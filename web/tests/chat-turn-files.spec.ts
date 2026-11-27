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
  // Ticket 1057: three rows and one button; it unfolds the rest in place and folds back.
  const rows = row(page, c.s.id).locator('.frow');
  await expect(rows).toHaveCount(3);
  await row(page, c.s.id).getByRole('button', { name: '3 more files' }).click();
  await expect(rows).toHaveCount(6);
  await row(page, c.s.id).getByRole('button', { name: 'Show fewer' }).click();
  await expect(rows).toHaveCount(3);
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

test('chat_turn_four_files_show_all_and_outside_path_is_short', async ({ page, chatCore }) => {
  const c = session(chatCore);
  // Built from parts: a literal home path would be a publish-scan hit (docs/release/publish-check.md).
  const outside = ['', 'Users', 'someone', 'Documents/a/very/long/folder/name/that/cannot/fit/in/the/card/at/all/outside.txt'].join('/');
  c.write(c.at(rec.user('go')), ...['a.txt', 'b.txt', 'c.txt'].flatMap((f, i) => c.edit(`e${i}`, f)), ...rec.edit('o', outside, ['+x']).map(c.at), c.at(rec.assistant('done')), c.end());
  await openChat(page, c.s.id);
  await expect(row(page, c.s.id).locator('.frow')).toHaveCount(4);
  await expect(row(page, c.s.id).locator('.more')).toHaveCount(0);
  const p = row(page, c.s.id).locator('.p.out');
  await expect(p).toHaveAttribute('title', outside);
  await expect(p.locator('.nm')).toHaveText('outside.txt');
  await expect(p.locator('.dir')).toHaveText(/^~\/Documents/);
  const [h, nm] = await Promise.all([p.evaluate((e) => e.getBoundingClientRect().height), p.locator('.nm').evaluate((e) => e.scrollWidth - e.clientWidth)]);
  expect(h).toBeLessThan(24); // one line
  expect(nm).toBe(0); // the file name is whole
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
  await expect(row(page, c.s.id)).toHaveAttribute('aria-label', /^1 file changed, \d+ added, \d+ removed, this turn$/);
  await expect(chat(page, c.s.id).locator('.turnfiles')).toHaveCount(0);
});

// Ticket 1074: one changed file is one line: path, numbers, View in Diff; no head text.
test('chat_turn_one_file_is_one_line', async ({ page, chatCore }) => {
  const c = session(chatCore);
  c.write(c.at(rec.user('go')), ...c.edit('e1', 'a.txt'), c.at(rec.assistant('done')), c.end());
  await openChat(page, c.s.id);
  const card = row(page, c.s.id);
  const btn = card.getByRole('button', { name: 'View in Diff' });
  await expect(card).toHaveAttribute('aria-label', '1 file changed, 1 added, 0 removed, this turn');
  await expect(card.locator('.h')).toHaveCount(0);
  const line = async () => {
    const [p, a, b] = await Promise.all([card.locator('.frow .p'), card.locator('.frow .add'), btn].map((l) => l.boundingBox()));
    expect(Math.abs(p!.y - b!.y)).toBeLessThan(12);
    expect(Math.abs(a!.y - b!.y)).toBeLessThan(12);
    expect(b!.x).toBeGreaterThan(a!.x);
  };
  await line();
  await card.evaluate((e) => (e.style.width = '220px')); // a narrow chat, as view_in_diff_stays_one_line_when_narrow: the path shrinks, the button stays
  await line();
  await btn.click();
  await expect(page.getByRole('complementary', { name: 'Diff' }).getByRole('radio', { name: 'Turn files' })).toHaveAttribute('aria-checked', 'true');
});

// A real drive missed View in Diff: the card sat at the turn's end while the agent still wrote its reply, so each new line
// moved it down. While the agent works on the last turn the card waits; it shows once, where it stays.
test('chat_turn_card_does_not_move_while_the_turn_ends', async ({ page, chatCore }) => {
  const c = session(chatCore);
  c.write(c.at(rec.user('go')), ...c.edit('e1', 'a.txt'));
  chatCore.hook(c.s.id, 'UserPromptSubmit');
  await openChat(page, c.s.id);
  const card = row(page, c.s.id);
  const seen = new Set<number>();
  const at = async () => {
    if (await card.count()) seen.add(Math.round((await card.getByRole('button', { name: 'View in Diff' }).boundingBox())!.y));
  };
  await expect(chat(page, c.s.id).locator('button.sum')).toBeVisible();
  await at();
  for (const line of ['First line of the reply.', 'A second, longer line of the reply that takes some room.', 'And a third.']) {
    c.write(c.at(rec.assistant(line)));
    await expect(chat(page, c.s.id).getByText(line)).toBeVisible();
    await at();
  }
  c.write(c.end());
  chatCore.hook(c.s.id, 'Stop');
  await expect(card).toHaveCount(1);
  await at();
  await page.waitForTimeout(300); // anything still settling after the turn ended
  await at();
  expect([...seen]).toHaveLength(1);
});
