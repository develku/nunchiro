// V2.5-69 (ticket 289, needs 208): the Board as a watch view. Columns derive from state (Needs you, Working, Next, Done;
// Idle hidden), a card opens its detail in place, the toolbar is search, project and + Card, and the rest sits in the
// view-options menu. Real core, board.json seeds and real sessions; `overlay` only fakes what a test cannot make a core do.
import type { Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { expect, openWindow, REPO, test, type Core } from './fixtures';
import { bucketOf, BUCKETS, byRecent } from '../src/board/watch';
import type { Card, Column } from '../src/board/model';
import type { Session } from '../src/types';
import * as words from '../src/i18n/areas/board-watch';
import { busyShell, FIVE, openBoard, overlay, seed } from './fixtures/board/coord';
import { makeT } from '../src/i18n';

const BIN = path.join(REPO, 'target/debug/nunchiro');

// The shared fixture opens every spec in the columns view (the view the old default was); this spec is about the new default.
test.beforeEach(async ({ app }) => {
  await app.addInitScript(() => {
    localStorage.removeItem('nunchiro.test.board-mode');
  });
});

const col = (app: Page, bucket: string) => app.locator(`.board .wcol[data-bucket="${bucket}"]`);
const titlesIn = (app: Page, bucket: string) => col(app, bucket).locator('.wcard .wtt').allInnerTexts();
const cardOf = (app: Page, title: string) => app.locator('.board .wcard').filter({ has: app.locator('.wtt', { hasText: new RegExp(`^${title}$`) }) });
const detail = (app: Page) => app.getByRole('complementary', { name: 'Card detail' });
const selectedTab = (app: Page) => app.locator('.tab[aria-selected="true"]').innerText();
const toolbar = (app: Page) => app.locator('.board .bhead');
const viewOptions = (app: Page) => app.locator('.board').getByRole('button', { name: 'View options' });

function reviewSession(core: Core, project: string, label: string) {
  const script = `printf '{}' | '${BIN}' hook UserPromptSubmit; printf '{}' | '${BIN}' hook Stop; exec cat`;
  return core.shell(project, label, '/bin/sh', '-c', script);
}

/** busy (working), asks (needs decision), finished (turn done, unseen), gone (ended: Done, ticket 407) and two manual cards. */
function populate(core: Core) {
  const p = core.project('demo');
  busyShell(core, p, 'busy');
  const waiting = core.agent(p, 'asks', 'go');
  reviewSession(core, p, 'finished');
  core.shell(p, 'gone', '/bin/sh', '-c', 'exit 0');
  fs.writeFileSync(path.join(waiting.cwd, 'go'), '');
  return p;
}

const COLUMNS = FIVE as unknown as Column[];
const manual = (column: string, over: Partial<Card> = {}): Card => ({ id: 'm', source: 'manual', title: 't', note: '', session_id: null, project: null, column, state: null, stale: false, updated_at: 1, ...over });
const session = (state: Card['state'], over: Partial<Card> = {}): Card => ({ ...manual('working', over), source: 'session', id: 's', state });

test('board_watch_columns_from_state: the bucket is derived from the card state, with no manual columns', async ({ app, core }) => {
  // The rule, on its own (the table is the ticket's: Needs you, Working, Next, Done; Idle hidden).
  expect(BUCKETS).toEqual(['attention', 'working', 'next', 'done']);
  expect(bucketOf(session('needs_decision'), COLUMNS)).toBe('attention');
  expect(bucketOf(session('working'), COLUMNS)).toBe('working');
  expect(bucketOf(session('review'), COLUMNS)).toBe('done');
  expect(bucketOf(session('done'), COLUMNS)).toBe('idle');
  expect(bucketOf(manual('todo'), COLUMNS)).toBe('next');
  // Ticket 1090: a Working column alone is not work; only a seat in a turn makes a card Working.
  expect(bucketOf(manual('working'), COLUMNS)).toBe('next');
  expect(bucketOf(manual('working', { attachments: [{ session_id: 'w', role: 'build', label: 'w', state: 'working' }] }), COLUMNS)).toBe('working');
  expect(bucketOf(manual('needs-decision'), COLUMNS)).toBe('attention');
  expect(bucketOf(manual('review'), COLUMNS)).toBe('attention'); // a finished lane waiting for the receipt check waits on you
  // Look v9 B N-S3-4: a lead's task card follows the Team view: ready to merge (Review) waits on nobody; its open merge
  // card (the decision column) or an asking seat needs you.
  expect(bucketOf(manual('review', { task: 't1' }), COLUMNS)).toBe('done');
  expect(bucketOf(manual('needs-decision', { task: 't1' }), COLUMNS)).toBe('attention');
  expect(bucketOf(manual('review', { task: 't1', attachments: [{ session_id: 'w', role: 'build', label: 'w', state: 'needs_decision' }] }), COLUMNS)).toBe('attention');
  // Look 1117 v11 B N11-S3-2: a lead's task card works only while a seat works (Team view); a running lead whose turn ended is Idle.
  expect(bucketOf(manual('working', { task: 't1', attachments: [{ session_id: 'w', role: 'build', label: null, state: null }] }), COLUMNS)).toBe('idle');
  expect(bucketOf(manual('working', { task: 't1', attachments: [{ session_id: 'w', role: 'build', label: 'w', state: 'working' }] }), COLUMNS)).toBe('working');
  const lead = { state: 'running', teammate: 'lead-1' } as Session;
  expect(bucketOf(session('review'), COLUMNS, lead)).toBe('idle');
  expect(bucketOf(session('review'), COLUMNS, { ...lead, teammate: undefined, completion_seq: 1 })).toBe('done');
  expect(bucketOf(session('idle'), COLUMNS)).toBe('idle'); // ticket 1092: no turn yet is neutral
  expect(bucketOf(manual('done'), COLUMNS)).toBe('done');
  // A worker attached to a working card that asks puts the card under Needs you; a card in a column that is gone is Next.
  expect(bucketOf(manual('working', { attachments: [{ session_id: 'w', role: 'build', label: 'w', state: 'needs_decision' }] }), COLUMNS)).toBe('attention');
  expect(bucketOf(manual('vanished'), COLUMNS)).toBe('next');
  // A user-made column set derives the same way, by what each column claims, not by its title or place.
  const custom: Column[] = [
    { id: 'a', title: 'Ideas', states: [], needs_decision: false },
    { id: 'b', title: 'Mine', states: ['working'], needs_decision: false },
    { id: 'c', title: 'Ask', states: [], needs_decision: true },
    { id: 'd', title: 'Shipped', states: ['done'], needs_decision: false },
  ];
  // Ticket 1090: a column that claims working holds a card under Working only while one of its seats is in a turn.
  expect(['a', 'b', 'c', 'd'].map((c) => bucketOf(manual(c), custom))).toEqual(['next', 'next', 'attention', 'done']);
  // Orca's order inside a column: the card that moved last is on top.
  expect(byRecent([manual('todo', { id: '1', last_moved_at: 5 }), manual('todo', { id: '2', last_moved_at: 9 }), manual('todo', { id: '3', updated_at: 7 })]).map((c) => c.id)).toEqual(['2', '3', '1']);

  // In the window: four columns by name, each card where its state puts it, Idle not drawn, no column editing.
  populate(core);
  seed(core, [
    { id: 'q1', title: 'Queued lane', column: 'todo' },
    { id: 'q2', title: 'Shipped lane', column: 'done', receipt: { sha: 'abc1234', command: 'cargo test', result: '12 passed' } },
  ]);
  const board = await openBoard(app, core);
  await expect(board).toHaveAttribute('data-mode', 'watch');
  await expect(board.locator('.wch b')).toHaveText(['Needs you', 'Working', 'To do', 'Done']);
  await expect.poll(() => titlesIn(app, 'attention'), { timeout: 15_000 }).toEqual(['asks']);
  await expect.poll(() => titlesIn(app, 'working'), { timeout: 15_000 }).toEqual(['busy']);
  await expect.poll(() => titlesIn(app, 'next'), { timeout: 15_000 }).toEqual(['Queued lane']);
  await expect.poll(() => titlesIn(app, 'done'), { timeout: 15_000 }).toEqual(expect.arrayContaining(['finished', 'Shipped lane']));
  // Ticket 407: an agent that ended is finished work, under Done (no longer hidden as Idle).
  await expect.poll(() => titlesIn(app, 'done'), { timeout: 15_000 }).toContain('gone');
  await expect(col(app, 'idle')).toHaveCount(0);
  await expect(board.getByRole('button', { name: 'Columns' })).toHaveCount(0);
  await expect(board.locator('.badd')).toHaveCount(0);
  // The count in each header is the cards under it.
  await expect(app.locator('.board .wch[data-bucket="next"] .bcount')).toHaveText('1');
  // An empty column says so, in words.
  await expect(col(app, 'attention').locator('.wnone')).toHaveCount(0);
});

test('board_watch_next_card_from_the_agent_cli: a card an agent placed with --why shows its line under Next', async ({ app, core }) => {
  const p = core.project('demo');
  core.shell(p, 'lead');
  const out = core.cli('board', 'create', 'Wire the schema', '--why', 'waits for the API lane', '--json');
  expect(out.column).toBe('todo');
  const ask = core.cli('board', 'create', 'Pick the name', '--column', 'needs-you', '--why', 'two names tie', '--json');
  await openBoard(app, core);
  await expect(cardOf(app, 'Wire the schema').locator('.wnote')).toHaveText('waits for the API lane');
  await expect(col(app, 'next').locator('.wcard')).toHaveCount(1);
  await expect.poll(() => titlesIn(app, 'attention')).toEqual(['Pick the name']);
  await expect(cardOf(app, 'Pick the name').locator('.wnote')).toHaveText('two names tie');
  expect(ask.column).toBe('needs-decision');
});

test('watch_card_your_turn_hand (inventory N011): a task card under Needs you draws the your-turn hand, as the columns view and the tree row do; a Next card keeps its ring', async ({ app, core }) => {
  core.shell(core.project('demo'), 'lead');
  core.cli('board', 'create', 'Wire the schema', '--json');
  core.cli('board', 'create', 'Pick the name', '--column', 'needs-you', '--json');
  await openBoard(app, core);
  await expect.poll(() => titlesIn(app, 'attention')).toEqual(['Pick the name']);
  // It drew the bare idle ring: a task card has no state of its own, and the mark had no rule for its column.
  await expect(cardOf(app, 'Pick the name').locator('.wt .bdot[data-g="hand"]')).toHaveCount(1);
  await expect(cardOf(app, 'Pick the name').locator('.wt .st')).toHaveCount(0);
  await expect(cardOf(app, 'Wire the schema').locator('.wt .st')).toHaveAttribute('data-s', 'todo');
  await expect(cardOf(app, 'Wire the schema').locator('.wt .bdot')).toHaveCount(0);
});

test('card_click_opens_detail_in_place: the click shows the task, what was done, the outcome, the duration, the agent and the worktree, and stays on the Board', async ({ app, core }) => {
  const p = core.project('demo');
  const worker = core.shell(p, 'builder');
  seed(core, [
    { id: 'd1', title: 'Ship the parser', column: 'done', moved: 125, attachments: [{ session_id: worker.id, role: 'build' }], receipt: { sha: 'abc1234def', command: 'cargo test', result: '12 passed' } },
  ]);
  const board = await openBoard(app, core);
  const before = await selectedTab(app);
  await cardOf(app, 'Ship the parser').click();
  const panel = detail(app);
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('heading', { name: 'Ship the parser' })).toBeVisible();
  const row = (name: string) => panel.locator('.wdr').filter({ has: app.locator('.wdk', { hasText: new RegExp(`^${name}$`) }) });
  await expect(row('What was done')).toContainText('12 passed');
  await expect(row('Outcome')).toContainText('abc1234');
  await expect(row('Outcome')).toContainText('cargo test');
  await expect(row('Duration')).toContainText('2h');
  await expect(row('Agent')).toContainText('builder');
  await expect(row('Agent')).toContainText('shell');
  await expect(row('Worktree')).toContainText('demo');
  await expect(row('Project')).toContainText('demo');
  // Still on the Board: the session tab did not change, the grid is still there beside the panel.
  expect(await selectedTab(app)).toBe(before);
  await expect(board.locator('.wcol')).toHaveCount(4);
  await expect(board).toBeVisible();
  // The open card is marked.
  await expect(cardOf(app, 'Ship the parser')).toHaveAttribute('aria-expanded', 'true');
});

