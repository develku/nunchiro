// V2.5-82 (ticket 297 items 1-3): the shots for the REPORT's mockup-vs-app page: the watch view with a card's subagents open, its
// detail at the default width, resized, maximised, in light and dark. Written only when BOARD_WATCH_FU_SHOTS=1, into
// .scratch/shots-v25-board-watch-fu/ of this checkout.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, REPO, test } from './fixtures';
import { openBoard, overlay, seed } from './fixtures/board/coord';

const OUT = path.join(REPO, '.scratch/shots-v25-board-watch-fu');
test.skip(!process.env.BOARD_WATCH_FU_SHOTS, 'shots only on request');
test.beforeEach(async ({ app }) => {
  await app.addInitScript(() => localStorage.removeItem('nunchiro.test.board-mode'));
  await app.setViewportSize({ width: 1440, height: 900 });
});

async function shot(page: Page, name: string, scheme: 'light' | 'dark') {
  await page.emulateMedia({ colorScheme: scheme });
  await page.mouse.move(2, 2);
  await page.waitForTimeout(500);
  fs.mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: path.join(OUT, `${name}-${scheme}.png`) });
}

for (const scheme of ['light', 'dark'] as const) {
  test(`shots ${scheme}`, async ({ app, core }) => {
    test.setTimeout(120_000);
    const p = core.project('alpha');
    const lead = core.agent(p, 'parser-lane', 'x');
    core.shell(p, 'docs-lane');
    seed(core, [
      { id: 'n1', title: 'Wire the schema', column: 'todo', moved: 4 },
      { id: 'n3', title: 'Pick the product name', column: 'needs-decision', moved: 7 },
      { id: 'd1', title: 'Ship the parser', column: 'done', moved: 125, receipt: { sha: 'abc1234def', command: 'cargo test', result: '412 passed' } },
    ]);
    await overlay(app, {
      ops: {
        subagents: (r) => ({
          kids: r.id === lead.id
            ? [
                { id: 'k1', label: 'Explore: find ssh -G callers', state: 'working', started_at: Math.floor(Date.now() / 1000) - 90 },
                { id: 'k2', label: 'Plan: page layout', state: 'done' },
              ]
            : [],
        }),
      },
    });
    const board = await openBoard(app, core);
    await expect(board.locator('.wcard').first()).toBeVisible({ timeout: 20_000 });
    await app.getByRole('button', { name: /^\d+ subagents?$/ }).click();
    await shot(app, 'watch-subagents', scheme);
    await app.locator('.board .wcard', { hasText: 'Ship the parser' }).click();
    await expect(app.getByRole('complementary', { name: 'Card detail' })).toBeVisible();
    await app.waitForTimeout(500);
    await shot(app, 'detail', scheme);
    const edge = app.getByRole('separator', { name: 'Resize the card detail' });
    const box = (await edge.boundingBox())!;
    await app.mouse.move(box.x + 2, box.y + 300);
    await app.mouse.down();
    await app.mouse.move(box.x - 200, box.y + 300, { steps: 8 });
    await app.mouse.up();
    await shot(app, 'detail-resized', scheme);
    await app.getByRole('button', { name: 'Maximise detail' }).click();
    await shot(app, 'detail-maximised', scheme);
  });
}
