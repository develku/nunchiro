// Ticket 1005: a teammate's memory file past the 6 KB its brief quotes is the core's own owner card (queue/mod.rs
// `OwnerAsk::Tidy`), counted and shown in Decisions with Tidy it and Not now. How the core raises it
// once per file and what its yes does is tested in the core (team.rs).
import { expect, openWindow, test } from './fixtures';
import { mates } from './leader-990';

test('tidy_card (ticket 1005): an oversize memory is one card in Decisions with Tidy it and Not now', async ({ app, core }) => {
  mates(core, [
    { id: 'mate-chief', name: 'Chief', lead: true },
    { id: 'mate-scout', name: 'Scout' },
  ]);
  const home = core.home + '/team/home';
  const tidy = { id: 'tidy-1', session_id: 'mate-scout', scope: 'owner', kind: 'owner', text: "Scout's MEMORY.md is over the 6 KB its brief quotes, so the rest does not reach Scout: let Scout tidy it?", choices: [], observed_at: Date.now() - 60_000, actionable: true, owner: { type: 'tidy', teammate: 'mate-scout', name: 'Scout', file: 'MEMORY.md', place: home } };
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    server.onMessage((m) => {
      if (typeof m !== 'string' || JSON.parse(m).event !== 'snapshot') return ws.send(m);
      const msg = JSON.parse(m);
      msg.owner_decisions = [...(msg.owner_decisions ?? []), tidy];
      ws.send(JSON.stringify(msg));
    });
  });
  await openWindow(app, {}, core);
  await app.getByRole('navigation', { name: 'Right bar' }).getByRole('button', { name: 'Decisions' }).click();
  await expect(app.locator('.dw .dw-count')).toHaveText('1 waiting');
  const card = app.locator('.dw [data-tidy="mate-scout"]');
  await expect(card).toHaveAccessibleName("Scout's MEMORY.md is too long");
  await expect(card.locator('.dc-why')).toHaveText('It is over the 6 KB a brief quotes, so the rest does not reach Scout. Let Scout tidy it?');
  await expect(card.locator('button')).toHaveText(['Tidy it', 'Not now']);
});
