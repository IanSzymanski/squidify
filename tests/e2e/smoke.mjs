// Chromium against `wrangler dev`: offline shell installs, the Cloudflare headers block nothing, a local file imports and plays, the app relaunches offline.
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

const PORT = 8799, BASE = `http://localhost:${PORT}/`, OUT = 'test-results/e2e';
mkdirSync(OUT, { recursive: true });

function toneWav(seconds = 3, rate = 22050) {
  const n = seconds * rate, buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin(i / rate * 2 * Math.PI * 440) * 8000), 44 + i * 2);
  return buf;
}

async function waitForServer(timeout = 60000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try { if ((await fetch(BASE)).ok) return; } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('wrangler dev did not start');
}

const server = spawn('npx', ['wrangler', 'dev', '--port', String(PORT)], { stdio: ['ignore', 'ignore', 'inherit'], detached: true });
const failures = [];
const check = (ok, label) => { console.log(`${ok ? 'ok    ' : 'FAIL  '} ${label}`); if (!ok) failures.push(label); };
let browser;
try {
  await waitForServer();

  const root = await fetch(BASE);
  check(/default-src 'self'/.test(root.headers.get('content-security-policy') || ''), 'CSP header on /');
  check(root.headers.get('x-content-type-options') === 'nosniff', 'nosniff header on /');
  check((await fetch(BASE + '_headers')).status === 404, '_headers is not served');

  browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const context = await browser.newContext();
  const page = await context.newPage();
  const problems = [];
  page.on('console', m => { if (m.type() === 'error' || /Content Security Policy|Refused/.test(m.text())) problems.push(m.text()); });
  page.on('pageerror', e => problems.push(e.message));

  await page.goto(BASE);
  await page.waitForFunction(() => /Offline ready/i.test(document.querySelector('#offlineBadge')?.textContent || ''), null, { timeout: 30000 }).catch(() => {});
  check(/Offline ready/i.test(await page.textContent('#offlineBadge')), 'offline shell installed');

  const file = join(mkdtempSync(join(tmpdir(), 'squidify-')), 'Test Tone.wav');
  writeFileSync(file, toneWav());
  await page.setInputFiles('#fileInput', file);
  await page.waitForSelector('[data-action="play-track"]', { timeout: 20000 });
  await page.locator('[data-action="play-track"]').first().click();
  await page.waitForTimeout(2000);
  const playing = await page.evaluate(() => [...document.querySelectorAll('audio')].some(a => !a.paused && a.currentTime > 0.5 && a.currentSrc.startsWith('blob:')));
  check(playing, 'imported file plays from a blob URL');

  await page.locator('.settings-button').first().click();
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}/settings.png` });

  await context.setOffline(true);
  await page.reload();
  await page.waitForTimeout(1500);
  check(await page.evaluate(() => !!document.getElementById('audio')), 'app relaunches offline');
  await page.screenshot({ path: `${OUT}/offline.png` });

  check(problems.length === 0, `no console errors or CSP violations${problems.length ? ': ' + problems.join(' | ') : ''}`);
} catch (error) {
  failures.push(error.message);
  console.error(error);
} finally {
  await browser?.close();
  try { process.kill(-server.pid); } catch {}
}
process.exit(failures.length ? 1 : 0);
