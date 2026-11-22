// V2.5-38 (ticket 186, needs 155 draft B): each board widget's saved view (visible card fields, lane key, filters,
// density) set from the pencil's edit panel, kept with the widget's zone in window storage (web/src/board/views.ts).
import fs from 'node:fs';
import path from 'node:path';
import { expect, openWindow, REPO, test } from './fixtures';
import { cardOf, openBoard, overlay, seed } from './fixtures/board/coord';
import { closeModal } from './settings-modal';
import { defaultView, parseView, RIGHT } from '../src/board/views';
import * as words from '../src/i18n/areas/board-words';
import { bar, barEnd, card, drag, endEdit, icon, sidebar, startEdit } from './d5b';
import type { Page } from '@playwright/test';

type Card = Record<string, unknown> & { attachments?: { session_id: string; state: string | null }[] };
const withState = (b: Record<string, unknown>, session: string, state: string) => ({ ...b, cards: (b.cards as Card[]).map((c) => ({ ...c, attachments: c.attachments?.map((a) => (a.session_id === session ? { ...a, state } : a)) })) });
const laneNames = (app: Page) => app.locator('.board .blh .blname').allInnerTexts();
const shownTitles = async (app: Page) => (await app.locator('.board .bcard .btt').allInnerTexts()).sort();

test('board_edit_fields_filters_lane_key: hidden fields leave the cards, lane key regroups, Your turn only and role narrow and clear', async ({ app, core }) => {
  const p = core.project('demo');
  const [opus, sonnet] = ['Opus', 'Sonnet'].map((l) => core.shell(p, l));
  seed(core, [
    { id: '12', title: 'Fields card', column: 'working', group: 'M1', ref: 'docs/tickets/183.md', attachments: [{ session_id: opus.id, role: 'build' }], receipt: { sha: '0123456789abcdef', command: 'cargo test', result: 'pass' } },
    { id: '14', title: 'Waiter', column: 'todo', group: 'M2', waits_on: ['12'], attachments: [{ session_id: sonnet.id, role: 'review' }] },
    { id: '10', title: 'Shipped', column: 'done', group: 'M1', attachments: [{ session_id: opus.id, role: 'build' }], receipt: { sha: 'fedcba9876543210', command: 'cargo test', result: 'pass' }, history: [{ actor: 'owner', kind: 'create', from: null, to: 'todo' }, { actor: 'coord', kind: 'move', from: 'review', to: 'done' }] },
  ]);
  await overlay(app, {
    board: (b) => withState(b, sonnet.id, 'needs_decision'),
    ops: { pr_chip: (r) => ({ type: 'pr_chip', chip: r.id === opus.id ? { state: 'merged', url: 'https://github.com/develku/nunchiro/pull/12', at: null } : null }) },
  });
  const board = await openBoard(app, core);
  const fields = cardOf(app, 'Fields card');
  const shipped = cardOf(app, 'Shipped');
  await expect(fields.locator('.bref')).toHaveText('docs/tickets/183.md');
  await expect(fields.locator('.bra')).toHaveCount(1);
  await expect(fields.locator('.brc')).toHaveText('0123456 · cargo test · pass');
  await expect(cardOf(app, 'Waiter').locator('.bwo')).toHaveText('waits on #12');
  await expect(shipped.locator('.bfact')).toBeVisible();
  // Draft B: project is off by default (the lane names it).
  await expect(fields.locator('.btag')).toHaveCount(0);

  await board.getByRole('button', { name: 'Edit board widget' }).click();
  const panel = app.getByRole('dialog', { name: 'Edit board widget' });
  const field = (name: string) => panel.getByRole('group', { name: 'Card fields' }).getByRole('checkbox', { name, exact: true });
  for (const name of ['ref', 'role · assignee', 'waits on', 'PR line', 'receipt']) await expect(field(name)).toBeChecked();
  await expect(field('project')).not.toBeChecked();
  await field('ref').uncheck();
  await expect(fields.locator('.bref')).toHaveCount(0);
  await field('PR line').uncheck();
  await expect(shipped.locator('.bfact')).toHaveCount(0);
  await field('role · assignee').uncheck();
  await expect(fields.locator('.bra')).toHaveCount(0);
  await field('waits on').uncheck();
  await expect(cardOf(app, 'Waiter').locator('.bwo')).toHaveCount(0);
  await field('receipt').uncheck();
  await expect(fields.locator('.brc')).toHaveCount(0);
  await field('project').check();
  await expect(fields.locator('.btag')).toHaveText('demo');
  // The other parts of the card stay.
  await expect(fields.locator('.bid')).toHaveText('#12');

  // Lane key: group (default) → none → project → role.
  await expect.poll(() => laneNames(app)).toEqual(['M2', 'M1']);
  const lanes = panel.getByRole('group', { name: 'Lane key' });
  await expect(panel.getByText('no group falls back to project lanes')).toBeVisible();
  await lanes.getByRole('button', { name: 'none' }).click();
  await expect(app.locator('.board .blh')).toHaveCount(0);
  await expect(app.locator('.board .bcard')).toHaveCount(3);
  await lanes.getByRole('button', { name: 'project' }).click();
  await expect.poll(() => laneNames(app)).toEqual(['demo']);
  await lanes.getByRole('button', { name: 'role' }).click();
  await expect.poll(() => laneNames(app)).toEqual(['review', 'build']);
  // The header strip shows the same choice: one view.
  await expect(app.locator('.board .bstrip').getByRole('button', { name: 'role' })).toHaveAttribute('aria-pressed', 'true');

  // Filters: Your turn only narrows to the card whose agent asks; role narrows by role; each clears.
  const filters = panel.getByRole('group', { name: 'Filters' });
  await filters.getByRole('button', { name: 'Your turn only' }).click();
  await expect.poll(() => shownTitles(app)).toEqual(['Waiter']);
  await filters.getByRole('button', { name: 'Your turn only' }).click();
  await expect.poll(() => shownTitles(app)).toEqual(['Fields card', 'Shipped', 'Waiter']);
  await filters.getByRole('button', { name: 'role: build' }).click();
  await expect.poll(() => shownTitles(app)).toEqual(['Fields card', 'Shipped']);
  await expect(filters.getByRole('button', { name: 'role: build' })).toHaveAttribute('aria-pressed', 'true');
  await filters.getByRole('button', { name: 'role: build' }).click();
  await expect.poll(() => shownTitles(app)).toEqual(['Fields card', 'Shipped', 'Waiter']);

  // The view outlives a reload.
  await app.reload();
  await expect.poll(() => laneNames(app)).toEqual(['review', 'build']);
  await expect(cardOf(app, 'Fields card').locator('.bref')).toHaveCount(0);
  await expect(cardOf(app, 'Fields card').locator('.btag')).toHaveText('demo');
});

