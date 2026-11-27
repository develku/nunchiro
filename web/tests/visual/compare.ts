// The visual gate's comparison: crops a mockup element and an app element at the same viewport and scale and counts
// differing pixels (pixelmatch's rules, run in the page), plus the seeds the specs share. Used by visual-conformance.spec.ts,
// fidelity-tree.spec.ts and fidelity-menus.spec.ts; it lives outside a spec file because Playwright cannot import one spec
// into another. How to add a component: README.md.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';
import { openWindow, type Core } from '../fixtures';
import { seed } from '../tree-seed';
import { mockup as mockupPath } from './mockups';

// A spec may point the crops elsewhere (NUNCHIRO_VISUAL_OUT, read per call) for its own side-by-side page.
/** Points this worker's crops at `.scratch/<dir>` (same as setting NUNCHIRO_VISUAL_OUT). */
export const outDir = (dir: string) => void (process.env.NUNCHIRO_VISUAL_OUT = path.resolve(import.meta.dirname, '../../../.scratch', dir));
const OUT = () => process.env.NUNCHIRO_VISUAL_OUT ?? path.resolve(import.meta.dirname, '../../../.scratch/fidelity-tokens/visual');
export const MAX_DIFF_RATIO = 0.02;
export const THRESHOLD = 0.1;

/** pixelmatch's per-pixel test, run in the page on two RGBA buffers of equal width and height. */
function diffInPage({ a, b, threshold }: { a: string; b: string; threshold: number }) {
  const load = (src: string) =>
    new Promise<ImageData>((ok, no) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        [c.width, c.height] = [img.width, img.height];
        const x = c.getContext('2d')!;
        x.drawImage(img, 0, 0);
        ok(x.getImageData(0, 0, img.width, img.height));
      };
      img.onerror = no;
      img.src = src;
    });
  return Promise.all([load(a), load(b)]).then(([A, B]) => {
    const w = Math.min(A.width, B.width);
    const h = Math.min(A.height, B.height);
    const crop = (d: ImageData) => {
      const o = new Uint8ClampedArray(w * h * 4);
      for (let y = 0; y < h; y++) o.set(d.data.subarray(y * d.width * 4, y * d.width * 4 + w * 4), y * w * 4);
      return o;
    };
    const [p, q] = [crop(A), crop(B)];
    const blend = (c: number, a: number) => 255 + (c - 255) * a;
    const Y = (r: number, g: number, b: number) => r * 0.29889531 + g * 0.58662247 + b * 0.11448223;
    const I = (r: number, g: number, b: number) => r * 0.59597799 - g * 0.2741761 - b * 0.32180189;
    const Q = (r: number, g: number, b: number) => r * 0.21147017 - g * 0.52261711 + b * 0.31114694;
    const delta = (s: Uint8ClampedArray, t: Uint8ClampedArray, k: number, m: number, yOnly: boolean) => {
      const a1 = s[k + 3] / 255;
      const a2 = t[m + 3] / 255;
      const [r1, g1, b1] = [blend(s[k], a1), blend(s[k + 1], a1), blend(s[k + 2], a1)];
      const [r2, g2, b2] = [blend(t[m], a2), blend(t[m + 1], a2), blend(t[m + 2], a2)];
      const y1 = Y(r1, g1, b1);
      const y2 = Y(r2, g2, b2);
      const y = y1 - y2;
      if (yOnly) return y;
      const i = I(r1, g1, b1) - I(r2, g2, b2);
      const qq = Q(r1, g1, b1) - Q(r2, g2, b2);
      const d = 0.5053 * y * y + 0.299 * i * i + 0.1957 * qq * qq;
      return y1 > y2 ? -d : d;
    };
    const siblings = (s: Uint8ClampedArray, x1: number, y1: number) => {
      const [x0, y0, x2, y2] = [Math.max(x1 - 1, 0), Math.max(y1 - 1, 0), Math.min(x1 + 1, w - 1), Math.min(y1 + 1, h - 1)];
      const pos = (y1 * w + x1) * 4;
      let zeroes = x1 === x0 || x1 === x2 || y1 === y0 || y1 === y2 ? 1 : 0;
      for (let x = x0; x <= x2; x++)
        for (let y = y0; y <= y2; y++) {
          if (x === x1 && y === y1) continue;
          const p2 = (y * w + x) * 4;
          if (s[pos] === s[p2] && s[pos + 1] === s[p2 + 1] && s[pos + 2] === s[p2 + 2] && s[pos + 3] === s[p2 + 3]) zeroes++;
          if (zeroes > 2) return true;
        }
      return false;
    };
    const antialiased = (s: Uint8ClampedArray, x1: number, y1: number, t: Uint8ClampedArray) => {
      const [x0, y0, x2, y2] = [Math.max(x1 - 1, 0), Math.max(y1 - 1, 0), Math.min(x1 + 1, w - 1), Math.min(y1 + 1, h - 1)];
      const pos = (y1 * w + x1) * 4;
      let zeroes = x1 === x0 || x1 === x2 || y1 === y0 || y1 === y2 ? 1 : 0;
      let [min, max, minX, minY, maxX, maxY] = [0, 0, 0, 0, 0, 0];
      for (let x = x0; x <= x2; x++)
        for (let y = y0; y <= y2; y++) {
          if (x === x1 && y === y1) continue;
          const d = delta(s, s, pos, (y * w + x) * 4, true);
          if (d === 0) {
            if (++zeroes > 2) return false;
          } else if (d < min) [min, minX, minY] = [d, x, y];
          else if (d > max) [max, maxX, maxY] = [d, x, y];
        }
      if (min === 0 || max === 0) return false;
      return (siblings(s, minX, minY) && siblings(t, minX, minY)) || (siblings(s, maxX, maxY) && siblings(t, maxX, maxY));
    };
    const maxDelta = 35215 * threshold * threshold;
    let diff = 0;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const k = (y * w + x) * 4;
        if (Math.abs(delta(p, q, k, k, false)) > maxDelta && !antialiased(p, x, y, q) && !antialiased(q, x, y, p)) diff++;
      }
    const total = Math.max(A.width, B.width) * Math.max(A.height, B.height);
    return { diff: diff + total - w * h, total, sizes: [A.width, A.height, B.width, B.height] };
  });
}