test('card_click_opens_detail_in_place: a card with no summary says so, and a session card shows its state', async ({ app, core }) => {
  const p = core.project('demo');
  busyShell(core, p, 'busy');
  seed(core, [{ id: 'n1', title: 'Bare card', column: 'todo' }]);
  await openBoard(app, core);
  await cardOf(app, 'Bare card').click();
  await expect(detail(app).locator('.wdr').filter({ hasText: 'What was done' })).toContainText('Nothing recorded yet');
  await expect(detail(app).getByRole('button', { name: 'Open session' })).toHaveCount(0); // no session to open
  await cardOf(app, 'busy').click();
  await expect(detail(app).getByRole('heading', { name: 'busy' })).toBeVisible();
  await expect(detail(app).locator('.wdr').filter({ hasText: 'Agent' })).toContainText('shell');
});

test('detail_open_session_button_jumps: Open session inside the detail is the one way to the session tab', async ({ app, core }) => {
  const p = core.project('demo');
  const a = core.shell(p, 'first');
  const b = core.shell(p, 'target');
  seed(core, [{ id: 'j1', title: 'Jump lane', column: 'working', attachments: [{ session_id: b.id, role: 'build' }] }]);
  await openWindow(app, {}, core);
  await app.locator(`.tab[data-tab="${a.id}"]`).click();
  await app.locator('.ib.r').getByRole('button', { name: /^Board( · |$)/ }).click();
  await app.mouse.move(2, 2);
  await expect(app.locator('.board')).toBeVisible();
  await cardOf(app, 'Jump lane').click();
  expect(await selectedTab(app)).toContain('first'); // opening the detail did not jump
  await detail(app).getByRole('button', { name: 'Open session' }).click();
  await expect(app.locator('.tab[aria-selected="true"]')).toContainText('target');
});

