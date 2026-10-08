export const MODULE_ID = "foundry-watch-room";
export const MAX_QUEUE = 60;
/** Seconds of tolerance when a non-controller reports that the current video has ended. */
export const ENDED_TOLERANCE = 5;

export function initialState() {
  return {
    revision: 0, roomId: null, open: false, hostId: null,
    controllerIds: [], current: null, queue: [], playing: false,
    position: 0, startedAt: 0, scene: null, loopMode: "off", voteMode: false, pendingVote: null, resumeStack: [], currentPriority: 0, cinematic: null, cinematicFocus: false
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

export function makeEntry(data, title, loop = false) {
  const parsed = parseSource(data.url);
  return { ...parsed, title: cleanTitle(title, parsed.label), loop: Boolean(loop), uid: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}` };
}

const validPos = v => Number.isFinite(Number(v)) ? Math.max(0, Math.min(86400 * 12, Number(v))) : 0;
const copy = obj => JSON.parse(JSON.stringify(obj));

/** Make `entry` the current video, starting at its link's start time. */
function setCurrent(s, entry, now, playing) {
  s.pendingVote = null;
  s.current = entry || null;
  s.currentPriority = Number.isFinite(Number(entry?.priority)) ? Math.max(0, Math.min(100, Number(entry.priority))) : 0;
  s.position = entry && !entry.live ? validPos(entry.start) : 0;
  s.startedAt = now;
  s.playing = Boolean(entry) && playing;
}

/** Progress to next track, with single-track, full-queue and encounter resume semantics. */
function advance(s, now, natural = false) {
  const old = s.current;
  if (natural && old && !old.live && (old.loop || s.loopMode === "one")) {
    setCurrent(s, { ...old }, now, true); return;
  }
  if (s.resumeStack?.length) {
    const resume = s.resumeStack.pop();
    setCurrent(s, resume.entry, now, resume.playing);
    s.position = resume.position;
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
        try { entry = makeEntry({url: intent.url}, intent.title, intent.loop); } catch { return null; }
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
      case "PLAY":
        if (!host || !s.current || s.playing) return null;
        s.playing = true;
        s.startedAt = now;
        break;
      case "PAUSE":
        if (!host || !s.current || !s.playing) return null;
        s.position = expectedPosition(s, now);
        s.playing = false;
        s.startedAt = now;
        break;
      case "SEEK":
        if (!host || !s.current || s.current.live) return null;
        s.position = validPos(intent.position);
        s.startedAt = now;
        break;
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
        try { entry = makeEntry({url: intent.url}, intent.title, intent.loop); } catch { return null; }
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
