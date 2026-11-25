// Ticket 1072: worker wake lines are one quiet row in the lead's chat, and Team room rows show their time. The model and time cases are pure functions; the last one drives a page on a fixture core.
import fs from 'node:fs';
import path from 'node:path';
import { expect, openWindow, REPO, test } from './fixtures';
import { mates, openSeat } from './leader-990';
import type { ChatEvent } from '../src/chat/feed';
import { buildRows, viewRows } from '../src/chat/model';
import { stamp } from '../src/room/room';
import { makeT } from './i18n-tables';

let cursor = 0;
const say = (text: string, role: 'user' | 'assistant' = 'user'): ChatEvent => ({ schema_version: 1, cursor: ++cursor, data: { kind: 'message', role, text } });
const W = (n: number) => `worker w${n} ended a turn (no report yet)`;
const shape = (events: ChatEvent[]) => buildRows(events).map((r) => (r.kind === 'wakes' ? `wakes:${r.n}` : r.kind === 'user' ? `user:${r.text}` : r.kind));

test('1072: a run of wake lines is one row, a joined message counts its lines, any other row breaks the run', () => {
  expect(shape([say(W(1)), say(W(2)), say('worker w3 done; report says: "STATUS: done"')])).toEqual(['wakes:3']);
  expect(shape([say(`${W(1)}\n${W(2)}`)])).toEqual(['wakes:2']);
  expect(shape([say(W(1)), say('ok', 'assistant'), say(W(2))])).toEqual(['wakes:1', 'assistant', 'wakes:1']);
});

test('1072: a wake starts the lead\'s next turn, so its tools are not folded into the turn before', () => {
  const tool = (id: string): ChatEvent => ({ schema_version: 1, cursor: ++cursor, data: { kind: 'tool_use', tool_id: id, name: 'Bash', input: { command: 'ls' } } });
  const rows = viewRows(buildRows([say('do X'), tool('a'), say('done X', 'assistant'), say(W(1)), tool('b'), say('w1 checked', 'assistant')]), 'normal');
  expect(rows.map((r) => r.kind)).toEqual(['user', 'summary', 'assistant', 'wakes', 'summary', 'assistant']);
});

test('1072: wake lines glued before the owner words draw the summary row and his bubble; a quote stays whole', () => {
  expect(shape([say(`${W(1)}\nworker w2 waits for your answer to its question in the room\nplease merge it`)])).toEqual(['wakes:2', 'user:please merge it']);
  const quote = `why did you say "${W(1)}"?`;
  expect(shape([say(quote)])).toEqual([`user:${quote}`]);
  const after = `hello\n${W(1)}`;
  expect(shape([say(after)])).toEqual([`user:${after}`]);
});

test('1072: a room row time is HH:MM today, Yesterday HH:MM the day before, then the date and time', () => {
  (globalThis as { document?: unknown }).document = { documentElement: { lang: 'en' } }; // the time helpers read the window's language
  const t = makeT('en', 'en');
  const now = new Date(2026, 10, 23, 15, 0).getTime();
  const at = (d: number, h: number, m: number) => new Date(2026, 10, d, h, m).getTime();
  const clock = (ms: number) => new Date(ms).toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' });
  expect(stamp(t, at(23, 9, 5), now)).toBe(clock(at(23, 9, 5)));
  expect(stamp(t, at(22, 23, 40), now)).toBe(`Yesterday ${clock(at(22, 23, 40))}`);
  expect(stamp(t, at(21, 8, 0), now)).toBe(`Nov 21 ${clock(at(21, 8, 0))}`);
});

test('1072: the wake row in a lead\'s chat says "2 worker updates" and its View in Team button opens the Team view', async ({ app, core }) => {
  fs.writeFileSync(path.join(core.home, 'bin', 'claude'), fs.readFileSync(path.join(REPO, 'crates/nunchiro-core/tests/fixtures/claude-mode')), { mode: 0o700 });
  const project = core.project('demo');
  mates(core, [{ id: 'main', name: 'Main', project, lead: true }]);
  // The window's chat page holds two wake lines, as the transcript of a lead with workers would.
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => {
      const msg = (typeof m === 'string' ? JSON.parse(m) : null) as { id?: number; chat?: string } | null;
      if (msg?.chat) {
        const events = [W(1), W(2)].map((text) => ({ schema_version: 1, cursor: 0, data: { kind: 'message', role: 'user', text } }));
        events.forEach((e, i) => (e.cursor = i + 1));
        return ws.send(JSON.stringify({ id: msg.id, response: { Ok: { page: { schema_version: 1, events, before: null } } } }));
      }
      server.send(m);
    });
    server.onMessage((m) => ws.send(m));
  });
  await openWindow(app);
  await openSeat(app, core, 'Main');
  const line = app.locator('.msg.wake[data-wakes]');
  await expect(line).toHaveText('2 worker updates · View in Team');
  await expect(app.locator('.teamv')).toHaveCount(0);
  await line.getByRole('button', { name: 'View in Team' }).click();
  await expect(app.locator('.teamv')).toBeVisible();
});
