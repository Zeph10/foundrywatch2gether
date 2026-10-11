/**
 * Conversion worker: splits a decoded track into instrumental / vocal stems and encodes each output.
 * Runs off the main thread so Foundry stays responsive.
 *
 * MP3 encoding uses lamejs (LGPL-3.0, https://github.com/zhuker/lamejs). The release build bundles it
 * at vendor/lamejs/lame.min.js; if that's missing the worker tries public CDNs, and if those are
 * unreachable it falls back to WAV, which every browser and Foundry can play (but is ~10× larger).
 *
 * In:  { left, right: Float32Array, sampleRate, outputs: { original, instrumental, vocals }, strength, kbps, format }
 * Out: progress { type: "progress", stage, fraction } … then
 *      { type: "done", encoder, similarity, files: [{ kind, buffer, mime, ext }] } or { type: "error", message }
 */
import { splitOffline, MONO_SIMILARITY } from "./separation.js";
import { MdxSeparator } from "./ai-core.js";

/**
 * AI separation with an MDX-Net model through ONNX Runtime Web, in a small pool of inference workers.
 * WebGPU (graphics card) runs one session; on the processor several single-threaded sessions run in
 * parallel on separate cores. Resolves { instrumental, vocals, backend, workers }.
 */
export async function aiSeparate(left, right, sampleRate, { modelBuffer, ortBase, params, denoise = true, onProgress, workers: wanted } = {}) {
  if (sampleRate !== 44100) throw new Error("The AI model needs 44.1 kHz audio.");
  const cores = globalThis.navigator?.hardwareConcurrency || 2;
  const start = async (provider, count) => {
    const pool = await Promise.all(Array.from({ length: count }, () => new Promise((resolve, reject) => {
      const w = new Worker(new URL("./ai-infer-worker.js", import.meta.url), { type: "module" });
      w.onmessage = ({ data }) => data.type === "ready" ? resolve(w) : (w.terminate(), reject(new Error(data.message)));
      w.onerror = e => { w.terminate(); reject(new Error(e.message || "AI worker failed to start")); };
      w.postMessage({ type: "init", modelBuffer: modelBuffer.slice(0), ortBase, provider });
    })).map(p => p.catch(e => e)));
    const ok = pool.filter(w => w instanceof Worker);
    if (!ok.length) throw pool[0];
    return ok;
  };
  let pool = null, backend = null, lastError = null;
  // On the processor, one single-threaded model per core (keeping one free on bigger machines), at most 3
  // to bound memory (each copy holds the 64 MB model plus working buffers).
  const cpuWorkers = wanted || Math.max(1, Math.min(3, cores >= 4 ? cores - 1 : cores));
  for (const [provider, count] of (globalThis.navigator?.gpu ? [["webgpu", 1]] : []).concat([["wasm", cpuWorkers]])) {
    try { pool = await start(provider, count); backend = provider; break; } catch (error) { lastError = error; }
  }
  if (!pool) {
    const why = String(lastError?.message || lastError);
    throw new Error(/import|fetch|load/i.test(why) ? `Couldn't load the AI runtime from ${ortBase}. Check your internet connection (it's downloaded once, then cached).` : `The AI model couldn't start: ${why}`);
  }
  const dims = [1, 4, params.dimF, params.dimT];
  const idle = [...pool], waiting = [], pending = new Map();
  let nextId = 0;
  for (const w of pool) w.onmessage = ({ data }) => {
    const job = pending.get(data.id); pending.delete(data.id);
    if (idle.push(w), waiting.length) waiting.shift()();
    if (!job) return;
    data.type === "result" ? job.resolve(data.data) : job.reject(new Error(data.message));
  };
  const run = async data => {
    while (!idle.length) await new Promise(r => waiting.push(r));
    const w = idle.shift(), id = nextId++;
    return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); w.postMessage({ type: "run", id, data, dims }, [data.buffer]); });
  };
  try {
    const result = await new MdxSeparator(params, run).separate(left, right, { denoise, onProgress, concurrency: pool.length });
    return { ...result, backend, workers: pool.length };
  } finally { pool.forEach(w => w.terminate()); }
}

const LAME_SOURCES = [
  new URL("../vendor/lamejs/lame.min.js", import.meta.url).href,
  "https://cdn.jsdelivr.net/npm/lamejs@1.2.1/lame.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/lamejs/1.2.1/lame.min.js"
];

let lamePromise = null;
/** Load lamejs from the bundled copy or a CDN. Resolves { lib, source } or null. */
export function loadLame(fetchImpl = globalThis.fetch) {
  lamePromise ||= (async () => {
    for (const source of LAME_SOURCES) {
      try {
        const response = await fetchImpl(source);
        if (!response.ok) continue;
        const code = await response.text();
        // lame.min.js declares a global `lamejs` function and calls it to attach Mp3Encoder.
        const lib = new Function(`${code}\n;return typeof lamejs !== "undefined" ? lamejs : globalThis.lamejs;`)();
        if (lib?.Mp3Encoder) return { lib, source };
      } catch { /* try the next source */ }
    }
    return null;
  })();
  return lamePromise;
}

