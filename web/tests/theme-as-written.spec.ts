// Ticket 293, needs 212: a catalog or imported theme is applied as written. The real window, with a seeded tree and board,
// paints text, board, tree marks, buttons and status colours from the theme's own fields, not only its background.
// D-20261108-11 (owner F16) amends option A: secondary text (--muted, --faint) is no longer palette 8 but a mix of the theme's
// own background and foreground that reads on --page and --panel; still theme colours only.
// SHOTS_DIR=<dir> also saves the comparison shots (light and dark OS mode, each theme) for the REPORT's shots page.
import fs from 'node:fs';
import path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { THEMES } from '../src/themes/catalog/catalog.gen';
import { contrast, deriveTokens } from '../src/themes/derive';
import { parseGhostty } from '../src/themes/ghostty';
import { DARK_PICK, LIGHT_PICK } from '../src/themes/nunchiro';
import { windowTokens } from './window-tokens';
import { expect, openWindow, test, type Core } from './fixtures';
import { seed } from './fixtures/board/coord';
import { card, openTheme, rgb, stored, token } from './theme-harness';
import { patch } from './attention-patch';
import { openQuiet } from './tree-seed';
import { repo, worktree } from './visual/compare';

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
// One light and two dark: the two bundled catalog themes and an imported one.
const PICKS = [
  { id: 'catalog:Catppuccin Latte', name: 'Catppuccin Latte', colors: parseGhostty(THEMES['Catppuccin Latte']) },
  { id: 'catalog:Catppuccin Mocha', name: 'Catppuccin Mocha', colors: parseGhostty(THEMES['Catppuccin Mocha']) },
  { id: 'imported:Dracula', name: 'Dracula', colors: parseGhostty(DRACULA), source: 'https://example.invalid/dracula' },
];

function fill(core: Core) {
  const p = repo(core, 'lumen');
  for (const b of ['asks', 'broke']) worktree(core, p, b);
  openQuiet(core);
  seed(core, [
    { id: 'c1', title: 'Write the report', column: 'todo' },
    { id: 'c2', title: 'Run the gate', column: 'working' },
    { id: 'c3', title: 'Pick a theme', column: 'needs-decision' },
    { id: 'c4', title: 'Read the review', column: 'review' },
    { id: 'c5', title: 'Release notes', column: 'done' },
  ]);
}
const shotsDir = process.env.SHOTS_DIR;
const style = (l: Locator, prop: 'color' | 'backgroundColor') => l.evaluate((e, p) => getComputedStyle(e)[p], prop);
const rowOf = (app: Page, label: string) => app.locator('.row.wt2').filter({ has: app.locator('.nm').getByText(label, { exact: true }) }).first();
// Ticket 1041 lane 4 (08150d02e): the row's rail is gone; its state light is the row's ::after, or the .sess block's
// ::before when a your-turn row and its decision line are one block (tree-polish-1041.spec.ts).
const rail = (row: Locator) =>
  row.evaluate((e) => {
    const own = getComputedStyle(e, '::after');
    return own.content !== 'none' ? own.backgroundColor : getComputedStyle(e.closest('.sess')!, '::before').backgroundColor;
  });

