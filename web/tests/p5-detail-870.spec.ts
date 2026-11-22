// Ticket 870 (scorecard P5): the board in a Korean window has no English left. The lane segment, the filter chips, the
// Done column's proof badge, the waits-on line and the view options were English words in the ko table. Card and column
// titles are the user's own data (board.json / board.toml) and stay as written.
import fs from 'node:fs';
import path from 'node:path';
import { english } from './fixtures/ui-scan';
import { expect, openWindow, test } from './fixtures';
import { FIVE, seed } from './fixtures/board/coord';
import { en, ko } from '../src/i18n/areas/board';
import { en as layout } from '../src/i18n/areas/rest-layout';

// Kept as written in every language: product names, git terms (PR, sha), and file or key names the user types in board.toml.
const KEEP = new Set(['CLI', 'PR', 'herdr', 'sha', 'board', 'toml', 'proof', 'true']);
const words = (v: string) => (v.replace(/\{[^}]*\}/g, '').match(/[A-Za-z]{2,}/g) ?? []).filter((w) => !KEEP.has(w));

test('board_ko_table_has_no_english_870: every Korean board line is Korean, apart from names kept on purpose', () => {
  const left = Object.entries(ko).filter(([k, v]) => k in en && words(v).length).map(([k, v]) => `${k}: ${v}`);
  expect(left).toEqual([]);
});

test('board_ko_window_has_no_english_870: the Korean board shows no English outside card and column titles', async ({ app, core }) => {
  seed(core, [
    { id: '1', title: '릴리스 노트 쓰기', column: 'todo', group: '다듬기' },
    { id: '2', title: '아이콘 고르기', column: 'working', waits_on: ['1'] },
    { id: '3', title: '토큰 정리', column: 'done', receipt: { sha: 'abc1234', command: '테스트', result: '통과' } },
  ]);
  await app.addInitScript(() => localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ ...JSON.parse(localStorage.getItem('nunchiro.settings.v1') ?? '{}'), language: 'ko' })));
  await app.goto('/');
  await expect(app.locator('html')).toHaveAttribute('lang', 'ko');
  await app.locator('.ib.r .aiw[data-icon="board"] button').click();
  const board = app.locator('.board');
  await expect(board.locator('.bcard')).toHaveCount(3);
  await expect(board.locator('.bstrip')).toContainText(ko['board.lane.by.group']);
  const titles = FIVE.map((c) => c.title);
  const left = (await english(app)).filter((w) => !titles.some((t) => w.endsWith(`(${t})`)) && !/\(abc1234/.test(w));
  expect(left).toEqual([]);
});

// The widget library: a widget whose widget.toml is broken says to fix the file, offers no approval it cannot take, and
// is not counted among the widgets waiting for approval.
test('broken_widget_says_fix_the_file_870: no Needs approval on a broken widget, and the line names the fix', async ({ app, core }) => {
  const make = (name: string, toml: string) => {
    const dir = path.join(core.home, 'widgets', name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'widget.toml'), toml);
    fs.writeFileSync(path.join(dir, 'run.sh'), 'echo hi\n');
  };
  make('broken', 'version = [');
  make('open-prs', 'version = 1\nkind = "script"\nauthor = "test"\ncommand = ["/bin/sh", "run.sh"]\n');
  await openWindow(app, {}, core);
  await app.locator('nav[data-bar="right"] .lay').click();
  const lib = app.getByRole('complementary', { name: 'Widget library' });
  await expect(lib.locator('.chip').last()).toHaveText(/1 to approve$/);
  await lib.locator('.chip').last().click();
  const broken = lib.locator('.lcard[data-card="widget:broken"]');
  await expect(broken).toContainText(layout['rest.layout.user.invalid']);
  await expect(broken.getByRole('button')).toHaveCount(0);
  await expect(lib.locator('.lcard[data-card="widget:open-prs"]').getByRole('button', { name: 'Needs approval' })).toBeVisible();
});