test('board_edit_fields_filters_lane_key: the one-line list density lists the shown cards and keeps after reload', async ({ app, core }) => {
  seed(core, [
    { id: 'a1', title: 'First task', column: 'todo' },
    { id: 'b2', title: 'Second task', column: 'review' },
  ]);
  const board = await openBoard(app, core);
  await board.getByRole('button', { name: 'Edit board widget' }).click();
  const panel = app.getByRole('dialog', { name: 'Edit board widget' });
  await panel.getByRole('group', { name: 'Show as' }).getByRole('button', { name: 'one-line list' }).click();
  await panel.getByRole('button', { name: 'Done', exact: true }).click();
  const list = app.locator('.board').getByRole('list', { name: 'Cards' });
  await expect(list.locator('.bltt')).toHaveText(['First task', 'Second task']);
  await expect(list.locator('.blcol')).toHaveText(['To do', 'Review']);
  await expect(app.locator('.board .bepfoot')).toHaveText('Saved view: one-line list · group lanes');
  await app.reload();
  await expect(app.locator('.board').getByRole('list', { name: 'Cards' }).locator('.bltt')).toHaveText(['First task', 'Second task']);
  // A row opens its card, as a card does.
  await app.locator('.board .bli').first().click();
  await expect(app.getByRole('dialog', { name: 'Edit card' })).toBeVisible();
});

