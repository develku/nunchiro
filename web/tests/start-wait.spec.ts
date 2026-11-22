// Ticket 425: a core that is only slow to start is not an error. With no attempt failed, the window says the core is still
// starting (a status, in the user's language); "Can't load this page" with the reason shows only once an attempt really
// failed or the shell gave up waiting (app/src-tauri/src/main.rs deliver_boot). A boot arriving later replaces either.
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

const waiting = { waiting: true, port: 0, token: '' };
// Ticket 430: `failed` carries a failure kind; the window shows its fixed message only.
const failing = { failed: 'start', port: 0, token: '' };
const START_FAILED = 'Nunchiro could not start or update its background service. Retry, or quit and open Nunchiro again.';

/** The shell's stand-in scripts (main.rs `stand_in_script`): they replace nothing but another stand-in. */
const standIn = (boot: object) =>
  `if (!window.__NUNCHIRO__ || window.__NUNCHIRO__.failed || window.__NUNCHIRO__.waiting) { window.__NUNCHIRO__ = ${JSON.stringify(boot)}; window.dispatchEvent(new Event('nunchiro:boot')); }`;

/** Until the test sets `core-up`, each page load is handed the waiting stand-in; after, the real boot (as the shell would). */
const bootsWaitingUntilUp = (page: Page, good: object) =>
  page.addInitScript(
    ([good, wait]) => void ((window as { __NUNCHIRO__?: unknown }).__NUNCHIRO__ = sessionStorage.getItem('core-up') ? good : wait),
    [good, waiting] as const,
  );
const coreUp = (page: Page, good: object) =>
  page.evaluate((good) => {
    sessionStorage.setItem('core-up', '1');
    window.__NUNCHIRO__ = good as typeof window.__NUNCHIRO__;
    window.dispatchEvent(new Event('nunchiro:boot'));
  }, good);

test('start_wait: a slow core shows the waiting state, no error; a real failure then says why; the boot that follows brings the window up', async ({ page, core }) => {
  await bootsWaitingUntilUp(page, core.boot());
  await page.goto('/');
  const status = page.getByRole('status').filter({ hasText: 'Nunchiro is starting' });
  await expect(status).toBeVisible();
  await expect(status).toContainText('The background service is still starting. This window opens by itself when it is ready.');
  await expect(status).toHaveAttribute('data-state', 'waiting');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByText("Can't load this page")).toHaveCount(0);
  await expect(status.getByRole('button', { name: 'Retry' })).toBeVisible(); // a quiet action, kept
  // An attempt that really failed: the waiting state turns into the failure with its kind's fixed message.
  await page.evaluate(standIn(failing));
  const alert = page.getByRole('alert');
  await expect(alert).toContainText("Can't load this page");
  await expect(alert).toContainText(START_FAILED);
  await expect(page.getByText('Nunchiro is starting')).toHaveCount(0);
  // The core comes up: its boot replaces the failure by itself.
  await coreUp(page, core.boot());
  await expect(page.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
});

test('start_wait: a boot that lands while waiting replaces the waiting state; a stand-in never replaces a real boot', async ({ page, core }) => {
  await bootsWaitingUntilUp(page, core.boot());
  await page.goto('/');
  await expect(page.getByRole('status').filter({ hasText: 'Nunchiro is starting' })).toBeVisible();
  await coreUp(page, core.boot());
  await expect(page.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  await page.evaluate(standIn(waiting));
  await page.evaluate(standIn(failing));
  expect(await page.evaluate(() => (window.__NUNCHIRO__ as { port: number }).port)).not.toBe(0);
  await expect(page.getByText('Nunchiro is starting')).toHaveCount(0);
  await expect(page.getByRole('alert').filter({ hasText: "Can't load this page" })).toHaveCount(0);
});

test('start_wait: the waiting text follows the language setting', async ({ page }) => {
  await page.addInitScript((boot) => {
    localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ language: 'ko' }));
    (window as { __NUNCHIRO__?: unknown }).__NUNCHIRO__ = boot;
  }, waiting);
  await page.goto('/');
  const status = page.getByRole('status').filter({ hasText: 'Nunchiro를 시작하는 중' });
  await expect(status).toBeVisible();
  await expect(status).toContainText('백그라운드 서비스가 아직 시작하는 중입니다.');
  await expect(page.getByRole('alert')).toHaveCount(0);
});

// Ticket 430: a stand-in whose `failed` is not a known kind (an older shell's raw reason, here one holding a token and a
// `</script>`) shows the generic fixed message, never the value; each kind has its own message in the user's language.
test('start_wait: the failure shows a fixed message by kind, never the raw reason', async ({ page }) => {
  const raw = { failed: 'serve update failed: token=s3cr3t-abc </script><b>x</b>', port: 0, token: '' };
  await page.addInitScript((boot) => void ((window as { __NUNCHIRO__?: unknown }).__NUNCHIRO__ = boot), raw);
  await page.goto('/');
  const alert = page.getByRole('alert');
  await expect(alert).toContainText(START_FAILED);
  await expect(alert).not.toContainText('s3cr3t');
  await expect(alert).not.toContainText('serve update');
  await page.evaluate(standIn({ failed: 'refused', port: 0, token: '' }));
  await expect(alert).toContainText('The background service refused this window. Quit Nunchiro and open it again.');
  await page.evaluate(standIn({ failed: 'timeout', port: 0, token: '' }));
  await expect(alert).toContainText('The background service did not answer in time.');
  await page.evaluate(standIn({ failed: 'cli', port: 0, token: '' }));
  await expect(alert).toContainText('Nunchiro could not run its own command-line tool.');
  await page.evaluate(standIn({ failed: 'toString', port: 0, token: '' }));
  await expect(alert).toContainText(START_FAILED);
});

test('start_wait: the failure message follows the language setting', async ({ page }) => {
  await page.addInitScript((boot) => {
    localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ language: 'ko' }));
    (window as { __NUNCHIRO__?: unknown }).__NUNCHIRO__ = boot;
  }, failing);
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('Nunchiro가 백그라운드 서비스를 시작하거나 업데이트하지 못했습니다.');
});
