import test from 'node:test';
import assert from 'node:assert/strict';
import { FFT3, MdxSeparator, AI_MODELS } from '../scripts/ai-core.js';

test('FFT3 (3·2^k points) matches a direct DFT, forward and inverse', () => {
  const n = 24, fft = new FFT3(n);
  const xr = Array.from({ length: n }, (_, i) => Math.sin(i * 0.7) + (i % 5) * 0.1), xi = Array.from({ length: n }, (_, i) => Math.cos(i * 1.3));
  const re = Float64Array.from(xr), im = Float64Array.from(xi);
  fft.run(re, im);
  for (let k = 0; k < n; k++) {
    let dr = 0, di = 0;
    for (let j = 0; j < n; j++) { const a = -2 * Math.PI * k * j / n; dr += xr[j] * Math.cos(a) - xi[j] * Math.sin(a); di += xr[j] * Math.sin(a) + xi[j] * Math.cos(a); }
    assert.ok(Math.abs(re[k] - dr) < 1e-9 && Math.abs(im[k] - di) < 1e-9, `bin ${k}`);
  }
  fft.run(re, im, true);
  for (let j = 0; j < n; j++) assert.ok(Math.abs(re[j] / n - xr[j]) < 1e-9 && Math.abs(im[j] / n - xi[j]) < 1e-9);
});

// Small geometry with the same structure as the real model (nFft = 3·2^k). dimF covers every bin here so
// reconstruction can be checked exactly; the real model drops the top (Nyquist, 22 kHz) bin — see below.
const P = { nFft: 48, hop: 8, dimF: 25, dimT: 32, compensate: 1 };
const n = 1000;
const L = Float32Array.from({ length: n }, (_, i) => 0.5 * Math.sin(2 * Math.PI * 3 * i / 48) + 0.2 * Math.sin(2 * Math.PI * 7 * i / 48 + 1));
const R = Float32Array.from({ length: n }, (_, i) => 0.4 * Math.sin(2 * Math.PI * 5 * i / 48 + 0.3));
const maxErr = (a, b) => a.reduce((m, v, i) => Math.max(m, Math.abs(v - b[i])), 0);

test('identity model reconstructs the input exactly (STFT, chunking, trim and ISTFT line up)', async () => {
  const sep = new MdxSeparator(P, async x => x);
  const { instrumental: [iL, iR], vocals: [vL, vR], chunks } = await sep.separate(L, R, { denoise: false });
  assert.ok(chunks >= 5, `several chunks (${chunks}) so seams are exercised`);
  assert.ok(maxErr(iL, L) < 1e-5 && maxErr(iR, R) < 1e-5, `reconstruction error ${maxErr(iL, L)}`);
  assert.ok(Math.max(...vL.map(Math.abs)) < 1e-5 && Math.max(...vR.map(Math.abs)) < 1e-5, 'vocals = mix − instrumental ≈ 0');
});

test('denoise (model on x and −x) is exact for a linear model; zero model gives vocals = mix', async () => {
  const den = await new MdxSeparator(P, async x => x).separate(L, R, { denoise: true });
  assert.ok(maxErr(den.instrumental[0], L) < 1e-5);
  const zero = await new MdxSeparator(P, async x => new Float32Array(x.length)).separate(L, R, { denoise: false });
  assert.ok(maxErr(zero.vocals[0], L) < 1e-6 && maxErr(zero.vocals[1], R) < 1e-6);
});

test('tensor layout is [L.re, L.im, R.re, R.im] × frequency × time, like UVR', async () => {
  const plane = P.dimF * P.dimT;
  // Silence the left channel planes only.
  const noLeft = await new MdxSeparator(P, async x => { const y = x.slice(); y.fill(0, 0, 2 * plane); return y; }).separate(L, R, { denoise: false });
  assert.ok(Math.max(...noLeft.instrumental[0].map(Math.abs)) < 1e-5, 'left silenced');
  assert.ok(maxErr(noLeft.instrumental[1], R) < 1e-5, 'right untouched');
  // Keep only frequency rows below bin 5: the 7/48 component of L goes, the 3/48 one stays.
  const lowPass = await new MdxSeparator(P, async x => { const y = x.slice(); for (let c = 0; c < 4; c++) for (let f = 5; f < P.dimF; f++) y.fill(0, c * plane + f * P.dimT, c * plane + (f + 1) * P.dimT); return y; }).separate(L, R, { denoise: false });
  const expected = Float32Array.from({ length: n }, (_, i) => 0.5 * Math.sin(2 * Math.PI * 3 * i / 48));
  assert.ok(maxErr(lowPass.instrumental[0].subarray(100, 900), expected.subarray(100, 900)) < 0.02, 'frequency axis');
});

test('dropping the Nyquist bin, as the real model does, only costs a tiny error', async () => {
  const out = await new MdxSeparator({ ...P, dimF: 24 }, async x => x).separate(L, R, { denoise: false });
  assert.ok(maxErr(out.instrumental[0], L) < 5e-3 && maxErr(out.instrumental[1], R) < 5e-3);
});

test('compensation gain applies to the instrumental only', async () => {
  const out = await new MdxSeparator({ ...P, compensate: 1.1 }, async x => x).separate(L, R, { denoise: false });
  assert.ok(Math.abs(out.instrumental[0][300] - L[300] * 1.1) < 1e-5);
  assert.ok(Math.abs(out.vocals[0][300]) < 1e-5);
});

test('model catalogue matches the published model', () => {
  const m = AI_MODELS['mdx-inst-hq-3'];
  assert.deepEqual(m.params, { nFft: 6144, hop: 1024, dimF: 3072, dimT: 256, compensate: 1.022, primary: 'instrumental' });
  assert.equal(m.bytes, 66759214);
  assert.equal(m.urls.every(u => u.startsWith('https://huggingface.co/')), true);
});

test('parallel chunks (finishing out of order) give the same result', async () => {
  let calls = 0;
  const slowRandom = async x => { calls++; await new Promise(r => setTimeout(r, Math.random() * 8)); return x; };
  const out = await new MdxSeparator(P, slowRandom).separate(L, R, { denoise: true, concurrency: 3 });
  assert.ok(maxErr(out.instrumental[0], L) < 1e-5 && maxErr(out.instrumental[1], R) < 1e-5);
  assert.equal(calls, out.chunks * 2, 'denoise runs the model twice per chunk');
});
