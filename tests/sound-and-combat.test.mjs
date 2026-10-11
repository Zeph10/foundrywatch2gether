import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, reduceIntent, fadeGain, cleanFx, supportsInstrumental, parseSource, trackFx } from '../scripts/state.js';
import { combatMetrics, crossedCombatRules, crossedPhases, describeThreshold } from '../scripts/director-core.js';
import { computeStatus, LISTENER_STATUS } from '../scripts/presence.js';
import { isCrossOrigin, allowsAudioProcessing, instrumentalSearchUrl } from '../scripts/audio-fx.js';

const gm = { id:'gm', name:'GM', role:4, isGM:true, active:true };
const viewer = { id:'viewer', name:'Bo', role:1, isGM:false, active:true };
const users = new Map([gm, viewer].map(u => [u.id, u]));
const T = 5_000_000;
const send = (s, type, actor = gm, props = {}, at = T) => reduceIntent(s, { type, ...props }, actor, users, 2, at);
const file = 'worlds/w/music/battle.mp3';

test('instrumental only applies to direct files; fades are clamped', () => {
  assert.equal(supportsInstrumental(parseSource(file)), true);
  assert.equal(supportsInstrumental(parseSource('https://youtu.be/dQw4w9WgXcQ')), false);
  assert.deepEqual(cleanFx({ fadeIn: 3.26, fadeOut: 999, instrumental: true }, parseSource(file)), { fadeIn: 3.3, fadeOut: 60, vocalMode: 'remove', vocalStrength: 0.7, instrumental: true });
  assert.equal(cleanFx({ vocalMode: 'isolate', vocalStrength: 2 }, parseSource(file)).vocalStrength, 1);
  assert.deepEqual(cleanFx({ fadeIn: -2, instrumental: true }, parseSource('https://youtu.be/dQw4w9WgXcQ')), { fadeIn: 0, fadeOut: 0, vocalMode: 'off', vocalStrength: 0.7, instrumental: false });
  assert.deepEqual(trackFx({ fadeIn: 2, instrumental: 1 }), { fadeIn: 2, fadeOut: 0, instrumental: true, vocalMode: undefined, vocalStrength: undefined });
});

test('fade-in follows the room clock from the start and again after a pause; loops do not re-fade', () => {
  let s = send(initialState(), 'OPEN');
  s = send(s, 'ADD', gm, { url: file, fx: { fadeIn: 4 } });
  s = send(s, 'PLAY', gm, {}, T);
  assert.equal(fadeGain(s, T), 0);
  assert.equal(fadeGain(s, T + 2000), 0.5);
  assert.equal(fadeGain(s, T + 6000), 1);
  s = send(s, 'PAUSE', gm, {}, T + 10_000);
  s = send(s, 'PLAY', gm, {}, T + 20_000);
  assert.equal(fadeGain(s, T + 21_000), 0.25, 'fades back in after resuming');
  s = send(s, 'SEEK', gm, { position: 30 }, T + 22_000);
  assert.equal(fadeGain(s, T + 22_100), 1, 'no fade after a seek');
  s = send(s, 'TRACK_FX', gm, { uid: s.current.uid, fx: {} }, T);
  assert.equal(s, null, 'unchanged fx is rejected');
});

test('fade-out before a known end, skipped for looping tracks', () => {
  let s = send(initialState(), 'OPEN');
  s = send(s, 'ADD', gm, { url: file, fx: { fadeOut: 5 } });
  s = send(s, 'PLAY', gm, {}, T);
  assert.equal(fadeGain(s, T + 50_000, 60), 1);
  assert.equal(fadeGain(s, T + 57_500, 60), 0.5);
  assert.equal(fadeGain(s, T + 57_500, 0), 1, 'unknown duration: no end fade');
  s = send(s, 'TRACK_LOOP', gm, { uid: s.current.uid, loop: true });
  assert.equal(fadeGain(s, T + 57_500, 60), 1);
});

