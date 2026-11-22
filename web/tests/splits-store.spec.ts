// SPLITS review SHOULDs (ticket 94): windows on one origin keep their own splits, and 📌 puts the widget in the zone the split was in.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, openWindow, REPO, test, type Core } from './fixtures';
import { drag, icon, readLayout, zone } from './d5b';

const STORE = 'nunchiro.splits.v1';
const agent = (core: Core, label: string) => core.agent(core.project(label), label, 'never-created');
const host = (page: Page) => page.locator('[data-split-host]');
const splits = (page: Page) => page.locator('[data-split-id]');
const stored = (page: Page) => page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? '{}'), STORE);
const open = async (page: Page, id: string) => {
  await page.locator(`button.row.wt2[data-menu-session="${id}"]`).click(); // ticket 570: each session here is in its own project, so not in the strip
  await expect(page.locator(`.chat[data-session="${id}"]`)).toBeVisible();
};
async function splitRight(page: Page, widget = 'Diff') {
  const b = (await host(page).boundingBox())!;
  await drag(page, icon(page, 'right', widget), { x: b.x + b.width - 30, y: b.y + b.height / 2 });
}
/** A second window of the same origin and storage, bound to the same core. */
async function secondWindow(page: Page, core: Core) {
  const w = await page.context().newPage();
  await w.addInitScript((boot) => {
    window.__NUNCHIRO__ = boot;
  }, core.boot());
  return w;
}

test('two_windows_keep_their_own_splits', async ({ app, core }) => {
  const a = agent(core, 'a');
  const b = agent(core, 'b');
  const other = await secondWindow(app, core);
  await openWindow(app, {}, core);
  await openWindow(other, {}, core);
  await open(app, a.id);
  await open(other, b.id);
  await splitRight(app);
  await expect(splits(app)).toHaveCount(1);
  await splitRight(other);
  await expect(splits(other)).toHaveCount(1);
  // The second window's write did not drop the first window's split.
  expect(Object.keys(await stored(app)).sort()).toEqual([a.id, b.id].sort());
  await app.reload();
  await open(app, a.id);
  await expect(splits(app)).toHaveCount(1);
  await other.reload();
  await open(other, b.id);
  await expect(splits(other)).toHaveCount(1);
  // Closing one window's split removes nothing from the other's.
  await splits(other).getByRole('button', { name: 'Close split' }).click();
  await expect(splits(other)).toHaveCount(0);
  expect(Object.keys(await stored(app))).toEqual([a.id]);
});

test('old_split_store_still_loads', async ({ app, core }) => {
  const a = agent(core, 'a');
  await openWindow(app, {}, core);
  // The merged format: session id -> [{ id, side, what }].
  await app.evaluate(([k, s]) => localStorage.setItem(k, JSON.stringify({ [s]: [{ id: 'old-1', side: 'down', what: 'diff' }] })), [STORE, a.id]);
  await app.reload();
  await open(app, a.id);
  await expect(splits(app)).toHaveCount(1);
  await expect(splits(app)).toHaveAttribute('data-side', 'down');
  await expect(splits(app).getByRole('button', { name: 'Keep in layout' })).toBeVisible();
});

test('pin_lands_where_the_split_was', async ({ app, core }) => {
  const a = agent(core, 'a');
  // A terminal pinned to another session sits first in the layout; the session view is still the `terminal` zone.
  await openWindow(app, {}, core);
  core.cli('layout', 'edge', 'left', 'terminal', '--pin', 'elsewhere');
  await expect(zone(app, 'terminal-2')).toBeVisible();
  await open(app, a.id);
  await splitRight(app);
  await splits(app).getByRole('button', { name: 'Keep in layout' }).click();
  await expect.poll(() => readLayout(core)).toMatch(/"diff"/);
  const diff = (await zone(app, 'diff').boundingBox())!;
  const main = (await zone(app, 'terminal').boundingBox())!;
  const first = (await zone(app, 'terminal-2').boundingBox())!;
  // Right of the session view, touching it; not beside the pinned terminal on the far left.
  expect(Math.abs(diff.x - (main.x + main.width))).toBeLessThan(2);
  expect(diff.x).toBeGreaterThan(first.x + first.width);
});

// Side-by-side for the owner (ticket 94): SPLITS_PIN_SHOTS=before|after writes ../.scratch/splits-pin/<name>-<tag>.png; skipped by default.
test('pin_before_after_shots', async ({ app, core }) => {
  const tag = process.env.SPLITS_PIN_SHOTS;
  test.skip(!tag, 'set SPLITS_PIN_SHOTS=before|after');
  const a = agent(core, 'a');
  await openWindow(app, {}, core);
  core.cli('layout', 'edge', 'left', 'terminal', '--pin', 'elsewhere');
  await expect(zone(app, 'terminal-2')).toBeVisible();
  await open(app, a.id);
  await splitRight(app);
  const dir = path.join(REPO, '.scratch/splits-pin');
  fs.mkdirSync(dir, { recursive: true });
  await app.screenshot({ path: path.join(dir, 'split.png') });
  await splits(app).getByRole('button', { name: 'Keep in layout' }).click();
  await app.waitForTimeout(800);
  await app.screenshot({ path: path.join(dir, `pinned-${tag}.png`) });
});
