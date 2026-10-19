import { MODULE_ID } from "./state.js";

const icon = cls => `<i class="fa-solid ${cls}" aria-hidden="true"></i>`;
const fmt = seconds => {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${r}` : `${m}:${r}`;
};

/**
 * The minimized Watch Room: a small bar that stays on screen while the full player is moved out of view.
 * The player itself keeps running (it is only positioned off-screen, never paused or unloaded), so sound
 * and room sync carry on, including while the Foundry tab is in the background.
 */
export class MiniDock {
  constructor(room) {
    this.room = room;
    this.el = null;
  }

  create() {
    if (this.el) return this.el;
    const el = document.createElement("div");
    el.id = "fwr-mini";
    el.className = "fwr-mini";
    el.setAttribute("role", "region");
    el.setAttribute("aria-label", "Watch Room (minimized)");
    el.hidden = true;
    el.innerHTML = `
      <span class="fwr-mini-grip" title="Drag to move" aria-hidden="true">${icon("fa-grip-vertical")}</span>
      <span class="fwr-mini-eq" aria-hidden="true"><i></i><i></i><i></i></span>
      <div class="fwr-mini-text" title="Open the Watch Room">
        <strong data-mini-title>Watch Room</strong>
        <small data-mini-status></small>
      </div>
      <button type="button" class="fwr-mini-unlock" data-mini="unlock" hidden>${icon("fa-volume-high")} Click for sound</button>
      <button type="button" data-mini="toggle" aria-label="Play or pause">${icon("fa-play")}</button>
      <button type="button" data-mini="mute" aria-label="Mute">${icon("fa-volume-high")}</button>
      <button type="button" data-mini="restore" title="Open the full player" aria-label="Open the full player">${icon("fa-up-right-and-down-left-from-center")}</button>
      <button type="button" data-mini="close" title="Close the player (stops the sound for you)" aria-label="Close the player">${icon("fa-xmark")}</button>
      <div class="fwr-mini-progress" aria-hidden="true"><span data-mini-bar></span></div>`;
    el.addEventListener("click", event => this.onClick(event));
    el.querySelector(".fwr-mini-text").addEventListener("dblclick", () => this.room.restore());
    this.attachDrag(el);
    document.body.append(el);
    this.el = el;
    window.addEventListener("resize", () => this.place());
    return el;
  }

  show() {
    this.create();
    this.el.hidden = false;
    this.place();
    this.paint();
  }

  hide() {
    if (this.el) this.el.hidden = true;
  }

  get visible() { return Boolean(this.el && !this.el.hidden); }

  async onClick(event) {
    const button = event.target.closest("[data-mini]");
    if (!button) {
      if (event.target.closest(".fwr-mini-text") && !this.dragged) this.room.restore();
      return;
    }
    switch (button.dataset.mini) {
      case "restore": this.room.restore(); break;
      case "close": this.room.hide(); break;
      case "unlock": await this.room.unlockPlayback(); break;
      case "mute": this.room.toggleMute(); break;
      case "toggle": await this.room.togglePlayback(); break;
    }
    this.paint();
  }

  /** Refresh everything shown in the dock from the room's local state. */
  paint() {
    if (!this.visible) return;
    const room = this.room, s = room.state, entry = s.current, el = this.el;
    const playing = room.independent ? room.localPlaying : Boolean(s.playing);
    el.querySelector("[data-mini-title]").textContent = entry?.title || (s.open ? "Nothing playing" : "Room closed");
    el.querySelector(".fwr-mini-text").title = `${entry?.title ? `${entry.title} · ` : ""}Click to open the full player`;
    el.classList.toggle("fwr-mini-playing", Boolean(entry && playing && !room.blocked && room.currentVolume > 0));
    el.classList.toggle("fwr-mini-blocked", Boolean(room.blocked));

    const unlock = el.querySelector('[data-mini="unlock"]');
    unlock.hidden = !room.blocked;

    const toggle = el.querySelector('[data-mini="toggle"]');
    toggle.hidden = !entry || (!room.canControl && !room.independent) || entry.live;
    toggle.innerHTML = icon(playing ? "fa-pause" : "fa-play");
    toggle.title = room.independent ? (playing ? "Pause (just you)" : "Play (just you)") : (playing ? "Pause for everyone" : "Play for everyone");
    toggle.setAttribute("aria-label", toggle.title);

    const muted = Number(room.currentVolume) === 0;
    const mute = el.querySelector('[data-mini="mute"]');
    mute.innerHTML = icon(muted ? "fa-volume-xmark" : "fa-volume-high");
    mute.title = muted ? "Unmute (only affects you)" : "Mute (only affects you)";
    mute.setAttribute("aria-label", mute.title);
    mute.setAttribute("aria-pressed", String(muted));
    this.paintProgress();
  }

  /** Status line and progress bar; called twice a second while the room is showing. */
  paintProgress() {
    if (!this.visible) return;
    const room = this.room, s = room.state, entry = s.current;
    const duration = Number(room.adapter?.getDuration?.()) || 0;
    const t = room.currentPosition();
    const playing = room.independent ? room.localPlaying : Boolean(s.playing);
    let status;
    if (!s.open) status = "The room has ended";
    else if (!entry) status = "Waiting for the next track";
    else if (room.blocked) status = "Your browser needs a click to play sound";
    else if (entry.live) status = "● Live";
    else {
      const time = duration ? `${fmt(t)} / ${fmt(duration)}` : fmt(t);
      status = `${playing ? "Playing" : "Paused"} · ${time}`;
      if (Number(room.currentVolume) === 0) status += " · muted";
      if (room.independent) status += " · on your own";
    }
    const line = this.el.querySelector("[data-mini-status]");
    if (line.textContent !== status) line.textContent = status;
    const bar = this.el.querySelector("[data-mini-bar]");
    bar.style.width = duration > 0 && !entry?.live ? `${Math.min(100, (t / duration) * 100).toFixed(2)}%` : "0%";
  }

  /** Saved position (client setting), clamped into the viewport; default is just above the launcher. */
  place() {
    if (!this.visible) return;
    let saved = null;
    try { saved = game.settings.get(MODULE_ID, "miniPosition"); } catch { /* not registered (tests) */ }
    const style = this.el.style;
    if (!saved || !Number.isFinite(saved.left) || !Number.isFinite(saved.top)) {
      style.left = ""; style.top = ""; style.bottom = "";
      this.el.classList.toggle("fwr-mini-no-launcher", !document.getElementById("fwr-launcher"));
      return;
    }
    const r = this.el.getBoundingClientRect();
    style.bottom = "auto";
    style.left = `${Math.max(0, Math.min(saved.left, innerWidth - r.width))}px`;
    style.top = `${Math.max(0, Math.min(saved.top, innerHeight - r.height))}px`;
  }

  attachDrag(el) {
    let start = null;
    // Track the drag on the window: the pointer usually leaves the small bar before the drag threshold is met.
    const move = event => {
      if (!start || event.pointerId !== start.id) return;
      const dx = event.clientX - start.x, dy = event.clientY - start.y;
      if (!this.dragged && Math.hypot(dx, dy) < 5) return;
      if (!this.dragged) { this.dragged = true; el.classList.add("fwr-mini-dragging"); }
      const r = el.getBoundingClientRect();
      el.style.bottom = "auto";
      el.style.left = `${Math.max(0, Math.min(start.left + dx, innerWidth - r.width))}px`;
      el.style.top = `${Math.max(0, Math.min(start.top + dy, innerHeight - r.height))}px`;
    };
    const end = event => {
      if (!start || event.pointerId !== start.id) return;
      start = null;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      el.classList.remove("fwr-mini-dragging");
      if (!this.dragged) return;
      const r = el.getBoundingClientRect();
      try { game.settings.set(MODULE_ID, "miniPosition", { left: Math.round(r.left), top: Math.round(r.top) }); } catch { /* tests */ }
      // Swallow the click that ends a drag, so dropping the bar on its title doesn't also open the player.
      setTimeout(() => { this.dragged = false; }, 0);
    };
    el.addEventListener("pointerdown", event => {
      if (event.button !== 0 || event.target.closest("button")) return;
      const r = el.getBoundingClientRect();
      start = { x: event.clientX, y: event.clientY, left: r.left, top: r.top, id: event.pointerId };
      this.dragged = false;
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", end);
      window.addEventListener("pointercancel", end);
    });
  }
}
