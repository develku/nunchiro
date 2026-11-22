// v25f F13 (owner RC feedback 11-08): Cmd+B left sidebar, Cmd+Option+B right sidebar, Cmd+Shift+Backslash both icon bars.
import path from 'node:path';
import { REPO, expect, openWindow, test } from './fixtures';
import { bar, editBar, endEdit, sidebar, stored } from './d5b';
import { cleanBars, defaultBars, members, toggleBars } from '../src/layout/bars';

const SHOTS = path.join(REPO, '.scratch', 'shots-v25f-sidebar-keys');
const HIDE_BARS = 'Shift+Meta+Backslash';

test('bars_hidden_is_kept_only_when_true: absent stays absent, garbage is dropped, the dirty mark ignores it', () => {
  const b = defaultBars();
  const hidden = toggleBars(b);
  expect(hidden.barsHidden).toBe(true);
  expect(toggleBars(hidden)).toEqual(b); // shown again leaves no field behind
  expect(cleanBars(hidden)!.barsHidden).toBe(true);
  expect('barsHidden' in cleanBars(b)!).toBe(false);
  expect('barsHidden' in cleanBars({ ...b, barsHidden: 'yes' })!).toBe(false);
  expect(members(hidden)).toBe(members(b));
});

test('key_hides_and_shows_both_icon_bars: no gap, sidebars untouched, kept across a reload', async ({ app }) => {
  await openWindow(app);
  await app.screenshot({ path: path.join(SHOTS, 'bars-shown.png') });
  const openBefore = await sidebar(app, 'left').getAttribute('data-widget');
  await app.keyboard.press(HIDE_BARS);
  await expect(bar(app, 'left')).toHaveCount(0);
  await expect(bar(app, 'right')).toHaveCount(0);
  await expect(sidebar(app, 'left')).toHaveAttribute('data-widget', openBefore!);
  // No gap: the left sidebar starts at the window edge and the last column ends at the other.
  expect((await sidebar(app, 'left').boundingBox())!.x).toBe(0);
  const body = (await app.locator('.body').boundingBox())!;
  const lastRight = await app.locator('.body').evaluate((e) => Math.round((e.lastElementChild as HTMLElement).getBoundingClientRect().right));
  expect(lastRight).toBe(Math.round(body.x + body.width));
  await app.screenshot({ path: path.join(SHOTS, 'bars-hidden.png') });
  await expect.poll(async () => (await stored(app)).bars.barsHidden).toBe(true);
  await app.reload();
  await expect(sidebar(app, 'left')).toBeVisible();
  await expect(bar(app, 'left')).toHaveCount(0);
  await app.keyboard.press(HIDE_BARS);
  await expect(bar(app, 'left')).toBeVisible();
  await expect(bar(app, 'right')).toBeVisible();
  await expect.poll(async () => (await stored(app)).bars.barsHidden).toBeUndefined();
});

test('palette_shows_hidden_bars: the command brings them back, and Layout edit shows them while it runs', async ({ app }) => {
  await openWindow(app);
  await app.keyboard.press(HIDE_BARS);
  await expect(bar(app, 'left')).toHaveCount(0);
  await app.keyboard.press('Control+Period'); // the Layout icon is hidden with its bar: the key still starts the edit
  await app.keyboard.press('KeyL');
  await editBar(app).waitFor();
  await expect(bar(app, 'left')).toBeVisible();
  await endEdit(app);
  await expect(bar(app, 'left')).toHaveCount(0);
  await app.keyboard.press('Meta+KeyK');
  await app.locator('.palette [data-command="bars.toggle"]').click();
  await expect(bar(app, 'left')).toBeVisible();
});

test('sidebar_keys_toggle_each_side: Cmd+B the left, Cmd+Option+B the right, the bars stay', async ({ app }) => {
  await openWindow(app);
  await expect(sidebar(app, 'right')).toHaveCount(0);
  await app.keyboard.press('Alt+Meta+KeyB');
  await expect(sidebar(app, 'right')).toBeVisible();
  await expect(sidebar(app, 'left')).toBeVisible();
  await app.keyboard.press('Alt+Meta+KeyB');
  await expect(sidebar(app, 'right')).toHaveCount(0);
  await app.keyboard.press('Meta+KeyB');
  await expect(sidebar(app, 'left')).toHaveCount(0);
  await expect(bar(app, 'left')).toBeVisible();
  await app.keyboard.press('Meta+KeyB');
  await expect(sidebar(app, 'left')).toBeVisible();
});
