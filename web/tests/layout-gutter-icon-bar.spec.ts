// system5 (ticket 196, needs 171, 172): the zone gutter, the icon bar icon's menu and the "..." overflow's keys.
import type { Page } from '@playwright/test';
import { expect, openWindow, test } from './fixtures';
import { icon, layoutCli, readLayout, zone } from './d5b';

test('zone_gutter_double_click_resets: a double-click on a zone gutter returns that zone to the size it was added with', async ({ app, core }) => {
  await openWindow(app);
  await layoutCli(app, core, 'edge right board'); // a zone with a size of its own: the edge size, 264 px
  const gutter = app.locator('.gutter[data-split="row"]').first();
  await expect(gutter).toHaveCount(1);
  const width = async () => Math.round((await zone(app, 'board').boundingBox())!.width);
  await expect.poll(width).toBe(264);
  await gutter.focus();
  await app.keyboard.press('ArrowLeft'); // wider by 16
  await expect.poll(width).toBe(280);
  const g = (await gutter.boundingBox())!; // zero width: the 7 px hit area is its ::before, so the mouse goes to the line
  await app.mouse.dblclick(g.x, g.y + g.height / 2);
  await expect.poll(width).toBe(264);
  await expect.poll(() => readLayout(core)).toContain('size = 264'); // saved too (the file follows the window)
});

const menu = (p: Page) => p.getByRole('menu', { name: 'Actions' });
const names = (p: Page) => menu(p).getByRole('menuitem').evaluateAll((els) => els.map((e) => e.querySelector('.mt')?.textContent));

test('icon_bar_icon_context_menu: right-click on a rail icon offers Hide, Move to the other bar, Open as split; a required widget cannot be hidden', async ({ app, core }) => {
  const s = core.shell(core.project('demo'), 'alpha');
  await openWindow(app, {}, core);
  await app.locator(`.tab[data-tab="${s.id}"]`).click();
  // Files: all three work.
  await icon(app, 'left', 'Files').click({ button: 'right' });
  await expect(menu(app)).toBeVisible();
  expect(await names(app)).toEqual(['Hide', 'Move to the other bar', 'Open as split']);
  for (const id of ['icon.hide', 'icon.move', 'icon.split']) await expect(menu(app).locator(`[data-command="${id}"]`)).not.toHaveAttribute('aria-disabled', 'true');
  await menu(app).getByRole('menuitem', { name: 'Open as split' }).click();
  await expect(app.locator('[data-split-id]')).toHaveCount(1);
  await icon(app, 'left', 'Files').click({ button: 'right' });
  await menu(app).getByRole('menuitem', { name: 'Move to the other bar' }).click();
  await expect(icon(app, 'right', 'Files')).toHaveCount(1);
  await expect(icon(app, 'left', 'Files')).toHaveCount(0);
  await icon(app, 'right', 'Files').click({ button: 'right' });
  await menu(app).getByRole('menuitem', { name: 'Hide' }).click();
  await expect(icon(app, 'right', 'Files')).toHaveCount(0);
  await expect(icon(app, 'left', 'Files')).toHaveCount(0);
  // The Tree is required (needs 100): Hide is off, the others stay.
  await icon(app, 'left', 'Tree').click({ button: 'right' });
  await expect(menu(app).locator('[data-command="icon.hide"]')).toHaveAttribute('aria-disabled', 'true');
  await expect(menu(app).locator('[data-command="icon.move"]')).not.toHaveAttribute('aria-disabled', 'true');
  await menu(app).getByRole('menuitem', { name: 'Hide' }).click({ force: true }); // a greyed item runs nothing
  await expect(icon(app, 'left', 'Tree')).toHaveCount(1);
  // The keyboard path: the menu key on the focused icon.
  await icon(app, 'left', 'Tree').focus();
  await app.keyboard.press('Shift+F10');
  await expect(menu(app)).toBeVisible();
  await app.keyboard.press('Escape');
  await expect(menu(app)).toBeHidden();
  await expect(icon(app, 'left', 'Tree')).toBeFocused();
});

test('icon_bar_overflow_keys: the ⋯ menu takes focus on open, ArrowUp/Down move, Esc closes and gives focus back to ⋯', async ({ app }) => {
  await app.setViewportSize({ width: 1440, height: 300 }); // a short window cuts the right bar's icons off behind ⋯
  await openWindow(app);
  const more = app.locator('nav[data-bar="right"] .more');
  await expect(more).toBeVisible();
  const pop = app.getByRole('menu', { name: 'More icons' });
  const items = pop.getByRole('menuitem');
  await more.click();
  await expect(pop).toBeVisible();
  await expect(items.first()).toBeFocused(); // focus goes in on open
  const n = await items.count();
  expect(n).toBeGreaterThan(1);
  await app.keyboard.press('ArrowDown');
  await expect(items.nth(1)).toBeFocused();
  await app.keyboard.press('ArrowUp');
  await expect(items.first()).toBeFocused();
  await app.keyboard.press('ArrowUp'); // wraps to the last
  await expect(items.nth(n - 1)).toBeFocused();
  await app.keyboard.press('Escape');
  await expect(pop).toBeHidden();
  await expect(more).toBeFocused(); // and back where it was
  // The keyboard opens it too, and Enter on an item runs it.
  await app.keyboard.press('Enter');
  await expect(pop).toBeVisible();
  await expect(items.first()).toBeFocused();
});
