// shots-102: mockup-vs-app side-by-side page for ticket 102 (dark Tidy colours) + ticket 109 (Resolve caret), on current main.
// Not part of the gate: run with SHOTS_102=1 (Chromium only). Writes t102-* shots and t102-side-by-side.html under .scratch/shots-102/.
// The seed, `tidyFill`, `on` and `tidyPanel` are copied from fidelity-worktree.spec.ts (the merged spec), so the frame is filled the same way.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { REPO, expect, test, type Core } from './fixtures';
import { openQuiet } from './tree-seed';
import { repo, show, type Scheme } from './visual/compare';
import { mockup } from './visual/mockups';

test.skip(({ browserName }) => !process.env.SHOTS_102 || browserName !== 'chromium', 'screenshots for the side-by-side page: SHOTS_102=1, chromium only');
test.describe.configure({ mode: 'serial' });
test.use({ deviceScaleFactor: 2, viewport: { width: 1440, height: 900 } });

const OUT = path.join(REPO, '.scratch/shots-102');
const FILE = 'v2-8a-compare-r3.html';
const SCHEMES = ['light', 'dark'] as const;
const TIDY = 'section[aria-labelledby="h-d3"] .dlg[aria-label^="정리 ·"]';

const clean = (app: Page) => app.mouse.move(900, 600);
const git = (dir: string, ...a: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { encoding: 'utf8' });
type Listed = { path: string; branch: string };
const create = (core: Core, p: string, branch: string) => (core.cli('worktree', 'create', '--project', p, '--branch', branch, '--no-focus').worktrees as Listed[]).find((w) => w.branch === branch)!;
/** A worktree whose agent session ended: its folder holds no running session. */
const ended = (core: Core, w: Listed) => {
  const s = core.cli('worktree', 'open', '--path', w.path, '--no-focus').session as { id: string };
  core.cli('session', 'close', s.id);
  return s.id;
};
/** The mockup page, rebuilt by `fill` with the app's words. */
const on = (fill: (m: Page) => Promise<void>) => async (m: Page) => {
  // The frames sit in a 4-column grid ~300px wide: at the app's width one would run under its neighbour. One column.
  // The mockup leaves `.chk .rb` unstyled (a UA grey button); the app gives it the mockup's own `.row .rb` look.
  // Kept (ticket 109): without the `.chk .rb,h4 .rb` rule `dark_tidy_resolve_width` fails on exactly that UA button
  // (mockup Resolve bg rgb(239, 239, 239), border 2px outset, width 76.39 vs the app's 67.66). Do not extend it.
  await m.addStyleTag({ content: '.cols{display:block!important}.col{margin-bottom:12px}.chk .rb,h4 .rb{font:600 11px system-ui;border:1px solid var(--line);background:var(--bg);color:var(--fg);border-radius:5px;padding:1px 7px}' });
  await fill(m);
};
/** "Tidy": 2 merged (PR chip patched), 1 folder gone, 2 needing a decision, over three projects as in the mockup. */
async function tidyPanel(app: Page, core: Core, scheme: Scheme) {
  const merged = new Set<string>();
  const projects = ['nunchiro', 'lumen', 'tide'].map((n) => repo(core, n));
  const [n, k, s] = projects;
  merged.add(ended(core, create(core, n, 'v2-9a-groups')));
  merged.add(ended(core, create(core, k, 'lcfollow')));
  const gone = create(core, s, 'v2-old');
  git(s, 'worktree', 'remove', '--force', '--', gone.path);
  for (const [p, b] of [[n, 'v2-undo'], [k, 'rehfix']] as const) fs.writeFileSync(path.join(create(core, p, b).path, 'lost.txt'), 'x');
  for (const p of projects) core.shell(p, 'main');
  openQuiet(core);
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    const chips = new Set<number>();
    ws.onMessage((msg) => {
      const r = typeof msg === 'string' ? JSON.parse(msg) : null;
      if (r?.request?.op === 'pr_chip' && merged.has(r.request.id)) chips.add(r.id);
      server.send(msg);
    });
    server.onMessage((msg) => {
      const r = typeof msg === 'string' ? JSON.parse(msg) : null;
      if (r && chips.has(r.id)) return ws.send(JSON.stringify({ id: r.id, response: { Ok: { type: 'pr_chip', chip: { state: 'merged', url: 'https://github.com/acme/app/pull/52', at: null } } } }));
      ws.send(msg);
    });
  });
  await show(app, scheme);
  await expect(app.locator('.grp[data-project="nunchiro"]')).toBeVisible();
  await expect(async () => {
    await app.keyboard.press('Meta+KeyK');
    await expect(app.locator('.palette input')).toBeFocused({ timeout: 3000 });
  }).toPass({ timeout: 15_000 });
  await app.keyboard.type('worktree.tidy');
  await app.keyboard.press('Enter');
  const d = app.getByRole('dialog', { name: /^Tidy/ });
  await expect(d).toBeVisible();
  const all = d.getByRole('button', { name: 'All projects' });
  if ((await all.count()) && (await all.getAttribute('aria-pressed')) === 'false') await all.click();
  await expect(d.getByRole('listitem')).toHaveCount(5);
  // The click on "All projects" took the panel's own focus: Cancel gets it back by keyboard, so its ring shows (focus-visible).
  await d.getByRole('button', { name: 'Cancel' }).focus();
  await app.keyboard.press('Shift+Tab');
  await app.keyboard.press('Tab');
  await expect(d.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await clean(app);
  return d;
}
const tidyFill = (d: Locator) => async (m: Page) => {
  const a = await d.evaluate((e) => ({
    title: e.querySelector('.wtttl span')!.textContent,
    groups: [...e.querySelectorAll('section')].map((s) => ({
      h: s.querySelector('.wtcap')!.textContent,
      rows: [...s.querySelectorAll('li')].map((li) => ({ name: [...li.querySelector('.tn')!.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim(), small: li.querySelector('small')!.textContent, box: !!li.querySelector('input'), resolve: !!li.querySelector('.resolve') })),
    })),
    buttons: [...e.querySelectorAll('.wtacts button')].map((b) => b.textContent),
    toggle: e.querySelector('.wtttl button')?.textContent ?? null,
  }));
  // Text only: the frame keeps its classes, inline styles and elements (`mockup_frame_not_adjusted`). A row or button the app
  // does not build is removed; one the frame lacks (the "All projects" toggle, a dirty row's checkbox) stays a measured difference.
  await m.locator(TIDY).first().evaluate((e, a) => {
    const first = (el: Element) => [...el.childNodes].find((n) => n.nodeType === 3)!;
    e.querySelector('h4')!.textContent = a.title;
    const caps = [...e.querySelectorAll('.grp')];
    caps.forEach((cap, i) => {
      const g = a.groups[i];
      const rows: Element[] = [];
      for (let n = cap.nextElementSibling; n?.classList.contains('chk'); n = n.nextElementSibling) rows.push(n);
      if (!g) return [cap, ...rows].forEach((x) => x.remove());
      cap.textContent = g.h;
      rows.forEach((row, k) => {
        const r = g.rows[k];
        if (!r) return row.remove();
        first(row.querySelector('span')!).textContent = r.name;
        row.querySelector('small')!.textContent = r.small;
        const rb = row.querySelector('.rb');
        if (rb) rb.textContent = rb.textContent!.replace(/^\S+/, 'Resolve');
      });
    });
    [...e.querySelectorAll('.actions button')].forEach((b, i) => (a.buttons[i] === undefined ? b.remove() : (b.textContent = a.buttons[i])));
  }, a);
};
const px = (v: string) => Math.round(parseFloat(v) * 100) / 100;
/** Computed style of one element: what the eye reads as its colour, border and width. */
const look = (l: Locator) =>
  l.first().evaluate((e) => {
    const c = getComputedStyle(e);
    return { accent: c.accentColor, bg: c.backgroundColor, scheme: c.colorScheme, border: `${c.borderTopWidth} ${c.borderTopStyle} ${c.borderTopColor}`, outline: c.outlineStyle, width: e.getBoundingClientRect().width };
  });

type Look = Awaited<ReturnType<typeof look>>;
type Facts = { box: [Look, Look]; all: [Look, Look]; resolve: [Look, Look]; allInMock: number; disabledBoxInMock: number; boxesInApp: number; mockCaretGlyph: boolean; appCaretSvg: boolean };
const facts: Partial<Record<Scheme, Facts>> = {};

const mockPage = async (app: Page, scheme: Scheme, prepare: (m: Page) => Promise<void>) => {
  const m = await app.context().newPage();
  await m.setViewportSize(app.viewportSize()!);
  await m.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
  await m.goto(`file://${mockup(FILE)}`);
  await prepare(m);
  await expect(m.locator(TIDY).first()).toBeVisible();
  return m;
};
const shoot = (l: Locator, name: string) => l.first().screenshot({ path: path.join(OUT, `t102-${name}.png`), animations: 'disabled' });

test.beforeAll(() => fs.mkdirSync(OUT, { recursive: true }));

for (const scheme of SCHEMES) {
  test(`t102 shots (${scheme})`, async ({ app, core }) => {
    test.setTimeout(90_000);
    const d = await tidyPanel(app, core, scheme);
    await expect(app.locator('html')).toHaveAttribute('data-theme', scheme);
    for (const g of ['Merged', 'Folder gone', 'Needs a decision']) await expect(d.getByRole('region', { name: new RegExp(`^${g}`) }), g).toBeVisible();
    const m = await mockPage(app, scheme, on(tidyFill(d)));
    const frame = m.locator(TIDY);
    // As visual/compare.ts does for the pixel gate: the frame is sized to the app panel's width, nothing else.
    const width = (await d.boundingBox())!.width;
    await frame.first().evaluate((e, w) => Object.assign((e as HTMLElement).style, { boxSizing: 'border-box', width: `${w}px`, maxWidth: 'none' }), width);
    const mBox = frame.locator('input[type=checkbox]:not(:disabled)');
    const mAll = m.locator('section[aria-labelledby="h-d3"] .row .rb');
    const mRes = frame.locator('.rb');
    const aBox = d.locator('input[type=checkbox]');
    const aAll = d.getByRole('button', { name: 'All projects' });
    const aRes = d.getByRole('button', { name: /^Resolve/ });

    await shoot(frame, `tidy-${scheme}-mock`);
    await shoot(d, `tidy-${scheme}-app`);
    await shoot(mBox, `checkbox-${scheme}-mock`);
    await shoot(aBox, `checkbox-${scheme}-app`);
    await shoot(mAll, `allprojects-${scheme}-mock`);
    await expect(aAll).toHaveAttribute('aria-pressed', 'true');
    await shoot(aAll, `allprojects-${scheme}-app`);
    await shoot(mRes, `resolve-${scheme}-mock`);
    await shoot(aRes, `resolve-${scheme}-app`);

    facts[scheme] = {
      box: [await look(mBox), await look(aBox)],
      all: [await look(mAll), await look(aAll)],
      resolve: [await look(mRes), await look(aRes)],
      allInMock: await frame.getByText('All projects').count(),
      disabledBoxInMock: await frame.locator('input[type=checkbox]:disabled').count(),
      boxesInApp: await aBox.count(),
      mockCaretGlyph: await mRes.first().evaluate((b) => b.textContent!.includes('▾')),
      appCaretSvg: (await aRes.first().locator('svg').count()) > 0,
    };

    // Not pressed: the toggle goes back to this project only; the mouse leaves it so no hover shows.
    await aAll.click();
    await expect(aAll).toHaveAttribute('aria-pressed', 'false');
    await clean(app);
    await shoot(aAll, `allprojects-idle-${scheme}-app`);
    await m.close();
  });
}

test.afterAll(() => {
  if (!SCHEMES.every((s) => facts[s])) return;
  const sha = execFileSync('git', ['rev-parse', '--short', 'origin/main'], { cwd: REPO, encoding: 'utf8' }).trim();
  const date = new Date().toLocaleDateString('sv');
  const F = facts as Record<Scheme, Facts>;
  const img = (n: string, w = '') => `<img src="t102-${n}.png" alt="${n}"${w ? ` width="${w}"` : ''}>`;
  const cap = (s: string, i: string) => `<figure>${i}<figcaption>${s}</figcaption></figure>`;
  const mockCell = (k: string, w = '') => cap('light', img(`${k}-light-mock`, w)) + cap('dark', img(`${k}-dark-mock`, w));
  const row = (label: string, mock: string, light: string, dark: string) => `<tr><th>${label}</th><td>${mock}</td><td>${light}</td><td>${dark}</td></tr>`;
  const head = '<tr><th></th><th>mockup</th><th>app light</th><th>app dark</th></tr>';
  const cmp = (f: (x: Facts) => [Look, Look], pick: (l: Look) => string) => (s: Scheme) => `${pick(f(F[s])[0])} | ${pick(f(F[s])[1])}`;
  const num = (r: Look) => `${px(String(r.width))} px`;
  const meas = (label: string, f: (x: Facts) => [Look, Look], pick: (l: Look) => string) => `<tr><th>${label}</th><td>${cmp(f, pick)('light')}</td><td>${cmp(f, pick)('dark')}</td></tr>`;
  const holds = (b: boolean) => (b ? 'still holds' : 'no longer holds');
  const both = (f: (x: Facts) => boolean) => f(F.light) && f(F.dark);
  const html = `<!doctype html><meta charset="utf-8"><title>ticket 102 + 109: Tidy mockup vs app</title>
<style>body{font:14px system-ui;margin:24px;max-width:1500px}table{border-collapse:collapse;margin:12px 0 28px}td,th{border:1px solid #888;padding:6px 10px;vertical-align:top;text-align:left}figure{margin:0 0 8px}figcaption{font-size:12px;color:#666}img{max-width:100%;background:#888}</style>
<h1>Tidy panel: mockup vs app (ticket 102 + 109)</h1>
<p>Base <code>${sha}</code> (origin/main), shot ${date}, Chromium 1440x900 at 2x. Decisions: FIDELITY (needs 101) and WTDIALOGS (needs 96). Ticket 102 (merged 1379b88) + ticket 109 (5a40e96).</p>
<p>Mockup: <code>${FILE}</code> frame "Merged / tidy", raw, only <code>tidyFill</code>'s text replacement. The owner has not ticked this row.</p>
<h2>1. Whole panel</h2>
<table>${head}${row('Tidy panel', cap('light', img('tidy-light-mock', '420')) + cap('dark', img('tidy-dark-mock', '420')), img('tidy-light-app', '480'), img('tidy-dark-app', '480'))}</table>
<h2>2. The three things ticket 102 / 109 changed</h2>
<table>${head}
${row('Checkbox (not disabled)', mockCell('checkbox'), img('checkbox-light-app'), img('checkbox-dark-app'))}
${row('All projects (pressed); the mockup has none, its <code>.row .rb</code> is shown (the mockup pill reads Korean 해결 ▾, not "All projects")', mockCell('allprojects'), img('allprojects-light-app'), img('allprojects-dark-app'))}
${row('All projects (not pressed)', 'no mockup state', img('allprojects-idle-light-app'), img('allprojects-idle-dark-app'))}
${row('Resolve with caret (ticket 109)', mockCell('resolve'), img('resolve-light-app'), img('resolve-dark-app'))}
</table>
<h2>3. Measured now (getComputedStyle; mockup | app)</h2>
<table><tr><th></th><th>light</th><th>dark</th></tr>
${meas('Checkbox background', (x) => x.box, (l) => l.bg)}
${meas('Checkbox color-scheme', (x) => x.box, (l) => l.scheme)}
${meas('All projects border', (x) => x.all, (l) => l.border)}
${meas('All projects outline', (x) => x.all, (l) => l.outline)}
${meas('Resolve width', (x) => x.resolve, num)}
</table>
<p>Ticket 102 REPORT, dark, for comparison: checkbox bg transparent | transparent; All projects border 1px solid rgb(61, 68, 77) | same; Resolve 67 px | 67.66 px.</p>
<h2>Remaining differences from the ticket 102 REPORT, checked against these shots</h2>
<ol>
<li>No "All projects" button in the mockup frame: ${holds(both((x) => x.allInMock === 0))} ("All projects" in the mockup frame: ${F.light.allInMock}; the app toggle is shown pressed and not pressed above).</li>
<li>Dirty rows: mockup draws a disabled checkbox, the app none: ${holds(both((x) => x.disabledBoxInMock > 0))} (mockup disabled boxes: ${F.light.disabledBoxInMock}, after <code>tidyFill</code>; app checkboxes: ${F.light.boxesInApp}).</li>
<li>Resolve triangle, app icon vs mockup "▾" glyph: ${holds(both((x) => x.appCaretSvg && x.mockCaretGlyph))} (app uses an svg: ${F.light.appCaretSvg}; mockup uses the glyph: ${F.light.mockCaretGlyph}).</li>
<li><code>on()</code> still injects one stylesheet for <code>.chk .rb</code>: still holds (by construction; no class or inline style added).</li>
</ol>
<p>Not proven: Chromium only, not the WKWebView app.</p>`;
  fs.writeFileSync(path.join(OUT, 't102-side-by-side.html'), html);
});
