# Shared Watch Room — Foundry VTT V14

A Watch2Gether-inspired, **single shared room** for video and music playback, synchronized across the Foundry world. No module dependencies or D&D-system dependencies.

## What's included

- **Three layouts:** compact thumbnail (per-player), draggable/resizable desktop window, or a video surface overlaid on and anchored to a shared scene's canvas coordinates. Each player can pick their preferred view. The host can position the scene surface by dragging its header.
- **One room** for everyone; configurable room creation permission (GM only, trusted players, everyone); opening a room automatically opens the local player on all connected clients by default.
- **YouTube, Vimeo, Twitch live channels/VODs, direct MP4/WebM/OGG/M4V links, and MP3/WAV/OGG/FLAC/M4A/AAC/Opus audio**, including files served from Foundry's `worlds/`, `modules/`, `systems/`, or `assets/` folders.
- **Synchronized** play, pause, seeks, late joins, and periodic drift correction for seeking-capable videos. Live Twitch streams use best-effort play/pause; seek and frame-perfect syncing aren't possible on live streams.
- **Host-controlled** video queue (add, reorder, play now, remove) and playback, optional individual control grants/revokes, GM takeover, and individual volume/mute.
- **Start times** from links are honored (`?t=90`, `&t=1m30s`, Twitch `?t=1h2m3s`, Vimeo/direct-file `#t=45s`).
- **Auto-advance** to the next queued video even if the host has hidden the player or gone offline: any synced watcher can report the end of a video, and the GM's client checks it against the room clock.
- **Independent playback** opt-out, click-to-rejoin sync, fullscreen, hide, and Picture-in-Picture. Document PiP needs a browser that supports it; direct files can additionally use conventional video PiP.
- Persistent room state, loop preferences, shared queue, music library, and triggers stored in Foundry world settings, so a reload can recover position for ongoing videos.

## New in v1.3: Encounter Profiles, Boss Phases & Cinematic Director

### The Director

A GM opens **⚜ Director** from the Watch Room header, **⚜ Cinematic Director** from the Music Library, or **Director** from supported Actor sheets. No extra dependencies are needed. The window is Foundry-style charcoal/gray/gold and remains available when the shared room is closed.

- **Encounter profiles**: Create named, persistent profiles; associate one with a world actor and optionally a scene. Profiles match that actor in a combat and may contain any number of boss HP phases and dynamic event rules. Profiles can be paused individually. A profile is reusable across sessions and combats. A given HP threshold fires once per combat and actor, even after healing. If one hit crosses several thresholds, only the deepest reached phase plays. **Configure the scene/actor before combat**, and ensure the boss is an actor in the combat tracker.
- **Combat thresholds** (formerly boss phases): change the music when the boss's HP, all enemies' pooled HP, the party's pooled HP, the lowest player character's HP, or the number of enemies still standing falls below or rises above a value. Each fires once per combat; the boss measure needs a boss actor, the others don't.
- **Boss phases**: Configure a percentage threshold (0–100), choose a library track, set loop, resume, queue/interrupt and priority. A button can generate starter phases at **75%, 50%, and 25%** from the currently selected track; individual phase tracks and settings can then be edited. HP phases use the actor's `system.attributes.hp.value/max` where available (D&D 5e and similarly structured systems). If an actor lacks usable HP values, boss-phase automation cannot run.
- **Dynamic triggers**: Within each profile, react to combat start/end, initiative, turn start, **round number**, defeated/0 HP, scene activation, Active Effect/condition added or removed, **spell chat card** (best-effort D&D 5e detection), or a manual trigger. Narrow a rule by actor, round, or a case-insensitive spell/condition name. Mark rules once-per-combat and assign individual tracks, playback mode, loop/resume and priority. A macro API allows custom events when a system's native hooks differ.
- **Priority system**: A currently playing trigger track with priority 90 resists interruption by a priority 50 event. Set each track/event priority **0–100**. The default is 50; boss-phase presets use 75, 80, and 85. Equal-priority cues are allowed; queued media can always be added; GM manual library playback can explicitly force a lower-priority interruption. Player-requested queue selection and manual skip continue using the original permissions/voting model.
- **Music library**: Existing tracks are preserved. Tracks now support **categories and tags**, search, and metadata editing; their stable IDs can be referenced by HP phases, encounter profiles, cine cues and Foundry macros. The Library Manager retains MP3/audio upload and file browsing, and buttons to play/queue/loop tracks. Library items can contain the video URLs already supported by Watch Room as well as server audio files.
- **Cinematic Director**: Create named cinematic sequences with timed steps (`0`, `10`, `45` seconds, etc). Supported steps: **play/queue a library track**, activate a Foundry scene, open a permitted journal for connected players, adjust active-scene darkness (0=day, 1=night), run a saved GM Foundry macro, play/pause the room, toggle player focus mode, and send text narration to chat. Add, remove, edit, save and replay cue steps. Cue timelines are stored in world settings, and the active cue's start time synchronizes across the room. A GM can start/stop a cue manually; stopping it ends the timeline and focus mode, **not** current music.
- **Focus presentation**: On cinematic start, participating players see a centered large player with a darkened backdrop; each player can still close or use independent playback. Ending focus returns the UI to its previous size/layout. Browser autoplay limitations still apply.

