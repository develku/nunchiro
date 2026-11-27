// Theme gallery (V1A-62, needs 70): one searchable grid of installed and online themes, live preview, install and
// remove, four built-ins. Online is mocked through the theme ops (theme-harness.ts); waits are on frames and the page.
import type { Page } from '@playwright/test';
import { expect, openWindow, test } from './fixtures';
import { card, cards, colors, harness, menu, openTheme, PIN, rgb, search, stored, token, type Entry } from './theme-harness';
import { luminance } from '../src/themes/derive';
import { parseGhostty } from '../src/themes/ghostty';
import { DARK_PICK, LIGHT_PICK } from '../src/themes/nunchiro';

const XSS = '"><img src=x onerror="window.__xss=1">';
const INDEX: Entry[] = [
  { name: 'Fake Dusk', license: 'MIT', source: 'https://github.com/example/dusk' },
  { name: 'Fake Dawn', license: 'unknown', source: '' },
  { name: 'Mid Below', license: 'MIT', source: '' },
  { name: 'Mid Above', license: 'MIT', source: '' },
  // Also built in: shows once, as installed.
  { name: 'Catppuccin Mocha', license: 'MIT', source: 'https://github.com/catppuccin/palette' },
  { name: XSS, license: 'MIT', source: '' },
];
// Background relative luminance on both sides of 0.5 (WCAG formula): #b4b4b4 is 0.456, #bcbcbc is 0.503.
const FILES: Record<string, ReturnType<typeof colors>> = {
  'Fake Dusk': colors('#2a1b3d', '#e8e3f0'),
  'Fake Dawn': colors('#fbf1e6', '#3b2f2f'),
  'Mid Below': colors('#b4b4b4', '#000000'),
  'Mid Above': colors('#bcbcbc', '#000000'),
  'Catppuccin Mocha': colors('#1e1e2e', '#cdd6f4'),
  [XSS]: colors('#003300', '#ccffcc'),
};
const SHELL = ['/bin/sh', '-c', "printf 'before \\033[31mREDTEXT\\033[0m\\n'; exec cat"];
const names = (app: Page) => cards(app).locator('.tname').allInnerTexts();
const seed = (app: Page, settings: Record<string, unknown>) =>
  app.addInitScript((s) => {
    if (!localStorage.getItem('nunchiro.settings.v1')) localStorage.setItem('nunchiro.settings.v1', JSON.stringify(s));
  }, settings);
const termBg = (app: Page, id: string) => app.locator(`.term[data-session="${id}"] .xterm-scrollable-element`).evaluate((el) => getComputedStyle(el).backgroundColor);

test('gallery-search: one query filters installed and online cards together; an installed online theme shows once', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  const mine = { id: 'imported:Fake Dusk', name: 'Fake Dusk', colors: FILES['Fake Dusk'], source: `${PIN}ghostty/Fake%20Dusk`, licence: 'MIT' };
  await seed(app, { themesImported: [mine] });
  await harness(app, INDEX, (n) => FILES[n]);
  await openWindow(app);
  await openTheme(app);
  await expect(card(app, 'Fake Dawn')).toBeVisible();
  await search(app, 'fake');
  await expect.poll(() => names(app)).toEqual(['Fake Dusk', 'Fake Dawn']);
  await expect(card(app, 'Fake Dusk')).toHaveAttribute('data-theme-id', 'imported:Fake Dusk');
  await search(app, 'CATPPUCCIN');
  await expect.poll(() => names(app)).toEqual(['Catppuccin Mocha', 'Catppuccin Latte']);
  await expect(card(app, 'Catppuccin Mocha')).toHaveAttribute('data-theme-id', 'catalog:Catppuccin Mocha');
  await search(app, 'no-such-theme-zz');
  await expect(cards(app)).toHaveCount(0);
  await expect(app.getByText('No theme matches “no-such-theme-zz”.')).toBeVisible();
});

test('gallery-filter-chips: Dark, Light and Installed show the right cards by background luminance', async ({ app, core }) => {
  expect(luminance('#b4b4b4')).toBeLessThan(0.5);
  expect(luminance('#bcbcbc')).toBeGreaterThan(0.5);
  core.shell(core.project('demo'), 'alpha');
  await harness(app, INDEX, (n) => FILES[n]);
  await openWindow(app);
  await openTheme(app);
  const chip = (name: string) => app.getByRole('group', { name: 'Show' }).getByRole('button', { name, exact: true });
  await expect(card(app, 'Mid Above')).toBeVisible();
  await chip('Dark').click();
  await expect(chip('Dark')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => names(app)).toEqual(['Nunchiro Dark', 'Catppuccin Mocha', 'Fake Dusk', 'Mid Below', XSS]);
  await chip('Light').click();
  await expect.poll(() => names(app)).toEqual(['Nunchiro Light', 'Catppuccin Latte', 'Fake Dawn', 'Mid Above']);
  await chip('Installed').click();
  await expect.poll(() => names(app)).toEqual(['Nunchiro Light', 'Nunchiro Dark', 'Catppuccin Mocha', 'Catppuccin Latte']);
  await chip('All').click();
  await expect(cards(app)).toHaveCount(4 + 5);
});

