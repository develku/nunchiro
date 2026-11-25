// Needs 171, 172 (ticket 206; http auth): each browser-access address has Copy and Open. Both use exactly the address the
// page shows, no token, pairing code, device id or path; Open goes through `openLink` (the user's browser, http(s) only).
import { once } from 'node:events';
import net from 'node:net';
import type { Page } from '@playwright/test';
import { expect, openWindow, test } from './fixtures';
import { enable, freePort, openBrowserAccess } from './web-access-shared';

/** Copies and opened windows are recorded by stubs placed before the page loads. */
async function stubs(app: Page) {
  await app.addInitScript(() => {
    const w = window as unknown as { __copied: string[]; __opened: unknown[][] };
    w.__copied = [];
    w.__opened = [];
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (text: string) => void w.__copied.push(text) }, configurable: true });
    window.open = (...args: unknown[]) => (w.__opened.push(args), null);
  });
}
const copied = (app: Page) => app.evaluate(() => (window as unknown as { __copied: string[] }).__copied);
const opened = (app: Page) => app.evaluate(() => (window as unknown as { __opened: unknown[][] }).__opened);
const PLAIN = /^http:\/\/[^\s/?#]+$/;

async function shown(app: Page, port: number) {
  await stubs(app);
  await enable(app, port);
  // Ticket 991 Q6-11: each address is a row of the Settings kit; the page draws no control of its own (`.machine-btn`).
  const rows = app.locator('.browser-page [data-row="address"]');
  await expect(rows.first().getByRole('button', { name: 'Open', exact: false })).toBeVisible();
  await expect(app.locator('.browser-page .machine-btn')).toHaveCount(0);
  await expect(app.locator('.browser-page [class*="machine-"]')).toHaveCount(0);
  await expect(rows.first().locator('.sctl button.btn')).toHaveCount(2);
  const text = (await rows.allInnerTexts()).join('\n');
  return [...text.matchAll(/http:\/\/\S+/g)].map((m) => m[0]);
}

// Ticket 317 review: access stays on when its port is taken, so the paired list must not say to turn it on or point at an address.
test('browser_on_with_no_address: a taken port keeps On and the paired list says there is no address', async ({ app }) => {
  const port = await freePort();
  const taken = net.createServer().listen(port, '127.0.0.1');
  await once(taken, 'listening');
  try {
    await openWindow(app);
    await openBrowserAccess(app);
    await app.getByRole('textbox', { name: 'Port' }).fill(String(port));
    await app.getByRole('textbox', { name: 'Port' }).blur();
    await app.getByRole('switch', { name: 'Allow phone and web access', exact: true }).click();
    await expect(app.getByRole('switch', { name: 'Allow phone and web access', exact: true })).toBeChecked();
    await expect(app.locator('.browser-page [role="alert"][data-field="problem"]')).toContainText('in use');
    await expect(app.getByText('None yet. No address is available to open right now.')).toBeVisible();
    await expect(app.getByText('Turn on access')).toHaveCount(0);
  } finally {
    taken.close();
  }
});

test('browser_address_copy: Copy writes exactly the shown address and says Copied for 3 seconds', async ({ app }) => {
  const port = await freePort();
  const [address] = await shown(app, port);
  expect(address).toBe(`http://127.0.0.1:${port}`);
  await app.getByRole('button', { name: `Copy ${address}`, exact: true }).click();
  await expect.poll(() => copied(app)).toEqual([address]);
  const status = app.locator('.browser-page [role="status"]');
  await expect(status).toHaveText('Copied');
  await expect(status).toHaveCount(0, { timeout: 5000 });
});

test('browser_address_open: Open calls window.open once with exactly the address, _blank and noopener', async ({ app }) => {
  const port = await freePort();
  const [address] = await shown(app, port);
  const requests: string[] = [];
  app.on('websocket', (ws) => ws.on('framesent', (f) => typeof f.payload === 'string' && requests.push(f.payload)));
  const before = requests.length;
  await app.getByRole('button', { name: `Open ${address}`, exact: true }).click();
  await expect.poll(() => opened(app)).toEqual([[address, '_blank', 'noopener']]);
  expect(requests.slice(before).filter((p) => !p.includes('"status"'))).toEqual([]); // only the page's own status polling
});

test('browser_address_text_is_plain: every copied or opened string is a listed bare address; the page text is unchanged', async ({ app }) => {
  const port = await freePort();
  const addresses = await shown(app, port);
  expect(addresses.length).toBeGreaterThan(0);
  const before = await app.locator('.browser-page').innerText();
  for (const a of addresses) {
    await app.getByRole('button', { name: `Copy ${a}`, exact: true }).click();
    await app.getByRole('button', { name: `Open ${a}`, exact: true }).click();
  }
  const strings = [...(await copied(app)), ...(await opened(app)).map((args) => String(args[0]))];
  expect(strings).toHaveLength(addresses.length * 2);
  for (const s of strings) {
    expect(s).toMatch(PLAIN);
    expect(addresses).toContain(s);
  }
  // Nothing but "Copied" is added to the page text, and no pairing code or device id appears.
  const after = (await app.locator('.browser-page').innerText()).replace(/Copied/g, '');
  expect(after.replace(/\s+/g, ' ')).toBe(before.replace(/\s+/g, ' '));
});

test('browser_address_buttons_only_where_addresses_show: off, nothing is listed and no button', async ({ app }) => {
  await openWindow(app);
  await openBrowserAccess(app);
  await expect(app.getByRole('switch', { name: 'Allow phone and web access', exact: true })).not.toBeChecked();
  await expect(app.getByRole('button', { name: /^(Copy|Open) http/ })).toHaveCount(0);
});

// Ticket 354: a port below 1024 stayed in the field as if it had been taken; nothing said the core refuses it.
test('browser_port_refused_says_so: a port outside 1024 to 65535 shows the range and the port still in use', async ({ app }) => {
  await openWindow(app);
  await openBrowserAccess(app);
  const port = app.getByRole('textbox', { name: 'Port' });
  const was = await port.inputValue();
  const refusal = app.locator('[data-field="port-range"]');
  await expect(refusal).toHaveCount(0);
  await port.fill('80');
  // Ticket 378 (설정 나머지): red while it is in the field; leaving it puts the saved port back and keeps the range line.
  await expect(port).toHaveAttribute('aria-invalid', 'true');
  const border = () => port.evaluate((e) => getComputedStyle(e).borderTopColor);
  const invalid = await border();
  await port.press('Tab');
  await expect(port).toHaveValue(was);
  await expect(port).toHaveAttribute('aria-invalid', 'false');
  expect(await border()).not.toBe(invalid);
  await expect(refusal).toHaveText(`Enter a port from 1024 to 65535. The port in use stays ${was}.`);
  await port.fill(String(await freePort()));
  await expect(refusal).toHaveCount(0);
});
