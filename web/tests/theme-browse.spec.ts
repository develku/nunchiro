// Browse online (V1A-47, gallery since V1A-62): the Theme page lists iTerm2-Color-Schemes themes the core fetches. The
// window's theme ops are answered by the test (theme-harness.ts; crates/nunchiro-core/tests/themes_online.rs covers the
// fetcher); every other frame goes to the real core. Waits are on frames and the page, never on a clock. The markup
// name case moved to theme-gallery.spec.ts.
import fs from 'node:fs';
import type { Page } from '@playwright/test';
import { expect, openWindow, test } from './fixtures';
import { card, cards, colors, harness as answer, openTheme, PIN, rgb, search, token } from './theme-harness';
import { parse } from '../src/settings';
import { parseGhostty } from '../src/themes/ghostty';

const INDEX = [
  { name: 'Fake Dusk', license: 'MIT', source: 'https://github.com/example/dusk' },
  { name: 'Fake Dawn', license: 'unknown', source: '' },
  { name: 'Closed Theme', license: 'nonfree', source: '' },
];
const THEMES: Record<string, ReturnType<typeof colors>> = { 'Fake Dusk': colors('#2a1b3d', '#e8e3f0'), 'Fake Dawn': colors('#fbf1e6', '#3b2f2f'), 'Closed Theme': colors('#101010', '#c0c0c0') };
const harness = (app: Page) => answer(app, INDEX, (n) => THEMES[n]);
const SHELL = ['/bin/sh', '-c', "printf 'before \\033[31mREDTEXT\\033[0m\\n'; exec cat"];
const online = (app: Page) => cards(app).filter({ has: app.getByRole('img', { name: 'Not installed' }) });

test('the shared fixture parses the same in the window as in the core', () => {
  const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/themes/ghostty-parse.json', import.meta.url), 'utf8'));
  for (const c of fixture.valid) expect(parseGhostty(c.text), c.name).toEqual(c.colors);
});

test('settings store: Browse online defaults on, a wrong type falls back; a stored licence must be a short string', () => {
  expect(parse(null).settings.themeBrowse).toBe(true);
  expect(parse(JSON.stringify({ themeBrowse: false })).settings.themeBrowse).toBe(false);
  const wrong = parse(JSON.stringify({ themeBrowse: 'no' }));
  expect(wrong.settings.themeBrowse).toBe(true);
  expect(wrong.clean).toBe(false);
  const pick = { id: 'imported:X', name: 'X', colors: parseGhostty('background = #000000\nforeground = #ffffff\n'), source: `${PIN}ghostty/X`, licence: 'nonfree' };
  expect(parse(JSON.stringify({ themesImported: [pick] })).settings.themesImported[0].licence).toBe('nonfree');
  for (const licence of [7, 'x'.repeat(101)]) {
    const bad = parse(JSON.stringify({ themesImported: [{ ...pick, licence }] }));
    expect(bad.settings.themesImported).toEqual([]);
    expect(bad.clean).toBe(false);
  }
});

test('the credits carry the full licence texts of the bundled themes', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await harness(app);
  await openWindow(app);
  await openTheme(app);
  await app.locator('.tfoot').getByRole('button', { name: 'credits' }).click();
  await app.getByText('Full licence texts').click();
  const texts = app.locator('.tlic pre').first();
  await expect(texts).toContainText('MIT License');
  await expect(texts).toContainText('Copyright (c) 2021 Catppuccin');
  await expect(texts).toContainText('Catppuccin Latte');
});

test('opening the Theme page sends the index op once; searching sends no index op again', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  const h = await harness(app);
  await openWindow(app);
  expect(h.ops).toEqual([]);
  await openTheme(app);
  await expect(card(app, 'Fake Dusk')).toBeVisible();
  await search(app, 'fake');
  await expect(online(app)).toHaveCount(2);
  expect(h.ops.filter((o) => o.op === 'theme_index')).toEqual([{ op: 'theme_index' }]);
});

test('search filters online cards by name; licences stay off the cards; cards work from the keyboard', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  const h = await harness(app);
  await openWindow(app);
  await openTheme(app);
  await expect(online(app)).toHaveCount(3);
  await search(app, 'fake');
  await expect(online(app)).toHaveCount(2);
  for (const t of await online(app).locator('.tname').allInnerTexts()) expect(t.toLowerCase()).toContain('fake');
  await expect(card(app, 'Fake Dawn')).not.toContainText('licence');
  await search(app, 'closed');
  await expect(online(app).locator('.tname')).toHaveText(['Closed Theme']);

  await search(app, 'dusk');
  const dusk = card(app, 'Fake Dusk').locator('.tpick');
  await expect(dusk).toHaveAccessibleName('Fake Dusk');
  expect(h.files()).toContain('Fake Dusk');
  await expect(dusk.locator('.tterm')).toHaveCSS('background-color', rgb('#2a1b3d'));
  await expect(dusk.locator('.tterm span').nth(4)).toHaveCSS('color', rgb('#ff5577'));
  await dusk.focus();
  await app.keyboard.press('Enter');
  await expect(dusk).toHaveAttribute('aria-pressed', 'true');
  expect(await token(app, '--bg')).toBe('#2a1b3d');
});

