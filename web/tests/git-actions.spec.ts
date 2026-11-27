// Ticket 373: the Diff header's one git button against a real core and a fake Claude. Nothing runs until it is
// pressed; a press puts one fixed prompt in that session (agent_prompt); on the default branch it is disabled and
// sends nothing (threat: one press must never push to the default branch).
import type { Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { expect, openWindow, REPO, test, type Core } from './fixtures';

const git = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'gc.auto=0', ...args], { encoding: 'utf8' }).trim();

/** A project on `main` with one commit, pushed to a bare origin whose HEAD is known; a fake gh and the picker Claude. */
function setup(core: Core) {
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
  // Present on PATH is all the core checks; the agent's own gh calls are not part of this test.
  fs.writeFileSync(path.join(core.home, 'bin/gh'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  return project;
}

/** Every agent_prompt the window sends, read off its socket. */
function spy(app: Page) {
  const prompts: { id: string; text: string }[] = [];
  void app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => {
      const msg = typeof m === 'string' ? JSON.parse(m) : null;
      if (msg?.request?.op === 'agent_prompt') prompts.push(msg.request);
      server.send(m);
    });
    server.onMessage((m) => ws.send(m));
  });
  return prompts;
}

type Send = { content: string; status: string };
const sendLog = (core: Core, id: string) => (core.cli('agent', 'get', id, '--json') as { send_log: Send[] }).send_log;
const diffIcon = (page: Page) => page.getByRole('navigation', { name: 'Right bar' }).getByRole('button', { name: 'Diff', exact: true });
const shot = (page: Page, name: string) => page.screenshot({ path: path.join(REPO, '.scratch/shots', `git-actions-${name}-${test.info().project.name}.png`) });
const PROMPT = 'Commit the changes, push this branch, then open a PR. Never push to the default branch.';

test('git actions: a worktree session runs nothing until pressed; a press puts the prompt in that session', async ({ app, core }) => {
  const project = setup(core);
  // A worktree on its own branch, as the window's New worktree makes it, and an agent session in it.
  const w = (core.cli('worktree', 'create', '--project', project, '--branch', 'fix-login', '--no-focus').worktrees as { path: string; branch: string }[]).find((x) => x.branch === 'fix-login')!;
  const s = core.cli('session', 'start', '--kind', 'claude', '--project', w.path, '--label', 'calm').session as { id: string; cwd: string };
  fs.writeFileSync(path.join(s.cwd, 'login.ts'), 'export const a = 2;\n');
  const head = git(s.cwd, 'rev-parse', 'HEAD');
  const prompts = spy(app);
  await openWindow(app);
  await diffIcon(app).click();
  const dock = app.getByRole('complementary', { name: 'Diff' });
  const button = dock.getByRole('button', { name: 'Commit, push & PR', exact: true });
  await expect(button).toBeVisible();
  await expect(button).not.toHaveAttribute('aria-disabled');
  await shot(app, 'ladder');
  // Nothing runs on its own: no prompt, no commit, after the list was read and the window settled.
  await app.waitForTimeout(1500);
  expect(prompts).toEqual([]);
  expect(sendLog(core, s.id)).toEqual([]);
  expect(git(s.cwd, 'rev-parse', 'HEAD')).toBe(head);

  await button.click();
  await expect.poll(() => sendLog(core, s.id)).toMatchObject([{ content: PROMPT, status: 'delivered' }]);
  expect(prompts).toEqual([{ op: 'agent_prompt', id: s.id, text: PROMPT }]);
  // One press asks once: until the turn ends or a refresh, the button waits.
  await expect(button).toHaveAttribute('aria-disabled', 'true');
  await expect(button).toHaveAttribute('data-tip', /The agent is working/);
  // An automatic refresh (window focus) before the agent shows working keeps the wait; only the person's Refresh ends it.
  await app.evaluate(() => window.dispatchEvent(new Event('focus')));
  await app.waitForTimeout(800);
  await expect(button).toHaveAttribute('data-tip', /The agent is working/);
  await button.click({ force: true });
  await shot(app, 'press');
  expect(prompts).toHaveLength(1);

  // What the agent does (the fake one does no git): commit, push, and the PR merged into main.
  git(s.cwd, 'commit', '-q', '-am', 'fix login');
  git(s.cwd, 'push', '-q', '-u', 'origin', 'HEAD');
  git(s.cwd, 'push', '-q', 'origin', 'HEAD:main');
  await dock.getByRole('button', { name: 'Refresh Diff' }).click();
  const done = dock.getByRole('button', { name: 'Commit', exact: true });
  await expect(done).toHaveAttribute('aria-disabled', 'true');
  await expect(done).toHaveAttribute('data-tip', 'The branch is up to date. Nothing to do.');
  await done.click({ force: true });
  await shot(app, 'after');
  expect(prompts).toHaveLength(1);
});

