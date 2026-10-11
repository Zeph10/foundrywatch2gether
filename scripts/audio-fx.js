/**
 * Client-side audio effects for direct audio/video files, built on the Web Audio API.
 *
 * The main vocal splitter is spectral (separation.js, run in an AudioWorklet via VocalSplitter).
 * VocalReducer below is the simpler fallback for browsers without AudioWorklet.
 *
 * Fallback vocal reduction uses mid/side processing. Lead vocals in most stereo mixes are
 * panned dead centre, so they are identical in the left and right channels. Subtracting one channel
 * from the other (the "side" signal) cancels everything centred, vocals included, and keeps
 * instruments panned to either side. Bass and kick drum are usually centred too, so the low end of
 * the centre ("mid") signal is added back through a low-pass filter; vocals sit well above it.
 * The result is mono (the same instrumental mix in both speakers), which keeps it audible on devices
 * that play in mono.
 *
 * Limits, by nature of the technique: it can't touch vocals that aren't centred, it thins out other
 * centred instruments (snare, solo lines), reverb tails on the voice survive, and mono recordings have
 * no side signal at all. True stem separation needs a trained model and isn't practical in a browser,
 * so for important tracks a real instrumental file is still the best option.
 */

let sharedContext = null;

/** One AudioContext per page. Browsers start it suspended until the user clicks something. */
export function audioContext() {
  const Ctor = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!Ctor) return null;
  if (!sharedContext || sharedContext.state === "closed") sharedContext = new Ctor();
  return sharedContext;
}

/** Try to start audio processing; returns true when the context is running. Call from a click when possible. */
export async function resumeAudio() {
  const ctx = sharedContext;
  if (!ctx) return true;
  if (ctx.state === "running") return true;
  try { await ctx.resume(); } catch { /* needs a user gesture */ }
  return ctx.state === "running";
}

const BASS_CUTOFF = 150;     // Hz kept from the centre channel (bass, kick)
const WET_MAKEUP = 1.35;     // the side signal is quieter than the full mix

export class VocalReducer {
  /**
   * Route `element` through the effect. After this the element's sound only reaches the speakers
   * through Web Audio, so volume is controlled here (`setVolume`) and the context must be running.
   */
  constructor(element, ctx = audioContext()) {
    if (!ctx) throw new Error("This browser doesn't support Web Audio.");
    this.ctx = ctx;
    this.element = element;
    const source = ctx.createMediaElementSource(element);
    element.volume = 1; // volume is applied by `this.output` instead, so it isn't applied twice

    // Force stereo first: a 2-channel "speakers" node up-mixes mono to L = R, so mono shows up as
    // side = 0 (detectable) instead of L = signal, R = silence. (Splitters can't change interpretation.)
    const stereo = ctx.createGain();
    stereo.channelCount = 2;
    stereo.channelCountMode = "explicit";
    stereo.channelInterpretation = "speakers";
    source.connect(stereo);
    const split = ctx.createChannelSplitter(2);
    stereo.connect(split);

    const gain = value => { const g = ctx.createGain(); g.gain.value = value; return g; };
    // side = (L − R) / 2
    const side = gain(1), sideL = gain(0.5), sideR = gain(-0.5);
    split.connect(sideL, 0); split.connect(sideR, 1); sideL.connect(side); sideR.connect(side);
    // mid = (L + R) / 2, low-passed twice for a steeper slope
    const mid = gain(1), midL = gain(0.5), midR = gain(0.5);
    split.connect(midL, 0); split.connect(midR, 1); midL.connect(mid); midR.connect(mid);
    const lowA = ctx.createBiquadFilter(), lowB = ctx.createBiquadFilter();
    for (const f of [lowA, lowB]) { f.type = "lowpass"; f.frequency.value = BASS_CUTOFF; f.Q.value = 0.707; }
    mid.connect(lowA); lowA.connect(lowB);

    // Instrumental = side + bass, sent identically to both speakers. (Sending −side to the right channel
    // would keep more width, but anything that folds to mono — phone speakers, mono Bluetooth, the OS
    // mono-audio setting — would then cancel the music to near silence.)
    const merge = gain(1);
    side.connect(merge); lowB.connect(merge);

    // Dry (original) and wet (reduced) paths cross-fade into one output whose gain is the volume.
    this.dry = gain(1);
    this.wet = gain(0);
    this.output = gain(1);
    source.connect(this.dry);
    merge.connect(this.wet);
    this.dry.connect(this.output);
    this.wet.connect(this.output);
    this.output.connect(ctx.destination);

    // Meters for the mono check.
    this.midMeter = ctx.createAnalyser();
    this.sideMeter = ctx.createAnalyser();
    for (const m of [this.midMeter, this.sideMeter]) m.fftSize = 2048;
    mid.connect(this.midMeter);
    side.connect(this.sideMeter);
    this.enabled = false;
  }

  /** Smoothly switch between the original mix and the vocal-reduced one. */
  setEnabled(on, seconds = 0.35) {
    const t = this.ctx.currentTime;
    const tc = Math.max(0.01, seconds / 3);
    this.wet.gain.setTargetAtTime(on ? WET_MAKEUP : 0, t, tc);
    this.dry.gain.setTargetAtTime(on ? 0 : 1, t, tc);
    this.enabled = Boolean(on);
  }

