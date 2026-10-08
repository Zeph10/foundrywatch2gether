import { MODULE_ID, expectedPosition, externalUrl } from "./state.js";

/** Seconds added when (re)loading the pop-up, to cover the provider page's load time. */
const LOAD_LEAD = 2;

/**
 * Synced pop-up playback for videos that can't be embedded. Each viewer opens the provider's own
 * page in a named pop-up window. While "follow the room" is on, the room drives that window:
 * play/seek reload it at the room's current time, pause swaps in a local "paused" page.
 * (The page itself is cross-origin, so the module can navigate it but not read or control it.)
 */
export class ExternalViewer {
  constructor(watch) {
    this.watch = watch;
    this.win = null;
    this.lastKey = "";
  }

  get name() { return `fwr-external-${game.world?.id || "room"}`; }
  get isOpen() { return Boolean(this.win && !this.win.closed); }
  get follow() { return game.settings.get(MODULE_ID, "externalFollow"); }

  /** What the pop-up should show right now. */
  targetUrl() {
    const s = this.watch.state;
    const entry = s.current;
    if (!entry) return this.pausedUrl(null, 0, "Nothing is playing in the room.");
    if (!s.playing) return this.pausedUrl(entry, expectedPosition(s), "The room is paused. This window resumes when the room plays.");
    return externalUrl(entry, entry.live ? 0 : expectedPosition(s) + LOAD_LEAD);
  }
  pausedUrl(entry, seconds, message) {
    const params = new URLSearchParams({ title: entry?.title || "Watch Room", at: String(Math.floor(seconds || 0)), message });
    return `modules/${MODULE_ID}/templates/external.html?${params}`;
  }
  stateKey() {
    const s = this.watch.state;
    return `${s.current?.uid}|${s.playing}|${s.position}|${s.startedAt}`;
  }

  /** From a click: open (or bring back) the pop-up at the room's current point. */
  open() {
    const url = this.targetUrl();
    const features = "popup=yes,width=1120,height=700";
    let win = null;
    try { win = window.open(url, this.name, features); } catch { win = null; }
    if (!win) {
      this.watch.setMessage("Your browser blocked the pop-up. Allow pop-ups for this site and try again.", true);
      return false;
    }
    this.win = win;
    this.lastKey = this.stateKey();
    try { win.focus(); } catch { /* cross-origin */ }
    this.paint();
    return true;
  }

  navigate(url) {
    if (!this.isOpen) return;
    try { this.win.location.href = new URL(url, location.href).href; }
    catch { try { this.win = window.open(url, this.name) || this.win; } catch { /* blocked */ } }
  }

  /** Called whenever room state changes. */
  sync() {
    const current = this.watch.state.current;
    if (!this.isOpen) { this.paint(); return; }
    if (!current?.external || !this.watch.state.open) {
      // The room moved on to something that plays inside Foundry.
      this.close();
      return;
    }
    if (!this.follow) { this.paint(); return; }
    const key = this.stateKey();
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.navigate(this.targetUrl());
    this.paint();
  }

  close() {
    try { this.win?.close(); } catch { /* already closed */ }
    this.win = null;
    this.lastKey = "";
    this.paint();
  }

  /** Refresh the in-room panel (button label, follow checkbox, status line). */
  paint() {
    const root = this.watch.root;
    const panel = root?.querySelector(".fwr-external");
    if (!panel) return;
    const label = panel.querySelector("[data-external-label]");
    if (label) label.textContent = this.isOpen ? "Bring pop-up back to the room's time" : "Open synced pop-up";
    const follow = panel.querySelector("[data-external-follow]");
    if (follow) follow.checked = this.follow;
    const status = panel.querySelector("[data-external-status]");
    if (status) {
      const s = this.watch.state;
      status.textContent = !this.isOpen ? "Each player opens their own pop-up. Your browser may ask to allow pop-ups."
        : !this.follow ? "Following is off: use the button to jump to the room's time."
        : s.playing ? "Following the room. Pausing or seeking here reloads the pop-up." : "Room paused: the pop-up shows a paused page until it resumes.";
    }
  }
}
