// Ticket 1085: no automatic line shows as the owner's bubble in a lead's chat. Every form the core types (the shared
// fixture a core test checks against the core's own code) folds into the quiet row; the owner's words glued after one
// keep their bubble alone; a message that quotes one stays whole. The last case drives a page on a fixture core.
import fs from 'node:fs';
import path from 'node:path';
import { expect, openWindow, REPO, test } from './fixtures';
import { mates, openSeat } from './leader-990';
import type { ChatEvent } from '../src/chat/feed';
import { buildRows } from '../src/chat/model';

const FORMS = (JSON.parse(fs.readFileSync(path.join(REPO, 'crates/nunchiro-core/tests/fixtures/automatic-lines.json'), 'utf8')) as { lines: { kind: string; text: string }[] }).lines;
const TEAM = new Set(['heartbeat', 'nudge', 'forward', 'release']);
let cursor = 0;
const say = (text: string): ChatEvent => ({ schema_version: 1, cursor: ++cursor, data: { kind: 'message', role: 'user', text } });
const shape = (...texts: string[]) => buildRows(texts.map(say)).map((r) => (r.kind === 'wakes' ? `wakes:${r.n}:${r.team}` : r.kind === 'user' ? `user:${r.text}` : r.kind));

test('1085: every automatic line form the core types folds into the quiet row, alone or glued before the owner words', () => {
  expect(new Set(FORMS.map((f) => f.kind))).toEqual(new Set(['wake', 'notice', 'heartbeat', 'nudge', 'forward', 'release']));
  for (const { kind, text } of FORMS) {
    const row = `wakes:1:${TEAM.has(kind) ? 1 : 0}`;
    expect(shape(text), text).toEqual([row]);
    expect(shape(`${text}그리고 merge it`), text).toEqual([row, 'user:그리고 merge it']);
    expect(shape(`${text}\nplease merge it`), text).toEqual([row, 'user:please merge it']);
    const quote = `why did you say "${text}"?`;
    expect(shape(quote), text).toEqual([`user:${quote}`]);
    expect(shape(`hello ${text}`), text).toEqual([`user:hello ${text}`]);
    expect(shape(`${text} and more`), text).toEqual([`user:${text} and more`]); // a space: his own sentence
  }
});

test('1085 r2: his own sentences that only start like an automatic line stay whole', () => {
  for (const own of ['worker 3 failed to start, check it', 'Team: please look at this', 'worker w1 done, now merge it', '2 new messages: run nunchiro agent check please']) {
    expect(shape(own), own).toEqual([`user:${own}`]);
  }
});

test('1085: the three glued messages of the owner transcript draw the quiet row and only his words', () => {
  expect(shape('3 new messages: run nunchiro agent check그리고 내가 승인이라고 최종 승인이라고 하기전까지는 …')).toEqual(['wakes:1:0', 'user:그리고 내가 승인이라고 최종 승인이라고 하기전까지는 …']);
  expect(shape('Team: 2 approved wait to merge, 1 seat stalled.위에 문제들을 승인하고 …')).toEqual(['wakes:1:1', 'user:위에 문제들을 승인하고 …']);
  expect(shape('worker Builder · ticket 1070: the Agents widget is… done작업 진행이 느린것 같은데')).toEqual(['wakes:1:0', 'user:작업 진행이 느린것 같은데']);
});

test('1085: heartbeats fold with worker lines into one row that counts them all', () => {
  expect(shape('Team: 1 report waits for review.', 'Team: 2 approved wait to merge, 1 seat stalled.')).toEqual(['wakes:2:2']);
  expect(shape('Team: 1 report waits for review.', 'worker w1 done; report says: "STATUS: done"', '2 new messages: run nunchiro agent check')).toEqual(['wakes:3:1']);
});

test('1085: a lead chat of only heartbeats says "Team update"; with a worker line it says "N worker updates"', async ({ app, core }) => {
  fs.writeFileSync(path.join(core.home, 'bin', 'claude'), fs.readFileSync(path.join(REPO, 'crates/nunchiro-core/tests/fixtures/claude-mode')), { mode: 0o700 });
  const project = core.project('demo');
  mates(core, [{ id: 'main', name: 'Main', project, lead: true }]);
  let texts = ['Team: 1 report waits for review.', 'Team: 2 approved wait to merge, 1 seat stalled.위에 문제들을 승인하고'];
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => {
      const msg = (typeof m === 'string' ? JSON.parse(m) : null) as { id?: number; chat?: string } | null;
      if (msg?.chat) {
        const events = texts.map((text, i) => ({ schema_version: 1, cursor: i + 1, data: { kind: 'message', role: 'user', text } }));
        return ws.send(JSON.stringify({ id: msg.id, response: { Ok: { page: { schema_version: 1, events, before: null } } } }));
      }
      server.send(m);
    });
    server.onMessage((m) => ws.send(m));
  });
  await openWindow(app);
  await openSeat(app, core, 'Main');
  const line = app.locator('.msg.wake[data-wakes]');
  await expect(line).toHaveText('Team update · View in Team');
  await expect(app.locator('.msg.user')).toHaveText(['위에 문제들을 승인하고']);
  await expect(app.getByText('Team: ', { exact: false })).toHaveCount(0);
  texts = ['Team: 1 report waits for review.', 'worker w1 done'];
  await app.reload();
  await openSeat(app, core, 'Main');
  await expect(line).toHaveText('2 worker updates · View in Team');
});