test('board_two_views_independent edge: storage that throws or holds garbage renders the zone default', async ({ app, core }) => {
  seed(core, [{ id: 'g1', title: 'Grouped', column: 'todo', group: 'M1' }]);
  await app.addInitScript(() => localStorage.setItem('nunchiro.board.view.centre', '{"lane":"sideways","density":7,"filters":"x","fields":[1]}'));
  const board = await openBoard(app, core);
  await expect.poll(() => laneNames(app)).toEqual(['M1']);
  await expect(board.locator('.bcard')).toHaveCount(1);
  await expect(cardOf(app, 'Grouped').locator('.bid')).toHaveText('#g1');
  // Storage that throws on every call: the board still renders its default view and a change still applies.
  const other = await app.context().newPage();
  await other.addInitScript((boot) => (window.__NUNCHIRO__ = boot), core.boot());
  await other.addInitScript(() => {
    const no = () => {
      throw new Error('storage blocked');
    };
    Storage.prototype.getItem = no;
    Storage.prototype.setItem = no;
    Storage.prototype.removeItem = no;
  });
  await other.goto('/');
  await expect(other.getByRole('dialog', { name: 'Settings' })).toBeVisible(); // v25f: with no sessions and storage that cannot say it ever started, the window opens the first-run Settings modal
  await closeModal(other);
  await other.locator('.ib.r').getByRole('button', { name: /^Board( · |$)/ }).click(); // each window opens its own Board modal
  // V2.5-69: the default view is the watch view now; a change still applies (View: columns shows the lanes by group).
  await expect(other.locator('.board[data-mode="watch"] .wcard')).toHaveCount(1);
  await other.locator('.board').getByRole('button', { name: 'View options' }).click();
  await other.getByRole('menuitemradio', { name: 'View: columns' }).click();
  await expect(other.locator('.board .blh .blname')).toHaveText(['M1']);
  await other.locator('.board .bstrip').getByRole('button', { name: 'none' }).click();
  await expect(other.locator('.board .blh')).toHaveCount(0);
  await other.close();
});

test('board_two_views_independent: views are kept per zone; the right bar defaults to Your turn only · one-line list · no lanes', () => {
  // Pure: the stored view of one zone never reads another's, and a broken value falls back per value.
  expect(defaultView(RIGHT)).toEqual({ mode: 'columns', watchLanes: 'auto', showIdle: false, lane: 'none', filters: { you: true, role: [], stale: false, missing: false, hideIdle: false }, fields: { ref: true, role: true, waits: true, pr: true, receipt: true, project: false }, density: 'list' });
  expect(defaultView('centre')).toMatchObject({ lane: 'group', density: 'cards', filters: { you: false } });
  expect(parseView('not json', RIGHT)).toEqual(defaultView(RIGHT));
  expect(parseView('[1,2]', 'centre')).toEqual(defaultView('centre'));
  expect(parseView(null, RIGHT)).toEqual(defaultView(RIGHT));
  const mixed = parseView('{"lane":"role","density":"bogus","filters":{"you":"yes","role":["build",3]},"fields":{"ref":false,"pr":"no"}}', RIGHT);
  expect(mixed).toEqual({ mode: 'columns', watchLanes: 'auto', showIdle: false, lane: 'role', density: 'list', filters: { you: true, role: ['build'], stale: false, missing: false, hideIdle: false }, fields: { ...defaultView(RIGHT).fields, ref: false }});
});

