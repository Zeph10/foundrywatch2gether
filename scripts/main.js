import { MODULE_ID, MAX_QUEUE, initialState, expectedPosition, canControl, reduceWithAutoOpen, serverNow, parseSource } from "./state.js";
import { createAdapter } from "./providers.js";
import { raise } from "./ui.js";
import { MusicFeatures } from "./music-features.js";
import { Director } from "./director.js";

const SOCKET = `module.${MODULE_ID}`;
const q = (root, sel) => root?.querySelector(sel);
const fmt = s => { s = Math.max(0, Math.floor(s || 0)); return `${Math.floor(s / 3600) ? `${Math.floor(s / 3600)}:` : ""}${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`; };
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const icon = cls => `<i class="fa-solid ${cls}" aria-hidden="true"></i>`;
const AUTOPLAY_MESSAGE = "Your browser blocked autoplay. Click 'enable playback' to start watching.";
/** Drift (seconds) tolerated before a periodic correction, and after a forced (state-change) sync. */
const DRIFT_PERIODIC = 2.5;
const DRIFT_FORCED = 0.75;
/** Intents whose rejection is an expected race and shouldn't be reported to the user. */
const QUIET_REJECTIONS = new Set(["ENDED", "NEXT", "VOTE_TIMEOUT"]);
const LOOP_LABELS = { off: "Repeat: off", one: "Repeat: current track", queue: "Repeat: whole queue" };


class WatchRoom {
  constructor() {
    this.state = initialState();
    this.root = null;
    this.adapter = null;
    this.loadedUid = null;
    this.loadGeneration = 0;
    this.autoOpenedRoomId = null;
    this.hidden = true;
    this.independent = false;
    this.mode = "window";
    this.currentVolume = 0.7;
    this.pending = Promise.resolve();
    this.pipWindow = null;
    this.syncBusy = false;
    this.resyncQueued = null;
    this.blocked = false;
    this.observedPlaying = null;
    this.confirmedPlayingUid = null;
    this.playerErrorUid = null;
    this.localPlaying = false;
    this.pendingScene = null;
    this.sidebarOpen = { window: true, scene: false };
    this.compact = false;
    this.music = new MusicFeatures(this);
    this.director = new Director(this);
  }

  get isLeader() {
    const active = game.users.activeGM;
    if (active !== undefined) return Boolean(active?.isSelf ?? active?.id === game.user.id);
    const gms = game.users.filter(u => u.active && u.isGM).sort((a, b) => a.id.localeCompare(b.id));
    return gms[0]?.id === game.user.id;
  }
  get canControl() { return canControl(this.state, game.user); }
  get canModerate() { return game.user.isGM || this.state.hostId === game.user.id; }
  get layout() { return this.root?.classList.contains("fwr-scene") ? "scene" : "window"; }

  start() {
    this.independent = game.settings.get(MODULE_ID, "independent");
    this.mode = game.settings.get(MODULE_ID, "mode");
    this.compact = game.settings.get(MODULE_ID, "compact");
    this.music.start();
    this.director.start();
    this.currentVolume = game.settings.get(MODULE_ID, "volume");
    game.socket.on(SOCKET, payload => this.onSocket(payload));
    if (game.settings.get(MODULE_ID, "showLauncher")) this.makeLauncher();
    this.acceptState(game.settings.get(MODULE_ID, "roomState"), true);
    Hooks.on("canvasReady", () => this.scenePosition());
    Hooks.on("canvasPan", () => this.scenePosition());
    Hooks.on("canvasTearDown", () => this.scenePosition());
    window.addEventListener("resize", () => this.scenePosition(true));
    // Progress repaints are cheap and keep the clock smooth; drift checks are less frequent.
    this.progressTimer = setInterval(() => { if (!this.hidden) this.paintProgress(); }, 500);
    this.timer = setInterval(() => {
      if (!this.hidden) {
        this.scenePosition();
        this.reconcile(false).catch(console.error);
      }
    }, 2500);
    this.voteTimer = setInterval(() => {
      if (this.isLeader && this.state.pendingVote?.expiresAt <= serverNow()) this.issue('VOTE_TIMEOUT');
    }, 1000);
  }

  makeLauncher() {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.id = "fwr-launcher";
    btn.className = "fwr-launcher";
    btn.title = "Shared Watch Room";
    btn.innerHTML = `${icon("fa-tv")} <span>Watch Room</span>`;
    btn.addEventListener("click", () => this.toggleVisible());
    document.body.append(btn);
    this.launcher = btn;
    this.updateLauncher();
  }
  updateLauncher() {
    if (!this.launcher) return;
    this.launcher.classList.toggle("fwr-live", Boolean(this.state.open));
    this.launcher.setAttribute("aria-pressed", String(!this.hidden));
    this.launcher.setAttribute("aria-label", this.state.open ? "Shared watch room (live)" : "Shared watch room");
  }
  toggleVisible() {
    if (this.hidden) this.show();
    else this.hide();
  }

  issue(type, props = {}) {
    // Encounter music and cinematics open a closed room on the leader, in the same transaction.
    const payload = { kind: "intent", actorId: game.user.id, intent: { type, ...props } };
    if (this.isLeader) this.processIntent(payload);
    else if (game.users.some(u => u.active && u.isGM)) game.socket.emit(SOCKET, payload);
    else {
      ui.notifications?.warn("A connected GM is needed to change the shared room.");
      this.setMessage("A connected GM is needed to change the shared room.", true);
    }
  }

  onSocket(payload) {
    if (!payload || typeof payload !== "object") return;
    if (payload.kind === "intent" && this.isLeader) this.processIntent(payload);
    if (payload.kind === 'director-journal' && payload.actorId && game.users.get(payload.actorId)?.isGM)
      this.director.showJournal(payload.journalId);
    if (payload.kind === "director-event" && this.isLeader && game.users.get(payload.actorId)?.isGM)
      this.runForwardedEvent(payload);
    if (payload.kind === "refresh") this.acceptState(game.settings.get(MODULE_ID, "roomState"));
    if (payload.kind === "rejected" && payload.userId === game.user.id) this.onRejected(payload.type);
  }

  /** Automation hooks only run on the leader; other GMs' macros are forwarded to it. */
  fireEvent(system, event, context = {}) {
    if (!game.user.isGM) return false;
    if (this.isLeader) return system === "music" ? (this.music.fire(event, context), true) : this.director.fire(event, context);
    const plain = { ...context };
    for (const key of ["actor", "combat"]) {
      if (plain[key] && typeof plain[key] === "object") { plain[`${key}Uuid`] = plain[key].uuid; delete plain[key]; }
    }
    try { game.socket.emit(SOCKET, { kind: "director-event", actorId: game.user.id, system, event, context: JSON.parse(JSON.stringify(plain)) }); }
    catch (error) { console.warn(`${MODULE_ID} | Couldn't forward event`, error); return false; }
    return true;
  }
  runForwardedEvent({ system, event, context = {} }) {
    if (typeof event !== "string") return;
    const ctx = { ...context };
    const resolve = uuid => { try { return uuid ? globalThis.fromUuidSync?.(uuid) ?? null : null; } catch { return null; } };
    if (ctx.actorUuid) ctx.actor = resolve(ctx.actorUuid);
    if (ctx.combatUuid) ctx.combat = resolve(ctx.combatUuid);
    delete ctx.actorUuid; delete ctx.combatUuid;
    if (system === "music") this.music.fire(event, ctx);
    else this.director.fire(event, ctx);
  }

  broadcastJournal(journalId) {
    if (!game.user.isGM || !game.journal?.get(journalId)) return;
    this.director.showJournal(journalId);
    game.socket.emit(SOCKET, {kind:'director-journal', actorId:game.user.id, journalId});
  }

