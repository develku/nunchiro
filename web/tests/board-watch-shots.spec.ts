// V2.5-69 (ticket 289): the shots for the owner's review page, light and dark, before (the columns board, the old default) and
// after (the watch view, its detail, the view-options menu, project lanes, Korean). Written only when BOARD_WATCH_SHOTS=1,
// into .scratch/shots-v25-board-watch/ of this checkout.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, REPO, test, type Core } from './fixtures';
import { openBoard, seed } from './fixtures/board/coord';

const OUT = path.join(REPO, '.scratch/shots-v25-board-watch');
const BIN = path.join(REPO, 'target/debug/nunchiro');
test.skip(!process.env.BOARD_WATCH_SHOTS, 'shots only on request');
test.beforeEach(async ({ app }) => {
  await app.addInitScript(() => localStorage.removeItem('nunchiro.test.board-mode'));
  await app.setViewportSize({ width: 1440, height: 900 });
});

function populate(core: Core) {
  const alpha = core.project('alpha');
  const beta = core.project('beta');
  core.shell(alpha, 'parser-lane');
  const asks = core.agent(alpha, 'schema-review', 'go');
  const review = core.shell(beta, 'docs-lane', '/bin/sh', '-c', `printf '{}' | '${BIN}' hook UserPromptSubmit; printf '{}' | '${BIN}' hook Stop; exec cat`);
  core.shell(beta, 'old-run', '/bin/sh', '-c', 'exit 0');
  fs.writeFileSync(path.join(asks.cwd, 'go'), '');
  seed(core, [
    { id: 'n1', title: 'Wire the schema', column: 'todo', moved: 4 },
    { id: 'n2', title: 'Migrate settings', column: 'todo', moved: 12 },
    { id: 'n3', title: 'Pick the product name', column: 'needs-decision', moved: 7 },
    { id: 'd1', title: 'Ship the parser', column: 'done', moved: 125, attachments: [{ session_id: review.id, role: 'build' }], receipt: { sha: 'abc1234def', command: 'cargo test', result: '412 passed' } },
  ]);
  for (const [id, note] of [['n1', 'waits for the API lane'], ['n2', 'after the schema merges'], ['n3', 'two names tie']]) {
    const f = path.join(core.home, 'board.json');
    const b = JSON.parse(fs.readFileSync(f, 'utf8'));
    b.manual.find((c: { id: string }) => c.id === id).note = note;
    fs.writeFileSync(f, JSON.stringify(b));
  }
}

async function shot(page: Page, name: string, scheme: 'light' | 'dark') {
  await page.emulateMedia({ colorScheme: scheme });
  await page.mouse.move(2, 2);
  await page.waitForTimeout(400);
  fs.mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: path.join(OUT, `${name}-${scheme}.png`) });
}

for (const scheme of ['light', 'dark'] as const) {
  test(`shots ${scheme}`, async ({ app, core }) => {
    test.setTimeout(120_000);
    populate(core);
    // Before: the columns board, as the old default drew it.
    await app.addInitScript(() => localStorage.setItem('nunchiro.test.board-mode', 'columns'));
    const board = await openBoard(app, core);
    await expect(board.locator('.bcard').first()).toBeVisible({ timeout: 20_000 });
    await shot(app, 'before-columns', scheme);
    await app.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('nunchiro.board.view.')).forEach((k) => localStorage.removeItem(k)));
    await app.addInitScript(() => localStorage.removeItem('nunchiro.test.board-mode'));
    await app.evaluate(() => localStorage.removeItem('nunchiro.test.board-mode'));
    await expect.poll(() => fs.existsSync(path.join(core.home, 'layout.toml'))).toBe(true);
    await app.reload();
    await expect(app.locator('.board[data-mode="watch"] .wcard').first()).toBeVisible({ timeout: 20_000 });
    await expect(app.locator('.board .wcol[data-bucket="attention"] .wcard')).toHaveCount(2, { timeout: 20_000 });
    await shot(app, 'after-watch-lanes', scheme);
    await app.locator('.board').getByRole('button', { name: 'View options' }).click();
    await shot(app, 'after-view-options', scheme);
    await app.getByRole('menuitemradio', { name: 'Lanes: none' }).click();
    await app.keyboard.press('Escape');
    await shot(app, 'after-watch', scheme);
    await app.locator('.board .wcard').filter({ hasText: 'Ship the parser' }).click();
    await expect(app.getByRole('complementary', { name: 'Card detail' })).toBeVisible();
    await shot(app, 'after-detail', scheme);
    if (scheme === 'light') {
      await app.keyboard.press('Escape');
      await app.evaluate(() => localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ ...JSON.parse(localStorage.getItem('nunchiro.settings.v1') ?? '{}'), language: 'ko' })));
      await app.reload();
      await expect(app.locator('.board .wch b').first()).toHaveText('내 답 대기');
      await shot(app, 'after-korean', scheme);
    }
  });
}
