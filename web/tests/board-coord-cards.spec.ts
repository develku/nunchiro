// V2.5-37 (ticket 185, needs 154/155, draft B): the task card: #id, ref link, role + assignee chips, waits on, the Done
// receipt line under the PR line, receipt missing, the stale badge with the header colour key, history and undo.
// Real core with board.json seeded; the overlay supplies only an asking agent, a PR, and `board_undo` (ticket 183 routes it).
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from './fixtures';
import { cardOf, openBoard, overlay, seed } from './fixtures/board/coord';

type Card = Record<string, unknown> & { id: string; attachments?: { session_id: string; state: string | null }[] };
const withState = (b: Record<string, unknown>, session: string, state: string) => ({ ...b, cards: (b.cards as Card[]).map((c) => ({ ...c, attachments: c.attachments?.map((a) => (a.session_id === session ? { ...a, state } : a)) })) });

test('board_card_chips_and_ref: #id, ref link, role + assignee chips with state dots, waits on', async ({ app, core }) => {
  const p = core.project('nunchiro');
  const [opus, sonnet, codex, extra] = ['Opus', 'Sonnet', 'Codex', 'Haiku'].map((l) => core.shell(p, l));
  seed(core, [
    { id: '12', title: 'board.toml fields', column: 'working', ref: 'docs/tickets/183.md', attachments: [{ session_id: opus.id, role: 'build' }, { session_id: sonnet.id, role: 'review' }, { session_id: codex.id, role: 'build2' }, { session_id: extra.id, role: 'docs' }] },
    { id: '14', title: 'Undo last', column: 'todo', ref: 'https://github.com/develku/nunchiro/issues/183', waits_on: ['12'] },
  ]);
  await overlay(app, { board: (b) => withState(withState(withState(b, opus.id, 'working'), sonnet.id, 'review'), codex.id, 'needs_decision') });
  await app.addInitScript(() => {
    const w = window as unknown as { __opened: unknown[] };
    w.__opened = [];
    window.open = ((url: string) => (w.__opened.push(url), null)) as typeof window.open;
    window.addEventListener('nunchiro:files.open', (e) => w.__opened.push((e as CustomEvent).detail));
  });
  await openBoard(app, core);
  const c12 = cardOf(app, 'board.toml fields');
  await expect(c12.locator('.bid')).toHaveText('#12 ');
  // Four attached sessions: four chips, each role + assignee + a shape and word per state (never colour alone).
  const chips = c12.locator('.bra');
  await expect(chips).toHaveCount(4);
  await expect(chips.nth(0)).toHaveText('buildOpus ● working');
  await expect(chips.nth(0).locator('[data-tone]')).toHaveAttribute('data-tone', 'w');
  await expect(chips.nth(1)).toHaveText(/^reviewSonnet ○ idle$/);
  await expect(chips.nth(2)).toHaveText('build2Codex ◆ your turn');
  await expect(chips.nth(2).locator('[data-tone]')).toHaveCSS('color', await app.evaluate(() => getComputedStyle(document.querySelector('.board')!).getPropertyValue('--you').trim()).then(hexToRgb));
  await expect(chips.nth(3)).toContainText('docs');
  // The card with an asking agent reads as your turn: the orange left edge.
  await expect(c12).toHaveAttribute('data-you', 'true');
  // waits on #12, display only.
  const c14 = cardOf(app, 'Undo last');
  await expect(c14.locator('.bwo')).toHaveText('waits on #12');
  await expect(c14.locator('.bwo')).toHaveAttribute('title', 'board.toml fields');
  // A ticket path opens in a file tab of the card's first attached session; a URL goes to the browser. Neither opens the editor.
  await c14.getByRole('link', { name: /issues\/183/ }).click();
  await expect(app.getByRole('dialog', { name: 'Edit card' })).toHaveCount(0);
  await c12.getByRole('link', { name: 'docs/tickets/183.md' }).click();
  await expect.poll(() => app.evaluate(() => (window as unknown as { __opened: unknown[] }).__opened)).toEqual(['https://github.com/develku/nunchiro/issues/183', { root: opus.id, path: 'docs/tickets/183.md' }]);
  // The file opens as a centre tab named after it.
  await expect(app.locator('.tab', { hasText: '183.md' })).toBeVisible();
});

