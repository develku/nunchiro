// Ticket 1003: an open loop's card (the core's `OwnerAsk::Loop`, queue/mod.rs) is counted and listed where every "Needs
// you" card is: the Home lead's chip, one row of the Home view and Decisions. An overdue loop is one row (the core keeps
// one card per loop: crates/nunchiro-core/tests/outbox.rs); its card closes it or keeps it open. A loop the Home lead
// asks to keep is a card too, and nothing is kept before the yes. The cards here are the proxy's, in the core's shape
// (stall-card-1004.spec.ts makes its card the same way).
import { expect, openWindow, test } from './fixtures';
import { mates, openSeat, openTeam } from './leader-990';

test('open_loops (ticket 1003): an overdue loop is one "Needs you" row and one card; the card closes it or keeps it open', async ({ app, core }) => {
  const alpha = core.project('alpha');
  core.shell(alpha, 'a1');
  mates(core, [{ id: 'mate-chief', name: 'Chief', lead: true }]);
  const card = (id: string, change: string, row: Record<string, unknown>, more: Record<string, unknown> = {}) => ({ id, session_id: '', scope: 'owner', kind: 'owner', text: `overdue: ${row.what}`, choices: [], observed_at: Date.now() - 60_000, actionable: true, owner: { type: 'loop', change, row: { source: 'Outbox card c1', at: 1, ...row }, ...more } });
  const gone = new Set<string>();
  const answers: { item: string; type: string }[] = [];
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    let last: Record<string, unknown> | null = null;
    const cards = () =>
      [
        card('loop-late', 'overdue', { id: 'L2', kind: 'waiting', who: 'Mina Park', what: 'the signed contract', due: '2026-11-20', asked: true }),
        card('loop-add', 'add', { id: '', kind: 'promise', who: 'Alex Kim', what: 'the Q4 roadmap', due: '2026-11-27', source: "the user's words, heard by the Home lead" }, { from: 'Chief' }),
      ].filter((c) => !gone.has(c.id));
    const push = () => last && ws.send(JSON.stringify({ ...last, owner_decisions: [...((last.owner_decisions as unknown[]) ?? []), ...cards()] }));
    server.onMessage((m) => {
      if (typeof m !== 'string' || JSON.parse(m).event !== 'snapshot') return ws.send(m);
      last = JSON.parse(m);
      push();
    });
    ws.onMessage((m) => {
      const msg = typeof m === 'string' ? JSON.parse(m) : null;
      if (msg?.request?.op !== 'answer' || !String(msg.request.item).startsWith('loop-')) return server.send(m);
      answers.push({ item: msg.request.item, type: msg.request.answer.type });
      gone.add(msg.request.item);
      ws.send(JSON.stringify({ id: msg.id, response: { Ok: 'Ack' } }));
      push();
    });
  });
  await openWindow(app, {}, core);
  await openSeat(app, core, 'Chief');
  await expect(app.locator('.shead [data-team-chip]')).toContainText('1 project · 2 needs you');
  const view = await openTeam(app);
  const needs = view.locator('[data-part="projects"] .lead-grp[data-group="needs"]');
  await expect(needs.locator('.lead-gh')).toHaveText('Needs you · 2');
  // One row per card: the overdue loop in the window's words, under the Home lead's name, with its Answer.
  const late = needs.locator('.lead-row[data-ask="loop-late"]');
  await expect(late).toHaveCount(1);
  await expect(late.locator('.home-pname')).toHaveText('Chief');
  await expect(late.locator('.lead-who')).toHaveText('Overdue · Waiting for Mina Park: the signed contract');
  await expect(needs.locator('.lead-row[data-ask="loop-add"] .lead-who')).toHaveText('Keep track? · You promised Alex Kim: the Q4 roadmap');
  // Answer opens its card in Decisions: what, when it was due, where it came from; it closes the loop or keeps it open.
  await late.locator('.lead-answer').click();
  const box = app.locator('.dw [data-loop="loop-late"]');
  await expect(box).toBeFocused();
  await expect(box).toHaveAccessibleName('Overdue · Waiting for Mina Park: the signed contract');
  await expect(box.locator('.rc-words p')).toHaveText(['Waiting for Mina Park: the signed contract', 'Due 2026-11-20 · from Outbox card c1']);
  await expect(box.locator('button')).toHaveText(['Done, close it', 'Still open']);
  await expect(box.locator('.mc-btns .mc-quiet')).toHaveText('Still open keeps it counted as overdue and does not ask again');
  const add = app.locator('.dw [data-loop="loop-add"]');
  await expect(add.locator('.rc-words p')).toHaveText(['Chief heard: You promised Alex Kim: the Q4 roadmap', "Due 2026-11-27 · from the user's words, heard by the Home lead"]);
  await expect(add.locator('button')).toHaveText(['Keep track', 'Not now']);
  await expect(app.locator('.dw .dw-count')).toHaveText('2 waiting');
  // Each button is one answer for its own card.
  await add.locator('[data-act="yes"]').click();
  await expect(add).toHaveCount(0);
  await box.locator('[data-act="no"]').click();
  await expect(box).toHaveCount(0);
  expect(answers).toEqual([
    { item: 'loop-add', type: 'allow_once' },
    { item: 'loop-late', type: 'deny' },
  ]);
  await expect(needs).toHaveCount(0);
});