// Side by side (needs 155 draft B): the edit panel band and the right-bar list band next to the app, light and dark, with
// the computed styles of each promise's element. Output: docs/design/v25-board/ (make-page.py). Run with SHOTS=1.
const EDIT_PAIRS = [
  ['pencil (on)', '.sh .lx.on', '.bhead .bpen[aria-pressed="true"]'],
  ['panel', '.ep', '.bep'],
  ['panel header', '.eph', '.beph'],
  ['panel Done', '.eph .eb', '.beph .bepb'],
  ['group title', '.eg h4', '.beg h4'],
  ['column row', '.erow', '.bepcols li'],
  ['drag handle', '.erow .g', '.bgrip'],
  ['column mark', '.erow .s', '.bsw'],
  ['segment on', '.ep .seg span.on', '.bep .bseg [aria-pressed="true"]'],
  ['filter chip on', '.ep .fc.on', '.bep .bfc[aria-pressed="true"]'],
  ['toggle', '.tg', '.bep .btg:checked'],
  ['minutes', '.num', '.bnum'],
  ['footer', '.ep .foot', '.bep .bepfoot'],
] as const;
const LIST_PAIRS = [
  ['list header', '.wbar .eph', '.sbar .bnarrow .bhead'],
  ['active filter', '.wbar .eph .fc.on', '.bnarrow .bhead .bfc'],
  ['row your turn', '.wc.you', '.bli[data-you]'],
  ['row broken', '.wc.bad', '.bli[data-bad]'],
  ['row', '.wc:not(.you):not(.bad)', '.bli:not([data-you]):not([data-bad])'],
  ['row title', '.wc .wt', '.bltt'],
  ['row column', '.wcol', '.blcol'],
  ['saved view footer', '.wbar .foot', '.bnarrow > .bepfoot'],
] as const;
const PROPS = ['color', 'background-color', 'border-top-color', 'border-top-width', 'border-left-color', 'border-left-width', 'border-radius', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'font-size', 'font-weight', 'height', 'width'];

test('board edit draft B side by side', async ({ app, core }, info) => {
  test.skip(info.project.name !== 'chromium' || !process.env.SHOTS, 'run with SHOTS=1');
  test.setTimeout(120_000);
  const DESIGN = path.join(REPO, 'docs/design/v25-board');
  const p = core.project('nunchiro');
  const [opus, sonnet] = ['Opus', 'Sonnet'].map((l) => core.shell(p, l));
  seed(core, [
    { id: '15', title: 'Lane key default group?', column: 'needs-decision', group: 'V2.5-35 board', attachments: [{ session_id: opus.id, role: 'build' }] },
    { id: '18', title: 'Theme token cleanup · fail', column: 'review', receipt: { sha: 'a1b2c3d', command: 'pnpm typecheck', result: 'fail' } },
    { id: '11', title: 'receipt missing', column: 'review', attachments: [{ session_id: sonnet.id, role: 'review' }] },
    { id: '12', title: 'board.toml fields', column: 'working', group: 'V2.5-35 board', ref: 'tickets/183' },
  ]);
  await overlay(app, { board: (b) => withState(b, opus.id, 'needs_decision') });
  await app.setViewportSize({ width: 1580, height: 920 });
  const board = await openBoard(app, core);
  await board.getByRole('button', { name: 'Edit board widget' }).click();
  await app.mouse.move(2, 2);
  const draft = await app.context().newPage();
  await draft.setViewportSize({ width: 1620, height: 1300 });
  await draft.goto(`file://${path.join(DESIGN, 'draft-b.html')}`);
  const read = (el: Element, props: string[]) => Object.fromEntries(props.map((q) => [q, getComputedStyle(el).getPropertyValue(q)]));
  const rows: Record<string, unknown>[] = [];
  const measure = async (band: string, scheme: string, gold: ReturnType<Page['locator']>, pairs: readonly (readonly [string, string, string])[]) => {
    for (const [name, g, m] of pairs) {
      const gl = gold.locator(g).first();
      const ml = app.locator(m).first();
      rows.push({ band, scheme, name, gold: g, mine: m, expected: (await gl.count()) ? await gl.evaluate(read, PROPS) : null, observed: (await ml.count()) ? await ml.evaluate(read, PROPS) : null });
    }
  };
  for (const scheme of ['light', 'dark'] as const) {
    await app.emulateMedia({ colorScheme: scheme });
    await draft.evaluate((s) => (document.documentElement.dataset.theme = s), scheme);
    await app.waitForTimeout(300);
    await app.locator('.bep').screenshot({ path: path.join(DESIGN, `app-edit-${scheme}.png`) });
    await draft.locator('.mw').first().locator('.ep').screenshot({ path: path.join(DESIGN, `draft-edit-${scheme}.png`) });
    await measure('edit', scheme, draft.locator('.mw').first(), EDIT_PAIRS);
  }
  // The right-bar band: the Board icon placed on the right bar (Layout), its sidebar at the bar's default view.
  await app.getByRole('dialog', { name: 'Edit board widget' }).getByRole('button', { name: 'Done', exact: true }).click();
  await startEdit(app);
  await drag(app, icon(app, 'right', 'Board'), await barEnd(app, 'right'));
  await endEdit(app);
  const rightBoard = sidebar(app, 'right').locator('.board');
  await expect(rightBoard.locator('.bepfoot')).toHaveText('Saved view: Your turn only · one-line list · no lanes');
  await app.mouse.move(2, 2);
  for (const scheme of ['light', 'dark'] as const) {
    await app.emulateMedia({ colorScheme: scheme });
    await draft.evaluate((s) => (document.documentElement.dataset.theme = s), scheme);
    await app.waitForTimeout(300);
    const box = (await rightBoard.boundingBox())!;
    await app.screenshot({ path: path.join(DESIGN, `app-rightbar-${scheme}.png`), clip: { x: box.x, y: box.y, width: box.width, height: Math.min(box.height, 300) } });
    await draft.locator('.mw').nth(1).locator('.wbar').screenshot({ path: path.join(DESIGN, `draft-rightbar-${scheme}.png`) });
    await measure('rightbar', scheme, draft.locator('.mw').nth(1), LIST_PAIRS);
  }
  fs.writeFileSync(path.join(DESIGN, 'styles-edit.json'), JSON.stringify(rows, null, 1));
  await draft.close();
});