#### GM macro examples

```js
const api = game.modules.get('foundry-watch-room').api;
api.openDirector();
api.playLibrary('Lich Phase 2', {priority: 85, resume: true});
api.playLibrary('Dungeon Ambience', {action: 'queue'});
api.runCinematic('The Lich Awakens');
api.stopCinematic();
// Manually raise a custom event tied to a saved Encounter Profile rule.
api.fireDirectorEvent('spellCast', {actor: game.actors.getName('Lich'), spell: 'Power Word Kill'});
```

For a profile's explicitly **manual** trigger, use `api.runProfileTrigger(profileId, triggerId)`. `api.getLibrary()`, `api.getProfiles()` and `api.getCinematics()` return read-only copies for macro authors. Existing `api.trigger('Old Trigger Name')` still works for v1.2 rules.

- **Closed room**: by default, encounter music, boss phases and cinematics open the room automatically (the active GM becomes host). Turn off **Encounter music and cinematics open the room** in Module Settings to have automation do nothing while the room is closed.

### Limitations and compatibility notes

- Only one *active GM client* schedules shared events; keep a GM online. Timelines step at approximately 0.5-second granularity (network latency adds uncertainty); this is not a frame-accurate cinematics engine. Cinematic timers are keyed to server time. If the GM is absent for more than 10 seconds, overdue steps are skipped upon resumption rather than replaying old actions.
- A profile must have a selected world actor (or be intentionally actor-independent). HP phases use the actor model's HP fields; some token-only/system-specific HP changes may not surface through the generic Foundry hooks. Test boss phases against your actual actor and token update path.
- Spell detection from D&D 2024 activity cards is **best effort**, based on system chat-message flags. For guaranteed detection of a specific spell or automation module, use `fireDirectorEvent(...)` from an activity/macro hook.
- Journals are opened only to players who already have permission to view them; the module does not override Foundry permissions. GM macros run as the GM and should be audited before saving into a cinematic.
- Changing or deleting music-library records can leave references to missing tracks in profiles/cues; these show as missing in the editor. Editing a track in place preserves its ID.
- Profiles, cinematic steps, room sync and playback are client-side Foundry module features. They have automated unit tests, **but have not been tested in a live Foundry V14 world with two browsers**. Treat v1.3.0 as a beta until tested locally.

---

## Previous: v1.2 Music, automation, loop, votes and small player

