// V2-CF3: a worktree row is named by its branch, else its session label, else its folder; its actions sit on the row's
// own menu and on visible, labelled controls (WTDIALOGS, TREEROWS). Real core, real git repos under the test home.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, openWindow, test, type Core } from './fixtures';
import { basename, buildTree, type Worktree } from '../src/tree';
import type { Session } from '../src/types';

const git = (dir: string, ...a: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { encoding: 'utf8' });
const repo = (core: Core) => {
  const p = core.project('repo');
  git(p, 'init', '-q', '-b', 'main');
  git(p, 'commit', '-q', '--allow-empty', '-m', 'init');
  return p;
};
type Listed = { path: string; branch: string; label: string };
const listed = (core: Core) => core.cli('worktree', 'list').worktrees as Listed[];
/** A managed worktree (in the core's list), with no session: its row is named by the branch. */
const managed = (core: Core, p: string, branch: string) => (core.cli('worktree', 'create', '--project', p, '--branch', branch, '--no-focus').worktrees as Listed[]).find((w) => w.branch === branch)!;
// Worktree rows: the main folder's idle session has a `treerow` of its own since v25-new-tab (needs 213).
const wtRows = (app: Page) => app.locator('.grp[data-project="repo"] .row.wt2:not([data-menu="treerow"])');

const session = (cwd: string, label: string): Session =>
  ({ id: `s-${label}`, kind: 'claude', project: '/p/repo', cwd, label, state: 'running', attention: { working: false, stale: false, failed: false, waiting: false, last_activity: 0 }, pending: [] }) as unknown as Session;
const nameOf = (w: Worktree | undefined) => w?.name;

test('worktree_row_named_by_branch_or_label: branch first, then the session label, never the UUID folder', async ({ app, core }) => {
  const p = repo(core);
  core.shell(p, 'main-shell');
  const a = core.agent(p, 'fix login', 'go', true);
  const m = managed(core, p, 'feature-x');
  await openWindow(app);
  const folder = basename(a.cwd); // a UUID; a session's worktree is detached, so it has no branch
  const row = wtRows(app).first();
  await expect(row).toBeVisible();
  await expect(row.locator('.n')).toHaveText('fix login');
  await expect(row).not.toContainText(folder);
  expect(await row.getAttribute('aria-label')).not.toContain(folder);
  // A managed worktree is named by its branch, not by its folder.
  await expect(wtRows(app).filter({ hasText: 'feature-x' })).toHaveCount(1);
  await expect(wtRows(app).filter({ hasText: basename(m.path) === 'feature-x' ? 'never' : basename(m.path) })).toHaveCount(0);
  // No branch (detached or unlisted): the session's label; neither: the folder.
  const uuid = '0b9e6c1a-5d2f-4b7a-9c3e-1f2a3b4c5d6e';
  const cwd = `/p/repo/${uuid}`;
  const tree = (labels: string[]) => buildTree(labels.map((l) => session(cwd, l)), [], []);
  expect(nameOf(tree(['fix login'])[0].groups[0].worktrees[0])).toBe('fix login');
  expect(nameOf(tree([''])[0].groups[0].worktrees[0])).toBe(uuid);
});

test('worktree_menu_lists_actions: Rename and Remove on the row menu (New is the project row\'s button, once), each doing its V2-8a action', async ({ app, core }) => {
  const p = repo(core);
  core.shell(p, 'main-shell');
  managed(core, p, 'menu-wt');
  await openWindow(app);
  const row = wtRows(app).filter({ hasText: 'menu-wt' });
  const menu = app.getByRole('menu', { name: 'Actions' });
  const open = async () => (await row.click({ button: 'right' }), expect(menu).toBeVisible());
  await open();
  await expect(menu.getByRole('menuitem', { name: /^Rename label/ })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: /^Remove worktree/ })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: /^New worktree/ })).toHaveCount(0); // NODUP: the project row has it
  await menu.getByRole('menuitem', { name: /^Rename label/ }).click();
  await expect(app.getByRole('textbox', { name: /Worktree label/ })).toBeFocused();
  await app.keyboard.press('Escape');
  await open();
  await menu.getByRole('menuitem', { name: /^Remove worktree/ }).click();
  await expect(app.getByRole('status').filter({ hasText: 'Removed menu-wt' })).toBeVisible();
});

