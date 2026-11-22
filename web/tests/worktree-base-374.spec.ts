// Ticket 374 (mock-m3 374.html scenes newwt, pr, tidy): a new worktree starts from origin's default branch, a pasted PR
// link gets the PR's code, and Tidy lists worktrees with no commits, unchecked. Real core and real git repos under the
// test home; a local bare repository stands in for GitHub (a `url.<path>.insteadOf` rewrite for the PR remote).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, openWindow, REPO, test, type Core } from './fixtures';
import { openQuiet } from './tree-seed';

/** Each scene beside its mock PNG (mock-m3 shots/374/<scene>.png) for the coordinator's comparison. */
const out = path.join(REPO, '.scratch/v29-wt-base/shots');
const shot = (l: { screenshot: (o: { path: string }) => Promise<unknown> }, name: string) => (fs.mkdirSync(out, { recursive: true }), l.screenshot({ path: path.join(out, `${name}.png`) }));

const git = (dir: string, ...a: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { encoding: 'utf8' }).trim();
type Listed = { path: string; branch: string; facts?: { unpushed: number } };
const listed = (core: Core) => core.cli('worktree', 'list').worktrees as Listed[];
const URL = 'https://github.com/acme/demo.git';

/** GitHub (a bare origin with `main`), a writer that pushes to it, and the project: a clone on a feature branch. */
function repos(core: Core) {
  const p = core.project('demo');
  const root = path.dirname(p);
  const origin = path.join(root, 'origin.git');
  const writer = path.join(root, 'writer');
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  git(root, 'clone', '-q', origin, writer);
  git(writer, 'commit', '-q', '--allow-empty', '-m', 'first');
  git(writer, 'push', '-q', 'origin', 'HEAD:main');
  fs.rmSync(p, { recursive: true, force: true });
  git(root, 'clone', '-q', origin, p);
  git(p, 'switch', '-q', '-c', 'feature');
  git(p, 'commit', '-q', '--allow-empty', '-m', 'local work');
  return { p, root, origin, writer };
}
const start = async (app: Page, core: Core, p: string) => (core.shell(p, 'main-shell'), openQuiet(core), openWindow(app));
const openNew = async (app: Page) => {
  await app.locator('.grp[data-project="demo"] .row.head').hover();
  await app.getByRole('button', { name: 'New worktree in demo', exact: true }).click();
  return app.getByRole('dialog', { name: 'New worktree', exact: true });
};
const made = async (core: Core, branch: string) => {
  await expect.poll(() => listed(core).some((w) => w.branch === branch)).toBe(true);
  return listed(core).find((w) => w.branch === branch)!;
};

test('worktree_new_starts_from_github_main_and_removes_without_asking', async ({ app, core }) => {
  const { p, root, writer } = repos(core);
  git(writer, 'commit', '-q', '--allow-empty', '-m', 'on github only');
  git(writer, 'push', '-q', 'origin', 'HEAD:main');
  const latest = git(writer, 'rev-parse', 'HEAD');
  await start(app, core, p);
  let d = await openNew(app);
  await d.getByRole('textbox').first().fill('fix-login');
  await expect(d.getByRole('status')).toHaveText('Creates fix-login from origin/main (fetched before creating)');
  await shot(d, 'newwt-dialog');
  await app.keyboard.press('Enter');
  const w = await made(core, 'fix-login');
  expect(git(w.path, 'rev-parse', 'HEAD')).toBe(latest);
  expect(w.facts?.unpushed).toBe(0);
  core.cli('worktree', 'remove', '--path', w.path); // the CLI fails when the core asks for a confirm
  expect(fs.existsSync(w.path)).toBe(false);

  // Network off: made from the last fetched main, and the toast says so.
  git(writer, 'commit', '-q', '--allow-empty', '-m', 'unseen');
  git(writer, 'push', '-q', 'origin', 'HEAD:main');
  git(p, 'remote', 'set-url', 'origin', path.join(root, 'gone.git'));
  d = await openNew(app);
  await d.getByRole('textbox').first().fill('offline');
  await app.keyboard.press('Enter');
  const o = await made(core, 'offline');
  expect(git(o.path, 'rev-parse', 'HEAD')).toBe(latest);
  await expect(app.getByRole('status').filter({ hasText: "Could not reach GitHub, so the worktree was made from the last downloaded main." })).toBeVisible();
  await shot(app.getByRole('status').filter({ hasText: "Could not reach GitHub" }), 'newwt-offline-toast');
});

