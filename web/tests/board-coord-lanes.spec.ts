// V2.5-37 (ticket 185, needs 154/155, draft B): swimlanes, the coordinator indicator and its CLI line, filter chips,
// reachability and the 8-language catalogue. Real core, board.json seeded with 184's task fields.
import { expect, nunchiro, test, type Core } from './fixtures';
import { makeT } from '../src/i18n';
import * as areas from '../src/i18n/areas/board';
import { cardOf, openBoard, overlay, seed } from './fixtures/board/coord';
import type { Page } from '@playwright/test';

const laneNames = (app: Page) => app.locator('.board .blh .blname').allInnerTexts();

test('board_lanes_by_group: groups M1, M2 and none draw three lanes, "no group" last, each with progress and n/m done', async ({ app, core }) => {
  seed(core, [
    { id: 'a1', title: 'M1 first', column: 'todo', group: 'M1' },
    { id: 'a2', title: 'M1 shipped', column: 'done', group: 'M1' },
    { id: 'b1', title: 'M2 only', column: 'working', group: 'M2' },
    { id: 'c1', title: 'Loose', column: 'review' },
  ]);
  const board = await openBoard(app, core);
  await expect.poll(() => laneNames(app)).toEqual(['M2', 'M1', 'no group']);
  const lane = (name: string) => board.locator('.blh').filter({ has: app.locator('.blname', { hasText: new RegExp(`^${name}$`) }) });
  await expect(lane('M1').locator('.bpt')).toHaveText('1/2 done');
  await expect(lane('M1').getByRole('progressbar')).toHaveAttribute('aria-valuenow', '1');
  expect(await lane('M1').locator('.bpbar i').evaluate((e) => e.getAttribute('style'))).toContain('50%');
  await expect(lane('M2').locator('.bpt')).toHaveText('0/1 done');
  await expect(lane('no group').locator('.bpt')).toHaveText('0/1 done');
  await expect(lane('M1').locator('.blk')).toHaveText('group');
  // The bar sits next to the lane title, on the same line (needs 155).
  const [name, bar] = [(await lane('M1').locator('.blname').boundingBox())!, (await lane('M1').locator('.bpbar').boundingBox())!];
  expect(Math.abs(name.y + name.height / 2 - (bar.y + bar.height / 2))).toBeLessThan(4);
  expect(bar.x).toBeGreaterThan(name.x + name.width);
  // Each card sits in its own lane's row, under its column.
  const cell = (lane: string, column: string) => board.locator(`.bcell[data-lane="${lane}"][data-column="${column}"]`);
  await expect(cell('g:M1', 'done').locator('.btt')).toHaveText('M1 shipped');
  await expect(cell('-', 'review').locator('.btt')).toHaveText('Loose');
  // Lane key switched to project: these cards have no project, so one "no group" lane holds all four.
  await board.getByRole('group', { name: 'Lanes' }).getByRole('button', { name: 'project' }).click();
  await expect.poll(() => laneNames(app)).toEqual(['no group']);
  await expect(board.locator('.blh .bpt')).toHaveText('1/4 done');
  // "none" draws no lane header at all; group again brings the three back (the choice is kept in the window).
  await board.getByRole('group', { name: 'Lanes' }).getByRole('button', { name: 'none' }).click();
  await expect(board.locator('.blh')).toHaveCount(0);
  await expect(board.locator('.bcard')).toHaveCount(4);
  await board.getByRole('group', { name: 'Lanes' }).getByRole('button', { name: 'group' }).click();
  await expect.poll(() => laneNames(app)).toEqual(['M2', 'M1', 'no group']);
});

