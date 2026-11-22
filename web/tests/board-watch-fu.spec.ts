// V2.5-82 (ticket 297 items 1, 2, 3, 4 (watch files), 5; needs 213): the watch view's leftovers. A card morphs into its detail
// (Orca's view transition) and honours reduced motion; a card expands its subagents in place; the detail resizes by its edge
// and maximises, the size kept in this window; the card menu moves a card next / previous and greys at the ends with a reason;
// the two watch files draw their marks with `Icon`, not text glyphs. Real core and board.json seeds; `overlay` only answers
// the `subagents` read, which a shell cannot make a core produce.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, REPO, test } from './fixtures';
import { agentsInTurn, busyShell, openBoard, overlay, seed } from './fixtures/board/coord';

test.beforeEach(async ({ app }) => {
  await app.addInitScript(() => localStorage.removeItem('nunchiro.test.board-mode'));
});

const card = (app: Page, title: string) => app.locator('.board .wcard').filter({ has: app.locator('.wtt', { hasText: new RegExp(`^${title}$`) }) });
const detail = (app: Page) => app.getByRole('complementary', { name: 'Card detail' });
const width = async (loc: ReturnType<Page['locator']>) => Math.round((await loc.boundingBox())!.width);
const column = (home: string, id: string) => (JSON.parse(fs.readFileSync(`${home}/board.json`, 'utf8')).manual as { id: string; column: string }[]).find((c) => c.id === id)?.column;

type Recorded = { named: string[] };
/** Records each `startViewTransition` call with the classes of the elements named at that moment (the old state), then runs it (or runs the callback where the browser has none). */
async function recordTransitions(app: Page) {
  await app.addInitScript(() => {
    const w = window as unknown as { __vt: { named: string[] }[] };
    w.__vt = [];
    const doc = document as unknown as { startViewTransition?: (cb: () => void) => unknown };
    const orig = doc.startViewTransition?.bind(document);
    doc.startViewTransition = (cb: () => void) => {
      const named = [...document.querySelectorAll<HTMLElement>('*')].filter((e) => e.style.viewTransitionName).map((e) => `${e.classList[0]}:${e.style.viewTransitionName}`);
      w.__vt.push({ named });
      if (orig) return orig(cb);
      cb();
      return { finished: Promise.resolve(), ready: Promise.resolve(), updateCallbackDone: Promise.resolve(), skipTransition() {} };
    };
  });
}
const transitions = (app: Page) => app.evaluate(() => (window as unknown as { __vt: Recorded[] }).__vt);
const namedNow = (app: Page) => app.evaluate(() => [...document.querySelectorAll<HTMLElement>('*')].filter((e) => e.style.viewTransitionName).length);

/** The morph is over when nothing is named any more; until then the page behind is not hit-testable, so a raw mouse waits. */
const settled = (app: Page) => expect.poll(() => namedNow(app)).toBe(0);

