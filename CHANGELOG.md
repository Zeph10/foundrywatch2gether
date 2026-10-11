# Changelog

## 1.5.1 — 2026-10-11

- Manifest now declares `"persistentStorage": true`. Foundry requires it for the Music Library's **Upload audio** button, which saves files into the module's own storage folder (`Data/modules/foundry-watch-room/storage/`). Those files survive module updates.

## 1.5.0 — 2026-10-11

### Instrumental mode (vocal reduction)
- New **Instrumental (reduce vocals)** switch in the **Track sound** panel and on library tracks. It removes centre-panned vocals using mid/side processing in the browser (Web Audio). The bass is kept, and the result plays identically in both speakers so it stays audible on mono devices. Switching is smooth and applies to everyone.
- Works on audio/video **files** (Foundry uploads, or direct links whose server allows CORS). YouTube, Vimeo and Twitch don't expose their audio, so for those the panel offers **Find an instrumental version on YouTube**.
- Mono recordings are detected and the room explains that they can't be separated. Measured on a test mix: the centred "voice" drops by about 34 dB while side-panned instruments keep their level.

### Fades
- **Fade in / fade out** per track (0–60 s), in the Track sound panel and on library tracks. Library fades carry into encounter triggers, boss phases and cinematics. Fades follow the shared room clock, so every player ramps together. Fade-in also applies when a track resumes from pause. Fade-out happens before the track's end, and not on looping tracks.
- **Crossfade**: when one track replaces another, the old one keeps playing underneath while it fades out (and its picture fades away). The length is the new track's fade-in, else the old track's fade-out, else the new world setting **Crossfade between tracks**.
- **Fade out & pause** and **Fade to next** buttons for controllers. A track paused this way fades back in over the same time when resumed.

### Combat thresholds
- The Director's *Boss HP phases* are now **Combat thresholds** with five measures: the boss's HP %, **all enemies' pooled HP %**, **the party's pooled HP %**, **the lowest player character's HP %**, and **enemies still standing**. Enemies and party are told apart by token disposition and player ownership.
- Each threshold can fire when the value **falls to or below** or **rises to or above** it (e.g. the party heals back up). Each fires once per combat. When several cross at once, the highest-priority, most extreme one plays.
- Only boss-HP thresholds need a boss actor on the profile; the others work for any fight in the profile's scene.

### Who's listening
- New **Who's listening** panel lists everyone logged in with what they're actually doing: listening, paused, muted, player closed, needs a click to start sound, in the pop-up, loading, can't play this video, or not responding (module not loaded). Offline users are listed underneath, and the header badge shows e.g. "3/5 listening".
- GMs get a **Nudge** button next to anyone who isn't listening. It sends that player an invitation.

### Join prompt on initiative
- On the first initiative roll of a combat, everyone who isn't listening gets a **Join & listen** banner (if the room is open, e.g. once encounter music has started). Clicking it opens the room and also counts as the click browsers require before playing sound. On by default. New world setting **Ask players to join when initiative is rolled**.

## 1.4.0 — 2026-10-07

### Videos that can't be embedded
Some owners turn off embedding (YouTube "Playback on other websites has been disabled", Vimeo domain privacy). Nothing can force those to play inside Foundry, so the room now works around them:

