// CHROME chat body: user box right, agent column <= 760 px, tool rows collapsed (expand on click/Enter), code block with Copy,
// changes card opening Diff.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { append, chat, expect, openChat, rec, test } from './fixtures/chat/harness';

test('chat_rows_as_drawn', async ({ page, chatCore }) => {
  const s = chatCore.chat('rows');
  append(
    s.file,
    rec.user('fix the row height'),
    rec.use('t1', 'Bash', { command: 'cargo test' }),
    rec.result('t1', '48 passed'),
    rec.assistant('Done.\n\n```rust\nfn main() {}\n```'),
  );
  await openChat(page, s.id);
  const view = chat(page, s.id);
  const user = view.locator('.msg.user').first();
  await expect(user).toBeVisible();
  const col = (await view.locator('.cin').first().boundingBox())!;
  const u = (await user.boundingBox())!;
  expect(u.x + u.width).toBeGreaterThan(col.x + col.width - 40); // right-aligned
  expect(u.x).toBeGreaterThan(col.x + 40);
  const md = (await view.locator('.md').first().boundingBox())!;
  expect(md.width).toBeLessThanOrEqual(760);
  const tool = view.locator('.tool .tl').first();
  await expect(tool).toHaveAttribute('aria-expanded', 'false');
  await expect(tool.locator('.tdone')).toBeVisible();
  await tool.click();
  await expect(tool).toHaveAttribute('aria-expanded', 'true');
  await tool.press('Enter');
  await expect(tool).toHaveAttribute('aria-expanded', 'false');
  const code = view.locator('.codeblk');
  await expect(code.locator('.ch2')).toContainText('rust');
  await expect(code.getByRole('button', { name: 'Copy' })).toBeVisible();
});

test('changes_card_opens_diff', async ({ page, chatCore }) => {
  const dir = chatCore.project('chg');
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a]);
  git('init', '-q');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init'); // before the session starts: Diff compares with that start commit
  const s0 = chatCore.cli('session', 'start', '--kind', 'claude', '--project', dir, '--label', 'chg').session as { id: string; cwd: string; agent_session_id: string };
  const s = { ...s0, file: chatCore.transcriptPath(s0) };
  fs.mkdirSync(path.dirname(s.file), { recursive: true });
  fs.writeFileSync(s.file, '');
  fs.writeFileSync(path.join(s.cwd, 'a.txt'), 'b\nc\n');
  append(s.file, rec.user('edit it'), rec.edit('e1', path.join(s.cwd, 'a.txt'), ['-a', '+b', '+c']), rec.assistant('Edited.'));
  await openChat(page, s.id);
  const card = chat(page, s.id).locator('.dcard');
  await expect(card).toContainText('+2 −1');
  await card.getByRole('button', { name: 'View' }).click();
  await expect(page.getByRole('region', { name: 'Diff of a.txt' })).toBeVisible({ timeout: 10_000 });
});

// Detailed-row coverage explicitly selects Verbose; the window now starts in Normal.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('nunchiro.chatView.v2', 'verbose'));
});