  onRejected(type) {
    if (type === "SCENE") { this.pendingScene = null; this.scenePosition(); }
    if (QUIET_REJECTIONS.has(type)) return;
    const message = ["TRIGGER", "PLAY_LIBRARY", "RUN_TRIGGER"].includes(type)
      ? "A higher-priority track is playing, so that cue was skipped."
      : type === "PROPOSE" ? "A vote is already in progress, or that track is no longer queued."
      : "The room didn't accept that change. Permissions or the room may have changed.";
    if (this.hidden && game.user.isGM && type !== "TRIGGER") ui.notifications?.warn(message);
    this.setMessage(message, true);
    this.updateUI();
  }

  processIntent(payload) {
    this.pending = this.pending.then(async () => {
      if (!this.isLeader) return;
      let actor = game.users.get(payload.actorId);
      if (!actor?.active) return;
      let intent = payload.intent;
      if (intent?.type === 'PLAY_LIBRARY') {
        if (!(actor.isGM || canControl(this.state,actor))) return;
        const track = this.music.library.find(t => t.id === intent.libraryId);
        if (!track) return;
        intent = {type:'TRIGGER',url:track.url,title:track.title,loop:track.loop,
          action:intent.action==='queue'?'queue':'interrupt',priority:Number(intent.priority ?? 50),
          resume:Boolean(intent.resume),force:Boolean(intent.force && actor.isGM),quiet:Boolean(intent.quiet)};
        if (!actor.isGM) actor = game.users.get(game.user.id);
      }
      if (intent?.type === 'RUN_TRIGGER') {
        if (!(actor.isGM || canControl(this.state, actor))) return;
        const rule = this.music.triggers.find(t => t.id === intent.triggerId && t.event === 'manual' && t.enabled);
        const track = this.music.library.find(t => t.id === rule?.libraryId);
        if (!rule || !track) return;
        // Only the leader's trusted configuration determines what the trigger plays.
        intent = {type:'TRIGGER',url:track.url,title:track.title,loop:track.loop,action:rule.action,resume:rule.resume,priority:rule.priority ?? 50};
        // Don't grant arbitrary TRIGGER permission to users via the socket.
        if (!actor.isGM) actor = game.users.get(game.user.id);
      }
      const old = game.settings.get(MODULE_ID, "roomState");
      const next = reduceWithAutoOpen(old, intent, actor, game.users,
        game.settings.get(MODULE_ID, "createRole"), serverNow(), game.settings.get(MODULE_ID, "autoOpenRoom"));
      if (!next) {
        const type = payload.intent?.type;
        // Automation (hooks, timelines) is expected to be rejected sometimes, e.g. by priority.
        if (payload.intent?.forUid || payload.intent?.quiet) return;
        if (actor.isSelf || actor.id === game.user.id) this.onRejected(type);
        else game.socket.emit(SOCKET, { kind: "rejected", userId: actor.id, type });
        return;
      }
      await game.settings.set(MODULE_ID, "roomState", next);
      // World-setting onChange already reaches every client; this is a fallback nudge.
      game.socket.emit(SOCKET, { kind: "refresh" });
    }).catch(error => console.error(`${MODULE_ID} | Intent error`, error));
  }

  acceptState(value, initial = false) {
    const prior = this.state;
    const s = value?.revision !== undefined ? value : initialState();
    // Each change arrives twice (setting onChange + refresh socket); ignore stale and duplicate revisions.
    if (!initial && s.revision <= prior.revision && s.roomId === prior.roomId) return;
    if (!initial && s.revision < prior.revision) return;
    this.state = s;
    this.pendingScene = null;
    const focus = Boolean(s.cinematicFocus && !this.independent);
    if (s.open && focus && this.hidden) this.show();
    this.root?.classList.toggle('fwr-cinematic',focus);
    this.root?.setAttribute('data-director-active',String(Boolean(s.cinematic)));
    if (JSON.stringify(prior.cinematic ?? null) !== JSON.stringify(s.cinematic ?? null)) this.director.render();
    this.updateLauncher();
    if (!s.open) {
      if (prior.open) {
        if (!initial) ui.notifications?.info("The shared watch room has ended.");
        this.hide();
        this.unloadPlayer();
      }
      if (!this.hidden) this.updateUI();
      return;
    }
    if (s.roomId !== this.autoOpenedRoomId) {
      this.autoOpenedRoomId = s.roomId;
      if (game.settings.get(MODULE_ID, "autoJoin")) this.show();
      else if (!initial && this.hidden) ui.notifications?.info("A shared watch room has started. Open Watch Room to join.");
    }
    if (!this.hidden) {
      this.updateUI();
      if ((s.current?.uid || null) !== this.loadedUid) this.loadCurrent();
      else {
        const playbackChanged = !prior.open || prior.playing !== s.playing || prior.position !== s.position ||
          prior.startedAt !== s.startedAt;
        this.reconcile(playbackChanged).catch(console.error);
      }
    }
  }

  unloadPlayer() {
    ++this.loadGeneration;
    try { this.adapter?.destroy(); } catch (error) { console.warn(error); }
    this.adapter = null;
    this.loadedUid = null;
    this.observedPlaying = null;
    this.confirmedPlayingUid = null;
  }

