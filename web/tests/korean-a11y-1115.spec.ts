// Lane korean-a11y-1115 (first-use walks 9 and 10): screen-reader names a Korean window spoke in English.
// Ticket 811: a layout resize handle held the zone id. Ticket 812: a key chip's spoken key names were English.
import type { Page } from '@playwright/test';
import { expect, openWindow, test } from './fixtures';

const korean = async (page: Page) => {
  await page.evaluate(() => localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ ...JSON.parse(localStorage.getItem('nunchiro.settings.v1') ?? '{}'), language: 'ko' })));
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'ko');
};

test('ticket 811 resize_handle_names_the_widget: the composer handle reads its widget, never the zone id', async ({ app, core }) => {
  core.agent(core.project('demo'), 'beta', 'x');
  await openWindow(app);
  await expect(app.locator('[data-zone-id="composer"]')).toHaveCount(1);
  await expect(app.getByRole('separator', { name: 'Resize Composer', exact: true })).toHaveCount(1);
  await korean(app);
  await expect(app.getByRole('separator', { name: '입력창 크기 조절', exact: true })).toHaveCount(1);
  await expect(app.getByRole('separator', { name: /composer/ })).toHaveCount(0);
});

test('ticket 812 key_chip_spoken_in_language: a key chip speaks Korean key names in a Korean window', async ({ app, core }) => {
  core.agent(core.project('demo'), 'beta', 'x');
  await openWindow(app);
  // Ticket 1031 removed the status bar's prefix chip, so the English names are read in the palette too.
  const spoken = () => app.getByRole('dialog').locator('.kbd[role="img"]').evaluateAll((e) => e.map((x) => x.getAttribute('aria-label') ?? ''));
  await app.keyboard.press('Meta+KeyK');
  await expect.poll(async () => (await spoken()).some((n) => n.startsWith('Control period, then '))).toBe(true);
  await app.keyboard.press('Escape');
  await korean(app);
  // A key after the prefix, in the palette: "<prefix>, 다음 <key>", no English word.
  await app.keyboard.press('Meta+KeyK');
  const names = await app.getByRole('dialog').locator('.kbd[role="img"]').evaluateAll((e) => e.map((x) => x.getAttribute('aria-label') ?? ''));
  expect(names.some((n) => n.startsWith('컨트롤 마침표, 다음 '))).toBe(true);
  expect(names.filter((n) => /Control|Shift|Command|Option|Space|period|then/.test(n))).toEqual([]);
});
