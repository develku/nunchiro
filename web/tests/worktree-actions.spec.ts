// V2-8a (WTDIALOGS Draft 1 "One-click+"): the worktree actions in the tree and the palette, through the real core and
// real git repos under the test home. The PR chip (V2-8b) is the only reply patched: no transcript names a PR here.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, openWindow, test, type Core } from './fixtures';
import { FIELDS } from '../src/settings';
import { openQuiet } from './tree-seed';

const repo = (core: Core, name = 'repo') => {
  const p = core.project(name);
  const git = (...a: string[]) => execFileSync('git', ['-C', p, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a]);
  git('init', '-q', '-b', 'main');
  git('commit', '-q', '--allow-empty', '-m', 'init');
  return p;
};
const git = (dir: string, ...a: string[]) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
const branches = (p: string) => git(p, 'branch', '--list', '--format=%(refname:short)').split('\n').filter(Boolean);
type Listed = { path: string; branch: string; label: string };
const create = (core: Core, p: string, branch: string) => (core.cli('worktree', 'create', '--project', p, '--branch', branch, '--no-focus').worktrees as Listed[]).find((w) => w.branch === branch)!;
const row = (app: Page, name: string) => app.locator('.row.wt2').filter({ hasText: name }).first();
/** A project row in the tree needs a session; the main folder's shell is enough. An idle project starts folded in its quiet line: opened first. */
const start = async (app: Page, core: Core, p: string) => (core.shell(p, 'main-shell'), openQuiet(core), openWindow(app));

test('create_one_field_forms: Cmd+N, one field; text, empty and Option+Enter; closes on submit with a progress row', async ({ app, core }) => {
  const p = repo(core);
  // Hold the create's reply so the progress row can be seen; everything else passes straight through.
  let release = () => {};
  const held = new Promise<void>((r) => (release = r));
  const pending = new Set<number>();
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => {
      const r = typeof m === 'string' ? JSON.parse(m) : null;
      if (r?.request?.op === 'worktree' && r.request.operation === 'create' && r.request.from === 'Fix the login') pending.add(r.id);
      server.send(m);
    });
    server.onMessage(async (m) => {
      if (typeof m === 'string' && pending.has(JSON.parse(m).id)) await held;
      ws.send(m);
    });
  });
  await start(app, core, p);
  await app.keyboard.press('Meta+KeyN');
  const dialog = app.getByRole('dialog', { name: 'New worktree' });
  await expect(dialog.getByRole('textbox')).toHaveCount(1);
  await app.keyboard.type('Fix the login');
  await app.keyboard.press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect(app.getByRole('status', { name: 'Creating worktree Fix the login' })).toBeVisible();
  release();
  await expect(row(app, 'fix-the-login')).toBeVisible();
  await expect(app.getByRole('status', { name: /Creating worktree/ })).toHaveCount(0);
  expect(branches(p)).toContain('fix-the-login');
  // Empty Enter: an auto name.
  await app.keyboard.press('Meta+KeyN');
  await app.keyboard.press('Enter');
  await expect.poll(() => branches(p).filter((b) => /^wt-[0-9a-f]{4}$/.test(b)).length).toBe(1);
  // Option+Enter: Advanced shows base and branch; the override is the branch.
  await app.keyboard.press('Meta+KeyN');
  await app.keyboard.type('anything');
  await app.keyboard.press('Alt+Enter');
  await expect(dialog.getByRole('textbox', { name: 'Base branch' })).toBeFocused();
  await expect(dialog.getByRole('textbox', { name: 'Branch name' })).toBeVisible();
  await dialog.getByRole('textbox', { name: 'Branch name' }).fill('chosen');
  await app.keyboard.press('Enter');
  await expect.poll(() => branches(p)).toContain('chosen');
  // A pasted PR URL: the head branch through gh (stubbed on the core's PATH). Ticket 374: the PR's code is fetched from
  // the remote that is its repository (a local bare one stands in for github.com/acme/app), or nothing is made.
  const bare = path.join(path.dirname(p), 'app.git');
  execFileSync('git', ['clone', '-q', '--bare', p, bare]);
  for (const n of [7, 8]) execFileSync('git', ['-C', bare, 'update-ref', `refs/pull/${n}/head`, 'HEAD']);
  execFileSync('git', ['-C', p, 'remote', 'add', 'origin', 'https://github.com/acme/app.git']);
  execFileSync('git', ['-C', p, 'config', `url.${bare}.insteadOf`, 'https://github.com/acme/app.git']);
  fs.writeFileSync(path.join(core.home, 'bin/gh'), `#!/bin/sh\necho '{"headRefName":"feature/from-pr"}'\n`, { mode: 0o700 });
  await app.keyboard.press('Meta+KeyN');
  await app.keyboard.insertText('https://github.com/acme/app/pull/7');
  await app.keyboard.press('Enter');
  await expect.poll(() => branches(p)).toContain('feature/from-pr');
  // gh failing: the fallback name, created all the same.
  fs.writeFileSync(path.join(core.home, 'bin/gh'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  await app.keyboard.press('Meta+KeyN');
  await app.keyboard.insertText('https://github.com/acme/app/pull/8');
  await app.keyboard.press('Enter');
  await expect.poll(() => branches(p)).toContain('pr-8');
  // Esc cancels: nothing is created.
  const n = branches(p).length;
  await app.keyboard.press('Meta+KeyN');
  await app.keyboard.type('never');
  await app.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  expect(branches(p).length).toBe(n);
});

