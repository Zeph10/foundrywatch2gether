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
- **Hide X / Escape:** Hides the local window; **does not close the shared room**. Re-open it with the launcher (which toggles) or the scene-control button. The floating launcher can be turned off in Module Settings.
- **End room:** Host or GM closes the shared room for everybody (asks for confirmation).
- **Start room:** Permission threshold is configured in Foundry Module Settings.

## Developer notes

- Entrypoint: `scripts/main.js` (ES module). Pure source and state operations in `scripts/state.js`. Third-party adapters in `scripts/providers.js`, trigger / music manager logic in `scripts/music-features.js`, encounter profiles and cinematics in `scripts/director.js` (pure rules in `director-core.js`), shared overlay helpers in `scripts/ui.js`.
- API available after ready: `game.modules.get('foundry-watch-room').api` → `open()`, `closeLocally()`, `toggle()`, `getState()`, `startRoom()`, `endRoom()`, `addVideo(url, title)`, `addAudio(url, title)`, `openMusicManager(actorUuid?)`, `trigger(nameOrId)` and `triggerEvent(event, context?)`.
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
