# Squidify

Squidify is a music player for audio files you already own. It runs in the browser, installs to a phone's Home Screen or a desktop as an app, and works offline. Imported music is copied into the browser's storage on the device and played from there. Nothing is uploaded, there is no account, and the server only hands out the app's own static files.

The app is plain HTML, CSS and ES modules: no framework, no build step, no runtime dependencies, no CDN, no telemetry. Cloudflare serves the `dist/` folder as static assets.

## What it does

**Library.** Import a folder (subfolders included) or a selection of audio files. Squidify reads title, artist, album and artwork from MP3 (ID3), FLAC and M4A tags, falls back to the filename, and skips duplicates. Browse songs, albums, liked songs and playlists, with search and sorting. Song details can be edited; edits change Squidify's catalog only, never the original file. Albums and playlists get generated gradient covers or a photo you choose. Where the browser can remember folder access (Chrome and Edge), a folder can be rescanned for new files.

**Playback.** A queue with play next, reorder, jump and save as playlist. Shuffle plays every song once per pass and spaces out repeated artists and albums; Previous walks back through the passes you heard. Repeat the queue or one song. The last session is restored, paused. Lock screen, Control Center and headphone buttons work through Media Session. Crossfade is optional (off by default, 0 to 12 seconds, linear, equal-power or S-curve). An output picker appears where the browser offers one: speaker selection in Chrome and Edge, AirPlay in Safari. A spectrum visualizer runs in the mini and full player, with twelve tuning controls in Settings.

**Playlists.** Create, rename, reorder by dragging, and export as M3U. **Mix studio** opens a playlist as a timeline: trim each song, set how far neighbours overlap, change speed, and adjust per-song volume, bass, treble, stereo position, reverb, echo and distortion, with waveforms, transition preview and undo. The mix is saved with the playlist and plays inside the studio; normal playback plays the songs unedited.

