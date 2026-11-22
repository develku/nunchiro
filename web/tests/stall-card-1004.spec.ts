// Ticket 1004: a stalled task's card (the core's own owner card, queue/mod.rs `OwnerAsk::Stall`) is counted and listed
// where every "Needs you" card is: the Home lead's chip, its project's row in the Home view, and Decisions, where it
// names the task, the seat and the last error and takes Dismiss only. How the core raises and clears the card is tested
// in the core (sessions/wake.rs).
import { expect, openWindow, test } from './fixtures';
import { mates, openSeat, openTeam } from './leader-990';

test('stall_card (ticket 1004): a stalled task is one "needs you" on the chip, on its project row and in Decisions, with the seat and its last error', async ({ app, core }) => {
  const alpha = core.project('alpha');
  core.shell(alpha, 'a1');
  mates(core, [
    { id: 'mate-chief', name: 'Chief', lead: true },
    { id: 'lead-main', name: 'Main', project: alpha, lead: true },
  ]);
  // The card is the proxy's, in the core's shape, as home-view.spec.ts makes its merge card.
  const stall = (id: string, error?: string) => ({ id, session_id: '', scope: 'owner', kind: 'owner', text: 'task t1 (Add tax) is stuck', choices: [], observed_at: Date.now() - 60_000, actionable: true, owner: { type: 'stall', task: id, title: 'Add tax', place: alpha, seat: 'Builder · tax', ...(error ? { error } : {}) } });
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    server.onMessage((m) => {
      if (typeof m !== 'string' || JSON.parse(m).event !== 'snapshot') return ws.send(m);
      const msg = JSON.parse(m);
      msg.owner_decisions = [...(msg.owner_decisions ?? []), stall('t1', 'Claude is not signed in'), stall('t2')];
      ws.send(JSON.stringify(msg));
    });
  });
  await openWindow(app, {}, core);
  await openSeat(app, core, 'Chief');
  const chip = app.locator('.shead [data-team-chip]');
  await expect(chip).toContainText('1 project · 2 needs you');
  const view = await openTeam(app);
  const rows = view.locator(`[data-part="projects"] .lead-grp[data-group="needs"] .lead-row[data-project="${alpha}"]`);
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0).locator('.lead-who')).toContainText('Stuck: Add tax · Builder · tax stopped on: Claude is not signed in');
  await expect(rows.nth(1).locator('.lead-who')).toContainText('Stuck: Add tax · Builder · tax finished two turns in a row and nothing changed');
  // Answer opens the card in Decisions.
  await rows.nth(0).locator('.lead-answer').click();
  const card = app.locator('.dw [data-stall="t1"]');
  await expect(card).toBeFocused();
  await expect(card).toHaveAccessibleName('Stuck: Add tax');
  await expect(card.locator('.dwh b')).toHaveText('Builder · tax');
  await expect(card.locator('.dc-why')).toHaveText('Builder · tax stopped on: Claude is not signed in');
  await expect(card.locator('button')).toHaveText(['Dismiss']);
  await expect(app.locator('.dw [data-stall="t2"] .dc-why')).toHaveText('Builder · tax finished two turns in a row and nothing changed');
  await expect(app.locator('.dw .dw-count')).toHaveText('2 waiting');
});
