// Look v33 S3-3: a failed session's tab showed the orange hand ("waiting") under "Session ended unexpectedly". Orange is
// your turn only: an ended or failed agent never waits, even when a stale `waiting` flag reaches the window (the core no
// longer keeps one, queue/mod.rs `waits`); failed shows the broken mark.
import path from 'node:path';
import { expect, openWindow, REPO, test } from './fixtures';

test('failed_tab_never_waits: a failed session with a leftover waiting flag shows the broken mark, not the hand', async ({ app, core }) => {
  const dir = core.project('demo');
  const s = core.shell(dir, 'look33b');
  let last = '';
  const sockets: { send(m: string): void }[] = [];
  let ended = false;
  const apply = (raw: string) => {
    const msg = JSON.parse(raw);
    for (const x of msg.sessions ?? [])
      if (ended && x.id === s.id) (x.state = 'failed'), Object.assign(x.attention, { failed: true, waiting: true }), (x.pending = []);
    return JSON.stringify(msg);
  };
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    sockets.push(ws);
    ws.onMessage((m) => server.send(m));
    server.onMessage((m) => ws.send(typeof m === 'string' && JSON.parse(m).event === 'snapshot' ? apply((last = m)) : m));
  });
  await openWindow(app);
  const dot = app.locator(`.tab[data-tab="${s.id}"] .tdot`);
  await expect(dot).toBeVisible();
  ended = true;
  for (const ws of sockets) ws.send(apply(last));
  await expect(dot).toHaveAttribute('data-s', 'failed');
  // Design book (tabs): the tab carries the tree's dot, no glyph: failed is the still red dot, never the warm one.
  await expect(dot).toHaveAttribute('data-dot', 'bad');
  await app.screenshot({ path: path.join(REPO, '.scratch/shots/w87-failed-tab-no-hand.png') });
});