test('board_toolbar_minimal: the toolbar is search, project, + Card and View options, nothing of the old strip', async ({ app, core }) => {
  populate(core);
  const board = await openBoard(app, core);
  const bar = toolbar(app);
  await expect(bar.getByRole('textbox', { name: 'Search cards' })).toBeVisible();
  await expect(bar.getByRole('button', { name: 'All projects' })).toBeVisible();
  await expect(bar.getByRole('button', { name: '+ Card' })).toBeVisible();
  await expect(bar.getByRole('button', { name: 'View options' })).toBeVisible();
  // Exactly those four controls: no Columns, no pencil, no filter chips, no colour key, no Lanes segmented control.
  expect(await bar.locator('button, input, select, [role="button"]').count()).toBe(4);
  await expect(board.locator('.bstrip')).toHaveCount(0);
  await expect(board.locator('.bkey')).toHaveCount(0);
  await expect(board.getByRole('group', { name: 'Lanes' })).toHaveCount(0);
  await expect(board.getByRole('button', { name: 'Your turn only' })).toHaveCount(0);
  await expect(board.getByRole('button', { name: 'Columns' })).toHaveCount(0);
  // + Card still works and lands in Next.
  await board.getByRole('button', { name: '+ Card' }).click();
  const dialog = app.getByRole('dialog', { name: 'New card' });
  await dialog.getByLabel('Title').fill('From the toolbar');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(cardOf(app, 'From the toolbar')).toBeVisible();
  await expect.poll(() => titlesIn(app, 'next')).toContain('From the toolbar');
});