test('TRACK_FX: controllers only; instrumental refused for embeds', () => {
  let s = send(initialState(), 'OPEN');
  s = send(s, 'ADD', gm, { url: file });
  assert.equal(send(s, 'TRACK_FX', viewer, { uid: s.current.uid, fx: { instrumental: true } }), null);
  s = send(s, 'TRACK_FX', gm, { uid: s.current.uid, fx: { instrumental: true, fadeIn: 2 } });
  assert.equal(s.current.instrumental, true);
  assert.equal(s.current.fadeIn, 2);
  let y = send(send(initialState(), 'OPEN'), 'ADD', gm, { url: 'https://youtu.be/dQw4w9WgXcQ' });
  assert.equal(send(y, 'TRACK_FX', gm, { uid: y.current.uid, fx: { instrumental: true } }), null);
});

test('manual fade: everyone ramps down, then the leader pauses or moves on', () => {
  let s = send(initialState(), 'OPEN');
  s = send(s, 'ADD', gm, { url: file, title: 'A' });
  s = send(s, 'ADD', gm, { url: file, title: 'B' });
  s = send(s, 'PLAY', gm, {}, T);
  assert.equal(send(s, 'FADE', viewer, { ms: 3000 }, T + 1000), null);
  let f = send(s, 'FADE', gm, { ms: 4000, then: 'pause' }, T + 10_000);
  assert.equal(fadeGain(f, T + 12_000), 0.5);
  assert.equal(send(f, 'FADE_DONE', gm, {}, T + 11_000), null, 'too early');
  const paused = send(f, 'FADE_DONE', gm, {}, T + 14_000);
  assert.equal(paused.playing, false);
  assert.equal(paused.position, 14);
  assert.equal(paused.fade, null);
  const next = send(send(s, 'FADE', gm, { ms: 2000, then: 'next' }, T + 10_000), 'FADE_DONE', gm, {}, T + 12_000);
  assert.equal(next.current.title, 'B');
  assert.equal(next.playing, true);
  const resumed = send(paused, 'PLAY', gm, {}, T + 20_000);
  assert.equal(fadeGain(resumed, T + 22_000), 0.5, 'fades back in after a fade-out pause');
  assert.equal(fadeGain(send(send(resumed, 'PAUSE', gm, {}, T + 30_000), 'PLAY', gm, {}, T + 31_000), T + 31_000), 1, 'ordinary pause/resume: no fade');
  const cancelled = send(f, 'PAUSE', gm, {}, T + 11_000);
  assert.equal(cancelled.fade, null, 'pausing cancels a fade');
});

const fighter = (hp, max, extra = {}) => ({ hp, max, side: 'party', pc: true, defeated: false, ...extra });
const goblin = (hp, max = 10, extra = {}) => ({ hp, max, side: 'enemy', pc: false, defeated: false, ...extra });

test('combat metrics pool HP by side and count enemies still standing', () => {
  const m = combatMetrics([fighter(30, 40), fighter(10, 40), goblin(5), goblin(0), goblin(10, 10, { defeated: true }), { hp: 5, max: 5, side: 'neutral' }]);
  assert.equal(m.party, 50);
  assert.equal(m.enemies, 50);
  assert.equal(m.anyPc, 25);
  assert.equal(m.enemiesRemaining, 1);
  assert.deepEqual(combatMetrics([]), { enemies: null, party: null, anyPc: null, enemiesRemaining: null });
});

