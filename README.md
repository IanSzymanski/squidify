# Squidify

A device-local music player and installable offline web app. No remote music service, runtime CDN, telemetry, audio upload, or third-party runtime dependency.

## Use

1. Open the deployed HTTPS URL in a normal browser while online.
2. Install using Add to Home Screen (Safari on iPhone) or Install app (Chrome/Edge).
3. Open the installed app and import a folder or multiple audio files.
4. In Offline & settings, wait for **App available offline**. Test an offline reopen before relying on it.

Importing creates an offline copy in IndexedDB. Folder handles are remembered where `showDirectoryPicker` and structured cloning of handles are supported. Other browsers use folder/file inputs. Cloud-only files must be downloaded before an offline import. Original files are never modified.

The shell is cached by a service worker. A secure origin (HTTPS, or localhost for development) is required; opening index.html through file:// does not install an offline app. Every runtime asset is packaged locally. Files are played through object URLs with one active native HTML audio element by default. A bounded second element prepares iOS playlist restarts or optional standard crossfades. Mixing uses Web Audio gains only when enabled. Media Session provides supported Lock Screen/headphone actions.

## Features

- Play/pause, previous/next, seeking, volume/mute, repeat queue/song, restored paused session
- Shuffle bag with no repeats within a cycle, artist/album spacing, actual queue history
- Folder and multi-file import, recursive subfolders, sampled content fingerprint deduplication, incremental atomic writes, stop import, storage failure handling
- MP3 ID3, FLAC, and M4A metadata/artwork with filename fallback and browser duration probing
- Songs, albums, search, liked songs, sorting
- Persistent playlists, rename/delete, add/remove/reorder, M3U export
- Queue add/play next, jump, remove/reorder, save as playlist
- Responsive phone layout, full-screen now playing, accessible labels, keyboard controls
- Storage estimate and persistent storage request; offline status verified against all shell assets

## Equalizer tuning

Settings includes a live full-size and mini preview with twelve controls: zone
count, active section width, peak contrast, sensitivity, peak width, edge fade, attack/release speeds,
height, glow, fill and line thickness. Adjustments apply immediately to both
players, save to the device's existing settings store, and can be reset together.
The default 30% edge fade tapers each end of the active span into the protected
stationary baseline using a smooth envelope. Neighboring zones join directly
without manufactured boundary dips.

Active section width is centered and measured against the entire canvas: 100%
uses the full player width and 10% leaves a narrow moving strip in the middle.
It replaces the previous button-based motion boundaries. Peak height reaches
400% by growing the full player's canvas upward, without moving the controls;
the mini visualization stays within its icon. Existing settings keep their saved
values and receive the new width default of 60%. Full and mini player song titles
stay on one line, fade at the trailing edge, and scroll only when they overflow.
The marquee pauses at each end and stops for reduced-motion preferences.

The preview uses the playing track's decoded spectrum when available, otherwise
a labeled demo signal. Demo values never enter the actual player. Pause preview
freezes its signal while still allowing shape adjustments. Reduced-motion mode
uses a static preview and does not run an animation loop. The visualization does
not change audio output. Saved values are bounded on load; no library migration
is needed.

## Limits

Browser codecs determine which audio files play. DRM/subscription downloads are not supported. Background playback, automatic next track while locked, and media controls remain subject to browser/OS behavior and have not been verified on a physical iPhone. Audio is not sample-accurate gapless playback. Optional standard crossfades are available in settings; physical-phone/background mixing remains unverified.

### SQ-031: external music controls

The Media Session handlers use the same player and queue as the in-app controls.
Play/pause preserve the current queue and position; manual Next honors queued
items, shuffle and repeat-all, and advances even with repeat-one enabled.
Previous restarts after three seconds, otherwise returning through played order.
Explicit seekbackward/seekforward handlers are cleared to prefer song navigation;
seekto retains bounded progress-bar seeking. Stop pauses and resets to zero.
The browser/OS chooses the displayed controls and forwards headphone commands;
clearing seek handlers cannot guarantee a particular lock-screen layout.

