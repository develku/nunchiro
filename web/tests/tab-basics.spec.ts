// needs 171 / 172 (Tab basics): middle-click closes, the right-click menu closes this or the others, the arrow keys move
// between tabs. Every close is `closeTab` (it pushes its own Undo and never stops the session). Real core, shells.
import type { Page } from '@playwright/test';
import { expect, openWindow, test, type Core } from './fixtures';

const tab = (p: Page, id: string) => p.locator(`.tab[data-tab="${id}"]`);
const tabIds = (p: Page) => p.locator('.tab').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.tab));
const bar = (p: Page) => p.locator('footer.status');
const undo = (p: Page) => bar(p).getByRole('button', { name: 'Undo' });
const running = (core: Core, id: string) => (core.cli('snapshot', '--json').sessions as { id: string; state: string }[]).find((s) => s.id === id)?.state;
const openFile = async (p: Page, root: string, path = 'notes.txt') => {
  await p.evaluate(([r, f]) => window.dispatchEvent(new CustomEvent('nunchiro:files.open', { detail: { root: r, path: f } })), [root, path]);
  const id = `file:${root}:${path}`;
  await expect(tab(p, id)).toHaveCount(1);
  return id;
};
const middle = (p: Page, id: string) => tab(p, id).click({ button: 'middle' });

test('tab_middle_click_closes_with_undo', async ({ app, core }) => {
  const p = core.project('demo');
  const [a, b] = ['one', 'two'].map((l) => core.shell(p, l).id);
  await openWindow(app);
  const file = await openFile(app, a);
  for (const id of [b, file]) {
    const before = await tabIds(app);
    const at = before.indexOf(id);
    await middle(app, id);
    await expect(tab(app, id)).toHaveCount(0);
    await expect(bar(app).locator('.undoline')).toContainText('tab closed');
    await undo(app).click();
    expect(await tabIds(app)).toEqual(before);
    expect((await tabIds(app)).indexOf(id)).toBe(at);
    await expect(tab(app, id)).toHaveAttribute('aria-selected', 'true');
  }
  // Closing a tab only closes the tab: the session keeps running.
  await middle(app, b);
  await expect(tab(app, b)).toHaveCount(0);
  expect(running(core, b)).toBe('running');
});

test('middle_click_does_not_autoscroll_or_close_through_the_x', async ({ app, core }) => {
  const [a] = ['one'].map((l) => core.shell(core.project('demo'), l).id);
  await openWindow(app);
  // The mouse-down of button 1 is default-prevented (no autoscroll cursor).
  const prevented = await tab(app, a).evaluate((el) => {
    const e = new MouseEvent('mousedown', { button: 1, bubbles: true, cancelable: true });
    el.dispatchEvent(e);
    return e.defaultPrevented;
  });
  expect(prevented).toBe(true);
  await expect(tab(app, a)).toHaveCount(1); // mouse-down alone closes nothing
});

const menu = (p: Page) => p.getByRole('menu', { name: 'Actions' });

test('tab_menu_close_and_others', async ({ app, core }) => {
  const p = core.project('demo');
  const [a, b, c] = ['one', 'two', 'three'].map((l) => core.shell(p, l).id);
  await openWindow(app);
  const file = await openFile(app, a);
  // The menu is there on a session and a file; Close tab acts on the right-clicked one.
  for (const id of [b, file]) {
    await tab(app, id).click({ button: 'right' });
    await expect(menu(app).getByRole('menuitem', { name: 'Close tab' })).toBeVisible();
    await expect(menu(app).getByRole('menuitem', { name: 'Close other tabs' })).toBeVisible();
    await app.keyboard.press('Escape');
  }
  // Session-only commands stay off a file tab's menu.
  await tab(app, file).click({ button: 'right' });
  await expect(menu(app).getByRole('menuitem', { name: /^Rename/ })).toHaveCount(0);
  await app.keyboard.press('Escape');
  // Close tab on the file tab, with its Undo.
  const before = await tabIds(app);
  await tab(app, file).click({ button: 'right' });
  await menu(app).getByRole('menuitem', { name: 'Close tab' }).click();
  await expect(tab(app, file)).toHaveCount(0);
  await undo(app).click();
  expect(await tabIds(app)).toEqual(before);
  // Close other tabs keeps the target and closes every other; one Undo (the store holds one) puts them all back in place.
  await tab(app, b).click({ button: 'right' });
  await menu(app).getByRole('menuitem', { name: 'Close other tabs' }).click();
  expect(await tabIds(app)).toEqual([b]);
  await expect(bar(app).locator('.undoline')).toContainText(`${before.length - 1} tabs closed`);
  await undo(app).click();
  expect(await tabIds(app)).toEqual(before);
  for (const id of [a, c]) expect(running(core, id)).toBe('running');
  // The menu key and Shift+F10 open the same menu from a focused tab.
  await tab(app, b).focus();
  await app.keyboard.press('ContextMenu');
  await expect(menu(app).getByRole('menuitem', { name: 'Close tab' })).toBeVisible();
  await app.keyboard.press('Escape');
  await tab(app, b).focus();
  await app.keyboard.press('Shift+F10');
  await expect(menu(app).getByRole('menuitem', { name: 'Close tab' })).toBeVisible();
});