test('view_options_hold_lanes_and_filters: lanes, the filters, show idle and the colour key live in the menu; lanes by project only when more than one project shows', async ({ app, core }) => {
  const a = core.shell(core.project('alpha'), 'one');
  const b = core.shell(core.project('beta'), 'two');
  core.shell(core.project('alpha'), 'gone', '/bin/sh', '-c', 'exit 0');
  core.shell(core.project('alpha'), 'quiet');
  seed(core, [
    { id: 'l1', title: 'Alpha lane', column: 'todo', attachments: [{ session_id: a.id, role: 'build' }] },
    { id: 'l2', title: 'Beta lane', column: 'todo', moved: 30, attachments: [{ session_id: b.id, role: 'build' }] },
  ]);
  const board = await openBoard(app, core);
  // Two projects show: a lane per project by default.
  await expect(board.locator('.wlane')).toHaveCount(2);
  // The menu holds the lane choice, the filters, the idle toggle and the colour key.
  await viewOptions(app).click();
  const menu = app.getByRole('menu', { name: 'View options' });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitemradio', { name: 'Lanes: automatic' })).toHaveAttribute('aria-checked', 'true');
  for (const name of ['Lanes: by project', 'Lanes: none', 'View: columns']) await expect(menu.getByRole('menuitemradio', { name })).toBeVisible();
  for (const name of ['Your turn only', 'Only stale', 'Only receipt missing', 'Show idle']) await expect(menu.getByRole('menuitemcheckbox', { name })).toBeVisible();
  await expect(menu.getByRole('group', { name: 'State key' })).toBeVisible();
  // None draws no lane header; the cards stay.
  await menu.getByRole('menuitemradio', { name: 'Lanes: none' }).click();
  await expect(board.locator('.wlane')).toHaveCount(0);
  await expect(cardOf(app, 'Alpha lane')).toBeVisible();
  // Show idle adds the Idle column with the quiet session (the ended one is under Done, ticket 407); it is saved with the view.
  await menu.getByRole('menuitemcheckbox', { name: 'Show idle' }).click();
  await expect(col(app, 'idle').locator('.wtt')).toHaveText(['quiet']);
  // A filter narrows the cards: only the ones waiting on you, which is none of these.
  await menu.getByRole('menuitemcheckbox', { name: 'Your turn only' }).click();
  await expect(board.locator('.wcard')).toHaveCount(0);
  await menu.getByRole('menuitemcheckbox', { name: 'Your turn only' }).click();
  await expect(cardOf(app, 'Alpha lane')).toBeVisible();
  await app.keyboard.press('Escape');
  await app.reload();
  await expect(app.locator('.board')).toBeVisible();
  await expect(col(app, 'idle')).toHaveCount(1); // the view survived the reload
  // One project only (the project filter): automatic lanes draw none, "by project" draws it anyway.
  await app.locator('.board .bhead').getByRole('button', { name: 'All projects' }).click();
  await app.getByRole('option', { name: 'alpha' }).click();
  await expect(cardOf(app, 'Alpha lane')).toBeVisible();
  await expect(cardOf(app, 'Beta lane')).toHaveCount(0);
  await expect(app.locator('.board .wlane')).toHaveCount(0);
  await viewOptions(app).click();
  await app.getByRole('menuitemradio', { name: 'Lanes: by project' }).click();
  await expect(app.locator('.board .wlane')).toHaveCount(1);
});

