// Ticket 222 (B19a): Diff's "Latest turn / Changes" scope. Real core, a fake Claude whose transcript the test writes;
// the core puts each finished turn's written files on its turn event (chat/turn_files.rs).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { append, ChatCore, expect, openChat, rec, test } from './fixtures/chat/harness';
import { REPO } from './fixtures';
import { latestTurn, scoped } from '../src/diff/scope';
import type { Change } from '../src/diff/Diff';
import type { ChatEvent } from '../src/chat/feed';

const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'gc.auto=0', ...args], { encoding: 'utf8' });

/** A Claude chat session on a git project whose first commit holds a.txt, b.txt and c.txt. */
function session(core: ChatCore) {
  const dir = core.project('demo');
  git(dir, 'init', '-q');
  for (const f of ['a.txt', 'b.txt', 'c.txt']) fs.writeFileSync(path.join(dir, f), `${f}\n`);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  const s = core.chat('demo');
  // Claude stamps every record with the session cwd; the core reads the project root from it.
  const at = (r: object) => ({ ...r, cwd: s.cwd });
  const edit = (id: string, file: string) => {
    fs.writeFileSync(path.join(s.cwd, file), `${file} changed\nmore\n`);
    return rec.edit(id, path.join(s.cwd, file), [`-${file}`, `+${file} changed`, '+more']).map(at);
  };
  let n = 0;
  const end = () => at({ type: 'system', subtype: 'turn_duration', uuid: `turn-${++n}`, durationMs: 10 });
  return { s, dir, at, edit, end, write: (...r: unknown[]) => append(s.file, ...r) };
}

const dock = (page: Page) => page.getByRole('complementary', { name: 'Diff' });
const files = (page: Page) => dock(page).getByRole('list', { name: 'Changed files' }).locator('[data-path]');
const scope = (page: Page, name: string) => dock(page).getByRole('radiogroup', { name: 'Diff scope' }).getByRole('radio', { name });
async function openDiff(page: Page) {
  await page.getByRole('navigation', { name: 'Right bar' }).getByRole('button', { name: 'Diff', exact: true }).click();
  await expect(dock(page)).toBeVisible();
}
const shot = (page: Page, name: string) => page.screenshot({ path: path.join(REPO, '.scratch/shots', `diff-scope-${name}-${test.info().project.name}.png`) });

test('diff_scope_latest_turn_lists_only_that_turns_files', async ({ page, chatCore }) => {
  const c = session(chatCore);
  // Turn 1 edits a.txt; turn 2 edits b.txt; c.txt changes outside any turn.
  c.write(c.at(rec.user('first')), ...c.edit('e1', 'a.txt'), c.end(), c.at(rec.user('second')), ...c.edit('e2', 'b.txt'), c.end());
  fs.writeFileSync(path.join(c.s.cwd, 'c.txt'), 'c by hand\n');
  await openChat(page, c.s.id);
  await openDiff(page);
  await expect(files(page)).toHaveCount(3);
  await scope(page, 'Turn files').click();
  await expect(scope(page, 'Turn files')).toHaveAttribute('aria-checked', 'true');
  // Same row look and counts as the Changes list.
  await expect(files(page)).toHaveText([/b\.txt.*modified.*\+2 −1/]);
  await expect(dock(page).locator('.dbase')).toContainText('the files of this turn, with all later changes · 1 file'); // B18 (ticket 991): Diff has no per-turn base, so the label says the changes are the whole session's
  await shot(page, 'latest');
  await files(page).first().click();
  await expect(page.getByRole('region', { name: 'Diff of b.txt' }).locator('tr.add')).toHaveText([/b\.txt changed/, /more/]);
  // A turn that wrote nothing: the scope says so in words.
  c.write(c.at(rec.user('third')), c.at(rec.assistant('nothing to change')), c.end());
  await dock(page).getByRole('button', { name: 'Refresh Diff' }).click();
  await expect(dock(page).getByRole('status')).toHaveText('The last turn changed no files.');
  await shot(page, 'latest-empty');
});

test('diff_scope_turn_with_shell_command_says_it_cannot_tell', async ({ page, chatCore }) => {
  // Real-app 11-10 defect 3: a turn appended to a.txt with a shell command, and Turn files said the turn changed no files.
  const c = session(chatCore);
  fs.appendFileSync(path.join(c.s.cwd, 'a.txt'), 'appended\n');
  c.write(c.at(rec.user('append a line')), c.at(rec.use('b1', 'Bash', { command: 'echo appended >> a.txt' })), c.at(rec.result('b1', '')), c.end());
  await openChat(page, c.s.id);
  await openDiff(page);
  await expect(files(page)).toHaveText([/a\.txt.*modified/]);
  await scope(page, 'Turn files').click();
  await expect(scope(page, 'Turn files')).toHaveAttribute('aria-checked', 'true');
  const status = dock(page).getByRole('status');
  await expect(status).toContainText('Nunchiro cannot tell which files this turn changed, because it ran commands.');
  await expect(status).not.toContainText('changed no files');
  await shot(page, 'turn-unknown');
  // Changes is one press away.
  await status.getByRole('button', { name: 'Show all changes' }).click();
  await expect(scope(page, 'Changes')).toHaveAttribute('aria-checked', 'true');
  // The button went with the press: focus lands on the scope it chose, not on the page.
  await expect(scope(page, 'Changes')).toBeFocused();
  await expect(files(page)).toHaveText([/a\.txt.*modified/]);
  // A turn that edited b.txt and also ran a command lists b.txt and adds nothing (coordinator, round 2).
  c.write(c.at(rec.user('more')), ...c.edit('e2', 'b.txt'), c.at(rec.use('b2', 'Bash', { command: 'true' })), c.end());
  await scope(page, 'Turn files').click();
  await expect(files(page)).toHaveText([/b\.txt.*modified/]);
  await expect(dock(page).getByRole('note')).toHaveCount(0);
  await expect(dock(page).getByRole('button', { name: 'Show all changes' })).toHaveCount(0);
});