test('board_watch_card_morphs_to_detail: opening and closing a detail runs one view transition from the card to the panel and back; reduced motion skips it', async ({ app, core }) => {
  seed(core, [
    { id: 'a', title: 'Alpha lane', column: 'todo' },
    { id: 'b', title: 'Beta lane', column: 'working' },
  ]);
  await recordTransitions(app);
  await openBoard(app, core);
  // Open: the card carries the shared name when the old state is captured; the panel appears; nothing stays named afterwards.
  await card(app, 'Alpha lane').click();
  await expect(detail(app)).toBeVisible();
  let seen = await transitions(app);
  expect(seen).toHaveLength(1);
  expect(seen[0].named).toEqual(['wcard:watch-morph']);
  await expect.poll(() => namedNow(app)).toBe(0);
  // Close (Esc): now the panel is the old state, and focus goes back to the card.
  await app.keyboard.press('Escape');
  await expect(detail(app)).toHaveCount(0);
  await expect(card(app, 'Alpha lane')).toBeFocused();
  seen = await transitions(app);
  expect(seen).toHaveLength(2);
  expect(seen[1].named).toEqual(['wdetail:watch-morph']);
  await expect.poll(() => namedNow(app)).toBe(0);
  // Another card while one is open swaps the panel under the same name without a second owner of it.
  await card(app, 'Alpha lane').click();
  await expect(detail(app).getByRole('heading', { name: 'Alpha lane' })).toBeVisible();
  await card(app, 'Beta lane').click();
  await expect(detail(app).getByRole('heading', { name: 'Beta lane' })).toBeVisible();
  expect((await transitions(app)).length).toBeGreaterThanOrEqual(3);
  await expect.poll(() => namedNow(app)).toBe(0);
  // Reduced motion: no transition is started and the detail still opens and closes.
  await app.emulateMedia({ reducedMotion: 'reduce' });
  const before = (await transitions(app)).length;
  await app.keyboard.press('Escape');
  await expect(detail(app)).toHaveCount(0);
  await card(app, 'Alpha lane').click();
  await expect(detail(app).getByRole('heading', { name: 'Alpha lane' })).toBeVisible();
  expect((await transitions(app)).length).toBe(before);
  // The pseudo-element tuning is in the sheet, with its own reduced-motion guard.
  const css = fs.readFileSync(path.join(REPO, 'web/src/board/watch.css'), 'utf8');
  expect(css).toMatch(/::view-transition-group\(watch-morph\)/);
  expect(css).toMatch(/prefers-reduced-motion: reduce\)[^}]*\{[^}]*view-transition/s);
});

const KIDS = [
  { id: 'k1', label: 'Explore: find ssh -G callers', state: 'working', started_at: Math.floor(Date.now() / 1000) - 90 },
  { id: 'k2', label: 'Plan: page layout', state: 'done' },
];

test('board_watch_card_expands_subagents: a card with subagents shows a count, expands its children in place, and folds again; the click never opens the detail', async ({ app, core }) => {
  const p = core.project('demo');
  agentsInTurn(core); // ticket 407: an agent in a turn is under Working; a quiet one is Idle
  const lead = core.agent(p, 'lead', 'x');
  busyShell(core, p, 'plain');
  await overlay(app, { ops: { subagents: (r) => ({ kids: r.id === lead.id ? KIDS : [] }) } });
  await openBoard(app, core);
  await expect(card(app, 'lead')).toBeVisible({ timeout: 15_000 });
  const toggle = app.getByRole('button', { name: '2 subagents' });
  await expect(toggle).toBeVisible({ timeout: 15_000 });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(toggle).toContainText('2');
  // No toggle on a card with no children, and nothing listed while folded.
  await expect(app.locator('.board .wcell').filter({ has: card(app, 'plain') }).getByRole('button', { name: /subagent/ })).toHaveCount(0);
  await expect(app.getByRole('list', { name: 'Subagents of lead' })).toHaveCount(0);
  const folded = (await card(app, 'lead').boundingBox())!.height;
  await toggle.click();
  const list = app.getByRole('list', { name: 'Subagents of lead' });
  await expect(list).toBeVisible();
  await expect(list.getByRole('listitem')).toHaveCount(2);
  await expect(list.getByRole('listitem').nth(0)).toContainText('Explore: find ssh -G callers');
  await expect(list.getByRole('listitem').nth(0)).toContainText('working');
  await expect(list.getByRole('listitem').nth(1)).toContainText('Plan: page layout');
  await expect(list.getByRole('listitem').nth(1)).toContainText('done');
  // In place: it sits in the card's own cell under the card, in the same column; the detail did not open.
  const col = app.locator('.board .wcol[data-bucket="working"]');
  await expect(col.getByRole('list', { name: 'Subagents of lead' })).toBeVisible();
  expect((await list.boundingBox())!.y).toBeGreaterThanOrEqual((await card(app, 'lead').boundingBox())!.y + folded - 1);
  await expect(detail(app)).toHaveCount(0);
  await expect(app.getByRole('button', { name: '2 subagents' })).toHaveAttribute('aria-expanded', 'true');
  await app.getByRole('button', { name: '2 subagents' }).click();
  await expect(list).toHaveCount(0);
});

