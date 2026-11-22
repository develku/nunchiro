// V2.5-82 (review SHOULD 5 of v25-quiet-chat, V2.5-49 rule): the chat no longer shows a pending question, so the Decisions
// widget is the surface that shows its text. The rule is `plain()` (chat/pending.ts): hidden characters are REMOVED, never
// drawn raw. The window's snapshot is patched (as quiet-chat.spec.ts does) so the question carries the characters whatever
// the core's own screen reader keeps.
import type { Page } from '@playwright/test';
import { append, chat, expect, openChat, rec, test } from './fixtures/chat/harness';

// U+202E right-to-left override, U+200B zero-width space, U+2028 line separator, U+E0041 tag letter A.
const HIDDEN = /[\u202e\u200b\u2028\u{e0041}]/u;
const ASK = 'Run rm\u202e -rf\u200b /tmp/x\u2028 now?\u{e0041}';

async function pendQuestion(page: Page, sessionId: string, text: string) {
  await page.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((msg) => server.send(msg));
    server.onMessage((raw) => {
      if (typeof raw !== 'string' || JSON.parse(raw).event !== 'snapshot') return ws.send(raw);
      const msg = JSON.parse(raw);
      for (const s of msg.sessions ?? [])
        if (s.id === sessionId) {
          s.pending = [{ id: `d-${s.id}`, session_id: s.id, scope: s.project, kind: 'question', text, choices: [], observed_at: Date.now() - 5_000, actionable: true, risky: false }];
          Object.assign(s.attention, { working: true, waiting: true, stale: false, failed: false });
        }
      ws.send(JSON.stringify(msg));
    });
  });
}

test('decisions_widget_hides_hidden_characters: a pending question with U+202E, U+200B, U+2028 and a tag character shows them removed, never raw', async ({ page, chatCore }) => {
  const s = chatCore.chat('hidden');
  append(s.file, rec.user('go'), rec.assistant('Let me ask.'));
  await pendQuestion(page, s.id, `${ASK}\nsecond`);
  await openChat(page, s.id);
  await expect(chat(page, s.id).locator('.dline')).toHaveCount(0); // the chat shows no question (v25-quiet-chat)
  await page.getByRole('navigation', { name: 'Right bar' }).getByRole('button', { name: 'Decisions' }).click();
  const widget = page.locator('.wg[data-widget="decisions"], .sbar[data-widget="decisions"]').first();
  const card = widget.locator('.dc-item').first();
  await expect(card).toBeVisible();
  // The words are there, the characters are not, in text and in every attribute that can carry it.
  await expect(card).toContainText('Run rm -rf /tmp/x now?');
  expect(await card.textContent()).not.toMatch(HIDDEN);
  const attrs = await card.evaluate((el) => [el, ...el.querySelectorAll('*')].flatMap((e) => [...e.attributes].filter((a) => a.name !== 'data-item').map((a) => a.value)));
  for (const v of attrs) expect(v).not.toMatch(HIDDEN);
});