test('gallery-live-preview: hover and arrow focus recolour the window and an open terminal; Esc and leaving the grid revert; nothing is saved until a click or Enter (D-20261108-12)', async ({ app, core }) => {
  const a = core.shell(core.project('demo'), 'alpha', ...SHELL);
  await app.emulateMedia({ colorScheme: 'light' });
  await harness(app, INDEX, (n) => FILES[n]);
  await openWindow(app);
  await expect(app.locator(`.term[data-session="${a.id}"] .xterm-rows`)).toContainText('REDTEXT');
  await openTheme(app);
  const before = await stored(app);
  expect(await token(app, '--bg')).toBe('#fafaf9'); // Nunchiro Light paints book-tokens.css (--stone-25)

  await card(app, 'Catppuccin Mocha').locator('.tpick').hover();
  await expect.poll(() => token(app, '--bg')).toBe('#1e1e2e');
  await expect.poll(() => termBg(app, a.id)).toBe(rgb('#1e1e2e'));
  await expect(app.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await stored(app)).toBe(before);
  // The pointer leaving the grid without a pick reverts.
  await app.mouse.move(1, 1);
  await expect.poll(() => token(app, '--bg')).toBe('#fafaf9'); // Nunchiro Light paints book-tokens.css (--stone-25)
  await expect.poll(() => termBg(app, a.id)).toBe(rgb('#fafaf9')); // Nunchiro Light's terminal background

  // An online card previews too, and preview never installs it.
  await card(app, 'Fake Dusk').locator('.tpick').hover();
  await expect.poll(() => token(app, '--bg')).toBe('#2a1b3d');
  await app.keyboard.press('Escape');
  await expect.poll(() => token(app, '--bg')).toBe('#fafaf9'); // Nunchiro Light paints book-tokens.css (--stone-25)
  expect(await stored(app)).toBe(before);
  await expect(app.getByRole('dialog', { name: 'Settings' })).toBeVisible(); // v25f: the Esc that ended the preview leaves the Settings modal open

  // Arrow keys move focus card to card and preview each; Esc restores the saved theme.
  await app.mouse.move(1, 1);
  await card(app, 'Nunchiro Light').locator('.tpick').focus();
  await app.keyboard.press('ArrowRight');
  await expect(card(app, 'Nunchiro Dark').locator('.tpick')).toBeFocused();
  await expect.poll(() => token(app, '--bg')).toBe('#1b1e21'); // Nunchiro Dark's panel (book-tokens.css --graphite-900)
  await app.keyboard.press('ArrowRight');
  await expect(card(app, 'Catppuccin Mocha').locator('.tpick')).toBeFocused();
  await expect.poll(() => token(app, '--bg')).toBe('#1e1e2e');
  await app.keyboard.press('Escape');
  await expect.poll(() => token(app, '--bg')).toBe('#fafaf9'); // Nunchiro Light paints book-tokens.css (--stone-25)
  expect(await stored(app)).toBe(before);

  // Enter applies and saves; leaving no longer reverts.
  await app.keyboard.press('ArrowRight');
  await app.keyboard.press('Enter');
  await expect.poll(() => token(app, '--bg')).toBe('#eff1f5');
  await expect.poll(async () => JSON.parse((await stored(app)) ?? '{}').themeLight?.id).toBe('catalog:Catppuccin Latte');
  await app.mouse.move(1, 1);
  await app.getByRole('searchbox', { name: 'Search themes' }).focus();
  expect(await token(app, '--bg')).toBe('#eff1f5');
  await expect(card(app, 'Catppuccin Latte').locator('.tpick')).toHaveAttribute('aria-pressed', 'true');
});

