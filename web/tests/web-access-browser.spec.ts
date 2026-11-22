// V2.5-15 acceptance (docs/design/v25-web-access.md section 7, web): a real core, the Mac window from the preview
// server and a second browser context on the core's browser listener.
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from './fixtures';
import { enable, freePort, openBrowserAccess, pair, phone } from './web-access-shared';
import { openWindow } from './fixtures';

test.setTimeout(60_000);

test('settings-browser-access-reachable', async ({ app }) => {
  await openWindow(app);
  // Two clicks from the visible Settings control; the toggle starts off and, with nothing paired, an empty state (v25-fix-settings).
  await openBrowserAccess(app);
  await expect(app.getByRole('switch', { name: 'Allow browser access', exact: true })).not.toBeChecked();
  // needs 192 (ticket 250 r3): final.html draws the Paired browsers card with its empty state.
  await expect(app.getByRole('heading', { name: 'Paired browsers' })).toHaveCount(1);
  await expect(app.getByText('None yet. Turn on access to get a pairing code.')).toBeVisible();
});

test('browser-pairing-shows-code', async ({ app, browser }) => {
  const port = await freePort();
  await enable(app, port);
  const { page } = await phone(browser, `http://127.0.0.1:${port}/`);
  await expect(page.getByRole('heading', { name: 'Pair this browser' })).toBeVisible();
  await page.getByRole('button', { name: 'Pair' }).click();
  const code = (await page.locator('[data-pair-code]').innerText()).trim();
  expect(code).toMatch(/^\d{6}$/);
  await expect(page.getByRole('status')).toHaveText('Waiting for the Mac…');
  const sheet = app.getByRole('dialog', { name: 'Browser pairing request' });
  await expect(sheet).toContainText(code);
  // W6: a loopback request is labelled as possibly an agent.
  await expect(sheet).toContainText('From this Mac (same-computer request). An agent could have sent it.');
  await sheet.getByRole('button', { name: 'Deny' }).click();
  await expect(page.getByRole('alert')).toHaveText('The pairing was denied or expired.');
  await expect(app.getByText('No browser paired yet')).toBeVisible(); // v25-fix-settings empty state
});

test('browser-watch-and-answer', async ({ app, core, browser }) => {
  const p = core.project('demo');
  const asks = core.agent(p, 'asks', 'go');
  const echo = core.shell(p, 'echo');
  const port = await freePort();
  await enable(app, port);
  const { page, errors } = await phone(browser, `http://127.0.0.1:${port}/`);
  await pair(app, page);
  await expect(app.locator('.browser-page')).toContainText('paired from 127.0.0.1');
  // Watch: the sessions are listed and one's output shows.
  await expect(page.getByRole('button', { name: /^echo/ })).toBeVisible();
  // Answer: the agent's question reaches the phone; its answer reaches the agent and is noticed on the Mac.
  fs.writeFileSync(path.join(asks.cwd, 'go'), '');
  const card = page.getByRole('article', { name: 'asks is waiting' });
  await expect(card).toContainText('Do you want to proceed?');
  // A screen-only permission is risky: like the Mac strip, the phone offers Deny only (V2-8e).
  await expect(card.getByRole('button')).toHaveText(['Deny']);
  await card.getByRole('button', { name: 'Deny' }).click();
  // The core took it (a refusal would show on the card); the fake agent ignores the Esc, so its prompt stays drawn.
  await expect(card.getByRole('alert')).toHaveCount(0);
  await expect(app.getByRole('status', { name: 'Browser actions' })).toContainText('answered an agent');
  // Reply: typed text goes to the session as a reply.
  await page.getByRole('button', { name: /^echo/ }).click();
  await page.getByLabel('Reply to echo').fill('hello from the phone');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText('Sent.')).toBeVisible();
  await expect.poll(() => core.read(echo.id)).toContain('hello from the phone');
  await expect(app.getByRole('status', { name: 'Browser actions' })).toContainText('sent a reply');
  await expect(page.locator('.browser-output .xterm-rows')).toContainText('hello from the phone');
  expect(errors).toEqual([]);
  // Revoke on the Mac closes the phone's connection.
  // Ticket 991 Q6-11: the paired browser is a kit row; its Revoke names the browser and is the kit's button.
  const device = app.locator('.browser-page [data-row="device"]');
  await expect(device.locator('.snm')).toContainText('·');
  await expect(app.locator('.browser-page .machine-btn')).toHaveCount(0);
  await expect(device.locator('button.btn.danger')).toHaveText('Revoke');
  await device.getByRole('button', { name: /^Revoke .*·/ }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Disconnected' })).toBeVisible();
});

test('browser-start-not-offered', async ({ app, browser }) => {
  const port = await freePort();
  await enable(app, port);
  const { page } = await phone(browser, `http://127.0.0.1:${port}/`);
  await pair(app, page);
  await expect(page.getByRole('heading', { name: 'Sessions' })).toBeVisible();
  for (const name of [/new session/i, /start/i, /settings/i, /close/i]) await expect(page.getByRole('button', { name })).toHaveCount(0);
  // The core refuses it too, whatever the page sends.
  const refused = await page.evaluate(
    (token) =>
      new Promise<string>((resolve) => {
        const ws = new WebSocket(`ws://${location.host}/ws`, ['nunchiro.v1', `nunchiro.token.${token}`]);
        ws.onopen = () => ws.send(JSON.stringify({ id: 1, request: { op: 'start', session: { id: 'x', kind: 'shell', cwd: '/tmp' } } }));
        ws.onmessage = (m) => {
          const v = JSON.parse(m.data);
          if (v.id === 1) resolve(v.response.Err);
        };
      }),
    await page.evaluate(() => localStorage.getItem('nunchiro.device-token')),
  );
  expect(refused).toBe('not allowed from the browser');
});
