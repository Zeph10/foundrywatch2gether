/**
 * AI vocal separation core (pure JS, no dependencies): the signal processing around an MDX-Net model.
 *
 * MDX-Net models (Ultimate Vocal Remover project) take a stereo spectrogram and return the spectrogram
 * of one stem. This file reproduces UVR's pre/post-processing exactly — PyTorch-style centred STFT
 * (reflect padding, periodic Hann window), the [batch, 4, dim_f, dim_t] tensor layout
 * (L.re, L.im, R.re, R.im), chunking with `trim` overlap, optional "denoise" (average of the model on
 * the input and on its negation), and the model's compensation gain. The model itself is called through
 * `runModel(Float32Array) → Float32Array`, so this file runs in Node tests and in the browser worker.
 */
import { FFT } from "./separation.js";

/** Known models. Sizes/hashes pin the exact files; params come from UVR's model_data.json. */
export const AI_MODELS = Object.freeze({
  "mdx-inst-hq-3": {
    id: "mdx-inst-hq-3",
    name: "UVR MDX-Net Inst HQ 3",
    file: "UVR-MDX-NET-Inst_HQ_3.onnx",
    bytes: 66759214,
    sha256: "317554b07fe1ea5279a77f2b1520a41ea4b93432560c4ffd08792c30fddf9adc",
    urls: [
      "https://huggingface.co/nomadkaraoke/public_uvr_models/resolve/main/UVR-MDX-NET-Inst_HQ_3.onnx",
      "https://huggingface.co/Politrees/UVR_resources/resolve/main/models/MDXNet/UVR-MDX-NET-Inst_HQ_3.onnx",
      "https://huggingface.co/seanghay/uvr_models/resolve/main/UVR-MDX-NET-Inst_HQ_3.onnx"
    ],
    params: { nFft: 6144, hop: 1024, dimF: 3072, dimT: 256, compensate: 1.022, primary: "instrumental" }
  }
});
export const DEFAULT_AI_MODEL = "mdx-inst-hq-3";

/** Complex FFT for N = 3·2^k (e.g. 6144), via one radix-3 step over three power-of-two FFTs. */
export class FFT3 {
  constructor(n) {
    if (n % 3 !== 0 || !Number.isInteger(Math.log2(n / 3))) throw new Error(`FFT3 needs 3·2^k points, got ${n}`);
    this.n = n; this.m = n / 3;
    this.sub = new FFT(this.m);
    this.parts = [0, 1, 2].map(() => ({ re: new Float64Array(this.m), im: new Float64Array(this.m) }));
    this.cos = new Float64Array(n); this.sin = new Float64Array(n);
    for (let k = 0; k < n; k++) { this.cos[k] = Math.cos(2 * Math.PI * k / n); this.sin[k] = Math.sin(2 * Math.PI * k / n); }
  }
  /** In place. `inverse` is unscaled (caller divides by N). */
  run(re, im, inverse = false) {
    const { n, m, parts } = this;
    for (let r = 0; r < 3; r++) {
      const p = parts[r];
      for (let j = 0; j < m; j++) { p.re[j] = re[3 * j + r]; p.im[j] = im[3 * j + r]; }
      this.sub.run(p.re, p.im, inverse);
    }
    const sign = inverse ? 1 : -1;
    const [a, b, c] = parts;
    for (let k = 0; k < n; k++) {
      const j = k % m;
      const w1r = this.cos[k], w1i = sign * this.sin[k];
      const k2 = (2 * k) % n, w2r = this.cos[k2], w2i = sign * this.sin[k2];
      re[k] = a.re[j] + (b.re[j] * w1r - b.im[j] * w1i) + (c.re[j] * w2r - c.im[j] * w2i);
      im[k] = a.im[j] + (b.re[j] * w1i + b.im[j] * w1r) + (c.re[j] * w2i + c.im[j] * w2r);
    }
  }
}

/** Matches torch.hann_window(n, periodic=True). */
function hann(n) {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n);
  return w;
}

export class MdxSeparator {
  /**
   * @param params { nFft, hop, dimF, dimT, compensate }
   * @param runModel async (Float32Array of 4·dimF·dimT) → Float32Array of the same size
   */
  constructor(params, runModel) {
    Object.assign(this, params);
    this.runModel = runModel;
    this.chunk = this.hop * (this.dimT - 1);
    this.trim = this.nFft / 2;
    this.gen = this.chunk - 2 * this.trim;
    this.window = hann(this.nFft);
    this.fft = this.nFft % 3 === 0 ? new FFT3(this.nFft) : new FFT(this.nFft);
    this.re = new Float64Array(this.nFft);
    this.im = new Float64Array(this.nFft);
    this.bins = this.nFft / 2 + 1;
    // Window-squared overlap envelope for the inverse STFT (same for every chunk).
    const total = this.chunk + this.nFft;
    this.envelope = new Float64Array(total);
    for (let t = 0; t < this.dimT; t++) for (let i = 0; i < this.nFft; i++) this.envelope[t * this.hop + i] += this.window[i] ** 2;
  }