test('view_options_hold_lanes_and_filters: the columns view stays one choice away, with its strip and Columns button', async ({ app, core }) => {
  core.shell(core.project('demo'), 'busy');
  const board = await openBoard(app, core);
  await viewOptions(app).click();
  await app.getByRole('menuitemradio', { name: 'View: columns' }).click();
  await expect(board).toHaveAttribute('data-mode', 'columns');
  await expect(board.locator('.bch b')).toHaveText(['To do', 'Working', 'Needs decision', 'Review', 'Done']);
  await expect(board.getByRole('group', { name: 'Lanes' })).toBeVisible();
  await expect(board.getByRole('button', { name: 'Columns' })).toBeVisible();
});

test('board_columns_follow_language: the four column names come from the app language, in all eight', async ({ app, core }) => {
  test.setTimeout(120_000);
  core.shell(core.project('demo'), 'busy');
  await openBoard(app, core);
  // v25f: the Board is a modal, not a place in layout.toml: the window keeps it open over a reload (sessionStorage).
  const tables = { en: words.en, ko: words.ko, ja: words.ja, 'zh-Hans': words.zhHans, 'zh-Hant': words.zhHant, es: words.es, fr: words.fr, pt: words.pt } as Record<string, Record<string, string>>;
  for (const [language, table] of Object.entries(tables)) {
    await app.evaluate((l) => localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ ...JSON.parse(localStorage.getItem('nunchiro.settings.v1') ?? '{}'), language: l })), language);
    await app.reload();
    await expect(app.locator('html')).toHaveAttribute('lang', language);
    await expect(app.locator('.board')).toBeVisible();
    const want = ['attention', 'working', 'next', 'done'].map((b) => table[`board.watch.col.${b}`]);
    await expect(app.locator('.board .wch b')).toHaveText(want);
    if (language === 'en') expect(want).toEqual(['Needs you', 'Working', 'To do', 'Done']);
    else if (language === 'ko') expect(want).toEqual(['내 답 대기', '진행 중', '할 일', '완료']);
    // One language per UI: an English window shows no Hangul in the column heads, a Korean one no English names.
    const heads = (await app.locator('.board .wch b').allInnerTexts()).join(' ');
    if (language === 'en') expect(heads).not.toMatch(/[가-힣]/);
    if (language === 'ko') expect(heads).not.toMatch(/Needs you|Working|To do|Done/);
  }
  // Every key exists in all eight languages and none is empty.
  const keys = Object.keys(words.en);
  for (const [language, table] of Object.entries(tables)) for (const k of keys) expect(table[k]?.trim(), `${language} ${k}`).toBeTruthy();
});

