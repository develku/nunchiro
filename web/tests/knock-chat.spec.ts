// The knock, in the chat: a message another sender's row put into the agent (the session's send log names it) shows who
// it is from, with its face, above its words. The owner's own message stays a plain bubble.
import { append, chat, expect, openChat, rec, test } from './fixtures/chat/harness';

test('chat_names_the_sender: a delivered message of another sender shows Message from <name>', async ({ page, chatCore }) => {
  const s = chatCore.chat('from');
  append(s.file, rec.user('write the parser'), rec.assistant('done'), rec.user('Run the full test suite'), rec.assistant('running'));
  await page.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => server.send(m));
    server.onMessage((raw) => {
      if (typeof raw !== 'string' || JSON.parse(raw).event !== 'snapshot') return ws.send(raw);
      const msg = JSON.parse(raw);
      for (const x of msg.sessions ?? []) if (x.id === s.id) x.send_log = [{ id: 'd1', sender: 'core', at: 1, content: 'Run the full test suite', status: 'delivered', keys: [], submit: true, completion_seq: 0, last_activity: 0 }];
      ws.send(JSON.stringify(msg));
    });
  });
  await openChat(page, s.id);
  const from = chat(page, s.id).locator('.msg.user.from');
  await expect(from).toHaveCount(1);
  await expect(from.locator('small')).toHaveText('Message from Nunchiro');
  await expect(from.locator('.ut')).toHaveText('Run the full test suite');
  await expect(chat(page, s.id).locator('.msg.user:not(.from) .ut')).toHaveText('write the parser');
});