  createUI() {
    if (this.root) return;
    const root = document.createElement("section");
    root.id = "fwr-room";
    root.className = "fwr-room fwr-window";
    root.setAttribute("aria-label", "Foundry shared watch room");
    root.innerHTML = `
      <header class="fwr-header" data-drag="true">
        <div class="fwr-brand">${icon("fa-tv")} <strong>Watch Room</strong> <span class="fwr-badge">SHARED</span></div>
        <div class="fwr-top-actions">
          <button type="button" data-act="compact" title="Switch between compact thumbnail and full player" aria-label="Toggle compact player">${icon("fa-down-left-and-up-right-to-center")}</button>
          <button type="button" data-act="music-manager" title="Saved music and encounter triggers" aria-label="Music library and triggers">${icon("fa-music")}</button>
          <button type="button" data-act="director" title="Encounter & Cinematic Director" aria-label="Encounter and cinematic director">${icon("fa-wand-magic-sparkles")}</button>
          <button type="button" data-act="sidebar" title="Show or hide the queue" aria-label="Show or hide the queue">${icon("fa-list")}</button>
          <button type="button" data-act="mode" title="Toggle window / scene view">${icon("fa-layer-group")} <span>Scene</span></button>
          <button type="button" data-act="pip" title="Picture-in-Picture" aria-label="Picture-in-Picture">${icon("fa-up-right-and-down-left-from-center")}</button>
          <button type="button" data-act="fullscreen" title="Fullscreen" aria-label="Fullscreen">${icon("fa-expand")}</button>
          <button type="button" data-act="hide" title="Hide locally without closing the room" aria-label="Hide watch room">${icon("fa-xmark")}</button>
        </div>
      </header>
      <div class="fwr-body">
        <div class="fwr-left">
          <div class="fwr-media">
            <div class="fwr-player" data-player></div>
            <div class="fwr-placeholder" data-placeholder><div class="fwr-television">${icon("fa-film")}</div><p>Nothing is playing yet</p><small data-placeholder-hint>Use the queue to add a video.</small></div>
            <button type="button" class="fwr-unlock" data-act="unlock" hidden>${icon("fa-play")} Click to enable playback</button>
          </div>
          <div class="fwr-now"><span data-provider>WAITING</span> <strong data-title>No video selected</strong></div>
          <div class="fwr-controls">
            <div class="fwr-actions">
              <button type="button" data-act="toggle" title="Play or pause" aria-label="Play or pause">${icon("fa-play")}</button>
              <button type="button" data-act="next" title="Play next video" aria-label="Play next video">${icon("fa-forward-step")}</button>
              <button type="button" data-act="loop" title="Loop mode" aria-label="Change loop mode">${icon("fa-repeat")}</button>
              <button type="button" data-act="track-loop" title="Loop this track" aria-label="Toggle track loop">${icon("fa-arrows-rotate")}</button>
              <span class="fwr-time" data-time>00:00 / --:--</span>
              <span class="fwr-grow"></span>
              <div class="fwr-volume" title="Your volume (only affects you)"><button type="button" data-act="mute" class="fwr-mute" aria-label="Mute">${icon("fa-volume-high")}</button><input data-volume type="range" min="0" max="1" step="0.01" value="0.7" aria-label="Local volume"></div>
            </div>
            <input data-seek class="fwr-scrub" type="range" min="0" max="100" step="0.1" value="0" aria-label="Video position">
            <div class="fwr-options">
              <label><input data-independent type="checkbox"> Independent playback</label>
              <span data-sync>Synced with room</span>
            </div>
          </div>
          <div class="fwr-vote" data-vote-panel hidden>
            <div data-vote-label></div>
            <div class="fwr-vote-actions">
              <button type="button" data-act="vote-yes">Yes</button><button type="button" data-act="vote-no">No</button>
              <button type="button" data-act="vote-approve">GM approve</button><button type="button" data-act="vote-reject">GM reject</button>
            </div>
          </div>
          <div class="fwr-message" data-message role="status" aria-live="polite"></div>
        </div>
        <aside class="fwr-sidebar">
          <div class="fwr-section-heading"><strong>Video / audio queue</strong><span data-count>0 queued</span></div>
          <label class="fwr-vote-toggle" data-vote-toggle><input type="checkbox" data-vote-mode> Vote before changing songs (GM override)</label>
          <form class="fwr-add" data-add-form>
            <input data-url type="text" placeholder="YouTube / Twitch / MP3 / MP4 / audio URL" aria-label="Video URL" required maxlength="2048">
            <input data-video-title type="text" placeholder="Title (optional)" aria-label="Optional title" maxlength="120">
            <div class="fwr-add-row">
              <button type="submit">${icon("fa-plus")} Add video</button>
              <button type="button" data-act="browse" title="Pick a video or audio file from Foundry" aria-label="Browse files">${icon("fa-folder-open")}</button>
              <button type="button" data-act="music-manager" title="Library and encounter themes">${icon("fa-music")}</button>
            </div>
          </form>
          <ol class="fwr-list" data-list></ol>
          <div class="fwr-permissions" data-permissions>
            <div class="fwr-section-heading"><strong>Playback permissions</strong></div>
            <div data-members></div>
          </div>
          <div class="fwr-room-actions">
            <button type="button" data-act="place-scene" title="Place a shared video surface on the active scene">${icon("fa-map")} Place in scene</button>
            <button type="button" data-act="remove-scene" title="Remove shared scene placement">${icon("fa-trash-can")} Clear scene</button>
            <button type="button" data-act="take-host" title="GM: take over as host">${icon("fa-crown")} Take host</button>
            <button type="button" data-act="close-room" class="fwr-danger">${icon("fa-power-off")} End room</button>
          </div>
          <div class="fwr-footer"><small data-host>Host: —</small><small data-scene-note></small></div>
        </aside>
      </div>
      <div class="fwr-closed" data-closed hidden>
        <div class="fwr-closed-icon">${icon("fa-tv")}</div>
        <strong>No shared room is open</strong>
        <p data-closed-hint>A GM or permitted player can start one room for everyone.</p>
        <button type="button" data-act="open-room">${icon("fa-play")} Start watch room</button>
      </div>`;
    root.addEventListener("click", event => this.onClick(event));
    q(root, "[data-add-form]").addEventListener("submit", event => this.onAdd(event));
    q(root, "[data-independent]").addEventListener("change", event => this.setIndependent(event.target.checked));
    q(root, '[data-vote-mode]').addEventListener('change', e => this.issue('VOTE_MODE',{enabled:e.target.checked}));
    const volume = q(root, "[data-volume]");
    volume.addEventListener("input", event => this.setVolume(Number(event.target.value), false));
    volume.addEventListener("change", event => this.setVolume(Number(event.target.value), true));
    const seek = q(root, "[data-seek]");
    seek.addEventListener("input", event => this.previewSeek(Number(event.target.value)));
    seek.addEventListener("change", event => { this.scrubbing = false; this.onSeek(Number(event.target.value)); });
    q(root, "[data-members]").addEventListener("change", event => {
      const el = event.target.closest("input[data-permit]");
      if (el) this.issue(el.checked ? "GRANT" : "REVOKE", {userId: el.dataset.permit});
    });
    root.addEventListener("keydown", event => this.onKey(event));
    this.attachDrag(root);
    document.body.append(root);
    this.root = root;
    // Persist native CSS resizes of the floating window (debounced).
    if (globalThis.ResizeObserver) {
      let timeout;
      this.resizeObserver = new ResizeObserver(() => {
        clearTimeout(timeout);
        timeout = setTimeout(() => this.saveWindowRect(), 400);
      });
      this.resizeObserver.observe(root);
    }
  }

  show() {
    this.createUI();
    this.hidden = false;
    this.root.hidden = false;
    this.applyGeometry = true;
    this.updateUI();
    this.updateLauncher();
    if (this.layout === "window") this.bringToFront();
    if (this.state.open && (this.state.current?.uid || null) !== this.loadedUid) this.loadCurrent();
    else this.reconcile(true).catch(console.error);
  }
  hide() {
    this.hidden = true;
    if (this.pipWindow) { try { this.pipWindow.close(); } catch { /* already closed */ } }
    if (this.root) this.root.hidden = true;
    if (this.adapter) { try { this.adapter.pause(); } catch { /* not ready */ } }
    this.observedPlaying = false;
    this.localPlaying = false;
    this.updateLauncher();
  }

