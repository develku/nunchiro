// Ticket 473: a session with no transcript yet shows no transcript view control ("Normal", "Thinking"): there is nothing
// to view another way. The control comes once the first message is in.
import path from 'node:path';
import { append, chat, expect, openChat, rec, test } from './fixtures/chat/harness';
import { REPO } from './fixtures';

test('view_control_needs_a_transcript: no Thinking or Normal control on an empty session; it shows with the first message', async ({ page, chatCore }) => {
  const s = chatCore.chat('quiet473');
  await openChat(page, s.id);
  const view = chat(page, s.id);
  await expect(view).toBeVisible();
  await page.waitForTimeout(500); // the empty transcript's first read
  await page.screenshot({ path: path.join(REPO, `.scratch/shots/473-empty-chat-${process.env.SHOT_TAG ?? 'after'}-${test.info().project.name}.png`) });
  const control = view.getByRole('button', { name: /^Transcript view/ });
  await expect(control).toHaveCount(0);
  append(s.file, rec.user('hello'), rec.assistant('Hi.'));
  await expect(view.locator('.md')).toContainText('Hi.');
  await expect(control).toBeVisible();
});
