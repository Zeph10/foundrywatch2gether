export const MODULE_ID = "foundry-watch-room";
export const MAX_QUEUE = 60;
/** Seconds of tolerance when a non-controller reports that the current video has ended. */
export const ENDED_TOLERANCE = 5;

export function initialState() {
  return {
    revision: 0, roomId: null, open: false, hostId: null,
    controllerIds: [], current: null, queue: [], playing: false,
    position: 0, startedAt: 0, scene: null, loopMode: "off", voteMode: false, pendingVote: null, resumeStack: [], currentPriority: 0, cinematic: null, cinematicFocus: false,
    fade: null, fadeInStart: 0, resumeFadeIn: 0
  };
}

export function serverNow() {
  const value = globalThis.game?.time?.serverTime;
  return Number.isFinite(value) ? value : Date.now();
}

export function expectedPosition(s, now = serverNow()) {
  if (!s?.current) return 0;
  const pos = Number(s.position) || 0;
  return Math.max(0, pos + (s.playing ? Math.max(0, now - (Number(s.startedAt) || now)) / 1000 : 0));
}

export function canControl(s, user) {
  return Boolean(user && (user.isGM || user.id === s?.hostId || s?.controllerIds?.includes(user.id)));
}

export function canCreate(user, minimumRole) {
  return Boolean(user && (user.isGM || Number(user.role) >= Number(minimumRole)));
}

function cleanTitle(text, fallback) {
  return String(text || fallback || "Video").replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, 120) || "Video";
}

