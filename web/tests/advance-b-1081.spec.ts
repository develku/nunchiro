// Ticket 1081 part B: the core staffs the Reviewer. A task whose review waits for a free seat says so in one quiet word in
// its row, a task whose Reviewer the core started says "auto review", the head counts the waiting reviews, and the way
// menu's "Seats at once" item sets Place.cap.
import { expect, openWindow, test } from './fixtures';
import { mates, openSeat, openTeam, repo, tokenClaude } from './leader-990';

const min = (n: number) => Date.now() - n * 60_000;

test('advance_b_1081: a review waiting for a seat shows in its row and the head; Seats at once sets Place.cap', async ({ app, core }) => {
  tokenClaude(core);
  const project = repo(core, 'demo-shop');
  mates(core, [{ id: 'lead-main', name: 'Lead', project, lead: true }]);
  const [b1, b2] = ['tax', 'fee'].map((k) => core.shell(project, k).id);
  const asked: { operation?: string; text?: string }[] = [];
  const place: { way: string; seats: string; cap?: number } = { way: 'team', seats: 'ask' };
  const seat = (session: string, name: string) => ({ session, name, role: 'builder', writes: true, at: min(40) });
  const tasks = (p: string) => [
    { id: 't1', place: p, title: 'tax', created: min(60), updated: min(30), seats: [seat(b1, 'tax')], state: 'idle', waits: 'review', advance: { review: 'waits' } },
    { id: 't2', place: p, title: 'fee', created: min(60), updated: min(20), seats: [seat(b2, 'fee')], state: 'idle', advance: { review: 'started' } },
  ];
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => {
      const msg = typeof m === 'string' ? JSON.parse(m) : null;
      const r = msg?.request;
      if (r?.op !== 'task') return server.send(m);
      asked.push(r);
      if (r.operation === 'cap') place.cap = Number(r.text);
      ws.send(JSON.stringify({ id: msg.id, response: { Ok: { tasks: r.operation === 'list' ? tasks(r.project) : [], place: { ...place } } } }));
    });
    server.onMessage((m) => ws.send(m));
  });
  await openWindow(app, {}, core);
  await openSeat(app, core, 'Lead');
  const team = await openTeam(app);
  await expect(team.locator('.lead-row[data-task="t1"] [data-auto-review="waits"]')).toHaveText('review waits');
  await expect(team.locator('.lead-row[data-task="t2"] [data-auto-review="started"]')).toHaveText('auto review');
  await expect(app.locator('.teamv-head [data-waits]')).toHaveText('1 report waiting · 1 review waits for a free seat');
  // Live seats: 4 by default; 6 sets Place.cap, and the Settings section (ticket 1099: the gear opens it) reads it back.
  await app.locator('.teamv-head [data-place-gear]').click();
  const cap = app.locator('.settings .place-sec').getByRole('radiogroup', { name: 'Live seats' });
  await expect(cap.getByRole('radio', { name: '4' })).toBeChecked();
  await cap.getByRole('radio', { name: '6' }).click();
  await expect.poll(() => asked.find((r) => r.operation === 'cap')?.text).toBe('6');
  await expect(cap.getByRole('radio', { name: '6' })).toBeChecked();
});