test('board_watch_basic_interactions: click, Enter, right-click menu, Esc and focus return on the card, the detail panel and the view-options menu', async ({ app, core }) => {
  const p = core.project('demo');
  const w = core.shell(p, 'builder');
  seed(core, [{ id: 'b1', title: 'Basic lane', column: 'working', attachments: [{ session_id: w.id, role: 'build' }] }]);
  const board = await openBoard(app, core);
  const card = cardOf(app, 'Basic lane');
  // Card: Enter opens the detail; Esc closes it and the focus is back on the card.
  await card.focus();
  await app.keyboard.press('Enter');
  await expect(detail(app)).toBeVisible();
  await app.keyboard.press('Escape');
  await expect(detail(app)).toHaveCount(0);
  await expect(card).toBeFocused();
  // Space opens it too; the panel's Close button closes it and returns to the card.
  await app.keyboard.press('Space');
  await expect(detail(app)).toBeVisible();
  await detail(app).getByRole('button', { name: 'Close' }).click();
  await expect(detail(app)).toHaveCount(0);
  await expect(card).toBeFocused();
  // Click opens; a second click on the same card keeps it open (it is a view, not a toggle you lose).
  await card.click();
  await expect(detail(app)).toBeVisible();
  // Right-click: the card's own menu with its actions; Open card opens the detail in place.
  await app.keyboard.press('Escape');
  await card.click({ button: 'right' });
  const menu = app.getByRole('menu').filter({ hasText: 'Open card' });
  await expect(menu).toBeVisible();
  await menu.getByRole('menuitem', { name: 'Open card' }).click();
  await expect(detail(app)).toBeVisible();
  await expect(detail(app).getByRole('heading', { name: 'Basic lane' })).toBeVisible();
  // A card with a hover name: the truncated title carries its full text.
  await expect(card.locator('.wtt')).toHaveAttribute('title', 'Basic lane');
  // View-options: click opens, Esc closes and returns to the button; Enter opens, arrows move, outside click closes.
  await app.keyboard.press('Escape');
  const trigger = viewOptions(app);
  await trigger.click();
  const options = app.getByRole('menu', { name: 'View options' });
  await expect(options).toBeVisible();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  const first = options.getByRole('menuitemradio').first();
  await expect(first).toBeFocused();
  await app.keyboard.press('ArrowDown');
  await expect(options.getByRole('menuitemradio').nth(1)).toBeFocused();
  await app.keyboard.press('ArrowUp');
  await expect(first).toBeFocused();
  await app.keyboard.press('Escape');
  await expect(options).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await app.keyboard.press('Enter');
  await expect(options).toBeVisible();
  await board.locator('.wch').first().click(); // outside
  await expect(options).toHaveCount(0);
  // The detail panel is a region named for what it shows, and it is reachable by keyboard from the card.
  await card.focus();
  await app.keyboard.press('Enter');
  await expect(detail(app)).toHaveAttribute('aria-label', 'Card detail');
});

