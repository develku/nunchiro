// Keys page follow-ups (ticket 71): a key jump onto a row a filter hides clears the filters and says why, the area sections
// share one left edge at 1440x900 (needs 166: the two-column cards became one list), and the (e) "Sessions and startup" screenshot is retaken after load (KEYS_FU_SHOTS=1).
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, openWindow, test } from './fixtures';

const TITLE = 'Open Diff (changes since the session started)';
const settings = (app: Page) => app.getByRole('navigation', { name: 'Settings pages' });

async function openKeys(app: Page) {
  await app.getByRole('button', { name: 'Settings', exact: true }).click();
  await settings(app).getByRole('button', { name: 'Keyboard' }).click();
  return app.locator('[data-keys-list]');
}

// The event the old key map's key click dispatched (kept on the list, needs 166), sent directly so the filter state is the only variable.
const jump = (app: Page, id: string) => app.evaluate((i) => window.dispatchEvent(new CustomEvent('nunchiro:keys.jump', { detail: i })), id);
const status = (app: Page) => app.getByRole('status').filter({ hasText: /^Cleared the search/ });

test('key_jump_on_filtered_row_says_why: a search that hides the row is cleared and the status line names the row', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await openKeys(app);
  const search = app.getByRole('searchbox', { name: 'Search actions or keys' });
  await search.fill('Go to the next tab');
  const row = app.locator('tr[data-command="diff.open"]');
  await expect(row).toHaveCount(0);
  await jump(app, 'diff.open');
  await expect(status(app)).toHaveText(`Cleared the search to show ${TITLE}.`);
  await expect(search).toHaveValue('');
  await expect(row).toHaveAttribute('data-jump', 'true');
  const r = await new AxeBuilder({ page: app }).include('.kbar').analyze();
  expect(r.violations).toEqual([]);
});

test('key_jump_clears_pressed_key_filter: a pressed-key filter that hides the row is cleared too', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await openKeys(app);
  await app.getByRole('button', { name: 'Record' }).click();
  await app.keyboard.press('KeyN'); // `prefix n` is Go to the next tab, so Diff is hidden
  const row = app.locator('tr[data-command="diff.open"]');
  await expect(app.getByRole('button', { name: 'Clear the key' })).toBeVisible();
  await expect(row).toHaveCount(0);
  await jump(app, 'diff.open');
  await expect(status(app)).toHaveText(`Cleared the search to show ${TITLE}.`);
  await expect(app.getByRole('button', { name: 'Clear the key' })).toHaveCount(0);
  await expect(row).toHaveAttribute('data-jump', 'true');
});

test('key_jump_without_filter_is_silent: no filter, no status line', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await openKeys(app);
  await jump(app, 'diff.open');
  await expect(app.locator('tr[data-command="diff.open"]')).toHaveAttribute('data-jump', 'true');
  await expect(status(app)).toHaveCount(0);
});

test('keys_one_column_list_confirmed: at 1440x900 every area section starts at one x position (the two-column cards of needs 104 are one list, needs 166)', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await app.setViewportSize({ width: 1440, height: 900 });
  const keys = await openKeys(app);
  await expect(keys.locator('section.karea').first()).toBeVisible();
  const boxes = await keys.locator('section.karea').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().toJSON()));
  expect(new Set(boxes.map((b) => Math.round(b.x))).size, `boxes: ${JSON.stringify(boxes.map((b) => [Math.round(b.x), Math.round(b.width)]))}`).toBe(1);
});