test('board_watch_detail_resize_maximise: the detail resizes by its edge (pointer and arrows), maximises and restores from a labelled button; the size is kept in this window', async ({ app, core }) => {
  seed(core, [{ id: 'a', title: 'Alpha lane', column: 'todo' }]);
  const board = await openBoard(app, core);
  await card(app, 'Alpha lane').click();
  const panel = detail(app);
  await expect(panel).toBeVisible();
  await settled(app);
  const edge = app.getByRole('separator', { name: 'Resize the card detail' });
  await expect(edge).toBeVisible();
  const start = await width(panel);
  expect(start).toBe(320);
  // Drag the edge 120px to the left: the panel grows by as much, and the value says so.
  const box = (await edge.boundingBox())!;
  await app.mouse.move(box.x + box.width / 2, box.y + 200);
  await app.mouse.down();
  await app.mouse.move(box.x + box.width / 2 - 120, box.y + 200, { steps: 6 });
  await app.mouse.up();
  expect(await width(panel)).toBe(start + 120);
  await expect(edge).toHaveAttribute('aria-valuenow', String(start + 120));
  // Keys on the edge: Left grows, Right shrinks, by 24.
  await edge.focus();
  await app.keyboard.press('ArrowLeft');
  expect(await width(panel)).toBe(start + 144);
  await app.keyboard.press('ArrowRight');
  expect(await width(panel)).toBe(start + 120);
  // It cannot be dragged past a floor or past the grid's own room.
  await edge.dblclick(); // double-click: back to the default
  expect(await width(panel)).toBe(start);
  for (let i = 0; i < 40; i++) await app.keyboard.press('ArrowRight');
  expect(await width(panel)).toBeGreaterThanOrEqual(240);
  await edge.dblclick();
  await app.mouse.move(box.x + 2, box.y + 200);
  await app.mouse.down();
  await app.mouse.move(2, box.y + 200, { steps: 6 });
  await app.mouse.up();
  const room = (await board.boundingBox())!.width;
  expect(await width(panel)).toBeLessThan(room);
  expect(await width(app.locator('.board .wcols'))).toBeGreaterThanOrEqual(200);
  // The chosen size is this window's: a reload and the same card come back at it.
  await edge.dblclick();
  await edge.focus();
  await app.keyboard.press('ArrowLeft');
  await app.keyboard.press('ArrowLeft');
  const kept = start + 48;
  expect(await width(panel)).toBe(kept);
  await app.reload();
  await expect(app.locator('.board')).toBeVisible();
  await card(app, 'Alpha lane').click();
  expect(await width(detail(app))).toBe(kept);
  // Maximise: the panel takes the whole board, the button now says Restore, and Restore gives the size back.
  const max = detail(app).getByRole('button', { name: 'Maximise detail' });
  await expect(max).toBeVisible();
  await max.click();
  const restore = detail(app).getByRole('button', { name: 'Restore detail size' });
  await expect(restore).toBeVisible();
  await expect(detail(app)).toHaveAttribute('data-max', '');
  const whole = (await app.locator('.board .bsplit').boundingBox())!.width;
  expect(await width(detail(app))).toBe(Math.round(whole));
  await expect(app.getByRole('separator', { name: 'Resize the card detail' })).toHaveCount(0);
  await restore.click();
  await expect(detail(app)).not.toHaveAttribute('data-max', '');
  expect(await width(detail(app))).toBe(kept);
  await expect(app.getByRole('button', { name: 'Maximise detail' })).toBeVisible();
});

test('board_watch_detail_width_broken_store: a saved width that is not a number, is too small or absurdly large is ignored (default width), and the store is left as it was', async ({ app, core }) => {
  seed(core, [{ id: 'a', title: 'Alpha lane', column: 'todo' }]);
  await openBoard(app, core);
  const KEY = 'nunchiro.board.watch.detailWidth';
  for (const bad of ['abc', '12', '99999', '', '{"w":400}']) {
    await app.evaluate(([k, v]) => localStorage.setItem(k, v), [KEY, bad]);
    await app.reload();
    await expect(app.locator('.board')).toBeVisible();
    await card(app, 'Alpha lane').click();
    await expect(detail(app)).toBeVisible();
    expect(await width(detail(app)), bad).toBe(320);
    expect(await app.evaluate((k) => localStorage.getItem(k), KEY), bad).toBe(bad); // read only: nothing rewritten
  }
  // A sane value is taken.
  await app.evaluate(([k, v]) => localStorage.setItem(k, v), [KEY, '400']);
  await app.reload();
  await card(app, 'Alpha lane').click();
  expect(await width(detail(app))).toBe(400);
});