for (const pick of PICKS)
  for (const scheme of ['light', 'dark'] as const)
    test(`themes_real_app_as_written: ${pick.name} in ${scheme} OS mode paints text, tree marks, board, buttons and status from its own fields`, { tag: '@chromium' }, async ({ app, core }) => {
      const c = pick.colors;
      const shot = (what: string) => app.screenshot({ path: path.join(shotsDir!, `${pick.name.replace(/\W+/g, '-')}-${scheme}-${what}.png`) });
      fill(core);
      await app.emulateMedia({ colorScheme: scheme });
      await patch(app, { asks: 'waiting', broke: 'failed' });
      // Both slots hold the theme and the mode follows the OS, so the OS scheme must not change what shows.
      await app.addInitScript((p) => localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ themeMode: 'system', themeLight: p, themeDark: p })), pick);
      await openWindow(app, {}, core);
      await app.mouse.move(900, 600);
      // tree marks: ticket 1041 lane 4 (C, owner 11-21) replaces ticket 462's rail (--tree-you, --tree-bad) with the state
      // light, the theme's own palette 3 and 1 stepped to 3:1 (derive.ts --light-you, --light-bad); its text the foreground
      await expect(rowOf(app, 'asks')).toBeVisible({ timeout: 15_000 });
      expect.soft(await rail(rowOf(app, 'asks')), 'your-turn light').toBe(rgb(deriveTokens(c)['--light-you']));
      expect.soft(await rail(rowOf(app, 'broke')), 'broken light').toBe(rgb(deriveTokens(c)['--light-bad']));
      expect.soft(await style(rowOf(app, 'asks').locator('.nm'), 'color'), 'row name').toBe(rgb(c.foreground));
      // text and panel
      expect.soft(await token(app, '--text')).toBe(c.foreground);
      // status colours: the theme's own palette 2, 3 (mixed toward 1), 1, stepped by the design book's derive rule until
      // they read (theme-book-contrast.spec.ts)
      const d = deriveTokens(c);
      expect.soft([await token(app, '--ok'), await token(app, '--you'), await token(app, '--bad'), await token(app, '--done')]).toEqual([d['--ok'], d['--you'], d['--bad'], d['--done']]);
      // muted: mixed from the theme's background and foreground (D-20261108-11), readable on the page
      const muted = await token(app, '--muted');
      expect.soft(muted).toBe(deriveTokens(c)['--muted']);
      expect.soft(contrast(muted, await token(app, '--page')), 'muted on --page').toBeGreaterThanOrEqual(4.5);
      // the accent is palette 4, stepped until it reads 3:1 as a mark
      expect.soft(await token(app, '--accent')).toBe(deriveTokens(c)['--accent']);
      if (shotsDir) fs.mkdirSync(shotsDir, { recursive: true });
      if (shotsDir) await shot('tree');
      await app.locator('.ib.r').getByRole('button', { name: /^Board( · |$)/ }).click();
      const board = app.locator('.board');
      await expect(board).toBeVisible();
      await app.mouse.move(2, 2);
      // board: card text, panel and the + Card button
      expect.soft(await style(board.locator('.btt').first(), 'color')).toBe(rgb(c.foreground));
      expect.soft(await style(board, 'backgroundColor')).toBe(rgb(c.background));
      expect.soft(await style(board.getByRole('button', { name: '+ Card' }), 'color')).toBe(rgb(c.foreground));
      if (shotsDir) await shot('board');
    });

// Selection, the board legend and a button come from the theme too, as written, in the real window.
for (const pick of PICKS)
  test(`selection_and_legend_mapped: ${pick.name} paints the window selection, the board key and a primary button from its own colours`, { tag: '@chromium' }, async ({ app, core }) => {
    const c = pick.colors;
    fill(core);
    await app.emulateMedia({ colorScheme: 'light' });
    await app.addInitScript((p) => localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ themeMode: 'fixed', themeFixed: p })), pick);
    await openWindow(app, {}, core);
    await app.locator('.ib.r').getByRole('button', { name: /^Board( · |$)/ }).click();
    const board = app.locator('.board');
    await expect(board).toBeVisible();
    // selection: the window's own ::selection (a rule only a catalog theme adds)
    const sel = await board.locator('.btt').first().evaluate((e) => { const s = getComputedStyle(e, '::selection'); return [s.backgroundColor, s.color]; });
    expect(sel).toEqual([rgb(c.selectionBackground), rgb(c.selectionForeground ?? c.foreground)]);
    expect(await style(board.locator('.bkey'), 'color'), 'legend text is the mixed --muted').toBe(rgb(deriveTokens(c)['--muted']));
    // key swatches follow the roles: your turn, stale, broken
    const swatch = (k: string) => style(board.locator(`.bkey [data-k="${k}"] i`), 'color');
    const d = deriveTokens(c);
    expect([await swatch('you'), await swatch('stale'), await swatch('bad')]).toEqual([rgb(d['--you']), rgb(c.palette[11]), rgb(d['--bad'])]);
    // a primary button: fill is the theme text, label the panel
    await board.getByRole('button', { name: '+ Card' }).click();
    const save = app.getByRole('dialog', { name: 'New card' }).getByRole('button', { name: 'Save' });
    expect([await style(save, 'backgroundColor'), await style(save, 'color')]).toEqual([rgb(c.foreground), rgb(c.background)]);
  });