  updateUI() {
    if (!this.root) return;
    const s = this.state; const el = this.root;
    const open = Boolean(s.open);
    q(el, "[data-closed]").hidden = open;
    q(el, ".fwr-body").hidden = !open;
    const mayCreate = game.user.isGM || Number(game.user.role) >= Number(game.settings.get(MODULE_ID, "createRole"));
    q(el, "[data-act=\"open-room\"]").disabled = !mayCreate;
    q(el, "[data-closed-hint]").textContent = mayCreate ? "Start one room for everyone in this world."
      : "A GM or permitted player can start one room for everyone.";
    for (const act of ["mode", "pip", "fullscreen", "sidebar", "compact"]) q(el, `[data-act="${act}"]`).hidden = !open;
    el.querySelectorAll('[data-act="music-manager"]').forEach(b => b.hidden = !game.user.isGM);
    el.classList.toggle('fwr-compact', this.compact);
    if (open) q(el, '[data-act="mode"]').hidden = this.compact;
    if (!open) { this.scenePosition(); return; }
    const canEdit = this.canControl;
    q(el, "[data-provider]").textContent = s.current ? (s.current.live ? "LIVE" : s.current.audio ? 'AUDIO' : s.current.provider.toUpperCase()) : "WAITING";
    q(el, '.fwr-media').classList.toggle('fwr-audio',Boolean(s.current?.audio));
    q(el, '[data-act="compact"]').title = this.compact ? 'Expand player' : 'Compact thumbnail player';
    q(el, '[data-act="compact"]').innerHTML = this.compact ? icon('fa-up-right-and-down-left-from-center') : icon('fa-down-left-and-up-right-to-center');
    q(el, "[data-title]").textContent = s.current?.title || "No video selected";
    q(el, "[data-title]").title = s.current?.title || "";
    q(el, "[data-count]").textContent = `${s.queue.length} queued`;
    const hostUser = game.users.get(s.hostId);
    q(el, "[data-host]").textContent = `Host: ${hostUser?.name || "Unknown"}${hostUser && !hostUser.active ? " (offline)" : ""}`;
    q(el, "[data-scene-note]").textContent = s.scene ? `Scene: ${game.scenes.get(s.scene.sceneId)?.name || "Unavailable"}` : "No scene placement";
    q(el, "[data-placeholder-hint]").textContent = canEdit ? "Add a video to the queue to begin." : "Waiting for the host to pick a video.";
    q(el, "[data-url]").disabled = !canEdit;
    q(el, "[data-video-title]").disabled = !canEdit;
    q(el, "[data-add-form] button[type=submit]").disabled = !canEdit;
    q(el, "[data-act=\"browse\"]").hidden = !canEdit || !this.filePickerClass;
    const toggle = q(el, "[data-act=\"toggle\"]");
    toggle.disabled = !s.current || (!canEdit && !this.independent);
    const showPause = this.independent ? Boolean(this.localPlaying) : Boolean(s.playing);
    toggle.innerHTML = showPause ? icon("fa-pause") : icon("fa-play");
    toggle.title = showPause ? (this.independent ? "Pause locally" : "Pause for everyone") : (this.independent ? "Play locally" : "Play for everyone");
    toggle.setAttribute("aria-label", toggle.title);
    // With voting on, any player may propose a skip; controllers who aren't GMs also go through the vote.
    q(el, "[data-act=\"next\"]").disabled = !(canEdit || s.voteMode) || (!s.current && !s.queue.length);
    q(el, "[data-act=\"next\"]").title = s.voteMode && !game.user.isGM ? "Propose skipping to the next track" : "Play next track";
    const loopMode = LOOP_LABELS[s.loopMode] ? s.loopMode : "off";
    const loop = q(el, "[data-act=\"loop\"]");
    loop.disabled = !canEdit;
    loop.dataset.mode = loopMode;
    loop.setAttribute("aria-pressed", String(loopMode !== "off"));
    loop.title = `${LOOP_LABELS[loopMode]}${canEdit ? " (click to change)" : ""}`;
    loop.setAttribute("aria-label", loop.title);
    loop.innerHTML = icon("fa-repeat") + (loopMode === "one" ? '<span class="fwr-loop-badge">1</span>' : "");
    const trackLoop = q(el, "[data-act=\"track-loop\"]");
    trackLoop.disabled = !canEdit || !s.current || s.current.live;
    trackLoop.setAttribute("aria-pressed", String(Boolean(s.current?.loop)));
    trackLoop.title = s.current?.loop ? "This track loops (click to stop looping)" : "Loop this track";
    const voteToggle = q(el, "[data-vote-toggle]");
    voteToggle.hidden = !this.canModerate;
    q(el, "[data-vote-mode]").checked = Boolean(s.voteMode);
    q(el, "[data-seek]").disabled = !s.current || s.current.live || (!canEdit && !this.independent);
    q(el, "[data-independent]").checked = this.independent;
    q(el, "[data-sync]").textContent = this.independent ? "Independent / local-only" : "Synchronized to room";
    q(el, "[data-volume]").value = String(this.currentVolume);
    this.paintMute();
    q(el, "[data-placeholder]").hidden = Boolean(s.current);
    q(el, "[data-act=\"close-room\"]").hidden = !this.canModerate;
    q(el, "[data-act=\"take-host\"]").hidden = !game.user.isGM || s.hostId === game.user.id;
    q(el, "[data-act=\"place-scene\"]").hidden = !canEdit;
    q(el, "[data-act=\"remove-scene\"]").hidden = !canEdit || !s.scene;
    q(el, "[data-permissions]").hidden = !this.canModerate;
    q(el, "[data-act=\"director\"]").hidden = !game.user.isGM;
    this.paintQueue();
    this.paintMembers();
    this.scenePosition();
    this.paintProgress();
  }

  get filePickerClass() {
    return globalThis.foundry?.applications?.apps?.FilePicker?.implementation ?? globalThis.FilePicker ?? null;
  }

  paintQueue() {
    const list = q(this.root, "[data-list]");
    if (!list) return;
    list.replaceChildren();
    const queue = this.state.queue;
    if (!queue.length) {
      const empty = document.createElement("li");
      empty.className = "fwr-list-empty";
      empty.textContent = "No videos queued";
      list.append(empty); return;
    }
    queue.forEach((entry, i) => {
      const item = document.createElement("li");
      item.className = "fwr-list-item";
      const title = document.createElement("div");
      title.className = "fwr-item-title";
      title.textContent = `${i + 1}. ${entry.title}`;
      title.title = `${entry.title}\n${entry.url}`;
      const actions = document.createElement("div");
      actions.className = "fwr-item-actions";
      if (this.canControl || this.state.voteMode) {
        const buttons = [
          ["move", "Move up", "fa-arrow-up", -1, i === 0],
          ["move", "Move down", "fa-arrow-down", 1, i === queue.length - 1],
          ["select", "Play now", "fa-play"],
          ["remove", "Remove", "fa-xmark"]
        ];
        for (const [act, label, fa, delta, disabled] of buttons) {
          const b = document.createElement("button");
          b.type = "button"; b.title = label; b.dataset.act = act; b.dataset.uid = entry.uid;
          b.setAttribute("aria-label", `${label}: ${entry.title}`);
          if (delta) b.dataset.delta = String(delta);
          b.disabled = Boolean(disabled || (!this.canControl && !['select'].includes(act)));
          b.innerHTML = icon(fa); actions.append(b);
        }
      }
      item.append(title, actions); list.append(item);
    });
  }
  paintVote() {
    const panel = q(this.root,'[data-vote-panel]'); if (!panel) return;
    const vote = this.state.pendingVote;
    panel.hidden = !this.state.voteMode || !vote;
    if (!vote) return;
    const target = vote.proposal.type === 'NEXT' ? 'skip to the next track' :
      `play ${this.state.queue.find(x => x.uid === vote.proposal.uid)?.title || 'selected track'}`;
    const eligible = game.users.filter(u => u.active && !u.isGM);
    const threshold = Math.floor(eligible.length/2)+1;
    const remaining = Math.max(0,Math.ceil((vote.expiresAt-serverNow())/1000));
    const online = new Set(eligible.map(u => u.id));
    const yes = vote.yes.filter(id => online.has(id)).length, no = vote.no.filter(id => online.has(id)).length;
    const requester = game.users.get(vote.requester)?.name || "A player";
    q(panel,'[data-vote-label]').textContent = `${requester} wants to ${target}: ${yes} yes / ${no} no · ${threshold} needed · ${remaining}s`;
    q(panel,'[data-act="vote-yes"]').hidden = game.user.isGM;
    q(panel,'[data-act="vote-no"]').hidden = game.user.isGM;
    q(panel,'[data-act="vote-yes"]').setAttribute('aria-pressed', String(vote.yes.includes(game.user.id)));
    q(panel,'[data-act="vote-no"]').setAttribute('aria-pressed', String(vote.no.includes(game.user.id)));
    q(panel,'[data-act="vote-approve"]').hidden = !game.user.isGM;
    q(panel,'[data-act="vote-reject"]').hidden = !game.user.isGM;
  }
  paintMembers() {
    const box = q(this.root, "[data-members]");
    if (!box || !this.canModerate) return;
    box.replaceChildren();
    for (const user of game.users) {
      if (user.isGM || user.id === this.state.hostId) continue;
      const label = document.createElement("label"); label.className = "fwr-member";
      const input = document.createElement("input");
      input.type = "checkbox"; input.dataset.permit = user.id;
      input.checked = this.state.controllerIds.includes(user.id);
      label.append(input, document.createTextNode(` ${user.name}${user.active ? "" : " (offline)"}`));
      box.append(label);
    }
    if (!box.children.length) box.textContent = "No other users";
  }
  paintMute() {
    const button = q(this.root, "[data-act=\"mute\"]");
    if (!button) return;
    const v = this.currentVolume;
    button.innerHTML = icon(v === 0 ? "fa-volume-xmark" : v < 0.5 ? "fa-volume-low" : "fa-volume-high");
    button.setAttribute("aria-label", v === 0 ? "Unmute" : "Mute");
    button.title = v === 0 ? "Unmute" : "Mute";
  }