test('remove_dirty_tree_asks_first: the sheet lists the loss, Cancel has focus, the only other button discards', async ({ app, core }) => {
  const p = repo(core);
  const w = create(core, p, 'dirty');
  fs.writeFileSync(path.join(w.path, 'lost.txt'), 'x');
  // Git-ignored: a remove deletes it too, so the sheet lists it (build output is not listed).
  fs.writeFileSync(path.join(p, '.git/info/exclude'), '.env\nnode_modules/\n');
  fs.writeFileSync(path.join(w.path, '.env'), 'SECRET=1');
  fs.mkdirSync(path.join(w.path, 'node_modules'));
  fs.writeFileSync(path.join(w.path, 'node_modules/i.js'), '1');
  fs.writeFileSync(path.join(w.path, 'kept.txt'), 'k');
  git(w.path, 'add', 'kept.txt');
  git(w.path, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'unpushed work');
  await start(app, core, p);
  await row(app, 'dirty').focus();
  await app.keyboard.press('Backspace');
  const sheet = app.getByRole('alertdialog', { name: 'dirty has unsaved work' });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole('region', { name: 'Lost if discarded' })).toContainText('?? lost.txt');
  await expect(sheet.getByRole('region', { name: 'Not pushed' })).toContainText('unpushed work');
  await expect(sheet.getByRole('region', { name: 'Git-ignored, deleted too' }).getByRole('listitem')).toHaveText(['!! .env']);
  await expect(sheet.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await expect(sheet.getByRole('button')).toHaveText(['Cancel', 'Discard and remove']);
  await expect(sheet.getByRole('button', { name: /\b(commit|move|stash|push)\b/i })).toHaveCount(0);
  // Tab stays inside; Cancel removes nothing.
  await app.keyboard.press('Tab');
  await app.keyboard.press('Tab');
  await expect(sheet.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await app.keyboard.press('Enter');
  await expect(sheet).toHaveCount(0);
  expect(fs.existsSync(w.path)).toBe(true);
  await row(app, 'dirty').focus();
  await app.keyboard.press('Backspace');
  await sheet.getByRole('button', { name: 'Discard and remove' }).click();
  await expect.poll(() => fs.existsSync(w.path)).toBe(false);
  expect(branches(p)).toContain('dirty');
});

test('A3 remove_live_asks_to_stop: a remove with a running session names it and stops it and removes in one step', async ({ app, core }) => {
  const p = repo(core);
  const w = create(core, p, 'busy');
  core.shell(w.path, 'busy-shell');
  await start(app, core, p);
  const sheet = app.getByRole('alertdialog', { name: 'busy has running sessions' });
  // The row acts as a worktree once the worktree list has come (later than the session under a loaded run). Before
  // that it is a plain session row, where the test browser reads Backspace as "back" and leaves the page: wait for it.
  await expect(app.locator(`[data-wt="${w.path}"]`)).toBeVisible();
  await expect(async () => {
    await row(app, 'busy').focus();
    await app.keyboard.press('Backspace');
    await expect(sheet).toBeVisible({ timeout: 1000 });
  }).toPass();
  await expect(sheet.getByRole('region', { name: 'Stopped if removed' }).getByRole('listitem')).toHaveText(['busy-shell']);
  await expect(sheet.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await sheet.getByRole('button', { name: 'Stop 1 session and remove' }).click();
  await expect(sheet).toHaveCount(0);
  await expect.poll(() => fs.existsSync(w.path)).toBe(false);
  await expect(app.getByRole('status').filter({ hasText: 'Removed busy · branch kept' })).toBeVisible();
});

// A2 (look 1117): after "Stop 1 session and remove" the core has no session and no worktree at once, but the row stayed
// about 10 s: the pointer still over the tree held its rows. A hold may keep the order, never a row that is gone.
test('A2 removed_worktree_row_leaves_while_tree_holds', async ({ app, core }) => {
  const p = repo(core);
  const w = create(core, p, 'busy');
  core.shell(w.path, 'busy-shell');
  await start(app, core, p);
  const sheet = app.getByRole('alertdialog', { name: 'busy has running sessions' });
  await expect(async () => {
    await row(app, 'busy').click({ button: 'right' });
    await app.getByRole('menu', { name: 'Actions' }).locator('[data-command="worktree.remove"]').click({ timeout: 1000 });
    await expect(sheet).toBeVisible({ timeout: 1000 });
  }).toPass();
  await sheet.getByRole('button', { name: 'Stop 1 session and remove' }).click();
  const tree = app.locator('.tree').first();
  const box = (await tree.boundingBox())!;
  await app.mouse.move(box.x + box.width / 2, box.y + box.height - 20); // the pointer rests over the tree, as after the dialog
  await expect.poll(() => fs.existsSync(w.path)).toBe(false);
  await app.mouse.move(box.x + box.width / 2, box.y + box.height - 24);
  await expect(app.locator('.row.wt2').filter({ hasText: 'busy' })).toHaveCount(0, { timeout: 1000 });
});

test('clean_remove_no_dialog_branch_kept: no dialog, the branch stays, a toast offers Undo that re-adds it', async ({ app, core }) => {
  const p = repo(core);
  const w = create(core, p, 'tidy');
  await start(app, core, p);
  await row(app, 'tidy').focus();
  await app.keyboard.press('Backspace');
  const toast = app.getByRole('status').filter({ hasText: 'Removed tidy · branch kept' });
  await expect(toast).toBeVisible();
  await expect(app.getByRole('alertdialog')).toHaveCount(0);
  await expect.poll(() => fs.existsSync(w.path)).toBe(false);
  expect(branches(p)).toContain('tidy');
  await toast.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(() => fs.existsSync(w.path)).toBe(true);
  await expect(row(app, 'tidy')).toBeVisible();
  expect(git(w.path, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('tidy');
});

test('rename_label_only_inline: F2 and a click on the selected name edit inline; Enter saves, Esc cancels, double-click opens', async ({ app, core }) => {
  const p = repo(core);
  const w = create(core, p, 'named');
  const before = [git(p, 'worktree', 'list', '--porcelain'), branches(p).join()];
  await start(app, core, p);
  await row(app, 'named').focus();
  await app.keyboard.press('F2');
  const field = app.getByRole('textbox', { name: /Worktree label/ });
  await expect(field).toBeFocused();
  await field.fill('Better');
  await app.keyboard.press('Enter');
  await expect(row(app, 'Better')).toBeFocused();
  // Esc cancels.
  await app.keyboard.press('F2');
  await field.fill('Nope');
  await app.keyboard.press('Escape');
  await expect(row(app, 'Better')).toBeVisible();
  await expect(row(app, 'Nope')).toHaveCount(0);
  // A click on the selected row's name.
  await row(app, 'Better').locator('.n').click();
  await expect(field).toBeVisible();
  await app.keyboard.press('Escape');
  expect([git(p, 'worktree', 'list', '--porcelain'), branches(p).join()]).toEqual(before);
  // Double-click still opens: a shell starts in the worktree.
  await row(app, 'Better').dblclick();
  await expect.poll(() => (core.cli('snapshot', '--json').sessions as { cwd: string }[]).some((s) => s.cwd === w.path)).toBe(true);
  await expect(field).toHaveCount(0);
});

test('removed_outside_nunchiro_shows_gone: the row turns gone, fades, then its record is cleaned', async ({ app, core }) => {
  const p = repo(core);
  const w = create(core, p, 'outside');
  await start(app, core, p);
  await expect(row(app, 'outside')).toBeVisible();
  git(p, 'worktree', 'remove', '--', w.path);
  await app.reload();
  await expect(app.locator('.cleanup summary')).toContainText('Ready to clean up (1)');
  await expect.poll(() => (core.cli('worktree', 'list').worktrees as Listed[]).length, { timeout: 15_000 }).toBe(0);
  await expect(app.locator('.cleanup')).toHaveCount(0);
});

test('merged_row_folds_into_cleanup: a merged PR (seeded chip) folds the worktree into "Ready to clean up (1)", and the clean-up there removes it', async ({ app, core }) => {
  const p = repo(core);
  const w = create(core, p, 'shipped');
  const s = core.cli('worktree', 'open', '--path', w.path, '--no-focus').session as { id: string };
  core.cli('session', 'close', s.id);
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    const chips = new Set<number>();
    ws.onMessage((m) => {
      const r = typeof m === 'string' ? JSON.parse(m) : null;
      if (r?.request?.op === 'pr_chip') chips.add(r.id);
      server.send(m);
    });
    server.onMessage((m) => {
      const r = typeof m === 'string' ? JSON.parse(m) : null;
      if (r && chips.has(r.id)) return ws.send(JSON.stringify({ id: r.id, response: { Ok: { type: 'pr_chip', chip: { state: 'merged', url: 'https://github.com/acme/app/pull/52', at: null } } } }));
      ws.send(m);
    });
  });
  await start(app, core, p);
  // TREEROWS (needs 92): merged and gone rows fold into "Ready to clean up (N)"; no per-row "Merged - remove" button is left.
  const fold = app.locator('.cleanup');
  await expect(fold.locator('summary')).toContainText('Ready to clean up (1)');
  await expect(app.getByRole('button', { name: 'shipped: Merged - remove' })).toHaveCount(0);
  await fold.locator('summary').click(); // opened by its summary: the merged row is listed in it
  await expect(fold.locator('.row.wt2')).toHaveCount(1);
  await expect(fold.locator('.row.wt2')).toContainText('shipped');
  await fold.getByRole('button', { name: 'Clean up…' }).click(); // the clean-up path: the Tidy sheet, the merged worktree already chosen
  await app.getByRole('dialog', { name: /^Tidy/ }).getByRole('button', { name: /^Remove 1 selected$/ }).click();
  await expect(app.getByRole('status').filter({ hasText: 'Removed 1 worktree · branches kept' })).toBeVisible();
  await expect.poll(() => fs.existsSync(w.path)).toBe(false);
  expect(branches(p)).toContain('shipped');
});

test('palette_and_tree_actions: keyboard only, create, rename, open and remove from the palette and the row', async ({ app, core }) => {
  const p = repo(core);
  await start(app, core, p);
  const palette = async (id: string) => {
    await app.keyboard.press('Meta+KeyK');
    await app.keyboard.type(id);
    await expect(app.locator(`[data-command="${id}"]`)).toHaveAttribute('aria-selected', 'true');
    await app.keyboard.press('Enter');
  };
  await palette('worktree.create');
  await expect(app.getByRole('textbox', { name: /New worktree/ })).toBeFocused();
  await app.keyboard.type('via palette');
  await app.keyboard.press('Enter');
  await expect(row(app, 'via-palette')).toBeVisible();
  const w = (core.cli('worktree', 'list').worktrees as Listed[])[0];
  // Tab to the row: focus selects it for the palette's row commands.
  await row(app, 'via-palette').focus();
  await palette('worktree.rename');
  await expect(app.getByRole('textbox', { name: /Worktree label/ })).toBeFocused();
  await app.keyboard.press('Meta+KeyA');
  await app.keyboard.type('Renamed');
  await app.keyboard.press('Enter');
  await expect(row(app, 'Renamed')).toBeVisible();
  await row(app, 'Renamed').focus();
  await palette('worktree.open');
  await expect.poll(() => (core.cli('snapshot', '--json').sessions as { cwd: string; id: string }[]).some((s) => s.cwd === w.path)).toBe(true);
  for (const s of core.cli('snapshot', '--json').sessions as { cwd: string; id: string }[]) if (s.cwd === w.path) core.cli('session', 'close', s.id);
  await row(app, 'Renamed').focus();
  await palette('worktree.remove');
  await expect(app.getByRole('status').filter({ hasText: 'Removed Renamed · branch kept' })).toBeVisible();
  await expect.poll(() => fs.existsSync(w.path)).toBe(false);
  // Cmd+Z undoes while the toast shows.
  await app.keyboard.press('Meta+KeyZ');
  await expect.poll(() => fs.existsSync(w.path)).toBe(true);
});

test('no_pr_button: no PR create, commit, push or move control in the new worktree UI', () => {
  const src = ['../src/tree/worktrees.tsx', '../src/Sidebar.tsx'].map((f) => fs.readFileSync(path.join(import.meta.dirname, f), 'utf8')).join('\n');
  const controls = [...src.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map((m) => m[1].replace(/\{[^}]*\}|<[^>]+>/g, ' ').trim());
  expect(controls.length).toBeGreaterThan(3);
  for (const c of controls) expect(c, c).not.toMatch(/\b(pr|pull request|commit|push|move|stash)\b/i);
  expect(FIELDS.find((f) => f.key === 'autoCleanWorktrees')).toBeTruthy();
});

test('finished_row_keeps_worktree_actions: a worktree whose shell was stopped still offers Remove from its row menu and the palette; a restarted shell names the row', async ({ app, core }) => {
  const p = repo(core);
  const w = create(core, p, 'feat-x');
  const old = core.shell(w.path, 'feat-x');
  await start(app, core, p);
  await expect(row(app, 'feat-x')).toBeVisible();
  core.cli('session', 'close', old.id);
  // Ticket 1063 (replaces the verify look's finished row, ticket 991): a worktree row whose sessions are all closed leaves
  // the tree; the worktree stays in Tidy and History.
  await expect(row(app, 'feat-x')).toHaveCount(0);
  const remove = app.getByRole('menu', { name: 'Actions' }).locator('[data-command="worktree.remove"]');
  // A shell started again in it is live: the row says so, not "Finished" (verify look v14, A7).
  core.shell(w.path, 'feat-x again');
  await expect(row(app, 'feat-x')).toHaveAttribute('aria-label', /idle · Shell/);
  await row(app, 'feat-x').click({ button: 'right' });
  await remove.click();
  await app.getByRole('alertdialog', { name: 'feat-x has running sessions' }).getByRole('button', { name: 'Stop 1 session and remove' }).click();
  await expect.poll(() => fs.existsSync(w.path)).toBe(false);
  // The finished row goes with its worktree (ticket 991 A2): no row is left that looks like a worktree with no actions.
  await expect(app.locator('.row.wt2').filter({ hasText: 'feat-x' })).toHaveCount(0);
});
