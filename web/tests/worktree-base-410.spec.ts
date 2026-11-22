// Ticket 410 (base-branch half; mock docs/design/m3-1110/374.html scene newwt, approved 11-10): New worktree > Advanced's
// base field lists the project's branches as you type, and a name that is not a branch is refused with a reason before
// Create, so nothing is made. Real core and a real git repo under the test home.
import { execFileSync } from 'node:child_process';
import type { Page } from '@playwright/test';
import { expect, openWindow, test, type Core } from './fixtures';
import { openQuiet } from './tree-seed';

const git = (dir: string, ...a: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { encoding: 'utf8' }).trim();
type Listed = { path: string; branch: string };
const listed = (core: Core) => core.cli('worktree', 'list').worktrees as Listed[];
/** main, release-2.0 (in a worktree), release-2.1 one commit ahead, a remote-only origin/release-3 and a tag. */
function repo(core: Core) {
  const p = core.project('repo');
  git(p, 'init', '-q', '-b', 'main');
  git(p, 'commit', '-q', '--allow-empty', '-m', 'init');
  git(p, 'tag', 'v1');
  git(p, 'branch', 'release-2.0');
  git(p, 'switch', '-q', '-c', 'release-2.1');
  git(p, 'commit', '-q', '--allow-empty', '-m', 'on 2.1');
  git(p, 'update-ref', 'refs/remotes/origin/release-3', 'HEAD');
  git(p, 'switch', '-q', 'main');
  core.cli('worktree', 'create', '--project', p, '--branch', 'release-2.0', '--no-focus');
  return p;
}
const open = async (app: Page, core: Core, p: string) => {
  core.shell(p, 'main-shell');
  openQuiet(core);
  await openWindow(app);
  await app.locator('.grp[data-project="repo"] .row.head').hover();
  await app.getByRole('button', { name: 'New worktree in repo', exact: true }).click();
  const d = app.getByRole('dialog', { name: 'New worktree', exact: true });
  await d.getByRole('textbox').first().fill('fix-login');
  await app.keyboard.press('Alt+Enter');
  await expect(d.getByRole('textbox', { name: 'Base branch' })).toBeFocused();
  return d;
};
const made = async (core: Core, branch: string) => {
  await expect.poll(() => listed(core).some((w) => w.branch === branch)).toBe(true);
  return listed(core).find((w) => w.branch === branch)!;
};

test('worktree_base_lists_branches: typing in Base branch lists matching branches; arrows pick one and Enter creates from it', async ({ app, core }) => {
  const p = repo(core);
  const d = await open(app, core, p);
  const base = d.getByRole('textbox', { name: 'Base branch' });
  const list = d.getByRole('listbox', { name: 'Existing branches' });
  await base.fill('ma');
  await expect(list.getByRole('option')).toHaveText(['mainin worktree']); // the project folder has it checked out
  await expect(list.getByRole('option', { name: 'main' })).toHaveAttribute('aria-selected', 'true');
  await expect(d.getByRole('status')).toHaveText('Creates fix-login from main');
  // Local and remote branches; a branch in a worktree is still a base (tagged, as the mock tags it); a tag is not listed.
  await base.fill('rel');
  await expect(list.getByRole('option')).toHaveText(['release-2.0in worktree', 'release-2.1', 'origin/release-3']);
  await base.fill('v');
  await expect(list).toHaveCount(0);
  await base.fill('release');
  await expect(list.getByRole('option').first()).toHaveAttribute('aria-selected', 'true');
  await app.keyboard.press('ArrowDown');
  await expect(list.getByRole('option', { name: 'release-2.1' })).toHaveAttribute('aria-selected', 'true');
  await expect(d.getByRole('status')).toHaveText('Creates fix-login from release-2.1');
  await expect(base).toHaveAttribute('aria-activedescendant', /.+/);
  // Esc closes the list and keeps the dialog; typing opens it again.
  await app.keyboard.press('Escape');
  await expect(list).toHaveCount(0);
  await expect(d).toBeVisible();
  await base.fill('release-2.');
  await app.keyboard.press('ArrowDown');
  await app.keyboard.press('Enter');
  await expect(d).toHaveCount(0);
  const w = await made(core, 'fix-login');
  expect(git(w.path, 'rev-parse', 'HEAD')).toBe(git(p, 'rev-parse', 'release-2.1'));
});

test('worktree_base_refuses_non_branch: a base that is not a branch is refused with its reason before Create; a branch then goes', async ({ app, core }) => {
  const p = repo(core);
  const d = await open(app, core, p);
  const base = d.getByRole('textbox', { name: 'Base branch' });
  const before = listed(core).length;
  for (const typed of ['nope', 'v1', 'mai']) {
    await base.fill(typed);
    if (typed === 'mai') await app.keyboard.press('Escape'); // the list offered main; closed, the typed text is the base
    await app.keyboard.press('Enter');
    await expect(d.getByRole('alert')).toHaveText(`‘${typed}’ is not a branch of this project. Pick one from the list, or leave the field empty.`);
    await expect(base).toHaveAttribute('aria-invalid', 'true');
    await expect(base).toBeFocused();
    await expect(d).toBeVisible();
  }
  // Clicking Create with the start-agent part open is refused the same way.
  await d.getByRole('checkbox').check();
  await d.getByRole('button', { name: 'Create and start' }).click();
  await expect(d.getByRole('alert')).toHaveText('‘mai’ is not a branch of this project. Pick one from the list, or leave the field empty.');
  await d.getByRole('checkbox').uncheck();
  expect(listed(core)).toHaveLength(before);
  // Typing clears the reason; a click on a listed branch fills the field with it.
  await base.fill('origin/rel');
  await expect(d.getByRole('alert')).toHaveCount(0);
  await expect(base).not.toHaveAttribute('aria-invalid', 'true');
  await d.getByRole('option', { name: 'origin/release-3' }).click();
  await expect(base).toHaveValue('origin/release-3');
  await expect(d.getByRole('listbox')).toHaveCount(0);
  await app.keyboard.press('Enter');
  await expect(d).toHaveCount(0);
  const w = await made(core, 'fix-login');
  expect(git(w.path, 'rev-parse', 'HEAD')).toBe(git(p, 'rev-parse', 'refs/remotes/origin/release-3'));
});

test('worktree_base_accepts_head_and_empty: HEAD (the 374 mock\'s way back to the current branch) and an empty field are not refused', async ({ app, core }) => {
  const p = repo(core);
  git(p, 'switch', '-q', 'release-2.1');
  const d = await open(app, core, p);
  await d.getByRole('textbox', { name: 'Base branch' }).fill('HEAD');
  await app.keyboard.press('Enter');
  await expect(d).toHaveCount(0);
  const w = await made(core, 'fix-login');
  expect(git(w.path, 'rev-parse', 'HEAD')).toBe(git(p, 'rev-parse', 'release-2.1'));
});
