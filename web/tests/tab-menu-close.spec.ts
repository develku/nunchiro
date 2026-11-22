// v25-tab-menu-close (ticket 215 B20, C2 tabs, C3; V2.5-56): the tab menu's Close to the right and Close all, tab labels that
// never select, and the active tab scrolling into view. Chromium and WebKit through Playwright, not WKWebView.
import type { Page } from '@playwright/test';
import { expect, openWindow, test } from './fixtures';

const tabIds = (p: Page) => p.locator('.tab[data-tab]').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.tab));
const tab = (p: Page, id: string) => p.locator(`.tab[data-tab="${id}"]`);
const menu = (p: Page) => p.getByRole('menu', { name: 'Actions' });
const reopen = (p: Page) => p.keyboard.press('Shift+Meta+KeyT');

test('tab_menu_close_to_the_right_and_close_all: Close to the right closes the tabs after the clicked one, Close all every tab; both grey out when nothing closes', async ({ app, core }) => {
  const p = core.project('demo');
  const [a, b, c, d] = ['a', 'b', 'c', 'd'].map((l) => core.shell(p, l).id);
  await openWindow(app);
  // The last tab has nothing to its right; Close all is still live.
  await tab(app, d).click({ button: 'right' });
  await expect(menu(app).getByRole('menuitem', { name: 'Close to the right' })).toHaveAttribute('aria-disabled', 'true');
  await expect(menu(app).getByRole('menuitem', { name: 'Close all' })).not.toHaveAttribute('aria-disabled', 'true');
  await app.keyboard.press('Escape');
  // Two clicks: right-click tab 2, then the item.
  await tab(app, b).click({ button: 'right' });
  await menu(app).getByRole('menuitem', { name: 'Close to the right' }).click();
  await expect.poll(() => tabIds(app)).toEqual([a, b]);
  await tab(app, a).click({ button: 'right' });
  await menu(app).getByRole('menuitem', { name: 'Close all' }).click();
  await expect.poll(() => tabIds(app)).toEqual([]);
  // Nothing open: the palette lists both, greyed.
  await app.keyboard.press('Meta+KeyK');
  for (const id of ['tab.close.right', 'tab.close.all']) await expect(app.locator(`.palette [data-command="${id}"]`)).toHaveAttribute('aria-disabled', 'true');
  void c;
});

test('tab_close_right_all_can_be_reopened: the tabs closed by either item come back with ⇧⌘T, in their old order', async ({ app, core }) => {
  const p = core.project('demo');
  const [a, b, c, d] = ['a', 'b', 'c', 'd'].map((l) => core.shell(p, l).id);
  await openWindow(app);
  await tab(app, b).click({ button: 'right' });
  await menu(app).getByRole('menuitem', { name: 'Close to the right' }).click();
  await expect.poll(() => tabIds(app)).toEqual([a, b]);
  await reopen(app);
  await expect.poll(() => tabIds(app)).toEqual([a, b, c]);
  await reopen(app);
  await expect.poll(() => tabIds(app)).toEqual([a, b, c, d]);
  await tab(app, a).click({ button: 'right' });
  await menu(app).getByRole('menuitem', { name: 'Close all' }).click();
  await expect.poll(() => tabIds(app)).toEqual([]);
  await expect(app.locator('.undoline')).toContainText('4 tabs closed'); // ledger v4f-A-S3-5: the toast counts the batch, it does not name one tab
  for (let n = 1; n <= 4; n++) {
    await reopen(app);
    await expect.poll(() => tabIds(app)).toEqual([a, b, c, d].slice(0, n));
  }
});

test('tab_labels_not_selectable: a tab label has user-select none, so a drag or double-click never selects its text', async ({ app, core }) => {
  const a = core.shell(core.project('demo'), 'alpha').id;
  await openWindow(app);
  // A draggable element is unselectable by the browser's own default (Chromium); take that default away so the rule itself is tested.
  const style = await tab(app, a).evaluate((el) => {
    el.removeAttribute('draggable');
    const s = getComputedStyle(el.querySelector('.tname')!) as CSSStyleDeclaration & { webkitUserSelect?: string };
    return s.userSelect || s.webkitUserSelect;
  });
  expect(style).toBe('none');
});

