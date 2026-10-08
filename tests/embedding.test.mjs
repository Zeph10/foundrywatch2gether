import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, reduceIntent, externalUrl, parseSource, expectedPosition } from '../scripts/state.js';
import { checkEmbeddable } from '../scripts/providers.js';

const gm = { id:'gm', name:'GM', role:4, isGM:true, active:true };
const host = { id:'host', name:'Ana', role:2, isGM:false, active:true };
const viewer = { id:'viewer', name:'Bo', role:1, isGM:false, active:true };
const users = new Map([gm, host, viewer].map(u => [u.id, u]));
const now = 2_000_000;
const send = (s, type, actor = gm, props = {}, at = now) => reduceIntent(s, { type, ...props }, actor, users, 2, at);
const yt = 'https://youtu.be/dQw4w9WgXcQ';

test('external links point at the provider page at the right time', () => {
  assert.equal(externalUrl(parseSource(yt), 75.9), 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=75s');
  assert.equal(externalUrl(parseSource(yt), 0), 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  assert.equal(externalUrl(parseSource('https://vimeo.com/123456/abcdef12'), 30), 'https://vimeo.com/123456/abcdef12#t=30s');
  assert.equal(externalUrl(parseSource('https://www.twitch.tv/videos/998877'), 3723), 'https://www.twitch.tv/videos/998877?t=1h2m3s');
  assert.equal(externalUrl(parseSource('https://www.twitch.tv/somechannel'), 50), 'https://www.twitch.tv/somechannel');
  assert.equal(externalUrl(parseSource('worlds/w/clip.mp4'), 12), 'worlds/w/clip.mp4#t=12');
});

test('ADD can mark a video external; EXTERNAL toggles it for controllers only', () => {
  let s = send(initialState(), 'OPEN');
  s = send(s, 'ADD', gm, { url: yt, external: true });
  assert.equal(s.current.external, true);
  s = send(s, 'ADD', gm, { url: 'https://vimeo.com/123456' });
  const queued = s.queue[0].uid;
  assert.equal(send(s, 'EXTERNAL', viewer, { uid: queued, external: true }), null);
  s = send(s, 'EXTERNAL', gm, { uid: queued, external: true });
  assert.equal(s.queue[0].external, true);
  assert.equal(send(s, 'EXTERNAL', gm, { uid: queued, external: true }), null, 'no-op rejected');
  s = send(s, 'EXTERNAL', gm, { uid: s.current.uid, external: false });
  assert.equal(s.current.external, false);
});

test('screen share takes over, keeps the interrupted video and its position, and stops cleanly', () => {
  let s = send(initialState(), 'OPEN');
  s = send(s, 'GRANT', gm, { userId: 'host' });
  s = send(s, 'ADD', gm, { url: yt, title: 'Movie' });
  s = send(s, 'PLAY', gm, {}, now);
  assert.equal(send(s, 'SHARE_START', viewer, {}, now + 1000), null, 'viewers cannot share');
  s = send(s, 'SHARE_START', host, {}, now + 40_000);
  assert.equal(s.current.provider, 'stream');
  assert.equal(s.current.sharerId, 'host');
  assert.equal(s.current.title, "Ana's screen");
  assert.equal(s.current.live, true);
  assert.equal(s.playing, true);
  assert.equal(s.queue[0].title, 'Movie');
  assert.equal(s.queue[0].start, 40, 'resumes where it was interrupted');
  assert.equal(send(s, 'SHARE_START', gm, {}, now + 41_000), null, "can't hijack someone else's share");
  assert.equal(send(s, 'SHARE_STOP', viewer, { uid: s.current.uid }), null);
  assert.equal(send(s, 'SHARE_STOP', host, { uid: 'stale' }), null);
  s = send(s, 'SHARE_STOP', host, { uid: s.current.uid }, now + 60_000);
  assert.equal(s.current.title, 'Movie');
  assert.equal(expectedPosition(s, now + 60_000), 40);
  assert.equal(send(s, 'SHARE_STOP', host, {}), null, 'nothing to stop');
});

test('a share is not recycled by repeat-queue mode', () => {
  let s = send(initialState(), 'OPEN');
  s = send(s, 'LOOP_MODE', gm, { mode: 'queue' });
  s = send(s, 'SHARE_START', gm);
  s = send(s, 'SHARE_STOP', gm, { uid: s.current.uid });
  assert.equal(s.current, null);
  assert.equal(s.queue.length, 0);
});

test('oEmbed check: 401/403 means not embeddable, success returns the title, failures are unknown', async () => {
  const entry = parseSource(yt);
  const reply = (status, body = {}) => async () => ({ ok: status === 200, status, json: async () => body });
  assert.deepEqual(await checkEmbeddable(entry, { fetchImpl: reply(200, { title: 'Real title' }) }), { embeddable: true, title: 'Real title' });
  assert.deepEqual(await checkEmbeddable(entry, { fetchImpl: reply(401) }), { embeddable: false });
  assert.deepEqual(await checkEmbeddable(parseSource('https://vimeo.com/123456'), { fetchImpl: reply(403), hostname: 'vtt.example' }), { embeddable: false });
  assert.equal((await checkEmbeddable(entry, { fetchImpl: reply(404) })).embeddable, null);
  assert.equal((await checkEmbeddable(entry, { fetchImpl: async () => { throw new TypeError('CORS'); } })).embeddable, null);
  assert.equal((await checkEmbeddable(parseSource('worlds/w/a.mp4'), { fetchImpl: reply(200) })).embeddable, null);
  let asked = '';
  await checkEmbeddable(parseSource('https://vimeo.com/123456'), { fetchImpl: async u => { asked = u; return { ok: false, status: 500 }; }, hostname: 'vtt.example' });
  assert.match(asked, /domain=vtt\.example/);
});
