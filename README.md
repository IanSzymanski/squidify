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

## Limits

Browser codecs determine which audio files play. DRM/subscription downloads are not supported. Background playback, automatic next track while locked, and media controls remain subject to browser/OS behavior and have not been verified on a physical iPhone. Audio is not gapless and there is no crossfade.

Storage is local to this origin, browser profile, and sometimes installed-app container. It is not a backup or cross-device sync. Keep original files. Clearing site data or uninstalling can remove all music and playlists; a browser can reclaim nonpersistent storage. Persistence requests may be declined by the browser.

For large libraries, import in smaller batches and watch available storage. Duplicate detection hashes file size plus the first/last 64 KiB, not every byte; it avoids loading entire large audio files into memory.

## Source and verification

Static assets live in `dist`. Source is deployed from the Sites Git repository. Run `npm test` for pure playback/metadata, offline-shell and storage workflow tests. No build step or runtime dependencies are required.

For any release that changes cached assets, update `VERSION` in `dist/sw.js`. The worker activates only after every shell asset has been cached. Database schema is versioned independently.
