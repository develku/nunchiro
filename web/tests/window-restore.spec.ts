// Ticket 302 (V2.5-88): every window restores its own tabs; a new window starts from the last written state; the states of
// vanished windows are pruned to a bound. The single-window restore specs stay in shell-chrome.spec.ts / shell-chrome-r2.spec.ts.
import type { Page } from '@playwright/test';
import { PREFIX, WINDOW_MAX } from '../src/chrome/windowState';
import { expect, openWindow, test, type Core } from './fixtures';

const tabIds = (p: Page) => p.locator('.tab[data-tab]').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.tab));
const live = (p: Page) => expect(p.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
const second = async (app: Page, core: Core) => {
  const other = await app.context().newPage();
  await other.addInitScript((boot) => { window.__NUNCHIRO__ = boot; }, core.boot());
  await other.goto('/');
  await live(other);
  return other;
};
const own = (p: Page) => p.evaluate((pre) => Object.keys(localStorage).filter((k) => k.startsWith(pre)).length, PREFIX);

test('window_restore_is_per_window: two windows each reload to their own tabs and focused tab', async ({ app, core }) => {
  const p = core.project('demo');
  const [a, b, c] = ['one', 'two', 'three'].map((l) => core.shell(p, l).id);
  await openWindow(app);
  const other = await second(app, core);
  await expect(other.locator('.tab[data-tab]')).toHaveCount(3);
  await app.locator(`.tab[data-tab="${c}"]`).click({ button: 'middle' });
  await app.locator(`.tab[data-tab="${a}"]`).click();
  await other.locator(`.tab[data-tab="${a}"]`).click({ button: 'middle' });
  await other.locator(`.tab[data-tab="${b}"]`).click();
  await expect(app.locator('.tab[data-tab]')).toHaveCount(2);
  await expect(other.locator('.tab[data-tab]')).toHaveCount(2);
  for (let i = 0; i < 2; i++) { // alternate reloads: the window that wrote last must not decide for the other
    await app.reload();
    await live(app);
    await other.reload();
    await live(other);
    expect(await tabIds(app)).toEqual([a, b]);
    await expect(app.locator(`.tab[data-tab="${a}"]`)).toHaveAttribute('aria-selected', 'true');
    expect(await tabIds(other)).toEqual([b, c]);
    await expect(other.locator(`.tab[data-tab="${b}"]`)).toHaveAttribute('aria-selected', 'true');
  }
});

test('new_window_starts_from_last_closed: a window with no state of its own opens the tabs and focus the last one wrote', async ({ app, core }) => {
  const p = core.project('demo');
  const [a, b, c] = ['one', 'two', 'three'].map((l) => core.shell(p, l).id);
  await openWindow(app);
  await app.locator(`.tab[data-tab="${c}"]`).click({ button: 'middle' });
  await app.locator(`.tab[data-tab="${b}"]`).click();
  await expect(app.locator('.tab[data-tab]')).toHaveCount(2);
  const next = await second(app, core);
  await app.close();
  expect(await tabIds(next)).toEqual([a, b]);
  await expect(next.locator(`.tab[data-tab="${b}"]`)).toHaveAttribute('aria-selected', 'true');
});

test('window_restore_keys_pruned: states of vanished windows are kept to a bound, the newest first', async ({ app, core }) => {
  core.shell(core.project('demo'), 'one');
  const rows = WINDOW_MAX + 12;
  await app.addInitScript(([pre, n]) => {
    if (sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded', '1');
    for (let i = 0; i < n; i++) localStorage.setItem(`${pre}gone-${i}`, JSON.stringify({ tabs: [], active: null, seen: [], scroll: {}, at: 1000 + i }));
    localStorage.setItem(`${pre}broken`, '{');
  }, [PREFIX, rows] as const);
  await openWindow(app);
  await expect.poll(() => own(app)).toBe(WINDOW_MAX); // this window's own state plus the newest vanished ones
  const keys = await app.evaluate((pre) => Object.keys(localStorage).filter((k) => k.startsWith(pre)), PREFIX);
  expect(keys).not.toContain(`${PREFIX}broken`);
  expect(keys).not.toContain(`${PREFIX}gone-0`);
  expect(keys).toContain(`${PREFIX}gone-${rows - 1}`);
});
