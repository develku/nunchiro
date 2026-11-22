// V2.5-56 (ticket 215 B12): the palette lists Sessions, then Commands, then Settings, each under a header; a session row wears
// the tree row's state dot (named, not colour alone) and its branch. Real core, real git repo under the test home.
import { execFileSync } from 'node:child_process';
import type { Page } from '@playwright/test';
import { expect, openWindow, test, type Core } from './fixtures';
import { paletteState, sameNameTell } from '../src/chrome/paletteState';
import type { T } from '../src/i18n';
import type { Session } from '../src/types';

const git = (dir: string, ...a: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { encoding: 'utf8' });
const repo = (core: Core) => {
  const p = core.project('repo');
  git(p, 'init', '-q', '-b', 'main');
  git(p, 'commit', '-q', '--allow-empty', '-m', 'init');
  return p;
};
/** A managed worktree on `branch` with a session in it (the row the palette gives a branch). */
const onBranch = (core: Core, p: string, branch: string, label: string) => {
  const w = (core.cli('worktree', 'create', '--project', p, '--branch', branch, '--no-focus').worktrees as { path: string; branch: string }[]).find((x) => x.branch === branch)!;
  return core.cli('worktree', 'open', '--path', w.path, '--label', label, '--no-focus').session as { id: string };
};
const open = async (app: Page) => {
  await app.getByRole('button', { name: 'Open command palette' }).click();
  return app.getByRole('combobox', { name: 'Command palette search' });
};
const headers = (app: Page) => app.locator('#palette-list [data-group]').evaluateAll((els) => els.map((e) => e.textContent));
/** The selected row's command id; a header would have none. */
const selected = (app: Page) => app.locator('#palette-list [aria-selected="true"]').getAttribute('data-command');

test('palette_groups_sessions_first_with_dot_and_branch', async ({ app, core }) => {
  const p = repo(core);
  core.shell(p, 'main-shell');
  onBranch(core, p, 'feature-x', 'on-branch');
  await openWindow(app);
  const search = await open(app);
  await expect(app.locator('#palette-list [data-command]').first()).toBeVisible();
  expect(await headers(app)).toEqual(['Sessions', 'Commands', 'Settings']);
  const ids = await app.locator('#palette-list [data-command]').evaluateAll((els) => els.map((e) => e.getAttribute('data-command')!));
  const kind = (id: string) => (id.startsWith('session.open.') ? 0 : id.startsWith('settings.') ? 2 : 1);
  expect(ids.map(kind)).toEqual([...ids.map(kind)].sort());
  // Down walks the rows only: from the last session it lands on the first command, never on a header.
  const sessions = ids.filter((id) => kind(id) === 0).length;
  expect(await selected(app)).toBe(ids[0]);
  for (let i = 1; i <= ids.length - 1; i++) {
    await search.press('ArrowDown');
    expect(await selected(app)).toBe(ids[i]);
  }
  for (let i = ids.length - 2; i >= sessions - 1; i--) {
    await search.press('ArrowUp');
    expect(await selected(app)).toBe(ids[i]);
  }
});

test('palette_session_row_shows_state_and_branch', async ({ app, core }) => {
  const p = repo(core);
  const s = onBranch(core, p, 'feature-x', 'on-branch');
  core.shell(p, 'plain-shell');
  await openWindow(app);
  const search = await open(app);
  await search.fill('on-branch');
  const row = app.locator(`#palette-list [data-command="session.open.${s.id}"]`);
  await expect(row).toBeVisible();
  await expect(row.locator('.branch')).toHaveText('feature-x');
  await expect(row.getByRole('img', { name: /^(Your turn|Working|Done|Failed|Idle)$/ })).toBeVisible();
  // A session with no branch shows none.
  await search.fill('plain-shell');
  await expect(app.locator('#palette-list [data-command^="session.open."] .branch')).toHaveCount(0);
  await expect(app.locator('#palette-list [data-command^="session.open."]').getByRole('img')).toHaveCount(1);
});

