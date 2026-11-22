// needs 72 (names on hover, tree row 5): a row whose name is cut by the sidebar's width shows the whole name as its tip's
// first line; a row whose name fits keeps the tip it had. Heads follow the same rule.
import { execFileSync } from 'node:child_process';
import type { Page } from '@playwright/test';
import { expect, openWindow, test, type Core } from './fixtures';
import { openQuiet } from './tree-seed';

const gitRepo = (core: Core, name: string) => {
  const p = core.project(name);
  const git = (...a: string[]) => execFileSync('git', ['-C', p, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a]);
  git('init', '-q');
  git('commit', '-q', '--allow-empty', '-m', 'init');
  return p;
};
const wt = (core: Core, project: string, label: string) =>
  core.cli('session', 'start', '--kind', 'shell', '--project', project, '--label', label, '--worktree', '--', '/bin/cat').session as { id: string };
const LONG = 'backtest-walk-forward-regime-filter-experiment-2026';
const width = (app: Page, w: number) => app.locator('.sbar.l').evaluate((e, x) => { (e as HTMLElement).style.width = `${x}px`; }, w);

test('row_name_tip_when_truncated: at 240 px a long worktree name leads the tip on hover and on focus; a short name keeps its tip', async ({ app, core }) => {
  const p = gitRepo(core, 'repo');
  const long = wt(core, p, LONG);
  const short = wt(core, p, 'short');
  openQuiet(core); // quiet projects start folded
  await openWindow(app);
  await width(app, 240);
  const rowOf = (id: string) => app.locator(`.grp[data-project="repo"] .row.wt2[data-menu-session="${id}"]`);
  const tipOf = (id: string) => rowOf(id).locator('.tip');
  const quiet = async () => {
    await app.mouse.move(900, 600);
    await app.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  };

  await expect(rowOf(long.id)).toBeVisible();
  // The state words are what the tip said before; the short one keeps exactly them.
  await rowOf(short.id).hover();
  const shortHtml = await tipOf(short.id).innerHTML();
  await expect(tipOf(short.id)).toBeVisible();
  expect(await tipOf(short.id).locator('b').count()).toBe(1);
  expect(shortHtml).not.toContain(LONG);
  await expect(tipOf(short.id).locator('b').first()).not.toHaveText('short');

  // Hover: the cut name is the first bold line, the state lines stay below it.
  await quiet();
  await rowOf(long.id).hover();
  await expect(tipOf(long.id)).toBeVisible();
  await expect(tipOf(long.id).locator('b').first()).toHaveText(LONG);
  expect(await tipOf(long.id).locator('b').count()).toBe(2);
  const full = await tipOf(long.id).locator('b').first().boundingBox();
  const state = await tipOf(long.id).locator('b').nth(1).boundingBox();
  expect(state!.y).toBeGreaterThan(full!.y);
  // The tooltip stays decoration: aria-hidden, and the row's label is untouched by the measure.
  await expect(tipOf(long.id)).toHaveAttribute('aria-hidden', 'true');
  await expect(rowOf(long.id)).toHaveAttribute('aria-label', new RegExp(`^${LONG}, `));

  // Keyboard focus.
  await quiet();
  await rowOf(long.id).focus();
  await app.keyboard.press('Tab');
  await app.keyboard.press('Shift+Tab');
  await expect(rowOf(long.id)).toBeFocused();
  await expect(tipOf(long.id)).toBeVisible();
  await expect(tipOf(long.id).locator('b').first()).toHaveText(LONG);

  // Widen the sidebar until the name fits: the next hover shows the plain tip again.
  await quiet();
  await width(app, 520);
  await rowOf(long.id).hover();
  await expect(tipOf(long.id)).toBeVisible();
  expect(await tipOf(long.id).locator('b').count()).toBe(1);
});

test('row_name_tip_when_truncated (head): a cut project name leads the head tooltip; a project name that fits keeps the path alone', async ({ app, core }) => {
  const longP = core.project('a-project-with-a-very-long-folder-name-for-the-tree');
  const shortP = core.project('tiny');
  core.shell(longP, 'one');
  core.shell(shortP, 'two');
  openQuiet(core); // quiet projects start folded
  await openWindow(app);
  await width(app, 240);
  const head = (name: string) => app.locator(`.grp[data-project="${name}"] .head button.n`);
  const longName = 'a-project-with-a-very-long-folder-name-for-the-tree';
  await head(longName).hover({ position: { x: 12, y: 8 } });
  await expect(head(longName)).toHaveAttribute('title', new RegExp(`^${longName}\\n`));
  await head('tiny').hover({ position: { x: 12, y: 8 } });
  await expect(head('tiny')).toHaveAttribute('title', shortP);
});
