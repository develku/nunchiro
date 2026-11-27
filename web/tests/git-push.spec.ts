// The Diff header's Push, run by the app behind a confirm strip: the strip names the commits, the remote branch and the
// head commit; Push moves the remote branch to that head and sends no prompt to the agent. A commit made after the strip
// showed is refused by the core and the remote stays. The push works while the agent is working. "Ask the agent" stays
// as the other choice in the button's menu, and the last choice is remembered. Local bare remote only.
import type { Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { expect, openWindow, REPO, test, type Core } from './fixtures';

const git = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'gc.auto=0', ...args], { encoding: 'utf8' }).trim();

/** A project on `main` pushed to a bare origin, a worktree on `fix-login` with `n` local commits, a Claude session in it.
 *  No gh on PATH, so the button is Push (a PR needs gh). */
function setup(core: Core, n: number) {
  const origin = core.project('origin.git');
  git(origin, 'init', '-q', '--bare', '-b', 'main');
  const project = core.project('demo');
  git(project, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(project, 'login.ts'), 'export const a = 1;\n');
  git(project, 'add', '-A');
  git(project, 'commit', '-q', '-m', 'init');
  git(project, 'remote', 'add', 'origin', origin);
  git(project, 'push', '-q', '-u', 'origin', 'main');
  git(project, 'remote', 'set-head', 'origin', 'main');
  fs.copyFileSync(path.join(REPO, 'crates/nunchiro/tests/fixtures/claude-picker'), path.join(core.home, 'bin/claude'));
  const w = (core.cli('worktree', 'create', '--project', project, '--branch', 'fix-login', '--no-focus').worktrees as { path: string; branch: string }[]).find((x) => x.branch === 'fix-login')!;
  const s = core.cli('session', 'start', '--kind', 'claude', '--project', w.path, '--label', 'calm').session as { id: string; cwd: string };
  for (let i = 0; i < n; i++) git(s.cwd, 'commit', '-q', '--allow-empty', '-m', `change ${i}`);
  return { origin, s };
}

/** Every request the window sends, by op. */
function spy(app: Page) {
  const sent: { op: string; [k: string]: unknown }[] = [];
  void app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => {
      const msg = typeof m === 'string' ? JSON.parse(m) : null;
      if (msg?.request?.op) sent.push(msg.request);
      server.send(m);
    });
    server.onMessage((m) => ws.send(m));
  });
  return sent;
}

const remoteHead = (origin: string) => {
  try {
    return git(origin, 'rev-parse', '--verify', '-q', 'refs/heads/fix-login');
  } catch {
    return '';
  }
};
const diffIcon = (page: Page) => page.getByRole('navigation', { name: 'Right bar' }).getByRole('button', { name: 'Diff', exact: true });
const shot = (page: Page, name: string) => page.screenshot({ path: path.join(REPO, '.scratch/shots', `git-push-${name}-${test.info().project.name}.png`) });

test('git push: the strip names the commits, the remote and the head; Push moves the remote and asks no agent', async ({ app, core }) => {
  const { origin, s } = setup(core, 3);
  const head = git(s.cwd, 'rev-parse', 'HEAD');
  const sent = spy(app);
  await openWindow(app);
  await diffIcon(app).click();
  const dock = app.getByRole('complementary', { name: 'Diff' });
  await dock.getByRole('button', { name: 'Push', exact: true }).click();
  const strip = dock.getByRole('alertdialog', { name: 'Push' });
  await expect(strip).toContainText(`Push 3 commits to origin/fix-login? Head commit: ${head.slice(0, 7)}.`);
  await expect(strip.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await shot(app, 'strip');
  await app.emulateMedia({ colorScheme: 'dark' });
  await shot(app, 'strip-dark');
  await app.emulateMedia({ colorScheme: 'light' });
  await strip.getByRole('button', { name: 'Push', exact: true }).click();
  await expect(dock.getByRole('status').filter({ hasText: 'Pushed' })).toContainText('Pushed 3 commits to origin/fix-login.');
  expect(remoteHead(origin)).toBe(head);
  expect(git(s.cwd, 'rev-parse', '--abbrev-ref', '@{u}')).toBe('origin/fix-login');
  expect(sent.filter((r) => r.op === 'agent_prompt')).toEqual([]);
  expect(sent.filter((r) => r.op === 'git_push')).toEqual([{ op: 'git_push', session: s.id, head }]);
  await shot(app, 'pushed');
});

test('git push: a commit made after the strip showed is refused and the remote stays; Esc cancels', async ({ app, core }) => {
  const { origin, s } = setup(core, 1);
  await openWindow(app);
  await diffIcon(app).click();
  const dock = app.getByRole('complementary', { name: 'Diff' });
  const button = dock.getByRole('button', { name: 'Push', exact: true });
  await button.click();
  const strip = dock.getByRole('alertdialog', { name: 'Push' });
  await expect(strip).toBeVisible();
  await app.keyboard.press('Escape');
  await expect(strip).toHaveCount(0);
  await button.click();
  git(s.cwd, 'commit', '-q', '--allow-empty', '-m', 'made after the strip showed');
  const now = git(s.cwd, 'rev-parse', 'HEAD');
  await strip.getByRole('button', { name: 'Push', exact: true }).click();
  await expect(strip).toContainText(`Nothing was sent: the branch changed after this was shown (new head ${now.slice(0, 7)}). Look again.`);
  expect(remoteHead(origin)).toBe('');
  await shot(app, 'changed');
});

test('git push: works while the agent is working; Ask the agent is the other choice and is remembered', async ({ app, core }) => {
  const { origin, s } = setup(core, 2);
  core.hook(s.id, 'UserPromptSubmit');
  const sent = spy(app);
  await openWindow(app);
  await diffIcon(app).click();
  const dock = app.getByRole('complementary', { name: 'Diff' });
  const button = dock.getByRole('button', { name: 'Push', exact: true });
  await expect(button).not.toHaveAttribute('aria-disabled');
  await button.click();
  await dock.getByRole('alertdialog', { name: 'Push' }).getByRole('button', { name: 'Push', exact: true }).click();
  await expect(dock.getByRole('status').filter({ hasText: 'Pushed' })).toContainText('Pushed 2 commits to origin/fix-login.');
  expect(remoteHead(origin)).toBe(git(s.cwd, 'rev-parse', 'HEAD'));
  // The menu offers the agent path; while the agent works it is off with its reason, so the app path stays.
  git(s.cwd, 'commit', '-q', '--allow-empty', '-m', 'one more');
  await dock.getByRole('button', { name: 'Refresh Diff' }).click();
  await dock.getByRole('button', { name: 'Push choices' }).click();
  const ask = app.getByRole('menuitemradio', { name: 'Ask Claude to push' });
  await expect(ask).toHaveAttribute('aria-disabled', 'true');
  await app.keyboard.press('Escape');
  core.hook(s.id, 'Stop');
  await dock.getByRole('button', { name: 'Push choices' }).click();
  await ask.click();
  // The choice is remembered: the main button now asks the agent, and the window keeps the pick for the next Diff.
  expect(await app.evaluate(() => localStorage.getItem('nunchiro.diffGitWay'))).toBe('agent');
  const askButton = dock.getByRole('button', { name: 'Ask Claude to push', exact: true });
  await askButton.click();
  await expect.poll(() => sent.filter((r) => r.op === 'agent_prompt').map((r) => r.text)).toEqual(['Push this branch. Never push to the default branch.']);
  expect(sent.filter((r) => r.op === 'git_push')).toHaveLength(1);
});
