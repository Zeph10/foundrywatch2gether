/** Thin wrappers around each provider's official playback API. */
const sdkCache = new Map();
function loadSDK(key, src, check) {
  if (check()) return Promise.resolve();
  if (sdkCache.has(key)) return sdkCache.get(key);
  const promise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.onload = () => {
      let tries = 0;
      const poll = () => {
        if (check()) resolve();
        else if (++tries > 80) reject(new Error(`${key} player API never became ready.`));
        else setTimeout(poll, 100);
      };
      poll();
    };
    script.onerror = () => {
      script.remove();
      reject(new Error(`${key} player API could not load. Check CSP, ad blockers, or network settings.`));
    };
    document.head.append(script);
  });
  sdkCache.set(key, promise);
  promise.catch(() => sdkCache.delete(key));
  return promise;
}

const YOUTUBE_ERRORS = {
  2: "YouTube rejected the video ID.",
  5: "YouTube's HTML5 player couldn't play this video.",
  100: "This YouTube video was removed or is private.",
  101: "The owner doesn't allow this YouTube video to be embedded.",
  150: "The owner doesn't allow this YouTube video to be embedded."
};

/** YouTube error codes meaning "the owner doesn't allow embedding". */
const YOUTUBE_EMBED_BLOCKED = new Set([101, 150]);

function notify(emit, state, detail, info) { try { emit(state, detail, info); } catch (error) { console.warn("Watch Room status event", error); } }

/**
 * Ask the provider's oEmbed endpoint whether a video may be embedded, before anyone tries.
 * Resolves {embeddable: true|false|null, title?}; null means "couldn't tell" (network, CORS, other sites).
 */
