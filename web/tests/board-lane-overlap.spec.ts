// Ticket 447: in the watch view a project lane is as tall as its tallest column. Lanes of 5, 1 and 12 Done cards: no two
// cards in a column overlap, and each lane's head starts below the last card of the lane above, at full and narrow width.
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { openBoard, seed } from './fixtures/board/coord';

test.beforeEach(async ({ app }) => {
  await app.addInitScript(() => localStorage.removeItem('nunchiro.test.board-mode'));
});

const LANES = { alpha: 5, beta: 1, gamma: 12 };

const box = async (l: Locator) => (await l.boundingBox())!;

async function noOverlap(app: Page, board: Locator) {
  const done = board.locator('.wcol[data-bucket="done"]');
  await expect(done.locator('.wcard')).toHaveCount(18);
  const cards = await Promise.all((await done.locator('.wcard').all()).map(box));
  cards.sort((a, b) => a.y - b.y);
  for (let i = 1; i < cards.length; i++) expect(cards[i].y, `card ${i} starts below card ${i - 1}`).toBeGreaterThanOrEqual(cards[i - 1].y + cards[i - 1].height);
  const lanes = await board.locator('.wlane').evaluateAll((els) => els.map((e) => e.getAttribute('data-lane')!));
  expect(lanes).toHaveLength(3);
  for (let i = 0; i + 1 < lanes.length; i++) {
    const last = await box(done.and(app.locator(`[data-lane=${JSON.stringify(lanes[i])}]`)).locator('.wcard').last());
    const head = await box(board.locator(`.wlane[data-lane=${JSON.stringify(lanes[i + 1])}]`));
    expect(head.y, `${lanes[i + 1]} head below the last card of ${lanes[i]}`).toBeGreaterThanOrEqual(last.y + last.height);
  }
}

test('lane_as_tall_as_its_tallest_column: Done cards of adjacent project lanes do not overlap, full and narrow width', async ({ app, core }) => {
  const seeds = Object.entries(LANES).flatMap(([name, n]) => {
    const s = core.shell(core.project(name), `${name} shell`);
    return Array.from({ length: n }, (_, i) => ({ id: `${name}${i}`, title: `${name} done ${i}`, column: 'done', moved: i + 1, attachments: [{ session_id: s.id, role: 'build' }] }));
  });
  seed(core, seeds);
  const board = await openBoard(app, core);
  await expect(board).toHaveAttribute('data-mode', 'watch');
  for (const name of Object.keys(LANES)) await expect(board.locator('.wlane .blname', { hasText: name })).toBeVisible();
  await noOverlap(app, board);
  await app.setViewportSize({ width: 900, height: 700 });
  await noOverlap(app, board);
});
