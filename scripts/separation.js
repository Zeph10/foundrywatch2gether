/**
 * Spectral vocal splitter — pure JavaScript, no dependencies. Used live (AudioWorklet), offline
 * (conversion worker) and in tests.
 *
 * How it works: the stereo signal is cut into overlapping 2048-sample frames and transformed with an
 * FFT. In each frequency bin we measure how "centre-panned" the sound is: a lead vocal is mixed
 * identically into both speakers, so its left and right values match in level AND phase. The
 * similarity  ψ = 2·Re(L·R*) / (|L|² + |R|²)  is 1 for such sounds, lower for instruments panned to
 * one side, and ≤ 0 for wide/out-of-phase sounds. Bins with ψ above a threshold form a soft "centre"
 * mask (smoothed over time and frequency to avoid warbling). The centre estimate C = mask·(L+R)/2 is
 * then either subtracted from both channels (instrumental) or kept on its own (vocals only), and only
 * inside the vocal band — bass/kick below `lowCut` and cymbals/air above `highCut` are left alone.
 *
 * Compared with plain L−R "karaoke" subtraction this keeps the stereo image, keeps the bass, keeps
 * anything not dead-centre, and stays mono-compatible. It still can't separate a vocal from other
 * instruments that share the centre and the same frequencies — that needs a trained AI model.
 */

export const FFT_SIZE = 2048;
export const HOP = FFT_SIZE / 4;
export const LATENCY = FFT_SIZE;   // samples between input and the matching output (streaming)
export const VOCAL_MODES = Object.freeze(["off", "remove", "isolate"]);

/** Strength 0–1 → mask threshold and depth. Higher = more aggressive (removes more, more artefacts). */
export function strengthParams(strength = 0.7) {
  const s = Math.max(0, Math.min(1, Number(strength)));
  return { threshold: 0.97 - 0.32 * s, depth: 0.7 + 0.3 * s };
}

/** In-place radix-2 complex FFT with cached tables. `inverse` gives the unscaled inverse. */
class FFT {
  constructor(n) {
    this.n = n;
    this.rev = new Uint32Array(n);
    const bits = Math.log2(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
    this.cos = new Float64Array(n / 2);
    this.sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) { this.cos[i] = Math.cos(2 * Math.PI * i / n); this.sin[i] = Math.sin(2 * Math.PI * i / n); }
  }
  run(re, im, inverse = false) {
    const n = this.n, rev = this.rev;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    const sign = inverse ? 1 : -1;
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let k = 0; k < half; k++) {
          const wr = this.cos[k * step], wi = sign * this.sin[k * step];
          const a = start + k, b = a + half;
          const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr; im[b] = im[a] - ti;
          re[a] += tr; im[a] += ti;
        }
      }
    }
  }
}

/**
 * Shared per-frame analysis: given windowed L and R frames, returns the complex spectra of L, R and
 * the centre estimate C (for bins 0..N/2), using a mask smoothed against the previous frame.
 */
class FrameAnalyser {
  constructor({ sampleRate = 48000, fftSize = FFT_SIZE } = {}) {
    this.n = fftSize;
    this.bins = fftSize / 2 + 1;
    this.fft = new FFT(fftSize);
    this.re = new Float64Array(fftSize);
    this.im = new Float64Array(fftSize);
    this.L = { re: new Float64Array(this.bins), im: new Float64Array(this.bins) };
    this.R = { re: new Float64Array(this.bins), im: new Float64Array(this.bins) };
    this.mask = new Float64Array(this.bins);
    this.raw = new Float64Array(this.bins);
    this.sampleRate = sampleRate;
    this.window = new Float64Array(fftSize);
    for (let i = 0; i < fftSize; i++) this.window[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / fftSize); // periodic Hann
    // Hann analysis × Hann synthesis at 75 % overlap sums to 1.5
    this.olaGain = 1 / 1.5;
    this.configure({});
    this.statWeighted = 0; this.statEnergy = 0;
  }

  configure({ strength = 0.7, lowCut = 150, highCut = 8000 } = {}) {
    const { threshold, depth } = strengthParams(strength);
    this.threshold = threshold;
    this.depth = depth;
    // Band weight per bin with half-octave ramps, so the edges don't click.
    const w = this.band = new Float64Array(this.bins);
    for (let k = 0; k < this.bins; k++) {
      const f = k * this.sampleRate / this.n;
      const up = f <= 0 ? 0 : Math.max(0, Math.min(1, Math.log2(f / lowCut) * 2 + 1));
      const down = Math.max(0, Math.min(1, 1 - Math.log2(f / highCut) * 2));
      w[k] = Math.min(up, down);
    }
  }

