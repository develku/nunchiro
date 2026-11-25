// Ticket 1063: finished worktree rows leave the sessions tree, as ticket 1022's main-folder rows do. A worktree row whose
// sessions all ended (none failed) leaves (at once when all are closed or its record is gone) and counts in the head's
// hollow bars; a live or failed one stays. "Clear finished" on the project head closes the ended sessions and removes the
// merged, empty and gone worktrees, never one with uncommitted files. "Move to done" works on a worktree row.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, openWindow, test, type Core } from './fixtures';
import { patchSnapshots } from './tree-mock-states';
import { openQuiet } from './tree-seed';

const repo = (core: Core, name = 'repo') => {
  const p = core.project(name);
  const git = (...a: string[]) => execFileSync('git', ['-C', p, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a]);
  git('init', '-q', '-b', 'main');
  git('commit', '-q', '--allow-empty', '-m', 'init');
  return p;
};
type Listed = { path: string; branch: string };
const create = (core: Core, p: string, branch: string) => (core.cli('worktree', 'create', '--project', p, '--branch', branch, '--no-focus').worktrees as Listed[]).find((w) => w.branch === branch)!;
const openIn = (core: Core, w: Listed) => core.cli('worktree', 'open', '--path', w.path, '--no-focus').session as { id: string };
const listed = (core: Core) => (core.cli('worktree', 'list').worktrees as Listed[]).map((w) => w.branch);
const state = (core: Core, id: string) => (core.cli('snapshot', '--json').sessions as { id: string; state: string }[]).find((s) => s.id === id)?.state ?? 'gone';
const row = (app: Page, name: string) => app.locator('.tree .row.wt2', { hasText: name });
const head = (app: Page, name: string) => app.locator(`.grp[data-project="${name}"] > .row.head`);
const start = (core: Core, p: string) => (core.shell(p, 'main-shell'), openQuiet(core));

test('closed_worktree_row_leaves: a worktree row whose only session is closed is not in the tree and counts in the head', async ({ app, core }) => {
  const p = repo(core);
  start(core, p);
  const w = create(core, p, 'feature/closed');
  core.cli('session', 'close', openIn(core, w).id);
  await openWindow(app);
  await expect(row(app, 'main-shell')).toBeVisible();
  await expect(row(app, 'feature/closed')).toHaveCount(0);
  await expect(head(app, 'repo').locator('.dbar')).toHaveAttribute('data-done-bars', '1');
});

test('rows_without_record_and_mixed_rows: no record makes no row; a closed and a running session keep it; a failed row stays', async ({ app, core }) => {
  const dir = core.project('demo');
  core.shell(dir, 'keep');
  core.shell(dir, 'lost');
  core.shell(dir, 'boom');
  // `wt` puts a session in `<project>/.wt/<label with \W as ->`: "pair a" and "pair-a" share one folder, so one row.
  core.shell(dir, 'pair a');
  const closed = core.shell(dir, 'pair-a');
  core.cli('session', 'close', closed.id);
  const set = await patchSnapshots(app);
  await openWindow(app);
  set({ lost: { wt: true, exited: true }, boom: { wt: true, failed: true }, 'pair a': { wt: true }, 'pair-a': { wt: true } });
  await expect(row(app, 'boom')).toBeVisible();
  await expect(row(app, 'pair')).toHaveCount(1);
  await expect(row(app, 'lost')).toHaveCount(0); // its worktree record is gone: the closed session's folder brings no row back
});

test('clear_finished: the head action closes the ended sessions, removes the clean worktree and keeps the one with uncommitted files', async ({ app, core }) => {
  const p = repo(core);
  start(core, p);
  const done = core.shell(p, 'done-1', '/usr/bin/true');
  const clean = create(core, p, 'feature/clean');
  core.cli('session', 'close', openIn(core, clean).id);
  const dirty = create(core, p, 'feature/dirty');
  fs.writeFileSync(path.join(dirty.path, 'lost.txt'), 'x');
  await expect.poll(() => state(core, done.id)).toBe('exited');
  await openWindow(app);
  await expect(row(app, 'feature/dirty')).toBeVisible(); // no session yet: a new worktree, not a finished one
  await head(app, 'repo').locator('[data-menu]').first().click({ button: 'right' });
  await app.getByRole('menu', { name: 'Actions' }).getByRole('menuitem', { name: 'Clear finished' }).click();
  await expect.poll(() => state(core, done.id)).not.toBe('exited');
  await expect.poll(() => listed(core)).toEqual(['feature/dirty']);
  await expect(app.getByText('Kept the worktrees with unsaved work: feature/dirty')).toBeVisible();
  expect(fs.readFileSync(path.join(dirty.path, 'lost.txt'), 'utf8')).toBe('x');
  await expect(row(app, 'feature/dirty')).toBeVisible();
});

test('move_to_done_on_worktree_row: the worktree row menu moves its idle session to done and the row leaves', async ({ app, core }) => {
  const p = repo(core);
  start(core, p);
  const w = create(core, p, 'feature/calm');
  const s = openIn(core, w);
  await openWindow(app);
  const r = app.locator(`.tree button.row.wt2[data-menu-session="${s.id}"]`);
  await expect(app.locator(`[data-wt="${w.path}"]`)).toBeVisible(); // the row's worktree menu needs the worktree list read
  await r.click({ button: 'right' });
  await app.getByRole('menu').locator('[data-command="session.settle"]').click();
  await expect(r).toHaveCount(0);
  expect(state(core, s.id)).toBe('running');
  await expect(head(app, 'repo').locator('.dbar')).toHaveAttribute('data-done-bars', '1');
});