// V2.5-38 (draft B second band): the board placed on the right bar is a narrow widget with its own saved view.
test('board_right_bar_widget: placed on the right bar from its visible icon it shows Your turn only · one-line list · no lanes; removing it forgets that view', async ({ app, core }) => {
  const p = core.project('demo');
  const asker = core.shell(p, 'Asker');
  seed(core, [
    { id: 'y1', title: 'Asks you', column: 'needs-decision', attachments: [{ session_id: asker.id, role: 'build' }] },
    { id: 'n1', title: 'Quiet task', column: 'todo', group: 'M1' },
  ]);
  await overlay(app, { board: (b) => withState(b, asker.id, 'needs_decision') });
  // The Board modal first (the Board icon, v25f), on its own view: group lanes, cards.
  await openBoard(app, core);
  const centreBoard = app.locator('.ovl .board');
  const boardCommand = async () => (await app.keyboard.press('Control+Space'), await app.keyboard.press('KeyK')); // board.toggle
  await expect(centreBoard.locator('.bcard')).toHaveCount(2);
  await app.keyboard.press('Escape');
  // Layout, then the Board icon onto the right bar: it opens in the right sidebar.
  await startEdit(app);
  await drag(app, icon(app, 'right', 'Board'), await barEnd(app, 'right'));
  await endEdit(app);
  const right = sidebar(app, 'right').locator('.board');
  await expect(right).toHaveAttribute('data-zone', 'right');
  await expect(right.locator('.bepfoot')).toHaveText('Saved view: Your turn only · one-line list · no lanes');
  await expect(right.locator('.bli .bltt')).toHaveText(['Asks you']);
  await expect(right.locator('.bhead .bfc')).toHaveText(['Your turn only']);
  // The two views are independent: changing the modal's lane key leaves the right bar's view alone, after reload too.
  await boardCommand();
  await centreBoard.locator('.bstrip').getByRole('button', { name: 'none' }).click();
  await app.reload();
  await expect(sidebar(app, 'right').locator('.board .bepfoot')).toHaveText('Saved view: Your turn only · one-line list · no lanes');
  await expect(centreBoard.locator('.blh')).toHaveCount(0); // the reload keeps the modal open
  await expect(centreBoard.locator('.bcard')).toHaveCount(2);
  await app.keyboard.press('Escape');
  // A right-bar view change sticks to the right bar only.
  await sidebar(app, 'right').locator('.board').getByRole('button', { name: 'Edit board widget' }).click();
  await sidebar(app, 'right').getByRole('dialog', { name: 'Edit board widget' }).getByRole('group', { name: 'Filters' }).getByRole('button', { name: 'Your turn only' }).click();
  await sidebar(app, 'right').getByRole('dialog', { name: 'Edit board widget' }).getByRole('button', { name: 'Done', exact: true }).click();
  await expect(sidebar(app, 'right').locator('.board .bepfoot')).toHaveText('Saved view: one-line list · no lanes');
  await boardCommand();
  await expect(centreBoard.locator('.bcard')).toHaveCount(2);
  await app.keyboard.press('Escape');
  // The Board icon collapses the sidebar board like any bar widget.
  await icon(app, 'right', 'Board').click();
  await expect(sidebar(app, 'right')).toHaveCount(0);
  // Removed from the bar: its view is forgotten; placed again from the library it starts from the right-bar default.
  await startEdit(app);
  await bar(app, 'right').getByRole('button', { name: 'Remove Board from the right bar' }).click();
  expect(await app.evaluate(() => localStorage.getItem('nunchiro.board.view.right'))).toBeNull();
  await drag(app, card(app, 'board'), await barEnd(app, 'right'));
  await endEdit(app);
  await expect(sidebar(app, 'right').locator('.board .bepfoot')).toHaveText('Saved view: Your turn only · one-line list · no lanes');
});

