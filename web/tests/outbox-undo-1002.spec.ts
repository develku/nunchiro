// Look v20 S1 (ticket 1002): the Outbox card's Undo is a second answer for the same card. The window's once-per-item
// guard held the Send and dropped the Undo, so the core approved at 10 s and the mail went. The card here is the
// proxy's, in the core's shape (stall-card-1004.spec.ts makes its card the same way), and the proxy plays the core's
// part: every answer for the card is recorded and acknowledged, and a yes shows as `yes_at` until it is undone. The core's
// own side (an Undo honoured until the approval, a late one told so) is crates/nunchiro-core/tests/outbox.rs.
import { expect, openWindow, test } from './fixtures';

test('outbox_undo (look v20 S1): Undo after Send reaches the core at 2 s and at 6 s; the card asks again and still takes Discard', async ({ app }) => {
  const id = 'obx-look-v20';
  let yesAt: number | null = null;
  const answers: { type: string }[] = [];
  const card = () => ({
    id,
    session_id: 'chief-seat',
    scope: 'owner',
    kind: 'owner',
    text: 'Mail to mina@example.com',
    choices: [],
    observed_at: Date.now() - 60_000,
    actionable: true,
    owner: { type: 'outward', tool: 'mcp__gmail__send_message', args: { to: ['mina@example.com'], subject: 'Draft', body: 'Hi Mina' }, from: 'Chief', hash: 'h', ...(yesAt ? { yes_at: yesAt } : {}) },
  });
  let gone = false;
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
      const a = msg.request.answer as { type: string };
      answers.push(a);
      if (a.type === 'allow_once') yesAt = Date.now();
      else if (yesAt) yesAt = null; // Undo: the card asks again
      else gone = true; // Discard
      ws.send(JSON.stringify({ id: msg.id, response: { Ok: 'Ack' } }));
      push();
    });
  });
  await openWindow(app);
  await app.getByRole('navigation', { name: 'Right bar' }).getByRole('button', { name: 'Decisions' }).click();
  const box = app.locator(`.dw [data-item="${id}"]`);
  const send = box.locator('[data-act="send-outbox"]');
  const undo = box.locator('[data-act="undo-outbox"]');
  for (const wait of [2_000, 6_000]) {
    await send.click();
    await expect(box.locator('.obx-sending')).toContainText('Sending in');
    await app.waitForTimeout(wait);
    await undo.click();
    // The card asks again: the core got the Undo and nothing was approved.
    await expect(send).toBeVisible();
    await expect(undo).toHaveCount(0);
  }
  expect(answers.map((a) => a.type)).toEqual(['allow_once', 'deny', 'allow_once', 'deny']);
  // Still answerable after two rounds: Discard reaches the core too.
  await box.locator('[data-act="discard"]').click();
  await expect(box).toHaveCount(0);
  expect(answers.map((a) => a.type)).toEqual(['allow_once', 'deny', 'allow_once', 'deny', 'deny']);
});
