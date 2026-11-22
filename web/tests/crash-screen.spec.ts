// S3: a throw while the window draws, or before its first draw, shows a screen with a way back, never a white window.
// The test build's switch (CrashScreen.tsx `testCrash`, VITE_FEATURE_FIXTURES) throws where `window.__testCrash` says.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, openWindow, REPO, test } from './fixtures';
import { enable, freePort } from './web-access-shared';

const TITLE = 'This window hit a problem';

/** Throws at `where` until the test sets `crash-fixed`; copies are recorded (WebKit has no clipboard-write permission). */
const crashing = (page: Page, where: 'boot' | 'render' | null) =>
  page.addInitScript((where) => {
    const w = window as unknown as { __testCrash?: string; __copied: string[] };
    if (where && !sessionStorage.getItem('crash-fixed')) w.__testCrash = where;
    w.__copied = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t: string) => void w.__copied.push(t) } });
  }, where);

const screen = (page: Page) => page.getByRole('alert').filter({ hasText: TITLE });

test('a throw in the first draw shows the crash screen and Reload window brings the app back', async ({ app }) => {
  await crashing(app, 'render');
  await app.goto('/');
  await expect(screen(app)).toContainText('Your sessions keep running in the background service.');
  await app.evaluate(() => sessionStorage.setItem('crash-fixed', '1'));
  await app.getByRole('button', { name: 'Reload window' }).click();
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  await expect(screen(app)).toHaveCount(0);
});

test('a throw while drawing a live window shows the screen; Copy details copies the error and where it was thrown', async ({ app, core }) => {
  await crashing(app, null);
  await openWindow(app, {}, core);
  await app.evaluate(() => {
    (window as { __testCrash?: string }).__testCrash = 'render';
    window.dispatchEvent(new Event('nunchiro:test-crash'));
  });
  await expect(screen(app)).toBeVisible();
  await app.getByRole('button', { name: 'Copy details' }).click();
  await expect(app.getByRole('button', { name: 'Copied' })).toBeVisible();
  await expect(app.getByRole('button', { name: 'Copy details' })).toBeVisible(); // back after about 2 s
  const copied = await app.evaluate(() => (window as unknown as { __copied: string[] }).__copied);
  expect(copied).toHaveLength(1);
  expect(copied[0].split('Error: test crash (render)')).toHaveLength(2); // the message once, though Chromium's stack starts with it
  // The message, the browser's stack and React's component stack (names are minified in the build).
  expect(copied[0].split('\n\n')).toHaveLength(3);
});

test('a throw before the first draw (the boot hand-off) shows the same screen', async ({ app }) => {
  await crashing(app, 'boot');
  await app.goto('/');
  await expect(screen(app)).toBeVisible();
  await app.evaluate(() => sessionStorage.setItem('crash-fixed', '1'));
  await app.getByRole('button', { name: 'Reload window' }).click();
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
});

test('the browser role has the same screen', async ({ app, browser }) => {
  test.setTimeout(60_000);
  const port = await freePort();
  await enable(app, port);
  const context = await browser.newContext();
  const page = await context.newPage();
  await crashing(page, 'render');
  await page.goto(`http://127.0.0.1:${port}/`);
  await expect(screen(page)).toBeVisible();
  await context.close();
});

test('crash screen shots, light and dark', async ({ app, browserName }) => {
  test.skip(browserName !== 'chromium', 'shots are chromium only');
  const dir = path.join(REPO, '.scratch/shots');
  fs.mkdirSync(dir, { recursive: true });
  await crashing(app, 'render');
  for (const scheme of ['light', 'dark'] as const) {
    await app.emulateMedia({ colorScheme: scheme });
    await app.goto('/');
    await expect(screen(app)).toBeVisible();
    await app.screenshot({ path: path.join(dir, `crash-screen-${scheme}.png`) });
  }
});
