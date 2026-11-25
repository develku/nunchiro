// Ticket 1090: what the owner sees on the board. "Working" only where an agent runs a turn; finished work under day heads
// with older cards in an Archive fold in the view the board opens with and in the right-bar list (ticket 1066's rule,
// one implementation); a closed or replaced seat's own card leaves Decisions. A real core throughout.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, REPO, test } from './fixtures';
import { busyShell, openBoard, seed } from './fixtures/board/coord';
import { barEnd, drag, endEdit, icon, sidebar, startEdit } from './d5b';
import { openWindow } from './fixtures';

const SHOTS = path.join(REPO, '.scratch/shots');
const shot = async (app: Page, name: string) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  await app.screenshot({ path: path.join(SHOTS, `board-truth-1090-${name}.png`) });
};

// The owner's board opens in its default view (the watch view): the suite's columns-view seam is cleared.
test.beforeEach(async ({ app }) => {
  await app.addInitScript(() => localStorage.removeItem('nunchiro.test.board-mode'));
});

test('board_working_is_a_turn: only a card whose seat is in a turn says Working; a stopped or seatless card waits', async ({ app, core }) => {
  const p = core.project('demo');
  const busy = busyShell(core, p, 'busy'); // in a turn: its prompt went out, no Stop came
  const quiet = core.shell(p, 'quiet'); // running, never in a turn (before 1090 the core called it working)
  seed(core, [
    { id: 'b1', title: 'Busy task', column: 'working', attachments: [{ session_id: busy.id, role: 'build' }] },
    { id: 'q1', title: 'Stopped task', column: 'working', attachments: [{ session_id: quiet.id, role: 'build' }] },
    { id: 'o1', title: 'Seatless task', column: 'working' },
  ]);
  const board = await openBoard(app, core);
  await expect(board).toHaveAttribute('data-mode', 'watch');
  // One agent runs a turn, so one card says Working, and the head counts one.
  await expect(board.locator('.wcol[data-bucket="working"] .wtt')).toHaveText(['Busy task']);
  await expect(board.locator('.wch[data-bucket="working"] .bcount')).toHaveText('1');
  expect((await board.locator('.wcol[data-bucket="next"] .wtt').allInnerTexts()).sort()).toEqual(['Seatless task', 'Stopped task']);
  await shot(app, 'working');
});

// Tickets 1091, 1092: a seat opened and not yet used sits in the neutral column (To do, no state): never Review, Done
// or Working (columns view, in cards and in list density).
for (const density of ['cards', 'list']) {
  test(`board_fresh_seat_waits_${density}: a seat with no turn is in To do, not under Review, Done or Working`, async ({ app, core }) => {
    core.agent(core.project('demo'), 'fresh seat', 'never'); // the fixture's fake agent: running, no turn
    await app.addInitScript(() => localStorage.setItem('nunchiro.test.board-mode', 'columns'));
    const zone = await (await openBoard(app, core)).getAttribute('data-zone');
    await app.evaluate(([z, d]) => localStorage.setItem(`nunchiro.board.view.${z}`, JSON.stringify({ mode: 'columns', density: d, filters: { you: false } })), [zone, density]);
    await app.reload();
    await app.mouse.move(2, 2);
    if (density === 'list') {
      // The list says each row's column in words.
      await expect(app.locator('.board .bli').filter({ hasText: 'fresh seat' }).locator('.blcol')).toHaveText('To do');
      await expect(app.locator('.board .bli').filter({ hasText: 'fresh seat' }).locator('.bdot[data-s="review"]')).toHaveCount(0);
    } else {
      const cell = (id: string) => app.locator(`.board .bcell[data-column="${id}"]`);
      await expect(cell('todo')).toContainText('fresh seat');
      await expect(cell('review')).not.toContainText('fresh seat');
      await expect(app.locator('.board .bdot[data-s="review"]')).toHaveCount(0);
      await expect(cell('done')).not.toContainText('fresh seat');
      await expect(cell('working')).not.toContainText('fresh seat');
    }
    await shot(app, `fresh-seat-${density}`);
  });
}

const MIN = 60_000;
function doneCards(core: Parameters<typeof seed>[0]) {
  const sinceMidnight = Math.floor((Date.now() - new Date().setHours(0, 0, 0, 0)) / MIN);
  seed(core, [
    { id: 'a', title: 'Fresh card', column: 'done', moved: 1 },
    { id: 'b', title: 'Yesterday card', column: 'done', moved: sinceMidnight + 120 },
    { id: 'c', title: 'Three day card', column: 'done', moved: 3 * 1440 },
    { id: 'd', title: 'Ten day card', column: 'done', moved: 10 * 1440 },
    { id: 'n', title: 'Open card', column: 'todo' },
  ]);
}

