// system5 (ticket 196, needs 171, 172 "Dialog, popover, menu: Esc closes; arrow keys move in menus; focus returns where it was").
import type { Locator, Page } from '@playwright/test';
import { legacyLayout, openWindow } from './fixtures';
import { layoutButton } from './d5b';
import { append, expect, openChat, rec, test } from './fixtures/chat/harness';

/** The menu-key contract of a popover: focus goes in on open, arrows move (wrapping), Esc closes and focus returns to the button. */
/** `count`: the menu's exact item count when it is known (the + menu has one since 7e654b45); otherwise more than one. */
async function keys(page: Page, button: Locator, menu: Locator, count?: number) {
  const items = menu.getByRole('menuitem');
  await button.click();
  await expect(menu).toBeVisible();
  await expect(items.first()).toBeFocused();
  const n = await items.count();
  if (count) expect(n).toBe(count);
  else expect(n).toBeGreaterThan(1);
  await page.keyboard.press('ArrowDown');
  await expect(items.nth(1 % n)).toBeFocused(); // a single item wraps onto itself
  await page.keyboard.press('ArrowUp');
  await expect(items.first()).toBeFocused();
  await page.keyboard.press('ArrowUp'); // wraps to the last
  await expect(items.nth(n - 1)).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(button).toBeFocused();
}

test('plus_menu_keys: the composer + menu takes focus on open, arrows move, Esc closes and returns focus to +', async ({ page, chatCore }) => {
  const s = chatCore.chat('plus');
  append(s.file, rec.user('hi'), rec.assistant('ok'));
  await openChat(page, s.id);
  await keys(page, page.getByRole('button', { name: 'Add', exact: true }), page.getByRole('menu', { name: 'Add to the message' }), 1);
});

test('notify_level_menu_keys: the notify level menu takes focus on open, arrows move, Esc closes and returns focus to its button', async ({ page, chatCore }) => {
  const s = chatCore.chat('notify');
  append(s.file, rec.user('hi'), rec.assistant('ok'));
  await openChat(page, s.id);
  const button = page.locator('.qlevel-btn');
  await keys(page, button, page.locator('.qlevel-menu'));
});

test('palette_selected_row_scrolls_into_view: with a long list the selected row stays inside the list on Up and Down', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app, {}, core);
  await app.keyboard.press('Meta+KeyK');
  const list = app.locator('#palette-list');
  await expect(list).toBeVisible();
  const rows = await list.locator('[role="option"]').count();
  expect(rows).toBeGreaterThan(25);
  const inside = async () =>
    list.evaluate((ul) => {
      const sel = ul.querySelector('[aria-selected="true"]')!.getBoundingClientRect();
      const box = ul.getBoundingClientRect();
      return sel.top >= box.top - 0.5 && sel.bottom <= box.bottom + 0.5;
    });
  // The list really scrolls (more rows than fit), so the check below means something.
  expect(await list.evaluate((ul) => ul.scrollHeight > ul.clientHeight)).toBe(true);
  for (let i = 0; i < 24; i++) await app.keyboard.press('ArrowDown');
  expect(await inside()).toBe(true);
  await app.keyboard.press('ArrowUp');
  expect(await inside()).toBe(true);
  for (let i = 0; i < 23; i++) await app.keyboard.press('ArrowUp');
  expect(await inside()).toBe(true);
  await expect(list.locator('[aria-selected="true"]')).toHaveAttribute('id', 'cmd-0');
});

test('answer_strip_dialog_esc_keeps: Esc on "Remove the answer strip?" is Keep, the strip stays and focus returns to the remove button', async ({ app, core }) => {
  legacyLayout(core, { strip: 'top' });
  await openWindow(app);
  await layoutButton(app).click();
  const remove = app.locator('[data-zone-id="waiting"]').getByRole('button', { name: 'Remove Answer strip from the Answer strip zone' });
  await remove.focus();
  await app.keyboard.press('Enter');
  const notice = app.getByRole('alertdialog', { name: 'Remove the answer strip?' });
  await expect(notice).toBeVisible();
  await expect(notice.getByRole('button', { name: 'Keep it' })).toBeFocused();
  await app.keyboard.press('Escape');
  await expect(notice).toBeHidden();
  await expect(app.locator('#waiting-strip')).toHaveCount(1); // Keep: nothing was removed
  await expect(remove).toBeFocused(); // and focus is back where it was
  await expect(app.getByRole('toolbar', { name: 'Layout edit' })).toBeVisible(); // Esc closed the dialog only, not Layout edit
});
