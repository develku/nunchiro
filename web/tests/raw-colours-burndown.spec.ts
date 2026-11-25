// V2.5-43 (raw colours burndown): the five non-system stylesheets and the find bar take their colours from tokens.
// raw_colours_five_files_lowered, raw_colours_none_left_or_listed and raw_colours_contrast_in_each_theme.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { parseGhostty } from '../src/themes/ghostty';
import { DARK_PICK, LIGHT_PICK } from '../src/themes/nunchiro';
import { expect, openWindow, REPO, test, type Core } from './fixtures';
import { append, openChat, rec, test as chatTest } from './fixtures/chat/harness';

const DRACULA = `background = #282a36
foreground = #f8f8f2
selection-background = #44475a
palette = 0=#21222c
palette = 1=#ff5555
palette = 2=#50fa7b
palette = 3=#f1fa8c
palette = 4=#bd93f9
palette = 5=#ff79c6
palette = 6=#8be9fd
palette = 7=#f8f8f2
palette = 8=#6272a4
palette = 9=#ff6e6e
palette = 10=#69ff94
palette = 11=#ffffa5
palette = 12=#d6acff
palette = 13=#ff92df
palette = 14=#a4ffff
palette = 15=#ffffff
`;
const SOLARIZED_LIGHT = `background = #fdf6e3
foreground = #657b83
selection-background = #eee8d5
palette = 0=#073642
palette = 1=#dc322f
palette = 2=#859900
palette = 3=#b58900
palette = 4=#268bd2
palette = 5=#d33682
palette = 6=#2aa198
palette = 7=#bbb5a1
palette = 8=#002b36
palette = 9=#cb4b16
palette = 10=#586e75
palette = 11=#657b83
palette = 12=#839496
palette = 13=#6c71c4
palette = 14=#93a1a1
palette = 15=#fdf6e3
`;
const imported = (name: string, ghostty: string) => ({ id: `imported:${name}`, name, colors: parseGhostty(ghostty), source: `https://example.invalid/${encodeURIComponent(name)}` });
const THEMES = [imported('Dracula', DRACULA), imported('Solarized Light', SOLARIZED_LIGHT), LIGHT_PICK, DARK_PICK];

const FILES = ['diff/diff.css', 'terminal/search.tsx', 'firstrun/firstrun.css', 'images/images.css', 'pr/pr.css'];
/** Literals the lane left in place, with the colour and job each does (REPORT `## Handoff`); none today. */
const LISTED: Record<string, number> = {};

/** The baseline lines this lane found (V2.5-43 base 8b7d289c): each must now be lower, or gone. */
const BEFORE: Record<string, number> = { 'hex diff/diff.css': 12, 'hex terminal/search.tsx': 5, 'hex firstrun/firstrun.css': 1, 'col images/images.css': 1, 'col pr/pr.css': 1 };

const counts = () =>
  Object.fromEntries(
    execFileSync('sh', [path.join(REPO, 'scripts/raw-literals.sh')], { encoding: 'utf8' })
      .split('\n')
      .filter((l) => /^(hex|col) /.test(l))
      .map((l) => l.split(' '))
      .map(([k, f, n]) => [`${k} ${f}`, Number(n)]),
  ) as Record<string, number>;
const baseline = () =>
  Object.fromEntries(
    fs.readFileSync(path.join(REPO, 'scripts/raw-literals.baseline'), 'utf8')
      .split('\n')
      .filter((l) => /^(hex|col) /.test(l))
      .map((l) => l.split(' '))
      .map(([k, f, n]) => [`${k} ${f}`, Number(n)]),
  ) as Record<string, number>;

test('raw_colours_five_files_lowered: the hex and col count of each of the five files equals its baseline line, or the line is gone', () => {
  const [now, base] = [counts(), baseline()];
  for (const f of FILES)
    for (const k of ['hex', 'col']) {
      expect(now[`${k} ${f}`] ?? 0, `${k} ${f}`).toBe(base[`${k} ${f}`] ?? 0);
      if (BEFORE[`${k} ${f}`]) expect(base[`${k} ${f}`] ?? 0, `${k} ${f} baseline lowered`).toBeLessThan(BEFORE[`${k} ${f}`]);
    }
});

test('raw_colours_none_left_or_listed: no raw hex or rgb( is left in the five files except the listed ones', () => {
  const now = counts();
  for (const f of FILES) for (const k of ['hex', 'col']) expect(now[`${k} ${f}`] ?? 0, `${k} ${f}`).toBe(LISTED[`${k} ${f}`] ?? 0);
});