test('worktree_pr_link_fetches_the_prs_code_or_makes_nothing', async ({ app, core }) => {
  const { p, root, origin, writer } = repos(core);
  git(p, 'config', `url.${origin}.insteadOf`, URL);
  git(p, 'remote', 'set-url', 'origin', URL);
  git(writer, 'switch', '-q', '-c', 'contrib');
  git(writer, 'commit', '-q', '--allow-empty', '-m', 'the pr');
  git(writer, 'push', '-q', 'origin', 'HEAD:refs/pull/412/head');
  const head = git(writer, 'rev-parse', 'HEAD');
  const main = git(p, 'rev-parse', 'refs/heads/main');
  await start(app, core, p);
  let d = await openNew(app);
  await d.getByRole('textbox').first().fill('https://github.com/acme/demo/pull/412');
  await expect(d.getByRole('status')).toHaveText("Creates pr-412 from origin/main · fetches the PR's code from GitHub");
  await shot(d, 'pr-dialog');
  await app.keyboard.press('Enter');
  const w = await made(core, 'pr-412');
  expect(git(w.path, 'log', '-1', '--format=%H')).toBe(head);
  expect(git(p, 'rev-parse', 'refs/heads/main')).toBe(main);

  // Ticket 394: a kept pr-<n> at another commit (the PR moved since) is refused, in the window's words.
  git(writer, 'commit', '-q', '--allow-empty', '-m', 'pr 414');
  git(writer, 'push', '-q', 'origin', 'HEAD:refs/pull/414/head');
  git(p, 'branch', 'pr-414', 'refs/heads/main');
  d = await openNew(app);
  await d.getByRole('textbox').first().fill('https://github.com/acme/demo/pull/414');
  await app.keyboard.press('Enter');
  await expect(app.getByRole('status').filter({ hasText: "Could not create the worktree: This PR’s branch already exists at an older commit. Delete it to get the newest commit." })).toBeVisible();

  // Another repository's PR, and the network off: an error, and no branch or worktree.
  const before = listed(core).length;
  d = await openNew(app);
  await d.getByRole('textbox').first().fill('https://github.com/other/thing/pull/5');
  await app.keyboard.press('Enter');
  await expect(app.getByRole('status').filter({ hasText: "Could not create the worktree: This PR belongs to a different repository than this project." })).toBeVisible();
  await shot(app.getByRole('status').filter({ hasText: 'Could not create' }), 'pr-foreign-toast');
  git(p, 'config', '--unset-all', `url.${origin}.insteadOf`);
  git(p, 'config', `url.${path.join(root, 'gone.git')}.insteadOf`, URL);
  d = await openNew(app);
  await d.getByRole('textbox').first().fill('https://github.com/acme/demo/pull/413');
  await app.keyboard.press('Enter');
  await expect(app.getByRole('status').filter({ hasText: "Could not create the worktree: Could not fetch the PR’s code (network). No branch or folder was made." })).toBeVisible();
  await shot(app.getByRole('status').filter({ hasText: "Could not fetch" }), 'pr-fetch-toast');
  expect(listed(core).length).toBe(before);
  expect(git(p, 'branch', '--list', 'pr-5', 'pr-413')).toBe('');
});

test('tidy_lists_worktrees_with_no_commits_unchecked_and_undo_brings_them_back', async ({ app, core }) => {
  const p = core.project('demo');
  git(p, 'init', '-q', '-b', 'main');
  git(p, 'commit', '-q', '--allow-empty', '-m', 'init');
  const mk = (branch: string) => (core.cli('worktree', 'create', '--project', p, '--branch', branch, '--no-focus').worktrees as Listed[]).find((w) => w.branch === branch)!;
  const spike = mk('spike-a');
  const s = core.cli('worktree', 'open', '--path', spike.path, '--no-focus').session as { id: string };
  core.cli('session', 'close', s.id);
  mk('try-b');
  const work = mk('has-work');
  git(work.path, 'commit', '-q', '--allow-empty', '-m', 'real work');
  const live = mk('live');
  core.cli('worktree', 'open', '--path', live.path, '--no-focus'); // a running session keeps it out
  await start(app, core, p);
  await app.locator('.grp[data-project="demo"] button.n').click({ button: 'right' });
  await app.getByRole('menuitem', { name: /Tidy worktrees/ }).click();
  const panel = app.getByRole('dialog', { name: /^Tidy/ });
  const group = panel.getByRole('region', { name: 'No commits (2)' });
  await expect(group.locator('li')).toHaveText([/spike-a\s*No new commits against the current branch · session closed/, /try-b\s*No new commits against the current branch · no session/]);
  await expect(group.getByRole('checkbox')).toHaveCount(2);
  for (const box of await group.getByRole('checkbox').all()) await expect(box).not.toBeChecked();
  await expect(panel).not.toContainText('has-work');
  await shot(panel, 'tidy-panel');
  await expect(panel.getByRole('button', { name: /^Remove/ })).toBeDisabled();
  await group.getByRole('checkbox').first().check();
  await panel.getByRole('button', { name: /^Remove/ }).click();
  await expect.poll(() => fs.existsSync(spike.path)).toBe(false);
  const toast = app.getByRole('status').filter({ hasText: /removed/i });
  await toast.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(() => fs.existsSync(spike.path)).toBe(true);
});
