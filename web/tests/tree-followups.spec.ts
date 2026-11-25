// Ticket 28 (V2-9a follow-ups 3 to 7): alt-click expand under collapsed projects, one announcement per waiting item,
// the freeze ending when an overlay closes, a group name counted in characters, and refused tree edits shown.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { stripOnTop, expect, openWindow, test, type Core } from './fixtures';
import { openQuiet, seed } from './tree-seed';

test.beforeEach(({ core }) => stripOnTop(core));

const grp = (app: Page, name: string) => app.locator(`.grp[data-project="${name}"]`);
const group = (app: Page, name: string) => app.locator(`.pgrp[data-group="${name}"]`);
const note = (app: Page, text: string) => app.getByRole('alert').filter({ hasText: text });
const arrive = (dir: string, trigger: string) => fs.writeFileSync(path.join(dir, trigger), '');
const toml = (core: Core) => fs.readFileSync(path.join(core.home, 'tree.toml'), 'utf8');
async function palette(app: Page, query: string) {
  await app.keyboard.press('Meta+KeyK');
  await app.locator('.palette input').fill(query);
  await app.keyboard.press('Enter');
}

/** A core that refuses every tree_edit while `refusing`, and answers the first `failLoads` tree_get with an Err. */
async function flaky(app: Page, gate: { refusing: boolean; failLoads: number }) {
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => {
      const msg = typeof m === 'string' ? JSON.parse(m) : null;
      const no = (text: string) => ws.send(JSON.stringify({ id: msg.id, response: { Err: text } }));
      if (msg?.request?.op === 'tree_edit' && gate.refusing) return no(`refused ${msg.request.edit.op}`);
      if (msg?.request?.op === 'tree_get' && gate.failLoads-- > 0) return no('tree.toml unreadable');
      server.send(m);
    });
    server.onMessage((m) => ws.send(m));
  });
}

test('alt_click_opens_worktrees_under_collapsed_projects: Alt-click on Expand all opens a collapsed project and shows its worktree; the next press puts it back', async ({ app, core }) => {
  const p = core.project('repo');
  const git = (...a: string[]) => execFileSync('git', ['-C', p, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a]);
  git('init', '-q');
  git('commit', '-q', '--allow-empty', '-m', 'init');
  core.cli('session', 'start', '--kind', 'shell', '--project', p, '--label', 'feat', '--worktree', '--', '/bin/cat');
  const other = core.project('other');
  core.shell(other, 'o1');
  openQuiet(core, ''); // a project with only a shell is quiet: its line starts folded
  await openWindow(app);
  await app.mouse.move(900, 400);
  const repo = grp(app, 'repo');
  await expect(repo.locator('.row.wt2')).toHaveCount(1);
  await app.getByRole('button', { name: 'Collapse repo' }).click();
  await expect(repo.locator('.row.wt2')).toHaveCount(0);
  await app.getByRole('button', { name: 'Expand all' }).click({ modifiers: ['Alt'] });
  await expect(repo.locator('.row.wt2')).toHaveCount(1);
  await expect(app.getByRole('button', { name: 'Collapse repo' })).toHaveAttribute('aria-expanded', 'true');
  // The chevron still folds a project that Expand all opened.
  await app.getByRole('button', { name: 'Collapse repo' }).click();
  await expect(repo.locator('.row.wt2')).toHaveCount(0);
  // The next press (plain or Alt) puts the folding back; a plain press alone opens no collapsed project.
  await app.getByRole('button', { name: 'Restore' }).click();
  await expect(repo.locator('.row.wt2')).toHaveCount(0);
  await app.getByRole('button', { name: 'Expand all' }).click();
  await expect(app.getByRole('button', { name: 'Restore' })).toBeVisible();
  await expect(repo.locator('.row.wt2')).toHaveCount(0);
});

// (A folded group's chip is the one announcement there: tree-groups.spec.ts pointer_in_tree_shows_new_chip.)
test('one_waiting_item_one_announcement: an open group and its project do not both announce the same new item', async ({ app, core }) => {
  const a = core.project('alpha');
  const b = core.project('beta');
  core.agent(a, 'a1', 'go-1');
  core.shell(b, 'b1');
  seed(core, { op: 'group_create', name: 'Web', project: a });
  openQuiet(core, 'Web');
  await openWindow(app);
  await grp(app, 'beta').locator('.head .n').hover();
  arrive(a, 'go-1');
  await expect(group(app, 'Web').locator('.ghead')).toBeVisible();
  const live = app.locator('aside.dock [role=status][aria-live=polite][aria-label]');
  await expect(live).toHaveCount(1, { timeout: 5000 });
  await expect(grp(app, 'alpha').locator('.head .chip')).toHaveText('new 1');
  await expect(group(app, 'Web').locator('.ghead .chip')).toHaveText('');
});

