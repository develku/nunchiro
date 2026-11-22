// perf-baseline: composer keystroke-to-paint, driven by composer.py (job JSON in argv[2]).
// ms = first keydown to the animation frame after the input event (the frame that shows the character).
// With job.profile and Chromium, a CDP CPU profile of the typing is reduced to the top self-time functions.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const job = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const web = path.resolve(import.meta.dirname, '../../web');
const { webkit, chromium } = createRequire(path.join(web, 'package.json'))('@playwright/test');
const launch = job.engine === 'webkit'
  ? () => webkit.launch()
  : () => chromium.launch({ headless: false, args: ['--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-background-timer-throttling'] });

const browser = await launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const page = await context.newPage();
await page.addInitScript((b) => { window.__NUNCHIRO__ = b; }, { port: job.port, token: job.token });
await page.goto(job.url);
await page.getByRole('status').filter({ hasText: /connected/i }).first().waitFor({ timeout: 30000 });
if (job.open) await page.locator(job.open).click(); // interact.py: a chat session's tree row (its first tab is a shell)
const box = page.locator('textarea#composer');
await box.waitFor({ timeout: 30000 });
await box.click();
await page.evaluate(() => {
  const w = window;
  w.__k = { t: null, done: () => {}, p: null };
  // keydown starts the clock; an IME-style insertText has none, so its beforeinput does
  for (const ev of ['keydown', 'beforeinput']) addEventListener(ev, () => { if (w.__k.t === null) w.__k.t = performance.now(); }, true);
  addEventListener('input', () => {
    const t0 = w.__k.t;
    requestAnimationFrame(() => { w.__k.done({ t0, ms: performance.now() - t0 }); });
  }, true);
});

let cdp = null;
if (job.profile && job.engine === 'chromium') {
  cdp = await context.newCDPSession(page);
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
  await cdp.send('Profiler.start');
}

const keys = [...job.keys];
const ms = [];
for (let i = 0; i < job.n; i++) {
  const k = keys[i % keys.length];
  await page.evaluate(() => { window.__k.t = null; window.__k.p = new Promise((res) => { window.__k.done = res; setTimeout(() => res(null), 2000); }); });
  if (/^[\x20-\x7e]$/.test(k)) await page.keyboard.press(k); else await page.keyboard.insertText(k);
  const r = await page.evaluate(() => window.__k.p);
  ms.push(r && r.t0 !== null ? r.ms : 2000);
  if (i % 40 === 39) { await page.keyboard.press('Meta+a'); await page.keyboard.press('Backspace'); }
  await page.waitForTimeout(50);
}

let top = null;
if (cdp) {
  const { profile } = await cdp.send('Profiler.stop');
  const self = new Map();
  const dt = profile.timeDeltas;
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  profile.samples.forEach((id, i) => {
    const f = byId.get(id).callFrame;
    const key = `${f.functionName || '(anon)'} ${f.url.split('/').slice(-2).join('/')}:${f.lineNumber + 1}`;
    self.set(key, (self.get(key) ?? 0) + dt[i] / 1000);
  });
  top = [...self].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([k, v]) => [k, Math.round(v)]);
}
await browser.close();
fs.writeFileSync(job.out, JSON.stringify({ ms, top }));