test('gallery-apply-installs: applying an online card installs it with source and licence; the icon becomes a check; it survives reload offline', async ({ app, core }) => {
  const a = core.shell(core.project('demo'), 'alpha', ...SHELL);
  const h = await harness(app, INDEX, (n) => FILES[n]);
  await openWindow(app);
  await openTheme(app);
  await app.getByRole('radio', { name: 'One theme' }).check();
  const dusk = card(app, 'Fake Dusk');
  await expect(dusk.getByRole('img', { name: 'Not installed' })).toBeVisible();
  await dusk.locator('.tpick').press('Enter'); // ticket 162: a click previews, Enter keeps
  expect(await token(app, '--bg')).toBe('#2a1b3d');
  await expect(dusk).toHaveAttribute('data-theme-id', 'imported:Fake Dusk');
  await expect(dusk.getByRole('img', { name: 'Installed' })).toBeVisible();
  await expect(dusk.locator('.tpick')).toHaveAttribute('aria-pressed', 'true');
  await expect(cards(app).filter({ hasText: 'Fake Dusk' })).toHaveCount(1);
  const saved = JSON.parse((await stored(app))!);
  expect(saved.themesImported).toEqual([{ id: 'imported:Fake Dusk', name: 'Fake Dusk', colors: FILES['Fake Dusk'], source: `${PIN}ghostty/Fake%20Dusk`, licence: 'MIT' }]);
  expect(saved.themeFixed.id).toBe('imported:Fake Dusk');

  await app.keyboard.press('Escape'); // v25f: closed first, so the page opens after the reload, as the ops below count
  await expect(app.getByRole('dialog', { name: 'Settings' })).toHaveCount(0);
  h.down = true;
  const sent = h.ops.length;
  await app.reload();
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  expect(await token(app, '--bg')).toBe('#2a1b3d');
  await expect.poll(() => termBg(app, a.id)).toBe(rgb('#2a1b3d'));
  await openTheme(app);
  await expect(card(app, 'Fake Dusk').getByRole('img', { name: 'Installed' })).toBeVisible();
  // Reopening asks for the index again (the page opened), never for an installed theme's file.
  expect(h.ops.slice(sent)).toEqual([{ op: 'theme_index' }]);
});

test('gallery-remove-imported: Remove drops it; a slot it held falls back to the Nunchiro default with a one-line note', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await app.emulateMedia({ colorScheme: 'dark' });
  const mine = { id: 'imported:Fake Dusk', name: 'Fake Dusk', colors: FILES['Fake Dusk'] };
  const other = { id: 'imported:Other', name: 'Other', colors: FILES['Fake Dawn'] };
  await seed(app, { themesImported: [mine, other], themeDark: mine, themeBrowse: false });
  await openWindow(app);
  expect(await token(app, '--bg')).toBe('#2a1b3d');
  await openTheme(app);
  await menu(app, 'Other', 'Remove');
  await expect(card(app, 'Other')).toHaveCount(0);
  await expect(app.getByRole('status').filter({ hasText: 'now uses' })).toHaveCount(0);
  await menu(app, 'Fake Dusk', 'Remove');
  await expect(card(app, 'Fake Dusk')).toHaveCount(0);
  await expect(app.getByRole('status').filter({ hasText: 'Fake Dusk was in use, so dark mode now uses Nunchiro Dark.' })).toBeVisible();
  await expect.poll(() => token(app, '--bg')).toBe('#1b1e21'); // Nunchiro Dark's panel (book-tokens.css --graphite-900)
  const saved = JSON.parse((await stored(app))!);
  expect(saved.themesImported).toEqual([]);
  expect(saved.themeDark.id).toBe('nunchiro:dark');
});

// Q9 ko-J14-1: an import adds no Undo of its own, so a Remove's Undo can meet a list filled again; it adds no 201st theme.
test('gallery-remove-undo-full: Undo of a Remove into a full imported list says so and keeps 200', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  const list = Array.from({ length: 200 }, (_, i) => ({ id: `imported:Kept ${i}`, name: `Kept ${i}`, colors: FILES['Fake Dawn'] }));
  await seed(app, { themesImported: list, themeBrowse: false });
  await openWindow(app);
  await openTheme(app);
  await menu(app, 'Kept 0', 'Remove');
  await expect(card(app, 'Kept 0')).toHaveCount(0);
  await app.getByText('Import a theme file').click();
  await app.getByRole('textbox', { name: 'Name' }).fill('Newer');
  await app.getByRole('textbox', { name: 'Theme file text' }).fill('background = #102030\nforeground = #e0e0e0\n');
  await app.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(card(app, 'Newer')).toHaveCount(1);
  await app.locator('.undoline').getByRole('button', { name: /Undo/ }).click();
  await expect(app.getByRole('status').filter({ hasText: 'You have 200 imported themes' })).toBeVisible();
  expect(JSON.parse((await stored(app))!).themesImported).toHaveLength(200);
});

test('gallery-hide-builtin: Hide removes a built-in from the grid, it has no Remove, Show hidden brings it back; a hidden theme in use stays applied', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await app.emulateMedia({ colorScheme: 'light' });
  await seed(app, { themeBrowse: false });
  await openWindow(app);
  await openTheme(app);
  const latte = card(app, 'Catppuccin Latte');
  await latte.locator('.tpick').press('Enter'); // ticket 162: a click previews, Enter keeps
  await expect.poll(() => token(app, '--bg')).toBe('#eff1f5');
  await latte.getByRole('button', { name: 'Options' }).click();
  await expect(latte.getByRole('button', { name: 'Remove' })).toHaveCount(0);
  await latte.getByRole('button', { name: 'Hide', exact: true }).click();
  await expect(latte).toHaveCount(0);
  expect(await token(app, '--bg')).toBe('#eff1f5');
  await menu(app, 'Nunchiro Dark', 'Hide');
  const show = app.getByRole('button', { name: 'Show hidden (2)' });
  await expect(show).toBeVisible();
  await app.reload();
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  await expect(app.getByRole('dialog', { name: 'Settings' })).toBeVisible(); // v25f: the reload keeps the Settings modal open
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Appearance' }).click();
  await expect(card(app, 'Catppuccin Mocha')).toBeVisible();
  await expect(card(app, 'Catppuccin Latte')).toHaveCount(0);
  await show.click();
  await expect(card(app, 'Catppuccin Latte')).toBeVisible();
  await expect(card(app, 'Nunchiro Dark')).toBeVisible();
  await expect(app.getByRole('button', { name: /Show hidden/ })).toHaveCount(0);
});