**YouTube import.** With a self-hosted converter (see [YouTube converter](#youtube-converter)), paste a video or playlist link in Settings. A playlist is listed first, then converted one video at a time into a new Squidify playlist of the same name. Progress is saved after each video, so an interrupted playlist resumes where it stopped.

**Downloads.** Save a song or a playlist back out as audio files named "Artist - Title". Chrome and Edge on a computer save into a folder you pick (a playlist gets its own subfolder, existing files are never overwritten). Phones use the share sheet, where Save to Files stores them. Other browsers use ordinary downloads. Nothing is saved unless you ask.

**Controls.** Touch: swipe up on the mini player to expand it and down to close it, swipe the mini player sideways to skip, swipe a song right to queue it, hold a song or playlist for its options. Keyboard: Space plays and pauses, `/` opens search, the arrow keys seek 5 seconds, Shift+arrow skips, Escape closes. Right-click or Shift+F10 opens options.

**Playback report.** Settings › Playback help › View playback report lists the last 80 playback events with app, browser and audio-session state, for diagnosing problems on a phone. It contains no song names, file paths or audio, and leaves the device only if you copy it.

**Agent tools.** Where the browser exposes `document.modelContext` (WebMCP), Squidify registers two tools for an in-browser assistant: read the library's metadata and create a playlist. Neither reads audio.

## Installing and updating

Open the deployed HTTPS address while online and install it: Share › Add to Home Screen in Safari on iPhone, or Install app in Chrome or Edge. Import music from inside the installed app, because on some platforms an installed app keeps storage separate from the browser. Settings shows **App available offline** once every app file is cached; try an offline launch before relying on it. Offline install needs HTTPS (or localhost); opening `index.html` from disk won't work.

Updates download in the background and take effect only after every Squidify window is closed, so a new version never interrupts playback or an open file picker. To update, open Squidify while online, close all its windows and reopen it. A notice confirms the new version.

## Where your music lives

Imported audio, artwork, playlists and settings live in IndexedDB for this site, in this browser profile. That means:

- It is not a backup or a sync. Keep your original files.
- Clearing site data, uninstalling the app, or the browser reclaiming space deletes the library. Squidify requests persistent storage, which the browser may refuse; Settings shows usage and whether persistence was granted.
- Each origin has its own library. Production, QA and any future domain each start empty.
- Large libraries are safer imported in batches while watching free space.

Duplicate detection hashes the file size plus the first and last 64 KiB, so large files are never read whole into memory. Two files with the same size and the same first and last 64 KiB count as the same song.

## Limits

The browser's codecs decide what plays. Squidify accepts `.mp3`, `.m4a`, `.aac`, `.flac`, `.wav`, `.ogg` and `.opus`, but a file the browser can't decode won't play. DRM-protected or streaming-service downloads won't play. Playback is not sample-accurate gapless.

Background playback, auto-advance while locked and lock-screen controls depend on iOS and the browser. The code works around known iOS behaviour (see [iOS playback rules](#ios-playback-rules)), but automated tests simulate the audio element. Any change in this area needs checking on a physical iPhone, in Safari and in the Home Screen app, with the screen locked and with headphones.

## YouTube converter

The converter is a separate service you run yourself; it is not in this repository. Settings takes its HTTPS address and an access key (32 to 256 letters, digits, `-` or `_`), sent as a Bearer token. The service must allow the Squidify origin in its CORS settings.

| Request | Purpose |
| --- | --- |
| `GET /api/health` | Must return `service: "squidify-converter"`, `api_version: 1`, `ready: true` |
| `POST /api/playlist` `{url}` | Playlist title and entries (`id`, `title`); the first 500 are used |
| `POST /api/convert` `{url, format: "original"}` | Starts a job, returns `job_id` |
| `GET /api/jobs/{id}` | Job status. `DELETE` cancels; `POST /api/jobs/{id}/complete` after download |
| `GET /api/download/{id}` | The audio: `audio/mpeg`, or `audio/mp4` with YouTube's original AAC, up to 50 MiB |

A converter without `/api/playlist` (404 or 405) still converts single videos. YouTube Mix links (`list=RD…`) never end, so only the video in them is converted. Conversion runs in the page, so on an iPhone it pauses while Squidify is in the background.

## Architecture

`app.js` is the entry point. It creates a shared context, builds each subsystem from a factory with an explicit API, merges their actions into one delegated event handler, then restores the library and the paused session. Subsystems reach each other through the context at call time, so there are no cyclic imports. Each module owns its timers, listeners and caches.

| Module | Responsibility |
| --- | --- |
| `app.js` | Composition and startup; registers the agent tools |
| `context.js` | Shared state, DOM references, lookup helpers, the queue and audio output |
| `interface.js` | Views, routing, dialogs, delegated UI events, keyboard shortcuts |
| `motion.js`, `gestures.js`, `drag-order.js` | View entrances and player sheet motion; swipe and hold gestures; drag to reorder |
| `icons.js`, `cover-art.js`, `cover-editor.js` | Vendored Lucide icons; generated covers; the cover and photo editor |
| `enhancements.js`, `spectrum.js` | Settings panel, visualizer, output picker, import results; FFT over decoded audio |
| `import.js`, `metadata.js` | File and folder import, rescans, deduplication, duration probes; tag and artwork parsing |
| `storage.js` | IndexedDB schema and transactions |
| `core.js` | `PlayQueue` (queue, shuffle passes, history) and formatting helpers |
| `playlists.js` | Playlists, liked songs, reordering, M3U export |
| `downloads.js` | Saving songs and playlists as files |
| `converter.js`, `converter-client.js` | YouTube import UI and batch state; converter HTTP client and response checks |
| `playback.js` | Audio lifecycle, transport, Media Session, session saving, iOS recovery |
| `audio-output.js` | Wraps the active and standby audio elements behind one stable interface |
| `mixing.js` | Crossfade preferences, Web Audio gain routing and fade curves |
| `playback-report.js` | The bounded local event log |
| `mix-editor.js`, `mix-model.js`, `mix-audio.js` | Mix studio UI; timeline model; Web Audio preview engine |
| `offline.js`, `release.js` | Service worker registration, offline readiness, update notices; the shell version |
| `sw.js` | The offline shell |

### Storage

One IndexedDB database, `squidify-local-v1`, at version 1, with five object stores keyed by `id`:

| Store | Holds |
| --- | --- |
| `tracks` | Song metadata and artwork |
| `media` | The audio blob for each track, under the same id |
| `playlists` | Name, `trackIds`, cover settings and the optional Mix studio `mix` |
| `folders` | Remembered folder handles for rescans |
| `settings` | Key/value preferences, the saved session, converter state |

A track and its audio are written in one transaction, and deleting a track removes it from every playlist in the same transaction. This database is the only copy of a user's imported music, so any schema change needs a migration.

### Offline shell

`sw.js` caches every file in `SHELL` under a cache named by `VERSION`. Installation fetches all of them and fails rather than activate a partial shell, or one where a sign-in page came back in place of a script. Once installed, navigations to `/` and `/index.html` answer from the cache, online or not. Only same-origin shell files are intercepted; audio never passes through the worker. A new worker waits for open windows to close instead of claiming them. `release.js` repeats the version so the page can announce an installed update.

### Audio

Songs play through a native `<audio>` element from object URLs over the stored blobs. `audio-output.js` pairs it with a standby element that preloads either the first song of the next pass (so a finished playlist can restart from the lock screen) or the incoming song of a crossfade. Only the active element's events reach the UI. Web Audio is used only while crossfade is on and inside Mix studio; otherwise playback never goes through an `AudioContext`. The visualizer decodes the file separately and runs its own FFT, so it never touches the playback path; files over 40 MB or 15 minutes show a flat baseline.

### iOS playback rules

These come from device reports on earlier shells (see [CHANGELOG.md](CHANGELOG.md), v19 to v28) and are easy to regress:

- Start playback synchronously inside lock-screen and headphone handlers. Keep the neighbouring songs' sources cached so that is possible; an awaited load loses background activation.
- Don't switch the audio session category to recover sound. The ambient category is silenced by screen lock.
- Keep Media Session metadata and the declared playing state through loading and buffering. Clearing them mid-load blanks the lock screen.
- Restarting a finished playlist from the lock screen needs the first song already preloaded in the standby element. A fresh load in the background stalls after metadata.
- Keep the standby element muted until it becomes active.
- No silent keep-alive audio and no background timers. A stuck playback gets one reload (after 2.5 seconds, or 8 seconds while only metadata has loaded) and no more.

## Development

```bash
npm install
```

```bash
npm run dev
```

`npm run dev` serves the app with `wrangler dev` at http://localhost:8787. `dist/` is the source; edit it directly.

```bash
npm test
```

```bash
npm run test:e2e
```

`npm test` runs the Node tests in `tests/`, which load the real module graph through `--experimental-vm-modules` with persistence swapped for an in-memory store. They cover playback and queue behaviour, the iOS recovery paths against a simulated audio element, import and storage workflows, mixing, the converter client, downloads, gestures and the offline shell. `npm run test:e2e` drives Chromium against `wrangler dev`: offline install, import, playback, offline relaunch, and no Content Security Policy violations. It needs Playwright's Chromium (`npx playwright install chromium`) the first time.

`dist/_headers` sets the security headers and CSP. `connect-src` allows any HTTPS origin because the converter address is user-configured. Anything that loads from a new kind of source (a worker, a `data:` font, a remote image) needs its directive added there, or it fails silently on the phone.

Visual rules (type, colour, motion, controls) are in [DESIGN-SYSTEM.md](DESIGN-SYSTEM.md). Source art is in `assets/` and is not served.

## Releasing and deploying

Every release that changes a cached file bumps `VERSION` in `dist/sw.js`, keeps `SHELL_VERSION` in `dist/release.js` the same, and adds any new runtime file to `SHELL`. New icons and images get a new versioned filename (`icon-192-v10.png`) instead of replacing the old one, because installed Home Screen apps keep the old file cached.

GitHub Actions runs both test suites on every pull request. A push to `main` runs them again and deploys to `https://squidify.<subdomain>.workers.dev`. Running the Deploy workflow with `env: qa` deploys the same commit to `squidify-qa`, a separate origin with its own offline shell and library, for trying a new shell on a phone without touching the installed app.

First-time setup: create a Cloudflare API token from the "Edit Cloudflare Workers" template, limited to the account, and add `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as GitHub Actions secrets. Until both exist, Deploy runs the tests and skips the deploy with a warning.

Don't put Cloudflare Access or any other sign-in in front of the site. An iOS Home Screen app can't finish a sign-in on another domain, and the service worker rejects a sign-in page served in place of a script. There is nothing private on the server to protect.
