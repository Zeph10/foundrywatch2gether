import test from 'node:test';
import assert from 'node:assert/strict';
import { SpectralSplitter, splitOffline, LATENCY, MONO_SIMILARITY } from '../scripts/separation.js';

const SR = 48000;
const tone = (hz, seconds, amp = 0.2, phase = 0) => Float32Array.from({ length: SR * seconds }, (_, i) => amp * Math.sin(2 * Math.PI * hz * i / SR + phase));
const add = (...xs) => xs[0].map((_, i) => xs.reduce((s, x) => s + x[i], 0));
/** Amplitude of a frequency in a signal (single-bin DFT over the middle second). */
function level(signal, hz) {
  const from = Math.floor(signal.length / 2 - SR / 2), to = from + SR;
  let re = 0, im = 0;
  for (let i = from; i < to; i++) { re += signal[i] * Math.cos(2 * Math.PI * hz * i / SR); im += signal[i] * Math.sin(2 * Math.PI * hz * i / SR); }
  return 2 * Math.hypot(re, im) / SR;
}
const dB = (a, b) => 20 * Math.log10(a / b);

// "Song": centred vocal at 440 Hz, guitar panned hard left (660 Hz), keys hard right (880 Hz),
// a strings pad panned 70/30 (1200 Hz) and centred bass at 80 Hz.
const vocal = tone(440, 3), guitar = tone(660, 3), keys = tone(880, 3), pad = tone(1200, 3), bass = tone(80, 3);
const L = add(vocal, guitar, pad.map(x => x * 0.7), bass);
const R = add(vocal, keys, pad.map(x => x * 0.3), bass);

test('offline instrumental removes the centred vocal and keeps everything else, in stereo', () => {
  const { instrumental: [iL, iR], vocals: [vL, vR] } = splitOffline(L, R, SR, { strength: 0.7 });
  assert.ok(dB(level(iL, 440), level(L, 440)) < -20, `vocal reduced by ${dB(level(iL, 440), level(L, 440)).toFixed(1)} dB`);
  assert.ok(Math.abs(dB(level(iL, 660), level(L, 660))) < 1, 'left guitar kept on the left');
  assert.ok(level(iR, 660) < 0.01, 'left guitar not smeared into the right channel');
  assert.ok(Math.abs(dB(level(iR, 880), level(R, 880))) < 1, 'right keys kept on the right');
  assert.ok(Math.abs(dB(level(iL, 1200), level(L, 1200))) < 1.5, 'off-centre pad kept');
  assert.ok(Math.abs(dB(level(iL, 80), level(L, 80))) < 1, 'centred bass below the vocal band kept');
  // Vocals stem: the voice, without the instruments.
  assert.ok(Math.abs(dB(level(vL, 440), level(L, 440))) < 3, 'vocal present in the vocal stem');
  for (const hz of [660, 880, 80]) assert.ok(level(vL, hz) < 0.02 && level(vR, hz) < 0.02, `${hz} Hz mostly absent from vocal stem`);
});

test('strength scales how much is removed', () => {
  const soft = splitOffline(L, R, SR, { strength: 0.1, vocals: false }).instrumental[0];
  const hard = splitOffline(L, R, SR, { strength: 1, vocals: false }).instrumental[0];
  assert.ok(level(hard, 440) < level(soft, 440));
});

test('streaming splitter: "off" reconstructs the input exactly, delayed by LATENCY samples', () => {
  const s = new SpectralSplitter({ sampleRate: SR, mode: 'off' });
  const inL = add(guitar, vocal), inR = add(keys, vocal);
  const outL = new Float32Array(inL.length), outR = new Float32Array(inR.length);
  for (let i = 0; i < inL.length; i += 128) s.process(inL.subarray(i, i + 128), inR.subarray(i, i + 128), outL.subarray(i, i + 128), outR.subarray(i, i + 128));
  let maxErr = 0;
  for (let i = 4 * LATENCY; i < inL.length - LATENCY; i++) maxErr = Math.max(maxErr, Math.abs(outL[i] - inL[i - LATENCY]), Math.abs(outR[i] - inR[i - LATENCY]));
  assert.ok(maxErr < 1e-4, `reconstruction error ${maxErr}`);
});

test('streaming splitter: switching to remove glides in and removes the vocal', () => {
  const s = new SpectralSplitter({ sampleRate: SR, mode: 'remove', strength: 0.7 });
  const outL = new Float32Array(L.length), outR = new Float32Array(R.length);
  for (let i = 0; i < L.length; i += 128) s.process(L.subarray(i, i + 128), R.subarray(i, i + 128), outL.subarray(i, i + 128), outR.subarray(i, i + 128));
  assert.ok(dB(level(outL, 440), level(L, 440)) < -20);
  assert.ok(Math.abs(dB(level(outL, 660), level(L, 660))) < 1);
  const similarity = s.takeSimilarity();
  assert.ok(similarity > 0.2 && similarity < MONO_SIMILARITY, `stereo track similarity ${similarity}`);
});

test('mono tracks are recognisable (centre similarity ≈ 1)', () => {
  const mono = add(vocal, guitar);
  const { similarity } = splitOffline(mono, mono, SR, { vocals: false });
  assert.ok(similarity >= MONO_SIMILARITY, `mono similarity ${similarity}`);
});
