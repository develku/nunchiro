// V2-8g (WTDIALOGS Draft 3, "Merged / tidy" frame): the Tidy panel over the V2-8a worktree ops, through the real core and
// real git repos under the test home. Only two replies are patched: the PR chip (no transcript names a PR here) and the
// gone-folder `forget` (held, so the gone row stays long enough to be seen). Every worktree request is logged.
import AxeBuilder from '@axe-core/playwright';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, openWindow, test, type Core } from './fixtures';
import { openQuiet } from './tree-seed';

const git = (dir: string, ...a: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { encoding: 'utf8' });
const repo = (core: Core, name: string) => {
  const p = core.project(name);
  git(p, 'init', '-q', '-b', 'main');
  git(p, 'commit', '-q', '--allow-empty', '-m', 'init');
  return p;
};
const branches = (p: string) => git(p, 'branch', '--list', '--format=%(refname:short)').split('\n').filter(Boolean);
type Listed = { path: string; branch: string };
const create = (core: Core, p: string, branch: string) => (core.cli('worktree', 'create', '--project', p, '--branch', branch, '--no-focus').worktrees as Listed[]).find((w) => w.branch === branch)!;
/** A worktree whose agent session ended: its folder holds no running session. */
const ended = (core: Core, w: Listed) => {
  const s = core.cli('worktree', 'open', '--path', w.path, '--no-focus').session as { id: string };
  core.windowClose(s.id); // ticket 1013 F6: the window's own Close keeps the done tab
  return s.id;
};

/**
 * Two projects: alpha has a merged worktree (a-merged), a squash-merged one (a-squash: its commit is not in main), a
 * clean one, one with a running session, a dirty one and a gone one; beta has a merged one (b-merged). `extra` adds
 * a merged worktree that holds a git-ignored file (a-ignored) and one whose running session sits in a subfolder (a-sub).
 */
function seed(core: Core, extra: { ignored?: boolean; sub?: boolean } = {}) {
  const a = repo(core, 'alpha');
  const b = repo(core, 'beta');
  const w = {
    merged: create(core, a, 'a-merged'),
    squash: create(core, a, 'a-squash'),
    clean: create(core, a, 'a-clean'),
    running: create(core, a, 'a-running'),
    dirty: create(core, a, 'a-dirty'),
    gone: create(core, a, 'a-gone'),
    bMerged: create(core, b, 'b-merged'),
  };
  // Squash-merged: main has the change, but the branch's own commit is in neither main nor an upstream.
  fs.writeFileSync(path.join(w.squash.path, 'feature.txt'), 'f');
  git(w.squash.path, 'add', 'feature.txt');
  git(w.squash.path, 'commit', '-q', '-m', 'feature');
  git(a, 'merge', '-q', '--squash', 'a-squash');
  git(a, 'commit', '-q', '-m', 'feature (squashed)');
  const merged = new Set([ended(core, w.merged), ended(core, w.squash), ended(core, w.bMerged)]);
  const more: { ignored?: Listed; sub?: Listed } = {};
  if (extra.ignored) {
    more.ignored = create(core, a, 'a-ignored');
    fs.writeFileSync(path.join(a, '.git/info/exclude'), '.env\n');
    fs.writeFileSync(path.join(more.ignored.path, '.env'), 'SECRET=1');
    merged.add(ended(core, more.ignored));
  }
  if (extra.sub) {
    more.sub = create(core, a, 'a-sub');
    fs.mkdirSync(path.join(more.sub.path, 'src'));
    merged.add(ended(core, more.sub)); // its PR merged: only the running session below keeps it out
    merged.add(core.shell(path.join(more.sub.path, 'src'), 'sub-shell').id);
  }
  // A running session in a worktree whose PR merged: still "Running session", never cleaned.
  const live = core.cli('worktree', 'open', '--path', w.running.path, '--no-focus').session as { id: string };
  merged.add(live.id);
  fs.writeFileSync(path.join(w.dirty.path, 'lost.txt'), 'x');
  git(a, 'worktree', 'remove', '--force', '--', w.gone.path);
  core.shell(a, 'main-shell');
  core.shell(b, 'main-shell-b');
  openQuiet(core);
  return { a, b, w: { ...w, ...more }, merged, live: live.id };
}

