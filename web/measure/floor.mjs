// V2.5-18 round 2: the echo key loop against a bare page in the same Playwright WebKit, to split the harness/engine frame
// floor from our app. ms = first keydown/input -> the frame after the echo is in the page, as paint.spec.ts measures it.
// Usage: node web/measure/floor.mjs [--repeats 5] [--n 100]   (from web/, after pnpm install). Prints JSON.
import { webkit } from '@playwright/test';
import fs from 'node:fs';

const arg = (k, d) => (process.argv.includes(k) ? +process.argv[process.argv.indexOf(k) + 1] : d);
const REPEATS = arg('--repeats', 5), N = arg('--n', 100), GAP = 50;
const KEYS = [...'QXZJKV눈치로한글입력확인QXZJKV가나다똠방각하읽었어요'];
const xterm = fs.readFileSync(new URL('../node_modules/@xterm/xterm/lib/xterm.js', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../node_modules/@xterm/xterm/css/xterm.css', import.meta.url), 'utf8');
const pct = (a, p) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.ceil((p / 100) * a.length) - 1)];

const xtermPage = (echo) => `<style>${css}</style><div id=t style="width:800px;height:300px"></div>
<script>${xterm}</script><script>
const term = new Terminal({ fontSize: 14, lineHeight: 1.2, fontFamily: 'monospace', scrollback: 2000 });
term.open(document.getElementById('t'));
term.onData((d) => (${echo}));
</script>`;
const PAGES = {
  contenteditable: `<div id=t contenteditable style="font:14px monospace;height:200px;white-space:pre"></div>`,
  xterm: xtermPage('term.write(d)'), // local echo: no core, no socket
  'xterm-async': xtermPage('setTimeout(() => term.write(d), 2)'), // the echo comes back in a later task, as a socket frame does
};

async function run(browser, name) {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })).newPage();
  await page.setContent(`<!doctype html><body>${PAGES[name]}`);
  const sel = name.startsWith('xterm') ? '#t .xterm-rows' : '#t';
  await page.evaluate(() => {
    window.__t = null;
    const first = () => (window.__t ??= performance.now());
    addEventListener('keydown', first, true);
    addEventListener('input', first, true);
  });
  await (name.startsWith('xterm') ? page.locator('#t .xterm-helper-textarea') : page.locator('#t')).focus();
  const out = [];
  for (let i = 0; i < N; i++) {
    const k = KEYS[i % KEYS.length];
    await page.evaluate(([sel, k]) => {
      const el = document.querySelector(sel), count = () => el.textContent.split(k).length - 1, c0 = count();
      window.__t = null;
      window.__p = new Promise((res) => {
        const mo = new MutationObserver(() => {
          if (count() <= c0) return;
          mo.disconnect();
          const tm = performance.now();
          requestAnimationFrame(() => res({ t0: window.__t, tm, tf: performance.now() }));
        });
        mo.observe(el, { childList: true, subtree: true, characterData: true });
        setTimeout(() => (mo.disconnect(), res(null)), 2000);
      });
    }, [sel, k]);
    if (/^[\x20-\x7e]$/.test(k)) await page.keyboard.press(k); else await page.keyboard.insertText(k);
    const r = await page.evaluate(() => window.__p);
    if (r && r.t0 !== null) out.push({ ms: r.tf - r.t0, dom: r.tm - r.t0 });
    await page.waitForTimeout(GAP);
  }
  await page.context().close();
  return out;
}

const browser = await webkit.launch();
const res = {};
for (const name of Object.keys(PAGES)) {
  const reps = [];
  for (let r = 0; r < REPEATS; r++) reps.push(await run(browser, name));
  const all = reps.flat();
  res[name] = {
    n: all.length, p50: +pct(all.map((x) => x.ms), 50).toFixed(1), p95: +pct(all.map((x) => x.ms), 95).toFixed(1),
    dom_p50: +pct(all.map((x) => x.dom), 50).toFixed(1), dom_p95: +pct(all.map((x) => x.dom), 95).toFixed(1),
    p95_per_repeat: reps.map((x) => +pct(x.map((y) => y.ms), 95).toFixed(1)),
  };
}
await browser.close();
console.log(JSON.stringify({ webkit: browser.version?.() ?? '', repeats: REPEATS, n: N, ...res }, null, 1));
