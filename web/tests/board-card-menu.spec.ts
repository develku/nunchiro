// needs 171 / 172 (ticket 201, board r7): the card context menu. The six `board.card.*` registry commands on a card and
// on a list row, each enabled only where the card can take it; they run the card's own paths (open, editor, Alt+arrow
// move, delete with Undo, the PR opener). Real core with board.json seeded; the overlay adds an integration card and a PR.
import fs from 'node:fs';
import type { Locator, Page } from '@playwright/test';
import { expect, openWindow, test, type Core } from './fixtures';
import { cardOf, openBoard, overlay, seed } from './fixtures/board/coord';

const PR = 'https://github.com/develku/nunchiro/pull/12';
const CARD_OPS = ['board.card.open', 'board.card.edit', 'board.card.next', 'board.card.prev', 'board.card.pr', 'board.card.delete'];
const menu = (p: Page) => p.getByRole('menu', { name: 'Actions' });
const items = (p: Page) => menu(p).getByRole('menuitem');
const commands = (p: Page) => items(p).evaluateAll((els) => els.map((e) => e.getAttribute('data-command')));
/** The card items the menu offers this target (drawn and not greyed). */
const usable = (p: Page) => items(p).evaluateAll((els) => els.filter((e) => !e.hasAttribute('aria-disabled')).map((e) => e.getAttribute('data-command')).filter((c) => c!.startsWith('board.card.')));
const item = (p: Page, id: string) => menu(p).locator(`[data-command="${id}"]`);
const column = (core: Core, id: string) => (JSON.parse(fs.readFileSync(`${core.home}/board.json`, 'utf8')).manual as { id: string; column: string }[]).find((c) => c.id === id)?.column;
const undoLine = (p: Page) => p.locator('footer.status .undoline');

async function menuOn(app: Page, target: Locator) {
  await target.locator('.btt, .bltt').first().click({ button: 'right' });
  await expect(menu(app)).toBeVisible();
}
async function record(app: Page) {
  await app.addInitScript(() => {
    const w = window as unknown as { __opened: unknown[][] };
    w.__opened = [];
    window.open = ((...args: unknown[]) => (w.__opened.push(args), null)) as typeof window.open;
  });
}
const opened = (app: Page) => app.evaluate(() => (window as unknown as { __opened: unknown[][] }).__opened);
const integ = (id: string, title: string, url: string | null) => ({ id, source: 'integration', source_name: 'tracker', title, note: '', session_id: null, project: null, column: 'review', state: null, stale: false, updated_at: 1, url });

const FOUR = [
  { id: 'f1', title: 'First', column: 'todo' },
  { id: 'm1', title: 'Middle', column: 'review' },
  { id: 'm2', title: 'Middle two', column: 'review' },
  { id: 'l1', title: 'Last', column: 'done' },
];

test('card_menu_items_follow_the_card: a manual, an integration and a session card each offer only what they can take', async ({ app, core }) => {
  const s = core.shell(core.project('demo'), 'busy');
  seed(core, [...FOUR, { id: 'p1', title: 'With PR', column: 'review', attachments: [{ session_id: 'pr-session', role: 'build' }] }]);
  await overlay(app, {
    board: (b) => ({ ...b, cards: [...(b.cards as object[]), integ('i1', 'Linked', 'https://example.test/i/1'), integ('i2', 'No link', null)] }),
    ops: { pr_chip: (r) => ({ chip: r.id === 'pr-session' ? { state: 'open', url: PR, at: null } : null }) },
  });
  await openBoard(app, core);
  const expectMenu = async (title: string, ids: string[]) => {
    await menuOn(app, cardOf(app, title));
    // Every card item is listed (in the surface's order); those the card cannot take are greyed.
    expect((await commands(app)).filter((c) => c!.startsWith('board.card.'))).toEqual(CARD_OPS);
    expect(await usable(app), title).toEqual(ids);
    await app.keyboard.press('Escape');
    await expect(menu(app)).toHaveCount(0);
  };
  await expectMenu('Middle', ['board.card.open', 'board.card.edit', 'board.card.next', 'board.card.prev', 'board.card.delete']);
  await expectMenu('First', ['board.card.open', 'board.card.edit', 'board.card.next', 'board.card.delete']);
  await expectMenu('Last', ['board.card.open', 'board.card.edit', 'board.card.prev', 'board.card.delete']);
  await expectMenu('With PR', ['board.card.open', 'board.card.edit', 'board.card.next', 'board.card.prev', 'board.card.pr', 'board.card.delete']);
  await expectMenu('Linked', ['board.card.open']);
  await expectMenu('No link', []);
  const session = app.locator(`.board .bcard[data-menu-session="${s.id}"]`);
  await expect(session).toBeVisible();
  await menuOn(app, session);
  expect(await usable(app)).toEqual(expect.arrayContaining(['board.card.open']));
  expect(await usable(app)).not.toContain('board.card.edit');
  expect(await usable(app)).not.toContain('board.card.delete');
  expect((await usable(app)).filter((c) => c === 'board.card.next' || c === 'board.card.prev').length).toBeGreaterThan(0);
});

