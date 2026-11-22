// V2.5-15, threat model W7: `http://100.x:7788` is not a secure context, and loopback is, so a test on 127.0.0.1 would
// miss what breaks there. Chromium resolves `nunchiro.test` to loopback, which leaves the page insecure; a small
// proxy rewrites Host and Origin to the core's loopback literal, as Tailscale's IP literal would match them.
import net from 'node:net';
import { test, expect } from './fixtures';
import { enable, freePort, pair, phone } from './web-access-shared';

test.use({ launchOptions: { args: ['--host-resolver-rules=MAP nunchiro.test 127.0.0.1'] } });
test.setTimeout(60_000);

/** One request per connection (the core closes after each reply); the WebSocket's head is rewritten, then piped. */
function proxy(from: number, to: number) {
  const server = net.createServer((client) => {
    let head = Buffer.alloc(0);
    const first = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf('\r\n\r\n');
      if (end < 0) return;
      client.off('data', first);
      const text = head.subarray(0, end).toString('latin1').split(`nunchiro.test:${from}`).join(`127.0.0.1:${to}`);
      const upstream = net.connect(to, '127.0.0.1', () => {
        upstream.write(Buffer.concat([Buffer.from(text, 'latin1'), head.subarray(end)]));
        client.pipe(upstream);
        upstream.pipe(client);
      });
      upstream.on('error', () => client.destroy());
      client.on('error', () => upstream.destroy());
    };
    client.on('data', first);
  });
  server.listen(from, '127.0.0.1');
  return server;
}

test('browser-insecure-context-loads', async ({ app, browser, browserName }) => {
  test.skip(browserName !== 'chromium', 'host-resolver-rules is a Chromium switch');
  const port = await freePort();
  const front = await freePort();
  const server = proxy(front, port);
  try {
    await enable(app, port);
    const { page, errors } = await phone(browser, `http://nunchiro.test:${front}/`);
    expect(await page.evaluate(() => isSecureContext)).toBe(false);
    // The features missing there, listed for the report; the page must not need them.
    const missing = await page.evaluate(() => ({
      subtle: !globalThis.crypto?.subtle,
      randomUUID: typeof globalThis.crypto?.randomUUID !== 'function',
      clipboard: !navigator.clipboard,
      serviceWorker: !('serviceWorker' in navigator),
      notification: typeof Notification === 'undefined' || !window.isSecureContext,
      share: typeof navigator.share !== 'function',
    }));
    console.log(`insecure-context missing: ${JSON.stringify(missing)}`);
    expect(missing.subtle && missing.clipboard && missing.serviceWorker).toBe(true);
    await expect(page.getByRole('heading', { name: 'Pair this browser' })).toBeVisible();
    await pair(app, page);
    await expect(page.getByRole('heading', { name: 'Waiting for you' })).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    server.close();
  }
});
