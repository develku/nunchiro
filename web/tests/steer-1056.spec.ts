// Ticket 1056: Send now on a queued row while Claude works goes into the running turn. The row stays, marked as sent,
// until the transcript shows the message, and comes back once when the session ends first. A held message names the
// true reason it waits. A real core and the fake agent of composer-queue.spec.ts; a filter on the window's socket stands
// in for the transcript (chat_page) and for queued rows and questions the fake cannot make.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { type Core, expect, openWindow, REPO, test } from './fixtures';

const HOOK = `const net = require('net'), fs = require('fs'), path = require('path'); const [h, id, event] = process.argv.slice(1);
const s = net.connect(path.join(h, 'core.sock')); let b = '';
s.on('connect', () => s.write(JSON.stringify({ token: fs.readFileSync(path.join(h, 'core.token'), 'utf8').trim(), request: { op: 'hook', id, event, payload: {} } }) + '\\n'));
s.on('data', (d) => { b += d; if (b.includes('\\n')) { process.stdout.write(b); s.destroy(); } });`;
function hook(core: Core, id: string, event: 'UserPromptSubmit' | 'Stop') {
  const reply = JSON.parse(execFileSync(process.execPath, ['-e', HOOK, core.home, id, event], { encoding: 'utf8', timeout: 10_000 }));
  if (!reply.Ok) throw new Error(`hook refused: ${JSON.stringify(reply)}`);
}
const box = (app: Page) => app.locator('.composer textarea');
const rows = (app: Page) => app.locator('.composer .qrow');
const isWorking = (core: Core, id: string) => (core.cli('snapshot', '--json').sessions as { id: string; attention: { working: boolean } }[]).find((x) => x.id === id)?.attention.working;
const draft = (app: Page, id: string) => app.evaluate((i) => JSON.parse(localStorage.getItem('nunchiro.composer.drafts.v1') ?? '{}')[i] as string | undefined, id);

type Snap = { id: string; pending: unknown[]; send_log?: unknown[]; send_queue?: unknown[] };
type Frame = { event?: string; sessions?: Snap[]; id?: number; request?: { op: string; [k: string]: unknown } };
/** The window's socket: `said` is what the transcript shows as the user's; `edit` rewrites each session of a snapshot. */
async function wire(app: Page) {
  const w = { said: [] as string[], edit: null as ((s: Snap) => void) | null, sent: [] as { op: string; [k: string]: unknown }[], again: () => {} };
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => {
      const msg = (typeof m === 'string' ? JSON.parse(m) : null) as Frame | null;
      if (msg?.request) w.sent.push(msg.request);
      if (msg?.request?.op === 'chat_page') {
        const events = w.said.map((text) => ({ data: { kind: 'message', role: 'user', text } }));
        return ws.send(JSON.stringify({ id: msg.id, response: { Ok: { page: { events, before: null } } } }));
      }
      server.send(m);
    });
    server.onMessage((m) => {
      if (typeof m !== 'string') return ws.send(m);
      const f = JSON.parse(m) as Frame;
      if (f.event !== 'snapshot') return ws.send(m);
      // An idle session sends no new snapshot: `again` sends the last one through the current edit.
      w.again = () => {
        const copy = JSON.parse(m) as Frame;
        if (w.edit) for (const s of copy.sessions ?? []) w.edit(s);
        ws.send(JSON.stringify(copy));
      };
      w.again();
    });
  });
  return w;
}
async function start(app: Page, core: Core) {
  fs.writeFileSync(path.join(core.home, 'bin', 'claude'), fs.readFileSync(path.join(REPO, 'crates/nunchiro-core/tests/fixtures/claude-mode')), { mode: 0o700 });
  const s = core.agent(core.project('p'), 'alpha', 'x');
  await openWindow(app);
  await app.locator(`.tab[data-tab="${s.id}"]`).click();
  hook(core, s.id, 'UserPromptSubmit');
  await expect.poll(() => isWorking(core, s.id)).toBe(true);
  await expect(app.locator('.composer .send')).toHaveAccessibleName('Stop');
  return s;
}
async function queueOne(app: Page, text: string) {
  await box(app).fill(text);
  await box(app).press('Enter');
  await expect(rows(app)).toHaveCount(1);
}

test('sent_row_waits_for_the_transcript: Send now marks the row sent and waiting, with no Stop, and the transcript removes it', async ({ app, core }) => {
  const w = await wire(app);
  await start(app, core);
  await queueOne(app, 'look at the logs too');
  // The owner's rule (2026-11-23): the row's own button, visible without hover, says the message goes in at the next step.
  const send = rows(app).first().getByRole('button', { name: '1 Send now', exact: true });
  await expect(send).toBeVisible();
  await expect(send).toHaveAttribute('title', "Send now. The message goes in at the agent's next step; the turn goes on.");
  await send.click();
  await expect(rows(app).first().getByRole('status')).toHaveText('Sent. Waiting for the agent to take it.');
  await expect(send).toBeDisabled();
  expect(w.sent.filter((r) => r.op === 'steer_now').map((r) => r.text)).toEqual(['look at the logs too']);
  expect(w.sent.filter((r) => r.op === 'send_keys')).toEqual([]); // the window pressed no Stop
  w.said = ['look at the logs too'];
  await expect(rows(app)).toHaveCount(0);
});

test('sent_row_comes_back_once_when_the_session_ends_first', async ({ app, core }) => {
  await wire(app);
  const s = await start(app, core);
  await queueOne(app, 'one more thing');
  await rows(app).first().getByRole('button', { name: '1 Send now', exact: true }).click();
  await expect(rows(app).first().getByRole('status')).toHaveText('Sent. Waiting for the agent to take it.');
  core.cli('session', 'close', s.id);
  await expect.poll(() => draft(app, s.id)).toBe('one more thing');
});

test('held_row_names_the_true_reason: a question, rows ahead, or the turn', async ({ app, core }) => {
  const w = await wire(app);
  const s = await start(app, core);
  const held = app.locator('.composer .queued.held b');
  const row = (id: string, sender: string, content: string, at: number) => ({ id, sender, content, status: 'queued', at, completion_seq: 0, last_activity: 0, keys: [], submit: true });
  const mine = row('m1', 'user', 'my words', 3);
  // As the core sends it: send_queue in queue order, send_log (log and queue) sorted by time.
  const set = (queue: { at: number }[], ask: boolean) =>
    (w.edit = (x) => {
      if (x.id !== s.id) return;
      x.send_queue = queue;
      x.send_log = [...queue].sort((a, b) => a.at - b.at);
      if (ask) x.pending = [{ id: 'q1', session_id: s.id, scope: 'session', kind: 'question', text: 'Which?', choices: [], observed_at: 1, actionable: true }];
    }, w.again());
  set([mine], false);
  await expect(held).toHaveText('Waiting for the agent to finish its turn:');
  // The owner's case: the core put the user row ahead of two older wake lines, so nothing goes before it.
  set([mine, row('w1', 'worker-1', 'worker w1 done', 1), row('w2', 'worker-2', 'worker w2 done', 2)], false);
  await expect(held).toHaveText('Waiting for the agent to finish its turn:');
  set([row('a1', 'lead-session', 'a message from the lead', 1), mine], false);
  await expect(held).toHaveText('Waiting for earlier messages to go first (1):');
  set([mine], true);
  await expect(held).toHaveText('Held until you answer:');
});
