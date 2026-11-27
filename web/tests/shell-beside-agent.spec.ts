// A shell beside the agent in one step: the right bar's Terminal icon opens a shell in the agent's own folder (its
// worktree when it has one) in the side pane, and a second press hides it again (as T3 Code's terminal drawer). The
// agent's own screen stays one click away in the pane's tab row. New terminal from the "+" popover starts in the
// current agent's folder too.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import type { Page } from '@playwright/test';
import { expect, openWindow, test, type Core } from './fixtures';
import { icon } from './d5b';

type Snap = { id: string; kind: string; project: string; cwd: string; state: string };
const shells = (core: Core) => (core.cli('snapshot', '--json').sessions as Snap[]).filter((s) => s.kind === 'shell');
const pane = (page: Page) => page.locator('[data-side-pane]:not([hidden])');
const termIcon = (page: Page) => icon(page, 'right', 'Terminal');

/** A Claude agent in a new worktree of a repository of its own. */
function worktreeAgent(core: Core) {
  const dir = core.project('wt');
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('commit', '-q', '--allow-empty', '-m', 'init');
  return { dir, ...core.agent(dir, 'a', 'never-created', true) };
}
async function openAgent(page: Page, id: string) {
  await page.locator(`.tab[data-tab="${id}"]`).click();
  await expect(page.locator(`.chat[data-session="${id}"]`)).toBeVisible();
}

test('terminal_icon_opens_shell_in_agent_folder: one press shows a shell in the worktree, the next hides it, the third shows the same one', async ({ app, core }) => {
  const a = worktreeAgent(core);
  expect(fs.realpathSync(a.cwd)).not.toBe(fs.realpathSync(a.dir));
  await openWindow(app, {}, core);
  await openAgent(app, a.id);
  await termIcon(app).click();
  await expect.poll(() => shells(core).length).toBe(1);
  const sh = shells(core)[0];
  expect(fs.realpathSync(sh.cwd)).toBe(fs.realpathSync(a.cwd));
  // It belongs to the agent's project (the tree draws it under that project's worktree row, not as a project of its own).
  expect(fs.realpathSync(sh.project)).toBe(fs.realpathSync(a.dir));
  await expect(app.locator(`.term[data-session="${sh.id}"] .xterm-screen`)).toBeVisible();
  await expect(app.locator(`.term[data-session="${sh.id}"] .xterm-helper-textarea`)).toBeFocused();
  // The agent's own screen is one tab away.
  await expect(pane(app).getByRole('tab', { name: /PTY/ })).toBeVisible();
  await expect(termIcon(app)).toHaveAttribute('aria-pressed', 'true');
  await termIcon(app).click();
  await expect(pane(app)).toHaveCount(0);
  await termIcon(app).click();
  await expect(app.locator(`.term[data-session="${sh.id}"] .xterm-screen`)).toBeVisible();
  await app.waitForTimeout(300);
  expect(shells(core)).toHaveLength(1);
  // The row is a tablist of tabs only; Delete on the shell's tab closes it.
  await pane(app).getByRole('tab', { name: /shell/ }).focus();
  await app.keyboard.press('Delete');
  await expect(pane(app).getByRole('tab', { name: /shell/ })).toHaveCount(0);
  await expect.poll(() => shells(core).find((s) => s.id === sh.id)?.state).not.toBe('running');
});

test('new_terminal_from_worktree_agent_starts_in_its_folder: the popover\'s New terminal opens where the agent works', async ({ app, core }) => {
  const a = worktreeAgent(core);
  await openWindow(app, {}, core);
  await openAgent(app, a.id);
  await app.getByRole('button', { name: 'New session', exact: true }).click();
  await app.getByRole('dialog', { name: 'New tab' }).getByRole('option', { name: 'New terminal' }).click();
  await expect.poll(() => shells(core).length).toBe(1);
  expect(fs.realpathSync(shells(core)[0].cwd)).toBe(fs.realpathSync(a.cwd));
  expect(fs.realpathSync(shells(core)[0].project)).toBe(fs.realpathSync(a.dir));
});