test('gallery-slots: Use for light and Use for dark set the slots; the OS appearance switch swaps between them; a click applies to the slot showing now', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await app.emulateMedia({ colorScheme: 'light' });
  const h = await harness(app, INDEX, (n) => FILES[n]);
  await openWindow(app);
  await openTheme(app);
  const light = app.getByRole('combobox', { name: 'When light' });
  const dark = app.getByRole('combobox', { name: 'When dark' });
  await expect(light).toHaveValue(LIGHT_PICK.id);
  await expect(dark).toHaveValue(DARK_PICK.id);
  await expect(app.getByRole('radiogroup', { name: 'Choosing the theme for' })).toHaveCount(0);
  await menu(app, 'Catppuccin Mocha', 'Use for dark');
  await expect(card(app, 'Fake Dawn').locator('.tpick')).toBeEnabled();
  await menu(app, 'Fake Dawn', 'Use for light');
  await expect(light).toHaveValue('imported:Fake Dawn');
  await expect(dark).toHaveValue('catalog:Catppuccin Mocha');
  // The pointer off the grid: no hover preview stands over the saved slots.
  await app.mouse.move(1, 1);
  await expect.poll(() => token(app, '--bg')).toBe('#fbf1e6');
  // Using an online theme for a slot installs it.
  await expect(card(app, 'Fake Dawn')).toHaveAttribute('data-theme-id', 'imported:Fake Dawn');
  await app.emulateMedia({ colorScheme: 'dark' });
  await expect.poll(() => token(app, '--bg')).toBe('#1e1e2e');
  await app.emulateMedia({ colorScheme: 'light' });
  await expect.poll(() => token(app, '--bg')).toBe('#fbf1e6');
  // A click applies to the slot showing now (light); dark stays.
  await card(app, 'Catppuccin Latte').locator('.tpick').press('Enter'); // ticket 162: a click previews, Enter keeps
  await expect(light).toHaveValue('catalog:Catppuccin Latte');
  await expect(card(app, 'Catppuccin Latte')).toContainText('In use');
  // Ticket 991 C17: the In use tag does not cut the card's name ("Catppuccin L…").
  expect(await card(app, 'Catppuccin Latte').locator('.tname').evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
  await dark.selectOption('catalog:Catppuccin Latte'); // the row, not the menu: the same slot write
  await expect(dark).toHaveValue('catalog:Catppuccin Latte');
  expect(h.files()).not.toContain('Catppuccin Mocha');
});

