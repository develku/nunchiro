// V2.5-61 B8 (ticket 220, needs 96 One-click+): the New worktree dialog offers an existing branch when the typed name
// matches one, tags branches already in a worktree, and sits under the worktree button it was opened from. Real core and
// real git repos under the test home; the branch list comes from the core's read-only `branches` op.
import { execFileSync } from 'node:child_process';
import type { Page } from '@playwright/test';
import { expect, openWindow, test, type Core } from './fixtures';
import { openQuiet } from './tree-seed';

const git = (dir: string, ...a: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { encoding: 'utf8' }).trim();
const repo = (core: Core, ...branches: string[]) => {
  const p = core.project('repo');
  git(p, 'init', '-q', '-b', 'main');
  git(p, 'commit', '-q', '--allow-empty', '-m', 'init');
  for (const b of branches) git(p, 'branch', b);
  return p;
};
const locals = (p: string) => git(p, 'branch', '--list', '--format=%(refname:short)').split('\n').filter(Boolean);
type Listed = { path: string; branch: string };
const listed = (core: Core) => core.cli('worktree', 'list').worktrees as Listed[];
/** A project head needs a session; the idle project starts folded in its quiet line, opened first. */
const start = async (app: Page, core: Core, p: string) => (core.shell(p, 'main-shell'), openQuiet(core), openWindow(app));
const button = (app: Page) => app.getByRole('button', { name: 'New worktree in repo', exact: true });
/** One click on the project head's visible worktree button. */
const openFromButton = async (app: Page) => {
  await app.locator('.grp[data-project="repo"] .row.head').hover();
  await button(app).click();
  return app.getByRole('dialog', { name: 'New worktree', exact: true });
};
const list = (app: Page) => app.getByRole('listbox', { name: 'Existing branches' });

test('worktree_dialog_offers_existing_branch_when_name_matches', async ({ app, core }) => {
  const p = repo(core, 'feat-x', 'feat-xy');
  await start(app, core, p);
  const d = await openFromButton(app);
  await d.getByRole('textbox').fill('feat-x');
  const options = list(app).getByRole('option');
  await expect(options.first()).toHaveText('Use existing branch feat-x');
  await expect(options.first()).toHaveAttribute('aria-selected', 'true');
  await expect(options.nth(1)).toHaveText('feat-xy');
  await expect(options.nth(1)).toHaveAttribute('aria-selected', 'false');
  await expect(d.getByRole('status')).toHaveText('Uses existing branch feat-x');
  await d.getByRole('textbox').fill('nothing-like-it');
  await expect(app.getByRole('option', { name: /Use existing branch/ })).toHaveCount(0);
  await expect(list(app)).toHaveCount(0);
  await expect(d.getByRole('status')).toHaveText('Creates nothing-like-it from current branch');
});

test('worktree_dialog_tags_refs_already_in_a_worktree', async ({ app, core }) => {
  const p = repo(core, 'taken', 'tabby');
  core.cli('worktree', 'create', '--project', p, '--branch', 'taken', '--no-focus');
  // A remote ref whose name a local branch already has: create would check out the local one, so it is not listed.
  git(p, 'update-ref', 'refs/remotes/origin/taken', 'HEAD');
  await start(app, core, p);
  const d = await openFromButton(app);
  await d.getByRole('textbox').fill('ta');
  const taken = list(app).getByRole('option', { name: /^taken/ });
  await expect(taken).toContainText('in worktree');
  await expect(taken).toHaveAttribute('aria-disabled', 'true');
  await expect(list(app).getByRole('option')).toHaveText(['tabby', 'takenin worktree']);
  await d.getByRole('textbox').fill('origin/taken');
  await expect(list(app)).toHaveCount(0);
  await d.getByRole('textbox').fill('ta');
  // ArrowDown skips the disabled row, both from nothing selected and when wrapping.
  await app.keyboard.press('ArrowDown');
  await expect(list(app).getByRole('option', { name: 'tabby' })).toHaveAttribute('aria-selected', 'true');
  await app.keyboard.press('ArrowDown');
  await expect(list(app).getByRole('option', { name: 'tabby' })).toHaveAttribute('aria-selected', 'true');
  await expect(taken).toHaveAttribute('aria-selected', 'false');
  // The exact name of a branch in a worktree: never offered, never selected.
  await d.getByRole('textbox').fill('taken');
  await expect(app.getByRole('option', { name: /Use existing branch/ })).toHaveCount(0);
  await expect(taken).toHaveAttribute('aria-selected', 'false');
  // A click on the disabled row does nothing (forced: Playwright never clicks an aria-disabled element itself).
  await taken.click({ force: true });
  await expect(d).toBeVisible();
  await app.keyboard.press('Enter');
  await expect(d).toHaveCount(0);
  // One-click+ create from the text: git refuses the checked-out branch, so nothing is created on it.
  await expect(app.getByRole('status').filter({ hasText: /already (used by|checked out at) worktree/ })).toBeVisible();
  expect(listed(core).filter((w) => w.branch === 'taken')).toHaveLength(1);
});