test('board_watch_card_subagents_bad_reply: a reply that is not a list, or a refused read, shows no toggle', async ({ app, core }) => {
  const p = core.project('demo');
  agentsInTurn(core); // ticket 407: an agent in a turn is under Working; a quiet one is Idle
  core.agent(p, 'lead', 'x');
  await overlay(app, { ops: { subagents: () => ({ kids: 'nope' }) } });
  await openBoard(app, core);
  await expect(card(app, 'lead')).toBeVisible({ timeout: 15_000 });
  await app.waitForTimeout(1500); // the first read has been answered by now
  await expect(app.getByRole('button', { name: /^\d+ subagents?$/ })).toHaveCount(0);
});

test('board_watch_menu_move_next_prev: Move next / Move previous move the card to the neighbour column from the watch card menu; at the ends the item is greyed and says why', async ({ app, core }) => {
  seed(core, [
    { id: 'f1', title: 'First', column: 'todo' },
    { id: 'm1', title: 'Middle', column: 'review' },
    { id: 'l1', title: 'Last', column: 'done' },
  ]);
  await openBoard(app, core);
  const menu = app.getByRole('menu', { name: 'Actions' });
  const item = (id: string) => menu.locator(`[data-command="board.card.${id}"]`);
  const open = async (title: string) => {
    await card(app, title).click({ button: 'right' });
    await expect(menu).toBeVisible();
  };
  // The ends: First has no previous column, Last no next; each says why on hover (title) and stays out of the way.
  await open('First');
  await expect(item('prev')).toHaveAttribute('aria-disabled', 'true');
  await expect(item('prev')).toHaveAttribute('title', 'Already in the first column, or this card cannot be moved');
  await expect(item('next')).not.toHaveAttribute('aria-disabled', 'true');
  await expect(item('next')).not.toHaveAttribute('title', /.+/);
  await item('prev').click({ force: true }); // a greyed item does nothing (force: Playwright waits for an enabled one otherwise)
  await expect.poll(() => column(core.home, 'f1')).toBe('todo');
  await expect(menu).toBeHidden(); // a click on a greyed item closes the menu; a further Esc would close the Board modal behind it
  await open('Last');
  await expect(item('next')).toHaveAttribute('aria-disabled', 'true');
  await expect(item('next')).toHaveAttribute('title', 'Already in the last column, or this card cannot be moved');
  await expect(item('prev')).not.toHaveAttribute('aria-disabled', 'true');
  await app.keyboard.press('Escape');
  // Middle moves: next to done (it lands under Done), then previous back to review (under Needs you).
  const under = (bucket: string) => app.locator(`.board .wcol[data-bucket="${bucket}"] .wcard .wtt`).allInnerTexts();
  await open('Middle');
  await item('next').click();
  await expect.poll(() => column(core.home, 'm1')).toBe('done');
  await expect.poll(() => under('done')).toContain('Middle');
  await open('Middle');
  await item('prev').click();
  await expect.poll(() => column(core.home, 'm1')).toBe('review');
  await expect.poll(() => under('attention')).toContain('Middle');
  // Focus stays with the card after the move.
  await expect(card(app, 'Middle')).toBeFocused();
});