test('gallery-slot-target: a card goes to the selected slot row, Undo stays with that slot, single-theme ignores a leftover selection (ticket 364)', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await app.emulateMedia({ colorScheme: 'light' });
  await harness(app, INDEX, (n) => FILES[n]);
  await openWindow(app);
  await openTheme(app);
  const button = (name: string) => app.getByRole('button', { name, exact: true });
  const select = (name: string) => app.getByRole('combobox', { name });
  const lightBtn = button('When light');
  const darkBtn = button('When dark');
  const darkRow = app.locator('.srow', { has: darkBtn });
  const lightRow = app.locator('.srow', { has: lightBtn });
  const offLabel = { position: { x: 300, y: 10 } }; // the row, away from its label and its dropdown
  const marks = async (light: boolean, dark: boolean) => {
    await expect(lightBtn).toHaveAttribute('aria-pressed', String(light));
    await expect(darkBtn).toHaveAttribute('aria-pressed', String(dark));
  };
  const saved = async () => JSON.parse((await stored(app)) ?? '{}');
  const pick = (name: string) => card(app, name).locator('.tpick').press('Enter'); // ticket 162: Enter keeps

  // 1. The default tracks macOS until the user chooses; then one row is marked at a time, by mouse and by keyboard.
  await marks(true, false);
  await app.emulateMedia({ colorScheme: 'dark' });
  await marks(false, true);
  await app.emulateMedia({ colorScheme: 'light' });
  await marks(true, false);
  await darkBtn.click();
  await marks(false, true);
  await lightBtn.focus();
  await app.keyboard.press('Space');
  await marks(true, false);

  // 2. The slot that is not showing takes the card; the window keeps its look.
  await darkBtn.click();
  await pick('Catppuccin Mocha');
  await expect(select('When dark')).toHaveValue('catalog:Catppuccin Mocha');
  await expect.poll(async () => (await saved()).themeDark?.id).toBe('catalog:Catppuccin Mocha');
  expect((await saved()).themeLight.id).toBe(LIGHT_PICK.id);
  await app.mouse.move(1, 1);
  expect(await token(app, '--bg')).toBe('#fafaf9');

  // 3. In use follows the selected row.
  await expect(card(app, 'Catppuccin Mocha')).toContainText('In use');
  await expect(card(app, 'Nunchiro Light')).not.toContainText('In use');
  await lightRow.click(offLabel);
  await marks(true, false);
  await expect(card(app, 'Nunchiro Light')).toContainText('In use');
  await expect(card(app, 'Catppuccin Mocha')).not.toContainText('In use');

  // 4. An online theme installs into the selected slot; Undo takes back that slot and the install.
  await darkRow.click(offLabel);
  await marks(false, true);
  await pick('Fake Dawn');
  await expect(select('When dark')).toHaveValue('imported:Fake Dawn');
  expect((await saved()).themesImported.map((p: { id: string }) => p.id)).toEqual(['imported:Fake Dawn']);
  await app.locator('.undoline').getByRole('button', { name: /Undo/ }).click();
  await expect(select('When dark')).toHaveValue('catalog:Catppuccin Mocha');
  await expect.poll(async () => (await saved()).themesImported).toEqual([]);
  expect((await saved()).themeDark.id).toBe('catalog:Catppuccin Mocha');
  expect((await saved()).themeLight.id).toBe(LIGHT_PICK.id);

  // 5. One theme: the leftover selection is ignored.
  const before = await saved();
  await app.getByRole('radio', { name: 'One theme' }).check();
  await expect(darkBtn).toHaveCount(0);
  await pick('Catppuccin Latte');
  await expect.poll(async () => (await saved()).themeFixed?.id).toBe('catalog:Catppuccin Latte');
  expect((await saved()).themeDark.id).toBe(before.themeDark.id);
  expect((await saved()).themeLight.id).toBe(before.themeLight.id);
  await expect(card(app, 'Catppuccin Latte')).toContainText('In use');
  await app.getByRole('radio', { name: 'Follow the system' }).check();
  await marks(false, true);

  // 6. Focus alone never moves the selection, or the next card lands in the wrong slot; opening a dropdown does.
  await select('When light').focus();
  await marks(false, true);
  await lightBtn.click();
  await marks(true, false);
  await select('When dark').click(); // a real click: selectOption fires no pointerdown, and an overlay would fail it
  await marks(false, true);
  await app.keyboard.press('Escape');
});

test('gallery-credits: no card and no lede carries a licence string; the footer credits open the licence detail', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  const mine = { id: 'imported:Fake Dusk', name: 'Fake Dusk', colors: FILES['Fake Dusk'], source: `${PIN}ghostty/Fake%20Dusk`, licence: 'Apache-2.0', copyright: ['Copyright (c) 2024 Dusk Author'] };
  await seed(app, { themesImported: [mine] });
  await harness(app, INDEX, (n) => FILES[n]);
  await openWindow(app);
  await openTheme(app);
  await expect(card(app, 'Fake Dawn')).toBeVisible();
  const licence = /licen[cs]e|\bMIT\b|Apache|copyright|unknown|nonfree/i;
  for (const t of await cards(app).allInnerTexts()) expect(t).not.toMatch(licence);
  for (const t of await app.locator('.tpage .lede').allInnerTexts()) expect(t).not.toMatch(licence);
  await expect(app.locator('.tpage [data-licence]')).toHaveCount(0);
  const footer = app.locator('.tfoot');
  await expect(footer).toHaveText('Themes from iTerm2-Color-Schemes (MIT) · credits');
  await footer.getByRole('button', { name: 'credits' }).click();
  const credits = app.getByRole('region', { name: 'Theme credits' });
  await expect(credits).toBeVisible();
  await expect(credits.locator('li').filter({ hasText: 'Catppuccin Mocha' })).toContainText('Copyright (c) 2021 Catppuccin');
  const dusk = credits.locator('li').filter({ hasText: 'Fake Dusk' });
  await expect(dusk).toContainText('Apache-2.0');
  await expect(dusk).toContainText('Copyright (c) 2024 Dusk Author');
  await expect(dusk).toContainText(`${PIN}ghostty/Fake%20Dusk`);
  await credits.getByText('Full licence texts').click();
  await expect(credits.locator('pre').first()).toContainText('Copyright (c) 2021 Catppuccin');
  await expect(credits.locator('pre').first()).toContainText('Permission is hereby granted');
});