test('apply imports the theme with source and licence, recolours window and terminal without reload, and survives reload offline', async ({ app, core }) => {
  const a = core.shell(core.project('demo'), 'alpha', ...SHELL);
  const h = await harness(app);
  await openWindow(app);
  await expect(app.locator(`.term[data-session="${a.id}"] .xterm-rows`)).toContainText('REDTEXT');
  await app.evaluate(() => ((window as { __same?: number }).__same = 1));
  await openTheme(app);
  await app.getByRole('radio', { name: 'One theme' }).check();
  await card(app, 'Fake Dusk').locator('.tpick').press('Enter'); // ticket 162: a click previews, Enter keeps
  expect(await token(app, '--bg')).toBe('#2a1b3d');
  expect(await app.evaluate(() => (window as { __same?: number }).__same)).toBe(1);
  const imported = app.locator('.tcard[data-theme-id="imported:Fake Dusk"]');
  await expect(imported).toHaveCount(1);
  await expect(imported.locator('.tpick')).toHaveAttribute('aria-pressed', 'true');
  // Applying it again neither duplicates it nor fetches it again.
  const files = h.files().length;
  await imported.locator('.tpick').press('Enter'); // ticket 162: a click previews, Enter keeps
  await expect(imported).toHaveCount(1);
  expect(h.files().length).toBe(files);

  const term = app.locator(`.term[data-session="${a.id}"]`);
  const termColours = async () => ({
    background: await term.locator('.xterm-scrollable-element').evaluate((el) => getComputedStyle(el).backgroundColor),
    red: await term.locator('.xterm-rows span', { hasText: 'REDTEXT' }).first().evaluate((el) => getComputedStyle(el).color),
  });
  await app.getByRole('button', { name: 'Close Settings' }).click(); // Settings is a modal: what sits behind it cannot be clicked
  await app.getByRole('tab', { name: /alpha/ }).click();
  await expect.poll(termColours).toEqual({ background: rgb('#2a1b3d'), red: rgb('#ff5577') });

  // The fake server goes away: the applied theme needs no network.
  h.down = true;
  await app.reload();
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  expect(await token(app, '--bg')).toBe('#2a1b3d');
  await expect.poll(termColours).toEqual({ background: rgb('#2a1b3d'), red: rgb('#ff5577') });
  await openTheme(app);
  await app.locator('.tfoot').getByRole('button', { name: 'credits' }).click();
  const kept = app.getByRole('region', { name: 'Theme credits' }).locator('li').filter({ hasText: 'Fake Dusk' });
  await expect(kept).toContainText('MIT');
  await expect(kept).toContainText(`${PIN}ghostty/Fake%20Dusk`);
  expect(h.files().length).toBe(files);
});

test('offline: one line with Retry; built-in themes still apply', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  const h = await harness(app);
  h.down = true;
  await openWindow(app);
  await openTheme(app);
  const line = app.getByRole('alert').filter({ hasText: "Can't reach GitHub; installed themes still work" });
  await expect(line).toBeVisible();
  await app.getByRole('radio', { name: 'One theme' }).check();
  await search(app, 'Mocha');
  await app.getByRole('button', { name: 'Catppuccin Mocha', exact: true }).click();
  expect(await token(app, '--bg')).toBe('#1e1e2e');
  h.down = false;
  await line.getByRole('button', { name: 'Retry' }).click();
  await expect(line).toHaveCount(0);
  expect(h.ops.filter((o) => o.op === 'theme_index')).toEqual([{ op: 'theme_index' }, { op: 'theme_index' }]);
});

test('setting off: no online card and no op is sent', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  const h = await harness(app);
  await openWindow(app);
  await openTheme(app);
  const setting = app.getByRole('switch', { name: 'Browse themes online' });
  await expect(setting).toBeChecked();
  await expect(online(app)).toHaveCount(3);
  await setting.uncheck();
  await expect(online(app)).toHaveCount(0);
  const sent = h.ops.length;
  await app.reload();
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  await openTheme(app);
  await expect(app.getByRole('switch', { name: 'Browse themes online' })).not.toBeChecked();
  await expect(cards(app)).toHaveCount(4);
  expect(h.ops.length).toBe(sent);
});

test('C18 online_card_preview_never_blank: a card whose file is on its way or did not load says so with its name, and Retry loads it', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  const h = await harness(app);
  h.hold = true;
  await openWindow(app);
  await openTheme(app);
  const dusk = card(app, 'Fake Dusk');
  await expect(dusk.locator('.tskel')).toContainText('Fake Dusk');
  await expect(dusk.locator('.tskel')).toContainText('Loading preview…');
  h.down = true;
  h.release();
  await expect(dusk.locator('.tskel')).toContainText('Preview not loaded');
  h.down = false;
  h.hold = false;
  await dusk.getByRole('button', { name: 'Retry' }).click();
  await expect(dusk.locator('.tskel')).toHaveCount(0);
});
