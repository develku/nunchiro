// Ticket 1047: Auto-hide the icon bars (the Dock's way): off by default; on, the bars float out of sight and come back at the window edge or on focus.
import { expect, openWindow, test } from './fixtures';
import { bar, stored } from './d5b';
import { cleanBars, defaultBars, toggleBars, toggleBarsAuto } from '../src/layout/bars';

const AUTO = 'Auto-hide icon bars'; // ticket 1093: the command has the window button's words
const run = async (app: import('@playwright/test').Page) => {
  await app.keyboard.press('Meta+KeyK');
  await app.getByRole('combobox').fill(AUTO);
  await app.keyboard.press('Enter');
};
const centre = (app: import('@playwright/test').Page) => app.locator('.body > :not(.ib):not(aside)').first().boundingBox();

test('bars_auto_is_kept_only_when_true: absent stays absent, garbage is dropped, hidden still wins', () => {
  const b = defaultBars();
  expect(toggleBarsAuto(b).barsAuto).toBe(true);
  expect(toggleBarsAuto(toggleBarsAuto(b))).toEqual(b);
  expect(cleanBars(toggleBarsAuto(b))!.barsAuto).toBe(true);
  expect('barsAuto' in cleanBars({ ...b, barsAuto: 'yes' })!).toBe(false);
  expect(toggleBars(toggleBarsAuto(b)).barsHidden).toBe(true);
});

test('rails_autohide: off draws the bars; on hides both, edge and focus bring one back, it is kept, reduced motion has no slide', async ({ app }) => {
  await openWindow(app);
  await expect(bar(app, 'left')).toHaveAttribute('data-bar', 'left');
  expect(await bar(app, 'left').getAttribute('data-auto')).toBeNull();
  const x = (await bar(app, 'left').boundingBox())!.x;
  expect(x).toBe(0);

  await run(app);
  await expect.poll(async () => (await stored(app)).bars.barsAuto).toBe(true);
  await expect(bar(app, 'left')).not.toBeInViewport();
  await expect(bar(app, 'right')).not.toBeInViewport();
  const before = await centre(app);

  await app.mouse.move(2, 400);
  await expect(bar(app, 'left')).toBeInViewport({ ratio: 1 });
  expect(await centre(app)).toEqual(before); // the bar floats over: nothing moves
  await app.mouse.move(700, 400);
  await expect(bar(app, 'left')).not.toBeInViewport();

  await app.mouse.move(1438, 400);
  await expect(bar(app, 'right')).toBeInViewport({ ratio: 1 });
  await app.mouse.move(700, 400);
  await expect(bar(app, 'right')).not.toBeInViewport();

  await app.locator('.title .cmd').focus(); // Tab from the title bar's search button lands in the left bar, which comes back
  await app.keyboard.press('Tab');
  await expect(bar(app, 'left').locator(':focus')).toHaveCount(1);
  await expect(bar(app, 'left')).toBeInViewport({ ratio: 1 });
  await app.evaluate(() => (document.activeElement as HTMLElement).blur());
  await app.mouse.move(700, 400);
  await expect(bar(app, 'left')).not.toBeInViewport();

  await app.reload();
  await expect(bar(app, 'left')).not.toBeInViewport();
  await app.emulateMedia({ reducedMotion: 'reduce' });
  expect(await bar(app, 'left').evaluate((e) => getComputedStyle(e).transitionDuration)).toBe('0s');
});
