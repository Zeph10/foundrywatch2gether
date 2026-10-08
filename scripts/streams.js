import { MODULE_ID } from "./state.js";

const SOCKET = `module.${MODULE_ID}`;
const DEFAULT_ICE = [{ urls: "stun:stun.l.google.com:19302" }, { urls: "stun:stun1.l.google.com:19302" }];
const HELLO_INTERVAL = 4000;
const GIVE_UP_AFTER = 30000;

/**
 * Screen sharing for videos that can't be embedded: a controller plays the video on their own
 * computer and streams that tab to everyone. Peer-to-peer WebRTC (one connection per viewer),
 * with Foundry's module socket carrying the offer/answer/ICE handshake.
 *
 * Sharer:  start() → getDisplayMedia → SHARE_START. Answers each viewer's "hello" with an offer.
 * Viewer:  watch(entry) → sends "hello" (retried) → answers the offer → shows the received stream.
 */
export class ScreenShare {
  constructor(room) {
    this.room = room;
    this.local = null;          // MediaStream being shared (sharer only)
    this.localUid = null;       // room entry uid of our share
    this.peers = new Map();     // sharer side: viewerId -> RTCPeerConnection
    this.viewer = null;         // viewer side: { uid, sharerId, pc, handlers, timers }
    this.pendingIce = new Map(); // pc -> queued candidates until remote description is set
  }

  get supported() {
    return Boolean(globalThis.isSecureContext && navigator.mediaDevices?.getDisplayMedia && globalThis.RTCPeerConnection);
  }
  get unsupportedReason() {
    if (!globalThis.isSecureContext) return "Screen sharing needs Foundry to be served over HTTPS (or localhost).";
    if (!navigator.mediaDevices?.getDisplayMedia) return "This browser can't share its screen.";
    if (!globalThis.RTCPeerConnection) return "This browser doesn't support WebRTC.";
    return "";
  }
  get sharing() { return Boolean(this.local); }
  isSharer(entry) { return entry?.provider === "stream" && entry.sharerId === game.user.id; }

  iceServers() {
    try {
      const custom = JSON.parse(game.settings.get(MODULE_ID, "iceServers") || "[]");
      if (Array.isArray(custom) && custom.length) return custom;
    } catch { /* fall back to public STUN */ }
    return DEFAULT_ICE;
  }

  send(to, type, uid, data = {}) {
    game.socket.emit(SOCKET, { kind: "rtc", from: game.user.id, to, type, uid, data });
  }