test('board_detail_within_two_clicks: from the main view, the Board button then a card shows the detail', async ({ app, core }) => {
  busyShell(core, core.project('demo'), 'busy');
  await openWindow(app, {}, core);
  await app.locator('.ib.r').getByRole('button', { name: /^Board( · |$)/ }).click(); // click 1: the labelled Board control
  await app.mouse.move(2, 2);
  await cardOf(app, 'busy').click(); // click 2: the card
  await expect(detail(app)).toBeVisible();
  await expect(detail(app).getByRole('heading', { name: 'busy' })).toBeVisible();
});

test('board_watch_old_pins: the watch view keeps the done receipt fact and the PR outcome of a Done card', async ({ app, core }) => {
  const p = core.project('demo');
  const w = core.shell(p, 'builder');
  seed(core, [{ id: 'r1', title: 'Receipt lane', column: 'done', attachments: [{ session_id: w.id, role: 'build' }], receipt: { sha: 'feedbee0000', command: 'make check', result: 'ok' } }]);
  await overlay(app, {
    ops: { pr_chip: () => ({ type: 'pr_chip', chip: { url: 'https://github.com/o/r/pull/12', state: 'merged' } }) },
  });
  await openBoard(app, core);
  const card = cardOf(app, 'Receipt lane');
  await expect(card.locator('.wfact')).toContainText('feedbee');
  await card.click();
  await expect(detail(app).locator('.wdr').filter({ hasText: 'Outcome' })).toContainText('make check');
  await expect(detail(app).locator('[data-pr-state]')).toContainText('#12');
});

test('lane_count_plural: a lane header says "1 card" and "2 cards"; Korean as written; every language has both forms', async ({ app, core }) => {
  // The rule on its own: English picks by the number, Korean says the same either way, French counts 0 and 1 as one.
  const tables = { en: words.en, ko: words.ko, ja: words.ja, 'zh-Hans': words.zhHans, 'zh-Hant': words.zhHant, es: words.es, fr: words.fr, pt: words.pt } as never;
  const count = (lang: string, n: number) => makeT(lang as never, lang, tables)(n === 1 ? 'board.watch.cards.one' : ('board.watch.cards.other' as never), { n });
  expect([0, 1, 2, 11].map((n) => count('en', n))).toEqual(['0 cards', '1 card', '2 cards', '11 cards']);
  expect([1, 2].map((n) => count('ko', n))).toEqual(['카드 1개', '카드 2개']);
  expect([0, 1, 2].map((n) => count('fr', n))).toEqual(['0 carte', '1 carte', '2 cartes']);
  for (const [lang, table] of Object.entries(tables as unknown as Record<string, Record<string, string>>)) for (const k of ['board.watch.cards.one', 'board.watch.cards.other']) expect(table[k], `${lang} ${k}`).toContain('{n}');
  // In the window: one card in the alpha lane, two in beta; the header counts say it right, and so do the column counts.
  const a = core.shell(core.project('alpha'), 'one');
  const b = busyShell(core, core.project('beta'), 'two'); // ticket 1090: in a turn, so its card in Working says Working
  seed(core, [
    { id: 'p1', title: 'Alpha lane', column: 'todo', attachments: [{ session_id: a.id, role: 'build' }] },
    { id: 'p2', title: 'Beta lane', column: 'todo', moved: 30, attachments: [{ session_id: b.id, role: 'build' }] },
    { id: 'p3', title: 'Beta second', column: 'working', moved: 40, attachments: [{ session_id: b.id, role: 'build' }] },
  ]);
  const board = await openBoard(app, core);
  const lane = (name: string) => board.locator('.wlane').filter({ has: app.locator('.blname', { hasText: new RegExp(`^${name}$`) }) });
  await expect(lane('alpha')).toContainText('1 card');
  await expect(lane('alpha')).not.toContainText('1 cards');
  await expect(lane('beta')).toContainText('2 cards');
  await expect(board.locator('.wch[data-bucket="next"] .bcount')).toHaveAttribute('aria-label', '2 cards');
  await expect(board.locator('.wch[data-bucket="working"] .bcount')).toHaveAttribute('aria-label', '1 card');
  await expect(board.locator('.wch[data-bucket="done"] .bcount')).toHaveAttribute('aria-label', '0 cards');
});