function isDirectFile(path) {
  return /\.(mp4|m4v|webm|ogv|ogg|mp3|wav|m4a|flac|aac|opus)(?:$|[?#])/i.test(path);
}

function safeDecode(text) {
  try { return decodeURIComponent(text); } catch { return text; }
}

/** Parse "90", "90s", "1m30s", "1h2m3s" (YouTube/Twitch/Vimeo start-time formats) into seconds. */
export function parseStartTime(value) {
  if (value === null || value === undefined) return 0;
  const text = String(value).trim().toLowerCase();
  if (/^\d+(?:\.\d+)?$/.test(text)) return Math.min(Number(text), 86400 * 12);
  const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(text);
  if (!match || !text) return 0;
  const [, h = 0, m = 0, sec = 0] = match;
  return Math.min(Number(h) * 3600 + Number(m) * 60 + Number(sec), 86400 * 12);
}

function hashParam(u, key) {
  return new URLSearchParams(u.hash.replace(/^#/, "")).get(key);
}

/** Only permit known embeddable providers or recognizable direct video files. */
export function parseSource(input, base = globalThis.location?.href || "https://example.invalid/") {
  const raw = String(input ?? "").trim();
  if (!raw || raw.length > 2048) throw new Error("Enter a video URL (up to 2048 characters).");
  if (/^(?:worlds|modules|systems|assets|uploads|storage)\//i.test(raw) && isDirectFile(raw)) {
    return { provider: "file", url: raw, audio: /\.(mp3|ogg|wav|m4a|flac|aac|opus)(?:$|[?#])/i.test(raw), live: false, start: 0,
      label: safeDecode(raw.split("/").pop()?.split(/[?#]/)[0] || "") || "Media file" };
  }
  let u;
  try { u = new URL(raw, base); } catch { throw new Error("That URL isn't valid."); }
  if (!["http:", "https:"].includes(u.protocol)) throw new Error("Only HTTP(S) video links are supported.");
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  const pieces = u.pathname.split("/").filter(Boolean);
  if (["youtu.be", "youtube.com", "m.youtube.com", "music.youtube.com", "youtube-nocookie.com"].includes(host)) {
    const id = host === "youtu.be" ? pieces[0] :
      u.pathname === "/watch" ? u.searchParams.get("v") :
      ["shorts", "live", "embed", "v"].includes(pieces[0]) ? pieces[1] : null;
    if (!/^[a-zA-Z0-9_-]{11}$/.test(id || "")) throw new Error("Use a valid YouTube video URL.");
    const start = parseStartTime(u.searchParams.get("t") ?? u.searchParams.get("start") ?? hashParam(u, "t"));
    return { provider: "youtube", id, url: `https://www.youtube.com/watch?v=${id}`, live: false, start, label: `YouTube • ${id}` };
  }
  if (host === "vimeo.com" || host === "player.vimeo.com") {
    const id = [...pieces].reverse().find(v => /^\d+$/.test(v));
    if (!id) throw new Error("Use a valid Vimeo video URL.");
    const after = pieces[pieces.indexOf(id) + 1] || "";
    const candidate = u.searchParams.get("h") || after;
    // Unlisted-video hashes are hex; anything else is ignored so it can't leak into the player URL.
    const hash = /^[a-f0-9]{6,}$/i.test(candidate) ? candidate : "";
    const start = parseStartTime(hashParam(u, "t"));
    return { provider: "vimeo", id, url: `https://vimeo.com/${id}${hash ? `/${hash}` : ""}`, hash, live: false, start, label: `Vimeo • ${id}` };
  }
  if (host === "clips.twitch.tv") throw new Error("Twitch clips are not supported; use a channel or VOD.");
  if (host === "twitch.tv" || host === "m.twitch.tv" || host === "player.twitch.tv") {
    if (pieces.includes("clip") || pieces[0] === "clip") throw new Error("Twitch clips are not supported; use a channel or VOD.");
    const vod = pieces[0] === "videos" ? pieces[1] : u.searchParams.get("video");
    if (vod && /^v?\d+$/.test(vod)) {
      const id = vod.replace(/^v/, "");
      const start = parseStartTime(u.searchParams.get("t"));
      return { provider: "twitch", id, videoType: "vod", url: `https://www.twitch.tv/videos/${id}`, live: false, start, label: `Twitch VOD • ${id}` };
    }
    const channel = host === "player.twitch.tv" ? u.searchParams.get("channel") : pieces[0];
    if (channel && /^[a-zA-Z0-9_]{2,25}$/.test(channel) && !["directory", "settings", "downloads", "clips", "collections", "videos"].includes(channel.toLowerCase())) {
      return { provider: "twitch", id: channel, videoType: "channel", url: `https://www.twitch.tv/${channel}`, live: true, start: 0, label: `Twitch Live • ${channel}` };
    }
    throw new Error("Use a Twitch channel or VOD link. Twitch clips are not supported.");
  }
  if (isDirectFile(u.pathname)) {
    return { provider: "file", audio: /\.(mp3|ogg|wav|m4a|flac|aac|opus)$/i.test(u.pathname), url: u.toString(), live: false, start: parseStartTime(hashParam(u, "t")), label: safeDecode(pieces.at(-1) || "") || "Video file" };
  }
  throw new Error("Supported: YouTube, Vimeo, Twitch, MP4/WebM video, MP3/OGG/WAV/M4A/FLAC/AAC/Opus audio.");
}

export function makeEntry(data, title, loop = false, fx = {}) {
  const parsed = parseSource(data.url);
  return { ...parsed, title: cleanTitle(title, parsed.label), loop: Boolean(loop), ...cleanFx(fx, parsed),
    uid: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}` };
}

export const MAX_FADE = 60;
const fadeSeconds = v => Number.isFinite(Number(v)) ? Math.round(Math.max(0, Math.min(MAX_FADE, Number(v))) * 10) / 10 : 0;

/** Vocal reduction runs through Web Audio, which needs the raw audio: only direct files qualify. */
export function supportsInstrumental(entry) {
  return entry?.provider === "file" && !entry.external;
}

/** The fx a saved library track carries into the room. */
export function trackFx(track, library = []) {
  const fx = { fadeIn: track?.fadeIn || 0, fadeOut: track?.fadeOut || 0, instrumental: Boolean(track?.instrumental),
    vocalMode: track?.vocalMode, vocalStrength: track?.vocalStrength };
  // Pre-rendered versions travel with the track as URLs, so the room can switch to them.
  const stems = {};
  for (const kind of ["instrumental", "vocals"]) {
    const id = track?.stems?.[kind];
    const stem = id && library.find(t => t.id === id);
    if (stem?.url) stems[kind] = stem.url;
  }
  if (Object.keys(stems).length) fx.stems = stems;
  return fx;
}

/** Pre-rendered stem URLs that are safe to play (direct files only). */
function cleanStems(stems) {
  const out = {};
  for (const kind of ["instrumental", "vocals"]) {
    const url = stems?.[kind];
    if (typeof url !== "string") continue;
    try { if (parseSource(url).provider === "file") out[kind] = url; } catch { /* drop invalid */ }
  }
  return Object.keys(out).length ? out : undefined;
}

export const VOCAL_MODE_LABELS = Object.freeze({ off: "Original", remove: "Remove vocals (instrumental)", isolate: "Vocals only" });

/**
 * Per-track audio effects: fade-in/out seconds and the vocal splitter (`vocalMode`: off / remove /
 * isolate, with `vocalStrength` 0.1–1). `instrumental` is kept as a derived flag for older data/macros.
 */
export function cleanFx(fx = {}, entry = {}) {
  let vocalMode = ["off", "remove", "isolate"].includes(fx.vocalMode) ? fx.vocalMode : (fx.instrumental ? "remove" : "off");
  if (!supportsInstrumental(entry)) vocalMode = "off";
  const strength = Number(fx.vocalStrength);
  const out = {
    fadeIn: fadeSeconds(fx.fadeIn),
    fadeOut: fadeSeconds(fx.fadeOut),
    vocalMode,
    vocalStrength: Number.isFinite(strength) ? Math.round(Math.max(0.1, Math.min(1, strength)) * 20) / 20 : 0.7,
    instrumental: vocalMode === "remove"
  };
  const stems = supportsInstrumental(entry) ? cleanStems(fx.stems) : undefined;
  if (stems) out.stems = stems;
  return out;
}

const clamp01 = v => Math.max(0, Math.min(1, v));
/**
 * Volume multiplier (0–1) for the current track at `now`, computed from the shared room clock so
 * every client fades in step. Combines the track's fade-in (from when it started or resumed), its
 * fade-out before a known end, and a GM's manual "fade out" in progress.
 */
export function fadeGain(s, now = serverNow(), duration = 0) {
  const entry = s?.current;
  if (!entry) return 1;
  let gain = 1;
  const pos = expectedPosition(s, now);
  // A track paused by "fade out & pause" fades back in over the same time when resumed.
  const fadeIn = Math.max(Number(entry.fadeIn) || 0, Number(s.resumeFadeIn) || 0);
  const from = Number(s.fadeInStart);
  if (fadeIn > 0 && !entry.live && Number.isFinite(from) && from >= 0) gain = Math.min(gain, clamp01((pos - from) / fadeIn));
  const fadeOut = Number(entry.fadeOut) || 0;
  const loops = entry.loop || s.loopMode === "one";
  if (fadeOut > 0 && duration > 0 && !entry.live && !loops) gain = Math.min(gain, clamp01((duration - pos) / fadeOut));
  const fade = s.fade;
  if (fade && fade.uid === entry.uid && fade.ms > 0) gain = Math.min(gain, clamp01(1 - (now - fade.startedAt) / fade.ms));
  return gain;
}

/** Providers that can be watched on their own site in a synced pop-up instead of being embedded. */
export const EXTERNAL_PROVIDERS = new Set(["youtube", "vimeo", "twitch", "file"]);
const newUid = now => globalThis.crypto?.randomUUID?.() || `${now}-${Math.random().toString(36).slice(2)}`;

/** The provider's own page for an entry, starting at `seconds` where the site supports it. */
export function externalUrl(entry, seconds = 0) {
  const t = Math.max(0, Math.floor(Number(seconds) || 0));
  switch (entry?.provider) {
    case "youtube": return `https://www.youtube.com/watch?v=${entry.id}${t ? `&t=${t}s` : ""}`;
    case "vimeo": return `https://vimeo.com/${entry.id}${entry.hash ? `/${entry.hash}` : ""}${t ? `#t=${t}s` : ""}`;
    case "twitch": {
      if (entry.videoType !== "vod") return `https://www.twitch.tv/${entry.id}`;
      const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60;
      return `https://www.twitch.tv/videos/${entry.id}${t ? `?t=${h}h${m}m${sec}s` : ""}`;
    }
    case "file": return `${String(entry.url).split("#")[0]}${t ? `#t=${t}` : ""}`;
    default: return "";
  }
}

const validPos = v => Number.isFinite(Number(v)) ? Math.max(0, Math.min(86400 * 12, Number(v))) : 0;
const copy = obj => JSON.parse(JSON.stringify(obj));

/** Make `entry` the current video, starting at its link's start time. */
function setCurrent(s, entry, now, playing) {
  s.pendingVote = null;
  s.fade = null;
  s.resumeFadeIn = 0;
  s.current = entry || null;
  s.currentPriority = Number.isFinite(Number(entry?.priority)) ? Math.max(0, Math.min(100, Number(entry.priority))) : 0;
  s.position = entry && !entry.live ? validPos(entry.start) : 0;
  s.startedAt = now;
  s.playing = Boolean(entry) && playing;
  s.fadeInStart = s.position; // fade in from where this track starts
}

/** Progress to next track, with single-track, full-queue and encounter resume semantics. */
function advance(s, now, natural = false) {
  const old = s.current;
  if (natural && old && !old.live && (old.loop || s.loopMode === "one")) {
    setCurrent(s, { ...old }, now, true);
    s.fadeInStart = -1; // a looping track shouldn't fade in again on every repeat
    return;
  }
  if (s.resumeStack?.length) {
    const resume = s.resumeStack.pop();
    setCurrent(s, resume.entry, now, resume.playing);
    s.position = resume.position;
    s.fadeInStart = resume.position;
    return;
  }
  if (old && s.loopMode === "queue" && !old.live && s.queue.length < MAX_QUEUE) {
    s.queue.push({...old, uid: globalThis.crypto?.randomUUID?.() || `replay-${now}`});
  }
  setCurrent(s, s.queue.shift(), now, true);
}

function songChange(s, proposal, now) {
  if (proposal?.type === "NEXT") {
    if (!s.current && !s.queue.length) return false;
    advance(s, now); return true;
  }
  if (proposal?.type === "SELECT") {
    const index = s.queue.findIndex(item => item.uid === proposal.uid);
    if (index < 0) return false;
    s.resumeStack = [];
    setCurrent(s, s.queue.splice(index, 1)[0], now, true); return true;
  }
  return false;
}

function eligibleVoters(users) {
  return [...(users?.values?.() || users || [])].filter(u => u.active && !u.isGM).map(u => u.id);
}
function countVote(s, users, now) {
  const vote = s.pendingVote;
  if (!vote) return;
  const eligible = eligibleVoters(users);
  const majority = Math.floor(eligible.length / 2) + 1;
  if (vote.yes.filter(id => eligible.includes(id)).length >= majority) {
    const proposal = vote.proposal;
    s.pendingVote = null;
    songChange(s, proposal, now);
  } else if (vote.no.filter(id => eligible.includes(id)).length >= majority) s.pendingVote = null;
}

/** Intents a GM's automation may issue while the room is closed; the leader opens the room first. */
export const AUTO_OPEN_INTENTS = new Set(["TRIGGER", "DIRECTOR_START"]);

/**
 * Apply `intent`, first opening the room in the same transaction when it is closed and the
 * intent is GM automation (encounter music, cinematics). Avoids a separate OPEN racing the cue.
 */
export function reduceWithAutoOpen(previous, intent, actor, users, minimumRole, now, autoOpen = true) {
  let base = previous || initialState();
  if (autoOpen && !base.open && actor?.isGM && AUTO_OPEN_INTENTS.has(intent?.type)) {
    base = reduceIntent(base, { type: "OPEN" }, actor, users, minimumRole, now) || base;
  }
  return reduceIntent(base, intent, actor, users, minimumRole, now);
}

/** Pure authoritative state transition. Returns null when forbidden or invalid. */
export function reduceIntent(previous, intent, actor, users, minimumRole, now) {
  const s = copy(previous || initialState());
  const type = intent?.type;
  const host = canControl(s, actor);
  const moderator = Boolean(actor?.isGM || actor?.id === s.hostId);
  const exists = id => Boolean(users?.get?.(id));
  if (type === "OPEN") {
    if (s.open || !canCreate(actor, minimumRole)) return null;
    Object.assign(s, { open: true, roomId: globalThis.crypto?.randomUUID?.() || `room-${now}`, hostId: actor.id,
      controllerIds: [], current: null, queue: [], playing: false, position: 0, startedAt: now, scene: null, loopMode: "off", voteMode: false, pendingVote: null, resumeStack: [], currentPriority:0, cinematic:null, cinematicFocus:false });
  } else {
    if (!s.open) return null;
    switch (type) {
      case "CLOSE":
        if (!moderator) return null;
        Object.assign(s, { open: false, playing: false, startedAt: now, pendingVote: null, resumeStack: [], cinematic:null, cinematicFocus:false, currentPriority:0 });
        break;
      case "ADD": {
        if (!host) return null;
        let entry;
        try { entry = makeEntry({url: intent.url}, intent.title, intent.loop, intent.fx); } catch { return null; }
        if (intent.external && EXTERNAL_PROVIDERS.has(entry.provider)) entry.external = true;
        if (!s.current) setCurrent(s, entry, now, false);
        else if (s.queue.length < MAX_QUEUE) s.queue.push(entry);
        else return null;
        break;
      }
      case "REMOVE":
        if (!host) return null;
        if (!s.queue.some(item => item.uid === intent.uid)) return null;
        s.queue = s.queue.filter(item => item.uid !== intent.uid);
        break;
      case "MOVE": {
        if (!host) return null;
        const idx = s.queue.findIndex(item => item.uid === intent.uid);
        const to = idx + Math.sign(Number(intent.delta) || 0);
        if (idx < 0 || to === idx || to < 0 || to >= s.queue.length) return null;
        const [item] = s.queue.splice(idx, 1);
        s.queue.splice(to, 0, item);
        break;
      }
      case "SELECT":
      case "NEXT":
        if (!host || (s.voteMode && !actor.isGM) || (intent.forUid && intent.forUid !== s.current?.uid)) return null;
        if (!songChange(s, intent, now)) return null;
        break;
      case "ENDED": {
        // Any synced watcher may report the end of the current video, so the room keeps
        // advancing even when the host has hidden the player or gone offline.
        if (!s.current || intent.forUid !== s.current.uid) return null;
        const reported = Number(intent.duration);
        if (!host) {
          if (s.current.live || !s.playing || !(reported > 0) ||
            expectedPosition(s, now) < reported - ENDED_TOLERANCE) return null;
        } else if (reported > 0 && !s.current.live && expectedPosition(s, now) < reported - ENDED_TOLERANCE) {
          // A looping track keeps its uid, so a second controller's late "ended" report would
          // otherwise restart the loop again. Reports that don't fit the room clock are stale.
          return null;
        }
        advance(s, now, true);
        break;
      }
      case "EXTERNAL": {
        // Switch a video between embedded playback and synced pop-up windows (for videos whose
        // owners disallow embedding).
        if (!host) return null;
        const entry = [s.current, ...s.queue].find(e => e?.uid === intent.uid);
        if (!entry || !EXTERNAL_PROVIDERS.has(entry.provider)) return null;
        if (Boolean(entry.external) === Boolean(intent.external)) return null;
        entry.external = Boolean(intent.external);
        if (!supportsInstrumental(entry)) { Object.assign(entry, { instrumental: false, vocalMode: "off" }); delete entry.stems; }
        break;
      }
      case "SHARE_START": {
        // A controller streams their own screen/tab to the room. The video that was playing goes
        // back to the front of the queue, keeping its position.
        if (!host) return null;
        if (s.current?.provider === "stream" && s.current.sharerId !== actor.id) return null;
        const entry = { provider: "stream", sharerId: actor.id, live: true, start: 0, url: "", label: "Screen share",
          title: cleanTitle(intent.title, `${cleanTitle(actor.name, "Host")}'s screen`), uid: newUid(now) };
        if (s.current && s.current.provider !== "stream" && s.queue.length < MAX_QUEUE) {
          s.queue.unshift({ ...s.current, start: s.current.live ? 0 : expectedPosition(s, now), uid: newUid(now) });
        }
        s.resumeStack = [];
        setCurrent(s, entry, now, true);
        break;
      }
      case "SHARE_STOP": {
        if (s.current?.provider !== "stream" || (intent.uid && intent.uid !== s.current.uid)) return null;
        if (!(moderator || host || actor?.id === s.current.sharerId)) return null;
        advance(s, now);
        break;
      }
      case "PLAY":
        if (!host || !s.current || s.playing) return null;
        s.playing = true;
        s.startedAt = now;
        s.fadeInStart = s.position; // tracks with a fade-in also fade back in after a pause
        s.fade = null;
        break;
      case "PAUSE":
        if (!host || !s.current || !s.playing) return null;
        s.position = expectedPosition(s, now);
        s.playing = false;
        s.startedAt = now;
        s.fade = null;
        s.resumeFadeIn = 0;
        break;
      case "SEEK":
        if (!host || !s.current || s.current.live) return null;
        s.position = validPos(intent.position);
        s.startedAt = now;
        s.fadeInStart = -1;
        break;
      case "TRACK_FX": {
        // Change a queued or current track's fades / instrumental switch.
        if (!host) return null;
        const entry = [s.current, ...s.queue].find(e => e?.uid === intent.uid);
        if (!entry) return null;
        // An explicit instrumental:true/false from older callers maps onto vocalMode.
        const fx = { ...intent.fx };
        if (fx.instrumental !== undefined && fx.vocalMode === undefined) fx.vocalMode = fx.instrumental ? "remove" : "off";
        const before = cleanFx(entry, entry);
        const next = cleanFx({ ...before, ...fx }, entry);
        if (JSON.stringify(next) === JSON.stringify(before)) return null;
        Object.assign(entry, next);
        break;
      }
      case "FADE": {
        // GM/controller "fade out" button: every client ramps down over `ms`, then the leader applies `then`.
        if (!host || !s.current || !s.playing) return null;
        const ms = Math.round(Math.max(500, Math.min(MAX_FADE * 1000, Number(intent.ms) || 3000)));
        const then = ["pause", "next", "stop"].includes(intent.then) ? intent.then : "pause";
        s.fade = { uid: s.current.uid, startedAt: now, ms, then };
        break;
      }
      case "FADE_DONE": {
        const fade = s.fade;
        if (!host || !fade || fade.uid !== s.current?.uid || now < fade.startedAt + fade.ms - 250) return null;
        s.fade = null;
        if (fade.then === "next") advance(s, now);
        else if (fade.then === "stop") { s.resumeStack = []; setCurrent(s, null, now, false); }
        else if (s.playing) {
          s.position = expectedPosition(s, now); s.playing = false; s.startedAt = now;
          s.resumeFadeIn = Math.round(fade.ms / 100) / 10;
        }
        break;
      }
      case "LOOP_MODE":
        if (!host || !["off", "one", "queue"].includes(intent.mode)) return null;
        s.loopMode = intent.mode; break;
      case "TRACK_LOOP": {
        if (!host) return null;
        const entry = [s.current, ...s.queue].find(e => e?.uid === intent.uid);
        if (!entry) return null;
        entry.loop = Boolean(intent.loop); break;
      }
      case "VOTE_MODE":
        if (!moderator) return null;
        s.voteMode = Boolean(intent.enabled); s.pendingVote = null; break;
      case "PROPOSE": {
        if (!s.voteMode || s.pendingVote || !actor?.active) return null;
        if (!["NEXT", "SELECT"].includes(intent.action)) return null;
        if (intent.action === "SELECT" && !s.queue.some(e => e.uid === intent.uid)) return null;
        if (intent.action === "NEXT" && !s.current && !s.queue.length) return null;
        s.pendingVote = { id: globalThis.crypto?.randomUUID?.() || String(now),
          proposal: {type: intent.action, uid: intent.uid}, requester: actor.id,
          yes: actor.isGM ? [] : [actor.id], no: [], expiresAt: now + 30000 };
        countVote(s, users, now); break;
      }
      case "VOTE": {
        if (!s.voteMode || !s.pendingVote || actor?.isGM || !actor?.active || s.pendingVote.id !== intent.id) return null;
        if (now >= s.pendingVote.expiresAt) { s.pendingVote = null; break; }
        s.pendingVote.yes = s.pendingVote.yes.filter(id => id !== actor.id);
        s.pendingVote.no = s.pendingVote.no.filter(id => id !== actor.id);
        s.pendingVote[intent.yes ? "yes" : "no"].push(actor.id);
        countVote(s, users, now); break;
      }
      case "VOTE_OVERRIDE":
        if (!actor.isGM || !s.pendingVote) return null;
        if (intent.approve) songChange(s, s.pendingVote.proposal, now);
        s.pendingVote = null; break;
      case "VOTE_TIMEOUT":
        if (!actor.isGM || !s.pendingVote || now < s.pendingVote.expiresAt) return null;
        s.pendingVote = null; break;
      case 'DIRECTOR_START': {
        if (!actor.isGM || typeof intent.cueId !== 'string' || intent.cueId.length > 120) return null;
        s.cinematic = { cueId:intent.cueId, startedAt:now, title:String(intent.title || '').slice(0,120) };
        s.cinematicFocus = Boolean(intent.focus);
        break;
      }
      case 'DIRECTOR_STOP': {
        if (!actor.isGM || !s.cinematic) return null;
        s.cinematic = null;
        s.cinematicFocus = false;
        break;
      }
      case 'DIRECTOR_FOCUS': {
        if (!actor.isGM || !s.cinematic) return null;
        s.cinematicFocus = Boolean(intent.enabled);
        break;
      }
      case "TRIGGER": {
        if (!actor.isGM) return null; // authoritative hooks/GM macros only
        let entry;
        try { entry = makeEntry({url: intent.url}, intent.title, intent.loop, intent.fx); } catch { return null; }
        const p = Math.min(100, Math.max(0, Number.isFinite(Number(intent.priority)) ? Number(intent.priority) : 50));
        entry.priority = p;
        if (intent.action === 'interrupt' && !intent.force && p < (Number(s.currentPriority) || 0)) return null;
        if (intent.action === "queue") {
          if (s.current && s.queue.length >= MAX_QUEUE) return null;
          if (!s.current) setCurrent(s, entry, now, true);
          else s.queue.push(entry);
        } else if (intent.action === "interrupt") {
          if (intent.resume && s.current) {
            s.resumeStack ||= [];
            if (s.resumeStack.length >= 5) s.resumeStack.shift();
            s.resumeStack.push({entry: s.current, position: expectedPosition(s, now), playing: s.playing});
          } else s.resumeStack = [];
          setCurrent(s, entry, now, true);
        } else return null;
        break;
      }
      case "GRANT":
        if (!moderator || !exists(intent.userId) || intent.userId === s.hostId) return null;
        s.controllerIds = [...new Set([...s.controllerIds, intent.userId])];
        break;
      case "REVOKE":
        if (!moderator || !s.controllerIds.includes(intent.userId)) return null;
        s.controllerIds = s.controllerIds.filter(id => id !== intent.userId);
        break;
      case "TAKE_HOST":
        if (!actor?.isGM || s.hostId === actor.id) return null;
        s.hostId = actor.id;
        s.controllerIds = s.controllerIds.filter(id => id !== actor.id);
        break;
      case "SCENE": {
        if (!host) return null;
        if (intent.scene === null) { s.scene = null; break; }
        const scene = intent.scene || {};
        if (!scene.sceneId || typeof scene.sceneId !== "string") return null;
        const bounded = (v, lo, hi) => Math.max(lo, Math.min(hi, Number(v) || lo));
        s.scene = {
          sceneId: scene.sceneId,
          x: bounded(scene.x, 0, 100000), y: bounded(scene.y, 0, 100000),
          width: bounded(scene.width, 400, 4000), height: bounded(scene.height, 300, 3000)
        };
        break;
      }
      default: return null;
    }
  }
  s.revision = (Number(s.revision) || 0) + 1;
  return s;
}