- **Detected when added.** Adding a YouTube or Vimeo link asks the provider whether embedding is allowed. If it isn't, the video is queued in pop-up mode automatically. When the title box is empty, the real video title is filled in.
- **Detected while playing.** If a provider refuses mid-session (YouTube errors 101/150, Vimeo privacy errors), the player shows a panel with: *Watch in a synced pop-up*, *Switch everyone to pop-ups*, *Share my screen instead* and *Skip*. Players see the pop-up option and a note to ask the host.
- **Synced pop-ups.** The video opens on its own site in a pop-up window that follows the room. Play and seek reload it at the room's current time (with a 2-second allowance for page load). Pause swaps in a "paused" page that shows the time. Each player can turn following off. Controllers can switch any current or queued YouTube/Vimeo/Twitch video between pop-up and embedded playback (*Use pop-ups* / *Play in Foundry*, or the ↗ button in the queue). Pop-up videos get a seekable timeline even though their length is unknown.
- **Screen share.** A controller can share a browser tab, window or screen (with tab audio) and the room streams it to everyone over peer-to-peer WebRTC. Only the sharer needs access to the video. The video that was playing goes back to the top of the queue at its current position, and comes back when sharing stops. The share ends automatically if the sharer stops it in the browser, reloads, or disconnects. Requires HTTPS (or localhost). A new world setting accepts TURN servers for players behind strict firewalls.

### Fixed
- Switching a video between pop-up and embedded mode didn't rebuild the player on clients, because the video's id doesn't change.

## 1.3.1 — 2026-10-07

### Fixed
- **Music manager couldn't be reopened** after closing it once (it stayed hidden).
- **"Browse server" was unusable**: the manager and Director sat at z-index 100000+, so Foundry's FilePicker opened behind them. Director → Music Library also opened the manager behind the Director. Both now stack like normal Foundry windows (raised on open/click), so pickers, dialogs and journals opened from them appear on top.
- **Cinematic focus covered the journals** its own "Show journal" steps opened. Focus mode now sits above the canvas and sidebar but below Foundry windows.
- Cinematic focus overwrote each player's saved window size and position (ResizeObserver and drag saved the centered focus geometry), so "returns to the previous layout" didn't hold. It's no longer saved, and dragging is disabled while focused.
- Auto-opening the room for encounter music raced: a separate OPEN was sent before the cue, and several cues at once produced spurious "room didn't accept" warnings. The leader now opens the room and applies the cue in one transaction. A new world setting turns this off.
- Automation rejections (priority-gated cues, timeline play/pause with nothing loaded, vote timeouts) showed "The room didn't accept that change" on the GM's screen. They're now silent; a manual cue blocked by priority says so plainly.
- **Vote mode**: the checkbox never reflected the room's state (other GMs saw it unchecked) and was shown to players who can't change it. Players could vote to play a queued track but **not to skip**, because the Next button stayed disabled.
- **Repeat buttons** gave no indication of the current mode and were clickable by viewers (who were then rejected). They now show off / one / queue and are disabled for non-controllers.
- A looping track keeps its id, so a second controller's late "ended" report restarted the loop again (audible stutter). Stale reports are now checked against the room clock.
- Director: dropping to 0 HP and being marked defeated fired "defeated" triggers **twice**. Both now share one event key.
- Director: an encounter profile without a boss actor fired its HP phases for **every** creature in the fight, PCs included. HP phases now require the profile's actor, and the editor says so.
- Director: no turn-start event on a new round when `turn` didn't change (e.g. a single combatant).
- Director: deleting a running cinematic left focus mode on forever. It's now stopped.
- Manager and Director re-renders jumped back to the top after every save and cleared the library search.
- `fireDirectorEvent` / `triggerEvent` silently did nothing for a GM who wasn't the active (leader) GM. They're now forwarded to the leader.
- Foundry's global button styles stretched the Director's close and nav buttons full-width and inflated the manager's button fonts.

### Improved
- Library track deletion asks for confirmation and says how many triggers, phases and cinematic steps use the track.
- Director shows which cinematic is running and only enables Stop while one is. Edit mode is highlighted, with an "Update…" button label.
- Native `confirm()` prompts replaced with Foundry dialogs. Escape closes the manager and Director.
- The vote panel names who proposed the change, counts only connected voters, and shows your own vote.
- Trigger list shows each rule's priority and actor.
- Two new state tests (26 total).

## 1.3.0 — 2026-10-07

