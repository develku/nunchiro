// Ticket 222 (B19b): after a finished turn that wrote files, the chat shows "N changed files" with an "Open diff" button
// that opens Diff on the Latest turn scope. Real core, a fake Claude whose transcript the test writes.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { append, chat, ChatCore, expect, openChat, rec, test } from './fixtures/chat/harness';
import { REPO } from './fixtures';

const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'gc.auto=0', ...args], { encoding: 'utf8' });

function session(core: ChatCore) {
  const dir = core.project('demo');
  git(dir, 'init', '-q');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  const s = core.chat('demo');
  const at = (r: object) => ({ ...r, cwd: s.cwd });
  const edit = (id: string, file: string) => {
    fs.writeFileSync(path.join(s.cwd, file), `${file} changed\n`);
    return rec.edit(id, path.join(s.cwd, file), [`+${file} changed`]).map(at);
  };
  let n = 0;
  const end = () => at({ type: 'system', subtype: 'turn_duration', uuid: `turn-${++n}`, durationMs: 10 });
  return { s, at, edit, end, write: (...r: unknown[]) => append(s.file, ...r) };
}
// B19 (ticket 991): a Claude turn's edits fold into one changed-files card (per-file +/-), which also opens Turn files;
// the plain "N changed files" row stays for turns without that card (Verbose, Codex).
const row = (page: Page, id: string) => chat(page, id).locator('.turnfiles, .chcard');
const shot = (page: Page, name: string) => page.screenshot({ path: path.join(REPO, '.scratch/shots', `chat-turn-files-${name}-${test.info().project.name}.png`) });

test('chat_turn_shows_changed_files_open_diff', async ({ page, chatCore }) => {
  const c = session(chatCore);
  const names = ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt', 'f.txt'];
  c.write(c.at(rec.user('go')), ...names.flatMap((f, i) => c.edit(`e${i}`, f)), c.at(rec.assistant('done')), c.end());
  // Changed by hand, outside the turn: Changes lists it, Latest turn does not.
  fs.writeFileSync(path.join(c.s.cwd, 'hand.txt'), 'by hand\n');
  await openChat(page, c.s.id);
  await expect(row(page, c.s.id)).toHaveCount(1);
  await expect(row(page, c.s.id)).toContainText('6 files changed');
  await expect(chat(page, c.s.id).locator('.turnfiles')).toHaveCount(0); // B19: one card, not two
  const open = row(page, c.s.id).getByRole('button', { name: 'View in Diff' });
  await shot(page, 'row');
  // Keyboard: focus ring from the shared tokens, Enter opens.
  await open.focus();
  // WebKit's Tab skips buttons unless the system "keyboard navigation" switch is on; Option+Tab reaches every control.
  const alt = page.context().browser()?.browserType().name() === 'webkit' ? 'Alt+' : '';
  await page.keyboard.press(`Shift+${alt}Tab`);
  await page.keyboard.press(`${alt}Tab`);
  await expect(open).toBeFocused();
  expect(await open.evaluate((e) => getComputedStyle(e).outlineStyle)).toBe('solid');
  await page.keyboard.press('Enter');
  const dock = page.getByRole('complementary', { name: 'Diff' });
  await expect(dock).toBeVisible();
  await expect(dock.getByRole('radio', { name: 'Turn files' })).toHaveAttribute('aria-checked', 'true');
  await expect(dock.getByRole('list', { name: 'Changed files' }).locator('[data-path]')).toHaveText(names.map((n) => new RegExp(n.replace('.', '\\.'))));
  await shot(page, 'open-diff');
  // A click works too, also after the Diff was switched back to Changes.
  await dock.getByRole('radio', { name: 'Changes' }).click();
  await expect(dock.getByRole('list', { name: 'Changed files' }).locator('[data-path]')).toHaveCount(7);
  await open.click();
  await expect(dock.getByRole('radio', { name: 'Turn files' })).toHaveAttribute('aria-checked', 'true');
  await expect(dock.getByRole('list', { name: 'Changed files' }).locator('[data-path]')).toHaveCount(6);
});

test('chat_turn_row_hidden_without_file_writes', async ({ page, chatCore }) => {
  const c = session(chatCore);
  // A finished turn that only read and talked; then a turn that writes but has not finished.
  c.write(c.at(rec.user('look')), c.at(rec.use('r1', 'Read', { file_path: path.join(c.s.cwd, 'a.txt') })), c.at(rec.result('r1', 'a')), c.at(rec.assistant('read it')), c.end());
  c.write(c.at(rec.user('now edit')), ...c.edit('e1', 'a.txt'));
  await openChat(page, c.s.id);
  await expect(chat(page, c.s.id).getByText('read it')).toBeVisible();
  // The read-only turn has no row; the writing turn has only its changes card (B19), before and after it ends.
  await expect(chat(page, c.s.id).locator('.turnfiles')).toHaveCount(0);
  await expect(row(page, c.s.id)).toHaveCount(1);
  c.write(c.end());
  await expect(row(page, c.s.id)).toHaveCount(1);
  await expect(row(page, c.s.id)).toContainText('1 file changed');
  await expect(chat(page, c.s.id).locator('.turnfiles')).toHaveCount(0);
});