  setVolume(v) {
    this.output.gain.setTargetAtTime(Math.max(0, Math.min(1, v)), this.ctx.currentTime, 0.03);
  }

  /**
   * Measure how much stereo difference the track has (side energy ÷ mid energy) while it plays.
   * Near 0 means mono or nearly mono, where vocal reduction would leave little but the bass.
   * Resolves null when there wasn't enough sound to judge (silence, paused).
   */
  measureStereo(ms = 2500) {
    const mid = new Float32Array(this.midMeter.fftSize), side = new Float32Array(this.sideMeter.fftSize);
    let midSum = 0, sideSum = 0, samples = 0;
    return new Promise(resolve => {
      const started = performance.now();
      const tick = () => {
        this.midMeter.getFloatTimeDomainData(mid);
        this.sideMeter.getFloatTimeDomainData(side);
        let m = 0, s = 0;
        for (let i = 0; i < mid.length; i++) { m += mid[i] * mid[i]; s += side[i] * side[i]; }
        if (m > 1e-6) { midSum += m; sideSum += s; samples++; }
        if (performance.now() - started < ms) setTimeout(tick, 100);
        else resolve(samples < 5 ? null : Math.sqrt(sideSum / midSum));
      };
      tick();
    });
  }
}

const workletLoads = new WeakMap();
/** Load the splitter worklet into `ctx` once. Resolves false where AudioWorklet isn't available. */
function loadSplitterWorklet(ctx) {
  if (!ctx?.audioWorklet) return Promise.resolve(false);
  if (!workletLoads.has(ctx)) {
    workletLoads.set(ctx, ctx.audioWorklet.addModule(new URL("./splitter-worklet.js", import.meta.url).href)
      .then(() => true, error => { console.warn("Watch Room | vocal splitter worklet failed to load", error); return false; }));
  }
  return workletLoads.get(ctx);
}

/**
 * Live vocal splitter for a media element: spectral centre extraction on the audio thread
 * (separation.js). Modes: "off" (original), "remove" (instrumental), "isolate" (vocals only).
 * Falls back to the simpler mid/side VocalReducer where AudioWorklet isn't supported.
 */
export class VocalSplitter {
  static async create(element, ctx = audioContext()) {
    if (!ctx) throw new Error("This browser doesn't support Web Audio.");
    if (await loadSplitterWorklet(ctx)) return new VocalSplitter(element, ctx);
    return new LegacySplitter(new VocalReducer(element, ctx));
  }

  constructor(element, ctx) {
    this.ctx = ctx;
    const source = ctx.createMediaElementSource(element);
    element.volume = 1; // volume is applied by `this.output`
    this.node = new AudioWorkletNode(ctx, "fwr-vocal-splitter", {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
      channelCount: 2, channelCountMode: "explicit", channelInterpretation: "speakers"
    });
    this.output = ctx.createGain();
    source.connect(this.node);
    this.node.connect(this.output);
    this.output.connect(ctx.destination);
    this.similarity = null;
    this.node.port.onmessage = event => { if (event.data?.similarity !== undefined) this.similarity = event.data.similarity; };
  }

  setMode(mode, strength = 0.7) {
    this.node.port.postMessage({ mode, strength });
    return { ok: true };
  }

  setVolume(v) {
    this.output.gain.setTargetAtTime(Math.max(0, Math.min(1, v)), this.ctx.currentTime, 0.03);
  }

  /** Centre similarity of the vocal band, measured while playing (≈1 means mono). null = no data yet. */
  async measureCentre(ms = 2500) {
    this.similarity = null;
    await new Promise(resolve => setTimeout(resolve, ms));
    return this.similarity;
  }
}

/** Mid/side fallback with the VocalSplitter interface. It can only remove, not isolate. */
class LegacySplitter {
  constructor(reducer) { this.reducer = reducer; }
  setMode(mode) {
    this.reducer.setEnabled(mode === "remove");
    return mode === "isolate" ? { ok: false, reason: "“Vocals only” needs a newer browser (AudioWorklet support)." } : { ok: true };
  }
  setVolume(v) { this.reducer.setVolume(v); }
  async measureCentre(ms) {
    const ratio = await this.reducer.measureStereo(ms);
    return ratio === null ? null : ratio < 0.04 ? 1 : 0.5;
  }
}

/** Is `url` served from another origin (so Web Audio needs CORS to read it)? */
export function isCrossOrigin(url, base = globalThis.location?.href) {
  try { return new URL(url, base).origin !== new URL(base).origin; } catch { return false; }
}

/** Does a cross-origin server allow scripts to read its audio (CORS)? Same-origin files always do. */
export async function allowsAudioProcessing(url, { fetchImpl = globalThis.fetch, base = globalThis.location?.href } = {}) {
  if (!isCrossOrigin(url, base)) return true;
  if (typeof fetchImpl !== "function") return false;
  try {
    const response = await fetchImpl(url, { method: "HEAD", mode: "cors", credentials: "omit" });
    return Boolean(response.ok || response.status === 405);
  } catch { return false; }
}

/** A YouTube search for an instrumental/karaoke version of a track title. */
export function instrumentalSearchUrl(title) {
  const clean = String(title || "").replace(/\((official|lyrics?|music video|audio|hd|4k)[^)]*\)/gi, "").trim();
  return `https://www.youtube.com/results?search_query=${encodeURIComponent(`${clean} instrumental`)}`;
}
