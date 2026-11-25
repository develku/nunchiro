// v1b-18, spec Acceptance 12 in the window: driven by scripts/scenario/v1b-board-queue.sh, which starts a core,
// writes the cards and passes BOARD_LIVE. This records, on the page clock, when each board item (data-item
// `identity@updated_at`) first shows in the strip and in a tree row; the script compares with its own write times.
import fs from 'node:fs';
import { expect, test } from '@playwright/test';
import { windowAuth } from './fixtures';

const live = process.env.BOARD_LIVE ? (JSON.parse(process.env.BOARD_LIVE) as { home: string; seen: string; done: string; ready: string }) : null;

test('scenario: board decisions reach the strip and the tree row', { tag: '@live' }, async ({ page }) => {
  test.setTimeout(3_600_000);
  const L = live!;
  const boot = windowAuth(L.home);
  await page.addInitScript((b) => (window.__NUNCHIRO__ = b), boot);
  await page.goto('/');
  await expect(page.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  await expect(page.locator('.tree .grp')).toHaveCount(1);
  await page.evaluate(() => {
    const seen: { strip: Record<string, number>; tree: Record<string, number> } = { strip: {}, tree: {} };
    (window as { __seen?: typeof seen }).__seen = seen;
    const check = () => {
      const now = Date.now();
      for (const e of document.querySelectorAll<HTMLElement>('.qcard[data-kind="board"]')) seen.strip[e.dataset.item!] ??= now;
      for (const e of document.querySelectorAll<HTMLElement>('.tree .q[data-item]')) seen.tree[e.dataset.item!] ??= now;
    };
    new MutationObserver(check).observe(document.body, { subtree: true, childList: true, attributes: true });
  });
  fs.writeFileSync(L.ready, 'ready');
  // The pointer stays off the strip and tree, so neither holds its rows.
  await page.mouse.move(700, 300);
  while (!fs.existsSync(L.done)) {
    const seen = await page.evaluate(() => (window as { __seen?: unknown }).__seen);
    fs.writeFileSync(`${L.seen}.tmp`, JSON.stringify(seen));
    fs.renameSync(`${L.seen}.tmp`, L.seen);
    await page.waitForTimeout(50);
  }
  const seen = await page.evaluate(() => (window as { __seen?: unknown }).__seen);
  fs.writeFileSync(L.seen, JSON.stringify(seen));
});