Each registration is guarded independently and occurs once per playback engine.
Metadata, artwork, playback state and valid position data follow audio events;
unloading or failed loading clears stale session data. Shell v18 delivers this
change through the existing offline update flow without changing saved music.

Automated integration coverage exercises real playback actions, queue insertion,
shuffle/repeat boundaries, repeated commands, seeking, artwork/state updates,
failed loading, unloading and absent/partially unsupported Media Session APIs.
The offline-shell suite verifies cached launch and module access without network.

Physical-device verification remains pending (no hardware was available):

| Surface | Required checks | Result |
|---|---|---|
| iPhone Safari and installed Home Screen app | Lock screen/Control Center buttons; one song action per press; metadata/artwork; progress seeking; boundaries; offline playback | Not tested |
| Wired and Bluetooth headphones, locked and unlocked | Play/pause; next/previous; rapid repeated skips; offline playback | Not tested |

For each hardware run, record device model, iOS/browser versions, accessory model,
visible controls and observed behavior. Use multiple locally saved songs and
include shuffle, repeat-one, repeat-all and the queue end. If seeking buttons
remain or commands are not delivered, record that limitation; do not infer
universal compatibility from automated results.

Storage is local to this origin, browser profile, and sometimes installed-app container. It is not a backup or cross-device sync. Keep original files. Clearing site data or uninstalling can remove all music and playlists; a browser can reclaim nonpersistent storage. Persistence requests may be declined by the browser.

For large libraries, import in smaller batches and watch available storage. Duplicate detection hashes file size plus the first/last 64 KiB, not every byte; it avoids loading entire large audio files into memory.

## Source and verification

Static assets live in `dist`. Source is deployed from the Sites Git repository. Run `npm test` for pure playback/metadata, offline-shell and storage workflow tests. No build step or runtime dependencies are required.

For any release that changes cached assets, update `VERSION` in `dist/sw.js`. The worker activates only after every shell asset has been cached. Database schema is versioned independently.

Updates wait for existing app windows to close and do not force a reload or claim an open session. To apply an update, open Squidify online, then close all its tabs/app windows and reopen it. File inputs stay mounted while the native picker is open; the import dialog is closed only after files have been selected. Rendering is deferred during native selection.

## Architecture (SQ-001)

`app.js` is the composition and startup entry point. It wires the modules, restores
saved records and a paused session, and registers browser tools.

| Module | Responsibility |
| --- | --- |
| `context.js` | Shared application model, stable DOM references, and lookup helpers |
| `interface.js` | Views, dialogs, artwork URLs, routing, and delegated UI events |
| `import.js` | File/folder selection, rescans, deduplication, imports, and duration probes |
| `playlists.js` | Playlist and liked-song operations, forms, export, and playlist tool execution |
| `playback.js` | Audio lifecycle, queue actions, media URLs, Media Session, and session saving |
| `offline.js` | Service-worker registration and offline-readiness checks |
| `storage.js` | Existing IndexedDB schema and transactions, unchanged by SQ-001 |
| `core.js`, `metadata.js`, `icons.js` | Existing queue/helpers, metadata parsing, and icon assets |

Each subsystem is a factory with an explicit public API. The entry point creates
stable API objects before binding events; callbacks resolve collaborators after
wiring. There are no cyclic ES module imports. Playback and import timers/caches
are private to their owning modules, and native file inputs remain mounted.

SQ-001 changes neither the database name/version nor track, media, folder,
playlist, or session record formats. No migration or music re-import is needed.
The service worker's v4 shell includes every new module and retains the existing
wait-until-windows-close update behavior.

The workflow tests evaluate the real ES module graph with Node's VM modules
flag (development only), replacing only persistence with an in-memory adapter.
They cover import/deduplication, playlist changes, saved-session restoration,
failed writes, picker lifetimes, and deletion. Offline tests serve the full module
set without network access. Physical-phone playback and browser storage policies
still require device testing.

## Touch controls (SQ-002 and interaction follow-ups)

