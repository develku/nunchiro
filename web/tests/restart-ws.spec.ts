// V1A-52 item 6 (owner pass 2026-10-26): WebKit logs "WebSocket connection to ... failed: The network connection was
// lost." once on Restart in the Permission needed panel. Cause: Restart replaces the tab, the last listener of the chat
// socket goes, so ChatFeed closes that socket on purpose and the new tab opens a fresh one (expected). The close was
// unclean (1006, both engines) because the core's window loop returned on the client's Close frame without flushing
// tungstenite's queued Close reply, then shut the TCP socket (crates/nunchiro-core/src/http/mod.rs, `serve`). WebKit
// reported that unclean close as a console error; Chromium stayed silent. V1A-55 fixed it: the window loop now sends
// and flushes its Close reply, and the second test pins the clean close.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, openWindow, test, type Core } from './fixtures';

/** Records every window socket: opens, the page's own close() calls and each close event with its code. */
const trackSockets = (page: Page) =>
  page.addInitScript(() => {
    const W = window.WebSocket;
    const log: string[] = ((window as unknown as { __ws: string[] }).__ws = []);
    let n = 0;
    window.WebSocket = class extends W {
      constructor(u: string | URL, p?: string | string[]) {
        super(u, p);
        const i = n++;
        log.push(`#${i} new`);
        const close = this.close.bind(this);
        this.close = (...a) => (log.push(`#${i} close()`), close(...a));
        this.addEventListener('close', (e) => log.push(`#${i} closed ${e.code} ${e.wasClean ? 'clean' : 'unclean'}`));
      }
    } as typeof WebSocket;
  });
const sockets = (page: Page) => page.evaluate(() => (window as unknown as { __ws: string[] }).__ws);

async function restartBlocked(app: Page, core: Core) {
  const project = core.project('locked');
  fs.chmodSync(project, 0o100);
  try {
    core.cli('session', 'start', '--kind', 'claude', '--project', project, '--label', 'ext', '--model', path.join(project, 'never'));
    await expect.poll(() => core.cli('snapshot', '--json').sessions[0].blocked, { timeout: 10_000 }).toBeTruthy();
    await openWindow(app);
    // #0 is the window's API socket, #1 the chat feed's (a Claude tab is open).
    await expect.poll(() => sockets(app)).toEqual(['#0 new', '#1 new']);
    await app.getByRole('region', { name: 'Permission needed' }).getByRole('button', { name: 'Restart session' }).click();
    await expect.poll(() => core.cli('snapshot', '--json').sessions.length).toBe(2);
    await expect.poll(async () => (await sockets(app)).some((l) => l.startsWith('#1 closed'))).toBe(true);
  } finally {
    fs.chmodSync(project, 0o700);
  }
}

test('restart-ws-lost: Restart closes the old chat socket on purpose, a new one replaces it, the API socket stays', async ({ app, core }) => {
  await trackSockets(app);
  const errors: string[] = [];
  app.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await restartBlocked(app, core);
  // The new socket opens a moment after the old one closes: wait for it, then read the list.
  await expect.poll(async () => (await sockets(app)).filter((l) => !l.startsWith('#1 closed'))).toEqual(['#0 new', '#1 new', '#1 close()', '#2 new']);
  // At most the one engine message for that socket; nothing else, and no reconnect storm.
  expect(errors.every((e) => /^WebSocket connection to 'ws:\/\/127\.0\.0\.1:\d+\/ws' failed: The network connection was lost\.$/.test(e))).toBe(true);
  expect(errors.length).toBeLessThanOrEqual(1);
});

test('restart-ws-lost: the core answers the page closing a socket with a Close frame (clean close)', async ({ app, core }) => {
  await trackSockets(app);
  await restartBlocked(app, core);
  // The page closes with no code, so the core echoes an empty Close (RFC 6455 5.5.1), which the page reads as 1005.
  expect((await sockets(app)).find((l) => l.startsWith('#1 closed'))).toBe('#1 closed 1005 clean');
});