test('active_tab_scrolls_into_view: in an overflowing strip a far tab opened or switched to is fully visible; an already visible active tab leaves the strip where it is', async ({ app, core }) => {
  const p = core.project('demo');
  const ids = Array.from({ length: 30 /* a full strip first narrows its tabs (72px each): 30 still overflow */ }, (_, i) => core.shell(p, `a-fairly-long-tab-name-${i}`).id);
  await openWindow(app);
  const strip = app.locator('.tabs');
  const overflows = () => strip.evaluate((el) => el.scrollWidth > el.clientWidth);
  expect(await overflows()).toBe(true);
  const inView = (id: string) =>
    app.evaluate((id) => {
      const s = document.querySelector('.tabs')!.getBoundingClientRect();
      const r = document.querySelector(`.tab[data-tab="${id}"]`)!.getBoundingClientRect();
      return r.left >= s.left - 1 && r.right <= s.right + 1;
    }, id);
  const left = () => strip.evaluate((el) => el.scrollLeft);
  // Switching to the last tab, then the first, brings each fully into view.
  await tab(app, ids[29]).dispatchEvent('click');
  await expect.poll(() => inView(ids[29])).toBe(true);
  expect(await left()).toBeGreaterThan(0);
  await tab(app, ids[0]).dispatchEvent('click');
  await expect.poll(() => inView(ids[0])).toBe(true);
  expect(await left()).toBe(0);
  // A visible tab: switching to its neighbour does not move the strip.
  await strip.evaluate((el) => (el.scrollLeft = 40));
  const before = await left();
  const visible = await app.evaluate(() => {
    const s = document.querySelector('.tabs')!.getBoundingClientRect();
    return [...document.querySelectorAll<HTMLElement>('.tab[data-tab]')].find((t) => t.getBoundingClientRect().left >= s.left + 1 && t.getBoundingClientRect().right <= s.right - 1)!.dataset.tab!;
  });
  await tab(app, visible).dispatchEvent('click');
  await app.waitForTimeout(300);
  expect(await left()).toBe(before);
  // Seventh look (A S3-5): after a relaunch the strip shows the active tab (it came back at its start, the active tab out of view).
  await tab(app, ids[29]).dispatchEvent('click');
  await expect.poll(() => inView(ids[29])).toBe(true);
  await app.reload();
  await expect(tab(app, ids[29])).toHaveAttribute('aria-selected', 'true');
  await app.waitForTimeout(500);
  expect(await inView(ids[29])).toBe(true);
});

// Look 1117 v5 A S3-2: a scrolled strip gave no sign of tabs cut off at its start, and the Room tab scrolled out of view.
test('scrolled_strip_marks_its_cut_and_keeps_the_room_tab', async ({ app, core }) => {
  const p = core.project('demo');
  const ids = Array.from({ length: 30 }, (_, i) => core.shell(p, `a-fairly-long-tab-name-${i}`).id);
  await openWindow(app);
  const strip = app.locator('.tabs');
  const room = app.locator('.tabs [data-room-tab]');
  const roomInView = () =>
    app.evaluate(() => {
      const s = document.querySelector('.tabs')!.getBoundingClientRect();
      const r = document.querySelector('.tabs [data-room-tab]')!.getBoundingClientRect();
      return r.width > 0 && r.left >= s.left - 1 && r.right <= s.right + 1;
    });
  await expect(room).toHaveCount(1);
  expect(await strip.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  expect(await roomInView()).toBe(true); // at the start the Room tab is still at the strip's end
  await expect(strip).not.toHaveAttribute('data-cut-start');
  // Looks v5 to v8 (A S3-2): the tabs cut off at the end are marked before any scroll, and fade into the Room tab's edge.
  await expect(strip).toHaveAttribute('data-cut-end', '');
  expect(await room.evaluate((el) => getComputedStyle(el.closest('.tabw')!, '::before').width)).toBe('24px');
  await tab(app, ids[15]).dispatchEvent('click');
  await expect(strip).toHaveAttribute('data-cut-start', '');
  expect(await roomInView()).toBe(true);
  // The last tab opened is in view left of the pinned Room tab, not under it.
  await tab(app, ids[29]).dispatchEvent('click');
  await expect
    .poll(() => app.evaluate((id) => document.querySelector(`.tab[data-tab="${id}"]`)!.closest('.tabw')!.getBoundingClientRect().right <= document.querySelector('.tabs [data-room-tab]')!.closest('.tabw')!.getBoundingClientRect().left + 1, ids[29]))
    .toBe(true);
  await expect(strip).not.toHaveAttribute('data-cut-end'); // the last tab is in view: nothing is cut at the end
  await tab(app, ids[0]).dispatchEvent('click');
  await expect(strip).not.toHaveAttribute('data-cut-start');
  await expect(strip).toHaveAttribute('data-cut-end', '');
});