test('board_lanes_by_group edge: a session card without group falls back to its project lane; a 200-char unicode group; an empty board', async ({ app, core }) => {
  // 18 Hangul (3 bytes) + 182 ASCII = 200 characters in 236 bytes: within the core's 256-byte group limit.
  const long = '보드레인'.repeat(4) + '보드' + 'x'.repeat(182);
  expect([...long].length).toBe(200);
  seed(core, [{ id: 'l1', title: 'Long lane', column: 'todo', group: long }]);
  core.shell(core.project('demo'), 'busy');
  const board = await openBoard(app, core);
  await expect.poll(() => laneNames(app)).toEqual([long, 'demo']);
  await expect(board.locator('.blh[data-kind="fallback"] .blk')).toHaveText('project · no group');
  // The long name is cut with an ellipsis and stays on one line; the bar and count are still shown.
  const head = board.locator('.blh[data-kind="group"]');
  await expect(head.locator('.blname')).toHaveAttribute('title', long);
  const box = (await head.boundingBox())!;
  expect(box.height).toBeLessThan(30);
  await expect(head.locator('.bpt')).toBeVisible();
  expect((await head.locator('.bpt').boundingBox())!.x + 1).toBeLessThan(box.x + box.width + 1);
});

test('board_lanes_by_group edge: an empty board shows the five columns and their + Add, no lane', async ({ app, core }) => {
  const board = await openBoard(app, core);
  await expect(board.locator('.bch b')).toHaveText(['To do', 'Working', 'Needs decision', 'Review', 'Done']);
  await expect(board.locator('.blh')).toHaveCount(0);
  await expect(board.getByRole('button', { name: '+ Add', exact: true })).toHaveCount(5);
  await board.locator('[data-column="review"]').getByRole('button', { name: '+ Add', exact: true }).click();
  await expect(app.getByRole('dialog', { name: 'New card' }).getByRole('combobox', { name: 'Column', exact: true })).toHaveValue('review');
});

/** A shell session that prints its token, started by `token`'s session (or the owner). */
async function start(core: Core, project: string, label: string, token?: string) {
  const env = token ? { ...core.env, NUNCHIRO_TOKEN: token } : core.env;
  const args = ['session', 'start', '--kind', 'shell', '--project', project, '--label', label, '--', '/bin/sh', '-c', 'printf "TOKEN:%s\\n" "$NUNCHIRO_TOKEN"; exec cat'];
  const id = (JSON.parse(nunchiro(env, args)).session as { id: string }).id;
  let own = '';
  await expect.poll(() => (own = /TOKEN:(\S+)/.exec(core.read(id))?.[1] ?? '')).not.toBe('');
  return { id, token: own };
}

test('board_coordinator_cli_hint: the header names the coordinator and its child sessions; CLI ▾ opens the verbs line', async ({ app, core }) => {
  const p = core.project('orch');
  const coord = await start(core, p, 'coord-1031');
  for (const n of [1, 2, 3, 4]) await start(core, p, `w${n}`, coord.token);
  const board = await openBoard(app, core);
  const indicator = board.locator('.bcoord');
  await expect(indicator).toContainText('Coordinator: coord-1031 · 4 child sessions');
  const cli = indicator.getByRole('button', { name: 'CLI ▾' });
  await expect(cli).toHaveAttribute('aria-expanded', 'false');
  await expect(board.locator('.bcli')).toHaveCount(0);
  await cli.click();
  await expect(cli).toHaveAttribute('aria-expanded', 'true');
  await expect(board.locator('.bcli code')).toHaveText(['nunchiro board list', 'create', 'move', 'done', 'note', 'self']);
  // Draft B ends the line with the note that nothing is imported from herdr.
  await expect(board.locator('.bcli')).toHaveText(/self· no herdr import$/);
  await cli.click();
  await expect(board.locator('.bcli')).toHaveCount(0);
});

test('board_coordinator_cli_hint edge: with no coordinator the indicator is absent', async ({ app, core }) => {
  core.shell(core.project('solo'), 'alone');
  const board = await openBoard(app, core);
  await expect(board.locator('.bch b').first()).toBeVisible();
  await expect(board.locator('.bcoord')).toHaveCount(0);
  await expect(board.getByRole('button', { name: 'CLI ▾' })).toHaveCount(0);
});