/** The colour a text sits on: the first non-transparent background up the ancestors, as the browser resolves it. */
const bgOf = (l: Locator) =>
  l.evaluate((e) => {
    for (let n: Element | null = e; n; n = n.parentElement) {
      const c = getComputedStyle(n).backgroundColor;
      if (c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') return c;
    }
    return 'rgb(255, 255, 255)';
  });
const fgOf = (l: Locator) => l.evaluate((e) => getComputedStyle(e).color);
const lum = (rgb: string) => {
  // A color-mix() result computes to `color(srgb 0.54 0.82 0.6)`: channels 0..1, not 0..255.
  const unit = rgb.startsWith('color(') ? 1 : 255;
  const [r, g, b] = (rgb.match(/[\d.]+/g) ?? []).slice(0, 3).map((v) => {
    const s = Number(v) / unit;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a: string, b: string) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};
/** CIE76 colour distance of two computed `rgb(...)` colours (sRGB, D65): about 2 is a just noticeable step; orange
 *  #e8590c against the match yellow #ffe27a is about 63, Dracula's yellow #f1fa8c against it about 15. */
const deltaE = (a: string, b: string) => {
  const lab = (rgb: string) => {
    const [r, g, bl] = (rgb.match(/[\d.]+/g) ?? []).slice(0, 3).map((v) => {
      const s = Number(v) / 255;
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
    const [x, y, z] = [(0.4124 * r + 0.3576 * g + 0.1805 * bl) / 0.95047, 0.2126 * r + 0.7152 * g + 0.0722 * bl, (0.0193 * r + 0.1192 * g + 0.9505 * bl) / 1.08883].map(f);
    return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
  };
  const [p, q] = [lab(a), lab(b)];
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
};
/** 4.5, or what the theme's own body text gets on the same background when that is lower, less `slack`. Solarized Light ships
 *  --text at 4.13 on its page (3.7 on the diff tint), and a stylesheet cannot read better than the token the whole app reads
 *  with: a theme palette is the system seam (REPORT Handoff). A sign that is also a coloured hue gets half a step of slack. */
async function readable(el: Locator, what: string, slack = 0) {
  const [fg, bg] = [await fgOf(el), await bgOf(el)];
  const text = await el.evaluate(() => {
    const probe = document.body.appendChild(document.createElement('i'));
    probe.style.color = 'var(--text)';
    const c = getComputedStyle(probe).color;
    probe.remove();
    return c;
  });
  const floor = Math.min(4.5, ratio(text, bg) - slack);
  expect(ratio(fg, bg), `${what}: ${fg} on ${bg}, floor ${floor.toFixed(2)}`).toBeGreaterThanOrEqual(floor - 1e-9);
}
const shotsDir = process.env.SHOTS_DIR;
const shot = (page: Page, surface: string, theme: string) =>
  shotsDir && (fs.mkdirSync(shotsDir, { recursive: true }), page.screenshot({ path: path.join(shotsDir, `${surface}-${theme.replace(/\W+/g, '-')}.png`) }));
const useTheme = (page: Page, pick: object) =>
  page.addInitScript((p) => localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ themeMode: 'fixed', themeFixed: p })), pick);

const git = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'gc.auto=0', ...args], { encoding: 'utf8' });
function repo(core: Core) {
  const dir = core.project('demo');
  git(dir, 'init', '-q');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\nchanged\n');
  return dir;
}

for (const pick of THEMES) {
  test(`raw_colours_contrast_in_each_theme: diff, ${pick.name}: the +/- sign reads on its tinted line`, { tag: '@chromium' }, async ({ app, core }) => {
    core.shell(repo(core), 'diff-shell');
    await useTheme(app, pick);
    await openWindow(app);
    await app.getByRole('navigation', { name: 'Right bar' }).getByRole('button', { name: 'Diff', exact: true }).click();
    await app.getByRole('list', { name: 'Changed files' }).locator('[data-path]').first().click();
    const view = app.getByRole('region', { name: 'Diff of a.txt' });
    await readable(view.locator('tr.add .sign').first(), 'added sign', 0.5);
    await readable(view.locator('tr.del .sign').first(), 'deleted sign', 0.5);
    await shot(app, 'diff', pick.name);
  });

  test(`raw_colours_contrast_in_each_theme: terminal search, ${pick.name}: the find field reads on its bar`, { tag: '@chromium' }, async ({ app, core }) => {
    const s = core.shell(core.project('demo'), 'numbers', '/bin/sh', '-c', "/usr/bin/seq -f 'line %g' 1 50; exec cat");
    await useTheme(app, pick);
    await openWindow(app);
    await app.locator(`.term[data-session="${s.id}"]`).click();
    await app.keyboard.press('Meta+KeyF');
    const field = app.getByRole('searchbox', { name: 'Find in terminal' });
    await field.fill('line 2');
    await readable(field, 'find field');
    await shot(app, 'terminal-search', pick.name);
  });

  // Round 2: the current match had --you, which a catalog theme derives from ANSI yellow, so it matched the yellow of the
  // other matches (--mark). The DOM renderer paints the current match's cells with the selection (findNext selects it), so
  // what marks it is its outline: that colour must stand apart from the other matches' fill in every theme.
  test(`find_current_match_stands_out: terminal search, ${pick.name}: the current match's outline differs from the other matches`, async ({ app, core }) => {
    const s = core.shell(core.project('demo'), 'numbers', '/bin/sh', '-c', "/usr/bin/seq -f 'line %g' 1 50; exec cat");
    await useTheme(app, pick);
    await openWindow(app);
    const term = app.locator(`.term[data-session="${s.id}"]`);
    await term.click();
    await app.keyboard.press('Meta+KeyF');
    await app.getByRole('searchbox', { name: 'Find in terminal' }).fill('line 2');
    const current = term.locator('.xterm-find-result-decoration[style*="outline"]');
    await expect(current).toHaveCount(1);
    const outline = await current.evaluate((e) => getComputedStyle(e).outlineColor);
    // An other match: a row span with an inline background that is not the current (top-layer) one.
    const other = term.locator('.xterm-rows span[style*="background-color"]:not(.xterm-decoration-top)').first();
    await expect(other).toHaveCount(1);
    const fill = await other.evaluate((e) => getComputedStyle(e).backgroundColor);
    expect(deltaE(outline, fill), `current outline ${outline} vs other match ${fill}`).toBeGreaterThan(30);
  });

  test(`raw_colours_contrast_in_each_theme: first run, ${pick.name}: the Landing's key hints read on the centre`, { tag: '@chromium' }, async ({ app }) => {
    await useTheme(app, pick);
    await openWindow(app);
    const keys = app.locator('.pane .empty .landing-keys');
    await expect(keys).toBeVisible();
    await readable(keys, 'Landing key hints');
    await shot(app, 'first-run', pick.name);
  });
}

