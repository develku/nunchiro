// needs 171 (ticket 195, SHOULD 1 of v25-tree-drag-group): "Move to group..." (row menu and palette) and "Remove from group" push the
// same Undo line a drag does. Run in chromium and webkit.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { stripOnTop, expect, openWindow, test, type Core } from './fixtures';
import { openQuiet, seed } from './tree-seed';

test.beforeEach(({ core }) => stripOnTop(core));

/** alpha in Web, beta in Docs, gamma loose; each with a shell so its project row exists. */
async function open(app: Page, core: Core) {
  const [a, b, c] = ['alpha', 'beta', 'gamma'].map((n) => core.project(n));
  [a, b, c].forEach((d, i) => core.shell(d, `s${i}`));
  seed(core, { op: 'group_create', name: 'Web', project: a }, { op: 'group_create', name: 'Docs', project: b });
  openQuiet(core, 'Web', 'Docs', '');
  await openWindow(app);
  await app.mouse.move(900, 400);
}

const head = (app: Page, project: string) => app.locator(`.grp[data-project="${project}"] > .row.head`);
const inGroup = (app: Page, group: string, project: string) => app.locator(`.pgrp[data-group="${group}"] .grp[data-project="${project}"]`);
const undo = (app: Page) => app.locator('footer.status .undoline').getByRole('button', { name: 'Undo' });
const toml = (core: Core) => fs.readFileSync(path.join(core.home, 'tree.toml'), 'utf8');
const menu = (app: Page) => app.getByRole('menu', { name: 'Actions' });

/**
 * The tree holds its rows while the pointer or focus is on it (needs 49). A pointer that leaves the sidebar onto the menu is not
 * "leaving" (the menu is an overlay of it), and the menu then closes under a pointer WebKit never reports leaving, so the rows would
 * wait for the sidebar's 5 s idle bound, as slow as the expect timeout. So park the real pointer away first, then do what the sidebar
 * treats as "the user left" (the window losing focus), and wait for it to say it holds nothing.
 */
async function leave(app: Page) {
  await app.mouse.move(900, 400);
  await app.evaluate(() => window.dispatchEvent(new Event('blur')));
  await expect(app.locator('aside.dock.l')).toHaveAttribute('data-held', 'false');
}

/** "Move to group..." from the right-clicked row's menu, picking `group` in the chooser. */
async function menuMove(app: Page, core: Core, project: string, group: string) {
  await head(app, project).locator('.n').click({ button: 'right' });
  await menu(app).getByRole('menuitem', { name: 'Move to group' }).click();
  await app.locator('.tpick input').fill(group);
  await app.keyboard.press('Enter');
  await expect.poll(() => new RegExp(`name = "${group}"\\s+projects = \\[[^\\]]*${project}"`).test(toml(core))).toBe(true); // the core has it before the tree is let go
  await leave(app);
}

test('tree_menu_move_undo_restores_group: "Move to group..." pushes an Undo line; the Undo button puts the project back', async ({ app, core }) => {
  await open(app, core);
  // From no group.
  await menuMove(app, core, 'gamma', 'Web');
  await expect(inGroup(app, 'Web', 'gamma')).toBeVisible();
  await expect(app.locator('footer.status .undoline')).toContainText('Moved gamma to Web');
  await undo(app).click();
  await expect(inGroup(app, 'Web', 'gamma')).toHaveCount(0);
  await expect(head(app, 'gamma')).toBeVisible();
  // From another group that the move empties: the Undo makes the group again.
  await menuMove(app, core, 'beta', 'Web');
  await expect(inGroup(app, 'Web', 'beta')).toBeVisible();
  await expect(app.locator('.pgrp[data-group="Docs"]')).toHaveCount(0);
  await undo(app).click();
  await expect(inGroup(app, 'Docs', 'beta')).toBeVisible();
  await expect(inGroup(app, 'Web', 'beta')).toHaveCount(0);
});