  /** Window + FFT both channels at once (L as real part, R as imaginary part), then build the mask. */
  analyse(frameL, frameR) {
    const n = this.n, re = this.re, im = this.im, win = this.window;
    for (let i = 0; i < n; i++) { re[i] = frameL[i] * win[i]; im[i] = frameR[i] * win[i]; }
    this.fft.run(re, im);
    const L = this.L, R = this.R, raw = this.raw, mask = this.mask, t0 = this.threshold;
    for (let k = 0; k < this.bins; k++) {
      const j = (n - k) % n;
      // Separate the two real spectra from the packed complex FFT.
      L.re[k] = 0.5 * (re[k] + re[j]); L.im[k] = 0.5 * (im[k] - im[j]);
      R.re[k] = 0.5 * (im[k] + im[j]); R.im[k] = -0.5 * (re[k] - re[j]);
      const pL = L.re[k] * L.re[k] + L.im[k] * L.im[k];
      const pR = R.re[k] * R.re[k] + R.im[k] * R.im[k];
      const cross = L.re[k] * R.re[k] + L.im[k] * R.im[k];
      const psi = (2 * cross) / (pL + pR + 1e-12);
      raw[k] = Math.max(0, Math.min(1, (psi - t0) / (1 - t0)));
      if (this.band[k] > 0) { this.statWeighted += Math.max(0, psi) * (pL + pR); this.statEnergy += pL + pR; }
    }
    // Smooth across neighbouring bins, then over time (attack fast, release slower) to curb "musical noise".
    for (let k = 0; k < this.bins; k++) {
      const a = raw[Math.max(0, k - 1)], b = raw[k], c = raw[Math.min(this.bins - 1, k + 1)];
      const target = 0.25 * a + 0.5 * b + 0.25 * c;
      mask[k] = target > mask[k] ? 0.6 * target + 0.4 * mask[k] : 0.35 * target + 0.65 * mask[k];
    }
  }

  /**
   * Synthesise one output frame: out = α·X + β·C per channel, where C is the in-band centre estimate.
   * remove: α=1, β=−depth · isolate: α=0, β=1 · off: α=1, β=0. Writes windowed, scaled samples.
   */
  synthesise(alpha, beta, outL, outR) {
    const n = this.n, re = this.re, im = this.im, L = this.L, R = this.R, mask = this.mask, band = this.band;
    for (let k = 0; k < this.bins; k++) {
      const m = mask[k] * band[k];
      const cRe = m * 0.5 * (L.re[k] + R.re[k]), cIm = m * 0.5 * (L.im[k] + R.im[k]);
      const lr = alpha * L.re[k] + beta * cRe, li = alpha * L.im[k] + beta * cIm;
      const rr = alpha * R.re[k] + beta * cRe, ri = alpha * R.im[k] + beta * cIm;
      // Pack Y = L' + i·R' (Hermitian halves rebuilt below) for one inverse FFT.
      re[k] = lr - ri; im[k] = li + rr;
      if (k > 0 && k < n / 2) { re[n - k] = lr + ri; im[n - k] = rr - li; }
    }
    this.fft.run(re, im, true);
    const scale = this.olaGain / n, win = this.window;
    for (let i = 0; i < n; i++) { outL[i] = re[i] * scale * win[i]; outR[i] = im[i] * scale * win[i]; }
  }

  /** Energy-weighted mean similarity in the vocal band since the last call (≈1 means mono). */
  takeSimilarity() {
    const v = this.statEnergy > 1e-9 ? this.statWeighted / this.statEnergy : null;
    this.statWeighted = 0; this.statEnergy = 0;
    return v;
  }
}

const MODE_WEIGHTS = { off: [1, 0], remove: [1, -1], isolate: [0, 1] };

/**
 * Streaming splitter for real-time use. `process()` takes any block size; output lags input by
 * LATENCY samples. Mode/strength changes glide over ~100 ms instead of clicking.
 */
export class SpectralSplitter {
  constructor({ sampleRate = 48000, mode = "off", strength = 0.7, lowCut = 150, highCut = 8000 } = {}) {
    this.n = FFT_SIZE;
    this.hop = HOP;
    this.analyser = new FrameAnalyser({ sampleRate });
    this.inL = new Float32Array(this.n); this.inR = new Float32Array(this.n);
    this.accL = new Float64Array(this.n); this.accR = new Float64Array(this.n);
    this.readyL = new Float32Array(this.hop); this.readyR = new Float32Array(this.hop);
    this.frameL = new Float64Array(this.n); this.frameR = new Float64Array(this.n);
    this.fill = 0;
    this.alpha = 1; this.beta = 0;
    this.set({ mode, strength, lowCut, highCut });
  }