test('gallery-migrate-dropped: a stored Nord dark pick and a fixed Rose Pine load as imported themes with the same colours, licence and copyright', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await app.emulateMedia({ colorScheme: 'dark' });
  const nord = { id: 'catalog:Nord', name: 'Nord', colors: parseGhostty('background = #2e3440\nforeground = #d8dee9\n') };
  const rose = { id: 'catalog:Rose Pine', name: 'Rose Pine', colors: parseGhostty('background = #191724\nforeground = #e0def4\n') };
  await seed(app, { themeDark: nord, themeFixed: rose, themeBrowse: false });
  await openWindow(app);
  expect(await token(app, '--bg')).toBe('#2e3440');
  await openTheme(app);
  await expect(card(app, 'Nord')).toHaveAttribute('data-theme-id', 'imported:Nord');
  await expect(card(app, 'Rose Pine')).toHaveAttribute('data-theme-id', 'imported:Rose Pine');
  await expect(card(app, 'Nord').locator('.tpick')).toHaveAttribute('aria-pressed', 'true');
  await app.getByRole('radio', { name: 'One theme' }).check();
  await expect.poll(() => token(app, '--bg')).toBe('#191724');
  await app.locator('.tfoot').getByRole('button', { name: 'credits' }).click();
  const n = app.getByRole('region', { name: 'Theme credits' }).locator('li').filter({ hasText: 'Nord' });
  await expect(n).toContainText('MIT');
  await expect(n).toContainText('Copyright (c) 2016-present Sven Greb');
  await expect(n).toContainText('https://github.com/nordtheme/iterm2');
  const saved = JSON.parse((await stored(app))!);
  expect(saved.themesImported.map((p: { id: string }) => p.id)).toEqual(['imported:Nord', 'imported:Rose Pine']);
});

test('gallery-request-budget: one screen sends at most 24 file ops and never more than 4 at once; scrolling to the end sends the next page; a new search drops queued calls; setting off sends nothing', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  const index: Entry[] = Array.from({ length: 860 }, (_, i) => ({ name: `Theme ${String(i).padStart(3, '0')}`, license: 'MIT', source: '' }));
  const h = await harness(app, index, (n) => (Number(n.slice(6)) % 2 ? colors('#fafafa', '#202020') : colors('#101010', '#e0e0e0')));
  h.hold = true;
  await openWindow(app);
  await openTheme(app);
  // Answers held: exactly 4 in flight, nothing more queued out.
  await expect.poll(() => h.files().length).toBe(4);
  expect(h.ops[0]).toEqual({ op: 'theme_index' });
  for (let i = 0; i < 5; i++) {
    expect(h.open).toBeLessThanOrEqual(4);
    h.release();
    await expect.poll(() => h.files().length).toBe(Math.min(24, 4 * (i + 2)));
  }
  h.release();
  await expect(cards(app).locator('.tpick[data-state="ok"]')).toHaveCount(4 + 24);
  expect(h.files()).toEqual(index.slice(0, 24).map((e) => e.name));
  expect(h.maxOpen).toBe(4);
  await expect(cards(app)).toHaveCount(4 + 24);

  // The end of the grid comes into view by scrolling: the next page, still 4 at a time.
  const end = app.getByRole('button', { name: 'More online themes' });
  await expect(end).not.toBeInViewport();
  // A programmatic scroll is not the user's: nothing more is fetched.
  await end.scrollIntoViewIfNeeded();
  await expect(end).toBeInViewport();
  await app.waitForTimeout(500);
  expect(h.files()).toHaveLength(24);
  // The user scrolls the grid to its end: the next page.
  await app.locator('.tscroll').evaluate((el) => (el.scrollTop = 0));
  await app.locator('.tscroll').hover({ position: { x: 5, y: 5 } });
  await app.mouse.wheel(0, 4000);
  await expect.poll(() => h.files().length).toBe(28);
  // A new search while 4 are in flight: the rest of that page is never sent.
  await search(app, 'Theme 85');
  h.release();
  await expect.poll(() => h.files().length).toBe(28 + 4);
  h.hold = false;
  h.release();
  await expect.poll(() => h.files().length).toBe(28 + 10);
  expect(h.files().slice(28)).toEqual(index.filter((e) => e.name.startsWith('Theme 85')).map((e) => e.name));
  await expect(cards(app)).toHaveCount(10);
  // Each name is asked at most once per window session.
  await search(app, '');
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Notifications' }).click();
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Appearance' }).click();
  await app.getByRole('button', { name: 'Show all', exact: true }).click(); // ticket 162: the page opens on the short list
  await expect(cards(app).locator('.tpick[data-state="ok"]')).toHaveCount(4 + 24);
  expect(new Set(h.files()).size).toBe(h.files().length);

  // Setting off: no online card and no op, after a reload as well.
  const sent = h.ops.length;
  await app.getByRole('switch', { name: 'Browse themes online' }).uncheck();
  await expect(cards(app)).toHaveCount(4);
  await app.reload();
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  await openTheme(app);
  await expect(cards(app)).toHaveCount(4);
  expect(h.ops.length).toBe(sent);
});

