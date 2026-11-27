// Theme page (needs 55; ticket V1A-34): pick a theme in the app, the window and open terminals recolour at once.
import type { Page } from '@playwright/test';
import { expect, openWindow, test } from './fixtures';
import { card, harness, menu } from './theme-harness';

const token = (app: Page, name: string) => app.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);
const rgb = (hex: string) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ')})`;
// Prints red (palette 1) text the test can find, then keeps the shell open.
const SHELL = ['/bin/sh', '-c', "printf 'before \\033[31mREDTEXT\\033[0m\\n'; exec cat"];

async function termColours(app: Page, id: string) {
  const term = app.locator(`.term[data-session="${id}"]`);
  return {
    background: await term.locator('.xterm-scrollable-element').evaluate((el) => getComputedStyle(el).backgroundColor),
    red: await term.locator('.xterm-rows span', { hasText: 'REDTEXT' }).first().evaluate((el) => getComputedStyle(el).color),
  };
}

// V1A-62: the page asks for the online index when it opens; answered here with an empty list, never the network.
test.beforeEach(({ app }) =>
  harness(app, [], () => {
    throw new Error('no theme file in this spec');
  }),
);

async function openTheme(app: Page) {
  // Settings is a modal that stays open over a reload; Meta+Comma would close it.
  if (!(await app.getByRole('button', { name: 'Close Settings' }).isVisible())) await app.keyboard.press('Meta+Comma');
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Appearance' }).click();
  await app.getByRole('button', { name: 'Show all', exact: true }).click(); // ticket 162: the rest of the themes
}

test('picking a catalog theme recolours the window and the open terminal with no reload or recreate, and persists', async ({ app, core, context }) => {
  const a = core.shell(core.project('demo'), 'alpha', ...SHELL);
  await openWindow(app);
  await expect(app.locator(`.term[data-session="${a.id}"] .xterm-rows`)).toContainText('REDTEXT');
  const before = await termColours(app, a.id);
  expect(await token(app, '--bg')).toBe('#fafaf9'); // Nunchiro Light paints book-tokens.css (--stone-25)
  await app.locator(`.term[data-session="${a.id}"] .xterm`).evaluate((el) => el.setAttribute('data-mark', '1'));
  await app.evaluate(() => ((window as { __same?: number }).__same = 1));

  await openTheme(app);
  await app.getByRole('radio', { name: 'One theme' }).check();
  await app.getByRole('searchbox', { name: 'Search themes' }).fill('mocha');
  await app.getByRole('button', { name: 'Catppuccin Mocha', exact: true }).press('Enter'); // ticket 162: a click previews, Enter keeps
  expect(await token(app, '--bg')).toBe('#1e1e2e');
  await expect(app.locator('html')).toHaveAttribute('data-theme', 'dark');

  await app.getByRole('button', { name: 'Close Settings' }).click(); // Settings is a modal: what sits behind it cannot be clicked
  await app.getByRole('tab', { name: /alpha/ }).click();
  await expect.poll(() => termColours(app, a.id)).toEqual({ background: rgb('#1e1e2e'), red: rgb('#f38ba8') });
  expect(before.background).not.toBe(rgb('#1e1e2e'));
  await expect(app.locator(`.term[data-session="${a.id}"] .xterm[data-mark="1"]`)).toHaveCount(1);
  expect(await app.evaluate(() => (window as { __same?: number }).__same)).toBe(1);
  await expect(app.locator(`.term[data-session="${a.id}"] .xterm-rows`)).toContainText('before');

  // A restart (reload, then a fresh page on the same storage) paints Catppuccin Mocha before the Theme page opens.
  await app.reload();
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  expect(await token(app, '--bg')).toBe('#1e1e2e');
  await expect.poll(() => termColours(app, a.id)).toEqual({ background: rgb('#1e1e2e'), red: rgb('#f38ba8') });
  await app.close();
  const second = await context.newPage();
  await second.addInitScript((boot) => {
    window.__NUNCHIRO__ = boot;
  }, core.boot());
  await second.goto('/');
  await expect(second.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  expect(await token(second, '--bg')).toBe('#1e1e2e');
  await expect.poll(() => termColours(second, a.id)).toEqual({ background: rgb('#1e1e2e'), red: rgb('#f38ba8') });
});

test('search filters cards; each card has the theme name and works from the keyboard', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await openTheme(app);
  const catalog = app.locator('.tpage .tcard[data-theme-id^="catalog:"]');
  await expect(catalog.first()).toBeVisible();
  // Needs 70 (V1A-62): Nunchiro Light/Dark plus Catppuccin Latte/Mocha (update.py ALLOWLIST, licence notice found).
  await expect(catalog).toHaveCount(2);
  await expect(app.locator('.tpage .tcard')).toHaveCount(4);
  await app.getByRole('searchbox', { name: 'Search themes' }).fill('catppuccin');
  await expect(catalog).not.toHaveCount(0);
  for (const name of await catalog.locator('.tname').allInnerTexts()) expect(name.toLowerCase()).toContain('catppuccin');
  await app.getByRole('searchbox', { name: 'Search themes' }).fill('no-such-theme-zz');
  await expect(app.getByText('No theme matches')).toBeVisible();
  await app.getByRole('searchbox', { name: 'Search themes' }).fill('Latte');
  const latte = app.getByRole('button', { name: 'Catppuccin Latte', exact: true });
  await latte.focus();
  await app.keyboard.press('Enter');
  await expect(latte).toHaveAttribute('aria-pressed', 'true');
  expect(await token(app, '--bg')).toBe('#eff1f5');
});