test('worktree_actions_within_two_clicks: a labelled control on the project row and on the worktree row', async ({ app, core }) => {
  const p = repo(core);
  core.shell(p, 'main-shell');
  managed(core, p, 'two-clicks');
  await openWindow(app);
  const head = app.locator('.grp[data-project="repo"] .row.head');
  await head.hover();
  await head.getByRole('button', { name: /^New worktree in repo/ }).click(); // click 1
  await expect(app.getByRole('dialog', { name: 'New worktree' })).toBeVisible();
  await app.keyboard.press('Escape');
  const row = wtRows(app).filter({ hasText: 'two-clicks' });
  await row.hover();
  const menu = app.getByRole('menu', { name: 'Actions' });
  for (const [item, then] of [
    [/^Rename label/, () => expect(app.getByRole('textbox', { name: /Worktree label/ })).toBeFocused()],
  ] as const) {
    await row.hover();
    // Q6 A14: the main folder's row has the same ⋯ now, so the worktree row's own one is named.
    await app.locator('.grp[data-project="repo"]').getByRole('button', { name: 'Actions for two-clicks' }).click(); // click 1
    await menu.getByRole('menuitem', { name: item }).click(); // click 2
    await then();
    await app.keyboard.press('Escape');
  }
});

test('dirty_remove_still_discard_or_cancel: Remove from the row menu offers Cancel and Discard only', async ({ app, core }) => {
  const p = repo(core);
  core.shell(p, 'main-shell');
  const a = managed(core, p, 'dirty-wt');
  fs.writeFileSync(path.join(a.path, 'lost.txt'), 'x');
  await openWindow(app);
  const row = wtRows(app).filter({ hasText: 'dirty-wt' });
  await row.click({ button: 'right' });
  await app.getByRole('menu', { name: 'Actions' }).getByRole('menuitem', { name: /^Remove worktree/ }).click();
  const sheet = app.getByRole('alertdialog');
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole('button')).toHaveText(['Cancel', 'Discard and remove']);
  await sheet.getByRole('button', { name: 'Cancel' }).click();
  expect(fs.existsSync(a.path)).toBe(true);
  expect(listed(core).length).toBe(1);
});

test('axe_clean: the tree with the row menu open', async ({ app, core }) => {
  const p = repo(core);
  core.shell(p, 'main-shell');
  managed(core, p, 'axe-wt');
  await openWindow(app);
  await wtRows(app).first().click({ button: 'right' });
  await expect(app.getByRole('menu', { name: 'Actions' })).toBeVisible();
  const r = await new AxeBuilder({ page: app }).include('.tree').include('.cmenu').analyze();
  expect(r.violations.map((v) => v.id)).toEqual([]);
});


test('tree_menu_new_worktree_uses_clicked_project: a stale selected worktree of project A is not used for a row of project B', async ({ app, core }) => {
  const a = repo(core);
  const b = core.project('other');
  git(b, 'init', '-q', '-b', 'main');
  git(b, 'commit', '-q', '--allow-empty', '-m', 'init');
  core.shell(a, 'a-shell');
  core.shell(b, 'b-shell');
  managed(core, a, 'a-wt');
  await openWindow(app);
  await app.locator('.grp[data-project="repo"] .row.wt2').filter({ hasText: 'a-wt' }).click(); // selects A's worktree row
  const bHead = app.locator('.grp[data-project="other"] .row.head');
  await bHead.locator('button.n').click({ button: 'right' });
  const menu = app.getByRole('menu', { name: 'Actions' });
  await menu.getByRole('menuitem', { name: /^New worktree/ }).click();
  const dialog = app.getByRole('dialog', { name: 'New worktree' });
  await app.keyboard.type('from-b');
  await app.keyboard.press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => git(b, 'branch', '--list', 'from-b')).toContain('from-b');
  expect(git(a, 'branch', '--list', 'from-b')).toBe('');
});