  set({ mode, strength, lowCut, highCut } = {}) {
    if (mode !== undefined) this.mode = VOCAL_MODES.includes(mode) ? mode : "off";
    const cfg = { strength: strength ?? this.strength ?? 0.7, lowCut: lowCut ?? this.lowCut ?? 150, highCut: highCut ?? this.highCut ?? 8000 };
    Object.assign(this, cfg);
    this.analyser.configure(cfg);
  }

  process(inL, inR, outL, outR) {
    const hop = this.hop, n = this.n;
    for (let i = 0; i < inL.length; i++) {
      this.inL[n - hop + this.fill] = inL[i];
      this.inR[n - hop + this.fill] = inR[i];
      outL[i] = this.readyL[this.fill];
      outR[i] = this.readyR[this.fill];
      if (++this.fill === hop) { this.frame(); this.fill = 0; }
    }
  }

  frame() {
    const n = this.n, hop = this.hop;
    // Glide towards the target mode weights (about 10 frames ≈ 100 ms).
    const [ta, tb] = MODE_WEIGHTS[this.mode] || MODE_WEIGHTS.off;
    const depthB = tb < 0 ? tb * this.analyser.depth : tb;
    this.alpha += (ta - this.alpha) * 0.2;
    this.beta += (depthB - this.beta) * 0.2;
    if (Math.abs(ta - this.alpha) < 1e-3) this.alpha = ta;
    if (Math.abs(depthB - this.beta) < 1e-3) this.beta = depthB;
    this.analyser.analyse(this.inL, this.inR);
    this.analyser.synthesise(this.alpha, this.beta, this.frameL, this.frameR);
    for (let i = 0; i < n; i++) { this.accL[i] += this.frameL[i]; this.accR[i] += this.frameR[i]; }
    for (let i = 0; i < hop; i++) { this.readyL[i] = this.accL[i]; this.readyR[i] = this.accR[i]; }
    this.accL.copyWithin(0, hop); this.accR.copyWithin(0, hop);
    this.accL.fill(0, n - hop); this.accR.fill(0, n - hop);
    this.inL.copyWithin(0, hop); this.inR.copyWithin(0, hop);
  }

  takeSimilarity() { return this.analyser.takeSimilarity(); }
}

/**
 * Offline split of a whole track in one pass. Returns time-aligned instrumental and/or vocal stems
 * (stereo Float32Arrays, same length as the input) plus the track's centre similarity.
 * `onProgress(fraction)` is called every few hundred frames.
 */
export function splitOffline(left, right, sampleRate, { strength = 0.7, lowCut = 150, highCut = 8000, instrumental = true, vocals = true, onProgress } = {}) {
  const n = FFT_SIZE, hop = HOP, length = left.length;
  const analyser = new FrameAnalyser({ sampleRate });
  analyser.configure({ strength, lowCut, highCut });
  // Pad so every sample is covered by a full set of overlapping frames.
  const padded = length + 2 * n;
  const out = {};
  if (instrumental) { out.instL = new Float32Array(padded); out.instR = new Float32Array(padded); }
  if (vocals) { out.vocL = new Float32Array(padded); out.vocR = new Float32Array(padded); }
  const frameL = new Float64Array(n), frameR = new Float64Array(n);
  const synthL = new Float64Array(n), synthR = new Float64Array(n);
  const frames = Math.ceil((length + n) / hop);
  for (let f = 0; f < frames; f++) {
    const start = f * hop - n; // signal index of frame sample 0
    for (let i = 0; i < n; i++) {
      const idx = start + i;
      frameL[i] = idx >= 0 && idx < length ? left[idx] : 0;
      frameR[i] = idx >= 0 && idx < length ? right[idx] : 0;
    }
    analyser.analyse(frameL, frameR);
    const base = start + n; // position in padded output
    if (instrumental) {
      analyser.synthesise(1, -analyser.depth, synthL, synthR);
      for (let i = 0; i < n; i++) { out.instL[base + i] += synthL[i]; out.instR[base + i] += synthR[i]; }
    }
    if (vocals) {
      analyser.synthesise(0, 1, synthL, synthR);
      for (let i = 0; i < n; i++) { out.vocL[base + i] += synthL[i]; out.vocR[base + i] += synthR[i]; }
    }
    if (onProgress && f % 256 === 0) onProgress(f / frames);
  }
  const trim = a => a.subarray(n, n + length);
  const result = { similarity: analyser.takeSimilarity() };
  if (instrumental) { result.instrumental = [trim(out.instL), trim(out.instR)]; }
  if (vocals) { result.vocals = [trim(out.vocL), trim(out.vocR)]; }
  onProgress?.(1);
  return result;
}

/** A track whose vocal-band energy is this centred is effectively mono: nothing to separate. */
export const MONO_SIMILARITY = 0.97;