  setMessage(message, warning = false) {
    const el = q(this.root, "[data-message]");
    if (!el) return;
    el.textContent = message || "";
    el.title = message || "";
    el.classList.toggle("fwr-warning", warning);
    // Informational notes fade out; warnings stay until something replaces them.
    clearTimeout(this.messageTimer);
    if (message && !warning) this.messageTimer = setTimeout(() => { if (el.textContent === message) el.textContent = ""; }, 5000);
  }

  async onAdd(event) {
    event.preventDefault();
    if (!this.canControl) return;
    const url = q(this.root, "[data-url]").value.trim();
    const title = q(this.root, "[data-video-title]").value.trim();
    if (!url) return;
    try {
      parseSource(url);
      if (this.state.queue.length >= MAX_QUEUE && this.state.current) throw new Error(`The queue is full (${MAX_QUEUE} videos).`);
      this.issue("ADD", {url, title});
      q(this.root, "[data-url]").value = "";
      q(this.root, "[data-video-title]").value = "";
      this.setMessage(this.state.current ? "Video added to the queue." : "Video loaded. Press play when everyone is ready.");
    } catch (error) { this.setMessage(error.message, true); }
  }

  browseFiles() {
    const Picker = this.filePickerClass;
    if (!Picker) return;
    try {
      new Picker({
        type: "video",
        callback: path => {
          const input = q(this.root, "[data-url]");
          if (input) { input.value = path; input.focus(); }
        }
      }).render(true);
    } catch (error) { this.setMessage(`File browser unavailable: ${error.message}`, true); }
  }

  onKey(event) {
    if (event.target.closest("input, textarea, select")) return;
    if (event.key === "Escape" && document.fullscreenElement !== this.root) { event.stopPropagation(); this.hide(); }
  }

  async onClick(event) {
    const button = event.target.closest("[data-act]");
    if (!button || button.disabled) return;
    const act = button.dataset.act;
    switch (act) {
      case "hide": this.hide(); break;
      case "open-room": this.issue("OPEN"); break;
      case "close-room": {
        const ok = await this.confirm("End watch room?", "This closes the room and clears the queue for everyone.");
        if (ok) this.issue("CLOSE");
        break;
      }
      case "toggle": {
        if (this.independent) {
          if (!this.adapter) return;
          try {
            if (this.localPlaying) { await this.adapter.pause(); this.localPlaying = false; }
            else { await this.adapter.play(); this.localPlaying = true; }
          } catch { this.showUnlock(true); }
          this.updateUI();
        } else this.issue(this.state.playing ? "PAUSE" : "PLAY");
        break;
      }
      case "next": this.requestSongChange('NEXT'); break;
      case "select": this.requestSongChange('SELECT',button.dataset.uid); break;
      case 'compact': this.toggleCompact(); break;
      case 'music-manager': this.music.openManager(); break;
      case 'director': this.director.open(); break;
      case 'loop': {
        const modes=['off','one','queue'];
        this.issue('LOOP_MODE',{mode:modes[(modes.indexOf(this.state.loopMode||'off')+1)%modes.length]}); break;
      }
      case 'track-loop': this.issue('TRACK_LOOP',{uid:this.state.current?.uid,loop:!this.state.current?.loop}); break;
      case 'vote-yes': this.issue('VOTE',{id:this.state.pendingVote?.id,yes:true}); break;
      case 'vote-no': this.issue('VOTE',{id:this.state.pendingVote?.id,yes:false}); break;
      case 'vote-approve': this.issue('VOTE_OVERRIDE',{approve:true}); break;
      case 'vote-reject': this.issue('VOTE_OVERRIDE',{approve:false}); break;
      case "remove": this.issue("REMOVE", {uid: button.dataset.uid}); break;
      case "move": this.issue("MOVE", {uid: button.dataset.uid, delta: Number(button.dataset.delta)}); break;
      case "browse": this.browseFiles(); break;
      case "place-scene": this.placeScene(); break;
      case "remove-scene": this.issue("SCENE", {scene: null}); break;
      case "take-host": this.issue("TAKE_HOST"); break;
      case "mode": this.toggleMode(); break;
      case "sidebar": {
        const layout = this.layout;
        this.sidebarOpen[layout] = !this.sidebarOpen[layout];
        this.paintSidebar();
        break;
      }
      case "mute": {
        const restore = this.lastVolume > 0 ? this.lastVolume : 0.7;
        if (this.currentVolume > 0) this.lastVolume = this.currentVolume;
        this.setVolume(this.currentVolume > 0 ? 0 : restore, true);
        q(this.root, "[data-volume]").value = String(this.currentVolume);
        break;
      }
      case "fullscreen": {
        const doc = this.root.ownerDocument;
        try { if (!doc.fullscreenElement) await this.root.requestFullscreen(); else await doc.exitFullscreen(); }
        catch { this.setMessage("Fullscreen is unavailable in this browser.", true); }
        break;
      }
      case "pip": await this.openPiP(); break;
      case "unlock": {
        this.showUnlock(false);
        try {
          await this.adapter?.play();
          await this.reconcile(true);
        } catch { this.showUnlock(true); }
        break;
      }
    }
  }

  requestSongChange(action, uid) {
    if (this.state.voteMode && !game.user.isGM) this.issue('PROPOSE',{action,uid});
    else this.issue(action,uid ? {uid}: {});
  }
  toggleCompact() {
    if (this.layout === 'window') this.saveWindowRect();
    this.compact = !this.compact;
    game.settings.set(MODULE_ID,'compact',this.compact);
    this.applyGeometry = true;
    this.root?.classList.toggle('fwr-compact',this.compact);
    this.scenePosition(true);
    this.updateUI();
  }

  async confirm(title, content) {
    const DialogV2 = globalThis.foundry?.applications?.api?.DialogV2;
    try {
      if (DialogV2?.confirm) return Boolean(await DialogV2.confirm({ window: { title }, content: `<p>${content}</p>`, rejectClose: false }));
    } catch { /* fall back to native confirm */ }
    return window.confirm(`${title}\n\n${content}`);
  }

  previewSeek(seconds) {
    this.scrubbing = true;
    const label = q(this.root, "[data-time]");
    const duration = Number(this.adapter?.getDuration?.()) || 0;
    if (label) label.textContent = `${fmt(seconds)} / ${duration ? fmt(duration) : "--:--"}`;
  }

