// ticket 123: the web composer's follow-up Enter opts into the core's key gate (`composer: true`) and carries the pending
// ids the window had drawn BEFORE the text went out. A real core and a fake Claude (claude-mode); the gate itself is the
// sessions.rs tests.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { type Core, expect, openWindow, REPO, test } from './fixtures';

function fakeClaude(core: Core) {
  const src = path.join(REPO, 'crates/nunchiro-core/tests/fixtures/claude-mode');
  fs.writeFileSync(path.join(core.home, 'bin/claude'), fs.readFileSync(src), { mode: 0o700 });
}
type Req = { op: string; [k: string]: unknown };
function watch(app: Page) {
  const sent: Req[] = [];
  app.on('websocket', (ws) =>
    ws.on('framesent', (f) => {
      if (typeof f.payload !== 'string') return;
      const r = JSON.parse(f.payload).request;
      if (r) sent.push(r);
    }),
  );
  return sent;
}
const tab = (app: Page, id: string) => app.locator(`.tab[data-tab="${id}"]`);
const pendingIds = (core: Core, id: string) =>
  (core.cli('snapshot', '--json').sessions as { id: string; pending: { id: string }[] }[]).find((x) => x.id === id)!.pending.map((p) => p.id);

test('composer_sends_gated_enter: send_text then send_keys ["enter"] with composer true and seen = the drawn pending ids', async ({ app, core }) => {
  fakeClaude(core);
  const project = core.project('p');
  const s = core.agent(project, 'mode', 'x');
  const sent = watch(app);
  await openWindow(app);
  await tab(app, s.id).click();
  const ta = app.locator('.composer textarea');
  expect(pendingIds(core, s.id)).toEqual([]);
  await ta.fill('first');
  await ta.press('Enter');
  await expect.poll(() => sent.filter((r) => r.op === 'send_keys').length).toBe(1);
  const calls = sent.filter((r) => r.op === 'send_text' || r.op === 'send_keys');
  expect(calls.map((r) => r.op)).toEqual(['send_text', 'send_keys']);
  expect(calls[1]).toMatchObject({ keys: ['enter'], seen: [], composer: true });

  // A dialog the window has already drawn: its id is in `seen`.
  fs.writeFileSync(path.join(project, 'dialog'), '');
  await expect.poll(() => pendingIds(core, s.id).length).toBe(1);
  await expect(app.locator('.composer .send')).toBeVisible();
  const ids = pendingIds(core, s.id);
  // `seen` is what the window itself holds for the session (App `target.pending`), not the core's snapshot: polling the CLI
  // proves only that the core queued the dialog. Wait until the window has drawn that item (its decision line on the tree
  // row, needs 92); typing before then makes the core refuse the text, as `composer_text_refused_when_dialog_unseen` pins
  // (`seen: []` and "a request you have not seen is pending", round 4 log). No timeout is lengthened and no assertion below changes.
  await expect(app.locator(`.tree .q[data-item="${ids[0]}"]`)).toBeVisible();
  await ta.fill('second');
  await ta.press('Enter');
  await expect.poll(() => sent.filter((r) => r.op === 'send_keys').length).toBe(2);
  const second = sent.filter((r) => r.op === 'send_keys')[1];
  expect(second.composer).toBe(true);
  expect(second.keys).toEqual(['enter']);
  expect(Array.isArray(second.seen)).toBe(true);
  expect(second.seen).toEqual(ids);
});

test('composer_refused_enter_restores_the_draft', async ({ app, core }) => {
  fakeClaude(core);
  const s = core.agent(core.project('p'), 'mode', 'x');
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => {
      const msg = typeof m === 'string' ? JSON.parse(m) : null;
      if (msg?.request?.op === 'send_keys') return ws.send(JSON.stringify({ id: msg.id, response: { Err: 'a request you have not seen is pending' } }));
      server.send(m);
    });
    server.onMessage((m) => ws.send(m));
  });
  await openWindow(app);
  await tab(app, s.id).click();
  const ta = app.locator('.composer textarea');
  await ta.fill('keep me');
  await ta.press('Enter');
  await expect(ta).toHaveValue('keep me');
});

// w11-core: an Enter while a start question is on the screen is refused with `agent_blocked: …`. The window shows no
// error for it: the text stays in the box and the session's card is what asks.
test('composer_agent_blocked_enter_shows_no_error', async ({ app, core }) => {
  fakeClaude(core);
  const s = core.agent(core.project('p'), 'mode', 'x');
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => {
      const msg = typeof m === 'string' ? JSON.parse(m) : null;
      if (msg?.request?.op === 'send_keys') return ws.send(JSON.stringify({ id: msg.id, response: { Err: 'agent_blocked: a question is on the screen; answer it first' } }));
      server.send(m);
    });
    server.onMessage((m) => ws.send(m));
  });
  await openWindow(app);
  await tab(app, s.id).click();
  const ta = app.locator('.composer textarea');
  await ta.fill('keep me');
  await ta.press('Enter');
  await expect(ta).toHaveValue('keep me');
  await app.waitForTimeout(500);
  await expect(app.getByText(/agent_blocked/)).toHaveCount(0);
});
