// Ticket 374: Diff keeps itself current, an older turn row opens with only its files, and Branch compares with where
// the branch left origin's default branch. Real core, a fake Claude whose transcript the test writes.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { append, chat, ChatCore, expect, openChat, rec, test } from './fixtures/chat/harness';
import { REPO } from './fixtures';

const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'gc.auto=0', ...args], { encoding: 'utf8' });

/** A Claude chat session on a git project; `before` runs on the project after its first commit, before the session starts. */
function session(core: ChatCore, before?: (dir: string) => void) {
  const dir = core.project('demo');
  git(dir, 'init', '-q', '-b', 'main');
  for (const f of ['a.txt', 'b.txt', 'c.txt']) fs.writeFileSync(path.join(dir, f), `${f}\n`);
  fs.writeFileSync(path.join(dir, 'long.txt'), Array.from({ length: 400 }, (_, i) => `line ${i}`).join('\n') + '\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  before?.(dir);
  const s = core.chat('demo');
  const at = (r: object) => ({ ...r, cwd: s.cwd });
  const edit = (id: string, file: string) => {
    fs.writeFileSync(path.join(s.cwd, file), `${file} changed\n`);
    return rec.edit(id, path.join(s.cwd, file), [`-${file}`, `+${file} changed`]).map(at);
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
const shot = (page: Page, name: string) => page.screenshot({ path: path.join(REPO, '.scratch/shots', `diff-data-${name}-${test.info().project.name}.png`) });

test('diff_refreshes_itself_and_keeps_the_scroll', async ({ page, chatCore }) => {
  const c = session(chatCore);
  // Every line of long.txt changes, so its patch scrolls.
  fs.writeFileSync(path.join(c.s.cwd, 'long.txt'), Array.from({ length: 400 }, (_, i) => `line ${i} edited`).join('\n') + '\n');
  await page.clock.install();
  await openChat(page, c.s.id);
  await openDiff(page);
  await expect(files(page)).toHaveText([/long\.txt/]);
  await files(page).first().click();
  // Ticket 374 (stacked view): every file scrolls in one view, so the stack is what scrolls and what must hold still.
  const code = dock(page).locator('.dstack');
  await expect(page.getByRole('region', { name: 'Diff of long.txt' }).locator('tr.add').first()).toBeVisible();
  await code.evaluate((e) => (e.scrollTop = 900));
  const topRow = () => code.evaluate((e) => { const r = e.getBoundingClientRect(); return document.elementFromPoint(r.left + r.width / 2, r.top + 40)?.closest('tr')?.textContent; });
  const before = await topRow();
  expect(before).toMatch(/line \d+/);
  let loading = 0;
  await page.exposeFunction('sawLoading', () => loading++);
  await page.evaluate(() => new MutationObserver(() => document.querySelector('.diff [aria-label="Diff of long.txt"] .dstate')?.textContent?.startsWith('Loading') && (window as unknown as { sawLoading: () => void }).sawLoading()).observe(document.body, { subtree: true, childList: true, characterData: true }));

  // Another file changes outside the app: the 30 s re-read lists it, no refresh pressed.
  fs.writeFileSync(path.join(c.s.cwd, 'a.txt'), 'by hand\n');
  await page.clock.fastForward(30_000);
  await expect(files(page)).toHaveText([/a\.txt/, /long\.txt/]);
  // Returning to the window re-reads too.
  fs.writeFileSync(path.join(c.s.cwd, 'b.txt'), 'by hand\n');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(files(page)).toHaveText([/a\.txt/, /b\.txt/, /long\.txt/]);
  // A turn that finishes re-reads at once.
  c.write(c.at(rec.user('go')), ...c.edit('e1', 'c.txt'), c.end());
  await expect(files(page)).toHaveText([/a\.txt/, /b\.txt/, /c\.txt/, /long\.txt/]);
  await expect(page.getByRole('region', { name: 'Diff of long.txt' })).toBeVisible();
  // Files listed above long.txt since: the same lines of long.txt are still under the reader.
  expect(await topRow()).toBe(before);
  expect(loading).toBe(0);
  await shot(page, 'refreshed');
});

test('diff_older_turn_row_opens_only_that_turns_files', async ({ page, chatCore }) => {
  const c = session(chatCore);
  c.write(c.at(rec.user('first')), ...c.edit('e1', 'a.txt'), c.end(), c.at(rec.user('second')), ...c.edit('e2', 'b.txt'), ...c.edit('e3', 'c.txt'), c.end());
  await openChat(page, c.s.id);
  const rows = chat(page, c.s.id).locator('.chcard'); // B19 (ticket 991): the changes card is the turn's one row
  await expect(rows).toHaveCount(2);
  await rows.first().getByRole('button', { name: 'View in Diff' }).click();
  await expect(scope(page, 'Turn files')).toHaveAttribute('aria-checked', 'true');
  await expect(files(page)).toHaveText([/a\.txt/]);
  await expect(dock(page).locator('.dbase')).toContainText('the files of this turn, with all later changes · 1 file'); // B18 (ticket 991): Diff has no per-turn base, so the label says the changes are the whole session's
  await shot(page, 'old-turn');
  // The latest row opens its own files; choosing the scope by hand shows the latest turn again.
  await rows.last().getByRole('button', { name: 'View in Diff' }).click();
  await expect(files(page)).toHaveText([/b\.txt/, /c\.txt/]);
  await rows.first().getByRole('button', { name: 'View in Diff' }).click();
  await expect(files(page)).toHaveText([/a\.txt/]);
  await scope(page, 'Changes').click();
  await scope(page, 'Turn files').click();
  await expect(files(page)).toHaveText([/b\.txt/, /c\.txt/]);
  // No origin here: Branch is off and says why.
  await expect(scope(page, 'Branch')).toHaveAttribute('aria-disabled', 'true');
  await expect(scope(page, 'Branch')).toHaveAttribute('title', 'There is no origin, so there is nothing to compare with.');
});

test('diff_branch_lists_every_commit_since_origin_default', async ({ page, chatCore }) => {
  // origin/main as a clone leaves it (no network); the branch has one commit before the session and one during it.
  const c = session(chatCore, (dir) => {
    git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    git(dir, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
    git(dir, 'checkout', '-q', '-b', 'feature');
    fs.writeFileSync(path.join(dir, 'one.txt'), 'one\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'one');
  });
  fs.writeFileSync(path.join(c.dir, 'two.txt'), 'two\n');
  git(c.dir, 'add', '-A');
  git(c.dir, 'commit', '-q', '-m', 'two');
  const main = git(c.dir, 'rev-parse', '--short=7', 'origin/main').trim();
  await openChat(page, c.s.id);
  await openDiff(page);
  await scope(page, 'Changes').click();
  await expect(files(page)).toHaveText([/two\.txt/]);
  await scope(page, 'Branch').click();
  await expect(scope(page, 'Branch')).toHaveAttribute('aria-checked', 'true');
  await expect(files(page)).toHaveText([/one\.txt.*added/, /two\.txt.*added/]);
  await expect(dock(page).locator('.dbase')).toHaveText(`vs ${main} · where it branched from origin/main · 2 files`);
  await files(page).first().click();
  await expect(page.getByRole('region', { name: 'Diff of one.txt' }).locator('tr.add')).toHaveText([/one/]);
  await shot(page, 'branch');
  // Back on main: nothing to compare, so Branch is off and the list is the session's changes.
  git(c.dir, 'checkout', '-q', 'main');
  await dock(page).getByRole('button', { name: 'Refresh Diff' }).click();
  await expect(scope(page, 'Branch')).toHaveAttribute('aria-disabled', 'true');
  await expect(scope(page, 'Branch')).toHaveAttribute('title', 'On the default branch there is no branch to compare.');
  await expect(scope(page, 'Changes')).toHaveAttribute('aria-checked', 'true');
});