/** Crops a mockup element and an app element at the page's viewport and scale; returns the share of differing pixels. */
export async function measureMockup(page: Page, mockup: string, mockupSelector: string, appLocator: Locator, opts: { name: string; prepare?: (m: Page) => Promise<void> }) {
  const m = await page.context().newPage();
  await m.setViewportSize(page.viewportSize()!);
  const scheme = await page.evaluate(() => (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  await m.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
  await m.goto(`file://${mockupPath(mockup)}`);
  await opts.prepare?.(m);
  const width = (await appLocator.boundingBox())!.width;
  await m.locator(mockupSelector).first().evaluate((e, w) => {
    const el = e as HTMLElement;
    el.style.boxSizing = 'border-box';
    el.style.width = `${w}px`;
    el.style.maxWidth = 'none';
  }, width);
  const mock = await m.locator(mockupSelector).first().screenshot({ animations: 'disabled' });
  await m.close();
  const app = await appLocator.screenshot({ animations: 'disabled' });
  const url = (b: Buffer) => `data:image/png;base64,${b.toString('base64')}`;
  const r = await page.evaluate(diffInPage, { a: url(mock), b: url(app), threshold: THRESHOLD });
  const ratio = r.diff / r.total;
  const out = OUT();
  fs.mkdirSync(out, { recursive: true });
  const tag = `${opts.name}-${scheme}`;
  fs.writeFileSync(path.join(out, `${tag}-mock.png`), mock);
  fs.writeFileSync(path.join(out, `${tag}-app.png`), app);
  fs.writeFileSync(path.join(out, `${tag}.json`), JSON.stringify({ name: opts.name, scheme, mockup, mockupSelector, ratio, sizes: r.sizes }));
  return ratio;
}

/** The gate: the app's component differs from the mockup's in at most 2% of its pixels. */
export async function expectMatchesMockup(page: Page, mockup: string, mockupSelector: string, appLocator: Locator, opts: { name: string; prepare?: (m: Page) => Promise<void> }) {
  let ratio = await measureMockup(page, mockup, mockupSelector, appLocator, opts);
  // One more look after a pause: a frame caught mid-change (seen once in a nightly, 4.98%, gone on the rerun) is not a look that differs.
  if (ratio > MAX_DIFF_RATIO) ratio = await page.waitForTimeout(500).then(() => measureMockup(page, mockup, mockupSelector, appLocator, opts));
  expect(ratio, `${opts.name}: ${(ratio * 100).toFixed(2)}% of pixels differ from ${mockup} ${mockupSelector}`).toBeLessThanOrEqual(MAX_DIFF_RATIO);
}

// ---- seed: the mockup's text. Session states come from a proxied snapshot (the core cannot make a session wait on demand).
/** Ticket 1041 lane 1 (owner 15.1 item 7): the A+B+C rows are 32 px by default; the ko/ mockups these specs compare with
 *  draw 30. A spec that crops a tree row against them keeps the old size, as a user who picked it does (a store at
 *  version 3 with a typed 30, which draws the old comfortable 30 / 24 / 32 exactly). The tree lane of 1041 moves the
 *  comparison to docs/design/polish-1121 and drops this. */
export const koRows = (app: Page) =>
  app.addInitScript(() => {
    const k = 'nunchiro.settings.v1';
    localStorage.setItem(k, JSON.stringify({ ...JSON.parse(localStorage.getItem(k) ?? '{}'), version: 3, density: 'comfortable', densityPicked: true, rowHeight: 30 }));
  });

export type Patch = { waiting?: 'permission' | 'question'; text?: string; failed?: boolean; working?: boolean };
export async function patchSnapshots(app: Page, patches: Record<string, Patch>) {
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((msg) => server.send(msg));
    server.onMessage((raw) => {
      if (typeof raw !== 'string' || JSON.parse(raw).event !== 'snapshot') return ws.send(raw);
      const msg = JSON.parse(raw);
      for (const s of msg.sessions ?? []) {
        const p = patches[s.label];
        if (p?.working) Object.assign(s.attention, { working: true, stale: false, failed: false, waiting: false });
        if (p?.failed) Object.assign(s.attention, { working: false, stale: false, failed: true, waiting: false });
        if (!p?.waiting) continue;
        Object.assign(s.attention, { working: false, stale: false, failed: false, waiting: true, last_activity: Date.now() - 600_000 });
        s.pending = [{ id: `d-${s.label}`, session_id: s.id, scope: s.project, kind: p.waiting, text: p.text ?? `Run ${s.label}?`, choices: [], observed_at: Date.now() - 120_000, actionable: true, risky: false }];
      }
      ws.send(JSON.stringify(msg));
    });
  });
}
export const repo = (core: Core, name: string) => {
  const p = core.project(name);
  const git = (...a: string[]) => execFileSync('git', ['-C', p, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a]);
  git('init', '-q', '-b', 'main');
  git('commit', '-q', '--allow-empty', '-m', 'init');
  return p;
};
export const worktree = (core: Core, p: string, branch: string) => {
  const w = (core.cli('worktree', 'create', '--project', p, '--branch', branch, '--no-focus').worktrees as { path: string; branch: string }[]).find((x) => x.branch === branch)!;
  core.cli('worktree', 'open', '--path', w.path, '--label', branch, '--no-focus');
};

