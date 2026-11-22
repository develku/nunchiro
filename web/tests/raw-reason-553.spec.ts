// Ticket 553 (review raw-words-errors-551 r1): a refusal's raw reason is not only a tooltip. The sandbox line in the
// widget gallery and on a placed widget carries it as its accessible description (a screen reader hears it), and the
// pairing page shows an unknown refusal's own words under a Details line below the plain one.
import fs from 'node:fs';
import path from 'node:path';
import type { Rollup } from 'vite';
import { expect as pwExpect, test as pwTest } from '@playwright/test';
import { buildQuiet } from './vite-build';
import { expect, test } from './fixtures';
import { enable, freePort, phone } from './web-access-shared';

const WEB = path.resolve(import.meta.dirname, '..');
const HARNESS = '/__widgets-553/';
const RAW = 'sandbox-exec: No such file or directory (os error 2)';

pwTest.describe('raw reason on widget lines', () => {
  pwTest.beforeAll(async () => {
    const out = await buildQuiet({
      configFile: path.join(WEB, 'vite.config.ts'),
      root: WEB,
      base: HARNESS,
      logLevel: 'silent',
      build: { write: false, rollupOptions: { input: path.join(WEB, 'tests/widgets-lang-harness.html') } },
    });
    for (const o of (Array.isArray(out) ? out : [out as Rollup.RollupOutput]).flatMap((r) => ('output' in r ? r.output : []))) {
      const dest = path.join(WEB, 'dist', HARNESS, o.fileName);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(`${dest}.${process.pid}`, o.type === 'chunk' ? o.code : o.source);
      fs.renameSync(`${dest}.${process.pid}`, dest);
    }
  });

  pwTest('raw_reason_widgets_553: the gallery and a placed widget describe the sandbox line with the raw reason', async ({ page }) => {
    await page.goto(`${HARNESS}tests/widgets-lang-harness.html?lang=en&case=unavailable`);
    const gallery = page.locator('.ugal .ugal-off[title]');
    await pwExpect(gallery).toHaveAccessibleDescription(RAW);
    await pwExpect(gallery).not.toContainText('sandbox-exec', { useInnerText: true });
    const placed = page.locator('[data-user-widget="ok"] .uw-err');
    await pwExpect(placed).toHaveAccessibleDescription(RAW);
    await pwExpect(placed).not.toContainText('sandbox-exec', { useInnerText: true });
  });
});

test('raw_reason_pairing_553: an unknown pairing refusal keeps the plain line and shows its own words under Details', async ({ app, browser }) => {
  const port = await freePort();
  await enable(app, port);
  const { page } = await phone(browser, `http://127.0.0.1:${port}/`);
  await page.route('**/pair', (route) =>
    route.request().method() === 'POST' ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'could not save the pairing: disk I/O' }) }) : route.fallback(),
  );
  await page.getByRole('button', { name: 'Pair' }).click();
  const alert = page.getByRole('alert');
  await expect(alert).toContainText('That did not work.');
  await alert.getByText('Details').click();
  await expect(alert).toContainText('could not save the pairing: disk I/O');
  await page.context().close();
});