test('overlay_exit_ends_tree_freeze: closing the menu or the palette ends the freeze at once when the pointer and focus are outside the tree', async ({ app, core }) => {
  core.shell(core.project('alpha'), 'a1');
  core.shell(core.project('beta'), 'b1');
  openQuiet(core, '');
  await openWindow(app);
  const tree = app.locator('aside.dock.l');
  await grp(app, 'alpha').locator('.head .n').hover();
  await expect(tree).toHaveAttribute('data-held', 'true');
  // Context menu: the pointer rides into it, then the click that closes it lands outside the tree.
  await grp(app, 'alpha').locator('.head .n').click({ button: 'right' });
  await expect(app.getByRole('menu', { name: 'Actions' })).toBeVisible();
  await app.mouse.move(900, 400);
  await expect(tree).toHaveAttribute('data-held', 'true'); // the overlay still rides on the freeze
  await app.mouse.click(900, 400);
  await expect(app.getByRole('menu', { name: 'Actions' })).toHaveCount(0);
  await expect(tree).toHaveAttribute('data-held', 'false', { timeout: 1500 });
  // Palette: the same.
  await grp(app, 'beta').locator('.head .n').hover();
  await expect(tree).toHaveAttribute('data-held', 'true');
  await app.keyboard.press('Meta+KeyK');
  await expect(app.locator('.palette input')).toBeVisible();
  await app.mouse.move(900, 400);
  await app.locator('.palette input').blur();
  await app.keyboard.press('Escape');
  await app.mouse.click(900, 400);
  await expect(app.locator('.palette')).toHaveCount(0);
  await expect(tree).toHaveAttribute('data-held', 'false', { timeout: 1500 });
});

test('group_name_max_length_counts_characters: 40 emoji are 80 UTF-16 units and still fit; the 65th character is cut; the core accepts 64', async ({ app, core }) => {
  const a = core.project('alpha');
  core.shell(a, 'a1');
  openQuiet(core, '');
  await openWindow(app);
  await app.mouse.move(900, 400);
  await grp(app, 'alpha').locator('.head .n').click();
  await palette(app, 'New group');
  const field = app.locator('.gname input');
  await field.focus();
  await app.keyboard.insertText('😀'.repeat(40));
  expect([...new Intl.Segmenter().segment(await field.inputValue())]).toHaveLength(40);
  await app.keyboard.insertText('😀'.repeat(30));
  expect([...new Intl.Segmenter().segment(await field.inputValue())]).toHaveLength(64);
  // Hangul syllables count one each, however they were composed.
  await field.fill('');
  await app.keyboard.insertText('가'.repeat(70));
  expect([...(await field.inputValue())]).toHaveLength(64);
  await field.fill('😀'.repeat(64));
  await app.keyboard.press('Enter');
  await expect(app.locator('.gname')).toHaveCount(0);
  await expect.poll(() => toml(core)).toContain('😀'.repeat(64));
});

test('refused_tree_edit_shows_error: a refused pin, remove-from-group and dissolve each show the core\'s message in the sidebar line', async ({ app, core }) => {
  const [a, b, c] = ['alpha', 'beta', 'gamma'].map((n) => core.project(n));
  [a, b, c].forEach((d, i) => core.shell(d, `s${i}`));
  seed(core, { op: 'group_create', name: 'Web', project: a }, { op: 'project_move', project: b, group: 'Web' }, { op: 'group_create', name: 'Site', project: c });
  openQuiet(core, 'Web');
  const gate = { refusing: false, failLoads: 0 };
  await flaky(app, gate);
  await openWindow(app);
  await app.mouse.move(900, 400);
  await grp(app, 'alpha').locator('.head .n').click();
  const before = toml(core);
  gate.refusing = true;
  for (const [id, op] of [['project.pin', 'pin'], ['group.remove', 'project_move'], ['group.dissolve', 'group_dissolve']]) {
    await palette(app, id);
    await expect(note(app, `refused ${op}`)).toBeVisible();
    await note(app, `refused ${op}`).getByRole('button', { name: 'Dismiss' }).click();
  }
  expect(toml(core)).toBe(before);
  await expect(group(app, 'Web').locator('.grp')).toHaveCount(2);
  // A refused rename keeps the dialog and its message, and the sidebar line stays empty. Ticket 534: the core's real
  // refusal of a taken name (tree.rs `duplicate group name Site`) reads as plain words; its own words only under Details.
  gate.refusing = false;
  await grp(app, 'alpha').locator('.head .n').click();
  await palette(app, 'Rename group');
  await app.locator('.gname input').fill('Site');
  await app.keyboard.press('Enter');
  const err = app.locator('.gname #gname-err');
  await expect(err).toHaveText(/^A group named Site already exists\. Choose another name\.Details/);
  await expect(err.locator('details.err-details')).not.toHaveAttribute('open');
  await expect(err.locator('details.err-details')).toContainText('duplicate group name Site');
  await expect(app.getByRole('alert')).toHaveCount(1);
});

test('failing_core_tree_shows_error: a tree load that fails says so, a failed Retry says so again, and a refused edit whose reload also fails still shows the refusal', async ({ app, core }) => {
  const [a, b] = ['alpha', 'beta'].map((n) => core.project(n));
  [a, b].forEach((d, i) => core.shell(d, `s${i}`));
  seed(core, { op: 'group_create', name: 'Web', project: a }, { op: 'project_move', project: b, group: 'Web' });
  openQuiet(core, 'Web');
  const gate = { refusing: false, failLoads: 2 };
  await flaky(app, gate);
  await openWindow(app);
  const line = note(app, 'could not load the project tree');
  await expect(line).toBeVisible();
  await app.mouse.move(900, 400);
  await line.getByRole('button', { name: 'Retry' }).click();
  await expect(line).toBeVisible(); // the second load failed too: the line is still there
  await line.getByRole('button', { name: 'Retry' }).click();
  await app.mouse.move(900, 400);
  await expect(line).toHaveCount(0);
  await expect(group(app, 'Web')).toHaveCount(1);
  // A refusal, then a reload that fails: the refusal is what the user reads.
  await grp(app, 'alpha').locator('.head .n').click();
  gate.refusing = true;
  gate.failLoads = 1;
  await palette(app, 'project.pin');
  await expect(note(app, 'refused pin')).toBeVisible();
});