// Basics of the Appearance page for a theme as written (needs 146, 172): reached from Settings in two clicks by name, a
// card hover previews the theme's own text and accent in the window (D-20261108-12), Esc puts the saved look back.
test('themes_basic_interactions: Settings, Appearance, hovering a card shows the theme as written; the name is on the card; Esc reverts', async ({ app, core }) => {
  fill(core);
  await app.emulateMedia({ colorScheme: 'light' });
  await openWindow(app, {}, core);
  await openTheme(app); // two clicks: Settings, then Appearance (labelled buttons)
  const mocha = card(app, 'Catppuccin Mocha');
  await expect(mocha.locator('.tname')).toHaveText('Catppuccin Mocha'); // the name shows on the card
  expect(await token(app, '--text')).toBe('#23272b'); // saved: Nunchiro Light (book-tokens.css --stone-900)
  await mocha.locator('.tpick').hover();
  const c = PICKS[1].colors;
  await expect.poll(() => token(app, '--text')).toBe(c.foreground);
  expect(await token(app, '--accent')).toBe(deriveTokens(c)['--accent']);
  expect(await token(app, '--ok')).toBe(deriveTokens(c)['--ok']);
  expect(await token(app, '--muted')).toBe(deriveTokens(c)['--muted']);
  await app.keyboard.press('Escape');
  await expect.poll(() => token(app, '--text')).toBe('#23272b');
  expect(await stored(app)).not.toContain('Catppuccin Mocha'); // a preview saves nothing
});

// The bundled pair keeps tokens.css and book-tokens.css exactly: the window sets no inline token for it, and every role
// reads the stylesheets' own value (the files parsed in window-tokens.ts, not a copy of their numbers).
const ROLE_TOKENS = ['--page', '--panel', '--raised', '--text', '--muted', '--faint', '--line', '--hover', '--you', '--you-bg', '--bad', '--run', '--ok', '--done', '--idle', '--on-status'];
for (const [name, pick] of [['Nunchiro Light', LIGHT_PICK], ['Nunchiro Dark', DARK_PICK]] as const)
  test(`bundled_themes_unchanged: ${name} sets no inline token and every role is the tokens.css value`, { tag: '@chromium' }, async ({ app, core }) => {
    fill(core);
    await app.addInitScript((p) => localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ themeMode: 'fixed', themeFixed: p })), pick);
    await openWindow(app, {}, core);
    await expect(app.locator('html')).toHaveAttribute('data-theme', name.endsWith('Dark') ? 'dark' : 'light');
    expect(await app.evaluate((ks) => ks.filter((k) => document.documentElement.style.getPropertyValue(k)), [...ROLE_TOKENS])).toEqual([]);
    expect(await app.evaluate(() => [document.getElementById('theme-selection'), document.documentElement.style.getPropertyValue('--selection-bg')])).toEqual([null, '']);
    const want = windowTokens(pick.colors);
    // Resolve each side to the browser's rgb() so #fff and #ffffff compare equal.
    const resolve = (page: Page, vals: string[]) =>
      page.evaluate((vs) => vs.map((v) => { const e = document.createElement('i'); e.style.color = v; document.body.append(e); const c = getComputedStyle(e).color; e.remove(); return c; }), vals);
    const got = await app.evaluate((ks) => ks.map((k) => getComputedStyle(document.documentElement).getPropertyValue(k).trim()), [...ROLE_TOKENS]);
    expect(await resolve(app, got)).toEqual(await resolve(app, ROLE_TOKENS.map((k) => want[k])));
  });