test('session_worktree_row_has_actions: a `session start --worktree` row: labelled, ⋯ reaches Rename and Remove (dirty: Cancel, Discard; ignored files listed)', async ({ app, core }) => {
  const p = repo(core);
  core.shell(p, 'main-shell');
  const a = core.agent(p, 'fix login', 'go', true);
  core.cli('session', 'close', a.id);
  fs.writeFileSync(path.join(p, '.git/info/exclude'), '.env\n');
  fs.writeFileSync(path.join(a.cwd, 'lost.txt'), 'x');
  fs.writeFileSync(path.join(a.cwd, '.env'), 'SECRET=1');
  await openWindow(app);
  const row = wtRows(app).filter({ hasText: 'fix login' });
  await expect(row).not.toContainText(basename(a.cwd));
  const menu = app.getByRole('menu', { name: 'Actions' });
  const more = app.locator('.grp[data-project="repo"]').getByRole('button', { name: 'Actions for fix login' });
  await expect(more).toHaveCount(1); // adopted: it is a managed row now
  await row.hover();
  await more.click();
  await menu.getByRole('menuitem', { name: /^Rename label/ }).click();
  await expect(app.getByRole('textbox', { name: /Worktree label/ })).toBeFocused();
  await app.keyboard.press('Escape');
  await row.hover();
  await more.click();
  await menu.getByRole('menuitem', { name: /^Remove worktree/ }).click();
  const sheet = app.getByRole('alertdialog');
  await expect(sheet.getByRole('button')).toHaveText(['Cancel', 'Discard and remove']);
  await expect(sheet.getByRole('region', { name: 'Git-ignored, deleted too' })).toContainText('!! .env');
  await expect(sheet.getByRole('region', { name: 'Lost if discarded' })).toContainText('?? lost.txt');
  await sheet.getByRole('button', { name: 'Cancel' }).click();
  expect(fs.existsSync(a.cwd)).toBe(true);
});

test('remove_via_more_in_two_clicks: ⋯ then Remove removes a clean worktree', async ({ app, core }) => {
  const p = repo(core);
  core.shell(p, 'main-shell');
  const w = managed(core, p, 'clean-wt');
  await openWindow(app);
  const row = wtRows(app).filter({ hasText: 'clean-wt' });
  await row.hover();
  await app.locator('.grp[data-project="repo"]').getByRole('button', { name: 'Actions for clean-wt' }).click(); // click 1
  await app.getByRole('menu', { name: 'Actions' }).getByRole('menuitem', { name: /^Remove worktree/ }).click(); // click 2
  await expect(app.getByRole('status').filter({ hasText: 'Removed clean-wt' })).toBeVisible();
  await expect.poll(() => fs.existsSync(w.path)).toBe(false);
});

test('menu_matches_mockup_05: header, the drawn items in order, rules between groups, red Remove; Stop only with a session', async ({ app, core }) => {
  const p = repo(core);
  core.shell(p, 'main-shell');
  managed(core, p, 'order-wt');
  const live = core.agent(p, 'live one', 'go', true);
  await openWindow(app);
  const menu = app.getByRole('menu', { name: 'Actions' });
  const texts = async () => (await menu.getByRole('menuitem').locator('.mt').allTextContents());
  await wtRows(app).filter({ hasText: 'order-wt' }).click({ button: 'right' });
  await expect(menu.locator('.mhd')).toHaveText('order-wt · worktree row');
  // Ticket 375 part A (806ffce9b): Open in editor follows Reveal in Finder.
  expect(await texts()).toEqual(['Open worktree (a shell in it)', 'Create a new session…', 'Rename label…', 'Copy path', 'Reveal in Finder', 'Open in editor', 'Remove worktree…']);
  await expect(menu.getByRole('menuitem', { name: /^Rename label/ }).locator('.kbd')).toHaveText('F2');
  await expect(menu.getByRole('separator')).toHaveCount(1); // no session: no Stop, so no second rule
  await expect(menu.getByRole('menuitem', { name: /^Remove worktree/ })).toHaveCSS('color', 'rgb(207, 34, 46)');
  for (const gone of [/Rename the session tab/, /Focus the terminal/, /Open Diff/, /Tidy/, /New worktree/]) await expect(menu.getByRole('menuitem', { name: gone })).toHaveCount(0);
  await app.keyboard.press('Escape');
  await expect(app.getByRole('button', { name: 'Actions for live one' })).toHaveCount(1); // adopted
  await wtRows(app).filter({ hasText: 'live one' }).click({ button: 'right' });
  // Q6 A14 (722f28361): a row with a session also restarts, closes and diffs it; the mockup's items keep their order.
  expect(await texts()).toEqual(['Open worktree (a shell in it)', 'Create a new session…', 'Rename label…', 'Copy path', 'Reveal in Finder', 'Open in editor', 'Stop this session', 'Restart session', 'Close session', 'Open Diff (changes since the session started)', 'Remove worktree…']);
  await expect(menu.getByRole('separator')).toHaveCount(2);
  void live;
});