- Swipe up on the bottom player to expand it; swipe down on the full player's top bar to return.
- Swipe left on either player for next, right for previous (without restarting the current track).
- Swipe right on a song row to append it to the queue; the row highlights when the threshold is reached.
- Hold a song or playlist for 500 ms to open its options. Moving more than 12 px cancels the hold; vertical list scrolling stays native. Mouse right-click and Shift+F10 open the same menu, and visible options buttons remain available.
- Playlist options include rename, add songs, move up/down, export, and details. Song options include local metadata editing, queue/playlist actions, and file information.

`gestures.js` owns gesture recognition and delegates actions to existing modules.
Sliders are excluded. Canceled/multi-touch gestures do not execute actions, and
completed gestures consume their synthetic click. Automated tests cover those
boundaries; physical iOS/Android touch behavior still needs device testing.

Playlists now appear above songs in the library. Their custom order is saved in
an optional `playlistOrder` setting; existing databases need no migration. Song
detail edits affect local catalog records only, never the original file or saved
audio bytes. The specified empty-library help cards and sidebar copy are removed.

## Iridescent identity and release feedback

The primary colors are mint `#0eedb5` and violet `#ae00ff`, used on an ink-dark
neutral palette. Key accents use both colors; ordinary state indicators remain
solid mint. Playlist covers are deterministic CSS conic-gradient folds seeded
by playlist ID, with slow transform-only movement and stable cover identity.
The motion stops for reduced-motion preferences and hidden pages.

`motion.js` supplies staggered view entrances and a 680 ms SVG wave wash between
routes. Startup renders immediately. Rapid navigation cancels stale transitions;
file-picker-safe navigation and reduced-motion preferences skip the wash.
Lucide 1.8.0 SVG nodes are vendored in `icons.js`; attribution and the ISC license
are in `dist/LUCIDE-LICENSE.txt`. No runtime CDN or icon fetch is needed.

The v6 worker records whether it replaced an older offline shell. After the
matching active shell confirms readiness, a one-time toast announces the update
and remembers it in `installedShellVersion`. Waiting updates get a separate
close-and-reopen notice. Neither path reloads a live session or forces activation.
Keep `release.js` and the worker version synchronized for later releases.

The headphone squid was edited from the supplied sleepy-squid reference with the
built-in image generator. Prompt brief: preserve the sleepy eyes and squid shape,
add simple over-ear headphones, use a mint-to-violet graphic on a near-black
square with no text. Source: `assets/squid-headphones-source.png`. Browser,
180 px Apple touch, 192/512 px app, and maskable variants are under `dist` with
`-v6` names to avoid stale asset caches. Existing iOS Home Screen icons may retain
their old cached image; new installations use the new Apple touch icon.

Verification: 40 automated tests cover playback/storage/gesture regressions,
offline packaging, first-install versus upgrade notices, one-time notifications,
and transition cancellation/reduced motion. Physical-device animation and Home
Screen appearance remain device QA items.

## Shell v19 — lock-screen playback correction

A device report identified silent Next/Previous switches with stale duration in v18.
The player now retains its native media session during source transitions, warms
both neighboring songs, and calls play synchronously for cached external skips.
Position and duration require metadata from the selected source; source-reset
pause/empty events cannot cancel the new playback intent. The selected track's
saved duration is used only for its in-app loading display.

A persistent download notice and indeterminate progress bar track service-worker
installation. It clears on completion or failure, coexists with other toasts, and
does not force activation or reload. First installation uses separate offline-setup
wording. Old clients acquire this indicator once v19 has been installed.

Verification: 72 automated tests passed, including synchronous native-action
startup, retained session, delayed and stale metadata, pause while loading, and
update completion/failure. The audio harness models source reset, readyState,
currentSrc and delayed metadata. Physical iPhone locked playback remains pending.

## Shell v20 — user validation and manual playlist restart

The user confirmed phone and headphone playback after v19. Device/version and
full Safari/Home Screen acceptance details were not supplied. Automatic Bluetooth
icon switching on that phone remains unavailable: the Safari wireless-target API
exposes AirPlay, rather than a general Bluetooth output route.

Manual Next now starts a new playlist/queue pass at the end, independent of
Repeat. Shuffle produces another balanced pass; natural completion with Repeat
off still stops. The shared engine preserves playlist context for app, gesture,
lock-screen and headphone commands. Output detection now refreshes on startup,
playback, focus, visibility and device/sink changes, and can recognize a named
system default where the browser exposes it. Merely available headphones are
never treated as the active route; no new permissions are requested.

