import { MODULE_ID } from "./state.js";

/**
 * Import & convert: bring a track in from a direct link, a file on this computer, or the library;
 * optionally split it into instrumental and vocal stems; save MP3s to the module's storage folder
 * and add them to the music library. Everything runs in the GM's browser; nothing leaves Foundry.
 */

export const MAX_IMPORT_BYTES = 300 * 1024 * 1024;
export const MAX_IMPORT_SECONDS = 20 * 60;
export const UPLOAD_LIMIT = 100 * 1024 * 1024;

const STREAMING_HOSTS = /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com|vimeo\.com|twitch\.tv|spotify\.com|soundcloud\.com|music\.apple\.com|deezer\.com|tidal\.com)$/i;

/** Links we deliberately don't download: streaming services forbid it, and the audio is usually copyrighted. */
export function isStreamingLink(url) {
  try { return STREAMING_HOSTS.test(new URL(url, "https://x.invalid/").hostname.replace(/^www\./, "")); }
  catch { return false; }
}

/** Safe, readable file name stem. */
export function slugify(text, fallback = "track") {
  const slug = String(text || "").normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase().slice(0, 60);
  return slug || fallback;
}

/** Title from a URL or file name: last path segment without extension, separators to spaces. */
export function titleFromName(name) {
  let base = String(name || "").split(/[?#]/)[0].split("/").pop() || "";
  try { base = decodeURIComponent(base); } catch { /* keep as-is */ }
  return base.replace(/\.[a-z0-9]{2,5}$/i, "").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 100);
}

export class Converter {
  constructor(music) {
    this.music = music;
    this.job = null;
  }

  get busy() { return Boolean(this.job); }

  /** Read the source into memory. Throws with a helpful message on CORS/size problems. */
  async load(source, signal, onProgress) {
    if (source.file) {
      if (source.file.size > MAX_IMPORT_BYTES) throw new Error("That file is over 300 MB.");
      return { data: await source.file.arrayBuffer(), name: source.file.name };
    }
    const url = String(source.url || "").trim();
    if (!url) throw new Error("Enter a link to an audio or video file.");
    if (isStreamingLink(url)) {
      throw new Error("YouTube, Vimeo, Twitch, Spotify and similar services don't allow downloading, so their links can't be imported. Use a file you own instead (“From your computer”).");
    }
    let response;
    try { response = await fetch(url, { signal, credentials: "same-origin" }); }
    catch (error) {
      if (error?.name === "AbortError") throw error;
      throw new Error("That site doesn't allow downloads from other websites (CORS), or it couldn't be reached. Download the file yourself, then choose “From your computer”.");
    }
    if (!response.ok) throw new Error(`The link answered ${response.status} ${response.statusText}. Check that it points straight to an audio or video file.`);
    const type = response.headers.get("content-type") || "";
    if (/text\/html/i.test(type)) throw new Error("That link is a web page, not an audio or video file. Use the direct file link (it usually ends in .mp3, .wav, .ogg, .flac, .m4a, .mp4 or .webm).");
    const total = Number(response.headers.get("content-length")) || 0;
    if (total > MAX_IMPORT_BYTES) throw new Error("That file is over 300 MB.");
    if (!response.body?.getReader) return { data: await response.arrayBuffer(), name: url };
    const reader = response.body.getReader();
    const chunks = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      if (received > MAX_IMPORT_BYTES) { reader.cancel(); throw new Error("That file is over 300 MB."); }
      onProgress?.("Downloading", total ? received / total : 0);
    }
    const data = new Uint8Array(received);
    let offset = 0;
    for (const c of chunks) { data.set(c, offset); offset += c.length; }
    return { data: data.buffer, name: url };
  }

  /** Decode any browser-supported audio/video file to 44.1 kHz stereo floats. */
  async decode(data) {
    const Offline = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
    if (!Offline) throw new Error("This browser can't decode audio.");
    let buffer;
    try { buffer = await new Offline(2, 1, 44100).decodeAudioData(data); }
    catch { throw new Error("The browser couldn't read audio from that file. Try MP3, WAV, OGG, FLAC, M4A, MP4 or WebM."); }
    if (buffer.duration > MAX_IMPORT_SECONDS) throw new Error("Tracks longer than 20 minutes aren't supported.");
    const left = buffer.getChannelData(0).slice();
    const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1).slice() : left.slice();
    return { left, right, sampleRate: buffer.sampleRate, duration: buffer.duration, channels: buffer.numberOfChannels };
  }

  /**
   * Run a whole import. `options`: { source: {url}|{file}|{libraryId}, title, outputs: {original, instrumental, vocals},
   * strength, kbps, category }. `onProgress(stage, fraction)`. Resolves a summary.
   */
  async run(options, onProgress = () => {}) {
    if (this.job) throw new Error("A conversion is already running.");
    if (!game.user.isGM) throw new Error("Only GMs can import tracks.");
    const Picker = this.music.watch.filePickerClass;
    if (!Picker?.uploadPersistent) throw new Error("Foundry's persistent upload isn't available, so converted files can't be saved.");
    const controller = new AbortController();
    const job = this.job = { controller, worker: null };
    try {
      const outputs = { original: Boolean(options.outputs?.original), instrumental: Boolean(options.outputs?.instrumental), vocals: Boolean(options.outputs?.vocals) };
      let sourceTrack = null, source = options.source || {};
      if (source.libraryId) {
        sourceTrack = this.music.library.find(t => t.id === source.libraryId);
        if (!sourceTrack) throw new Error("Choose a library track.");
        source = { url: sourceTrack.url };
      }
      if (!outputs.original && !outputs.instrumental && !outputs.vocals) throw new Error("Choose at least one thing to save.");
      onProgress(source.file ? "Reading file" : "Downloading", 0);
      const { data, name } = await this.load(source, controller.signal, onProgress);
      onProgress("Decoding audio", 0);
      const audio = await this.decode(data);
      const title = String(options.title || "").trim() || sourceTrack?.title || titleFromName(source.file?.name || name) || "Imported track";

      let ai = null;
      if (options.engine === "ai" && (outputs.instrumental || outputs.vocals)) {
        onProgress("Loading AI model", 0);
        const models = this.music.ai;
        ai = { modelBuffer: await models.load(), ortBase: models.ortBase, params: models.model.params, denoise: options.denoise !== false };
      }
      const result = await this.inWorker(audio, outputs, { ...options, ai }, onProgress, job);
      if (controller.signal.aborted) throw new DOMException("Cancelled", "AbortError");
      const notes = [];
      if (result.mono && result.engine !== "ai") notes.push("The recording is mono, so it can't be split into vocals and instrumental. Only the full track was saved.");
      if (result.encoder === "wav") notes.push("The MP3 encoder couldn't be loaded, so files were saved as WAV (larger, same quality).");

      const stamp = Date.now().toString(36).slice(-5);
      const suffix = { original: "", instrumental: " (instrumental)", vocals: " (vocals)" };
      const saved = [];
      for (const file of result.files) {
        if (file.buffer.byteLength > UPLOAD_LIMIT) { notes.push(`The ${file.kind} file is over 100 MB and wasn't uploaded.`); continue; }
        onProgress(`Saving ${file.kind === "original" ? "full track" : file.kind}`, saved.length / result.files.length);
        const fileName = `${slugify(title)}${file.kind === "original" ? "" : `-${file.kind}`}-${stamp}.${file.ext}`;
        const upload = new File([file.buffer], fileName, { type: file.mime });
        const response = await Picker.uploadPersistent(MODULE_ID, "audio", upload, {}, { notify: false });
        const path = response?.path || response?.url;
        if (!path) throw new Error("Foundry didn't return a path for the uploaded file.");
        saved.push({ kind: file.kind, path, title: `${title}${suffix[file.kind]}` });
      }
      const engine = result.engine === "ai" ? "ai" : "spectral";
      const added = await this.addToLibrary(saved, { sourceTrack, category: options.category, engine });
      onProgress("Done", 1);
      return { title, saved, added, notes, encoder: result.encoder, engine, backend: result.backend, workers: result.aiWorkers };
    } finally {
      job.worker?.terminate();
      if (this.job === job) this.job = null;
    }
  }

  inWorker(audio, outputs, options, onProgress, job) {
    return new Promise((resolve, reject) => {
      const worker = job.worker = new Worker(new URL("./convert-worker.js", import.meta.url), { type: "module" });
      let mono = false;
      worker.onmessage = ({ data }) => {
        if (data.type === "progress") onProgress(data.stage, data.fraction);
        else if (data.type === "mono") mono = true;
        else if (data.type === "done") resolve({ ...data, mono });
        else if (data.type === "error") reject(new Error(data.message));
      };
      worker.onerror = event => reject(new Error(event.message || "The conversion worker failed to start."));
      job.controller.signal.addEventListener("abort", () => { worker.terminate(); reject(new DOMException("Cancelled", "AbortError")); });
      const kbps = [128, 160, 192, 256, 320].includes(Number(options.kbps)) ? Number(options.kbps) : 192;
      const transfer = [audio.left.buffer, audio.right.buffer];
      if (options.ai?.modelBuffer) transfer.push(options.ai.modelBuffer);
      worker.postMessage({ left: audio.left, right: audio.right, sampleRate: audio.sampleRate, outputs,
        strength: Number(options.strength) || 0.7, kbps, format: "mp3", engine: options.ai ? "ai" : "spectral", ai: options.ai }, transfer);
    });
  }

  /** Library entries for the saved files, linked to each other (and to the source track) through `stems`. */
  async addToLibrary(saved, { sourceTrack, category, engine = "spectral" }) {
    if (!saved.length) return [];
    const id = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const entries = saved.map(s => ({
      id: id(), title: s.title.slice(0, 120), url: s.path, loop: false, fadeIn: 0, fadeOut: 0, vocalMode: "off",
      category: (category || sourceTrack?.category || "Imported").slice(0, 50),
      tags: [...new Set([...(s.kind === "original" ? [] : [s.kind]), ...(sourceTrack?.tags || [])])].slice(0, 12),
      kind: s.kind
    }));
    const stems = Object.fromEntries(entries.filter(e => e.kind !== "original").map(e => [e.kind, e.id]));
    const parentId = entries.find(e => e.kind === "original")?.id || sourceTrack?.id;
    for (const e of entries) { if (e.kind !== "original" && parentId) e.stemOf = parentId; }
    let library = [...this.music.library];
    // Re-rendering replaces the previous stem entries of the same kind (their files stay on the server).
    const replaced = new Set(Object.keys(stems).map(kind => library.find(t => t.id === parentId)?.stems?.[kind]).filter(Boolean));
    library = library.filter(t => !replaced.has(t.id)).concat(entries.map(({ kind, ...e }) => ({ ...e, ...(kind === "original" ? {} : { stemEngine: engine }) })));
    if (parentId && Object.keys(stems).length) library = library.map(t => t.id === parentId ? { ...t, stems: { ...(t.stems || {}), ...stems }, stemEngine: engine } : t);
    await this.music.saveLibrary(library);
    return entries.map(({ kind, ...e }) => e);
  }

  cancel() { this.job?.controller.abort(); }
}
