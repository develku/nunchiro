// A bot-task trial: the Assistant's only way to send was a local script, so its reply never became a card. A command
// card (outbox.rs `COMMAND`) shows the exact line Send runs and the whole text of each file it names, has no Open by
// hand, and Discard reaches the core. The card is the proxy's, in the core's shape (outbox-undo-1002.spec.ts).
import { expect, openWindow, test } from './fixtures';

test('outbox command card: the line and its file are shown, Run and Discard only', async ({ app }) => {
  const id = 'obx-command';
  const answers: { type: string }[] = [];
  const line = '/work/bin/send-mail /work/drafts/reply.eml';
  const text = 'To: Jordan Lee <jordan@partner.example.com>\nSubject: Re: Can we find an hour?\n\nTuesday 14:00?';
  const script = '#!/bin/sh\ncat "$@" > /dev/null';
  let gone = false;
  const card = () => ({
    id,
    session_id: 'chief-seat',
    scope: 'owner',
    kind: 'owner',
    text: 'Run a command',
    choices: [],
    observed_at: Date.now() - 60_000,
    actionable: true,
    owner: {
      type: 'outward',
      tool: 'Bash',
      args: { command: line, files: [{ path: '/work/bin/send-mail', sha256: 'a', text: script }, { path: '/work/drafts/reply.eml', sha256: 'b', text }, { path: '/work/drafts/reply.eml', sha256: 'b', text }] },
      from: 'Chief',
      hash: 'h',
    },
  });
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    let last: Record<string, unknown> | null = null;
    const push = () => last && ws.send(JSON.stringify({ ...last, owner_decisions: [...((last.owner_decisions as unknown[]) ?? []), ...(gone ? [] : [card()])] }));
    server.onMessage((m) => {
      if (typeof m !== 'string' || JSON.parse(m).event !== 'snapshot') return ws.send(m);
      last = JSON.parse(m);
      push();
    });
    ws.onMessage((m) => {
      const msg = typeof m === 'string' ? JSON.parse(m) : null;
      if (msg?.request?.op !== 'answer' || msg.request.item !== id) return server.send(m);
      answers.push(msg.request.answer);
      gone = true;
      ws.send(JSON.stringify({ id: msg.id, response: { Ok: 'Ack' } }));
      push();
    });
  });
  await openWindow(app);
  await app.getByRole('navigation', { name: 'Right bar' }).getByRole('button', { name: 'Decisions' }).click();
  const box = app.locator(`.dw [data-item="${id}"]`);
  await expect(box).toContainText('Run a command');
  await expect(box.locator('code')).toHaveText(line);
  await expect(box).toContainText('File it uses: /work/drafts/reply.eml');
  // The program's text is shown too, and a file named twice is shown twice (keys by place, not by path).
  await expect(box).toContainText('File it uses: /work/bin/send-mail');
  await expect(box.locator('.obx-body')).toHaveText([script, text, text]);
  await expect(box.locator('[data-act="send-outbox"]')).toHaveText('Run');
  await expect(box.locator('[data-act="open-outbox"]')).toHaveCount(0);
  await box.locator('[data-act="discard"]').click();
  await expect(box).toHaveCount(0);
  expect(answers.map((a) => a.type)).toEqual(['deny']);
});