  /** Centred STFT of a stereo chunk into the model's input layout [4, dimF, dimT]. */
  stft(left, right) {
    const { nFft, hop, dimF, dimT, chunk, re, im, window } = this;
    const pad = nFft / 2, out = new Float32Array(4 * dimF * dimT), plane = dimF * dimT;
    const at = (x, i) => { // reflect padding, like torch.stft(center=True)
      let j = i - pad;
      if (j < 0) j = -j; else if (j >= chunk) j = 2 * (chunk - 1) - j;
      return x[j];
    };
    for (let t = 0; t < dimT; t++) {
      const start = t * hop;
      for (let i = 0; i < nFft; i++) { re[i] = at(left, start + i) * window[i]; im[i] = at(right, start + i) * window[i]; }
      this.fft.run(re, im);
      for (let k = 0; k < dimF; k++) {
        const j = (nFft - k) % nFft;
        const o = k * dimT + t;
        out[o] = 0.5 * (re[k] + re[j]);              // L.re
        out[plane + o] = 0.5 * (im[k] - im[j]);      // L.im
        out[2 * plane + o] = 0.5 * (im[k] + im[j]);  // R.re
        out[3 * plane + o] = -0.5 * (re[k] - re[j]); // R.im
      }
    }
    return out;
  }

  /** Inverse of `stft` (bins ≥ dimF are zero, like UVR's freq_pad). Returns [left, right] of `chunk` samples. */
  istft(spec) {
    const { nFft, hop, dimF, dimT, chunk, re, im, window, envelope } = this;
    const pad = nFft / 2, plane = dimF * dimT, total = chunk + nFft;
    const accL = new Float64Array(total), accR = new Float64Array(total);
    for (let t = 0; t < dimT; t++) {
      re.fill(0); im.fill(0);
      for (let k = 0; k < dimF; k++) {
        const o = k * dimT + t;
        const lr = spec[o], li = spec[plane + o], rr = spec[2 * plane + o], ri = spec[3 * plane + o];
        re[k] = lr - ri; im[k] = li + rr;
        if (k > 0) { re[nFft - k] = lr + ri; im[nFft - k] = rr - li; }
      }
      this.fft.run(re, im, true);
      const start = t * hop;
      for (let i = 0; i < nFft; i++) { accL[start + i] += re[i] / nFft * window[i]; accR[start + i] += im[i] / nFft * window[i]; }
    }
    const left = new Float32Array(chunk), right = new Float32Array(chunk);
    for (let i = 0; i < chunk; i++) {
      const e = envelope[pad + i] || 1;
      left[i] = accL[pad + i] / e; right[i] = accR[pad + i] / e;
    }
    return [left, right];
  }

  /**
   * Separate a whole track. Returns { instrumental: [L, R], vocals: [L, R] } (same length as input).
   * `denoise` runs the model twice per chunk (input and negated input) for cleaner output.
   */
  async separate(left, right, { denoise = true, onProgress, signal, concurrency = 1 } = {}) {
    const { chunk, gen, trim } = this, n = left.length;
    const pad = gen - (n % gen);
    const padded = n + pad + 2 * trim;
    const mixL = new Float32Array(padded), mixR = new Float32Array(padded);
    mixL.set(left, trim); mixR.set(right, trim);
    const instL = new Float32Array(n + pad), instR = new Float32Array(n + pad);
    const chunks = Math.ceil((n + pad) / gen);
    let next = 0, done = 0;
    // `concurrency` chunks in flight at once (the model may run in several workers). The STFT/ISTFT are
    // synchronous, so the shared scratch buffers are never used by two chunks at the same time.
    const worker = async () => {
      for (let c = next++; c < chunks; c = next++) {
        if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
        const i = c * gen;
        const spec = this.stft(mixL.subarray(i, i + chunk), mixR.subarray(i, i + chunk));
        let pred;
        if (denoise) {
          const neg = spec.map(v => -v);
          const [a, b] = await Promise.all([this.runModel(spec), this.runModel(neg)]);
          pred = a.map((v, k) => 0.5 * (v - b[k]));
        } else pred = await this.runModel(spec);
        const [l, r] = this.istft(pred);
        const keep = Math.min(gen, n + pad - i);
        instL.set(l.subarray(trim, trim + keep), i);
        instR.set(r.subarray(trim, trim + keep), i);
        onProgress?.(++done / chunks);
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, chunks)) }, worker));
    const inst = [new Float32Array(n), new Float32Array(n)], voc = [new Float32Array(n), new Float32Array(n)];
    for (let k = 0; k < n; k++) {
      // Vocals = mix − raw instrumental; the instrumental gets the model's compensation gain.
      voc[0][k] = left[k] - instL[k]; voc[1][k] = right[k] - instR[k];
      inst[0][k] = instL[k] * this.compensate; inst[1][k] = instR[k] * this.compensate;
    }
    return { instrumental: inst, vocals: voc, chunks };
  }
}