test('card_menu_actions_run: open, edit, next, prev, delete with Undo and pull request do what the click and keys do', async ({ app, core }) => {
  seed(core, [...FOUR, { id: 'p1', title: 'With PR', column: 'todo', attachments: [{ session_id: 'pr-session', role: 'build' }] }]);
  await overlay(app, { ops: { pr_chip: (r) => ({ chip: r.id === 'pr-session' ? { state: 'open', url: PR, at: null } : null }) } });
  await record(app);
  await openBoard(app, core);
  const middle = cardOf(app, 'Middle');
  // Open and Edit: the card's editor, as a click on it.
  for (const op of ['board.card.open', 'board.card.edit']) {
    await menuOn(app, middle);
    await item(app, op).click();
    await expect(app.getByRole('dialog', { name: 'Edit card' })).toBeVisible();
    await app.keyboard.press('Escape');
    await expect(app.getByRole('dialog', { name: 'Edit card' })).toHaveCount(0);
  }
  // Next and Prev: board_move, as Alt+Right and Alt+Left.
  await menuOn(app, middle);
  await item(app, 'board.card.next').click();
  await expect(app.locator('.board [data-column="done"] .bcard').filter({ hasText: 'Middle' }).first()).toBeVisible();
  await expect.poll(() => column(core, 'm1')).toBe('done');
  await middle.locator('.bmain').focus();
  await app.keyboard.press('Alt+ArrowLeft');
  await expect.poll(() => column(core, 'm1')).toBe('review');
  await menuOn(app, middle);
  await item(app, 'board.card.prev').click();
  await expect.poll(() => column(core, 'm1')).toBe('needs-decision');
  await middle.locator('.bmain').focus();
  await app.keyboard.press('Alt+ArrowRight');
  await expect.poll(() => column(core, 'm1')).toBe('review');
  // Delete: gone with the Undo line; Undo puts it back in the same place.
  const review = () => app.$$eval('.board [data-column="review"] .bcard .btt', (els) => els.map((e) => e.textContent));
  await app.mouse.move(2, 2);
  await expect.poll(review).toEqual(['Middle', 'Middle two']);
  await menuOn(app, middle);
  await item(app, 'board.card.delete').click();
  await expect.poll(review).toEqual(['Middle two']);
  await expect(undoLine(app)).toContainText('Deleted card');
  await undoLine(app).getByRole('button', { name: 'Undo' }).click();
  await app.mouse.move(2, 2);
  await expect.poll(review).toEqual(['Middle', 'Middle two']);
  // Pull request: the https URL through the browser opener.
  await menuOn(app, cardOf(app, 'With PR'));
  await item(app, 'board.card.pr').click();
  expect(await opened(app)).toEqual([[PR, '_blank', 'noopener']]);
  await expect(app.getByRole('dialog', { name: 'Edit card' })).toHaveCount(0);
});

test('card_menu_actions_run: Open on a session card opens the session', async ({ app, core }) => {
  const s = core.shell(core.project('demo'), 'busy');
  core.shell(core.project('demo'), 'other');
  await openBoard(app, core);
  const card = app.locator(`.board .bcard[data-menu-session="${s.id}"]`);
  if (!(await app.locator('.board').isVisible())) await app.locator('.ib.r').getByRole('button', { name: /^Board( · |$)/ }).click(); // the zone's strip is gone (ticket 284 item 1)
  await menuOn(app, card);
  await item(app, 'board.card.open').click();
  await expect(app.locator('.tab[aria-selected="true"]')).toHaveAttribute('data-tab', s.id);
});

test('card_menu_on_session_card_keeps_board_open: a command on a live-session card runs and the Board modal stays', async ({ app, core }) => {
  const s = core.shell(core.project('demo'), 'busy');
  await openBoard(app, core);
  const card = app.locator(`.board .bcard[data-menu-session="${s.id}"]`);
  const col = () => card.evaluate((e) => e.closest('[data-column]')?.getAttribute('data-column'));
  const before = await col();
  await menuOn(app, card);
  const next = item(app, 'board.card.next');
  const op = (await next.getAttribute('aria-disabled')) === null ? next : item(app, 'board.card.prev');
  await op.click();
  await expect.poll(col).not.toBe(before);
  await expect(app.locator('.board')).toBeVisible();
});

test('card_menu_delete_is_danger: Delete is red and the last card item', async ({ app, core }) => {
  seed(core, FOUR);
  await openBoard(app, core);
  await menuOn(app, cardOf(app, 'Middle'));
  await expect(item(app, 'board.card.delete')).toHaveAttribute('data-danger', '');
  const all = await commands(app);
  expect(all.filter((c) => c!.startsWith('board.card.')).at(-1)).toBe('board.card.delete');
  expect(all.slice(all.indexOf('board.card.delete') + 1)).toEqual(['board.toggle', 'waiting.next', 'focus.composer']);
});