test('board_filters: Your turn only, role, stale and receipt missing each filter the cards and clear', async ({ app, core }) => {
  const s1 = core.shell(core.project('demo'), 'opus');
  const s2 = core.shell(core.project('demo'), 'sonnet');
  seed(core, [
    { id: 't1', title: 'Asks you', column: 'working', attachments: [{ session_id: s1.id, role: 'build' }] },
    { id: 't2', title: 'Old one', column: 'working', moved: 14, attachments: [{ session_id: s2.id, role: 'review' }] },
    { id: 't3', title: 'No receipt', column: 'review', history: [{ actor: 'owner', kind: 'create', from: null, to: 'review' }, { actor: 'build-agent', kind: 'refused', from: 'review', to: 'done', reason: 'receipt required' }] },
    { id: 't4', title: 'Plain', column: 'todo' },
  ]);
  // The agent on t1 is asking: an attached session in needs_decision (no real agent is needed to show that state).
  await overlay(app, { board: (b) => ({ ...b, cards: (b.cards as { attachments?: { session_id: string; state: string | null }[] }[]).map((c) => ({ ...c, attachments: c.attachments?.map((a) => (a.session_id === s1.id ? { ...a, state: 'needs_decision' } : a)) })) }) });
  const board = await openBoard(app, core);
  const shown = () => board.locator('.bcard .btt').allInnerTexts().then((l) => l.sort());
  const all = ['Asks you', 'No receipt', 'Old one', 'Plain'];
  await expect.poll(shown).toEqual(all);
  const chip = (name: string) => board.locator('.bstrip').getByRole('button', { name: new RegExp(`^${name}`) });

  await chip('Your turn only').click();
  await expect(chip('Your turn only')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(shown).toEqual(['Asks you']);
  await chip('Your turn only').click();
  await expect.poll(shown).toEqual(all);

  // Draft B: roles are added from the dashed "+ filter" chip and shown as one "role: … ✕" chip, which clears them.
  const add = board.getByRole('button', { name: '+ filter' });
  await expect(board.locator('.bstrip select')).toHaveCount(0);
  await add.click();
  const menu = board.getByRole('menu', { name: 'Role filter' });
  await expect(menu.getByRole('menuitemcheckbox')).toHaveText(['role: build', 'role: review']);
  await menu.getByRole('menuitemcheckbox', { name: 'role: review' }).click();
  await expect.poll(shown).toEqual(['Old one']);
  await menu.getByRole('menuitemcheckbox', { name: 'role: build' }).click();
  await expect.poll(shown).toEqual(['Asks you', 'Old one']);
  const roleChip = board.locator('.bstrip').getByRole('button', { name: 'role: review, build', exact: true });
  await expect(roleChip).toHaveAttribute('aria-pressed', 'true');
  // The chip is as short as the other chips (draft B .fc), not a tall native select.
  const [h1, h2] = [(await roleChip.boundingBox())!.height, (await chip('stale').boundingBox())!.height];
  expect(Math.abs(h1 - h2)).toBeLessThan(1);
  await roleChip.click();
  await expect.poll(shown).toEqual(all);
  await expect(roleChip).toHaveCount(0);

  await chip('stale').click();
  await expect.poll(shown).toEqual(['Old one']);
  await chip('stale').click();
  await expect.poll(shown).toEqual(all);

  await chip('receipt missing').click();
  await expect.poll(shown).toEqual(['No receipt']);
  await chip('receipt missing').click();
  await expect.poll(shown).toEqual(all);
});

test('board_reachable_2_clicks: the board opens from the visible labelled Board control on the bar', async ({ app, core }) => {
  seed(core, [{ id: 'r1', title: 'Reach me', column: 'todo', group: 'M1' }]);
  await overlay(app, {});
  // openBoard is exactly one click on the bar's "Board" button; the lane, strip and card are then on screen.
  const board = await openBoard(app, core);
  await expect(board.getByRole('group', { name: 'Lanes' })).toBeVisible();
  await expect(board.getByRole('button', { name: 'Your turn only' })).toBeVisible();
  await expect(cardOf(app, 'Reach me')).toBeVisible();
});

test('board_strings_8_languages: every board key has a string in each of the 8 UI languages', () => {
  const keys = Object.keys(areas.en);
  expect(keys.length).toBeGreaterThan(100);
  const tables = areas as unknown as Record<string, Record<string, string>>;
  for (const lang of ['en', 'ko', 'ja', 'zh-Hans', 'zh-Hant', 'es', 'fr', 'pt']) {
    const table = tables[lang];
    const missing = keys.filter((k) => typeof table?.[k] !== 'string' || !table[k].trim());
    expect(missing, lang).toEqual([]);
    // Every English placeholder is kept, so no language drops a number or a name.
    const names = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
    for (const k of keys) expect(names(tables.en[k]).filter((n) => !names(table[k]).includes(n)), `${lang} ${k}`).toEqual([]);
  }
  const ko = makeT<string>('ko', 'ko', { en: tables.en, ko: tables.ko } as never);
  expect(ko('board.lane.done', { n: 3, m: 7 })).toBe('3/7 완료');
  expect(ko('board.task.stale', { n: 14 })).toBe('멈춤 14분');
});

test('board_filters edge: a move made while a chip hides cards keeps the hidden cards in place; keys stay in the lane', async ({ app, core }) => {
  // Oldest first: A, H, B, C in Working (the window's order starts by age). H has no role, so "role: build" hides it.
  const build = [{ session_id: 'gone-session', role: 'build' }];
  seed(core, [
    { id: 'a', title: 'A', column: 'working', group: 'M1', moved: 9, attachments: build },
    { id: 'h', title: 'H', column: 'working', group: 'M1', moved: 8 },
    { id: 'b', title: 'B', column: 'working', group: 'M1', moved: 7, attachments: build },
    { id: 'c', title: 'C', column: 'working', group: 'M1', moved: 6, attachments: build },
    { id: 'o', title: 'Other lane', column: 'working', moved: 5, attachments: build },
  ]);
  const board = await openBoard(app, core);
  const order = () => board.locator('.bcell[data-lane="g:M1"][data-column="working"] .btt').allInnerTexts();
  await expect.poll(order).toEqual(['A', 'H', 'B', 'C']);
  await board.getByRole('button', { name: '+ filter' }).click();
  await board.getByRole('menu', { name: 'Role filter' }).getByRole('menuitemcheckbox', { name: 'role: build' }).click();
  await expect.poll(order).toEqual(['A', 'B', 'C']);
  await cardOf(app, 'C').locator('.bmain').focus();
  await app.keyboard.press('Alt+ArrowUp');
  await expect.poll(order).toEqual(['A', 'C', 'B']);
  // The last card of its lane cell stays put on Alt+Down: the next lane's card is not its neighbour.
  await cardOf(app, 'B').locator('.bmain').focus();
  await app.keyboard.press('Alt+ArrowDown');
  await expect.poll(order).toEqual(['A', 'C', 'B']);
  await board.locator('.bstrip').getByRole('button', { name: 'role: build', exact: true }).click();
  await expect.poll(order).toEqual(['A', 'H', 'C', 'B']);
});

test('board_session_card_compact: a session card says "auto · session card" with its state chip, no project tag in its project lane, and is as short as a task card', async ({ app, core }) => {
  core.shell(core.project('nunchiro'), 'layout-d5');
  seed(core, [{ id: 't1', title: 'Task beside it', column: 'working', group: 'M1', ref: 'tickets/183' }]);
  const board = await openBoard(app, core);
  const session = cardOf(app, 'layout-d5');
  await expect(session.locator('.bauto')).toHaveText('auto · session card');
  await expect(session.locator('.bra')).toHaveText(/^—[●○◆] (working|idle)$/);
  await expect(session.locator('.bid')).toHaveText(' shell');
  await expect(session.locator('.btag')).toHaveCount(0); // its lane is "nunchiro", so the tag would repeat it
  // Two rows, the same height as a task card with two rows (draft B .cd min-height 62px), no empty space below.
  const [s, t] = [(await session.boundingBox())!.height, (await cardOf(app, 'Task beside it').boundingBox())!.height];
  expect(Math.abs(s - t)).toBeLessThan(2);
  expect(s).toBeLessThanOrEqual(63); // draft B .cd min-height: 62px; two rows fit inside it
  // Another lane key keeps the project tag: there the lane does not name it.
  await board.getByRole('group', { name: 'Lanes' }).getByRole('button', { name: 'none' }).click();
  await expect(session.locator('.btag')).toHaveText('nunchiro');
});