// Round 3 (ticket 289): the first role item takes focus when the menu opened before any role existed and the roles arrive
// after (the first snapshot, or a card written meanwhile). Before, focus was set once at open and stayed on the button.
test('board_role_menu_focus_when_roles_arrive_late: a menu opened empty focuses its first item when the roles show up', async ({ app, core }) => {
  const s = core.shell(core.project('demo'), 'Worker');
  const board = await openBoard(app, core);
  const add = board.locator('.bstrip').getByRole('button', { name: '+ filter' });
  await add.click();
  const menu = board.getByRole('menu', { name: 'Role filter' });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitemcheckbox')).toHaveCount(0); // no role on the board yet
  seed(core, [{ id: 'r1', title: 'Roles', column: 'todo', attachments: [{ session_id: s.id, role: 'build' }] }, { id: 'r2', title: 'More roles', column: 'todo', attachments: [{ session_id: s.id, role: 'docs' }] }]);
  await expect(menu.getByRole('menuitemcheckbox', { name: 'role: build' })).toBeFocused();
  await app.keyboard.press('ArrowDown');
  await expect(menu.getByRole('menuitemcheckbox', { name: 'role: docs' })).toBeFocused();
  // Focus the user already moved into the menu is not taken back when another role arrives.
  seed(core, [{ id: 'r1', title: 'Roles', column: 'todo', attachments: [{ session_id: s.id, role: 'build' }] }, { id: 'r2', title: 'More roles', column: 'todo', attachments: [{ session_id: s.id, role: 'docs' }] }, { id: 'r3', title: 'Review', column: 'todo', attachments: [{ session_id: s.id, role: 'review' }] }]);
  await expect(menu.getByRole('menuitemcheckbox', { name: 'role: review' })).toBeVisible();
  await expect(menu.getByRole('menuitemcheckbox', { name: 'role: docs' })).toBeFocused();
});

// V2.5-38 item 4a (185 follow-up): the role filter menu is a WAI-ARIA menu button.
test('board_role_menu_keyboard: focus moves into the menu, arrows wrap, Home/End jump, Esc returns to the button, outside click closes', async ({ app, core }) => {
  const p = core.project('demo');
  const s = core.shell(p, 'Worker');
  seed(core, [{ id: 'r1', title: 'Roles', column: 'todo', attachments: [{ session_id: s.id, role: 'build' }] }, { id: 'r2', title: 'More roles', column: 'todo', attachments: [{ session_id: s.id, role: 'docs' }] }, { id: 'r3', title: 'Review', column: 'todo', attachments: [{ session_id: s.id, role: 'review' }] }]);
  const board = await openBoard(app, core);
  const add = board.locator('.bstrip').getByRole('button', { name: '+ filter' });
  await add.click();
  const menu = board.getByRole('menu', { name: 'Role filter' });
  const item = (r: string) => menu.getByRole('menuitemcheckbox', { name: `role: ${r}` });
  await expect(item('build')).toBeFocused();
  await app.keyboard.press('ArrowDown');
  await expect(item('docs')).toBeFocused();
  await app.keyboard.press('End');
  await expect(item('review')).toBeFocused();
  await app.keyboard.press('ArrowDown'); // wraps
  await expect(item('build')).toBeFocused();
  await app.keyboard.press('ArrowUp'); // wraps back
  await expect(item('review')).toBeFocused();
  await app.keyboard.press('Home');
  await expect(item('build')).toBeFocused();
  await app.keyboard.press('Space');
  await expect(item('build')).toHaveAttribute('aria-checked', 'true');
  await app.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(add).toBeFocused();
  await expect(add).toHaveAttribute('aria-expanded', 'false');
  // A pointer-down outside closes it; a click on the button toggles it.
  await add.click();
  await expect(menu).toBeVisible();
  await app.mouse.click(5, 300);
  await expect(menu).toHaveCount(0);
});