test('B16 board_watch_card_starts_a_session: a task card with no session starts one from the card and from its detail; the form and the board name the column alike; hidden idle sessions are counted', async ({ app, core }) => {
  const p = core.project('demo');
  core.shell(p, 'quiet'); // a shell that ran no turn: Idle, hidden by default
  seed(core, [{ id: 'v1', title: 'Add VAT rounding', column: 'todo' }]);
  const board = await openBoard(app, core);
  await expect.poll(() => titlesIn(app, 'next')).toEqual(['Add VAT rounding']);
  // One name for the column: the bucket head says what the card form's Column says.
  await expect(board.locator('.wch[data-bucket="next"] b')).toHaveText('To do');
  await expect(board.locator('.bepfoot')).toContainText('Idle sessions hidden: 1');
  // The card itself offers the start.
  await expect(cardOf(app, 'Add VAT rounding').locator('..').getByRole('button', { name: 'Start session…' })).toBeVisible();
  await cardOf(app, 'Add VAT rounding').click();
  await expect(detail(app)).toContainText('No agent attached');
  await detail(app).getByRole('button', { name: 'Start session…' }).click();
  const dlg = app.getByRole('dialog', { name: 'New tab' });
  await expect(dlg).toBeVisible();
  await expect(dlg).toContainText('in demo');
});

test('watch_card_ref_and_waits_on: a task card shows its ref link and "waits on #id" as the columns card does (look v35 b S3-3)', async ({ app, core }) => {
  seed(core, [
    { id: '12', title: 'Base card', column: 'working' },
    { id: '14', title: 'Waiter', column: 'todo', ref: 'https://github.com/develku/nunchiro/issues/183', waits_on: ['12'] },
  ]);
  await app.addInitScript(() => {
    const w = window as unknown as { __opened: unknown[] };
    w.__opened = [];
    window.open = ((url: string) => (w.__opened.push(url), null)) as typeof window.open;
  });
  await openBoard(app, core);
  const cell = app.locator('.board .wcell').filter({ has: app.locator('.wtt', { hasText: /^Waiter$/ }) });
  await expect(cell.locator('.bwo')).toHaveText('waits on #12');
  await expect(cell.locator('.bwo')).toHaveAttribute('title', 'Base card');
  const ref = cell.getByRole('link', { name: /issues\/183/ });
  await expect(ref).toHaveText('issues/183');
  // The link sits outside the card's own button: a click opens the link, never the card's detail.
  await expect(cardOf(app, 'Waiter').locator('a')).toHaveCount(0);
  await app.screenshot({ path: path.join(REPO, `.scratch/shots/w108-s3-3-watch-ref-${test.info().project.name}.png`) });
  await ref.click();
  await expect(detail(app)).toHaveCount(0);
  await expect.poll(() => app.evaluate(() => (window as unknown as { __opened: unknown[] }).__opened)).toEqual(['https://github.com/develku/nunchiro/issues/183']);
});