- **Foundry charcoal and gold:** dark charcoal, pewter-gray panels and warm gold accents, scoped to this module.
- **Compact thumbnail view:** press the minimize/expand symbol in the player header. Each user's compact layout and position are independent. Compact mode shows the video thumbnail, play/pause, skip, repeat, individual volume and timeline. Expanding returns to the full layout (or your preferred scene overlay). Resize the compact window like the original.
- **Audio playback and saved library:** a GM opens the **musical note** in the player header or queue. Upload MP3, OGG, WAV, M4A, AAC, FLAC or Opus directly into Foundry's module storage using the V14 persistent uploader; or browse an existing server audio file. The GM saves a URL or audio file as a named library track. Your Foundry server and each browser must support the selected codec. Uploads cap at 100 MB per file (server limits may be lower). Files stay on the Foundry server; library metadata is saved in world settings.
- **Repeat modes:** the main loop button cycles `off → repeat current → repeat queue`. The adjacent individual-track loop button takes precedence when the current track finishes; clicking Next always skips, even when looping. The music library also has a per-track loop toggle for encounter themes.
- **Voting toggle:** GM/host can enable **Vote before changing songs** in the queue pane. Non-GM players can propose selecting a queued track or skipping. A majority of *currently connected, non-GM users* must vote Yes within 30 seconds or the vote is declined. The requesting player votes Yes automatically. The GM can immediately approve/reject or change tracks directly without a vote. Normal auto-advance and configured encounter triggers bypass voting.
- **Encounter trigger manager:** GM configures saved tracks for these events: combat starting, combat ending (combat deleted/deactivated), a selected world actor rolling initiative, a selected actor's turn, an actor dropping to 0 HP / being marked defeated, a world scene being activated, or a manual macro. Open it from the player musical note, or click **Music** on supported actor-sheet headers. Rules can optionally be scoped to a world actor or scene.
- **Per-rule actions:** interrupt the current track and optionally resume it at its previous timestamp after the encounter track ends, or add the track to the queue. Nested interrupts can resume up to five saved tracks. Saved trigger settings survive world restarts and are evaluated by the currently connected active GM. Looping encounter tracks remain active until skipped by a controller or overridden by another trigger.
- **GM-only management:** the music library, uploads, and trigger rules are edited by GMs. Playback controllers can manage the live queue, and players participate in votes when enabled. A connected GM is required for shared changes and automation.

**Create an encounter theme**: Open Music & Triggers → upload/browse/save a song → add a trigger → select event "Creature rolls initiative" → choose the relevant actor (or use the Music button on its sheet) → select track → choose "Play immediately" and "Resume previous" → Save. The trigger fires when that actor receives an initiative value in a combat, without a vote.

**Macros:** Make a trigger with event **Manual / macro**, name it e.g. `Boss Entrance`, then run:

```js
game.modules.get('foundry-watch-room').api.trigger('Boss Entrance');
```

Only the GM or permitted live playback controllers can invoke a configured manual trigger. See the music manager for the exact name.

## Splitting vocals and importing tracks

**Live, in the room.** The **Track sound** panel's **Vocals** setting offers *Original*, *Remove vocals (instrumental)* and *Vocals only*, with a **Strength** slider. It works on audio/video files (uploads, or direct links whose server allows it). The splitter looks at every frequency separately and takes out only what is mixed dead-centre in the vocal range. Stereo width, bass, cymbals and off-centre instruments stay as they are.

**Saved, in the library.** *Music & Triggers → Import & convert* takes a direct file link, a file from your computer, or an existing library track. It saves any of: the full track as MP3, an instrumental, and a vocals-only version. The files go into the module's storage folder (kept across updates) and appear in the library, linked as stems. YouTube/Vimeo/Twitch/Spotify links can't be imported; their terms don't allow downloading. If a site blocks downloads from other websites, download the file and choose *From your computer*.