type Confirm = { uncommitted_total: number; ignored_total: number; unpushed_total: number; kept_on: string | null };
/**
 * Patches the PR chip of `merged` sessions, holds the window's own `forget` until `release()`, and logs every worktree request.
 * `paths` are worktrees whose branch's own PR merged: a removed worktree's ended sessions close with it (ticket 991 A2), so
 * after an Undo the row has no session chip and reads its state from the branch, as a real project's row does.
 */
async function patch(app: Page, merged: Set<string>, paths: Set<string>) {
  const log: { operation: string; path?: string; confirm?: Confirm; force?: unknown }[] = [];
  const hold = { on: true };
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    const chips = new Set<number>();
    ws.onMessage((m) => {
      const r = typeof m === 'string' ? JSON.parse(m) : null;
      if (r?.request?.op === 'pr_chip' && merged.has(r.request.id)) chips.add(r.id);
      if (r?.request?.op === 'pr_branch' && paths.has(r.request.path)) return ws.send(JSON.stringify({ id: r.id, response: { Ok: { type: 'pr_branch', pr: { url: 'https://github.com/acme/app/pull/52', number: 52, state: 'merged', failed: [] } } } }));
      if (r?.request?.op === 'worktree') {
        log.push(r.request);
        if (r.request.operation === 'forget' && hold.on) return;
      }
      server.send(m);
    });
    server.onMessage((m) => {
      const r = typeof m === 'string' ? JSON.parse(m) : null;
      if (r && chips.has(r.id)) return ws.send(JSON.stringify({ id: r.id, response: { Ok: { type: 'pr_chip', chip: { state: 'merged', url: 'https://github.com/acme/app/pull/52', at: null } } } }));
      ws.send(m);
    });
  });
  return Object.assign(log, { release: () => void (hold.on = false) });
}

// rc2c-testfix (V2.5-67): a removal or an Undo runs one core `worktree` op per worktree, about 2 s each in the debug core
// (git itself 18 ms), measured alone and after 324 other tests alike (click to toast 9.5 s for 3 worktrees + 1 gone record
// at load 5-8; it does not grow over a run). The default 5 s expect is under that, so each wait that follows a removal or
// an Undo gets this budget; test.slow() already gives the test 135 s.
const CORE_OPS = 45_000;
const panel = (app: Page) => app.getByRole('dialog', { name: /^Tidy/ });
const item = (app: Page, name: string) => panel(app).getByRole('listitem').filter({ hasText: name });
const palette = async (app: Page, id: string) => {
  // The window's key handler can attach a moment after the tree shows (WebKit under load): press again if nothing opened.
  await expect(async () => {
    await app.keyboard.press('Meta+KeyK');
    await expect(app.locator('.palette input')).toBeFocused({ timeout: 3000 });
  }).toPass({ timeout: 15_000 });
  await app.keyboard.type(id);
  await expect(app.locator(`[data-command="${id}"]`)).toHaveAttribute('aria-selected', 'true');
  await app.keyboard.press('Enter');
};
/** Opens the panel from the palette and widens it to every project. */
const openAll = async (app: Page) => {
  await palette(app, 'worktree.tidy');
  await expect(panel(app)).toBeVisible();
  await panel(app).getByRole('button', { name: 'All projects' }).click();
};
// V2.5-41: seed() takes 10-16 s of the 45 s budget on a loaded mini (CLI and git calls per worktree, measured in REPORT),
// and every test mutates its seed, so no shared beforeAll seed: each test gets the slow (x3) budget.
test.beforeEach(() => test.slow());
const start = async (app: Page, core: Core, extra: Parameters<typeof seed>[1] = {}) => {
  const s = seed(core, extra);
  const log = await patch(app, s.merged, new Set([s.w.merged, s.w.squash, s.w.bMerged].map((w) => w.path)));
  await openWindow(app);
  await expect(app.locator('.grp[data-project="alpha"]')).toBeVisible();
  // Readiness: the panel leaves out a worktree with a running session, so a-running's session must be running before it opens.
  await expect.poll(() => (core.cli('snapshot', '--json').sessions as { id: string; state: string }[]).find((x) => x.id === s.live)?.state).toBe('running');
  return { ...s, log, release: () => log.release() };
};