test('diff_scope_changes_unchanged', async ({ page, chatCore }) => {
  const c = session(chatCore);
  c.write(c.at(rec.user('go')), ...c.edit('e1', 'a.txt'), c.end());
  fs.writeFileSync(path.join(c.s.cwd, 'c.txt'), 'c by hand\n');
  fs.writeFileSync(path.join(c.s.cwd, 'new.md'), '# new\n');
  await openChat(page, c.s.id);
  await openDiff(page);
  // The default scope is Changes: every changed and untracked file against the start commit, as before.
  await expect(scope(page, 'Changes')).toHaveAttribute('aria-checked', 'true');
  await expect(files(page)).toHaveText([/a\.txt.*modified/, /c\.txt.*modified/, /new\.md.*untracked/]);
  await expect(dock(page).locator('.dbase')).toContainText('session start · 3 files');
  await shot(page, 'changes');
});

test('diff_scope_latest_turn_disabled_before_first_turn', async ({ page, chatCore }) => {
  const c = session(chatCore);
  // An edit, but the turn has not finished.
  c.write(c.at(rec.user('go')), ...c.edit('e1', 'a.txt'));
  await openChat(page, c.s.id);
  await openDiff(page);
  const turn = scope(page, 'Turn files');
  await expect(turn).toHaveAttribute('aria-disabled', 'true');
  await expect(turn).toHaveAttribute('title', 'No turn has finished yet in this session, so there is no latest turn to show.');
  await turn.click({ force: true }); // Playwright waits on aria-disabled; the real click must do nothing
  await expect(scope(page, 'Changes')).toHaveAttribute('aria-checked', 'true');
  await expect(files(page)).toHaveText([/a\.txt/]);
  await shot(page, 'disabled');
  // The turn finishes: the scope becomes available without reopening Diff.
  c.write(c.end());
  await expect(turn).not.toHaveAttribute('aria-disabled', 'true');
});

test('diff_scope_choice_kept_per_window', async ({ page, chatCore }) => {
  const c = session(chatCore);
  c.write(c.at(rec.user('first')), ...c.edit('e1', 'a.txt'), c.end(), c.at(rec.user('second')), ...c.edit('e2', 'b.txt'), c.end());
  await openChat(page, c.s.id);
  await openDiff(page);
  // Radio basics: one tab stop, arrows move and select, the focus ring shows.
  await expect(scope(page, 'Turn files')).not.toHaveAttribute('aria-disabled', 'true');
  await scope(page, 'Changes').focus();
  await expect(scope(page, 'Changes')).toHaveAttribute('tabindex', '0');
  await expect(scope(page, 'Turn files')).toHaveAttribute('tabindex', '-1');
  await page.keyboard.press('ArrowLeft');
  await expect(scope(page, 'Turn files')).toBeFocused();
  await expect(scope(page, 'Turn files')).toHaveAttribute('aria-checked', 'true');
  expect(await scope(page, 'Turn files').evaluate((e) => getComputedStyle(e).outlineStyle)).not.toBe('none');
  await expect(files(page)).toHaveText([/b\.txt/]);
  await page.keyboard.press('ArrowRight');
  await expect(scope(page, 'Changes')).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Space');
  await expect(scope(page, 'Changes')).toHaveAttribute('aria-checked', 'true');
  await scope(page, 'Turn files').focus();
  await page.keyboard.press('Enter');
  await expect(scope(page, 'Turn files')).toHaveAttribute('aria-checked', 'true');
  // The window keeps the choice: a reload opens Diff on Latest turn.
  await page.reload();
  await expect(page.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  await page.locator(`.tab[data-tab="${c.s.id}"]`).click();
  if (!(await dock(page).isVisible())) await openDiff(page);
  await expect(scope(page, 'Turn files')).toHaveAttribute('aria-checked', 'true');
  await expect(files(page)).toHaveText([/b\.txt/]);
});

test('diff_scope_pure_filter_drops_reverted_files', () => {
  const change = (p: string, old_path: string | null = null): Change => ({ path: p, status: old_path ? 'R' : 'M', old_path, additions: 1, deletions: 0, binary: false });
  let cursor = 0;
  const ev = (data: unknown): ChatEvent => ({ schema_version: 1, cursor: ++cursor, data: data as ChatEvent['data'] });
  // The Diff list no longer has reverted.txt: the turn wrote it, then put it back.
  const list = [change('kept.txt'), change('other.txt'), change('moved.txt', 'was.txt')];
  expect(scoped(list, ['reverted.txt', 'kept.txt', 'was.txt']).map((f) => f.path)).toEqual(['kept.txt', 'moved.txt']);
  expect(scoped(list, [])).toEqual([]);
  // The latest finished turn wins; a started turn or one without a file list does not count.
  expect(latestTurn([])).toBeNull();
  expect(latestTurn([ev({ kind: 'turn', turn_id: 'a', state: 'completed' })])).toBeNull();
  expect(latestTurn([ev({ kind: 'turn', turn_id: 'a', state: 'completed', files: ['x'] }), ev({ kind: 'turn', turn_id: 'b', state: 'started' })])).toEqual(['x']);
  expect(latestTurn([ev({ kind: 'turn', turn_id: 'a', state: 'completed', files: ['x'] }), ev({ kind: 'turn', turn_id: 'b', state: 'interrupted', files: ['y', 3] })])).toEqual(['y']);
});
