// V2.5-15: shared steps for the web-access specs. The Mac window turns browser access on in Settings and allows the
// pairing; a separate browser context plays the phone, served by the core's own browser listener.
import net from 'node:net';
import type { Browser, Page } from '@playwright/test';
import { expect, openWindow } from './fixtures';

export async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

/** Settings > Phone and web access, from the visible Settings control: two clicks. */
export async function openBrowserAccess(app: Page) {
  await app.getByRole('button', { name: 'Settings', exact: true }).click();
  // needs 192 (ticket 250): Phone and web access is its own page again; its section heading is the h2 under the page title.
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Phone and web access', exact: true }).click();
  await expect(app.getByRole('heading', { name: 'Phone and web access', level: 2 })).toBeVisible();
}

/** Opens the Mac window and turns browser access on at `port`. */
export async function enable(app: Page, port: number) {
  await openWindow(app);
  await openBrowserAccess(app);
  await app.getByRole('textbox', { name: 'Port' }).fill(String(port));
  await app.getByRole('textbox', { name: 'Port' }).blur(); // saved on blur
  // Controlled by the core's reply: checked once the core bound the port.
  await app.getByRole('switch', { name: 'Allow phone and web access', exact: true }).click();
  await expect(app.getByRole('switch', { name: 'Allow phone and web access', exact: true })).toBeChecked();
  await expect(app.locator('.browser-page')).toContainText(`http://127.0.0.1:${port}`);
}

/** A fresh browser (its own storage, like another device) on the browser listener. */
export async function phone(browser: Browser, url: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  return { page, errors };
}

/** The whole approval: Pair on the phone, the same code on the Mac, Allow there; the phone then connects. */
export async function pair(app: Page, page: Page) {
  await page.getByRole('button', { name: 'Pair' }).click();
  const code = (await page.locator('[data-pair-code]').innerText()).trim();
  expect(code).toMatch(/^\d{6}$/);
  const sheet = app.getByRole('dialog', { name: 'Browser pairing request' });
  await expect(sheet).toContainText(code);
  await sheet.getByRole('button', { name: 'Allow' }).click();
  await expect(page.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible({ timeout: 10_000 });
  return code;
}
