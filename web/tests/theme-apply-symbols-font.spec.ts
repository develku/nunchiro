// needs 152 (amends needs 71): Nunchiro bundles Symbols Nerd Font Mono as the terminal's symbol fallback, on by default,
// so prompt glyphs (Powerline, devicons) never draw as boxes. The real-app capture is
// docs/design/v25-bug-sweep/theme/check2.py (shots-r2-after/5-prompt.png).
import { DEFAULTS } from '../src/settings';
import { SYMBOLS } from '../src/settings/appearance/fonts';
import { expect, openWindow, test } from './fixtures';
import { stored } from './theme-harness';

/** Loaded FontFaces named like the symbols face. */
const loadedSymbols = (app: import('@playwright/test').Page) =>
  app.evaluate((name) => [...document.fonts].filter((f) => f.family.replace(/"/g, '') === name && f.status === 'loaded').length, SYMBOLS);

test('symbols_font_default: a fresh window lists the symbols face after the main face and loads the bundled file', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  expect(DEFAULTS.termFont).toBe('"SF Mono", "Symbols Nerd Font Mono", Menlo, "D2Coding", monospace');
  await expect.poll(() => loadedSymbols(app)).toBeGreaterThan(0);
  // The face draws a Powerline arrow (U+E0B0) wider than nothing: the glyph is there, not a missing-glyph box measure.
  const w = await app.evaluate((name) => {
    const c = document.createElement('canvas').getContext('2d')!;
    c.font = `24px "${name}"`;
    return c.measureText('').width;
  }, SYMBOLS);
  expect(w).toBeGreaterThan(0);
  await app.getByRole('navigation', { name: 'Left bar' }).getByRole('button', { name: 'Settings' }).click();
  // needs 192 (7) (ticket 250): the face is always on behind the picked font; Settings has no toggle for it.
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Terminal', exact: true }).click();
  await expect(app.getByRole('button', { name: /^Terminal font/ })).toBeVisible();
  await expect(app.getByRole('checkbox', { name: /Symbols Nerd Font fallback/ })).toHaveCount(0);
});

test('symbols_font_old_default_migrates: a stored copy of the old default list reads as the new default; a custom list stays', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await app.addInitScript(() => {
    if (sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded', '1');
    localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ termFont: '"SF Mono", Menlo, "D2Coding", monospace' }));
  });
  await openWindow(app);
  await expect.poll(async () => JSON.parse((await stored(app)) ?? '{}').termFont).toBe(DEFAULTS.termFont);
  await app.evaluate(() => localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ termFont: '"Menlo", monospace' })));
  await app.reload();
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  await expect.poll(async () => JSON.parse((await stored(app)) ?? '{}').termFont).toBe('"Menlo", monospace');
});