test('palette_state_dot_follows_the_tree_row_states', () => {
  const s = (over: Partial<Session> & { attention?: Partial<Session['attention']> }) =>
    ({ state: 'running', pending: [], ...over, attention: { working: false, stale: false, failed: false, waiting: false, last_activity: 0, ...over.attention } }) as unknown as Session;
  expect(paletteState(s({ attention: { waiting: true } as Session['attention'] }))).toBe('you');
  expect(paletteState(s({ attention: { working: true } as Session['attention'] }))).toBe('run');
  expect(paletteState(s({ state: 'exited' as Session['state'] }))).toBe('done');
  expect(paletteState(s({ state: 'failed' as Session['state'] }))).toBe('bad');
  expect(paletteState(s({}))).toBe('idle');
});

// Look 1117 v11 A S3-12: two sessions of one name in one project read "Go to sl1 (proj1)" twice.
test('palette_same_name_rows_tell_state_and_age', () => {
  const now = Date.parse('2026-11-19T12:00:00Z');
  const s = (id: string, project: string, state: string, ago: number) => ({ id, project, label: 'sl1', state, pending: [], attention: { working: false, stale: false, failed: false, waiting: false, last_activity: now - ago } }) as unknown as Session;
  const list = [s('a', '/p1', 'resumable', 3 * 3_600_000), s('b', '/p1', 'running', 120_000), s('c', '/p2', 'running', 0)];
  const t = ((k: string, v?: { n?: number }) => (v?.n === undefined ? k : `${k}:${v.n}`)) as T; // the node run has no catalogue
  const tell = sameNameTell(list, (x) => x.label, t, now);
  expect(list.map(tell)).toEqual([' · mw.status.resumable · chat.pr.hours:3', ' · mw.status.idle · chat.pr.minutes:2', '']);
});

// Look 1117 v16 A S3-12: two of one name, state and time words still read the same; the id's tail tells them apart.
test('palette_same_name_same_words_rows_add_id_tail', () => {
  const s = (id: string) => ({ id, project: '/p1', label: 'Notes', state: 'running', pending: [], attention: { working: false, stale: false, failed: false, waiting: false, last_activity: 0 } }) as unknown as Session;
  const list = [s('aaaa-1111'), s('bbbb-2222')];
  const tell = sameNameTell(list, (x) => x.label, ((k: string) => k) as T);
  expect(list.map(tell)).toEqual([' · mw.status.idle · #1111', ' · mw.status.idle · #2222']);
});

test('palette_empty_group_has_no_header', async ({ app, core }) => {
  const p = repo(core);
  core.shell(p, 'sidekick');
  await openWindow(app);
  const search = await open(app);
  await search.fill('sidekick');
  await expect(app.locator('#palette-list [data-command]').first()).toBeVisible();
  expect(await headers(app)).toEqual(['Sessions']);
  await search.fill('toggle sidebar');
  await expect(app.locator('#palette-list [data-command="sidebar.left.toggle"]')).toBeVisible();
  expect(await headers(app)).not.toContain('Sessions');
});

test('palette_enter_and_activedescendant_across_group', async ({ app, core }) => {
  const p = repo(core);
  core.shell(p, 'main-shell');
  await openWindow(app);
  const search = await open(app);
  await expect(app.locator('#palette-list [data-command]').first()).toBeVisible();
  const ids = await app.locator('#palette-list [data-command]').evaluateAll((els) => els.map((e) => e.getAttribute('data-command')!));
  const target = 'sidebar.left.toggle';
  // Down from the Sessions group across the header into Commands; the combobox points at the selected row each step.
  for (let i = 1; i <= ids.indexOf(target); i++) {
    await search.press('ArrowDown');
    const id = await app.locator('#palette-list [aria-selected="true"]').getAttribute('id');
    await expect(search).toHaveAttribute('aria-activedescendant', id!);
  }
  expect(await selected(app)).toBe(target);
  await expect(app.locator('aside.sbar[data-side="left"]')).toHaveCount(1);
  await search.press('Enter');
  await expect(app.getByRole('dialog', { name: 'Command palette' })).toHaveCount(0);
  await expect(app.locator('aside.sbar[data-side="left"]')).toHaveCount(0);
});
