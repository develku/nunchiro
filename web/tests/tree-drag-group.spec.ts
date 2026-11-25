// needs 171 (ticket 195): a project head dragged onto a group head sends the same project_move the "Move to group..." menu does.
// Pointer events, not HTML5 drag: Playwright drives the real mouse, and WKWebView (Tauri) fires pointer events where native
// drag events can stay silent. Run in chromium and webkit.
import fs from 'node:fs';
import path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { stripOnTop, expect, openWindow, test, type Core } from './fixtures';
import { openQuiet, seed } from './tree-seed';

test.beforeEach(({ core }) => stripOnTop(core));

type Spy = { moves: { project: string; group: string | null }[]; refusing: boolean };
/** Counts every project_move the window sends; `refusing` answers them with an error as a core that refuses would. */
async function spy(app: Page): Promise<Spy> {
  const s: Spy = { moves: [], refusing: false };
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => {
      const msg = typeof m === 'string' ? JSON.parse(m) : null;
      if (msg?.request?.op === 'tree_edit' && msg.request.edit.op === 'project_move') {
        s.moves.push({ project: msg.request.edit.project, group: msg.request.edit.group });
        if (s.refusing) return ws.send(JSON.stringify({ id: msg.id, response: { Err: 'refused project_move' } }));
      }
      server.send(m);
    });
    server.onMessage((m) => ws.send(m));
  });
  return s;
}

/** alpha in Web, beta in Docs, gamma loose; each with a shell so its project row exists. */
async function open(app: Page, core: Core) {
  const [a, b, c] = ['alpha', 'beta', 'gamma'].map((n) => core.project(n));
  [a, b, c].forEach((d, i) => core.shell(d, `s${i}`));
  seed(core, { op: 'group_create', name: 'Web', project: a }, { op: 'group_create', name: 'Docs', project: b });
  openQuiet(core, 'Web', 'Docs', '');
  const s = await spy(app);
  await openWindow(app);
  await app.mouse.move(900, 400);
  return { s, a, b, c };
}

