// V2.5-34 (finding 27, needs 153): the command palette closes on Esc, on a click outside it and after a command runs; it
// lists the plain layout actions by readable name and has no ':' typed command mode (the layout command language stays
// the `nunchiro layout` CLI).
import type { Page } from '@playwright/test';
import { expect, openWindow, test } from './fixtures';

const palette = (app: Page) => app.getByRole('dialog', { name: 'Command palette' });
const open = async (app: Page) => {
  await app.getByRole('button', { name: 'Open command palette' }).click();
  await expect(palette(app)).toBeVisible();
  await expect(palette(app).getByRole('combobox')).toBeFocused();
};

test.beforeEach(async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
});

test.describe('palette_closes', () => {
  test('Esc', async ({ app }) => {
    await open(app);
    await app.keyboard.press('Escape');
    await expect(palette(app)).toHaveCount(0);
  });

  test('Esc after the list was used', async ({ app }) => {
    await open(app);
    await palette(app).getByRole('combobox').fill('split');
    await app.keyboard.press('ArrowDown');
    await app.keyboard.press('Escape');
    await expect(palette(app)).toHaveCount(0);
  });

  test('Esc when focus has left the search field', async ({ app }) => {
    await open(app);
    await app.keyboard.press('Tab');
    await expect(palette(app).getByRole('combobox')).not.toBeFocused();
    await app.keyboard.press('Escape');
    await expect(palette(app)).toHaveCount(0);
  });

  test('click outside', async ({ app }) => {
    await open(app);
    await app.mouse.click(1200, 700);
    await expect(palette(app)).toHaveCount(0);
  });

  test('a click inside keeps it open', async ({ app }) => {
    await open(app);
    await palette(app).getByRole('combobox').click();
    await expect(palette(app)).toBeVisible();
  });

  test('running a command by Enter and by click', async ({ app }) => {
    await open(app);
    // Ticket 1031: was Lock layout / Unlock layout; any command with a visible effect does.
    const bar = app.getByRole('toolbar', { name: 'Layout edit' });
    await palette(app).getByRole('combobox').fill('Edit layout');
    await app.keyboard.press('Enter');
    await expect(palette(app)).toHaveCount(0);
    await expect(bar).toBeVisible();

    await open(app);
    await palette(app).getByRole('option', { name: /^Cancel layout edit/ }).click();
    await expect(palette(app)).toHaveCount(0);
    await expect(bar).toHaveCount(0);
  });
});

test('palette_layout_actions: plain layout actions by name, no ":" command mode', async ({ app }) => {
  await open(app);
  const list = palette(app).getByRole('listbox');
  for (const name of ['Split right', 'Split down', 'Split left', 'Split up', 'Reset layout', 'Undo layout change']) {
    await expect(list.getByRole('option', { name: new RegExp(`^${name}`) }), name).toHaveCount(1);
  }
  await expect(list.getByRole('option', { name: /lock layout/i })).toHaveCount(0); // ticket 1031: the Lock feature is gone
  // ':' is a plain character in the search field: no command mode, nothing typed there is run as a layout command.
  const input = palette(app).getByRole('combobox');
  await input.fill(': split right terminal');
  await expect(input).toHaveValue(': split right terminal');
  await expect(list.getByRole('option')).toHaveCount(0);
  await expect(palette(app).locator('[data-mode], .cmdline, [aria-label*="command line" i]')).toHaveCount(0);
  await expect(app.locator('.estrip input, .lline, [aria-label*="Layout command" i]')).toHaveCount(0);
  await input.fill('layout command');
  await expect(list.getByRole('option', { name: /command line/i })).toHaveCount(0);
});
