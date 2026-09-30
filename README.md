# Squidify

A device-local music player and installable offline web app. No remote music service, runtime CDN, telemetry, audio upload, or third-party runtime dependency.

## Use

1. Open the deployed HTTPS URL in a normal browser while online.
2. Install using Add to Home Screen (Safari on iPhone) or Install app (Chrome/Edge).
3. Open the installed app and import a folder or multiple audio files.
4. In Offline & settings, wait for **App available offline**. Test an offline reopen before relying on it.

Importing creates an offline copy in IndexedDB. Folder handles are remembered where `showDirectoryPicker` and structured cloning of handles are supported. Other browsers use folder/file inputs. Cloud-only files must be downloaded before an offline import. Original files are never modified.

The shell is cached by a service worker. A secure origin (HTTPS, or localhost for development) is required; opening index.html through file:// does not install an offline app. Every runtime asset is packaged locally. Files are played through object URLs on one persistent HTML audio element; Media Session provides supported Lock Screen/headphone actions.

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

Settings includes a live full-size and mini preview with eleven controls: zone
count, peak contrast, sensitivity, peak width, edge fade, attack/release speeds,
height, glow, fill and line thickness. Adjustments apply immediately to both
players, save to the device's existing settings store, and can be reset together.
The default 30% edge fade tapers each end of the active span into the protected
stationary baseline using a smooth envelope. Neighboring zones join directly
without manufactured boundary dips.

The preview uses the playing track's decoded spectrum when available, otherwise
a labeled demo signal. Demo values never enter the actual player. Pause preview
freezes its signal while still allowing shape adjustments. Reduced-motion mode
uses a static preview and does not run an animation loop. The visualization does
not change audio output. Saved values are bounded on load; no library migration
is needed.

## Limits

Browser codecs determine which audio files play. DRM/subscription downloads are not supported. Background playback, automatic next track while locked, and media controls remain subject to browser/OS behavior and have not been verified on a physical iPhone. Audio is not gapless and there is no crossfade.

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