test('gallery-offline: the index op fails: installed themes show, one line with Retry', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  const h = await harness(app, INDEX, (n) => FILES[n]);
  h.down = true;
  await openWindow(app);
  await openTheme(app);
  const line = app.getByRole('alert').filter({ hasText: "Can't reach GitHub; installed themes still work" });
  await expect(line).toBeVisible();
  await expect(cards(app)).toHaveCount(4);
  await card(app, 'Catppuccin Mocha').locator('.tpick').press('Enter'); // ticket 162: a click previews, Enter keeps
  await app.getByRole('radio', { name: 'One theme' }).check();
  await card(app, 'Catppuccin Mocha').locator('.tpick').press('Enter'); // ticket 162: a click previews, Enter keeps
  expect(await token(app, '--bg')).toBe('#1e1e2e');
  h.down = false;
  await line.getByRole('button', { name: 'Retry' }).click();
  await expect(line).toHaveCount(0);
  await expect(card(app, 'Fake Dusk')).toBeVisible();
  expect(h.ops.filter((o) => o.op === 'theme_index')).toHaveLength(2);
});

test('gallery injection: a theme name holding markup renders as text and injects no element (V1A-47 case)', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await harness(app, INDEX, (n) => FILES[n]);
  await openWindow(app);
  await openTheme(app);
  await search(app, '<img');
  const x = card(app, XSS);
  await expect(x).toHaveCount(1);
  await expect(x.locator('.tname')).toHaveText(XSS);
  await x.locator('.tpick').press('Enter'); // ticket 162: a click previews, Enter keeps
  await expect(x).toHaveAttribute('data-theme-id', `imported:${XSS}`);
  await expect(app.locator('.settings img')).toHaveCount(0);
  expect(await app.evaluate(() => (window as { __xss?: number }).__xss)).toBeUndefined();
});

test('gallery-imports-cap: with 200 imported themes, applying an online one says why and installs nothing', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  const full = Array.from({ length: 200 }, (_, i) => ({ id: `imported:T${i}`, name: `T${i}`, colors: FILES['Fake Dawn'] }));
  await seed(app, { themesImported: full });
  await harness(app, INDEX, (n) => FILES[n]);
  await openWindow(app);
  await openTheme(app);
  await search(app, 'Fake Dusk');
  await card(app, 'Fake Dusk').locator('.tpick').press('Enter'); // ticket 162: a click previews, Enter keeps
  await expect(app.getByRole('status').filter({ hasText: 'You have 200 imported themes; remove one to install another.' })).toBeVisible();
  expect(JSON.parse((await stored(app)) ?? '{}').themesImported ?? full).toHaveLength(200);
  await expect(card(app, 'Fake Dusk').getByRole('img', { name: 'Not installed' })).toBeVisible();
});

// Security review round 1 (MUST): layout shifts (skeletons, filtered cards, window resizes) never open a page; only a
// real scroll of the grid or the button does. Light themes are 1 in 20 here, so a Light screen holds almost nothing.
test('gallery-request-budget-layout: chip changes and window resizes fetch no next page; one screen stays at 24 files', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  const index: Entry[] = Array.from({ length: 860 }, (_, i) => ({ name: `Theme ${String(i).padStart(3, '0')}`, license: 'MIT', source: '' }));
  const h = await harness(app, index, (n) => (Number(n.slice(6)) % 20 ? colors('#101010', '#e0e0e0') : colors('#fafafa', '#202020')));
  await openWindow(app);
  await openTheme(app);
  const chip = (name: string) => app.getByRole('group', { name: 'Show' }).getByRole('button', { name, exact: true });
  await expect(cards(app).locator('.tpick[data-state="ok"]')).toHaveCount(4 + 24);
  for (const c of ['Light', 'Dark', 'Light', 'All', 'Light']) {
    await chip(c).click();
    await app.waitForTimeout(400);
    expect(h.files(), `after ${c}`).toHaveLength(24);
  }
  for (const [width, height] of [[1000, 700], [1440, 1400], [800, 500], [1440, 900], [1200, 1600], [1440, 900]]) {
    await app.setViewportSize({ width, height });
    await app.waitForTimeout(300);
    expect(h.files(), `after ${width}x${height}`).toHaveLength(24);
  }
  // The button is the one way on when nothing scrolls: one page per click.
  await app.getByRole('button', { name: 'More online themes' }).click();
  await expect.poll(() => h.files().length).toBe(48);
  await app.waitForTimeout(400);
  expect(h.files()).toHaveLength(48);
});