test('worktree_dialog_existing_branch_creates_without_new_branch', async ({ app, core }) => {
  const p = repo(core, 'feat-x');
  const old = git(p, 'rev-parse', 'feat-x');
  git(p, 'commit', '-q', '--allow-empty', '-m', 'main moves on');
  git(p, 'update-ref', 'refs/remotes/origin/far', old);
  const before = locals(p);
  await start(app, core, p);
  let d = await openFromButton(app);
  await d.getByRole('textbox').fill('feat-x');
  await expect(list(app).getByRole('option').first()).toHaveText('Use existing branch feat-x');
  await app.keyboard.press('Enter');
  await expect(d).toHaveCount(0);
  await expect.poll(() => listed(core).filter((w) => w.branch === 'feat-x').length).toBe(1);
  const w = listed(core).find((w) => w.branch === 'feat-x')!;
  expect(git(w.path, 'branch', '--show-current')).toBe('feat-x');
  expect(locals(p)).toEqual(before);
  expect(git(p, 'rev-parse', 'feat-x')).toBe(old);
  // A remote-only branch: a local branch made at the remote commit.
  d = await openFromButton(app);
  await d.getByRole('textbox').fill('far');
  await expect(list(app).getByRole('option').first()).toHaveText('Use existing branch origin/far');
  await app.keyboard.press('Enter');
  await expect.poll(() => listed(core).filter((w) => w.branch === 'far').length).toBe(1);
  const far = listed(core).find((w) => w.branch === 'far')!;
  expect(git(far.path, 'branch', '--show-current')).toBe('far');
  expect(git(p, 'rev-parse', 'refs/heads/far')).toBe(old);
});

test('worktree_dialog_popover_anchored_to_button', async ({ app, core }) => {
  const p = repo(core);
  await start(app, core, p);
  const d = await openFromButton(app);
  const b = (await button(app).boundingBox())!;
  const card = (await d.boundingBox())!;
  const vw = app.viewportSize()!.width;
  expect(card.y - (b.y + b.height)).toBeGreaterThanOrEqual(0);
  expect(card.y - (b.y + b.height)).toBeLessThanOrEqual(12);
  expect(Math.abs(card.x - b.x) <= 8 || card.x + card.width <= vw - 8).toBe(true);
  expect(card.x).toBeGreaterThanOrEqual(8);
  expect(card.x + card.width).toBeLessThanOrEqual(vw - 8);
  await app.keyboard.press('Escape');
  await expect(d).toHaveCount(0);
  // Cmd+N: no button, the centred card as before.
  await app.mouse.move(vw - 4, 4);
  await app.keyboard.press('Meta+KeyN');
  await expect(d).toBeVisible();
  const centred = (await d.boundingBox())!;
  expect(Math.abs(centred.x + centred.width / 2 - vw / 2)).toBeLessThanOrEqual(1);
});

