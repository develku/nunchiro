// Ticket 377 item 1: the palette lists the session you just left first, finds a session by the branch its row shows, and
// says "Nothing matched" instead of going blank.
import { execFileSync } from 'node:child_process';
import type { Page } from '@playwright/test';
import { expect, openWindow, test } from './fixtures';

const git = (dir: string, ...a: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { encoding: 'utf8' });
const ids = (app: Page) => app.locator('#palette-list [data-command]').evaluateAll((els) => els.map((e) => e.getAttribute('data-command')!));
const openPalette = async (app: Page) => {
  await app.getByRole('button', { name: 'Open command palette' }).click();
  return app.getByRole('combobox', { name: 'Command palette search' });
};
const focus = async (app: Page, id: string) => {
  await app.locator(`.tab[data-tab="${id}"]`).click();
  await expect(app.locator(`.tab[data-tab="${id}"]`)).toHaveAttribute('aria-selected', 'true');
};

test('palette_lists_the_session_just_left_first', async ({ app, core }) => {
  const p = core.project('demo');
  // Tree order is one, two, three: A is the last of it, so only the recent list can put it first.
  const [b, , a] = ['one', 'two', 'three'].map((l) => core.shell(p, l).id);
  await openWindow(app, {}, core);
  await focus(app, a);
  await focus(app, b);
  await openPalette(app);
  await expect(app.locator('#palette-list [data-command]').first()).toBeVisible();
  expect((await ids(app))[0]).toBe(`session.open.${a}`);
});

test('palette_finds_a_session_by_its_branch', async ({ app, core }) => {
  const p = core.project('repo');
  git(p, 'init', '-q', '-b', 'main');
  git(p, 'commit', '-q', '--allow-empty', '-m', 'init');
  const w = (core.cli('worktree', 'create', '--project', p, '--branch', 'feature/zebra-stripes', '--no-focus').worktrees as { path: string; branch: string }[]).find((x) => x.branch === 'feature/zebra-stripes')!;
  const s = core.cli('worktree', 'open', '--path', w.path, '--label', 'plain-name', '--no-focus').session as { id: string };
  await openWindow(app);
  await (await openPalette(app)).fill('zebra');
  await expect(app.locator(`#palette-list [data-command="session.open.${s.id}"]`)).toBeVisible();
});

test('palette_says_nothing_matched', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await (await openPalette(app)).fill('zzzz');
  await expect(app.locator('#palette-list [data-command]')).toHaveCount(0);
  await expect(app.locator('#palette-list li.empty[role="status"]')).toHaveText('Nothing matched');
});