export async function checkEmbeddable(entry, { fetchImpl = globalThis.fetch, timeoutMs = 4000, hostname = globalThis.location?.hostname } = {}) {
  let url;
  if (entry?.provider === "youtube") url = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(entry.url)}`;
  else if (entry?.provider === "vimeo") url = `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(entry.url)}${hostname ? `&domain=${encodeURIComponent(hostname)}` : ""}`;
  else return { embeddable: null };
  if (typeof fetchImpl !== "function") return { embeddable: null };
  const controller = globalThis.AbortController ? new AbortController() : null;
  const timer = setTimeout(() => controller?.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { signal: controller?.signal, credentials: "omit" });
    if (response.ok) {
      const data = await response.json().catch(() => ({}));
      return { embeddable: true, title: typeof data?.title === "string" ? data.title : "" };
    }
    // YouTube answers 401 and Vimeo 403 when the owner has disabled embedding (or restricted domains).
    if (response.status === 401 || response.status === 403) return { embeddable: false };
    return { embeddable: null, status: response.status };
  } catch {
    return { embeddable: null };
  } finally { clearTimeout(timer); }
}
const finite = v => (Number.isFinite(Number(v)) ? Number(v) : 0);

/**
 * Build a player for `entry` inside `mount`. Resolves to an adapter, or null when the
 * mount was replaced by a newer load while the provider SDK was still downloading.
 */
export async function createAdapter(entry, mount, onStatus, context = {}) {
  mount.replaceChildren();
  const holder = document.createElement("div");
  holder.className = "fwr-media-inner";
  mount.append(holder);
  let destroyed = false;
  const callback = (type, detail, info) => { if (!destroyed) notify(onStatus, type, detail, info); };

  if (entry.external) {
    // Not embedded: the room drives a pop-up window on the provider's own site (see ExternalViewer).
    const panel = document.createElement("div");
    panel.className = "fwr-external";
    const site = { youtube: "YouTube", vimeo: "Vimeo", twitch: "Twitch", file: "a new window" }[entry.provider] || "its site";
    panel.innerHTML = `
      <i class="fa-solid fa-up-right-from-square fwr-external-icon" aria-hidden="true"></i>
      <strong></strong>
      <p>This video plays on ${site} in a pop-up window that follows the room's play, pause and seek.</p>
      <button type="button" data-act="external-open"><i class="fa-solid fa-window-restore" aria-hidden="true"></i> <span data-external-label>Open synced pop-up</span></button>
      <label class="fwr-external-follow"><input type="checkbox" data-external-follow> Follow the room (the pop-up reloads at the right time when the room plays, pauses or seeks)</label>
      <small data-external-status></small>`;
    panel.querySelector("strong").textContent = entry.title || entry.label || "External video";
    holder.append(panel);
    return {
      kind: "external", live: Boolean(entry.live), ready: Promise.resolve(), panel,
      play() {}, pause() {}, seek() {},
      getTime: () => 0, getDuration: () => 0, setVolume() {},
      destroy() { destroyed = true; holder.remove(); }
    };
  }

  if (entry.provider === "stream") {
    // Another user's screen/tab, received over WebRTC (see ScreenShare).
    const streams = context.streams;
    const video = document.createElement("video");
    video.className = "fwr-video";
    video.playsInline = true;
    video.autoplay = true;
    const status = document.createElement("div");
    status.className = "fwr-stream-status";
    holder.append(video, status);
    const sharing = streams?.isSharer(entry);
    video.muted = Boolean(sharing); // the sharer hears the original; avoid echo
    video.addEventListener("playing", () => callback("playing"));
    video.addEventListener("pause", () => callback("paused"));
    const setStatus = text => { status.textContent = text || ""; status.hidden = !text; };
    let readyResolve;
    const ready = new Promise(resolve => { readyResolve = resolve; });
    const unwatch = streams?.watch(entry, {
      stream: media => { video.srcObject = media; setStatus(""); readyResolve(); callback("ready"); },
      status: text => setStatus(text),
      failed: text => { setStatus(text); readyResolve(); callback("error", text); }
    }) || (() => {});
    if (!streams) { setStatus("Screen sharing isn't available."); readyResolve(); }
    let volume = 1;
    return {
      kind: "stream", live: true, ready, element: video,
      play: () => video.srcObject ? video.play() : Promise.resolve(),
      pause: () => { video.pause(); },
      seek() {}, getTime: () => 0, getDuration: () => 0,
      setVolume: v => { volume = v; if (!sharing) { video.volume = v; video.muted = v === 0; } },
      async pip() { if (document.pictureInPictureEnabled && video.requestPictureInPicture) await video.requestPictureInPicture(); },
      destroy() { destroyed = true; unwatch(); video.srcObject = null; holder.remove(); }
    };
  }
  const stale = () => !holder.isConnected || holder.parentNode !== mount;

  if (entry.provider === "file") {
    const video = document.createElement(entry.audio ? "audio" : "video");
    video.className = entry.audio ? "fwr-audio-element" : "fwr-video";
    video.playsInline = true;
    video.preload = "auto";
    const ready = new Promise(resolve => {
      video.addEventListener("loadedmetadata", () => { resolve(); callback("ready"); }, {once: true});
      // Let the load finish on errors too; the "error" status carries the message.
      video.addEventListener("error", () => resolve(), {once: true});
    });
    video.addEventListener("ended", () => callback("ended"));
    video.addEventListener("playing", () => callback("playing"));
    video.addEventListener("pause", () => { if (!video.ended) callback("paused"); });
    video.addEventListener("error", () => {
      const code = video.error?.code;
      callback("error", code === 4 ? "This file format or codec isn't supported by your browser, or the file can't be reached."
        : code === 2 ? "A network error interrupted the video download." : "");
    });
    video.src = entry.url;
    holder.append(video);
    return {
      kind: "file", live: false, element: video, ready,
      play: () => video.play(),
      pause: () => { video.pause(); },
      seek: seconds => { if (Number.isFinite(seconds)) video.currentTime = Math.max(0, seconds); },
      getTime: () => video.currentTime || 0,
      // Infinity (unbounded streams) and NaN (no metadata yet) both mean "unknown".
      getDuration: () => finite(video.duration),
      setVolume: v => { video.volume = v; video.muted = v === 0; },
      async pip() { if (document.pictureInPictureEnabled && video.requestPictureInPicture) await video.requestPictureInPicture(); },
      destroy() { destroyed = true; video.pause(); video.removeAttribute("src"); video.load(); holder.remove(); }
    };
  }

  if (entry.provider === "youtube") {
    await loadSDK("YouTube", "https://www.youtube.com/iframe_api", () => Boolean(window.YT?.Player));
    if (stale()) { holder.remove(); return null; }
    let readyResolve;
    const ready = new Promise(resolve => { readyResolve = resolve; });
    const node = document.createElement("div");
    holder.append(node);
    const player = new window.YT.Player(node, {
      videoId: entry.id,
      width: "100%", height: "100%",
      playerVars: { controls: 0, disablekb: 1, fs: 0, playsinline: 1, rel: 0, enablejsapi: 1, origin: window.location.origin },
      events: {
        onReady: () => { readyResolve(); callback("ready"); },
        onStateChange: event => {
          if (event.data === window.YT.PlayerState.ENDED) callback("ended");
          if (event.data === window.YT.PlayerState.PLAYING) callback("playing");
          if (event.data === window.YT.PlayerState.PAUSED) callback("paused");
        },
        onError: event => callback("error", YOUTUBE_ERRORS[event?.data] || "", { blocked: YOUTUBE_EMBED_BLOCKED.has(Number(event?.data)) })
      }
    });
    return {
      kind: "youtube", live: false, ready,
      play: () => player.playVideo(), pause: () => player.pauseVideo(),
      seek: seconds => player.seekTo(seconds, true),
      getTime: () => finite(player.getCurrentTime?.()),
      getDuration: () => finite(player.getDuration?.()),
      setVolume: v => { if (v === 0) player.mute(); else { player.unMute(); player.setVolume(Math.round(v * 100)); } },
      destroy() { destroyed = true; try { player.destroy(); } catch { /* removed player */ } holder.remove(); }
    };
  }

  if (entry.provider === "vimeo") {
    await loadSDK("Vimeo", "https://player.vimeo.com/api/player.js", () => Boolean(window.Vimeo?.Player));
    if (stale()) { holder.remove(); return null; }
    const videoURL = entry.hash ? `https://vimeo.com/${entry.id}/${entry.hash}` : `https://vimeo.com/${entry.id}`;
    // Non-responsive: the module's CSS sizes the iframe to fill the media area.
    const player = new window.Vimeo.Player(holder, { url: videoURL, autopause: false, controls: false, dnt: true, responsive: false, width: 640, height: 360 });
    let t = 0; let duration = 0;
    player.on("timeupdate", event => { t = event.seconds; duration = event.duration || duration; });
    player.on("seeked", event => { t = event.seconds; });
    player.on("ended", () => callback("ended"));
    player.on("play", () => callback("playing"));
    player.on("pause", () => callback("paused"));
    const vimeoBlocked = error => /privacy|password|domain|embed/i.test(`${error?.name || ""} ${error?.message || ""}`);
    player.on("error", event => callback("error", vimeoBlocked(event)
      ? "This Vimeo video's privacy settings don't allow it to play here." : event?.message || "", { blocked: vimeoBlocked(event) }));
    const ready = player.ready().then(async () => {
      duration = await player.getDuration().catch(() => 0) || duration;
      callback("ready");
    }, error => {
      if (vimeoBlocked(error)) callback("error", "This Vimeo video's privacy settings don't allow it to play here.", { blocked: true });
      throw error;
    });
    return {
      kind: "vimeo", live: false, ready,
      play: () => player.play(), pause: () => player.pause(),
      seek: async seconds => { t = await player.setCurrentTime(seconds); },
      getTime: () => t, getDuration: () => duration,
      setVolume: v => player.setVolume(v).catch(() => {}),
      destroy() { destroyed = true; player.destroy().catch(() => {}); holder.remove(); }
    };
  }

  if (entry.provider === "twitch") {
    await loadSDK("Twitch", "https://player.twitch.tv/js/embed/v1.js", () => Boolean(window.Twitch?.Player));
    if (stale()) { holder.remove(); return null; }
    const div = document.createElement("div");
    div.id = `fwr-twitch-${Math.random().toString(36).slice(2)}`;
    holder.append(div);
    let readyResolve;
    const ready = new Promise(resolve => { readyResolve = resolve; });
    // Twitch.Player looks the target up by id in the main document, so pass the element when possible.
    const player = new window.Twitch.Player(div.ownerDocument === document ? div.id : div, {
      width: "100%", height: "100%", parent: [window.location.hostname],
      autoplay: false, muted: false,
      ...(entry.videoType === "vod" ? { video: `v${entry.id}` } : { channel: entry.id })
    });
    const E = window.Twitch.Player;
    const safe = fn => { try { return fn(); } catch { return 0; } };
    player.addEventListener(E.READY, () => { readyResolve(); callback("ready"); });
    player.addEventListener(E.ENDED, () => callback("ended"));
    player.addEventListener(E.PLAY, () => callback("playing"));
    player.addEventListener(E.PAUSE, () => callback("paused"));
    if (E.OFFLINE) player.addEventListener(E.OFFLINE, () => callback("error", "This Twitch channel is offline."));
    player.addEventListener(E.PLAYBACK_BLOCKED, () => callback("blocked"));
    return {
      kind: "twitch", live: Boolean(entry.live), ready,
      play: () => player.play(), pause: () => player.pause(),
      seek: seconds => { if (!entry.live) player.seek(seconds); },
      getTime: () => entry.live ? 0 : finite(safe(() => player.getCurrentTime())),
      getDuration: () => entry.live ? 0 : finite(safe(() => player.getDuration())),
      setVolume: v => { player.setMuted(v === 0); player.setVolume(v); },
      destroy() { destroyed = true; try { player.pause(); } catch { /* not ready */ } holder.remove(); }
    };
  }
  holder.remove();
  throw new Error(`Unknown video provider: ${entry.provider}`);
}
