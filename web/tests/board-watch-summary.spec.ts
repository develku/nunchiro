// V2.5-69 round 2 (ticket 289 item 3, needs 208): the card detail shows the card's summary, the last thing its agent said,
// read from the session's own transcript through the core's `chat_page`. Real core and a fake Claude transcript.
import fs from 'node:fs';
import path from 'node:path';
import { append, rec, test, expect } from './fixtures/chat/harness';
import { seed } from './fixtures/board/coord';

test.beforeEach(async ({ page, chatCore }) => {
  // The shared harness opens specs in the columns view; this one is about the watch view's detail. (chatCore is asked for
  // here so its own init script is registered before this one.)
  void chatCore;
  await page.addInitScript(() => localStorage.removeItem('nunchiro.test.board-mode'));
});

test('card_detail_shows_summary: a session card, and a task card with no note, show the last thing the agent said; a note wins; no transcript says so', async ({ page, chatCore }) => {
  fs.copyFileSync(path.join(import.meta.dirname, 'fixtures/board/layout.toml'), path.join(chatCore.home, 'layout.toml'));
  const talker = chatCore.chat('talker');
  append(talker.file, rec.user('build the parser'), rec.assistant('Early plan, not the end.'), rec.user('finish it'), rec.assistant('Parser done: 412 tests pass.\nSecond line stays out of the one-line summary.'));
  const silent = chatCore.chat('silent', false); // no transcript yet
  // Look 1117 v5 (B-S2-1): a lead made these cards, so their session is the lead's, whose last words are about another task.
  const lead = chatCore.chat('lead');
  append(lead.file, rec.user('merge both'), rec.assistant('The greet merge is in main as a fast-forward.'));
  seed(chatCore, [
    { id: 't4', title: 'Slug lane', column: 'working', session_id: lead.id },
    { id: 't5', title: 'Marked lane', column: 'working', session_id: lead.id },
    { id: 't1', title: 'Parser lane', column: 'working', attachments: [{ session_id: talker.id, role: 'build' }] },
    { id: 't2', title: 'Noted lane', column: 'working', attachments: [{ session_id: talker.id, role: 'build' }] },
    { id: 't3', title: 'Quiet lane', column: 'working', attachments: [{ session_id: silent.id, role: 'build' }] },
  ]);
  const board = page.locator('.board');
  // A note on t2: the REPORT task line the coordinator wrote beats the transcript.
  const f = path.join(chatCore.home, 'board.json');
  const b = JSON.parse(fs.readFileSync(f, 'utf8'));
  b.manual.find((c: { id: string }) => c.id === 't2').note = 'REPORT: parser lane merged at abc1234';
  b.manual.find((c: { id: string }) => c.id === 't5').note = '**-> Result.** Task t5 **passes**';
  fs.writeFileSync(f, JSON.stringify(b));
  await page.goto('/');
  await expect(page.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  await expect(board).toBeVisible();
  await page.mouse.move(2, 2);
  const card = (title: string) => page.locator('.board .wcard').filter({ has: page.locator('.wtt', { hasText: new RegExp(`^${title}$`) }) });
  const done = page.getByRole('complementary', { name: 'Card detail' }).locator('.wdr').filter({ hasText: 'What was done' });
  // Look 1117 v5 (B-S2-1, w11-core): the card shows the core's words for it (its note, its task's outcome), never a
  // session's last message (that was Q7 point 20); with neither, its title alone. The detail still shows the agent's.
  await expect(card('Parser lane').locator('.wnote')).toHaveCount(0);
  await expect(card('Noted lane').locator('.wnote')).toHaveText('REPORT: parser lane merged at abc1234');
  await expect(card('Quiet lane').locator('.wnote')).toHaveCount(0);
  // Look 1117 v5: a task card never shows its (lead's) session's last message; a note reads as plain words.
  await expect(card('Marked lane').locator('.wnote')).toHaveText('-> Result. Task t5 passes');
  await expect(card('Slug lane').locator('.wnote')).toHaveCount(0);
  // A task card whose agent has a transcript: its last message, first line, not the earlier one.
  await card('Parser lane').click();
  await expect(done).toContainText('Parser done: 412 tests pass.', { timeout: 15_000 });
  await expect(done).not.toContainText('Early plan');
  await expect(done).not.toContainText('Second line');
  // The note is explicit: it wins over the transcript.
  await card('Noted lane').click();
  await expect(done).toContainText('REPORT: parser lane merged at abc1234');
  await expect(done).not.toContainText('Parser done');
  await card('Slug lane').click();
  await expect(done).toContainText('Nothing recorded yet');
  await expect(done).not.toContainText('greet merge');
  // No transcript: the plain sentence, never a stale summary from the previous card.
  await card('Quiet lane').click();
  await expect(done).toContainText('Nothing recorded yet');
  await expect(done).not.toContainText('Parser done');
});

test('card_detail_shows_a_long_note_whole: a 5,000-character note, marks taken off, is in the detail row whole (nothing cut)', async ({ page, chatCore }) => {
  fs.copyFileSync(path.join(import.meta.dirname, 'fixtures/board/layout.toml'), path.join(chatCore.home, 'layout.toml'));
  const quiet = chatCore.chat('quiet', false); // a session, as above: the window opens on the Board, not onboarding
  seed(chatCore, [{ id: 't1', title: 'Long lane', column: 'working', attachments: [{ session_id: quiet.id, role: 'build' }] }]);
  const words = Array.from({ length: 625 }, (_, i) => `w${String(i).padStart(4, '0')}`).join(' '); // 3,124 characters
  const note = `**Done:** ${words} ${'z'.repeat(5000 - words.length - 11)}`;
  expect(note.length).toBe(5000);
  const f = path.join(chatCore.home, 'board.json');
  const b = JSON.parse(fs.readFileSync(f, 'utf8'));
  b.manual.find((c: { id: string }) => c.id === 't1').note = note;
  fs.writeFileSync(f, JSON.stringify(b));
  await page.goto('/');
  await expect(page.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  await expect(page.locator('.board')).toBeVisible();
  await page.mouse.move(2, 2);
  const card = page.locator('.board .wcard').filter({ has: page.locator('.wtt', { hasText: /^Long lane$/ }) });
  await card.click();
  const done = page.getByRole('complementary', { name: 'Card detail' }).locator('.wdr').filter({ hasText: 'What was done' });
  await expect(done).toContainText(`Done: ${words} ${'z'.repeat(5000 - words.length - 11)}`);
});