const post = (message, transfer) => self.postMessage(message, transfer || []);
const progress = (stage, fraction) => post({ type: "progress", stage, fraction });

function toInt16(samples) {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

/** Peak-normalise quietly: stems can clip slightly after subtraction, or be much quieter (vocals). */
function limit(left, right, ceiling = 0.98) {
  let peak = 0;
  for (let i = 0; i < left.length; i++) peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
  if (peak <= ceiling || peak === 0) return [left, right];
  const g = ceiling / peak;
  return [left.map(x => x * g), right.map(x => x * g)];
}

export function encodeMp3(lib, left, right, sampleRate, kbps, onProgress) {
  const encoder = new lib.Mp3Encoder(2, sampleRate, kbps);
  const L = toInt16(left), R = toInt16(right);
  const chunks = [];
  const block = 1152 * 20;
  for (let i = 0; i < L.length; i += block) {
    const data = encoder.encodeBuffer(L.subarray(i, i + block), R.subarray(i, i + block));
    if (data.length) chunks.push(new Uint8Array(data.buffer, data.byteOffset, data.length).slice());
    if (onProgress && (i / block) % 50 === 0) onProgress(i / L.length);
  }
  const end = encoder.flush();
  if (end.length) chunks.push(new Uint8Array(end.buffer, end.byteOffset, end.length).slice());
  const size = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.length; }
  onProgress?.(1);
  return out.buffer;
}

/** 16-bit PCM stereo WAV. */
export function encodeWav(left, right, sampleRate) {
  const frames = left.length, bytes = frames * 4;
  const buffer = new ArrayBuffer(44 + bytes);
  const v = new DataView(buffer);
  const text = (offset, s) => { for (let i = 0; i < s.length; i++) v.setUint8(offset + i, s.charCodeAt(i)); };
  text(0, "RIFF"); v.setUint32(4, 36 + bytes, true); text(8, "WAVE");
  text(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 2, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 4, true); v.setUint16(32, 4, true); v.setUint16(34, 16, true);
  text(36, "data"); v.setUint32(40, bytes, true);
  const L = toInt16(left), R = toInt16(right);
  for (let i = 0, o = 44; i < frames; i++, o += 4) { v.setInt16(o, L[i], true); v.setInt16(o + 2, R[i], true); }
  return buffer;
}

// Only wire up the message handler inside an actual worker (the encoders are also imported by tests).
if (globalThis.WorkerGlobalScope && globalThis instanceof globalThis.WorkerGlobalScope) self.onmessage = async event => {
  const { left, right, sampleRate, outputs = {}, strength = 0.7, kbps = 192, format = "mp3", engine = "spectral", ai } = event.data || {};
  try {
    const wantSplit = outputs.instrumental || outputs.vocals;
    const stems = {};
    let similarity = null;
    let backend = null, aiWorkers = 0;
    if (wantSplit && engine === "ai") {
      progress("Loading AI model", 0);
      const result = await aiSeparate(left, right, sampleRate, { ...ai, onProgress: f => progress("AI separating vocals", f) });
      backend = result.backend; aiWorkers = result.workers;
      if (outputs.instrumental) stems.instrumental = limit(...result.instrumental);
      if (outputs.vocals) stems.vocals = limit(...result.vocals);
    } else if (wantSplit) {
      const result = splitOffline(left, right, sampleRate, {
        strength, instrumental: Boolean(outputs.instrumental), vocals: Boolean(outputs.vocals),
        onProgress: f => progress("Separating vocals", f)
      });
      similarity = result.similarity;
      if (similarity !== null && similarity >= MONO_SIMILARITY) {
        // Mono: there is no stereo difference to separate on. Say so rather than saving junk.
        post({ type: "mono", similarity });
      } else {
        if (result.instrumental) stems.instrumental = limit(...result.instrumental);
        if (result.vocals) stems.vocals = limit(...result.vocals);
      }
    }
    const jobs = [];
    if (outputs.original) jobs.push(["original", [left, right]]);
    for (const kind of ["instrumental", "vocals"]) if (stems[kind]) jobs.push([kind, stems[kind]]);

    let lame = null;
    if (format === "mp3") { progress("Loading MP3 encoder", 0); lame = await loadLame(); }
    const encoder = lame ? "mp3" : "wav";
    const files = [];
    const labels = { original: "full track", instrumental: "instrumental", vocals: "vocals" };
    for (const [kind, [l, r]] of jobs) {
      const stage = `Encoding ${labels[kind]} (${encoder.toUpperCase()})`;
      progress(stage, 0);
      const buffer = lame ? encodeMp3(lame.lib, l, r, sampleRate, kbps, f => progress(stage, f)) : encodeWav(l, r, sampleRate);
      files.push({ kind, buffer, mime: lame ? "audio/mpeg" : "audio/wav", ext: lame ? "mp3" : "wav" });
    }
    post({ type: "done", encoder, encoderSource: lame?.source || null, similarity, files, engine, backend, aiWorkers }, files.map(f => f.buffer));
  } catch (error) {
    post({ type: "error", message: error?.message || String(error) });
  }
};
