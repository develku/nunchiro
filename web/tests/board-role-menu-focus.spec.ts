// Ticket 297 item 9 (needs 213): Tab out of the open role menu, then a role count change must not pull focus back to item 1.
// The menu's focus on open and when roles arrive late stay as board_role_menu_* in board-edit-views.spec.ts.
import { expect, test } from './fixtures';
import { openBoard, seed } from './fixtures/board/coord';

test('board_role_menu_tab_out_keeps_focus: after Tab leaves the menu a new role does not move focus', async ({ app, core }) => {
  const s = core.shell(core.project('demo'), 'Worker');
  const role = (id: string, r: string) => ({ id, title: `Card ${r}`, column: 'todo', attachments: [{ session_id: s.id, role: r }] });
  seed(core, [role('r1', 'build'), role('r2', 'docs')]);
  const board = await openBoard(app, core);
  const add = board.locator('.bstrip').getByRole('button', { name: '+ filter' });
  await add.click();
  const menu = board.getByRole('menu', { name: 'Role filter' });
  const item = (r: string) => menu.getByRole('menuitemcheckbox', { name: `role: ${r}` });
  await expect(item('build')).toBeFocused();
  await app.keyboard.press('Tab'); // items are tabindex -1: Tab leaves the menu, which stays open
  await expect(menu.locator(':focus')).toHaveCount(0);
  const out = await app.evaluate(() => document.activeElement?.tagName ?? '');
  expect(out).not.toBe('BODY');
  seed(core, [role('r1', 'build'), role('r2', 'docs'), role('r3', 'review')]);
  await expect(item('review')).toBeVisible(); // the count changed, 2 -> 3
  await expect(menu.locator(':focus')).toHaveCount(0);
  await expect(item('build')).not.toBeFocused();
});

// docs/areas/system.md "Basic interactions" for a menu: Esc closes and focus returns, arrows move, a click works as well as a key.
// The long walk (wrap, Home/End, outside click) stays in board_role_menu_keyboard (board-edit-views.spec.ts).
test('role_menu_basics_unchanged: opens focused on item 1, arrows move, a click picks, Esc closes and returns focus to the button', async ({ app, core }) => {
  const s = core.shell(core.project('demo'), 'Worker');
  seed(core, [{ id: 'r1', title: 'One', column: 'todo', attachments: [{ session_id: s.id, role: 'build' }] }, { id: 'r2', title: 'Two', column: 'todo', attachments: [{ session_id: s.id, role: 'docs' }] }]);
  const board = await openBoard(app, core);
  const add = board.locator('.bstrip').getByRole('button', { name: '+ filter' });
  await add.click();
  const menu = board.getByRole('menu', { name: 'Role filter' });
  const item = (r: string) => menu.getByRole('menuitemcheckbox', { name: `role: ${r}` });
  await expect(item('build')).toBeFocused();
  await app.keyboard.press('ArrowDown');
  await expect(item('docs')).toBeFocused();
  await item('docs').click();
  await expect(item('docs')).toHaveAttribute('aria-checked', 'true');
  await app.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(add).toBeFocused();
});
