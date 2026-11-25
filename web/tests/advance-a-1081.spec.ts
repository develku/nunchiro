// Ticket 1081 part A: the core's auto-advance as the Team view shows it. A seat the core saw stalled reads "stalled" with
// the reason in its title, a running seat's row says its last activity ("N min ago"), the head says what waits on the
// lead, and the way menu's Auto-advance item sets Place.auto.
import { expect, openWindow, test } from './fixtures';
import { mates, openSeat, openTeam, repo, tokenClaude } from './leader-990';

const min = (n: number) => Date.now() - n * 60_000;

test('advance_a_1081: a stalled seat, its last activity and what waits show in the Team view; Auto-advance toggles Place.auto', async ({ app, core }) => {
  tokenClaude(core);
  const project = repo(core, 'demo-shop');
  mates(core, [{ id: 'lead-main', name: 'Lead', project, lead: true }]);
  const [b1, b2, b3] = ['tax', 'fee', 'docs'].map((k) => core.shell(project, k).id);
  const asked: { operation?: string; text?: string }[] = [];
  const place = { way: 'team', seats: 'ask', auto: true };
  const seat = (session: string, name: string) => ({ session, name, role: 'builder', writes: true, at: min(40) });
  const tasks = (p: string) => [
    { id: 't1', place: p, title: 'tax', created: min(60), updated: min(30), seats: [seat(b1, 'tax')], live: [b1], seen: { [b1]: min(3) }, state: 'idle', waits: 'review', advance: { stalled: [{ session: b1, name: 'Builder · tax', why: 'quiet for 25 min', n: min(28), at: min(3) }] } },
    { id: 't2', place: p, title: 'fee', created: min(60), updated: min(20), seats: [seat(b2, 'fee')], live: [b2], seen: { [b2]: Date.now() - 10_000 }, state: 'idle', waits: 'review' },
    { id: 't3', place: p, title: 'docs', created: min(60), updated: min(10), seats: [seat(b3, 'docs')], review: { revision: 'c', pass: true, by: 'user', name: 'review-docs', at: min(10) }, state: 'approved', waits: 'merge' },
  ];
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => {
      const msg = typeof m === 'string' ? JSON.parse(m) : null;
      const r = msg?.request;
      if (r?.op !== 'task') return server.send(m);
      asked.push(r);
      if (r.operation === 'auto') place.auto = r.text === 'on';
      ws.send(JSON.stringify({ id: msg.id, response: { Ok: { tasks: r.operation === 'list' ? tasks(r.project) : [], place: { ...place } } } }));
    });
    server.onMessage((m) => ws.send(m));
  });
  await openWindow(app, {}, core);
  await openSeat(app, core, 'Lead');
  const team = await openTeam(app);
  const t1 = team.locator('.lead-row[data-task="t1"]');
  await expect(t1.locator('[data-stalled]')).toHaveText('stalled');
  await expect(t1.locator('[data-stalled]')).toHaveAttribute('title', 'Builder · tax: quiet for 25 min');
  await expect(t1.locator('.lead-tm[data-seen]')).toHaveText('3 min ago');
  await expect(team.locator('.lead-row[data-task="t2"] .lead-tm[data-seen]')).toHaveText('now');
  await expect(team.locator('.lead-row[data-task="t2"] [data-stalled]')).toHaveCount(0);
  await expect(app.locator('.teamv-head [data-waits]')).toHaveText('2 reports waiting · 1 approved to merge · 1 stalled');
  // Auto-advance: on by default; off sets Place.auto, and the Settings section (ticket 1099: the gear opens it) reads it back.
  await app.locator('.teamv-head [data-place-gear]').click();
  const auto = app.locator('.settings .place-sec').getByRole('switch', { name: 'Auto-advance' });
  await expect(auto).toBeChecked();
  await auto.click();
  await expect.poll(() => asked.find((r) => r.operation === 'auto')?.text).toBe('off');
  await expect(auto).not.toBeChecked();
});