Verification: 75 automated tests passed, including manual restart after natural
completion, repeat/shuffle/single/empty queues, retained metadata/context, and
active output/default-sink icon refresh with unsupported-browser fallback.

## Shell v21 — Play after playlist completion

The user validated v20, then reported that lock-screen Play after the playlist
ends restarts the final song without audio. The shared Play handler had resumed
an ended source instead of restarting the queue. It now uses manual Next's
new-pass/source-load path when the active final source is ended, reloading the
first song at zero before playback. Shuffle, playlist context and Repeat settings
are preserved; ordinary paused-source resume is unchanged. This applies to
player, active-collection, lock-screen and headphone Play controls.

Verification: 78 automated checks passed. Three new regression tests cover all
Play entry points, single-song/shuffle passes, and synchronous lock-screen Play
startup. Two of these tests failed against v20 before the fix. The v21 Play
correction awaits user device confirmation.

## Shell v22 — Native audio-session recovery

The user reports that both lock-screen Play and Next now select the first song
but remain silent while progress advances in the installed Home Screen app.
Queue selection is working; the audible output failure remains a device issue.

Playback requests now select the Audio Session API's music playback category
where available. Hidden iOS startup cycles through ambient and restores playback
on the next task to recover the stale native category reported in
[WebKit 323104](https://bugs.webkit.org/show_bug.cgi?id=323104). That report matches
the symptom, but does not establish the cause on the user's phone. Unsupported
or throwing APIs fall back to normal HTML audio playback. External Play is
idempotent and also requests recovery when the element claims it is playing.

Source changes rely on src assignment's resource selection without a redundant
load call. Single-song restarts reuse the loaded source. The exact first song of
the next balanced shuffle pass is prepared and kept in the bounded media cache,
so a completed long playlist can restart synchronously within a native action.
Media Session playback and position updates wait for playing, with position
cleared while buffering. Settings and the installed-update toast identify v22.

Verification: all 85 automated checks passed, including seven added regressions
for reserved shuffle passes, simulated native category faults, repeated external
Play, Pause during recovery, unsupported APIs, delayed playing, long playlists
and source reuse. Simulated output is not physical sound verification. Retest
lock-screen Play and Next after natural playlist completion on v22; audible
playback in the installed iPhone app remains unconfirmed.

## Shell v23 — Preserve background music ownership

The user reports that v22 fades out during normal Home Screen/lock use (not
force-quitting), loses its lock-screen controls and leaves a blank Now Playing
module. iOS then offered to install/open Apple Music. Squidify contains no Apple
Music integration or App Store redirect; the OS fallback explanation remains an
inference without a native device trace.

Code investigation found three unsafe session paths: v22 temporarily selected
ambient for every hidden playback request and relied on a timer to restore
playback; it declared paused during startup/buffering; and a metadata refresh
during an uncached source load could clear the entire media session. Apple's
ambient audio category is silenced by screen lock. The related WebKit 323104
recovery report was not sufficient justification for applying that category
cycle to every background playback request.

v23 removes the cycle and its timer, keeps a stable playback category, preserves
declared playback intent through loading/buffering, and refreshes existing
metadata across visibility/page lifecycle changes without replaying or taking
focus back from a real interruption. Position still waits for valid current
source metadata and actual playing. Stale play-promise failures cannot override
a newer song. Cached playlist restarts and source reuse remain intact.

Settings > Playback help > View playback report provides the last 80 local
events with app/browser versions, visibility, transport and audio-session
states. It includes no song names, file URLs, track IDs or audio. Nothing is
transmitted automatically; Copy report explicitly copies it for user sharing.

Verification: four focused regressions failed on v22 before the correction;
all 88 checks now pass, including lifecycle, delayed-source handoffs, Play/Next
restart, stale promise handling, report privacy/bounds and offline asset access.
These establish code behavior, not physical iOS audibility. Device verification
of screen-lock playback and restart remains pending. Confirm Settings v23,
start a song, return Home and lock normally, then test track changes/completion.

References: [Apple ambient category](https://developer.apple.com/it/documentation/audiotoolbox/kaudiosessioncategory_ambientsound),
[Media Session declared state and routing](https://w3c.github.io/mediasession/#playback-state).

## Shell v24 — Prepared playlist restart after native completion

The user confirms that v23 restores audible lock-screen/background playback and
Next works when pressed before the final song ends. Restarting after completion
still stalls. The supplied 71-event report identifies the failure precisely:
at 18:02:45 UTC the final song ends; at 18:02:47 remote Play selects the first
song and calls play. Its metadata loads with readyState 1, but no playing event
follows, then stalled fires. After returning to the foreground at 18:02:51 the
player reaches readyState 4. There is no media error. The native audio-session
state property is unavailable in this browser, so no category fault is inferred.

Caching a Blob URL did not preload playable samples into a native player. On
iOS, v24 prepares the exact first song of the next pass in one inactive native
audio element with preload=auto while the current song runs. After an ended
source, Play/Next can activate this prepared player synchronously without a src
replacement, provided it already has future data. Ordinary pre-end skips keep
the working current-player path. Non-iOS playback is unchanged. If the browser
declines preloading, the ordinary load path remains available; preparation is
a browser hint and real iPhone readiness must be confirmed.

The UI and controls use a stable audio interface which forwards only the active
element's events. Old ended/pause/error events cannot affect the new track.
Volume, mute, rate, metadata/duration and position follow the activated player.
The pair is reused across passes, and standby audio never plays by itself.
There are no ambient category changes, silent keep-alive loops or background
timers needed for this handoff. Reports include restart readiness and the
restart-prepared/restart-source-load path to establish which branch ran.

Verification: 93 checks pass. A replay of the observed metadata-only background
load failure fails against v23 and passes with the prepared restart, covering
both Play and Next across repeated completions. Additional checks cover native
event isolation, preference transfer, unavailable preparation, cleanup and
offline module availability. User confirmation of v24 audibility is pending.

## v27 transport durability

Previous at the first queue entry reuses the current source and suppresses
near-identical seeks instead of repeatedly calling native play. Transport request
serials keep late promise failures from overriding newer Pause/Play commands;
late native play events cannot undo explicit Pause. Cached track changes still
start synchronously inside remote actions, preserving iOS background activation.

On iOS, ordinary loads, resumes and seeks back to zero now receive the same
clock-progress verification as completed-playlist restarts. Frozen playback gets
one source reload after 2.5 seconds; metadata-only buffering gets eight seconds.
Recovery preserves position and stops after one attempt. Pause, another source,
interruption, an active seek or an excessively delayed timer prevents obsolete
recovery. No audio-session category cycling or silent keep-alive is used.

Verification: 111 simulated checks, including rapid mixed commands and pending
play promises. Physical iPhone audibility remains a device acceptance check:
confirm Settings v27, rapidly alternate Previous/Next and Pause/Play while locked,
then stop pressing and verify audible playback with advancing time. Also verify
Pause remains paused and natural playlist-end restart still works.

## v28 playlist-pass history and lock-screen state

The seven-song reproduction exposed a definite queue boundary: `next()` discarded
the preceding pass and reset the index to zero. Keep up to ten previous passes,
with forward traversal restoring the exact already-heard shuffle order. New
explicit queue starts clear history; saved sessions preserve it, and deleted
songs are pruned from both directions. The preceding pass's final file is cached
so remote Previous can start synchronously across the boundary.

The incorrect native Play icon while sound advances is a distinct device symptom.
The paused standby element was unmuted during preload. Keep it muted until active,
transfer user preferences at handoff, and republish active playback state after
inactive loading events and active time updates. This is a targeted mitigation;
it does not prove which native element iOS chose for its lock-screen UI. Reports
now include anonymous history counts and standby mute/readiness state.

Verification: all 116 simulated tests pass, including seven-song shuffled runs
through multiple passes, backward/forward order, persisted history, bounded
history, native handoffs and state reconciliation without extra play calls.
Device acceptance remains open: start a fresh seven-song shuffle and immediately
lock the phone; check Pause is shown during playback. Skip seven times, verify
Pause again, then Previous (twice if more than three seconds have elapsed) should
return to the preceding pass's last song. Also confirm natural playlist-end
restart and explicit Pause remain functional. Capture the report if the native
icon is still incorrect; no automated test here observes the physical lock screen.

## v29 manual search drawer

Search starts collapsed on mobile and desktop. The magnifying-glass tab hangs
under the connection badge: tap to toggle, drag down to open, or drag up from
the tab/search field to close. List scrolling no longer changes search visibility.
The slash shortcut and playlist search button still open and focus the field;
Escape closes it, and hidden controls are inert. Closing preserves the query;
changing views clears it as before. Song action cells use clipping rather than
text ellipsis, avoiding a stray truncation dot beside their three-dot button.

Physical iPhone gesture and visual confirmation remains pending.

## v30 interaction and ambient motion

The collapsed search tab hides after downward list travel and returns on upward
travel; the open search drawer remains user-controlled. Full-screen horizontal
swipes no longer skip tracks. Mini-player swipes and downward dismissal remain.
Seek inputs and thumbs glow during pointer interaction and keyboard focus.
Song and playlist artwork breathes with staggered eight-second cycles; the
header squid closes its eyes once every eight seconds. Reduced motion disables
these ambient animations. The mini waveform has substantially higher sensitivity
and contrast and uses nearly its full icon height; the full waveform retains
its settings. Mini-player hairline matches the kicker purple.
Physical iPhone appearance and touch verification remains pending.

## v31 mini waveform revert

Restored the mini waveform's pre-v30 sensitivity, contrast, edge fade and height
response, including its settings preview. All other v30 changes remain intact.

## v32 search layering and player cleanup

Search and its tab retract beneath a separate header-chrome layer. Both share
the header's solid background and have no border. Removed the mini-player's
purple top hairline.

## Shell v33 — SQ-033 standard mixing

Settings > Playback > Standard mixing adds an opt-in Crossfade toggle, a 0–12
second duration slider/numeric field (default 4 seconds), and Linear, Equal power,
or Smooth S-curve fades. Preferences save locally. New and existing libraries
start with mixing off unless the user has explicitly saved it enabled.

`mixing.js` manages preferences, native-source gain routing and scheduled curves.
The existing queue remains authoritative, including shuffle, inserted next songs,
repeat-all and pass history. Repeat-one and identical adjacent sources do not
crossfade. Natural changes start a prepared incoming player at zero gain; only
successful startup advances the queue and adopts its already-running clock.
Gain envelopes use the audio clock, with 3.1 dB of mixing headroom. Native progress
events trigger the transition window; delayed events can shorten an overlap or
leave an ordinary handoff. This is not beat matching or sample-accurate sequencing.

Two native players are reused. Durations are capped at half of each adjacent
song (adjusted for playback rate), preventing three simultaneous songs. Manual
skips remain immediate, with a 15 ms incoming gain ramp when processing is active.
Pause, seek, new sources, processing interruption and preference changes cancel
the outgoing tail. Unsupported processing, unready media and rejected incoming
playback leave the existing native handoff available. A failed incoming player
is not reused for that fallback.

Turning mixing off, or setting duration to zero, closes its processing context
and restores fresh native elements at the current position without audio routing.
If the processing context is interrupted, playback pauses, the native path is
restored, and the user can press Play to continue without mixing. It never tries
to reclaim audio focus automatically. Explicit browser speaker/AirPlay selection
turns mixing off; the system-managed default/Bluetooth route remains eligible.

Verification: **128 automated checks passed**, including 13 new mixing checks
covering preferences, fade curves/headroom, bounded overlaps, queue/transport
races, failure handoffs, native-path restoration, and interruption handling.
The existing lock-screen, restart, import, storage and offline-shell regressions
pass. These use simulated audio; no physical iPhone or audible browser rendering
was available. Physical Safari/Home Screen checks remain required for locked
crossfades, headphone controls, output changes and long background sessions.
The optional non-overlapping fade-out/fade-in mode remains future work.