test.describe('touch', () => {
  test.use({ hasTouch: true, isMobile: true });
  test('more_and_new_worktree_visible_without_hover_on_touch: (hover: none) draws ⋯ and ⌄ worktree', async ({ app, core }) => {
    const p = repo(core);
    core.shell(p, 'main-shell');
    managed(core, p, 'touch-wt');
    await openWindow(app);
    expect(await app.evaluate(() => matchMedia('(hover: none)').matches)).toBe(true);
    const g = app.locator('.grp[data-project="repo"]');
    await expect(g.getByRole('button', { name: 'Actions for touch-wt' })).toBeVisible();
    await expect(g.getByRole('button', { name: /^New worktree in repo/ })).toBeVisible();
  });
});

test('remove_refused_while_session_runs: Backspace and the menu ask to stop the running agent first; Cancel leaves its folder alone (ticket 991 A3)', async ({ app, core }) => {
  const p = repo(core);
  core.shell(p, 'main-shell');
  const a = core.agent(p, 'live agent', 'go', true);
  await openWindow(app);
  const row = wtRows(app).filter({ hasText: 'live agent' });
  await expect(app.locator('.grp[data-project="repo"]').getByRole('button', { name: 'Actions for live agent' })).toHaveCount(1); // adopted
  const sheet = app.getByRole('alertdialog', { name: 'live agent has running sessions' });
  await row.focus();
  await app.keyboard.press('Backspace');
  await expect(sheet.getByRole('listitem')).toHaveText(['live agent']);
  await sheet.getByRole('button', { name: 'Cancel' }).click();
  await row.click({ button: 'right' });
  await app.getByRole('menu', { name: 'Actions' }).getByRole('menuitem', { name: /^Remove worktree/ }).click();
  await expect(sheet.getByRole('button', { name: 'Stop 1 session and remove' })).toBeVisible();
  await app.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
  expect(fs.existsSync(a.cwd)).toBe(true);
  expect(git(p, 'worktree', 'list')).toContain(a.cwd);
  expect(core.cli('snapshot', '--json').sessions as { id: string; state: string }[]).toContainEqual(expect.objectContaining({ id: a.id, state: 'running' }));
});

test('shots: per-row crops, mockup and app, for the REPORT side-by-side page', async ({ app, core, browserName }) => {
  test.skip(browserName !== 'chromium' || !process.env.WT_SHOTS, 'screenshots only on request');
  const p = repo(core);
  core.shell(p, 'main-shell');
  const a = core.agent(p, 'fix login', 'go', true);
  core.cli('session', 'close', a.id);
  managed(core, p, 'feature-x');
  await openWindow(app);
  const out = path.resolve(import.meta.dirname, '../../.scratch/cf3');
  fs.mkdirSync(out, { recursive: true });
  const grp = app.locator('.grp[data-project="repo"]');
  await grp.locator('.row.head').hover();
  await grp.screenshot({ path: path.join(out, 'app-rows.png') });
  await wtRows(app).filter({ hasText: 'feature-x' }).hover();
  await grp.screenshot({ path: path.join(out, 'app-row-more.png') });
  await wtRows(app).filter({ hasText: 'feature-x' }).click({ button: 'right' });
  await expect(app.getByRole('menu', { name: 'Actions' })).toBeVisible();
  await app.locator('.cmenu').screenshot({ path: path.join(out, 'app-menu.png') });
  const m = await app.context().newPage();
  await m.setViewportSize({ width: 1440, height: 1000 });
  const drafts = path.resolve(import.meta.dirname, '../../.scratch/v2-drafts');
  test.skip(!fs.existsSync(drafts), `mockup frames absent: ${drafts}`);
  await m.goto(`file://${drafts}/07-worktrees-pr.html`);
  const f7 = (await m.locator('#o7a .frame').first().boundingBox())!;
  await m.screenshot({ path: path.join(out, 'mock-rows.png'), clip: { x: f7.x, y: f7.y + 36, width: 300, height: 300 }, fullPage: true });
  await m.goto(`file://${drafts}/05-context-undo.html`);
  await m.locator('#o5a .menu').first().screenshot({ path: path.join(out, 'mock-menu.png') });
});