test('board_card_chips_and_ref edge: deleting the card a waits_on points at removes the chip; a gone session shows "session gone"', async ({ app, core }) => {
  seed(core, [
    { id: '12', title: 'Base card', column: 'working' },
    { id: '14', title: 'Waiter', column: 'todo', waits_on: ['12'], attachments: [{ session_id: 'nobody-here', role: 'build' }] },
  ]);
  await openBoard(app, core);
  const waiter = cardOf(app, 'Waiter');
  await expect(waiter.locator('.bwo')).toHaveText('waits on #12');
  await expect(waiter.locator('.bra')).toHaveText('build ○ session gone');
  await cardOf(app, 'Base card').locator('.bmain').click();
  await app.getByRole('dialog', { name: 'Edit card' }).getByRole('button', { name: 'Delete' }).click();
  await expect(cardOf(app, 'Base card')).toHaveCount(0);
  await expect(waiter.locator('.bwo')).toHaveCount(0);
});

function hexToRgb(hex: string) {
  const n = parseInt(hex.replace('#', ''), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

test('board_done_receipt_line: proof badge on Done; PR line then receipt line on a Done card; receipt missing on the Review card', async ({ app, core }) => {
  const s = core.shell(core.project('nunchiro'), 'builder');
  seed(core, [
    { id: '10', title: 'Five columns', column: 'done', attachments: [{ session_id: s.id, role: 'build' }], receipt: { sha: '0123456789abcdef', command: 'cargo test', result: 'pass' }, history: [{ actor: 'owner', kind: 'create', from: null, to: 'todo' }, { actor: 'coord-1031', kind: 'move', from: 'review', to: 'done' }] },
    { id: '11', title: 'Receipt check', column: 'review', history: [{ actor: 'owner', kind: 'create', from: null, to: 'review' }, { actor: 'build-agent', kind: 'refused', from: 'review', to: 'done', reason: 'receipt required' }] },
    { id: '19', title: 'Moved by hand', column: 'done', history: [{ actor: 'owner', kind: 'create', from: null, to: 'todo' }, { actor: 'owner', kind: 'move', from: 'todo', to: 'done' }] },
    { id: '18', title: 'Tokens', column: 'review', receipt: { sha: 'a1b2c3d4', command: 'pnpm typecheck', result: 'fail' } },
    { id: '26', title: 'Cargo summary', column: 'review', receipt: { sha: 'b2c3d4e5', command: 'cargo test', result: 'test result: ok. 12 passed; 0 failed' } },
    { id: '22', title: 'Not yours', column: 'review', history: [{ actor: 'owner', kind: 'create', from: null, to: 'review' }, { actor: 'review-agent', kind: 'refused', from: 'review', to: 'done', reason: 'not your card' }] },
  ]);
  await overlay(app, { ops: { pr_chip: (r) => ({ type: 'pr_chip', chip: r.id === s.id ? { state: 'merged', url: 'https://github.com/develku/nunchiro/pull/12', at: null } : null }) } });
  const board = await openBoard(app, core);
  await expect(board.locator('.bcol[data-head="done"] .bproof')).toHaveText('proof');
  await expect(board.locator('.bcol[data-head="review"] .bproof')).toHaveCount(0);
  const done = cardOf(app, 'Five columns');
  await expect(done.locator('.bfact')).toContainText('Merged #12');
  await expect(done.locator('.brc')).toHaveText('0123456 · cargo test · pass');
  await expect(done.locator('.brc b')).toHaveAttribute('data-pass', 'true');
  // The receipt line sits under the PR line.
  const [fact, rc] = [(await done.locator('.bfact').boundingBox())!, (await done.locator('.brc').boundingBox())!];
  expect(rc.y).toBeGreaterThan(fact.y + fact.height - 1);
  await expect(cardOf(app, 'Receipt check').locator('.bmiss')).toHaveText('receipt missing · stopped in Review (sha, command, result needed)');
  await expect(cardOf(app, 'Moved by hand').locator('.brc')).toHaveText('moved by you · no receipt needed');
  // A summary that counts zero failures is a pass, not broken.
  await expect(cardOf(app, 'Cargo summary').locator('.brc b')).toHaveAttribute('data-pass', 'true');
  await expect(cardOf(app, 'Cargo summary')).not.toHaveAttribute('data-bad', 'true');
  // A refusal into Done for another reason (rights) is not "receipt missing".
  await expect(cardOf(app, 'Not yours').locator('.bmiss')).toHaveCount(0);
  // A failing receipt reads as broken: red word, red left edge.
  const bad = cardOf(app, 'Tokens');
  await expect(bad).toHaveAttribute('data-bad', 'true');
  await expect(bad.locator('.brc b')).toHaveAttribute('data-pass', 'false');
});

test('board_stale_badge: 14 min unmoved shows the yellow clock badge; 9 min none; the header key shows orange, yellow, red', async ({ app, core }) => {
  seed(core, [
    { id: '21', title: 'Reconnect', column: 'working', moved: 14 },
    { id: '22', title: 'Fresh', column: 'working', moved: 9 },
    { id: '23', title: 'Backlog', column: 'todo', moved: 60 },
    { id: '24', title: 'Shipped', column: 'done', moved: 60 },
  ]);
  const board = await openBoard(app, core);
  const badge = cardOf(app, 'Reconnect').locator('.bstale');
  await expect(badge).toHaveText('stale 14 min');
  await expect(badge.locator('svg')).toBeVisible();
  // Ticket 1041 (A): no dashed outline; the clock, the words and the yellow tint carry it.
  await expect(badge).toHaveCSS('border-top-width', '0px');
  const ink = await badge.evaluate((e) => [getComputedStyle(e).color, getComputedStyle(e).backgroundColor]);
  // Yellow: red and green high, blue low, in the text (light #7a5c00, dark #e3b341), on the stale tint.
  expect(ink[1]).not.toBe('rgba(0, 0, 0, 0)');
  for (const c of [ink[0]]) {
    const [r, g, b] = c.match(/\d+/g)!.map(Number);
    expect(r > b + 60 && g > b + 40, c).toBe(true);
  }
  await expect(cardOf(app, 'Fresh').locator('.bstale')).toHaveCount(0);
  // To do and Done cards never go stale.
  await expect(cardOf(app, 'Backlog').locator('.bstale')).toHaveCount(0);
  await expect(cardOf(app, 'Shipped').locator('.bstale')).toHaveCount(0);
  const key = board.getByRole('group', { name: 'State key' });
  await expect(key).toHaveText(/your turn.*stale.*broken/);
  const swatch = (k: string) => key.locator(`[data-k="${k}"] i`).evaluate((e) => getComputedStyle(e).color);
  const token = (n: string) => board.evaluate((e, n) => getComputedStyle(e).getPropertyValue(n).trim(), n).then(hexToRgb);
  expect(await swatch('you')).toBe(await token('--you'));
  expect(await swatch('bad')).toBe(await token('--bad'));
  expect(await swatch('stale')).toBe(await token('--stale-line'));
});

test('board_history_undo: who, when, from -> to; refused line red; Undo last change restores the column; nothing to undo is disabled', async ({ app, core }) => {
  const at = (min: number) => Date.now() - min * 60_000;
  seed(core, [
    {
      id: '20', title: 'Tree flicker', column: 'review',
      history: [
        { at: at(50), actor: 'owner', kind: 'create', from: null, to: 'todo' },
        { at: at(40), actor: 'build-Opus', kind: 'move', from: 'todo', to: 'working' },
        { at: at(20), actor: 'coord-1031', kind: 'move', from: 'working', to: 'review' },
        { at: at(10), actor: 'review-Sonnet', kind: 'refused', from: 'review', to: 'done', reason: 'not your card' },
      ],
    },
    { id: '30', title: 'Brand new', column: 'todo' },
  ]);
  // The core stores `undo` and serves `board_undo` (ticket 184); the window's socket path for it is ticket 183's, so the
  // reply here is what 184's handle_task returns: the card back in Working, an undo line, nothing more to undo.
  const undone: Record<string, unknown>[] = [];
  let restored = false;
  await overlay(app, {
    board: (b) => ({ ...b, cards: (b.cards as Card[]).map((c) => (c.id === '20' ? { ...c, can_undo: !restored, ...(restored ? { column: 'working', history: [...(c.history as unknown[]), { at: Date.now(), actor: 'owner', kind: 'undo', from: 'review', to: 'working', reason: null }] } : {}) } : c)) }),
    forward: { board_undo: (r) => (undone.push(r), (restored = true), { op: 'board_snapshot' }) },
  });
  const board = await openBoard(app, core);
  const card = cardOf(app, 'Tree flicker');
  await expect(card.locator('.bhist')).toHaveCount(0);
  await card.getByRole('button', { name: 'History of Tree flicker' }).click();
  await expect(card.getByRole('button', { name: 'History of Tree flicker' })).toHaveAttribute('aria-expanded', 'true');
  const rows = card.locator('.bhist li');
  await expect(rows).toHaveCount(4);
  const hm = (min: number) => app.evaluate((t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }), at(min));
  await expect(rows.nth(0)).toHaveText(`${await hm(10)}review-Sonnet refused Review → Done: not your card`);
  await expect(rows.nth(1)).toHaveText(`${await hm(20)}coord-1031 Working → Review`);
  await expect(rows.nth(2)).toHaveText(`${await hm(40)}build-Opus To do → Working`);
  await expect(rows.nth(3)).toHaveText(`${await hm(50)}you created in To do`);
  // The refused line is red; the change undo would take back is marked.
  const red = await board.evaluate((e) => getComputedStyle(e).getPropertyValue('--bad').trim()).then(hexToRgb);
  await expect(rows.nth(0)).toHaveAttribute('data-kind', 'refused');
  expect(await rows.nth(0).locator('span').evaluate((e) => getComputedStyle(e).color)).toBe(red);
  await expect(rows.nth(1)).toHaveAttribute('data-last', 'true');
  // A click inside the history does not open the editor.
  await rows.nth(1).locator('span').click();
  await expect(app.getByRole('dialog', { name: 'Edit card' })).toHaveCount(0);

  const undo = card.getByRole('button', { name: 'Undo last change' });
  await expect(undo).toBeEnabled();
  await undo.click();
  expect(undone).toEqual([{ op: 'board_undo', id: '20' }]);
  await expect(board.locator('.bcell[data-column="working"]').locator('.btt', { hasText: 'Tree flicker' })).toBeVisible();
  await expect(card.locator('.bhist li').first()).toContainText('you undo Review → Working');
  await expect(card.getByRole('button', { name: 'Undo last change' })).toBeDisabled();

  // Edge: a card with nothing to undo shows the button disabled, with a tooltip saying so.
  const fresh = cardOf(app, 'Brand new');
  await fresh.getByRole('button', { name: 'History of Brand new' }).click();
  const none = fresh.getByRole('button', { name: 'Undo last change' });
  await expect(none).toBeDisabled();
  await expect(none).toHaveAttribute('title', 'Nothing to undo');
});

test('board_history_chevron_on_expanded_only: the chevron shows on the expanded card; a collapsed card shows it only under the pointer or focus', async ({ app, core }) => {
  seed(core, [
    { id: '20', title: 'Open me', column: 'review' },
    { id: '21', title: 'Leave me', column: 'review' },
  ]);
  await openBoard(app, core);
  const opacity = (title: string) => cardOf(app, title).locator('.bexp').evaluate((e) => getComputedStyle(e).opacity);
  expect(await opacity('Open me')).toBe('0');
  expect(await opacity('Leave me')).toBe('0');
  // Still reachable: hovering the card (or focusing it) shows the labelled button.
  await cardOf(app, 'Open me').hover();
  await expect.poll(() => opacity('Open me')).toBe('1');
  await cardOf(app, 'Open me').getByRole('button', { name: 'History of Open me' }).click();
  await app.mouse.move(2, 2);
  await expect.poll(() => opacity('Open me')).toBe('1');
  expect(await opacity('Leave me')).toBe('0');
  await cardOf(app, 'Leave me').locator('.bmain').focus();
  await expect.poll(() => opacity('Leave me')).toBe('1');
});

test('board_undo_restores_card: through the real core, a moved card goes back with Undo and its history shows the undo', async ({ app, core }) => {
  seed(core, [{ id: '20', title: 'Move me', column: 'todo' }]);
  await openBoard(app, core);
  const card = cardOf(app, 'Move me');
  const cell = (column: string) => board(app).locator(`.bcell[data-column="${column}"] .btt`, { hasText: 'Move me' });
  // A real move by keys (board_move), then the card's own Undo (board_undo, ticket 183's window route).
  await card.locator('.bmain').focus();
  await app.keyboard.press('Alt+ArrowRight');
  await expect(cell('working')).toBeVisible();
  await card.getByRole('button', { name: 'History of Move me' }).click();
  await expect(card.locator('.bhist li').first()).toContainText('you To do → Working');
  const undo = card.getByRole('button', { name: 'Undo last change' });
  await expect(undo).toBeEnabled();
  await undo.click();
  await expect(cell('todo')).toBeVisible();
  await expect(cell('working')).toHaveCount(0);
  await expect(card.locator('.bhist li').first()).toContainText('you undo Working → To do');
  // One step: nothing more to undo, and the core kept it (the next poll agrees).
  await expect(undo).toBeDisabled();
  await expect(undo).toHaveAttribute('title', 'Nothing to undo');
  await app.waitForTimeout(1500);
  await expect(cell('todo')).toBeVisible();
  const stored = JSON.parse(fs.readFileSync(path.join(core.home, 'board.json'), 'utf8')).manual[0];
  expect(stored.column).toBe('todo');
});

test('board_undo_refused_disabled: a board_undo the core drops unanswered turns Undo disabled, saying why', async ({ app, core }) => {
  seed(core, [{ id: '20', title: 'Moved once', column: 'review', history: [{ actor: 'owner', kind: 'create', from: null, to: 'todo' }, { actor: 'owner', kind: 'move', from: 'todo', to: 'review' }] }]);
  const file = path.join(core.home, 'board.json');
  const store = JSON.parse(fs.readFileSync(file, 'utf8'));
  store.manual[0].undo = { ...store.manual[0], column: 'todo', history: [] };
  fs.writeFileSync(file, JSON.stringify(store));
  await overlay(app, { drop: ['board_undo'] });
  await openBoard(app, core);
  const card = cardOf(app, 'Moved once');
  await card.getByRole('button', { name: 'History of Moved once' }).click();
  const undo = card.getByRole('button', { name: 'Undo last change' });
  await expect(undo).toBeEnabled();
  await undo.click();
  await expect(undo).toBeDisabled();
  await expect(undo).toHaveAttribute('title', 'Undo was refused or got no answer; reload the window to try again');
  await expect(board(app).locator('.bcell[data-column="review"] .btt', { hasText: 'Moved once' })).toBeVisible();
});
const board = (app: import('@playwright/test').Page) => app.locator('.board');