const head = (app: Page, project: string) => app.locator(`.grp[data-project="${project}"] > .row.head`);
const ghead = (app: Page, group: string) => app.locator(`.pgrp[data-group="${group}"] > .row.ghead`);
const inGroup = (app: Page, group: string, project: string) => app.locator(`.pgrp[data-group="${group}"] .grp[data-project="${project}"]`);
const centre = async (l: Locator) => {
  const b = (await l.boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
};
/** Presses on `from` and moves to `to` in steps, leaving the button down. */
async function pick(app: Page, from: Locator, to: Locator) {
  const a = await centre(from);
  const b = await centre(to);
  await app.mouse.move(a.x, a.y);
  await app.mouse.down();
  await app.mouse.move(a.x + 8, a.y + 8, { steps: 3 });
  await app.mouse.move(b.x, b.y, { steps: 8 });
}
const drag = async (app: Page, from: Locator, to: Locator) => (await pick(app, from, to), await app.mouse.up());
const toml = (core: Core) => fs.readFileSync(path.join(core.home, 'tree.toml'), 'utf8');
const label = (app: Page) => app.locator('.droplabel');

test('tree_drag_project_into_group: dragging a project head onto a group head sends one project_move and the project appears under it', async ({ app, core }) => {
  const { s } = await open(app, core);
  await expect(inGroup(app, 'Web', 'gamma')).toHaveCount(0);
  await drag(app, head(app, 'gamma'), ghead(app, 'Web'));
  await expect(inGroup(app, 'Web', 'gamma')).toBeVisible();
  expect(s.moves).toEqual([{ project: core.project('gamma'), group: 'Web' }]);
  await expect.poll(() => toml(core)).toMatch(/Web[\s\S]*gamma/);
});

test('tree_drag_group_head_highlight: the group head shows the highlight and "Move to <group>" only while a project is over it', async ({ app, core }) => {
  await open(app, core);
  await pick(app, head(app, 'gamma'), ghead(app, 'Web'));
  await expect(ghead(app, 'Web')).toHaveAttribute('data-hot', '');
  await expect(label(app)).toHaveText('Move to Web');
  await expect(ghead(app, 'Docs')).not.toHaveAttribute('data-hot', '');
  // Moving on to the other group moves the mark; the row itself has not moved on screen.
  const b = await centre(ghead(app, 'Docs'));
  await app.mouse.move(b.x, b.y, { steps: 4 });
  await expect(label(app)).toHaveText('Move to Docs');
  await expect(ghead(app, 'Web')).not.toHaveAttribute('data-hot', '');
  await expect(head(app, 'gamma')).toBeVisible();
  await app.mouse.up();
  await expect(label(app)).toHaveCount(0);
  await expect(app.locator('[data-hot]')).toHaveCount(0);
});

test('tree_drag_cancel_changes_nothing: Escape during the drag and a drop outside any group head send no edit', async ({ app, core }) => {
  const { s } = await open(app, core);
  const before = toml(core);
  await pick(app, head(app, 'gamma'), ghead(app, 'Web'));
  await expect(label(app)).toHaveText('Move to Web');
  await app.keyboard.press('Escape');
  await expect(label(app)).toHaveCount(0);
  await app.mouse.up(); // the button comes up after the cancel: no drop
  // A drop on empty space (the composer side of the window).
  await pick(app, head(app, 'gamma'), ghead(app, 'Web'));
  await app.mouse.move(900, 400, { steps: 6 });
  await expect(label(app)).toHaveCount(0);
  await app.mouse.up();
  expect(s.moves).toEqual([]);
  expect(toml(core)).toBe(before);
  await expect(inGroup(app, 'Web', 'gamma')).toHaveCount(0);
});

test('tree_drag_same_group_noop: dropping a project on the group it is already in sends nothing and says nothing', async ({ app, core }) => {
  const { s } = await open(app, core);
  await pick(app, head(app, 'alpha'), ghead(app, 'Web'));
  await expect(label(app)).toHaveCount(0);
  await expect(ghead(app, 'Web')).not.toHaveAttribute('data-hot', '');
  await app.mouse.up();
  expect(s.moves).toEqual([]);
  await expect(app.getByRole('alert')).toHaveCount(0);
  await expect(inGroup(app, 'Web', 'alpha')).toBeVisible();
});

test('tree_drag_only_projects_onto_group_heads: no drop on a project row, no drag of a group head, no drag from a session row', async ({ app, core }) => {
  const { s } = await open(app, core);
  // A project row is no target.
  await pick(app, head(app, 'gamma'), head(app, 'alpha'));
  await expect(label(app)).toHaveCount(0);
  await expect(app.locator('[data-hot]')).toHaveCount(0);
  await app.mouse.up();
  // A group head is not dragged: nothing follows the pointer and nothing is a target.
  await pick(app, ghead(app, 'Web'), ghead(app, 'Docs'));
  await expect(app.locator('.pdrag')).toHaveCount(0);
  await expect(label(app)).toHaveCount(0);
  await app.mouse.up();
  // Neither does a session row (the project's own AGENTS row in the tree) start one.
  const row = app.locator('.tree .row:not(.head):not(.ghead):not(.quiet)').first();
  await pick(app, row, ghead(app, 'Web'));
  await expect(app.locator('.pdrag')).toHaveCount(0);
  await expect(label(app)).toHaveCount(0);
  await app.mouse.up();
  expect(s.moves).toEqual([]);
});

test('tree_drag_refused_edit_shows_error: a project_move the core refuses shows its error and the project stays out', async ({ app, core }) => {
  const { s } = await open(app, core);
  s.refusing = true;
  await drag(app, head(app, 'gamma'), ghead(app, 'Web'));
  await expect(app.getByRole('alert').filter({ hasText: 'refused project_move' })).toBeVisible();
  expect(s.moves).toHaveLength(1);
  await expect(inGroup(app, 'Web', 'gamma')).toHaveCount(0);
});

test('tree_drag_move_is_undoable: the status line Undo (and Cmd+Z) puts the project back where it was', async ({ app, core }) => {
  const { s } = await open(app, core);
  const undo = app.locator('footer.status .undoline').getByRole('button', { name: 'Undo' });
  // From no group.
  await drag(app, head(app, 'gamma'), ghead(app, 'Web'));
  await expect(inGroup(app, 'Web', 'gamma')).toBeVisible();
  await undo.click();
  await expect(inGroup(app, 'Web', 'gamma')).toHaveCount(0);
  await expect(head(app, 'gamma')).toBeVisible();
  // From another group, by the keyboard.
  await drag(app, head(app, 'alpha'), ghead(app, 'Docs'));
  await expect(inGroup(app, 'Docs', 'alpha')).toBeVisible();
  await app.mouse.move(900, 400);
  await app.keyboard.press('Meta+KeyZ');
  await expect(inGroup(app, 'Web', 'alpha')).toBeVisible();
  // Web was emptied by alpha leaving it, so the core dropped it and the Undo makes it again with a group_create (not counted here).
  expect(s.moves.map((m) => m.group)).toEqual(['Web', null, 'Docs']);
});

test('tree_drag_lost_release_ends_drag: a release the window never saw (outside it) ends the drag at the next pointer move, with no edit', async ({ app, core }) => {
  const { s } = await open(app, core);
  await pick(app, head(app, 'gamma'), ghead(app, 'Web'));
  await expect(label(app)).toHaveText('Move to Web');
  const b = await centre(ghead(app, 'Docs'));
  await app.evaluate(({ x, y }) => window.dispatchEvent(new PointerEvent('pointermove', { clientX: x, clientY: y, buttons: 0 })), b);
  await expect(label(app)).toHaveCount(0);
  await app.mouse.up();
  expect(s.moves).toEqual([]);
});

test('tree_undo_move_restores_position: the Undo of a move puts a middle project back at its old index, not at the end', async ({ app, core }) => {
  const [a, d, e, b] = ['alpha', 'delta', 'epsilon', 'beta'].map((n) => core.project(n));
  [a, d, e, b].forEach((p, i) => core.shell(p, `s${i}`));
  seed(core, { op: 'group_create', name: 'Web', project: a }, { op: 'project_move', project: d, group: 'Web' }, { op: 'project_move', project: e, group: 'Web' }, { op: 'group_create', name: 'Docs', project: b });
  openQuiet(core, 'Web', 'Docs', '');
  await openWindow(app);
  await app.mouse.move(900, 400);
  const order = () => {
    const t = toml(core);
    return [a, d, e].map((p) => t.indexOf(p));
  };
  const before = order();
  expect(before).toEqual([...before].sort((x, y) => x - y)); // alpha, delta, epsilon
  await drag(app, head(app, 'delta'), ghead(app, 'Docs'));
  await expect(inGroup(app, 'Docs', 'delta')).toBeVisible();
  await app.locator('footer.status .undoline').getByRole('button', { name: 'Undo' }).click();
  await expect(inGroup(app, 'Web', 'delta')).toBeVisible();
  await expect.poll(order).toEqual(before);
});
