import { MODULE_ID } from "./state.js";

const SOCKET = `module.${MODULE_ID}`;
const HEARTBEAT = 10000;
const STALE_AFTER = 25000;

/** What each status means and how it's shown. `listening` marks statuses that count as "in the room". */
export const LISTENER_STATUS = Object.freeze({
  listening:     { label: "Listening", icon: "fa-headphones", listening: true },
  ready:         { label: "In the room (paused)", icon: "fa-circle-pause", listening: true },
  idle:          { label: "In the room (nothing playing)", icon: "fa-circle", listening: true },
  popup:         { label: "Watching in the pop-up", icon: "fa-up-right-from-square", listening: true },
  independent:   { label: "Watching on their own", icon: "fa-person-walking", listening: true },
  loading:       { label: "Loading…", icon: "fa-spinner", listening: false },
  muted:         { label: "Muted", icon: "fa-volume-xmark", listening: false },
  blocked:       { label: "Needs a click to start sound", icon: "fa-hand-pointer", listening: false },
  "popup-closed":{ label: "Pop-up not open", icon: "fa-window-restore", listening: false },
  error:         { label: "Can't play this video", icon: "fa-triangle-exclamation", listening: false },
  hidden:        { label: "Player closed", icon: "fa-eye-slash", listening: false },
  unknown:       { label: "Not responding (module still loading or disabled?)", icon: "fa-circle-question", listening: false }
});

/** Work out this browser's own status from the room's local state (pure; see Presence.compute). */
export function computeStatus(room) {
  const s = room.state;
  if (!s?.open) return "idle";
  if (room.hidden) return "hidden";
  if (room.blocked) return "blocked";
  if (!s.current) return "idle";
  const kind = room.adapter?.kind;
  if (kind === "external") return room.externalOpen ? "popup" : "popup-closed";
  if (room.playerErrorUid === s.current.uid || room.embedBlockedUid === s.current.uid) return "error";
  if (!room.adapter) return "loading";
  if (room.independent) return "independent";
  if (Number(room.currentVolume) === 0) return "muted";
  if (!s.playing) return "ready";
  return room.observedPlaying ? "listening" : "loading";
}

/**
 * Who is listening: each client broadcasts its own status on change and every 10 s; everyone keeps
 * a table. Users who are logged in but never report are "not responding" (e.g. the module isn't
 * enabled for them yet, or their page is still loading).
 */
export class Presence {
  constructor(room) {
    this.room = room;
    this.table = new Map(); // userId -> { status, at }
    this.lastSent = "";
    this.lastSentAt = 0;
  }

  start() {
    this.update(true, true);
    this.timer = setInterval(() => this.update(Date.now() - this.lastSentAt > HEARTBEAT), 2000);
    Hooks.on("userConnected", (user, connected) => {
      if (!connected) this.table.delete(user.id);
      else this.update(true, true); // say hello to the newcomer
      this.room.paintListeners?.();
    });
  }

  /** Recompute this client's status; broadcast when it changed (or `force`). */
  update(force = false, hello = false) {
    const status = computeStatus({
      state: this.room.state, hidden: this.room.hidden, blocked: this.room.blocked, adapter: this.room.adapter,
      externalOpen: this.room.external?.isOpen, playerErrorUid: this.room.playerErrorUid,
      embedBlockedUid: this.room.embedBlockedUid, independent: this.room.independent,
      currentVolume: this.room.currentVolume, observedPlaying: this.room.observedPlaying
    });
    const changed = status !== this.lastSent;
    this.table.set(game.user.id, { status, at: Date.now() });
    if (!changed && !force) return;
    this.lastSent = status;
    this.lastSentAt = Date.now();
    game.socket.emit(SOCKET, { kind: "presence", userId: game.user.id, status, hello });
    if (changed) this.room.paintListeners?.();
  }

  receive(msg) {
    if (!msg?.userId || !game.users.get(msg.userId)?.active || !LISTENER_STATUS[msg.status]) return;
    const before = this.table.get(msg.userId)?.status;
    this.table.set(msg.userId, { status: msg.status, at: Date.now() });
    // A client that just arrived asks for everyone's status by saying hello; answer it.
    if (msg.hello) setTimeout(() => this.update(true), 200 + Math.random() * 600);
    if (before !== msg.status) this.room.paintListeners?.();
  }

  statusOf(userId) {
    if (userId === game.user.id) return this.table.get(userId)?.status || "loading";
    const row = this.table.get(userId);
    if (!row || Date.now() - row.at > STALE_AFTER) return "unknown";
    return row.status;
  }

  isListening(userId) {
    return Boolean(LISTENER_STATUS[this.statusOf(userId)]?.listening);
  }

  /** Logged-in users with their status, listeners first; plus the names of offline users. */
  roster() {
    const active = [...game.users].filter(u => u.active).map(user => ({ user, status: this.statusOf(user.id) }));
    active.sort((a, b) => Number(this.isListening(b.user.id)) - Number(this.isListening(a.user.id)) ||
      Number(b.user.isGM) - Number(a.user.isGM) || String(a.user.name).localeCompare(String(b.user.name)));
    const offline = [...game.users].filter(u => !u.active).map(u => u.name);
    return { active, offline, listening: active.filter(r => LISTENER_STATUS[r.status]?.listening).length };
  }
}