test('tidy_lists_every_worktree_state: merged, folder gone and needs-a-decision rows are listed with their state; clean and running ones are not', async ({ app, core }) => {
  await start(app, core);
  await palette(app, 'worktree.tidy');
  // Opened from alpha: starts filtered to alpha, with a visible toggle to every project.
  await expect(panel(app)).toBeVisible();
  await expect(item(app, 'b-merged')).toHaveCount(0);
  await panel(app).getByRole('button', { name: 'All projects' }).click();
  const state = { 'a-merged': 'Merged', 'a-squash': 'Merged', 'b-merged': 'Merged', 'a-gone': 'Only the record is removed', 'a-dirty': '1 unsaved file' };
  for (const [name, text] of Object.entries(state)) await expect(item(app, name), name).toContainText(text);
  await expect(panel(app).getByRole('region', { name: 'Folder gone (1)' })).toBeVisible();
  await expect(panel(app).getByRole('region', { name: 'Needs a decision (1)' })).toBeVisible();
  // Ticket 374: a clean worktree with no commits and no session is listed under No commits, unchecked; one with a running
  // session is not a tidy candidate, and no extra group names it.
  await expect(panel(app).getByRole('region', { name: 'No commits (1)' })).toBeVisible();
  await expect(item(app, 'a-clean').getByRole('checkbox')).not.toBeChecked();
  await expect(item(app, 'a-running'), 'a-running').toHaveCount(0);
  await expect(panel(app)).not.toContainText(/Clean|Running session|Space toggles/);
  await expect(panel(app)).toHaveAccessibleName('Tidy · 6 worktrees in 2 projects');
  // The folder-gone row is checked, as in the mockup.
  await expect(item(app, 'a-gone').getByRole('checkbox')).toBeChecked();
});

test('tidy_cleans_only_merged_clean_idle: the bulk action removes the merged, clean, idle ones (a squash-merged one too) and the gone record; branches stay, never forced', async ({ app, core }) => {
  const s = await start(app, core);
  await openAll(app);
  for (const n of ['a-merged', 'a-squash', 'b-merged', 'a-gone']) await expect(item(app, n).getByRole('checkbox'), n).toBeChecked();
  // c45f44e2 (owner-check rows 03/15/23): a dirty row keeps its box, drawn disabled and unchecked, so it is never in the bulk.
  await expect(item(app, 'a-dirty').getByRole('checkbox')).toBeDisabled();
  await expect(item(app, 'a-dirty').getByRole('checkbox')).not.toBeChecked();
  s.release();
  await panel(app).getByRole('button', { name: 'Remove 4 selected' }).click();
  await expect(app.getByRole('status').filter({ hasText: 'Removed 3 worktrees · branches kept · 1 gone record cleaned' })).toBeVisible({ timeout: CORE_OPS });
  await expect(panel(app)).toHaveCount(0);
  await expect.poll(() => [s.w.merged.path, s.w.squash.path, s.w.bMerged.path].map((p) => fs.existsSync(p))).toEqual([false, false, false]);
  for (const k of ['clean', 'running', 'dirty'] as const) expect(fs.existsSync(s.w[k].path), k).toBe(true);
  expect(branches(s.a)).toEqual(expect.arrayContaining(['a-merged', 'a-squash', 'a-clean', 'a-running', 'a-dirty']));
  expect(branches(s.b)).toContain('b-merged');
  // The op log: a remove per worktree, never forced; a confirm only for a loss of commits alone (never uncommitted or ignored files).
  const removes = s.log.filter((r) => r.operation === 'remove');
  expect([...new Set(removes.map((r) => r.path))].sort()).toEqual([s.w.merged.path, s.w.squash.path, s.w.bMerged.path].sort());
  for (const r of removes) if (r.confirm) expect([r.confirm.uncommitted_total, r.confirm.ignored_total, r.confirm.kept_on]).toEqual([0, 0, r.path === s.w.squash.path ? 'a-squash' : r.confirm.kept_on]);
  expect(removes.some((r) => r.path === s.w.squash.path && r.confirm)).toBe(true);
  expect(s.log.filter((r) => r.operation === 'forget' && r.path !== s.w.gone.path)).toEqual([]);
  expect(s.log.map((r) => r.operation).filter((o) => !['list', 'remove', 'forget', 'adopt'].includes(o))).toEqual([]);
});