  onSeek(seconds) {
    if (!this.state.current || this.state.current.live) return;
    if (this.independent) {
      Promise.resolve(this.adapter?.seek(seconds)).catch(() => {});
      return;
    }
    if (this.canControl) this.issue("SEEK", {position: seconds});
  }
  setIndependent(value) {
    this.independent = Boolean(value);
    game.settings.set(MODULE_ID, "independent", this.independent);
    this.localPlaying = this.independent ? Boolean(this.observedPlaying ?? this.state.playing) : this.localPlaying;
    this.updateUI();
    if (!this.independent) {
      this.observedPlaying = null;
      this.reconcile(true).catch(console.error);
    }
  }
  setVolume(value, persist) {
    this.currentVolume = clamp(Number.isFinite(value) ? value : 0.7, 0, 1);
    if (persist) game.settings.set(MODULE_ID, "volume", this.currentVolume);
    try { this.adapter?.setVolume(this.currentVolume); } catch { /* not ready */ }
    this.paintMute();
  }
  showUnlock(show) {
    this.blocked = show;
    const b = q(this.root, "[data-act=\"unlock\"]");
    if (b) b.hidden = !show;
    if (show) this.setMessage(AUTOPLAY_MESSAGE, true);
    else if (q(this.root, "[data-message]")?.textContent === AUTOPLAY_MESSAGE) this.setMessage("");
  }