test('worktree_branch_list_keys_and_esc', async ({ app, core }) => {
  const p = repo(core, 'k-one', 'k-three', 'k-two');
  await start(app, core, p);
  const d = await openFromButton(app);
  await d.getByRole('textbox').fill('k-');
  const options = list(app).getByRole('option');
  await expect(options).toHaveText(['k-one', 'k-three', 'k-two']);
  await expect(list(app).locator('[aria-selected="true"]')).toHaveCount(0);
  await app.keyboard.press('ArrowDown');
  await expect(options.nth(0)).toHaveAttribute('aria-selected', 'true');
  await app.keyboard.press('ArrowDown');
  await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true');
  await app.keyboard.press('ArrowUp');
  await expect(options.nth(0)).toHaveAttribute('aria-selected', 'true');
  await app.keyboard.press('ArrowUp');
  await expect(options.nth(2)).toHaveAttribute('aria-selected', 'true');
  await expect(d.getByRole('status')).toHaveText('Uses existing branch k-two');
  // First Esc: the list closes, the dialog stays; second Esc: the dialog closes and focus is back on its button.
  await app.mouse.move(1, 1);
  await app.keyboard.press('Escape');
  await expect(list(app)).toHaveCount(0);
  await expect(d).toBeVisible();
  await expect(d.getByRole('textbox')).toBeFocused();
  await app.keyboard.press('Escape');
  await expect(d).toHaveCount(0);
  await expect(button(app)).toBeFocused();
  // A click on an option creates on that branch.
  const again = await openFromButton(app);
  await again.getByRole('textbox').fill('k-th');
  await list(app).getByRole('option', { name: 'k-three' }).click();
  await expect(again).toHaveCount(0);
  await expect.poll(() => listed(core).map((w) => w.branch)).toEqual(['k-three']);
  expect(locals(p)).toEqual(['k-one', 'k-three', 'k-two', 'main']);
});

// Round 2 (security review SHOULDs).
test('worktree_dialog_failed_branch_read_leaves_dialog_as_is', async ({ app, core }) => {
  const p = repo(core, 'feat-x');
  let refused = () => {};
  const answered = new Promise<void>((r) => (refused = r));
  // The core refuses the branch read; everything else passes straight through.
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => {
      const r = typeof m === 'string' ? JSON.parse(m) : null;
      if (r?.request?.op === 'worktree' && r.request.operation === 'branches') {
        ws.send(JSON.stringify({ id: r.id, response: { Err: 'not a git top level' } }));
        refused();
        return;
      }
      server.send(m);
    });
    server.onMessage((m) => ws.send(m));
  });
  await start(app, core, p);
  const d = await openFromButton(app);
  await answered;
  await d.getByRole('textbox').fill('feat-x');
  await expect(d.getByRole('status')).toHaveText('Creates feat-x from current branch');
  await expect(list(app)).toHaveCount(0);
  await expect(d.getByRole('alert')).toHaveCount(0);
  // Today's One-click+ create still works.
  await app.keyboard.press('Enter');
  await expect(d).toHaveCount(0);
  await expect.poll(() => listed(core).map((w) => w.branch)).toEqual(['feat-x']);
});

test('worktree_dialog_remote_name_with_a_slash', async ({ app, core }) => {
  const p = repo(core);
  const old = git(p, 'rev-parse', 'HEAD');
  git(p, 'commit', '-q', '--allow-empty', '-m', 'main moves on');
  git(p, 'remote', 'add', 'team/up', 'https://example.invalid/t');
  git(p, 'update-ref', 'refs/remotes/team/up/far2', old);
  await start(app, core, p);
  const d = await openFromButton(app);
  await d.getByRole('textbox').fill('far2');
  await expect(list(app).getByRole('option').first()).toHaveText('Use existing branch team/up/far2');
  await app.keyboard.press('Enter');
  await expect(d).toHaveCount(0);
  await expect.poll(() => listed(core).map((w) => w.branch)).toEqual(['far2']);
  expect(git(p, 'rev-parse', 'refs/heads/far2')).toBe(old);
});

test('worktree_dialog_card_follows_its_row_on_resize', async ({ app, core }) => {
  const p = repo(core);
  await start(app, core, p);
  const d = await openFromButton(app);
  const before = (await d.boundingBox())!;
  // The row moves (here pushed down by a 40px margin, which collapses with the margin of the Assistants group above it,
  // ticket 1032), then the window resizes: the card goes with the row.
  const grp = app.locator('.grp[data-project="repo"]');
  const rowBefore = (await grp.boundingBox())!.y;
  await grp.evaluate((e) => ((e as HTMLElement).style.marginTop = '40px'));
  const moved = Math.round((await grp.boundingBox())!.y - rowBefore);
  expect(moved).toBeGreaterThan(30);
  const size = app.viewportSize()!;
  await app.setViewportSize({ width: size.width - 10, height: size.height });
  await expect.poll(async () => Math.round((await d.boundingBox())!.y - before.y)).toBe(moved);
});
