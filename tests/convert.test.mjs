import test from 'node:test';
import assert from 'node:assert/strict';
import { isStreamingLink, slugify, titleFromName } from '../scripts/convert.js';
import { encodeWav, encodeMp3, loadLame } from '../scripts/convert-worker.js';

test('streaming-service links are refused; direct files and Foundry paths are not', () => {
  for (const url of ['https://www.youtube.com/watch?v=x', 'https://youtu.be/x', 'https://music.youtube.com/watch?v=x', 'https://vimeo.com/1',
    'https://www.twitch.tv/videos/1', 'https://open.spotify.com/track/x', 'https://soundcloud.com/a/b']) assert.equal(isStreamingLink(url), true, url);
  for (const url of ['https://cdn.example.com/a.mp3', 'worlds/w/music/a.ogg', 'modules/x/storage/audio/b.wav', 'https://example.com/youtube.mp3']) assert.equal(isStreamingLink(url), false, url);
});

test('titles and file names from links', () => {
  assert.equal(titleFromName('https://x.org/music/Dragon_Lair-Theme%20(v2).mp3?dl=1'), 'Dragon Lair Theme (v2)');
  assert.equal(slugify('Dragon Lair Theme (v2) — Ünïcode!'), 'dragon-lair-theme-v2-unicode');
  assert.equal(slugify('!!!'), 'track');
});

test('WAV encoder writes a valid 16-bit stereo file', () => {
  const left = Float32Array.from({ length: 100 }, (_, i) => Math.sin(i / 5)), right = left.map(x => -x);
  const buf = encodeWav(left, right, 44100), v = new DataView(buf);
  const str = (o, n) => String.fromCharCode(...new Uint8Array(buf, o, n));
  assert.equal(str(0, 4), 'RIFF'); assert.equal(str(8, 4), 'WAVE'); assert.equal(str(36, 4), 'data');
  assert.equal(v.getUint16(22, true), 2); assert.equal(v.getUint32(24, true), 44100); assert.equal(v.getUint16(34, true), 16);
  assert.equal(buf.byteLength, 44 + 100 * 4);
  // Sample 10: left = sin(2), right = -sin(2), each within one 16-bit step.
  assert.ok(Math.abs(v.getInt16(44 + 40, true) - Math.sin(2) * 0x7fff) <= 1);
  assert.ok(Math.abs(v.getInt16(44 + 42, true) + Math.sin(2) * 0x8000) <= 1);
});

test('MP3 path: loader evaluates a lamejs-style script and the encoder output is concatenated', async () => {
  // Stand-in with lamejs's shape: a global function that attaches Mp3Encoder when called.
  const fake = `function lamejs(){ lamejs.Mp3Encoder = function(ch, sr, kbps){ this.encodeBuffer = (l, r) => new Int8Array(Math.ceil(l.length / 8)).fill(1); this.flush = () => new Int8Array(7).fill(2); }; } lamejs();`;
  const lame = await loadLame(async () => ({ ok: true, text: async () => fake }));
  assert.ok(lame?.lib?.Mp3Encoder, 'loader found Mp3Encoder');
  const samples = new Float32Array(1152 * 50);
  const mp3 = new Uint8Array(encodeMp3(lame.lib, samples, samples, 44100, 192));
  assert.equal(mp3.length, Math.ceil(1152 * 20 / 8) * 2 + Math.ceil(1152 * 10 / 8) + 7);
  assert.equal(mp3.at(-1), 2);
});