test('system mode follows the OS between the light and dark picks', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await app.emulateMedia({ colorScheme: 'light' });
  await openWindow(app);
  expect(await token(app, '--bg')).toBe('#fafaf9'); // Nunchiro Light paints book-tokens.css (--stone-25)
  await app.emulateMedia({ colorScheme: 'dark' });
  await expect.poll(() => token(app, '--bg')).toBe('#1b1e21'); // Nunchiro Dark's panel (book-tokens.css --graphite-900)
  await expect(app.locator('html')).toHaveAttribute('data-theme', 'dark');
  // Choosing while the dark appearance shows sets the dark pick; the light pick stays.
  await openTheme(app);
  await app.getByRole('searchbox', { name: 'Search themes' }).fill('Catppuccin Mocha');
  await app.getByRole('button', { name: 'Catppuccin Mocha', exact: true }).press('Enter'); // ticket 162: a click previews, Enter keeps
  expect(await token(app, '--bg')).toBe('#1e1e2e');
  await app.emulateMedia({ colorScheme: 'light' });
  await expect.poll(() => token(app, '--bg')).toBe('#fafaf9'); // Nunchiro Light paints book-tokens.css (--stone-25)
  await expect(app.locator('html')).toHaveAttribute('data-theme', 'light');
  await app.emulateMedia({ colorScheme: 'dark' });
  await expect.poll(() => token(app, '--bg')).toBe('#1e1e2e');
});

test('imported themes: none shows the catalog and no error; a pasted theme is kept in the app and applies', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await openTheme(app);
  await expect(app.locator('.tpage .tcard[data-theme-id^="imported:"]')).toHaveCount(0);
  await expect(app.locator('.tpage .tcard[data-theme-id^="catalog:"]').first()).toBeVisible();
  await expect(app.getByRole('alert')).toHaveCount(0);
  await app.getByText('Import a theme file').click();
  await app.getByRole('textbox', { name: 'Name' }).fill('My Theme');
  // Not a theme: refused with a reason.
  await app.getByRole('textbox', { name: 'Theme file text' }).fill('font-size = 12');
  await app.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(app.getByRole('alert')).toContainText('No theme found');
  await app.getByRole('textbox', { name: 'Theme file text' }).fill('background = #102030\nforeground = #e0e0e0\npalette = 1=#ff0000\n');
  await app.getByRole('textbox', { name: 'Source (optional)' }).fill('https://example.com/my-theme');
  await app.getByRole('button', { name: 'Add', exact: true }).click();
  await app.getByRole('radio', { name: 'One theme' }).check();
  await app.getByRole('button', { name: 'My Theme', exact: true }).press('Enter'); // ticket 162: a click previews, Enter keeps
  expect(await token(app, '--bg')).toBe('#102030');
  await app.reload();
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  expect(await token(app, '--bg')).toBe('#102030');
  await openTheme(app);
  await expect(card(app, 'My Theme')).toHaveAttribute('data-theme-id', 'imported:My Theme');
  // V1A-62: the source moved off the card into the credits detail.
  await app.locator('.tfoot').getByRole('button', { name: 'credits' }).click();
  await expect(app.getByRole('region', { name: 'Theme credits' }).locator('li').filter({ hasText: 'My Theme' })).toContainText('https://example.com/my-theme');
  await menu(app, 'My Theme', 'Remove');
  await expect(card(app, 'My Theme')).toHaveCount(0);
});

test('catalog licences: each theme author\'s notice ships in the built chunk and shows in the Theme credits', async ({ app, core }) => {
  // The built lazy chunk keeps the notices (not tree-shaken away).
  const fs = await import('node:fs');
  const dir = new URL('../dist/assets/', import.meta.url);
  const chunk = fs.readdirSync(dir).find((f) => f.startsWith('catalog.gen-'));
  expect(chunk).toBeTruthy();
  expect(fs.readFileSync(new URL(chunk!, dir), 'utf8')).toContain('Copyright (c) 2021 Catppuccin');
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await openTheme(app);
  await app.locator('.tfoot').getByRole('button', { name: 'credits' }).click();
  const mocha = app.locator('.tlic li').filter({ hasText: 'Catppuccin Mocha' });
  await expect(mocha).toContainText('MIT');
  await expect(mocha).toContainText('Copyright (c) 2021 Catppuccin');
  await expect(mocha).toContainText('https://github.com/catppuccin/palette');
  await expect(app.locator('.tlic li')).toHaveCount(2);
});
