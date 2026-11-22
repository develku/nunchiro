// Ticket 407: the Board header's count is the cards its columns draw, and each session sits in the column of its state:
// working under Working, a quiet one idle (not Working), one that ended under Done. The age and the project tag keep a gap.
import type { Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { expect, REPO, test, type Core } from './fixtures';
import { bucketOf } from '../src/board/watch';
import type { Card, Column } from '../src/board/model';
import { status, type Session } from '../src/types';
import { busyShell, FIVE, openBoard, seed } from './fixtures/board/coord';

const BIN = path.join(REPO, 'target/debug/nunchiro');
const COLUMNS = FIVE as unknown as Column[];

test.beforeEach(async ({ app }) => {
  await app.addInitScript(() => localStorage.removeItem('nunchiro.test.board-mode'));
});

const card = (state: Card['state']): Card => ({ id: 's', source: 'session', title: 't', note: '', session_id: 's', project: null, column: 'working', state, stale: false, updated_at: 1 });
const live = (over: { working?: boolean; state?: Session['state']; agent_ended?: boolean; background?: boolean } = {}) =>
  ({
    id: 's',
    state: over.state ?? 'running',
    agent_ended: over.agent_ended ?? false,
    attention: { working: over.working ?? false, waiting: false, stale: false, failed: false, last_activity: 1 },
    pending: over.background ? [{ kind: 'background' }] : [],
  }) as unknown as Session;

test('board_state_to_column: working, idle, waiting and ended sessions map to their watch column', () => {
  // The core's state with the live session: the card state alone keeps its old meaning when no session is known.
  expect(bucketOf(card('working'), COLUMNS, live({ working: true }))).toBe('working');
  expect(bucketOf(card('working'), COLUMNS, live({ background: true }))).toBe('working');
  expect(status(live({ working: true, background: true }))).toBe('working'); // N12-S2-4: a background note is no "waiting"
  expect(bucketOf(card('working'), COLUMNS, live())).toBe('idle'); // a quiet session is idle, not Working
  expect(bucketOf(card('working'), COLUMNS)).toBe('working');
  expect(bucketOf(card('needs_decision'), COLUMNS, live())).toBe('attention');
  expect(bucketOf(card('review'), COLUMNS, live())).toBe('done'); // a finished turn not yet seen
  expect(bucketOf(card('done'), COLUMNS, live())).toBe('idle'); // a finished turn already seen, agent still there
  expect(bucketOf(card('done'), COLUMNS, live({ agent_ended: true }))).toBe('done'); // the agent quit, its shell stays
  expect(bucketOf(card('done'), COLUMNS, live({ state: 'exited' }))).toBe('done');
  expect(bucketOf(card('done'), COLUMNS, live({ state: 'resumable' }))).toBe('done');
  expect(bucketOf(card('done'), COLUMNS)).toBe('idle');
});

const header = async (app: Page) => Number((await app.locator('.board .bsummary .dim').innerText()).match(/\d+/)![0]);
const columnSum = async (app: Page, sel: string) => (await app.locator(sel).allInnerTexts()).reduce((n, x) => n + Number(x), 0);
const titlesIn = (app: Page, bucket: string) => app.locator(`.board .wcol[data-bucket="${bucket}"] .wcard .wtt`).allInnerTexts();

function populate(core: Core) {
  const p = core.project('demo');
  busyShell(core, p, 'busy');
  core.shell(p, 'quiet');
  core.shell(p, 'finished', '/bin/sh', '-c', `printf '{}' | '${BIN}' hook UserPromptSubmit; printf '{}' | '${BIN}' hook Stop; exec cat`);
  core.shell(p, 'gone', '/bin/sh', '-c', 'exit 0');
  const asks = core.agent(p, 'asks', 'go');
  fs.writeFileSync(path.join(asks.cwd, 'go'), '');
  seed(core, [{ id: 'q1', title: 'Queued lane', column: 'todo' }]);
}

test('board_header_count_matches_columns: the header counts what the columns draw, in both views and with Idle shown', async ({ app, core }) => {
  populate(core);
  const board = await openBoard(app, core);
  await expect(board).toHaveAttribute('data-mode', 'watch');
  await expect.poll(() => titlesIn(app, 'attention'), { timeout: 15_000 }).toEqual(['asks']);
  await expect.poll(() => titlesIn(app, 'working'), { timeout: 15_000 }).toEqual(['busy']);
  await expect.poll(() => titlesIn(app, 'done'), { timeout: 15_000 }).toEqual(expect.arrayContaining(['finished', 'gone']));
  await expect(board.locator('.wcard .wtt', { hasText: /^quiet$/ })).toHaveCount(0); // idle: hidden, and not under Working
  const counts = '.board .wch .bcount';
  expect(await header(app)).toBe(await columnSum(app, counts));
  expect(await header(app)).toBe(5); // asks, busy, Queued lane, finished, gone
  // Show idle draws the quiet session under Idle, and the header counts it too.
  await board.getByRole('button', { name: 'View options' }).click();
  await app.getByRole('menu', { name: 'View options' }).getByRole('menuitemcheckbox', { name: 'Show idle' }).click();
  await app.keyboard.press('Escape');
  await expect.poll(() => titlesIn(app, 'idle')).toEqual(['quiet']);
  expect(await header(app)).toBe(6);
  expect(await header(app)).toBe(await columnSum(app, counts));
  // The columns view: every card has a column, and the header still is their sum.
  await board.getByRole('button', { name: 'View options' }).click();
  await app.getByRole('menu', { name: 'View options' }).getByRole('menuitemradio', { name: 'View: columns' }).click();
  await expect(board).not.toHaveAttribute('data-mode', 'watch');
  await expect.poll(async () => (await header(app)) === (await columnSum(app, '.board .bch .bcount'))).toBe(true);
});

test('board_age_and_tag_keep_a_gap: the age text and the project tag box do not touch', async ({ app, core }) => {
  populate(core);
  const board = await openBoard(app, core);
  const meta = board.locator('.wcard .wmeta', { has: app.locator('.btag') }).first();
  await expect(meta).toBeVisible({ timeout: 15_000 });
  const gap = await meta.evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el.firstChild!); // the "kind · 6m" text before the tag
    return el.querySelector('.btag')!.getBoundingClientRect().left - range.getBoundingClientRect().right;
  });
  expect(gap).toBeGreaterThanOrEqual(3);
});