test('board_done_days_default_view: the board as it opens shows finished work under day heads and older work in a closed Archive', async ({ app, core }) => {
  doneCards(core);
  const board = await openBoard(app, core);
  await expect(board).toHaveAttribute('data-mode', 'watch');
  const done = board.locator('.wcol[data-bucket="done"]:not([data-archive-cell])');
  await expect(done.locator('.bdh')).toHaveText(['Today', 'Yesterday', 'This week']);
  await expect(done.locator('.wtt')).toHaveText(['Fresh card', 'Yesterday card', 'Three day card']);
  await expect(board.locator('.wch[data-bucket="done"] .bcount')).toHaveText('3');
  const archive = board.locator('[data-archive]');
  await expect(archive.locator('summary')).toHaveText('Archive (1)');
  await expect(archive).not.toHaveAttribute('open', '');
  await shot(app, 'default-view');
  await archive.locator('summary').click();
  await expect(archive.locator('li')).toContainText(['Ten day card']);
});

test('board_fresh_seat_right_bar: the right-bar list shows a seat with no turn without a Review mark', async ({ app, core }) => {
  core.agent(core.project('demo'), 'fresh seat', 'never');
  await app.addInitScript(() => localStorage.setItem('nunchiro.board.view.right', '{"filters":{"you":false}}'));
  await openWindow(app, {}, core);
  await startEdit(app);
  await drag(app, icon(app, 'right', 'Board'), await barEnd(app, 'right'));
  await endEdit(app);
  const row = sidebar(app, 'right').locator('.board .blist .bli').filter({ hasText: 'fresh seat' });
  await expect(row).toHaveCount(1);
  await expect(row.locator('.bdot[data-s="review"]')).toHaveCount(0);
  await shot(app, 'fresh-seat-right-bar');
});

test('board_done_days_right_bar: the right-bar list shows finished work under day heads and older work in a closed Archive', async ({ app, core }) => {
  doneCards(core);
  // The right bar's saved view with "Your turn only" off: that filter shows only cards that wait on you, never done work.
  await app.addInitScript(() => localStorage.setItem('nunchiro.board.view.right', '{"filters":{"you":false}}'));
  await openWindow(app, {}, core);
  await startEdit(app);
  await drag(app, icon(app, 'right', 'Board'), await barEnd(app, 'right'));
  await endEdit(app);
  const list = sidebar(app, 'right').locator('.board .blist');
  await expect(list.locator('.bdh')).toHaveText(['Today', 'Yesterday', 'This week']);
  await expect(list.locator('.bli .bltt')).toHaveText(['Open card', 'Fresh card', 'Yesterday card', 'Three day card']);
  const archive = list.locator('[data-archive]');
  await expect(archive.locator('summary')).toHaveText('Archive (1)');
  await expect(archive).not.toHaveAttribute('open', '');
  await shot(app, 'right-bar');
});

test('decisions_seat_closed: a closed seat\'s stall card leaves Decisions; the seat that replaced it keeps its own', async ({ app, core }) => {
  const p = core.project('demo');
  const old = core.shell(p, 'Builder · old');
  const next = core.shell(p, 'Builder · new'); // the seat that replaced it
  // The core raises a stall card from a check-in (core-tested in sessions/tests.rs); here it is written into the queue store
  // while the core is stopped, in the core's own shape, so the real close path takes it away.
  core.run(['serve', 'stop']);
  const file = path.join(core.home, 'queue.json');
  const q = JSON.parse(fs.readFileSync(file, 'utf8'));
  const stall = (task: string, session: string, seat: string) => ({ id: `stall-${task}`, session_id: session, scope: 'owner', kind: 'owner', text: `task ${task} is stuck`, choices: [], sources: [], observed_at: Date.now() - MIN, actionable: true, reconciled: false, hook_event_id: null, owner: { type: 'stall', task, title: 'Add tax', place: p, seat } });
  q.owner = [...(q.owner ?? []), stall('t1', old.id, 'Builder · old'), stall('t2', next.id, 'Builder · new')];
  fs.writeFileSync(file, JSON.stringify(q));
  await core.restart();
  // The new core has a new window port and token.
  await app.addInitScript((boot) => {
    window.__NUNCHIRO__ = boot;
  }, core.boot());
  await openWindow(app, {}, core);
  await icon(app, 'right', 'Decisions').click();
  const decisions = sidebar(app, 'right');
  await expect(decisions.locator('[data-stall="t1"]')).toBeVisible();
  await expect(decisions.locator('[data-stall="t2"]')).toBeVisible();
  core.cli('session', 'close', old.id);
  // A stopped seat's close finishes after its 10 s undo window.
  await expect(decisions.locator('[data-stall="t1"]')).toHaveCount(0, { timeout: 25_000 });
  await expect(decisions.locator('[data-stall="t2"]')).toBeVisible();
  await shot(app, 'decisions');
});