**AI separation (v1.7, best quality).** *Music & Triggers → AI vocal separation → Download model* fetches a trained MDX-Net model (UVR's *Inst HQ 3*, 64 MB) from Hugging Face once. It's checked against its SHA-256 and kept in that GM's browser, not on the Foundry server. Import & convert then offers **Separation: AI model**, and it runs entirely in the GM's browser.

- **Speed:** on the processor it takes roughly 3–5× the song's length, so about 10–20 minutes for a 4-minute song. It uses up to 3 cores in parallel. Browsers with WebGPU use the graphics card and are much faster. Leave the tab open while it works.
- **Offline:** if the download is blocked, download `UVR-MDX-NET-Inst_HQ_3.onnx` yourself and use **Load model file…**.

**Pre-render, and the room uses it automatically.** The ✂ button on a library track (or **Pre-render tracks with vocal settings**) saves an instrumental and a vocals version next to it. It uses AI when the model is installed, otherwise the spectral splitter. From then on, whenever that track is set to *Remove vocals* or *Vocals only*, the room plays the pre-rendered file for everyone instead of filtering live. That includes the Track sound panel, triggers, boss phases and cinematics. Switching between versions crossfades and keeps the position.

**How good is it?** Measured on 5 real songs from the MUSDB18 test set (SDR, higher is better; +3 dB ≈ half the leftover error):

| Method | Instrumental | Vocals |
|---|---|---|
| Doing nothing (the mix itself) | 4.3 dB | −4.3 dB |
| Live / spectral splitter | 5.5 dB | 1.2 dB |
| **AI model** | **14.9 dB** | **10.9 dB** |

The live splitter is a rough karaoke effect on real songs. It can't separate the voice from other centred instruments in the same range, and reverb and wide harmonies survive. The AI result is close to what desktop tools such as Ultimate Vocal Remover produce with the same model. Mono recordings can't be split by the live splitter, but the AI model handles them.

## Track sound: fades

Controllers see a **Track sound** panel in the queue sidebar. Its settings apply to everyone:

- **Fade in / Fade out** (seconds) for the current track. Set defaults per track in the Music Library; they carry into triggers, boss phases and cinematics.
- **Fade out & pause** / **Fade to next** for ending a scene smoothly.
- **Crossfade between tracks** (Module Settings) blends one track into the next. A track's own fade-in/out takes precedence.

## Who's listening and joining in

The **Who's listening** panel shows every logged-in player and what their browser is doing: listening, paused, muted, player closed, needs a click to start sound, and so on. "Not responding" usually means the module isn't enabled for that player or their page is still loading. GMs can **Nudge** anyone who isn't listening.

When initiative is rolled, players who aren't listening get a **Join & listen** banner. Clicking it opens the room and also unlocks browser sound, so it's the easiest way to get everyone hearing the combat music. Turn it off in Module Settings → **Ask players to join when initiative is rolled**.

## Videos that can't be embedded

Some video owners disable embedding (YouTube: *"Playback on other websites has been disabled by the video owner"*; Vimeo: domain-restricted privacy). No module can force those to play inside Foundry. The room offers two workarounds and picks up the problem automatically:

- **Synced pop-ups**: everyone watches on the video's own site in a pop-up window that the room keeps in sync. Play and seek reload the pop-up at the room's current time, and pause shows a "paused" page. Best when every player can open the video themselves. Allow pop-ups for your Foundry site when the browser asks. YouTube may need a click inside the pop-up the first time before it plays with sound.
- **Screen share**: a controller opens the video in another browser tab and clicks the **screen** button in the queue panel (or *Share my screen instead*), then picks that tab and ticks **Share tab audio**. Everyone sees and hears that tab, live. Best when only the host can play the video, e.g. a members-only or region-locked video the host has access to. It needs Foundry served over **HTTPS** (or localhost). Each viewer receives a direct peer-to-peer stream, so the sharer's upload bandwidth limits it to roughly 6–8 viewers. If some players can't connect, add a TURN server in **Module Settings → Screen share: ICE servers**. DRM services (Netflix, Disney+ etc.) show a black screen when shared; that's the services' copy protection.

When you add a YouTube or Vimeo link, the room checks whether embedding is allowed and queues blocked videos in pop-up mode automatically. If a video fails while playing, a panel offers pop-ups, screen share or Skip. Controllers can switch any video either way with **Use pop-ups** / **Play in Foundry** under the player, or the ↗ button on a queued item.

## Installation (manifest URL)

In Foundry: **Add-on Modules → Install Module**, paste this into **Manifest URL**, and click **Install**:

```
https://github.com/Zeph10/foundrywatch2gether/releases/latest/download/module.json
```

Foundry will then offer updates whenever a new release is published.

### Publishing releases (maintainers)

1. Bump `"version"` in `module.json` (for example `1.3.2`) and add a `CHANGELOG.md` entry.
2. Push to `main`. The workflow in `.github/workflows/release.yml` runs the tests, builds `module.zip`, and creates release `v1.3.2` with `module.json` and `module.zip` attached. It skips versions that already have a release, and can also be run by hand from the **Actions** tab.
3. Foundry offers the update to anyone who installed from the manifest URL.

## Installation (ZIP)

1. Extract `foundry-watch-room/` from the ZIP directly into **Foundry User Data** → `Data/modules/`. The result must be `Data/modules/foundry-watch-room/module.json`.
2. Restart Foundry if it was running, then enable **Shared Watch Room** in **Game Settings → Manage Modules**.
3. Ensure a GM is connected. Click **Watch Room** at the bottom-left, or the TV button under token scene controls.
4. Start the room; every connected player gets the window automatically. The host adds a video URL and presses Play.
5. The host can **Place in scene**. Each user can toggle **Scene / Window**. Scene mode anchors the surface to the active scene; users on a different scene see their window instead. Drag the scene-mode header (as the host) to move the shared surface.
6. Grant controls under **Playback permissions** as appropriate. A GM can reclaim host privileges if needed.

## Compatibility

- Target **Foundry V14.367–14.368**. The package manifest declares a minimum of 14.367 and verified-target 14.368. **This is a prototype and has NOT been runtime-tested inside a live Foundry client.** The declaration is an intended compatibility target, not a claim of completed live verification.
- Works independent of game system and without Midi-QOL.
- YouTube/Vimeo/Twitch provider playback depends on external vendor JavaScript APIs, their embedding policies, network conditions, browser extensions, and the host's Content Security Policy.
- **Twitch requires a supported HTTPS host/domain** except approved localhost cases. The module supplies the `parent` host parameter, but a local IP or insecure/non-public address can fail Twitch's embedding restrictions.
- Private/age-restricted/geo-blocked/disallow-embed videos won't play in an iframe. Paid DRM streaming (Netflix/Disney+/etc.) is not supported. **Twitch clips** are not included.
- Modern browsers restrict autoplay and unmuted starts; each watcher may have to click **Click to enable playback** at least once. The module cannot override the browser's consent rules.
- Browser **Document Picture-in-Picture** works only on browsers implementing the API (recent Chromium-based browsers). Traditional video PiP is supported for direct-file videos; it cannot reliably control third-party iframes.
- World settings maintain the official shared state, updated by one active GM's Foundry client. **At least one GM must be connected** for shared operations. When no GM is connected, the current room remains watchable but no new state changes are accepted.
- **Security note:** Foundry module sockets are client-originated; this prototype's role-based controls apply to normal game clients, not malicious players who tamper with the socket protocol. Do not rely on this client-side model for adversarial authorization without a trusted server-side integration.
- **Scene mode is an HTML overlay positioned in scene coordinates**, not a saved Foundry Tile or a video texture. This allows embeddable iframes to work, but won't appear in exports or recordings of the canvas alone.

## Controls

- **Play/Pause, Next, Seek:** Available to the room host, GMs, and users granted playback permissions. Viewers see a synchronized timeline.
- **Queue:** Arrow buttons reorder, ▶ plays immediately, ✕ removes. The folder button opens Foundry's video file browser; the music manager includes the audio browser and uploader. The list button in the header shows or hides the queue panel (hidden by default in scene view).
- **Independent playback:** Stops automatic syncing locally and enables local playback controls. Turning it off catches up to the room.
- **Repeat:** The repeat button cycles off → current track (badge “1”) → whole queue; the adjacent button loops just the current track. Both are controller-only.
- **Volume:** Per-client, not broadcast. Click the speaker icon to mute/unmute.
- **Minimize (– button, Escape, or the launcher):** shrinks the room to a small bar at the bottom-left and **keeps playing and in sync**, including while Foundry is in a background tab or another window has focus. The bar shows the track and time, with play/pause (for controllers), mute, open and close. Drag it anywhere by its grip; click the title to open the full player again. The choice is remembered, so the room opens minimized next time too.
- **Media keys:** the keyboard play/pause key and the system's "now playing" controls work while Foundry isn't focused. Controllers pause or skip for everyone. For other players, play/pause mutes or unmutes just them. Coverage depends on the browser, and YouTube embeds may take over these keys.
- **Close (X):** closes the player for you and **stops your sound**; it does not end the shared room. Re-open it with the launcher or the scene-control button. The floating launcher can be turned off in Module Settings.
- **End room:** Host or GM closes the shared room for everybody (asks for confirmation).
- **Start room:** Permission threshold is configured in Foundry Module Settings.

## Third-party code

- **lamejs 1.2.1** (MP3 encoder, https://github.com/zhuker/lamejs), LGPL-3.0, bundled unmodified in release builds at `vendor/lamejs/` with its licence. It runs only when you use Import & convert.
- **ONNX Runtime Web 1.20.1** (Microsoft, MIT), loaded from jsDelivr only when AI separation runs. You can point it elsewhere in Module Settings → *AI separation: runtime location*.
- **UVR-MDX-NET-Inst_HQ_3** model by the Ultimate Vocal Remover project (https://github.com/Anjok07/ultimatevocalremovergui). It isn't bundled; each GM's browser downloads it from a public Hugging Face mirror when asked.

## Developer notes

- Entrypoint: `scripts/main.js` (ES module). Pure source and state operations in `scripts/state.js`. Third-party adapters in `scripts/providers.js`, trigger / music manager logic in `scripts/music-features.js`, encounter profiles and cinematics in `scripts/director.js` (pure rules in `director-core.js`), shared overlay helpers in `scripts/ui.js`.
- API available after ready: `game.modules.get('foundry-watch-room').api` → `open()`, `closeLocally()`, `minimize()`, `restore()`, `toggle()`, `getState()`, `startRoom()`, `endRoom()`, `addVideo(url, title)`, `addAudio(url, title)`, `openMusicManager(actorUuid?)`, `trigger(nameOrId)` and `triggerEvent(event, context?)`.
- Tests: `node --test tests/*.mjs` (pure state/parsing, repeat/vote/encounter logic and manifest).
- No permanent storage of provider API keys, account credentials, user chat messages, or playlist history.
- Manual test checklist: one GM + one player; start with autojoin; try all four sources; grant/revoke; queue Next; seek; reload mid-play; independently pause/rejoin; scene placement/drag and pan/zoom; browser autoplay prompts; GM disconnect; end room; check browser devtools for CSP or provider errors.

## Limits and caveats

- **Not runtime-verified in a live Foundry instance**: this ZIP has passed static / automated logic tests but UI and all hooks still need an in-world smoke test. Test with a GM and one player before session time.
- Audio cannot bypass browser autoplay policies; every player may need to click **Enable playback** when their browser first joins.
- Twitch, YouTube and Vimeo rely on third-party embed rules; uploads play as direct browser-served media.
- The **0 HP** automation is designed around the D&D 5e `system.attributes.hp.value` field or combatant defeated status. Other systems may use different HP paths. The first observed HP value for certain unlinked token actors may need combat to initialize; defeat flag changes are also supported.
- Multiple triggers for one event fire in their saved order. Scene activation is Foundry's *active world scene*, not an individual player's private canvas navigation.
- The music manager does not overwrite existing Foundry playlists or Journal entries. It stores track URLs and trigger definitions under the module's own world settings.