test('tidy_keeps_ignored_files_for_the_sheet: a merged worktree with git-ignored files is kept, the toast names why, and its row goes to the discard sheet', async ({ app, core }) => {
  const s = await start(app, core, { ignored: true });
  await openAll(app);
  s.release();
  await expect(item(app, 'a-ignored').getByRole('checkbox')).toBeChecked();
  await panel(app).getByRole('button', { name: /^Remove \d+ selected$/ }).click();
  const toast = app.getByRole('status').filter({ hasText: /1 not removed: git-ignored files/ });
  await expect(toast).toBeVisible({ timeout: CORE_OPS });
  expect(fs.existsSync(path.join(s.w.ignored!.path, '.env'))).toBe(true);
  // The panel stays open and the row now needs a decision, with Resolve.
  await expect(item(app, 'a-ignored')).toContainText('git-ignored');
  await expect(item(app, 'a-ignored').getByRole('checkbox')).toBeDisabled(); // c45f44e2: the box stays, disabled and unchecked
  await expect(item(app, 'a-ignored').getByRole('checkbox')).not.toBeChecked();
  await item(app, 'a-ignored').getByRole('button', { name: 'Resolve' }).click();
  await app.getByRole('menuitem', { name: /Discard and remove/ }).click();
  const sheet = app.getByRole('alertdialog', { name: 'a-ignored has unsaved work' });
  await expect(sheet.getByRole('button')).toHaveText(['Cancel', 'Discard and remove']);
  await expect(sheet.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await sheet.getByRole('button', { name: 'Cancel' }).click();
  expect(fs.existsSync(path.join(s.w.ignored!.path, '.env'))).toBe(true);
});

test('tidy_session_in_subfolder_keeps_worktree: a running session in a subfolder of a merged worktree keeps it out of the list and the bulk', async ({ app, core }) => {
  const s = await start(app, core, { sub: true });
  await openAll(app);
  s.release();
  await expect(item(app, 'a-merged')).toBeVisible();
  await expect(item(app, 'a-sub')).toHaveCount(0);
  await panel(app).getByRole('button', { name: /^Remove \d+ selected$/ }).click();
  await expect.poll(() => fs.existsSync(s.w.merged.path)).toBe(false);
  expect(fs.existsSync(s.w.sub!.path)).toBe(true);
  expect(s.log.filter((r) => r.path === s.w.sub!.path && r.operation === 'remove')).toEqual([]);
});

test('tidy_undo_restores: one Undo re-adds everything removed; a core refusal leaves that one and the toast counts only the removed', async ({ app, core }) => {
  const s = await start(app, core);
  await openAll(app);
  s.release();
  await panel(app).getByRole('button', { name: 'Remove 4 selected' }).click();
  const toast = app.getByRole('status').filter({ hasText: 'Removed 3 worktrees' });
  await expect(toast).toBeVisible({ timeout: CORE_OPS });
  await expect.poll(() => fs.existsSync(s.w.merged.path)).toBe(false);
  await toast.getByRole('button', { name: 'Undo' }).click();
  const back = [s.w.merged.path, s.w.squash.path, s.w.bMerged.path];
  await expect.poll(() => back.map((p) => fs.existsSync(p)), { timeout: CORE_OPS }).toEqual([true, true, true]);
  expect(git(s.w.merged.path, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('a-merged');
  expect(git(s.w.squash.path, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('a-squash');
  // The list is read when the panel opens: a worktree that turns dirty after that is refused by the core and stays.
  await openAll(app);
  await expect(item(app, 'a-merged')).toBeVisible();
  // The restored rows have no session now: they read "merged" from their branch's PR, one request each. The late file is
  // written after that, or the next list read shows it first and the row is never in the bulk (nightly 11-17).
  const bulk = panel(app).getByRole('button', { name: 'Remove 3 selected' });
  await expect(bulk).toBeVisible({ timeout: CORE_OPS });
  fs.writeFileSync(path.join(s.w.merged.path, 'late.txt'), 'x');
  await bulk.click();
  const two = app.getByRole('status').filter({ hasText: /Removed 2 worktrees\b.*1 not removed/ });
  await expect(two).toBeVisible({ timeout: CORE_OPS });
  await expect.poll(() => [s.w.squash.path, s.w.bMerged.path].map((p) => fs.existsSync(p))).toEqual([false, false]);
  expect(fs.existsSync(path.join(s.w.merged.path, 'late.txt'))).toBe(true);
  // The kept one is a row that needs a decision, with its unsaved file named.
  await expect(item(app, 'a-merged')).toContainText('1 unsaved file');
  await two.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(() => [s.w.squash.path, s.w.bMerged.path].map((p) => fs.existsSync(p)), { timeout: CORE_OPS }).toEqual([true, true]);
});

test('tidy_never_force_removes_dirty: a dirty worktree survives the bulk action; its row offers the dirty-remove dialog only', async ({ app, core }) => {
  const s = await start(app, core);
  await openAll(app);
  // c45f44e2 (owner-check rows 03/15/23): a dirty row keeps its box, drawn disabled and unchecked, so it is never in the bulk.
  await expect(item(app, 'a-dirty').getByRole('checkbox')).toBeDisabled();
  await expect(item(app, 'a-dirty').getByRole('checkbox')).not.toBeChecked();
  s.release();
  await panel(app).getByRole('button', { name: 'Remove 4 selected' }).click();
  await expect(app.getByRole('status').filter({ hasText: 'Removed 3 worktrees' })).toBeVisible({ timeout: CORE_OPS });
  expect(fs.existsSync(path.join(s.w.dirty.path, 'lost.txt'))).toBe(true);
  await openAll(app);
  // Resolve is a menu (Resolve ▾): look inside, or the existing discard sheet.
  await item(app, 'a-dirty').getByRole('button', { name: 'Resolve' }).click();
  await expect(app.getByRole('menuitem')).toHaveText(['Open a shell in it', 'Discard and remove…']);
  await app.getByRole('menuitem', { name: /Discard and remove/ }).click();
  const sheet = app.getByRole('alertdialog', { name: 'a-dirty has unsaved work' });
  await expect(sheet.getByRole('button')).toHaveText(['Cancel', 'Discard and remove']);
  await expect(sheet.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await sheet.getByRole('button', { name: 'Cancel' }).click();
  expect(fs.existsSync(path.join(s.w.dirty.path, 'lost.txt'))).toBe(true);
  expect(s.log.filter((r) => r.operation === 'remove' && r.path === s.w.dirty.path).every((r) => !r.confirm)).toBe(true);
});

test('tidy_reachable_in_two_clicks: the labelled project menu item opens it; the palette command works by keyboard; focus is trapped, Esc returns it', async ({ app, core }) => {
  await start(app, core);
  // Click 1: the project's menu (right-click). Click 2: the labelled item.
  await app.locator('.grp[data-project="alpha"] button.n').click({ button: 'right' });
  await app.getByRole('menuitem', { name: /Tidy worktrees…/ }).click();
  await expect(panel(app)).toBeVisible();
  await expect(item(app, 'a-merged')).toBeVisible();
  await app.keyboard.press('Escape');
  await expect(panel(app)).toHaveCount(0);
  // Keyboard only.
  const opener = app.locator('.grp[data-project="alpha"] button.n');
  await opener.focus();
  await palette(app, 'worktree.tidy');
  await expect(panel(app)).toBeVisible();
  const inside = () => app.evaluate(() => !!document.activeElement?.closest('[role=dialog][aria-label^="Tidy"]'));
  expect(await inside()).toBe(true);
  for (let i = 0; i < 12; i++) {
    await app.keyboard.press('Tab');
    expect(await inside(), `Tab ${i}`).toBe(true);
  }
  await app.keyboard.press('Shift+Tab');
  expect(await inside()).toBe(true);
  await app.keyboard.press('Escape');
  await expect(panel(app)).toHaveCount(0);
  await expect(opener).toBeFocused();
});

test('axe_clean: no serious or critical violation on the panel', async ({ app, core }) => {
  await start(app, core);
  await openAll(app);
  await expect(item(app, 'a-gone')).toBeVisible();
  const r = await new AxeBuilder({ page: app }).include('[role=dialog][aria-label^="Tidy"]').analyze();
  expect(r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}: ${v.help}`)).toEqual([]);
});

// Screenshots for the REPORT side-by-side page (the mockup's Draft 3 "Merged / tidy" frame against the app, light and dark).
test('mockup_vs_app_screenshots: the panel in both themes, written under .scratch/tidy-shots', async ({ app, core }, info) => {
  await start(app, core);
  await openAll(app);
  await expect(item(app, 'a-gone')).toBeVisible();
  const dir = path.join(import.meta.dirname, '../../.scratch/tidy-shots');
  fs.mkdirSync(dir, { recursive: true });
  for (const scheme of ['light', 'dark'] as const) {
    await app.emulateMedia({ colorScheme: scheme });
    await expect(app.locator('html')).toHaveAttribute('data-theme', scheme);
    await panel(app).screenshot({ path: path.join(dir, `app-${scheme}-${info.project.name}.png`) });
  }
});