export type Scheme = 'light' | 'dark';

export async function show(app: Page, scheme: Scheme) {
  await app.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
  await openWindow(app);
  await app.mouse.move(900, 600);
}

/** Group Trading (lumen, tide, blog) as in v2-8a-groups.html G2, folded by the user. */
export async function trading(app: Page, core: Core, scheme: Scheme, fold = true) {
  const k = repo(core, 'lumen');
  worktree(core, k, 'rehfix');
  worktree(core, k, 'broke');
  worktree(core, k, 'tests');
  core.shell(k, 'main');
  const s = repo(core, 'tide');
  worktree(core, s, 'sealed-read');
  worktree(core, s, 'review');
  core.shell(s, 'main');
  const b = repo(core, 'blog');
  worktree(core, b, 'post');
  worktree(core, b, 'draft');
  core.shell(b, 'main');
  seed(core, { op: 'group_create', name: 'Trading', project: k }, { op: 'project_move', project: s, group: 'Trading' }, { op: 'project_move', project: b, group: 'Trading' }, ...(fold ? [{ op: 'fold', key: 'group:Trading', folded: true }] : []));
  await patchSnapshots(app, { rehfix: { waiting: 'permission' }, 'sealed-read': { waiting: 'question' }, review: { waiting: 'permission' }, broke: { failed: true }, tests: { working: true }, post: { working: true } });
  await show(app, scheme);
  return app.locator('.pgrp[data-group="Trading"]');
}

/** The design book replaced the mockup's palette: its surface, text and line colours take the app's own, so the frame
 *  still compares layout, words and controls like for like. */
export const bookPalette = async (d: Locator, m: Page) => {
  const v = await d.evaluate(() => {
    const r = getComputedStyle(document.documentElement);
    const t = (k: string) => r.getPropertyValue(k).trim();
    return { page: t('--page'), bg: t('--panel'), fg: t('--text'), mut: t('--muted'), line: t('--line'), hov: t('--hover'), run: t('--accent') };
  });
  await m.addStyleTag({ content: `:root,:root:not([data-theme=light]),:root[data-theme=dark]{--page:${v.page}!important;--bg:${v.bg}!important;--fg:${v.fg}!important;--mut:${v.mut}!important;--line:${v.line}!important;--hov:${v.hov}!important;--run:${v.run}!important}` });
};

/** The design book also replaced the mockup's controls (buttons, fields, checks): each mockup control matched by
 *  `mockSel` takes the computed look of the app control at the same index under `appSel`, so the frame still compares
 *  layout and words. Pseudo-elements (a check's tick) are not copied. */
export const bookControls = async (d: Locator, appSel: string, m: Locator, mockSel: string) => {
  const props = ['height', 'width', 'padding', 'border', 'border-radius', 'background-color', 'color', 'font', 'box-shadow', 'appearance', 'line-height', 'box-sizing', 'outline', 'outline-offset'];
  const looks = await d.locator(appSel).evaluateAll((els, p) => els.map((e) => Object.fromEntries(p.map((k) => [k, getComputedStyle(e).getPropertyValue(k)]))), props);
  await m.locator(mockSel).evaluateAll((els, l) => els.forEach((e, i) => l[i] && Object.entries(l[i]).forEach(([k, v]) => (e as HTMLElement).style.setProperty(k, v, 'important'))), looks);
};