test('close_other_tabs_is_absent_with_one_tab', async ({ app, core }) => {
  const [a] = ['one'].map((l) => core.shell(core.project('demo'), l).id);
  await openWindow(app);
  expect(await tabIds(app)).toEqual([a]);
  await tab(app, a).click({ button: 'right' });
  await expect(menu(app).getByRole('menuitem', { name: 'Close tab' })).toBeVisible();
  await expect(menu(app).getByRole('menuitem', { name: 'Close other tabs' })).toHaveCount(0);
});

test('tab_arrow_keys', async ({ app, core }) => {
  const p = core.project('demo');
  const ids = ['one', 'two', 'three'].map((l) => core.shell(p, l).id);
  await openWindow(app);
  const order = await tabIds(app);
  expect(order.sort()).toEqual([...ids].sort());
  const [t0, t1, t2] = await tabIds(app) as string[];
  await tab(app, t0).click();
  await tab(app, t0).focus();
  await app.keyboard.press('ArrowRight');
  await expect(tab(app, t1)).toBeFocused();
  await expect(tab(app, t1)).toHaveAttribute('aria-selected', 'true');
  await app.keyboard.press('ArrowLeft');
  await expect(tab(app, t0)).toBeFocused();
  const room = app.locator('[data-room-tab]'); // ticket 571: the project's Room tab is the strip's last stop
  await app.keyboard.press('ArrowLeft'); // wraps to the last stop, the Room tab
  await expect(room).toBeFocused();
  await app.keyboard.press('ArrowLeft');
  await expect(tab(app, t2)).toBeFocused();
  await expect(tab(app, t2)).toHaveAttribute('aria-selected', 'true');
  await app.keyboard.press('ArrowRight');
  await expect(room).toBeFocused();
  await app.keyboard.press('ArrowRight'); // wraps to the first
  await expect(tab(app, t0)).toBeFocused();
  await app.keyboard.press('End');
  await expect(room).toBeFocused();
  await app.keyboard.press('Home');
  await expect(tab(app, t0)).toBeFocused();
  await tab(app, t1).focus();
  await app.keyboard.press('Enter');
  await expect(tab(app, t1)).toHaveAttribute('aria-selected', 'true');
});

test('tab_arrows_do_nothing_in_the_rename_field', async ({ app, core }) => {
  const [a, b] = ['one', 'two'].map((l) => core.shell(core.project('demo'), l).id);
  await openWindow(app);
  await tab(app, a).dblclick();
  const field = app.getByRole('textbox', { name: /^Rename / });
  await expect(field).toBeFocused();
  await field.fill('abc');
  await app.keyboard.press('ArrowLeft');
  await app.keyboard.press('ArrowRight');
  await app.keyboard.press('Home');
  await expect(field).toBeFocused();
  await expect(field).toHaveValue('abc');
  await expect(tab(app, b)).toHaveAttribute('aria-selected', 'false');
});

// A real drive: the tab strip's New session "+" followed the last tab, so it moved with every new tab. It stays at the end.
test('new_session_plus_stays_put_as_tabs_are_added', async ({ app, core }) => {
  const p = core.project('demo');
  const a = core.shell(p, 'one').id;
  await openWindow(app);
  await expect(tab(app, a)).toHaveCount(1);
  const plus = app.locator('.zh > .tadd');
  const x = async () => Math.round((await plus.boundingBox())!.x);
  const before = await x();
  const file = await openFile(app, a);
  await expect(tab(app, file)).toBeVisible();
  await openFile(app, a, 'other.txt');
  expect(await x()).toBe(before);
});