test('git actions: on the default branch the button is disabled with a reason and sends nothing', async ({ app, core }) => {
  const project = setup(core);
  const s = core.cli('session', 'start', '--kind', 'claude', '--project', project, '--label', 'main-agent').session as { id: string; cwd: string };
  expect(git(s.cwd, 'symbolic-ref', '--short', 'HEAD')).toBe('main');
  fs.writeFileSync(path.join(s.cwd, 'login.ts'), 'export const a = 3;\n');
  const prompts = spy(app);
  await openWindow(app);
  await diffIcon(app).click();
  const button = app.getByRole('complementary', { name: 'Diff' }).getByRole('button', { name: 'Commit, push & PR', exact: true });
  await expect(button).toHaveAttribute('aria-disabled', 'true');
  await expect(button).toHaveAttribute('data-tip', 'Not available on the default branch (main). Work in a worktree.');
  await button.click({ force: true });
  await button.focus();
  await app.keyboard.press('Enter');
  await shot(app, 'default-branch');
  await app.waitForTimeout(1000);
  expect(prompts).toEqual([]);
  expect(sendLog(core, s.id)).toEqual([]);
  expect(git(project, 'rev-parse', 'origin/main')).toBe(git(project, 'rev-parse', 'main'));
});

test('git actions: a local commit with no upstream offers Push & PR; a press after the branch became the default sends nothing', async ({ app, core }) => {
  const project = setup(core);
  const w = (core.cli('worktree', 'create', '--project', project, '--branch', 'fix-login', '--no-focus').worktrees as { path: string; branch: string }[]).find((x) => x.branch === 'fix-login')!;
  const s = core.cli('session', 'start', '--kind', 'claude', '--project', w.path, '--label', 'calm').session as { id: string; cwd: string };
  // An app worktree starts from a sha: its branch has no upstream. One local commit, nothing uncommitted.
  fs.writeFileSync(path.join(s.cwd, 'login.ts'), 'export const a = 4;\n');
  git(s.cwd, 'commit', '-q', '-am', 'fix login');
  const prompts = spy(app);
  // The agent path (the app's own path is git-push.spec.ts and pr-create.spec.ts): the last pick, kept by the window.
  await app.addInitScript(() => localStorage.setItem('nunchiro.diffGitWay', 'agent'));
  await openWindow(app);
  await diffIcon(app).click();
  const dock = app.getByRole('complementary', { name: 'Diff' });
  const push = dock.getByRole('button', { name: 'Ask Claude to push & open PR', exact: true });
  await expect(push).toBeVisible();
  await expect(push).not.toHaveAttribute('aria-disabled');

  // The list is now stale: the branch became a default name. The press reads the facts again and sends nothing.
  git(s.cwd, 'branch', '-m', 'master');
  await push.click();
  await expect(push).toHaveAttribute('aria-disabled', 'true');
  await expect(push).toHaveAttribute('data-tip', 'Not available on the default branch (master). Work in a worktree.');
  await push.click({ force: true });
  await app.waitForTimeout(1000);
  expect(prompts).toEqual([]);
  expect(sendLog(core, s.id)).toEqual([]);
});

test('git actions: an SSH session has no button (its prompt would reach this core, which does not run it)', async ({ app, core }) => {
  const project = setup(core);
  const w = (core.cli('worktree', 'create', '--project', project, '--branch', 'fix-login', '--no-focus').worktrees as { path: string; branch: string }[]).find((x) => x.branch === 'fix-login')!;
  const s = core.cli('session', 'start', '--kind', 'claude', '--project', w.path, '--label', 'calm').session as { id: string; cwd: string };
  fs.writeFileSync(path.join(s.cwd, 'login.ts'), 'export const a = 5;\n');
  // The snapshot names a machine; the Remote-wrapped diff_list is answered by this core, so the list still loads.
  const prompts: unknown[] = [];
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => {
      const msg = typeof m === 'string' ? JSON.parse(m) : null;
      if (msg?.request?.op === 'agent_prompt') prompts.push(msg.request);
      server.send(msg?.request?.op === 'remote' ? JSON.stringify({ ...msg, request: msg.request.request }) : m);
    });
    server.onMessage((m) => {
      const msg = typeof m === 'string' ? JSON.parse(m) : null;
      if (msg?.event === 'snapshot') return ws.send(JSON.stringify({ ...msg, sessions: msg.sessions.map((x: { id: string }) => (x.id === s.id ? { ...x, machine: 'mac2' } : x)) }));
      ws.send(m);
    });
  });
  await openWindow(app);
  await diffIcon(app).click();
  const dock = app.getByRole('complementary', { name: 'Diff' });
  await expect(dock.getByRole('list', { name: 'Changed files' })).toContainText('login.ts');
  await expect(dock.locator('.dgit')).toHaveCount(0);
  expect(prompts).toEqual([]);
});