// Security review round 1 (SHOULDs).
test('gallery-imports-cap (file import): the 201st pasted theme is refused with the reason; the stored list stays loadable', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  const full = Array.from({ length: 200 }, (_, i) => ({ id: `imported:T${i}`, name: `T${i}`, colors: FILES['Fake Dawn'] }));
  await seed(app, { themesImported: full, themeBrowse: false });
  await openWindow(app);
  await openTheme(app);
  await app.getByText('Import a theme file').click();
  await app.getByRole('textbox', { name: 'Name' }).fill('One More');
  await app.getByRole('textbox', { name: 'Theme file text' }).fill('background = #102030\nforeground = #e0e0e0\n');
  await app.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(app.getByRole('alert')).toContainText('You have 200 imported themes; remove one to add another.');
  expect(JSON.parse((await stored(app)) ?? '{}').themesImported ?? full).toHaveLength(200);
  await expect(card(app, 'One More')).toHaveCount(0);
});

test('gallery-migrate-dropped with a full Imported list: the slot keeps its colours and its licence notice shows in credits, with an MIT text', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await app.emulateMedia({ colorScheme: 'dark' });
  const full = Array.from({ length: 200 }, (_, i) => ({ id: `imported:T${i}`, name: `T${i}`, colors: FILES['Fake Dawn'] }));
  const nord = { id: 'catalog:Nord', name: 'Nord', colors: parseGhostty('background = #2e3440\nforeground = #d8dee9\n') };
  await seed(app, { themesImported: full, themeDark: nord, themeBrowse: false });
  await openWindow(app);
  expect(await token(app, '--bg')).toBe('#2e3440');
  await openTheme(app);
  await app.locator('.tfoot').getByRole('button', { name: 'credits' }).click();
  const credits = app.getByRole('region', { name: 'Theme credits' });
  const n = credits.locator('li').filter({ hasText: 'Nord' });
  await expect(n).toContainText('Copyright (c) 2016-present Sven Greb');
  await expect(n).toContainText('https://github.com/nordtheme/iterm2');
  await credits.getByText('Full licence texts').click();
  await expect(credits.locator('pre').last()).toContainText('THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND');
  await expect(credits.locator('pre')).toHaveCount(2);
});

test('gallery catalog load failure: bundled themes never show as online cards to install again', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  const h = await harness(app, INDEX, (n) => FILES[n]);
  await app.route(/catalog\.gen-[^/]*\.js$/, (r) => r.abort());
  await openWindow(app);
  await app.keyboard.press('Meta+Comma');
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Appearance' }).click();
  await expect(app.getByRole('alert').filter({ hasText: 'The built-in themes did not load.' })).toBeVisible();
  await app.waitForTimeout(500);
  await expect(card(app, 'Catppuccin Mocha')).toHaveCount(0);
  expect(h.files()).not.toContain('Catppuccin Mocha');
  await app.unroute(/catalog\.gen-[^/]*\.js$/);
  await app.getByRole('button', { name: 'Try again' }).click();
  await expect(card(app, 'Catppuccin Mocha')).toHaveAttribute('data-theme-id', 'catalog:Catppuccin Mocha');
  await app.getByRole('button', { name: 'Show all', exact: true }).click(); // ticket 162: online cards are behind it
  await expect(card(app, 'Fake Dusk')).toBeVisible();
  expect(h.files()).not.toContain('Catppuccin Mocha');
});

test('gallery menu a11y: named per card; Esc closes it and returns focus to its toggle; after Hide and Remove focus lands on the next card', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  const mine = { id: 'imported:Mine', name: 'Mine', colors: FILES['Fake Dusk'] };
  const last = { id: 'imported:Last', name: 'Last', colors: FILES['Fake Dawn'] };
  await seed(app, { themesImported: [mine, last], themeBrowse: false });
  await openWindow(app);
  await openTheme(app);
  const toggle = app.getByRole('button', { name: 'Options for Catppuccin Mocha', exact: true });
  await toggle.click();
  await card(app, 'Catppuccin Mocha').getByRole('button', { name: 'Hide', exact: true }).focus();
  await app.keyboard.press('Escape');
  await expect(card(app, 'Catppuccin Mocha').getByRole('button', { name: 'Hide', exact: true })).toHaveCount(0);
  await expect(toggle).toBeFocused();
  // Use for dark: the menu closes and focus goes back to its toggle.
  await toggle.click();
  await card(app, 'Catppuccin Mocha').getByRole('button', { name: 'Use for dark', exact: true }).click();
  await expect(toggle).toBeFocused();
  await menu(app, 'Catppuccin Mocha', 'Hide');
  await expect(card(app, 'Catppuccin Latte').locator('.tpick')).toBeFocused();
  await menu(app, 'Mine', 'Remove');
  await expect(card(app, 'Last').locator('.tpick')).toBeFocused();
  await menu(app, 'Last', 'Remove');
  await expect(card(app, 'Catppuccin Latte').locator('.tpick')).toBeFocused();
});
