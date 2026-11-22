// Ticket 960 (scorecard P5, detail pass 2): one check per gap fixed in the Artifacts pane, the Preview's error lines,
// the board's watch detail and a web widget with a page. Each failed before its fix. Shots: p5-sweep-960-shots.spec.ts.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, REPO, test, type Core } from './fixtures';
import { seed } from './fixtures/board/coord';
import { gitChat, page1, PNG, savedImage, written } from './fixtures/artifacts-widget/helpers';
import { append, rec, test as chatTest } from './fixtures/chat/harness';
import { installWidgetHost } from './fixtures/web-widgets/host';

const BIN = path.join(REPO, 'target/debug/nunchiro');

async function korean(app: Page) {
  await app.addInitScript(() => localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ ...JSON.parse(localStorage.getItem('nunchiro.settings.v1') ?? '{}'), language: 'ko' })));
  await app.goto('/');
  await expect(app.locator('html')).toHaveAttribute('lang', 'ko');
  await expect(app.locator('.ib.r .aiw[data-icon="board"] button')).toBeVisible();
}

chatTest('artifacts_rows_speak_the_window_language_960', async ({ page, chatCore }) => {
  const s = gitChat(chatCore, 'rows', null);
  const img = savedImage(chatCore, s.id, PNG);
  append(s.file, rec.user(`봐줘\n${img}`), written(s, 'w1', 'notes.md', '# Notes'), written(s, 'g1', 'gone.html', page1('Gone')), rec.assistant('ok'));
  fs.rmSync(path.join(s.cwd, 'gone.html'));
  await korean(page);
  await page.locator(`.tab[data-tab="${s.id}"]`).click();
  await page.locator('.ib.r .aiw[data-icon="artifacts"] button').click();
  const rows = page.locator('.aw .awrow');
  await expect(rows).toHaveCount(3);
  // Before: "c414cd0e…png" and "attachment"; "markdown" in a box sized for "html"; "by agent".
  await expect(rows.nth(0).locator('.awn')).toHaveText('png 이미지');
  await expect(rows.nth(0).locator('.m')).toHaveText(/^첨부/);
  await expect(rows.nth(1).locator('.ic')).toHaveText('md');
  await expect(rows.nth(1).locator('.m')).toHaveText(/^에이전트 작성/);
  // Before: the missing row said only what happened.
  await expect(rows.nth(2).locator('button.it')).toHaveAccessibleDescription(/다시 작성해 달라고 하세요\.$/);
});

test('preview_error_lines_name_an_action_and_no_command_960', () => {
  const src = fs.readFileSync(path.join(REPO, 'web/src/i18n/areas/english-leftovers.ts'), 'utf8');
  // Before: "its artifact_open command is missing or failed" in all 8 languages.
  expect(src).not.toContain('artifact_open');
  for (const key of ['missing', 'outside', 'unavailable']) {
    const lines = src.split('\n').filter((l) => l.includes(`'leftovers.card.text.${key}': '`));
    expect(lines).toHaveLength(8);
    expect(lines[0]).toMatch(/(Ask the agent|Restart Nunchiro)/);
  }
});

function watchBoard(core: Core) {
  const beta = core.project('beta');
  const review = core.shell(beta, 'docs-lane', '/bin/sh', '-c', `printf '{}' | '${BIN}' hook UserPromptSubmit; printf '{}' | '${BIN}' hook Stop; exec cat`);
  seed(core, [{ id: 'd1', title: 'Ship the parser', column: 'done', moved: 125, attachments: [{ session_id: review.id, role: 'build' }] }]);
}

test('watch_detail_status_word_follows_language_960', async ({ app, core }) => {
  await app.addInitScript(() => localStorage.removeItem('nunchiro.test.board-mode'));
  watchBoard(core);
  await korean(app);
  await app.locator('.ib.r .aiw[data-icon="board"] button').click();
  await app.locator('.board .wcard').filter({ hasText: 'Ship the parser' }).click();
  const status = app.locator('.wdetail .wdr').first().locator('.wdv');
  // Before: "완료 · idle".
  await expect(status).toHaveText(/^완료 · \S/); // a Korean word of one or more parts (쉬는 중 since 22cc2f572)
  await expect(status).not.toContainText(/[A-Za-z]/);
});

test('web_widget_sheet_and_line_follow_language_960', async ({ app, core }) => {
  test.setTimeout(60_000);
  await installWidgetHost(app, core.home);
  const file = path.join(core.home, 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), web_widgets: true }));
  core.run(['serve', 'stop'], 10_000);
  await core.restart();
  await app.addInitScript((boot) => Object.assign(window.__NUNCHIRO__ ?? {}, boot), core.boot());
  const dir = path.join(core.home, 'widgets', 'w');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'widget.toml'), 'version = 1\nkind = "web"\nauthor = "test"\nentry = "index.html"\npermissions = ["read", "act"]\nnetwork = []\n');
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><p>hi</p>');
  core.shell(core.project('act'), 'target');
  await korean(app);
  core.cli('layout', ...'split right widget:w --zone terminal'.split(' '));
  // Before: the sheet was English in every window ("Page to show", "Allow read only").
  const sheet = app.getByRole('dialog');
  await expect(sheet).toContainText('표시할 페이지');
  await expect(sheet).not.toContainText('Page to show');
  await sheet.getByRole('button', { name: '읽기 전용 허용' }).click();
  // Before: "read only · actions are off for this widget".
  await expect(app.locator('[data-user-widget="w"] .ww-confirm')).toHaveText('읽기 전용 · 이 위젯은 보내기가 꺼져 있습니다');
});