test('whole-fight thresholds fire on crossing, in either direction, once each', () => {
  const rules = [
    { id: 'half', source: 'enemies', threshold: 50, direction: 'below', priority: 60 },
    { id: 'quarter', source: 'enemies', threshold: 25, direction: 'below', priority: 60 },
    { id: 'danger', source: 'anyPc', threshold: 20, direction: 'below', priority: 80 },
    { id: 'saved', source: 'party', threshold: 75, direction: 'above', priority: 50 },
    { id: 'last', source: 'enemiesRemaining', threshold: 1, direction: 'below', priority: 70 },
    { id: 'boss', threshold: 50 } // boss-HP rule: handled by crossedPhases, ignored here
  ];
  const prev = { enemies: 80, party: 60, anyPc: 50, enemiesRemaining: 3 };
  const hit = crossedCombatRules(rules, prev, { ...prev, enemies: 20 });
  assert.deepEqual(hit.map(r => r.id), ['half', 'quarter'], 'big hit: deepest is last');
  assert.deepEqual(crossedCombatRules(rules, prev, { ...prev, enemies: 20 }, new Set(['quarter'])).map(r => r.id), ['half']);
  assert.deepEqual(crossedCombatRules(rules, prev, { ...prev, anyPc: 10, enemies: 45 }).map(r => r.id), ['half', 'danger'], 'higher priority last');
  assert.deepEqual(crossedCombatRules(rules, prev, { ...prev, party: 80 }).map(r => r.id), ['saved']);
  assert.deepEqual(crossedCombatRules(rules, prev, { ...prev, enemiesRemaining: 1 }).map(r => r.id), ['last']);
  assert.deepEqual(crossedCombatRules(rules, { ...prev, enemies: null }, { ...prev, enemies: 10 }), [], 'unknown never crosses');
  assert.equal(describeThreshold(rules[4]), 'Enemies still standing ≤ 1');
  assert.equal(describeThreshold(rules[3]), "Party's HP % ≥ 75%");
});

test('boss HP thresholds also support "rises above" (e.g. the boss heals)', () => {
  const phases = [{ id: 'enrage', threshold: 50 }, { id: 'recovered', threshold: 60, direction: 'above' }, { id: 'pack', source: 'enemies', threshold: 40 }];
  assert.deepEqual(crossedPhases(phases, 70, 45).map(p => p.id), ['enrage']);
  assert.deepEqual(crossedPhases(phases, 45, 65).map(p => p.id), ['recovered']);
  assert.deepEqual(crossedPhases(phases, 45, 55), []);
});

test('listener status reflects what this browser is actually doing', () => {
  const base = { state: { open: true, playing: true, current: { uid: 'u', provider: 'file' } }, hidden: false, blocked: false,
    adapter: { kind: 'file' }, independent: false, currentVolume: 0.7, observedPlaying: true };
  assert.equal(computeStatus(base), 'listening');
  assert.equal(computeStatus({ ...base, hidden: true }), 'hidden');
  assert.equal(computeStatus({ ...base, blocked: true }), 'blocked');
  assert.equal(computeStatus({ ...base, currentVolume: 0 }), 'muted');
  assert.equal(computeStatus({ ...base, state: { ...base.state, playing: false } }), 'ready');
  assert.equal(computeStatus({ ...base, adapter: null }), 'loading');
  assert.equal(computeStatus({ ...base, adapter: { kind: 'external' }, externalOpen: false }), 'popup-closed');
  assert.equal(computeStatus({ ...base, embedBlockedUid: 'u' }), 'error');
  for (const s of ['listening', 'ready', 'popup']) assert.equal(LISTENER_STATUS[s].listening, true);
  for (const s of ['hidden', 'muted', 'blocked', 'unknown']) assert.equal(LISTENER_STATUS[s].listening, false);
});

test('audio processing needs same-origin files or CORS', async () => {
  const base = 'https://vtt.example/game';
  assert.equal(isCrossOrigin('worlds/w/a.mp3', base), false);
  assert.equal(isCrossOrigin('https://cdn.other/a.mp3', base), true);
  assert.equal(await allowsAudioProcessing('worlds/w/a.mp3', { base }), true);
  assert.equal(await allowsAudioProcessing('https://cdn.other/a.mp3', { base, fetchImpl: async () => ({ ok: true }) }), true);
  assert.equal(await allowsAudioProcessing('https://cdn.other/a.mp3', { base, fetchImpl: async () => { throw new TypeError('CORS'); } }), false);
  assert.match(instrumentalSearchUrl('Battle Theme (Official Video)'), /search_query=Battle%20Theme%20instrumental$/);
});
