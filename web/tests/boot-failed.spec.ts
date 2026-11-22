// Ticket 379: when the shell cannot reach or replace the core, the window says why and recovers; it is never left blank.
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

// Ticket 430: `failed` carries a failure kind; the window shows its fixed message, not a raw reason.
const failing = { failed: 'start', port: 0, token: '' };

const bootsFailingUntilBack = <B>(page: Page, good: B) =>
  page.addInitScript(
    ([good, bad]) => void ((window as { __NUNCHIRO__?: unknown }).__NUNCHIRO__ = sessionStorage.getItem('core-back') ? good : bad),
    [good, failing] as const,
  );

test('a window whose core failed shows the reason and Retry brings it up', async ({ page, core }) => {
  await bootsFailingUntilBack(page, core.boot());
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('Nunchiro could not start or update its background service.');
  await page.evaluate(() => sessionStorage.setItem('core-back', '1'));
  await page.getByRole('button', { name: 'Retry' }).click();
  await expect(page.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
});

test('a core that comes back after the failure was shown replaces it by itself', async ({ page, core }) => {
  await bootsFailingUntilBack(page, core.boot());
  await page.goto('/');
  await expect(page.getByRole('alert')).toBeVisible();
  await page.evaluate((good) => {
    sessionStorage.setItem('core-back', '1');
    window.__NUNCHIRO__ = good;
    window.dispatchEvent(new Event('nunchiro:boot'));
  }, core.boot());
  await expect(page.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
});