- Added persisted **Encounter Profiles**, boss HP phases with once-per-combat threshold detection, and dynamic trigger rules.
- Added dynamic combat-round, Active Effect/condition and best-effort spell-card detection; manual macro event API.
- Added shared **0–100 priority gating** for encounter media interruptions, preserved with interruption/resume stack.
- Added searchable, taggable, categorized music library, in-place editing and stable-ID playback API.
- Added **Cinematic Director** timeline editor with media, scene, journal, darkness, GM macro, play/pause, focus, and narration cues.
- Added cinematic presentation mode and timed cue execution by the active GM, plus actor-sheet Director shortcut.
- Expanded automated Node tests for encounter rules, priority, timelines and state transitions (24 tests).
- Preserved module ID and v1.2 room, triggers and library settings for in-place upgrade.

## 1.2.0 — 2026-10-07

- Foundry-inspired charcoal/pewter/gold theme.
- Separate client-side 336 × 270 thumbnail player, saved layout/geometry, expand/collapse button.
- Direct browser audio playback (MP3/OGG/WAV/FLAC/M4A/AAC/Opus) and Foundry V14 persistent audio uploader.
- GM-managed persistent music library with track queueing, immediate playback, removal, saved per-track loop.
- Repeat current, repeat queue and current-track loop controls.
- GM-managed event triggers (initiative, combat start/end, turn start, defeat/0 HP, scene activation, manual macro).
- Actor-sheet shortcut for configuring encounter music, configurable interrupt/queue/resume behavior.
- Toggleable majority player voting for song changes, 30-second expiry, GM overrides.
- Added state-level regression tests covering these features.
- Retains the original module ID and existing room-state settings for in-place upgrade from v1.1.

# Changelog

## 1.1.0

### Fixed
- Every room change (including queue edits and permission grants) force-seeked every watcher, causing stutter and rebuffering. Each change was also processed twice (setting change + socket refresh). Duplicate revisions are now ignored and only playback changes trigger a forced sync, with a small tolerance.
- A sync requested while a periodic drift check was running was silently dropped (e.g. a pause could take up to 2.5 s to apply). It is now queued.
- Hiding the window while a video was loading left the player permanently blank on re-open. Re-opening after the host cleared the video left the old player on screen.
- The room stalled at the end of a video whenever no controller had the window open. Any synced watcher can now report the end; the leader GM checks the report against the room clock.
- Saved window geometry was re-applied every 2.5 s, fighting drags and native resizes; the window could also open off-screen on smaller displays. Geometry is now applied only on layout changes, clamped to the viewport, and resizes persist via ResizeObserver.
- Scene-mode surface: CSS minimum sizes distorted the placed size, it covered Foundry's sidebar and windows (z-index 100000), and dragging snapped back until the GM confirmed. Fixed all three.
- Picture-in-Picture: icons were missing (Font Awesome not copied), the stylesheet used a relative URL, the window could be dragged inside PiP, and ending or hiding the room left an empty PiP window open.
- The Scene/Window button label could show the wrong action.
- "Autoplay blocked" prompt appeared spuriously during slow buffering, and its warning never cleared. Detection now waits for a real "playing" event.
- Direct files: "ready" fired before metadata loaded, play/pause events weren't reported (breaking independent-mode button state), and live streams reported an infinite duration.
- Vimeo: the responsive embed overflowed the player area; duration was unknown until playback started.
- Vimeo `?h=` hashes weren't validated before being used in the player URL; `clips.twitch.tv` links gave a misleading error; malformed `%` escapes in file names threw `URI malformed`.
- Volume was written to settings on every slider tick. Header icon buttons had no accessible names.
- Rejected actions gave no feedback. The GM now reports rejections back to the requesting user.

### Added
- Queue reordering, start-time support in links, a file browser button, a mute toggle, a collapsible queue panel, end-room confirmation, Escape to hide, launcher toggle, optional launcher setting, notifications when a room starts or ends, YouTube error explanations, and `endRoom` / `addVideo` / `toggle` API methods.
- Defensive CSS so Foundry's global button and input styles don't distort the room's controls.