  async loadCurrent() {
    const entry = this.state.current;
    const generation = ++this.loadGeneration;
    this.loadedUid = entry?.uid || null;
    this.observedPlaying = null;
    this.confirmedPlayingUid = null;
    this.playerErrorUid = null;
    this.localPlaying = false;
    this.showUnlock(false);
    if (this.adapter) { try { this.adapter.destroy(); } catch (err) { console.warn(err); } this.adapter = null; }
    const mount = q(this.root, "[data-player]");
    if (!mount) { this.loadedUid = null; return; }
    if (!entry) { mount.replaceChildren(); this.setMessage(""); this.paintProgress(); return; }
    this.setMessage(`Loading ${entry.provider} player…`);
    let timeout;
    try {
      const adapter = await createAdapter(entry, mount, (status, detail) => this.playerEvent(status, entry.uid, detail));
      if (generation !== this.loadGeneration || this.hidden || !this.state.open || !adapter) {
        adapter?.destroy();
        // Forget the load so the next show() rebuilds the player instead of assuming it exists.
        if (generation === this.loadGeneration) this.loadedUid = null;
        return;
      }
      this.adapter = adapter;
      await Promise.race([
        adapter.ready,
        new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("Video provider did not become ready within 15 seconds.")), 15000); })
      ]);
      if (generation !== this.loadGeneration || this.hidden) return;
      adapter.setVolume(this.currentVolume);
      if (this.playerErrorUid !== entry.uid) this.setMessage("");
      await this.reconcile(true);
      this.probeAutoplay(entry.uid);
    } catch (error) {
      if (generation === this.loadGeneration && this.playerErrorUid !== entry.uid) this.setMessage(`Player error: ${error.message}`, true);
      console.error(`${MODULE_ID} | Player load failed`, error);
    } finally { clearTimeout(timeout); }
  }

  /** If the room is playing but no "playing" event arrives, the browser most likely blocked autoplay. */
  probeAutoplay(uid) {
    if (!this.state.playing || this.independent || this.confirmedPlayingUid === uid) return;
    clearTimeout(this.probeTimer);
    this.probeTimer = setTimeout(() => {
      const duration = Number(this.adapter?.getDuration?.()) || 0;
      const pastEnd = duration > 0 && expectedPosition(this.state) >= duration - 1;
      if (!pastEnd && !this.hidden && this.state.current?.uid === uid && this.state.playing && !this.independent &&
        this.confirmedPlayingUid !== uid && this.playerErrorUid !== uid && !this.state.current.live) {
        this.showUnlock(true);
      }
    }, 4000);
  }

  playerEvent(status, uid, detail) {
    if (uid !== this.state.current?.uid || this.hidden) return;
    if (status === "playing") {
      this.observedPlaying = true; this.localPlaying = true; this.confirmedPlayingUid = uid;
      this.showUnlock(false);
    }
    if (status === "paused") { this.observedPlaying = false; this.localPlaying = false; }
    if (this.independent && (status === "playing" || status === "paused")) this.updateUI();
    if (status === "error") {
      this.playerErrorUid = uid;
      this.setMessage(detail || "This video may be unavailable or disallow embedding.", true);
    }
    if (status === "blocked") this.showUnlock(true);
    if (status === "ended") {
      this.observedPlaying = false;
      this.reportEnded(uid, true);
    }
  }

  /** Tell the room the current video finished. Re-sent (throttled) while the room stays stuck past the end. */
  reportEnded(uid, immediate = false) {
    if (this.independent || this.hidden) return;
    const now = Date.now();
    if (!immediate && this.endReport?.uid === uid && now - this.endReport.at < 8000) return;
    this.endReport = { uid, at: now };
    this.issue("ENDED", {forUid: uid, duration: Number(this.adapter?.getDuration?.()) || 0});
  }

  async reconcile(force = false) {
    if (this.hidden || !this.state.open || this.independent || !this.adapter || !this.state.current) return;
    if (this.syncBusy) {
      // Don't drop a state-change sync that arrives mid-check; run it right after.
      this.resyncQueued = Boolean(this.resyncQueued) || force;
      return;
    }
    this.syncBusy = true;
    const adapter = this.adapter;
    try {
      const expected = expectedPosition(this.state);
      const duration = Number(adapter.getDuration()) || 0;
      const target = duration > 0 ? Math.min(expected, Math.max(0, duration - .1)) : expected;
      const actual = Number(await adapter.getTime()) || 0;
      const drift = Math.abs(target - actual);
      if (!this.state.current.live && drift > (force ? DRIFT_FORCED : DRIFT_PERIODIC)) {
        await adapter.seek(target);
      }
      if (this.state.playing) {
        const ended = duration > 0 && target >= duration - 0.2;
        if (ended && expected > duration + 1) this.reportEnded(this.state.current.uid);
        if (!ended && (force || this.observedPlaying !== true)) try {
          await adapter.play(); this.localPlaying = true; this.observedPlaying = true;
          this.probeAutoplay(this.state.current.uid);
        }
        catch (error) {
          if (error?.name === "NotAllowedError" || /play|gesture|autoplay/i.test(String(error))) this.showUnlock(true);
          else console.warn(`${MODULE_ID} | Playback error`, error);
        }
      } else {
        if (force || this.observedPlaying !== false) await adapter.pause();
        this.localPlaying = false;
        this.observedPlaying = false;
        this.showUnlock(false);
      }
    } catch (error) { console.warn(`${MODULE_ID} | Sync issue`, error); }
    finally {
      this.syncBusy = false;
      this.paintProgress();
      const queued = this.resyncQueued;
      this.resyncQueued = null;
      if (queued !== null) this.reconcile(queued).catch(console.error);
    }
  }

  paintProgress() {
    if (!this.root || !this.state.open) return;
    this.paintVote();
    const entry = this.state.current;
    const duration = Number(this.adapter?.getDuration?.()) || 0;
    let t = this.independent ? (Number(this.adapter?.getTime?.()) || 0) : expectedPosition(this.state);
    if (duration > 0) t = Math.min(t, duration);
    const scrub = q(this.root, "[data-seek]");
    if (scrub && !this.scrubbing) {
      // Without a known duration the bar would just pin to the end, so show it empty and inert.
      scrub.max = String(Math.max(duration, 1));
      if (!scrub.matches(":active")) scrub.value = duration > 0 ? String(Math.min(t, duration)) : "0";
      if (!duration) scrub.disabled = true;
      else if (scrub.disabled) scrub.disabled = !entry || entry.live || (!this.canControl && !this.independent);
    }
    if (this.scrubbing) return;
    const label = q(this.root, "[data-time]");
    if (label) label.textContent = !entry ? "00:00 / --:--" : entry.live ? "● LIVE" : `${fmt(t)} / ${duration ? fmt(duration) : "--:--"}`;
  }

  async toggleMode() {
    if (this.pipWindow) {
      this.setMessage("Close the Picture-in-Picture window before changing layout.");
      return;
    }
    if (this.mode === "scene") {
      this.mode = "window";
    } else {
      if (!this.state.scene || this.state.scene.sceneId !== canvas?.scene?.id) {
        if (this.canControl) { await this.placeScene(); return; }
        this.setMessage("Ask the host to place the video on your current scene first.", true);
        return;
      }
      this.mode = "scene";
    }
    game.settings.set(MODULE_ID, "mode", this.mode);
    this.applyGeometry = true;
    this.scenePosition();
  }

  async placeScene() {
    if (!this.canControl || !canvas?.scene) {
      this.setMessage("Open a scene first, then place the shared player.", true); return;
    }
    const scene = canvas.scene;
    const rectangle = canvas.dimensions?.sceneRect || {x: 0, y: 0, width: scene.width, height: scene.height};
    const w = clamp(rectangle.width * 0.48, 700, 1600);
    const h = w * 0.62;
    const existing = this.state.scene?.sceneId === scene.id ? this.state.scene : null;
    if (!existing) {
      this.issue("SCENE", {scene: {
        sceneId: scene.id, x: rectangle.x + (rectangle.width - w) / 2, y: rectangle.y + (rectangle.height - h) / 2,
        width: w, height: h
      }});
    }
    this.mode = "scene";
    this.applyGeometry = true;
    await game.settings.set(MODULE_ID, "mode", "scene");
    this.scenePosition();
  }

  /** Viewport-clamped saved window rectangle. */
  windowRect() {
    const saved = game.settings.get(MODULE_ID, this.compact ? 'compactRect':'rect') || {};
    const minW = this.compact ? 260 : 320, minH = this.compact ? 200 : 260;
    const width = clamp(Number(saved.width) || (this.compact ? 336:860), minW, Math.max(minW, innerWidth - 16));
    const height = clamp(Number(saved.height) || (this.compact ? 270:570), minH, Math.max(minH, innerHeight - 16));
    return {
      width, height,
      left: clamp(Number(saved.left) || 0, 0, Math.max(0, innerWidth - width)),
      top: clamp(Number(saved.top) || 0, 0, Math.max(0, innerHeight - height))
    };
  }
  saveWindowRect() {
    if (!this.root || this.hidden || this.pipWindow || this.layout !== "window" || this.root.ownerDocument.fullscreenElement ||
      this.root.classList.contains("fwr-cinematic")) return;
    const r = this.root.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const next = { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
    const key = this.compact ? 'compactRect':'rect';
    const old = game.settings.get(MODULE_ID, key) || {};
    if (["left", "top", "width", "height"].some(k => Math.abs((Number(old[k]) || 0) - next[k]) > 2)) {
      game.settings.set(MODULE_ID, key, next);
    }
  }

  paintSidebar() {
    if (!this.root) return;
    const open = this.sidebarOpen[this.layout];
    this.root.classList.toggle("fwr-collapsed", !open);
    const b = q(this.root, "[data-act=\"sidebar\"]");
    if (b) { b.setAttribute("aria-pressed", String(open)); b.title = open ? "Hide the queue" : "Show the queue"; }
  }

  scenePosition(forceGeometry = false) {
    if (!this.root || this.hidden || this.pipWindow) return;
    const root = this.root;
    const scene = this.pendingScene || this.state.scene;
    const onScene = this.state.open && !this.compact && this.mode === "scene" && scene?.sceneId === canvas?.scene?.id && canvas?.stage && canvas?.app;
    const modeButton = q(root, "[data-act=\"mode\"] span");
    if (modeButton) modeButton.textContent = this.mode === "scene" ? "Window" : "Scene";
    const modeAction = q(root, "[data-act=\"mode\"]");
    if (modeAction) modeAction.title = this.mode === "scene" && !onScene
      ? "Scene view isn't available on this scene; showing the window. Click to switch back to window view."
      : "Toggle window / scene view";
    if (!onScene) {
      const wasScene = root.classList.contains("fwr-scene");
      root.classList.remove("fwr-scene");
      root.classList.add("fwr-window");
      // Only re-apply saved geometry on layout changes, so periodic ticks don't fight drags or resizes.
      if (wasScene || forceGeometry || this.applyGeometry) {
        const rect = this.windowRect();
        root.style.transform = "";
        root.style.left = `${rect.left}px`;
        root.style.top = `${rect.top}px`;
        root.style.width = `${rect.width}px`;
        root.style.height = `${rect.height}px`;
        if (wasScene) this.bringToFront();
      }
      this.applyGeometry = false;
      this.paintSidebar();
      return;
    }
    root.classList.remove("fwr-window");
    root.classList.add("fwr-scene");
    root.style.zIndex = "";
    const rect = this.canvasRect();
    const transform = canvas.stage.worldTransform;
    const anchor = transform.apply({x: scene.x, y: scene.y});
    root.style.left = `${rect.left + anchor.x}px`;
    root.style.top = `${rect.top + anchor.y}px`;
    root.style.width = `${scene.width}px`;
    root.style.height = `${scene.height}px`;
    root.style.transformOrigin = "top left";
    root.style.transform = `scale(${clamp(Math.abs(transform.a), 0.05, 10)}, ${clamp(Math.abs(transform.d), 0.05, 10)})`;
    this.applyGeometry = false;
    this.paintSidebar();
  }

  canvasRect() {
    return canvas.app.renderer?.canvas?.getBoundingClientRect?.() || canvas.app.view?.getBoundingClientRect?.() ||
      document.querySelector("canvas#board")?.getBoundingClientRect?.() || {left: 0, top: 0};
  }

  /** Raise the floating window above other Foundry windows, cooperating with Foundry's own z-order counter. */
  bringToFront() {
    if (!this.root || this.layout !== "window" || this.pipWindow) return;
    raise(this.root);
  }

  attachDrag(root) {
    let start = null;
    root.addEventListener("pointerdown", event => {
      if (this.layout === "window") this.bringToFront();
      if (this.pipWindow || root.classList.contains("fwr-cinematic") || event.button !== 0 || !event.target.closest("[data-drag]") || event.target.closest("button, input, a")) return;
      const scene = root.classList.contains("fwr-scene");
      if (scene && !this.canControl) return;
      const point = {x: event.clientX, y: event.clientY};
      const original = scene ? { ...(this.pendingScene || this.state.scene) } : this.windowRect();
      if (!scene) Object.assign(original, { left: parseFloat(root.style.left) || original.left, top: parseFloat(root.style.top) || original.top });
      start = { pointerId: event.pointerId, point, original, scene, moved: false };
      event.target.setPointerCapture?.(event.pointerId);
    });
    root.addEventListener("pointermove", event => {
      if (!start || event.pointerId !== start.pointerId) return;
      const dx = event.clientX - start.point.x, dy = event.clientY - start.point.y;
      if (!start.moved && Math.hypot(dx, dy) < 3) return;
      start.moved = true;
      if (start.scene) {
        const scale = Math.max(.05, Math.abs(canvas.stage.worldTransform.a) || 1);
        this.pendingScene = { ...start.original, x: Math.max(0, start.original.x + dx / scale), y: Math.max(0, start.original.y + dy / scale) };
        this.scenePosition();
      } else {
        root.style.left = `${clamp(start.original.left + dx, 0, innerWidth - 150)}px`;
        root.style.top = `${clamp(start.original.top + dy, 0, innerHeight - 90)}px`;
      }
    });
    const finish = event => {
      if (!start || event.pointerId !== start.pointerId) return;
      if (start.moved) {
        // Keep showing pendingScene until the leader confirms it, so the surface doesn't snap back.
        if (start.scene && this.pendingScene) this.issue("SCENE", {scene: this.pendingScene});
        else if (!start.scene) this.saveWindowRect();
      }
      start = null;
    };
    root.addEventListener("pointerup", finish);
    root.addEventListener("pointercancel", finish);
  }

  async openPiP() {
    if (!this.root) return;
    if (this.pipWindow) { this.pipWindow.close(); return; }
    // Chromium Document PiP supports an entire video player, including cross-origin embeds.
    if (window.documentPictureInPicture?.requestWindow) {
      try {
        const popup = await window.documentPictureInPicture.requestWindow({width: 760, height: 600});
        this.pipWindow = popup;
        // Copy every stylesheet (Foundry's included) so Font Awesome icons and themes render in the popup.
        for (const node of document.querySelectorAll("link[rel=\"stylesheet\"], style")) {
          const clone = node.cloneNode(true);
          if (node.tagName === "LINK") clone.href = node.href;
          popup.document.head.append(clone);
        }
        popup.document.body.style.margin = "0";
        popup.document.body.style.background = "#0c111b";
        popup.document.body.append(this.root);
        this.root.classList.remove("fwr-scene", "fwr-window");
        this.root.classList.add("fwr-pip");
        this.root.style.cssText = "";
        popup.addEventListener("pagehide", () => {
          if (this.pipWindow !== popup) return;
          this.pipWindow = null;
          document.body.append(this.root);
          this.root.classList.remove("fwr-pip");
          this.root.classList.add("fwr-window");
          this.applyGeometry = true;
          this.scenePosition(true);
          if (!this.hidden && this.state.current) this.loadCurrent();
        }, {once: true});
        // Moving an iframe between documents reloads it, so rebuild the player cleanly.
        if (this.state.current) this.loadCurrent();
        return;
      } catch (error) { this.setMessage(`Picture-in-Picture unavailable: ${error.message}`, true); return; }
    }
    if (this.adapter?.kind === "file" && document.pictureInPictureEnabled) {
      try { await this.adapter.pip(); return; }
      catch { /* fall through */ }
    }
    this.setMessage("Picture-in-Picture for embedded sites needs a browser with Document Picture-in-Picture (e.g. recent Chrome/Edge).", true);
  }
}