  /** Called from a click: pick a screen/tab/window and start sharing it to the room. */
  async start(title = "") {
    if (!this.supported) throw new Error(this.unsupportedReason);
    if (this.local) return;
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 30 } },
      audio: true,
      selfBrowserSurface: "exclude",   // don't offer the Foundry tab itself
      surfaceSwitching: "include",
      systemAudio: "include"
    });
    this.local = stream;
    stream.getVideoTracks()[0]?.addEventListener("ended", () => this.stop()); // browser's own "Stop sharing"
    // Track labels are browser-internal ids, not titles; the room names the share after the sharer.
    this.room.issue("SHARE_START", { title: String(title || "").slice(0, 120) });
  }

  /** Stop sharing; tell the room unless it already moved on. */
  stop(tellRoom = true) {
    const uid = this.localUid;
    for (const track of this.local?.getTracks() || []) track.stop();
    this.local = null;
    this.localUid = null;
    for (const pc of this.peers.values()) pc.close();
    this.peers.clear();
    const current = this.room.state.current;
    if (tellRoom && current?.provider === "stream" && current.sharerId === game.user.id && (!uid || current.uid === uid)) {
      this.room.issue("SHARE_STOP", { uid: current.uid });
    }
    this.room.updateUI?.();
  }

  /** Keep local capture consistent with the room state. */
  onState(state) {
    const current = state.current;
    const mine = current?.provider === "stream" && current.sharerId === game.user.id;
    if (mine && this.local) this.localUid = current.uid;
    // Room moved on (Next, another share, room closed): release the capture.
    if (this.local && this.localUid && (!mine || current.uid !== this.localUid)) this.stop(false);
    // We reloaded mid-share: the capture is gone, so end the stale share for everyone.
    if (mine && !this.local && this.staleUid !== current.uid) {
      this.staleUid = current.uid;
      this.room.issue("SHARE_STOP", { uid: current.uid, quiet: true });
    }
    if (this.viewer && this.viewer.uid !== current?.uid) this.unwatch();
  }

  /**
   * Viewer: connect to the sharer of `entry`. `handlers` gets stream(mediaStream), status(text), failed(text).
   * Returns an unwatch function.
   */
  watch(entry, handlers) {
    if (this.isSharer(entry)) {
      if (this.local) handlers.stream(this.local);
      else handlers.failed("Your screen share ended. Share again from the queue panel.");
      return () => {};
    }
    this.unwatch();
    const sharer = game.users.get(entry.sharerId);
    const viewer = { uid: entry.uid, sharerId: entry.sharerId, pc: null, handlers, startedAt: Date.now() };
    this.viewer = viewer;
    handlers.status(`Connecting to ${sharer?.name || "the host"}'s screen…`);
    const hello = () => {
      if (this.viewer !== viewer || viewer.connected) return;
      if (Date.now() - viewer.startedAt > GIVE_UP_AFTER) {
        handlers.failed("Couldn't connect to the shared screen. Strict networks may need a TURN server (Module Settings → ICE servers).");
        return;
      }
      if (!game.users.get(viewer.sharerId)?.active) handlers.status("The person sharing is offline.");
      this.send(viewer.sharerId, "hello", viewer.uid);
      viewer.timer = setTimeout(hello, HELLO_INTERVAL);
    };
    hello();
    return () => { if (this.viewer === viewer) this.unwatch(); };
  }

  unwatch() {
    const viewer = this.viewer;
    if (!viewer) return;
    clearTimeout(viewer.timer);
    viewer.pc?.close();
    if (viewer.sharerId) this.send(viewer.sharerId, "bye", viewer.uid);
    this.viewer = null;
  }

  makePeer(remoteId, uid) {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers() });
    this.pendingIce.set(pc, []);
    pc.addEventListener("icecandidate", event => {
      if (event.candidate) this.send(remoteId, "ice", uid, { candidate: event.candidate.toJSON() });
    });
    return pc;
  }

  async flushIce(pc) {
    for (const candidate of this.pendingIce.get(pc) || []) await pc.addIceCandidate(candidate).catch(() => {});
    this.pendingIce.set(pc, []);
  }

  async addIce(pc, candidate) {
    if (!pc || !candidate) return;
    if (!pc.remoteDescription) this.pendingIce.get(pc)?.push(candidate);
    else await pc.addIceCandidate(candidate).catch(() => {});
  }

  /** Socket entry point for {kind: "rtc"} messages. */
  async onSignal(msg) {
    if (!msg || msg.to !== game.user.id || !game.users.get(msg.from)?.active) return;
    try {
      const current = this.room.state.current;
      if (msg.type === "hello") return await this.onHello(msg, current);
      if (msg.type === "bye") { this.peers.get(msg.from)?.close(); this.peers.delete(msg.from); return; }
      if (msg.type === "offer") return await this.onOffer(msg, current);
      if (msg.type === "answer") {
        const pc = this.peers.get(msg.from);
        if (pc && this.localUid === msg.uid) { await pc.setRemoteDescription(msg.data.sdp); await this.flushIce(pc); }
        return;
      }
      if (msg.type === "ice") {
        const pc = this.local ? this.peers.get(msg.from) : (this.viewer?.uid === msg.uid ? this.viewer.pc : null);
        await this.addIce(pc, msg.data?.candidate);
      }
    } catch (error) { console.warn(`${MODULE_ID} | Screen share signalling`, error); }
  }

  /** Sharer: a viewer asked for the stream. */
  async onHello(msg, current) {
    if (!this.local || current?.provider !== "stream" || current.uid !== msg.uid || current.sharerId !== game.user.id) return;
    this.peers.get(msg.from)?.close();
    const pc = this.makePeer(msg.from, msg.uid);
    this.peers.set(msg.from, pc);
    for (const track of this.local.getTracks()) pc.addTrack(track, this.local);
    pc.addEventListener("connectionstatechange", () => {
      if (["failed", "closed"].includes(pc.connectionState) && this.peers.get(msg.from) === pc) this.peers.delete(msg.from);
    });
    await pc.setLocalDescription(await pc.createOffer());
    this.send(msg.from, "offer", msg.uid, { sdp: pc.localDescription.toJSON() });
  }

  /** Viewer: the sharer sent an offer. */
  async onOffer(msg, current) {
    const viewer = this.viewer;
    if (!viewer || viewer.uid !== msg.uid || viewer.sharerId !== msg.from || current?.uid !== msg.uid) return;
    viewer.pc?.close();
    const pc = this.makePeer(msg.from, msg.uid);
    viewer.pc = pc;
    pc.addEventListener("track", event => {
      if (this.viewer !== viewer) return;
      viewer.connected = true;
      clearTimeout(viewer.timer);
      viewer.handlers.stream(event.streams[0] || new MediaStream([event.track]));
    });
    pc.addEventListener("connectionstatechange", () => {
      if (this.viewer !== viewer || viewer.pc !== pc) return;
      if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
        // Try again from the top: the sharer creates a fresh connection on the next hello.
        viewer.connected = false;
        viewer.startedAt = Date.now();
        viewer.handlers.status("Reconnecting to the shared screen…");
        clearTimeout(viewer.timer);
        viewer.timer = setTimeout(() => this.send(viewer.sharerId, "hello", viewer.uid), 1500);
      }
    });
    await pc.setRemoteDescription(msg.data.sdp);
    await this.flushIce(pc);
    await pc.setLocalDescription(await pc.createAnswer());
    this.send(msg.from, "answer", msg.uid, { sdp: pc.localDescription.toJSON() });
  }
}