test('card_menu_opens_by_keyboard: Shift+F10 and the menu key on a focused card; Esc gives focus back; right-click and Ctrl+click', async ({ app, core }) => {
  seed(core, FOUR);
  await openBoard(app, core);
  const card = cardOf(app, 'Middle');
  for (const key of ['Shift+F10', 'ContextMenu']) {
    await card.locator('.bmain').focus();
    await app.keyboard.press(key);
    await expect(menu(app)).toBeVisible();
    await expect(menu(app)).toBeFocused();
    expect(await usable(app)).toContain('board.card.edit');
    await app.keyboard.press('Escape');
    await expect(menu(app)).toHaveCount(0);
    await expect(card).toBeFocused();
  }
  // Keyboard all the way: the menu key, arrows to Move to next column, Enter.
  await card.locator('.bmain').focus();
  await app.keyboard.press('Shift+F10');
  const at = (await commands(app)).indexOf('board.card.next');
  for (let i = 0; i < at; i++) await app.keyboard.press('ArrowDown');
  await app.keyboard.press('Enter');
  await expect.poll(() => column(core, 'm1')).toBe('done');
  await card.locator('.btt').click({ button: 'right' });
  await expect(menu(app)).toBeVisible();
  await app.keyboard.press('Escape');
  await card.locator('.btt').click({ modifiers: ['Control'] });
  await expect(menu(app)).toBeVisible();
});

test('card_menu_stale_key_does_nothing: a card deleted between opening the menu and choosing an item; an unknown key', async ({ app, core }) => {
  seed(core, FOUR);
  await openBoard(app, core);
  const errors: string[] = [];
  app.on('pageerror', (e) => errors.push(e.message));
  await menuOn(app, cardOf(app, 'Middle'));
  // Another window deletes the card while this menu is open.
  const other = await app.context().newPage();
  await other.addInitScript((boot) => (window.__NUNCHIRO__ = boot), core.boot());
  await openWindow(other, {}, core);
  await other.locator('.ib.r').getByRole('button', { name: /^Board( · |$)/ }).click(); // v25f: each window opens its own Board modal
  await other.locator('.board .bcard .btt', { hasText: /^Middle$/ }).click();
  await other.getByRole('dialog', { name: 'Edit card' }).getByRole('button', { name: 'Delete' }).click();
  await expect.poll(() => column(core, 'm1')).toBeUndefined();
  await other.close();
  await app.waitForTimeout(1500); // the held board still polls the live one each second
  await item(app, 'board.card.delete').click();
  await app.mouse.move(2, 2);
  await expect(cardOf(app, 'Middle')).toHaveCount(0);
  await expect(app.locator('.board .bmsg')).toHaveText('');
  await expect(app.getByText('Deleted card')).toHaveCount(0);
  // An unknown key does nothing.
  await app.evaluate(() => window.dispatchEvent(new CustomEvent('nunchiro:board.card', { detail: { op: 'delete', key: 'manual::nope' } })));
  await expect(app.locator('.board .bmsg')).toHaveText('');
  expect(column(core, 'm2')).toBe('review');
  expect(errors).toEqual([]);
});

test('list_row_menu_matches_card_menu: a list row offers the card items with the same enablement; Next matches Alt+Right', async ({ app, core }) => {
  seed(core, FOUR);
  const zone = await (await openBoard(app, core)).getAttribute('data-zone');
  await menuOn(app, cardOf(app, 'First'));
  const onCard = await usable(app);
  await app.keyboard.press('Escape');
  await app.evaluate((z) => localStorage.setItem(`nunchiro.board.view.${z}`, '{"lane":"none","density":"list"}'), zone);
  await app.reload();
  await app.mouse.move(2, 2);
  const row = (title: string) => app.locator('.board .bli').filter({ has: app.locator('.bltt', { hasText: new RegExp(`^${title}$`) }) });
  await menuOn(app, row('First'));
  expect(await usable(app)).toEqual(onCard);
  await item(app, 'board.card.next').click();
  await expect.poll(() => column(core, 'f1')).toBe('working');
  await expect(row('First').locator('.blcol')).toHaveText('Working');
  await row('First').focus();
  await app.keyboard.press('Alt+ArrowRight');
  await expect.poll(() => column(core, 'f1')).toBe('needs-decision');
  await menuOn(app, row('First'));
  await item(app, 'board.card.prev').click();
  await expect.poll(() => column(core, 'f1')).toBe('working');
  // A row's click still opens its card.
  await row('First').click();
  await expect(app.getByRole('dialog', { name: 'Edit card' })).toBeVisible();
});

test('blank_board_menu_unchanged: blank board space opens no card menu; the board items stay on the card', async ({ app, core }) => {
  seed(core, FOUR);
  await openBoard(app, core);
  await app.locator('.board .bcell[data-column="needs-decision"]').first().click({ button: 'right', position: { x: 5, y: 5 } });
  await expect(menu(app)).toHaveCount(0); // v25f: no Esc here, nothing is open but the Board modal, which Esc closes
  await menuOn(app, cardOf(app, 'Middle'));
  expect((await commands(app)).filter((c) => !c!.startsWith('board.card.'))).toEqual(['board.toggle', 'waiting.next', 'focus.composer']);
});
