// Ticket 1089: the Team room says beside each line's written time when it reached its seat ("delivered 14:07") or that it
// still waits there, and changes by itself when it arrives; a line not written today shows its day, in the wide and the
// narrow room. The page test answers the window's room_read with a fixed room (the core's side has its own test:
// sessions::room::tests::a_room_line_says_when_it_reached_its_seat).
import path from 'node:path';
import type { WebSocketRoute } from '@playwright/test';
import { expect, openWindow, REPO, test } from './fixtures';
import { mates, openSeat, openTeam } from './leader-990';
import { reachedText, stamp } from '../src/room/room';
import { makeT } from './i18n-tables';

const SHOTS = path.join(REPO, '.scratch', 'shots');

test('1089: a line to no seat says nothing more; a waiting line says waiting; a delivered one its time, with its day when that is not the day it was written', () => {
  (globalThis as { document?: unknown }).document = { documentElement: { lang: 'en' } }; // the time helpers read the window's language
  const t = makeT('en', 'en');
  const now = new Date(2026, 10, 23, 15, 0).getTime();
  const at = (d: number, h: number, m: number) => new Date(2026, 10, d, h, m).getTime();
  expect(reachedText(t, undefined, at(23, 14, 0), now)).toBeNull();
  expect(reachedText(t, null, at(23, 14, 0), now)).toEqual({ text: 'waiting', waiting: true });
  expect(reachedText(t, at(23, 14, 7), at(23, 14, 0), now)?.text).toBe(`delivered ${stamp(t, at(23, 14, 7), now)}`);
  // Written yesterday and delivered yesterday: the written time already says the day.
  expect(reachedText(t, at(22, 9, 40), at(22, 9, 12), now)?.text).toBe(`delivered ${stamp(t, at(23, 9, 40), now)}`);
  // Written yesterday, delivered today after hours in the queue: the delivered time alone, which is today's.
  expect(reachedText(t, at(23, 8, 5), at(22, 23, 50), now)?.text).toBe(`delivered ${stamp(t, at(23, 8, 5), now)}`);
  // Written two days ago, delivered yesterday: the day is said.
  expect(reachedText(t, at(22, 8, 5), at(21, 23, 50), now)?.text).toBe(`delivered Yesterday ${stamp(t, at(23, 8, 5), now)}`);
});

test('1089: the lead\'s line to a worker shows waiting, then delivered by itself; yesterday\'s line shows its day (narrow and wide room)', async ({ app, core }) => {
  const project = core.project('demo');
  core.shell(project, 'alpha');
  mates(core, [{ id: 'lead-main', name: 'Main', project, lead: true }]);
  const now = Date.now();
  const day = new Date(now);
  const yesterday = (h: number, m: number) => new Date(day.getFullYear(), day.getMonth(), day.getDate() - 1, h, m).getTime();
  let lead = '';
  let arrived: number | null = null; // the second line reaches w1 when the test says so
  const page = () => {
    const line = (n: number, to: string, body: string, ts: number) => ({ id: `m${n}`, kind: 'typed', from: lead, to, thread: `m${n}`, body, created_by: 'agent', ts });
    const messages = lead
      ? [
          line(1, 'seat-w1', 'fix the tests in web/', yesterday(9, 12)),
          line(2, 'seat-w1', 'then open the PR', now - 60_000),
          { id: 'm3', kind: 'message', from: lead, to: 'person', thread: 'm3', body: 'a note for you', created_by: 'agent', ts: now - 30_000 },
          line(4, 'seat-w2', 'review w1 when it is done', now - 20_000),
        ]
      : [];
    const delivery = lead ? { m1: yesterday(9, 40), m2: arrived, m4: null } : {};
    return { messages, reset: true, log: 1, pins: [], names: { 'seat-w1': 'w1', 'seat-w2': 'w2' }, delivery };
  };
  const windows: WebSocketRoute[] = [];
  await app.routeWebSocket(/\/ws$/, (ws) => {
    windows.push(ws);
    const server = ws.connectToServer();
    ws.onMessage((m) => {
      const f = typeof m === 'string' ? JSON.parse(m) : null;
      if (f?.request?.op === 'room_read') return void ws.send(JSON.stringify({ id: f.id, response: { Ok: page() } }));
      server.send(m);
    });
    server.onMessage((m) => ws.send(m));
  });
  await openWindow(app, {}, core);
  lead = await openSeat(app, core, 'Main');

  // The Team view at the side of the lead (the owner's "Team chat"): its room is narrow, a chat in time order.
  for (const ws of windows) ws.send('{"event":"room"}'); // the lead is known now: read the room again
  const side = await openTeam(app);
  await side.getByRole('tab', { name: /^Room/ }).click();
  const chat = side.locator('.room-chat');
  const narrow = (n: number) => chat.locator(`.room-line[data-msg="m${n}"]`);
  await expect(narrow(1).locator('time')).toHaveText(/^Yesterday \d/);
  await expect(narrow(1).locator('.room-reached')).toHaveText(/^delivered \d/); // delivered the day it was written
  await expect(narrow(2).locator('time')).toHaveText(/^\d/); // today: the time alone
  await expect(narrow(2).locator('.room-reached')).toHaveText('waiting');
  await expect(narrow(3).locator('.room-reached')).toBeHidden(); // a note to the person: only its written time
  await expect(narrow(4).locator('.room-reached')).toHaveText('waiting');
  // The delivered time is whole: the words before it give way (the head line cut it to "delivered" in the first draft).
  for (const n of [1, 2, 4]) {
    const [to, reached] = [narrow(n).locator('.room-line-to'), narrow(n).locator('.room-reached')];
    expect((await reached.boundingBox())!.x + (await reached.boundingBox())!.width).toBeLessThanOrEqual((await to.boundingBox())!.x + (await to.boundingBox())!.width + 0.5);
    expect(await reached.evaluate((e) => e.scrollWidth <= e.clientWidth + 1)).toBe(true);
    expect(await narrow(n).locator('.room-line-addr').evaluate((e) => e.scrollWidth <= e.clientWidth + 1)).toBe(true); // "→ w1" whole too
  }
  const height = (await narrow(2).boundingBox())!.height;
  await app.screenshot({ path: path.join(SHOTS, '1089-narrow-waiting.png') });

  // The worker gets the line: the core pushes a room frame and the line changes by itself.
  arrived = Date.now();
  for (const ws of windows) ws.send('{"event":"room"}');
  await expect(narrow(2).locator('.room-reached')).toHaveText(/^delivered \d/);
  await expect(narrow(2).locator('.room-reached')).toHaveAttribute('data-reached', 'delivered');
  expect((await narrow(2).boundingBox())!.height).toBe(height); // the row does not grow
  await app.screenshot({ path: path.join(SHOTS, '1089-narrow-delivered.png') });

  // The wide room (the Team view as a tab): the same words beside the written time.
  await side.getByRole('button', { name: 'Open as a tab' }).click();
  const wide = (n: number) => app.locator(`.pane .teamv-room .room .room-log [data-msg="m${n}"]`);
  await expect(wide(1).locator('time')).toHaveText(/^Yesterday \d/);
  await expect(wide(1).locator('.room-reached')).toHaveText(/^delivered \d/);
  await expect(wide(2).locator('.room-reached')).toHaveText(/^delivered \d/);
  await expect(wide(4).locator('.room-reached')).toHaveText('waiting');
  await app.screenshot({ path: path.join(SHOTS, '1089-wide.png') });
});
