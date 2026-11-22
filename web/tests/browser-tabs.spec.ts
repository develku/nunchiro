// Ticket 328 part 1: My browser's tab strip. The native views need the app, so its bridge is faked and every call is
// recorded (as browser-view.spec.ts); one view per tab is the app's `rules_of` (mod.rs), unit-tested there.
import type { Page } from '@playwright/test';
import { expect, openWindow, test } from './fixtures';
import { icon, sidebar } from './d5b';

type Call = [string, Record<string, unknown>];
const fakeApp = (page: Page) =>
  page.addInitScript(() => {
    const w = window as unknown as { __calls: Call[]; __TAURI_INTERNALS__: unknown };
    w.__calls = [];
    w.__TAURI_INTERNALS__ = { invoke: (cmd: string, args: Record<string, unknown>) => (w.__calls.push([cmd, args]), Promise.resolve(null)), transformCallback: () => 1, metadata: {} };
  });
const calls = (page: Page, cmd: string) => page.evaluate((c) => (window as unknown as { __calls: Call[] }).__calls.filter((x) => x[0] === c).map((x) => x[1]), cmd);
const stored = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('nunchiro.browser.tabs.v1') ?? 'null'));

const open = async (page: Page) => {
  const side = sidebar(page, 'right');
  if (!(await side.getByLabel('Address').isVisible().catch(() => false))) await icon(page, 'right', 'Browser').click();
  await expect(side.getByLabel('Address')).toBeVisible();
  return side;
};

test('browser_tabs_open_switch_close_and_come_back', async ({ app, core }) => {
  await fakeApp(app);
  await openWindow(app, {}, core);
  const side = await open(app);
  const strip = side.getByRole('tablist', { name: 'Browser tabs' });
  const tabs = strip.getByRole('tab');
  const bar = side.getByLabel('Address');
  await expect(tabs).toHaveText(['New tab']);

  // Tab 1: the "you" space. A secret-looking query parameter and the fragment never reach storage.
  await bar.fill('http://127.0.0.1:5731/one?q=cats&access_token=abc#id_token=xyz');
  await bar.press('Enter');
  await expect(tabs).toHaveText(['127.0.0.1:5731']);
  await expect.poll(async () => [...new Set((await calls(app, 'browser_show')).map((c) => c.space))]).toEqual(['you']);
  expect((await stored(app)).tabs[0].url).toBe('http://127.0.0.1:5731/one?q=cats');
  expect(JSON.stringify(await stored(app))).not.toMatch(/abc|xyz/);

  // Tab 2: its own space, so its own native view.
  await side.getByRole('button', { name: 'New browser tab' }).click();
  await expect(tabs).toHaveText(['127.0.0.1:5731', 'New tab']);
  await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
  await expect(bar).toHaveValue('');
  await bar.fill('http://localhost:5732/two');
  await bar.press('Enter');
  await expect(tabs).toHaveText(['127.0.0.1:5731', 'localhost:5732']);
  // Round 2: the hover shows the whole title and address; a tab in the narrow pane keeps a few letters (strip scrolls past that).
  // Ticket 997 L7 (mockup docs/design/browser-widget-1119.html `.tab`): the close sits inside the pill, whose floor is 56 px.
  await expect(tabs.nth(1)).toHaveAttribute('data-tip', 'localhost:5732 · http://localhost:5732/two');
  expect((await strip.locator('.bt').nth(0).boundingBox())!.width).toBeGreaterThanOrEqual(56);
  await expect.poll(async () => (await calls(app, 'browser_show')).some((c) => c.space !== 'you')).toBe(true);
  const second = (await calls(app, 'browser_show')).find((c) => c.space !== 'you')!.space as string;
  expect(second).toMatch(/^you:[A-Za-z0-9]{1,16}$/);

  // A click switches; the address bar is the shown tab's.
  await tabs.nth(0).click();
  await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true');
  await expect(bar).toHaveValue('http://127.0.0.1:5731/one?q=cats&access_token=abc#id_token=xyz'); // this run's bar text, not storage
  await expect.poll(async () => (await calls(app, 'browser_hide')).map((c) => c.space)).toContain(second);

  // Keys: next, previous, close (rebindable commands, Settings > Keys): the prefix (⌃.), then } { W.
  await app.keyboard.press('Control+Period');
  await app.keyboard.press('Shift+BracketRight');
  await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
  await app.keyboard.press('Control+Period');
  await app.keyboard.press('Shift+BracketLeft');
  await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true');
  await app.keyboard.press('Control+Period');
  await app.keyboard.press('Shift+KeyW');
  await expect(tabs).toHaveText(['localhost:5732']);
  await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true');
  await expect.poll(async () => (await calls(app, 'browser_forget')).map((c) => c.space)).toEqual(['you']);

  // Reload the window: the remaining tab and its address come back, and its page opens again when shown.
  await app.reload();
  const again = await open(app);
  await expect(again.getByRole('tablist', { name: 'Browser tabs' }).getByRole('tab')).toHaveText(['localhost:5732']);
  await expect(again.getByLabel('Address')).toHaveValue('http://localhost:5732/two');
  await expect.poll(async () => (await calls(app, 'browser_show')).map((c) => [c.space, c.url])).toContainEqual([second, 'http://localhost:5732/two']);
});

test('browser_tab_middle_click_and_new_tab_key', async ({ app, core }) => {
  await fakeApp(app);
  await openWindow(app, {}, core);
  const side = await open(app);
  const tabs = side.getByRole('tablist', { name: 'Browser tabs' }).getByRole('tab');
  await side.getByLabel('Address').click();
  await app.keyboard.press('Control+Period');
  await app.keyboard.press('Shift+KeyT');
  await expect(tabs).toHaveText(['New tab', 'New tab']);
  await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
  await tabs.nth(1).click({ button: 'middle' });
  await expect(tabs).toHaveCount(1);
  // The last tab gives way to an empty one: the strip never goes empty.
  await side.getByRole('button', { name: 'Close New tab' }).click();
  await expect(tabs).toHaveText(['New tab']);
  expect((await stored(app)).tabs[0].id).toMatch(/^you:/);
});
