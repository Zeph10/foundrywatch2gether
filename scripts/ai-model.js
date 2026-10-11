import { MODULE_ID } from "./state.js";
import { AI_MODELS, DEFAULT_AI_MODEL } from "./ai-core.js";

/**
 * AI model management for the GM's browser. The ~64 MB model is downloaded once from a Hugging Face
 * mirror (or picked from a file), checked against its SHA-256, and kept in this browser's IndexedDB,
 * so it works offline afterwards and never has to be uploaded to the Foundry server. Each GM browser
 * keeps its own copy. The ONNX Runtime used to run it is loaded from jsDelivr (cached by the browser).
 */

export const ORT_VERSION = "1.20.1";
export const DEFAULT_ORT_BASE = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;
const DB_NAME = "fwr-ai-models", STORE = "models";

function openDb() {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) return reject(new Error("This browser can't store the AI model (no IndexedDB)."));
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Couldn't open browser storage for the AI model."));
  });
}
async function idb(mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const request = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(request?.result);
      tx.onerror = tx.onabort = () => reject(tx.error || new Error("Browser storage refused the AI model (is the disk full or storage blocked?)."));
    });
  } finally { db.close(); }
}

export async function sha256Hex(buffer) {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

export class AiModels {
  constructor() { this.status = null; this.installing = null; }

  get model() { return AI_MODELS[DEFAULT_AI_MODEL]; }

  /** Where the ONNX Runtime files come from (world setting; jsDelivr by default). */
  get ortBase() {
    let base = "";
    try { base = String(game.settings.get(MODULE_ID, "aiRuntimeUrl") || "").trim(); } catch { /* not registered (tests) */ }
    base ||= DEFAULT_ORT_BASE;
    return base.endsWith("/") ? base : `${base}/`;
  }

  /** WebGPU uses the graphics card and is much faster; otherwise the model runs on the CPU. */
  get backend() { return globalThis.navigator?.gpu ? "webgpu" : "wasm"; }
  get backendLabel() { return this.backend === "webgpu" ? "graphics card (WebGPU)" : "processor (no WebGPU in this browser — slower)"; }

  /** {installed, bytes, savedAt} for the default model in this browser. */
  async info() {
    try {
      const row = await idb("readonly", store => store.get(this.model.id));
      this.status = row ? { installed: true, bytes: row.buffer?.byteLength || 0, savedAt: row.savedAt } : { installed: false };
    } catch (error) { this.status = { installed: false, error: error.message }; }
    return this.status;
  }

  async load() {
    const row = await idb("readonly", store => store.get(this.model.id));
    if (!row?.buffer) throw new Error("The AI model isn't installed in this browser yet. Download it first (Music & Triggers → AI vocal separation).");
    return row.buffer;
  }

  async remove() {
    await idb("readwrite", store => store.delete(this.model.id));
    this.status = { installed: false };
  }

  /** Check and store a model buffer (from a download or a file the GM picked). */
  async store(buffer) {
    const model = this.model;
    if (buffer.byteLength !== model.bytes) throw new Error(`That isn't the expected model file (${(buffer.byteLength / 1e6).toFixed(1)} MB instead of ${(model.bytes / 1e6).toFixed(1)} MB). Use ${model.file}.`);
    const hash = await sha256Hex(buffer);
    if (hash !== model.sha256) throw new Error(`The model file failed its integrity check, so it wasn't saved. Use the original ${model.file}.`);
    await idb("readwrite", store => store.put({ buffer, savedAt: Date.now(), sha256: hash }, model.id));
    this.status = { installed: true, bytes: buffer.byteLength, savedAt: Date.now() };
  }

  /** Download from the first mirror that works. `onProgress(fraction, mirrorHost)`. */
  async install(onProgress = () => {}, signal) {
    if (this.installing) return this.installing;
    this.installing = (async () => {
      const errors = [];
      for (const url of this.model.urls) {
        const host = new URL(url).hostname + new URL(url).pathname.split("/").slice(1, 3).join("/");
        try {
          const response = await fetch(url, { signal, credentials: "omit" });
          if (!response.ok) { errors.push(`${host}: ${response.status}`); continue; }
          const total = Number(response.headers.get("content-length")) || this.model.bytes;
          const reader = response.body.getReader();
          const data = new Uint8Array(this.model.bytes);
          let received = 0;
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (received + value.length > data.length) throw new Error("The download was larger than the expected model.");
            data.set(value, received);
            received += value.length;
            onProgress(received / total, host);
          }
          await this.store(received === data.length ? data.buffer : data.slice(0, received).buffer);
          return this.status;
        } catch (error) {
          if (error?.name === "AbortError") throw error;
          errors.push(`${host}: ${error.message}`);
        }
      }
      throw new Error(`Couldn't download the AI model (${errors.join("; ")}). You can download ${this.model.file} yourself and use “Load model file”.`);
    })();
    try { return await this.installing; } finally { this.installing = null; }
  }
}