test('tree_remove_from_group_undo: "Remove from group" pushes an Undo line that puts the project back in the group', async ({ app, core }) => {
  await open(app, core);
  await head(app, 'alpha').locator('.n').click({ button: 'right' });
  await menu(app).getByRole('menuitem', { name: 'Remove from group' }).click();
  await expect.poll(() => toml(core)).not.toMatch(/name = "Web"/); // Web was alpha's alone, so the core dropped it
  await leave(app);
  await expect(inGroup(app, 'Web', 'alpha')).toHaveCount(0);
  await expect(head(app, 'alpha')).toBeVisible();
  await expect(app.locator('footer.status .undoline')).toContainText('Removed alpha from Web');
  await undo(app).click();
  await expect(inGroup(app, 'Web', 'alpha')).toBeVisible();
});

test('tree_menu_move_undo_by_keyboard: Cmd+Z undoes a menu move', async ({ app, core }) => {
  await open(app, core);
  await menuMove(app, core, 'gamma', 'Docs');
  await expect(inGroup(app, 'Docs', 'gamma')).toBeVisible();
  await app.mouse.move(900, 400);
  await app.keyboard.press('Meta+KeyZ');
  await expect(inGroup(app, 'Docs', 'gamma')).toHaveCount(0);
  await expect(head(app, 'gamma')).toBeVisible();
});

// needs 171 (ticket 195, SHOULD of v25-tree-move-index): a move inside the project's own group. The only way to reach it in the
// window is "Move to group..." naming the project's own group (a drag has no own-group target), which appends: the first project
// lands in the last slot and its Undo puts it back at index 0. Slots between (down one, first) have no control in the window; the
// core's index handling for them is `project_move_back_restores_order` (tests/tree_store.rs).

/** Web holds alpha, delta, epsilon in that order; beta is in Docs. */
async function openWeb3(app: Page, core: Core) {
  const [a, d, e, b] = ['alpha', 'delta', 'epsilon', 'beta'].map((n) => core.project(n));
  [a, d, e, b].forEach((p, i) => core.shell(p, `s${i}`));
  seed(core, { op: 'group_create', name: 'Web', project: a }, { op: 'project_move', project: d, group: 'Web' }, { op: 'project_move', project: e, group: 'Web' }, { op: 'group_create', name: 'Docs', project: b });
  openQuiet(core, 'Web', 'Docs', '');
  await openWindow(app);
  await app.mouse.move(900, 400);
  /** The projects of Web as the file lists them. */
  const order = () => {
    const t = toml(core);
    return [a, d, e].map((p) => [t.indexOf(p), p]).sort((x, y) => (x[0] as number) - (y[0] as number)).map(([, p]) => ['alpha', 'delta', 'epsilon'].find((n) => (p as string).endsWith(n)));
  };
  return { order };
}

test('tree_move_within_group_first_last: the first project moved to its own group lands in the last slot', async ({ app, core }) => {
  const { order } = await openWeb3(app, core);
  expect(order()).toEqual(['alpha', 'delta', 'epsilon']);
  await menuMove(app, core, 'alpha', 'Web');
  await expect.poll(order).toEqual(['delta', 'epsilon', 'alpha']);
  await expect(app.locator('footer.status .undoline')).toContainText('Moved alpha to Web');
});

test('tree_undo_within_group_restores_index: the Undo of that move puts the project back at its old slot in the same group', async ({ app, core }) => {
  const { order } = await openWeb3(app, core);
  await menuMove(app, core, 'delta', 'Web'); // the middle one
  await expect.poll(order).toEqual(['alpha', 'epsilon', 'delta']);
  await undo(app).click();
  await expect.poll(order).toEqual(['alpha', 'delta', 'epsilon']);
  await expect(inGroup(app, 'Web', 'delta')).toBeVisible();
});

test('tree_move_same_position_noop: moving the last project to its own group changes nothing and records no Undo', async ({ app, core }) => {
  const { order } = await openWeb3(app, core);
  const before = toml(core);
  await menuMove(app, core, 'epsilon', 'Web');
  await app.waitForTimeout(500); // a core answer would show by now; there is nothing to wait for on a no-op
  expect(toml(core)).toBe(before);
  expect(order()).toEqual(['alpha', 'delta', 'epsilon']);
  await expect(app.locator('footer.status .undoline')).toHaveCount(0);
});
