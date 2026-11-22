// Acceptance 11 from the browser side (the Rust tests cover the raw handshakes).
import { expect, ORIGIN, test } from './fixtures';

test('a page with a wrong token never connects', async ({ page, core }) => {
  await page.addInitScript((b) => (window.__NUNCHIRO__ = { ...b, token: 'f'.repeat(64) }), core.boot());
  await page.goto('/');
  await expect(page.getByRole('status').filter({ hasText: 'Disconnected' })).toBeVisible();
  await page.waitForTimeout(1500);
  await expect(page.getByRole('status').filter({ hasText: /^Connected$/ })).toHaveCount(0);
});

test('the right token from an origin outside the allowlist is refused', async ({ page, core }) => {
  await page.addInitScript((b) => (window.__NUNCHIRO__ = b), core.boot());
  // Same files, different origin: http://localhost is not on the allowlist.
  await page.goto(ORIGIN.replace('127.0.0.1', 'localhost'));
  await page.waitForTimeout(1500);
  await expect(page.getByRole('status').filter({ hasText: /^Connected$/ })).toHaveCount(0);
});