test('board_watch_controls_basics: each new control has click, keyboard, a visible name and focus; nothing styled as clickable lacks a handler', async ({ app, core }) => {
  const p = core.project('demo');
  agentsInTurn(core); // ticket 407: an agent in a turn is under Working; a quiet one is Idle
  const lead = core.agent(p, 'lead', 'x');
  seed(core, [{ id: 'a', title: 'Alpha lane', column: 'todo' }]);
  await overlay(app, { ops: { subagents: (r) => ({ kids: r.id === lead.id ? KIDS : [] }) } });
  await openBoard(app, core);
  // Subagent toggle: a native button, Enter and Space open and fold it, with a name that says what it does, focus ring on keys.
  const toggle = app.getByRole('button', { name: '2 subagents' });
  await expect(toggle).toBeVisible({ timeout: 15_000 });
  await toggle.focus();
  await app.keyboard.press('Enter');
  const list = app.getByRole('list', { name: 'Subagents of lead' });
  await expect(list).toBeVisible();
  await app.keyboard.press('Space');
  await expect(list).toHaveCount(0);
  await expect(toggle).toHaveAttribute('title', '2 subagents');
  expect(await toggle.evaluate((e) => getComputedStyle(e).cursor)).toBe('pointer');
  // The card's own keys still work next to it: Enter on the card opens the detail, not the toggle.
  await card(app, 'Alpha lane').focus();
  await app.keyboard.press('Enter');
  const panel = detail(app);
  await expect(panel).toBeVisible();
  // Resize edge: a separator that takes focus, shows its value and has a hover name; double-click resets.
  const edge = app.getByRole('separator', { name: 'Resize the card detail' });
  await expect(edge).toHaveAttribute('tabindex', '0');
  await expect(edge).toHaveAttribute('aria-orientation', 'vertical');
  await expect(edge).toHaveAttribute('title', 'Drag to resize · double-click for the default width');
  expect(await edge.evaluate((e) => getComputedStyle(e).cursor)).toBe('col-resize');
  // Maximise and Close by keyboard; Esc closes the maximised panel and the focus returns to the card.
  const max = panel.getByRole('button', { name: 'Maximise detail' });
  await max.focus();
  await app.keyboard.press('Enter');
  await expect(panel.getByRole('button', { name: 'Restore detail size' })).toBeFocused();
  await app.keyboard.press('Space');
  await expect(panel.getByRole('button', { name: 'Maximise detail' })).toBeVisible();
  await expect(panel).not.toHaveAttribute('data-max', '');
  await app.keyboard.press('Enter');
  await expect(panel).toHaveAttribute('data-max', '');
  await app.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await expect(card(app, 'Alpha lane')).toBeFocused();
  // Reachable within two clicks from the main view: the Board icon, then the card (open the detail), where Maximise sits.
  await card(app, 'Alpha lane').click();
  await expect(detail(app).getByRole('button', { name: 'Maximise detail' })).toBeVisible();
  // The Close mark is an Icon, and so is the lane chevron: no text glyph is drawn by the two watch files.
  await expect(detail(app).locator('.wdx svg[data-icon="x"]')).toHaveCount(1);
  await expect(detail(app).getByRole('button', { name: 'Close' })).toHaveText('');
});

test('board_watch_icons_not_glyphs: the two watch files draw the close and chevron marks with Icon, and no text glyph is left in them', async ({ app, core }) => {
  const a = core.shell(core.project('alpha'), 'one');
  const b = core.shell(core.project('beta'), 'two');
  seed(core, [
    { id: 'l1', title: 'Alpha lane', column: 'todo', attachments: [{ session_id: a.id, role: 'build' }] },
    { id: 'l2', title: 'Beta lane', column: 'todo', attachments: [{ session_id: b.id, role: 'build' }] },
  ]);
  const board = await openBoard(app, core);
  // Two projects show: a lane header per project with its fold chevron.
  await expect(board.locator('.wlane')).toHaveCount(2);
  await expect(board.locator('.wlane .blfold svg[data-icon="chevron-right"]')).toHaveCount(2);
  await expect(board.locator('.wlane .blfold svg[data-icon="chevron-right"]').first()).toHaveClass(/oi/);
  // The source: no ✕ ▾ ▸ ↳ glyph in either file.
  for (const f of ['WatchDetail.tsx', 'WatchGrid.tsx']) {
    const src = fs.readFileSync(path.join(REPO, 'web/src/board', f), 'utf8');
    expect(src, f).not.toMatch(/[✕✖×▾▸▴▼▶↳⌄›‹]/);
  }
});
