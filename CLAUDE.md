# Squidify

Device-local music player and installable offline web app. Plain ES modules, no framework, no build step. Cloudflare serves `dist/` as static assets (no Worker script). Read README.md's Architecture section before changing module boundaries.

## Layout

- `dist/`: the app as served. This is source, not build output; edit it directly.
- `dist/sw.js`: offline shell. `SHELL` lists every cached asset; a new runtime file must be added there.
- `dist/_headers`: security headers and CSP for Cloudflare.
- `tests/*.test.mjs`: Node tests over the real module graph (`--experimental-vm-modules`), persistence replaced in memory.
- `tests/e2e/smoke.mjs`: Chromium against `wrangler dev`.
- `assets/`: source art, not served.

## Commands

- `npm test`
- `npm run test:e2e`
- `npm run dev`: http://localhost:8787

## Rules

- Any release that changes a cached asset bumps `VERSION` in `dist/sw.js`, and `release.js` stays in sync with it.
- New icon or image files get a new versioned name (`-v10`) rather than replacing old ones; installed Home Screen apps cache them.
- Never change the IndexedDB schema without a migration. Users' music exists only there.
- Production deploys happen from CI on merge to `main`. Use QA (Deploy workflow, `env: qa`) to try a new shell on a phone first.
- Physical iPhone behaviour (lock screen, background audio, Home Screen) cannot be verified here. Say what was simulated and what still needs the device.
