// Ticket 871: the default board columns follow the window language. The store keeps the core's English titles; the
// window shows its own word while a column still holds its default title, and the stored title once it is renamed.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { openBoard } from './fixtures/board/coord';

const titles = (app: Page) => app.locator('.board .bch b').allInnerTexts();
async function setLanguage(app: Page, language: string) {
  await app.evaluate((l) => {
    const k = 'nunchiro.settings.v1';
    localStorage.setItem(k, JSON.stringify({ ...JSON.parse(localStorage.getItem(k) ?? '{}'), language: l }));
  }, language);
  await app.reload();
  await expect(app.locator('html')).toHaveAttribute('lang', language);
}

test('board_default_columns_follow_language: Korean and Japanese show their words, a renamed column keeps its title, the store stays English', async ({ app, core }) => {
  await openBoard(app, core);
  await expect.poll(() => titles(app)).toEqual(['To do', 'Working', 'Needs decision', 'Review', 'Done']);
  await setLanguage(app, 'ko');
  await expect.poll(() => titles(app)).toEqual(['할 일', '작업 중', '결정 필요', '검토', '완료']);
  // Rename Review in the edit panel (its field shows the shown word); only that column changes.
  await app.locator('.board').getByRole('button', { name: '보드 위젯 편집' }).click();
  const field = app.locator('[data-column-row="review"] > input');
  await expect(field).toHaveValue('검토');
  await field.fill('코드 검토');
  await field.press('Enter');
  await expect.poll(() => titles(app)).toEqual(['할 일', '작업 중', '결정 필요', '코드 검토', '완료']);
  // The store holds the English defaults and the one title the person wrote.
  const toml = fs.readFileSync(path.join(core.home, 'board.toml'), 'utf8');
  for (const t of ['To do', 'Working', 'Needs decision', 'Done', '코드 검토']) expect(toml).toContain(`title = "${t}"`);
  expect(toml).not.toContain('할 일');
  await app.keyboard.press('Escape');
  await setLanguage(app, 'ja');
  await expect.poll(() => titles(app)).toEqual(['やること', '作業中', '要判断', '코드 검토', '完了']);
});
