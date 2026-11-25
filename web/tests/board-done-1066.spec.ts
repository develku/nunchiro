// Ticket 1066: the Done column shows recent cards under day heads; older ones go to an Archive fold. The cutoff and
// grouping are pure (tasks.ts); the page test seeds four done cards (today, yesterday, 3 and 10 days ago) in a real core.
import { expect, test } from './fixtures';
import { openBoard, seed } from './fixtures/board/coord';
import type { Card, Column } from '../src/board/model';
import { archivedIn, doneGroups, doneHead } from '../src/board/tasks';

const DAY = 86_400_000;
const NOW = new Date(2026, 10, 23, 15, 0).getTime(); // a Monday afternoon
const COLUMNS = [
  { id: 'todo', title: 'To do', states: [], needs_decision: false, proof: false },
  { id: 'done', title: 'Done', states: ['done'], needs_decision: false, proof: true },
] as Column[];
const done = (id: string, ago: number, column = 'done'): Card => ({ id, source: 'manual', title: id, note: '', session_id: null, project: null, column, state: null, stale: false, updated_at: 1, last_moved_at: NOW - ago });

test('done_cutoff_and_groups: the cutoff follows done_days; heads are today, yesterday, this week, earlier; newest first', () => {
  const cards = [done('three', 3 * DAY), done('today', 60_000), done('ten', 10 * DAY), done('yest', 15 * 3_600_000 + 60_000), done('open', 10 * DAY, 'todo')];
  for (const [days, kept] of [[1, ['today', 'yest']], [7, ['today', 'yest', 'three']], [30, ['today', 'yest', 'three', 'ten']]] as const) {
    const old = archivedIn(COLUMNS, days, NOW);
    expect(cards.filter((c) => !old(c)).filter((c) => c.column === 'done').map((c) => c.id), `${days} days`).toEqual(cards.filter((c) => kept.includes(c.id as never)).map((c) => c.id));
  }
  expect(archivedIn(COLUMNS, 7, NOW)(cards[4])).toBe(false); // a card outside Done never archives
  expect(doneGroups(cards.filter((c) => c.column === 'done'), NOW).map((g) => [g.head, g.cards.map((c) => c.id)])).toEqual([['today', ['today']], ['yesterday', ['yest']], ['week', ['three']], ['earlier', ['ten']]]);
  expect(doneHead(NOW + 5000, NOW)).toBe('today'); // a clock a little ahead is still today
  // A newer move into Done (last_moved_at) counts: the card that left and came back is not old.
  expect(archivedIn(COLUMNS, 7, NOW)({ ...done('back', 10 * DAY), last_moved_at: NOW - 1000 })).toBe(false);
  expect(archivedIn(COLUMNS, 7, NOW)({ ...done('core', 10 * DAY), done_at: NOW - 1000 })).toBe(false); // the core's done_at wins
});

test('done_archive_page: three under their heads, count 3, Archive (1) searches by receipt sha, lane progress 4/4, 30 days brings it back', async ({ app, core }) => {
  const sinceMidnight = Math.floor((Date.now() - new Date().setHours(0, 0, 0, 0)) / 60_000);
  const receipt = (sha: string) => ({ sha, command: 'cargo test', result: 'ok' });
  seed(core, [
    { id: 'a', title: 'Fresh card', column: 'done', moved: 1, receipt: receipt('aaaaaaa1') },
    { id: 'b', title: 'Yesterday card', column: 'done', moved: sinceMidnight + 120, receipt: receipt('bbbbbbb2') },
    { id: 'c', title: 'Three day card', column: 'done', moved: 3 * 1440, receipt: receipt('ccccccc3') },
    { id: 'd', title: 'Ten day card', column: 'done', moved: 10 * 1440, receipt: receipt('d3adb33f') },
  ]);
  await openBoard(app, core);
  const column = app.locator('.bcol[data-column="done"]');
  const cells = app.locator('.bcell[data-column="done"]:not([data-archive-cell])');
  await expect(column.locator('.bcount')).toHaveText('3');
  await expect(cells.locator('.bcard')).toHaveCount(3);
  await expect(cells.locator('.bdh')).toHaveText(['Today', 'Yesterday', 'This week']);
  await expect(cells.getByText('Ten day card')).toHaveCount(0);
  // Lane progress counts every done card, the archived one too.
  await expect(app.locator('.bpt').first()).toHaveText('4/4 done');
  const archive = app.locator('[data-archive]');
  await expect(archive.locator('summary')).toHaveText('Archive (1)');
  await expect(archive).not.toHaveAttribute('open', '');
  await archive.locator('summary').click();
  await expect(archive.locator('li')).toContainText(['Ten day card']);
  await archive.getByRole('searchbox').fill('nothing here');
  await expect(archive.locator('li')).toHaveText('No archived card matches.');
  await archive.getByRole('searchbox').fill('d3adb33f');
  await expect(archive.locator('li')).toHaveCount(1);
  await expect(archive.locator('li')).toContainText('Ten day card');
  // The edit panel's setting: 30 days brings the fourth back under Earlier.
  await app.locator('.bpen').click();
  await app.locator('.bep select').selectOption('30');
  await expect(column.locator('.bcount')).toHaveText('4');
  await expect(cells.locator('.bdh')).toHaveText(['Today', 'Yesterday', 'This week', 'Earlier']);
  await expect(app.locator('[data-archive]')).toHaveCount(0);
});