// V2.5-38 item 4b: draft B's column heads show the full title (no ellipsis), in every UI language, with the right bar open.
// A title is whole when nothing overflows, nothing is ellipsised, and no word breaks across lines (each word's text
// range has one line box; the review saw "Needs deci-sion" broken mid-word).
const cutTitles = (app: Page, selector: string) =>
  app.locator(selector).evaluateAll((els) =>
    els
      .filter((e) => {
        if (e.scrollWidth > e.clientWidth + 1 || e.scrollHeight > e.clientHeight + 1 || getComputedStyle(e).textOverflow === 'ellipsis') return true;
        const node = e.firstChild;
        if (!node || node.nodeType !== Node.TEXT_NODE) return false;
        const text = node.textContent ?? '';
        let at = 0;
        return text.split(' ').some((word) => {
          const range = document.createRange();
          range.setStart(node, at);
          range.setEnd(node, at + word.length);
          at += word.length + 1;
          return word.length > 0 && new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size > 1;
        });
      })
      .map((e) => e.textContent),
  );
const LANGUAGES = ['en', 'ko', 'ja', 'zh-Hans', 'zh-Hant', 'es', 'fr', 'pt'];
const WORDS: Record<string, Record<string, string>> = { en: words.en, ko: words.ko, ja: words.ja, 'zh-Hans': words.zhHans, 'zh-Hant': words.zhHant, es: words.es, fr: words.fr, pt: words.pt };
const setLanguage = (app: Page, l: string) => app.evaluate((l) => localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ ...JSON.parse(localStorage.getItem('nunchiro.settings.v1') ?? '{}'), language: l })), l);