const RED_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAAEElEQVR4nGO4w8AARww4OQDTjwpRD8VS4AAAAABJRU5ErkJggg==';
const PR_URL = 'https://github.com/develku/nunchiro/pull/12';
const VIEW = {
  number: 12, title: 'Add the PR view', url: PR_URL, state: 'OPEN', isDraft: false, author: 'develku', body: 'Body',
  createdAt: '2026-10-30T10:00:00Z', headRefOid: '0123456789abcdef0123456789abcdef01234567', headRefName: 'herdr/x', baseRefName: 'main',
  reviewDecision: 'APPROVED', mergeable: 'MERGEABLE', additions: 3, deletions: 1, labels: [], requested: [],
  latest: [], checks: [], commits: [], comments: [], reviews: [], files: [],
};

for (const pick of THEMES) {
  chatTest(`raw_colours_contrast_in_each_theme: image viewer, ${pick.name}: the file name reads on the dialog`, { tag: '@chromium' }, async ({ page, chatCore }) => {
    const s = chatCore.chat();
    const user = { type: 'user', uuid: crypto.randomUUID(), message: { role: 'user', content: [{ type: 'text', text: 'see this' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: RED_PNG } }] } };
    append(s.file, user, rec.assistant('ok'));
    await useTheme(page, pick);
    await openChat(page, s.id);
    await page.getByRole('button', { name: 'Open image png image' }).click();
    const dialog = page.getByRole('dialog', { name: 'Image png image' });
    await expect(dialog).toBeVisible();
    await readable(dialog.locator('.ivbar .iname'), 'image name');
    await shot(page, 'image-viewer', pick.name);
  });

  chatTest(`raw_colours_contrast_in_each_theme: PR view, ${pick.name}: the title reads on the dialog`, { tag: '@chromium' }, async ({ page, chatCore }) => {
    fs.writeFileSync(path.join(chatCore.home, 'gh-view'), JSON.stringify(VIEW));
    fs.writeFileSync(path.join(chatCore.home, 'bin/gh'), `#!/bin/sh\ncase "$2" in\n  view) /bin/cat '${chatCore.home}/gh-view' ;;\n  diff) printf '+a\\n-b\\n' ;;\n  list) echo '[]' ;;\nesac\n`, { mode: 0o700 });
    const s = chatCore.chat('alpha');
    append(s.file, rec.user('open a pr'), rec.use('t1', 'Bash', { command: 'gh pr create' }), rec.result('t1', PR_URL));
    await page.addInitScript(() => localStorage.setItem('nunchiro.chatView.v2', 'verbose'));
    await useTheme(page, pick);
    await openChat(page, s.id);
    await page.locator('.shead .prchip button').first().click();
    const dlg = page.getByRole('dialog', { name: 'Pull request' });
    await dlg.getByRole('button', { name: 'Turn on' }).click();
    await expect(dlg.getByRole('heading', { name: /Add the PR view/ })).toBeVisible();
    await readable(dlg.getByRole('heading', { name: /Add the PR view/ }), 'PR title');
    await shot(page, 'pr-view', pick.name);
  });
}