let watch;
Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "roomState", {
    name: "Shared Watch Room State", scope: "world", config: false, type: Object,
    default: initialState(), onChange: value => watch?.acceptState(value)
  });
  game.settings.register(MODULE_ID, "createRole", {
    name: "Who can start a room?",
    hint: "A GM is always allowed. A GM must be online to process shared changes.",
    scope: "world", config: true, type: Number, default: 4,
    choices: { 4: "GM only", 2: "Trusted players or higher", 1: "Any player" }
  });
  game.settings.register(MODULE_ID, "autoOpenRoom", {
    name: "Encounter music and cinematics open the room",
    hint: "When the room is closed, a triggered encounter track, boss phase or cinematic starts it automatically (with the active GM as host). Turn off to have automation do nothing while the room is closed.",
    scope: "world", config: true, type: Boolean, default: true
  });
  game.settings.register(MODULE_ID, "autoJoin", {
    name: "Automatically join when a room opens",
    hint: "Opens the player locally. Browsers might still require a click before video or audio can start.",
    scope: "client", config: true, type: Boolean, default: true
  });
  game.settings.register(MODULE_ID, "showLauncher", {
    name: "Show floating Watch Room button",
    hint: "Adds a launcher in the bottom-left corner. The room is always available from the token scene controls.",
    scope: "client", config: true, type: Boolean, default: true, requiresReload: true
  });
  game.settings.register(MODULE_ID, "independent", {
    name: "Independent playback",
    hint: "Opt out of synchronization and use local playback controls. Re-enable to catch up.",
    scope: "client", config: true, type: Boolean, default: false,
    onChange: value => { if (watch && watch.independent !== value) watch.setIndependent(value); }
  });
  game.settings.register(MODULE_ID, "volume", {
    name: "Watch Room volume", scope: "client", config: false, type: Number, default: 0.7
  });
  game.settings.register(MODULE_ID, "mode", {
    name: "Watch Room layout", scope: "client", config: false, type: String, default: "window"
  });
  game.settings.register(MODULE_ID, 'compact', {
    name:'Compact player',scope:'client',config:false,type:Boolean,default:false
  });
  game.settings.register(MODULE_ID, 'compactRect', {
    name:'Compact player geometry',scope:'client',config:false,type:Object,
    default:{left:28,top:140,width:336,height:270}
  });
  game.settings.register(MODULE_ID, 'musicLibrary', {
    name:'Saved music',scope:'world',config:false,type:Array,default:[],
    onChange: () => watch?.music.renderManager()
  });
  game.settings.register(MODULE_ID, 'encounterProfiles', {
    name:'Encounter profiles with boss phases and dynamic triggers',scope:'world',config:false,type:Array,default:[],
    onChange: () => watch?.director.render()
  });
  game.settings.register(MODULE_ID, 'cinematicCues', {
    name:'Saved cinematic timelines',scope:'world',config:false,type:Array,default:[],
    onChange: () => watch?.director.render()
  });
  game.settings.register(MODULE_ID, 'musicTriggers', {
    name:'Music triggers',scope:'world',config:false,type:Array,default:[],
    onChange: () => watch?.music.renderManager()
  });
  game.settings.register(MODULE_ID, "rect", {
    name: "Watch Room window geometry", scope: "client", config: false, type: Object,
    default: {left: 170, top: 110, width: 860, height: 570}
  });
});

Hooks.on("getSceneControlButtons", controls => {
  if (!controls.tokens?.tools) return;
  controls.tokens.tools["fwr-watch-room"] = {
    name: "fwr-watch-room", title: "Shared Watch Room", icon: "fa-solid fa-tv",
    order: Object.keys(controls.tokens.tools).length, button: true, visible: true,
    onChange: () => watch?.show()
  };
});

Hooks.once("ready", () => {
  watch = new WatchRoom();
  watch.start();
  game.modules.get(MODULE_ID).api = {
    open: () => watch.show(),
    closeLocally: () => watch.hide(),
    toggle: () => watch.toggleVisible(),
    getState: () => structuredClone(watch.state),
    startRoom: () => watch.issue("OPEN"),
    endRoom: () => watch.issue("CLOSE"),
    addVideo: (url, title = "") => { parseSource(url); watch.issue("ADD", {url, title}); },
    openMusicManager: (actorUuid = '') => watch.music.openManager(actorUuid),
    openDirector: (actorUuid = '') => watch.director.open(actorUuid),
    getLibrary: () => structuredClone(watch.music.library),
    getProfiles: () => structuredClone(watch.director.profiles),
    getCinematics: () => structuredClone(watch.director.cues),
    playLibrary: (idOrName, options = {}) => watch.music.playLibrary(idOrName, options),
    runCinematic: idOrName => watch.director.runCue(idOrName),
    stopCinematic: () => watch.director.stopCue(),
    fireDirectorEvent: (event, context = {}) => watch.fireEvent('director', event, context),
    runProfileTrigger: (profileId, triggerId) => watch.director.manual(profileId,triggerId),
    trigger: nameOrId => watch.music.manual(nameOrId),
    triggerEvent: (event, context = {}) => watch.fireEvent('music', event, context),
    addAudio: (url, title = '') => { parseSource(url); watch.issue('ADD',{url,title}); }
  };
});