test('board_column_title_fits: every column head shows its whole title in all 8 languages, default width, right bar open, a 560 px centre zone and the board on the narrowest right bar', async ({ app, core }) => {
  test.setTimeout(180_000);
  const asker = core.shell(core.project('demo'), 'one');
  seed(core, [{ id: 'y1', title: 'Asks you', column: 'needs-decision', attachments: [{ session_id: asker.id, role: 'build' }] }]);
  await overlay(app, { board: (b) => withState(b, asker.id, 'needs_decision') }); // the right bar shows Your turn only
  // v25f: the Board icon opens a modal now, so the zone this spec sizes is placed by hand: a Board zone beside the terminal.
  fs.writeFileSync(
    path.join(core.home, 'layout.toml'),
    'version = 1\nlocked = false\n\n[root]\nid = "centre"\nsplit = "column"\n\n[[root.children]]\nid = "upper"\nsplit = "row"\n\n[[root.children.children]]\nid = "terminal"\nwidgets = ["terminal"]\n\n[[root.children.children]]\nid = "board"\nwidgets = ["board"]\n\n[[root.children]]\nid = "composer"\nwidgets = ["composer"]\n',
  );
  await openWindow(app, {}, core);
  // Default 1440 px, the right bar open beside it, and a narrow window whose centre zone is about 560 px.
  for (const [width, open] of [[1440, false], [1440, true], [932, false]] as const) {
    await app.setViewportSize({ width, height: 900 });
    for (const language of LANGUAGES) {
      await setLanguage(app, language);
      await app.evaluate((o) => {
        const k = 'nunchiro.settings.v1';
        const s = JSON.parse(localStorage.getItem(k) ?? '{}');
        localStorage.setItem(k, JSON.stringify({ ...s, bars: { ...s.bars, active: { ...(s.bars?.active ?? {}), right: o ? 'decisions' : null } } }));
      }, open);
      await app.reload();
      await expect(app.locator('html')).toHaveAttribute('lang', language);
      await expect(app.locator('.board .bch')).toHaveCount(5);
      if (open) await expect(sidebar(app, 'right')).toBeVisible();
      const label = `${language} ${width}${open ? ' + right bar' : ''}`;
      if (width < 1440) expect((await app.locator('[data-zone-id] .board').boundingBox())!.width, label).toBeLessThan(600);
      expect(await cutTitles(app, '.board .bch b'), label).toEqual([]);
      await expect(app.locator('.board .bch b').nth(2)).toHaveText(WORDS[language]!['board.default.needsDecision']); // ticket 871
    }
  }
  // The board on the right bar at the sidebar minimum (208 px): its one-line list names each card's column whole.
  await app.setViewportSize({ width: 1440, height: 900 });
  await setLanguage(app, 'en');
  await app.reload();
  await startEdit(app);
  await drag(app, icon(app, 'right', 'Board'), await barEnd(app, 'right'));
  await endEdit(app);
  // v25-shell-chrome: the sidebar width is kept in the arrangement (Bars.sidebarW); this old single value is both sides (v25f F12).
  await app.evaluate(() => {
    const k = 'nunchiro.settings.v1';
    const s = JSON.parse(localStorage.getItem(k) ?? '{}');
    localStorage.setItem(k, JSON.stringify({ ...s, bars: { ...s.bars, sidebarW: 208 } }));
  });
  for (const language of LANGUAGES) {
    await setLanguage(app, language);
    await app.reload();
    await expect(app.locator('html')).toHaveAttribute('lang', language);
    const right = sidebar(app, 'right');
    await expect(right.locator('.board .bli .blcol')).toHaveText([WORDS[language]!['board.default.needsDecision']]); // ticket 871
    expect(Math.round((await right.boundingBox())!.width), language).toBeLessThanOrEqual(210);
    expect(await cutTitles(app, '.board[data-zone="right"] .blcol'), `${language} right bar`).toEqual([]);
  }
});

// V2.5-38 item 4c: an undo answered after the 3 s wait does not leave Undo disabled for the window's life.
test('board_undo_late_success: a board_undo answered yes after 3 s puts the card back and turns Undo back on', async ({ app, core }) => {
  seed(core, [{ id: '20', title: 'Moved once', column: 'review', history: [{ actor: 'owner', kind: 'create', from: null, to: 'todo' }, { actor: 'owner', kind: 'move', from: 'todo', to: 'review' }] }]);
  const file = path.join(core.home, 'board.json');
  const store = JSON.parse(fs.readFileSync(file, 'utf8'));
  store.manual[0].undo = { ...store.manual[0], column: 'todo', history: [] };
  fs.writeFileSync(file, JSON.stringify(store));
  // The real core answers; its reply to board_undo is held 3.6 s.
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    const late = new Set<number>();
    ws.onMessage((msg) => {
      if (typeof msg === 'string' && JSON.parse(msg).request?.op === 'board_undo') late.add(JSON.parse(msg).id);
      server.send(msg);
    });
    server.onMessage((msg) => {
      const id = typeof msg === 'string' ? JSON.parse(msg).id : undefined;
      if (id !== undefined && late.has(id)) return void setTimeout(() => ws.send(msg), 3600);
      ws.send(msg);
    });
  });
  await openBoard(app, core);
  const card = cardOf(app, 'Moved once');
  await card.getByRole('button', { name: 'History of Moved once' }).click();
  const undo = card.getByRole('button', { name: 'Undo last change' });
  await undo.click();
  // Past 3 s with no answer: disabled, saying why.
  await expect(undo).toHaveAttribute('title', 'Undo was refused or got no answer; reload the window to try again', { timeout: 3500 });
  // The late yes: the card is back in To do and Undo no longer carries the refusal.
  await expect(app.locator('.board .bcell[data-column="todo"] .btt', { hasText: 'Moved once' })).toBeVisible({ timeout: 5000 });
  const after = cardOf(app, 'Moved once').getByRole('button', { name: 'Undo last change' });
  await expect(after).not.toHaveAttribute('title', 'Undo was refused or got no answer; reload the window to try again');
});
