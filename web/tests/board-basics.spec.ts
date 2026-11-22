// needs 171 / 172, ticket 201: the board's missing basics (docs/areas/system.md "Basic interactions"). Real core with
// board.json seeded; the overlay answers only what a test cannot make the core do on cue (a PR and its view, a long note).
import fs from 'node:fs';
import type { Page } from '@playwright/test';
import { expect, nunchiro, test, type Core } from './fixtures';
import { cardOf, openBoard, overlay, seed } from './fixtures/board/coord';

const PR = 'https://github.com/develku/nunchiro/pull/12';
const VIEW = {
  url: PR, number: 12, title: 'Add the PR view', state: 'MERGED', draft: false, author: 'develku', body: '', created_at: '2026-10-30T10:00:00Z',
  head: '0123456789abcdef0123456789abcdef01234567', head_ref: 'herdr/pr-12', base_ref: 'main', review: 'APPROVED', mergeable: 'MERGEABLE',
  checks: 'pass', additions: 120, deletions: 34, labels: [], reviewers: [], timeline: [], files: [{ path: 'a.ts', additions: 120, deletions: 34 }], diff: '', diff_cut: false,
};

/** window.open records instead of opening; Escape keydowns that reach the window are counted. */
async function record(app: Page) {
  await app.addInitScript(() => {
    const w = window as unknown as { __opened: unknown[][]; __esc: number };
    w.__opened = [];
    w.__esc = 0;
    window.open = ((...args: unknown[]) => (w.__opened.push(args), null)) as typeof window.open;
    window.addEventListener('keydown', (e) => e.key === 'Escape' && w.__esc++);
  });
}
const opened = (app: Page) => app.evaluate(() => (window as unknown as { __opened: unknown[][] }).__opened);
const escapes = (app: Page) => app.evaluate(() => (window as unknown as { __esc: number }).__esc);
const selected = (app: Page) => app.locator('.tab[aria-selected="true"]');

/** A task card in Done with a merged PR (its attached session's chip and view come from the overlay). */
async function doneCard(app: Page, core: Core) {
  seed(core, [{ id: '7', title: 'Shipped task', column: 'done', attachments: [{ session_id: 'pr-session', role: 'build' }] }]);
  await overlay(app, { ops: { pr_chip: () => ({ chip: { state: 'merged', url: PR, at: null } }), pr_view: () => ({ view: VIEW }) } });
  await record(app);
  await openBoard(app, core);
  const card = cardOf(app, 'Shipped task');
  await expect(card.locator('.bfact')).toContainText('Merged #12');
  return card;
}

test('details_popover_esc_outside: Esc closes and returns focus, a press outside closes, the toggle still closes', async ({ app, core }) => {
  const card = await doneCard(app, core);
  const details = card.getByRole('button', { name: 'Details' });
  const popover = card.getByRole('group', { name: 'Pull request detail' });
  await details.click();
  await expect(popover).toBeVisible();
  await app.keyboard.press('Escape');
  await expect(popover).toHaveCount(0);
  await expect(details).toBeFocused();
  expect(await escapes(app)).toBe(0); // an outer dialog or the window never sees it
  await details.click();
  await expect(popover).toBeVisible();
  await app.locator('.board .bsummary').click();
  await expect(popover).toHaveCount(0);
  await expect(app.getByRole('dialog', { name: 'Edit card' })).toHaveCount(0);
  await details.click();
  await popover.locator('.bdh').click(); // a press inside keeps it
  await expect(popover).toBeVisible();
  await card.getByRole('button', { name: 'Hide' }).click();
  await expect(popover).toHaveCount(0);
});

test('pr_number_opens_pr: "Merged #12" is a button that opens the PR in the browser (click and Enter), names the host, never opens the card', async ({ app, core }) => {
  const card = await doneCard(app, core);
  const number = card.locator('.bfact').getByRole('button', { name: 'Merged #12', exact: true });
  await expect(number).toHaveAttribute('title', /github\.com/);
  await number.click();
  expect(await opened(app)).toEqual([[PR, '_blank', 'noopener']]);
  await number.focus();
  await app.keyboard.press('Enter');
  expect(await opened(app)).toHaveLength(2);
  await expect(app.getByRole('dialog', { name: 'Edit card' })).toHaveCount(0);
});

test('chip_opens_session: a live chip is a button that opens its session (click and Enter); a gone chip is plain text', async ({ app, core }) => {
  const p = core.project('nunchiro');
  const [opus, sonnet] = ['Opus', 'Sonnet'].map((l) => core.shell(p, l));
  seed(core, [{ id: '12', title: 'Chip task', column: 'working', attachments: [{ session_id: opus.id, role: 'build' }, { session_id: sonnet.id, role: 'review' }, { session_id: 'nobody-here', role: 'docs' }] }]);
  await openBoard(app, core);
  const card = cardOf(app, 'Chip task');
  await card.getByRole('button', { name: /Opus/ }).click();
  await expect(selected(app)).toHaveAttribute('data-tab', opus.id);
  await expect(app.getByRole('dialog', { name: 'Edit card' })).toHaveCount(0);
  // Opening a session brings its terminal to the front of the board's zone (UXFIX (c): LayoutView's reveal, an effect after
  // the tab is selected), so the board's visibility is read once that terminal shows; then back to the board.
  await expect(app.locator(`.term[data-session="${opus.id}"]`)).toBeVisible();
  if (!(await app.locator('.board').isVisible())) await app.locator('.ib.r').getByRole('button', { name: /^Board( · |$)/ }).click(); // the zone's strip is gone (ticket 284 item 1)
  const sonnetChip = card.getByRole('button', { name: /Sonnet/ });
  await expect(sonnetChip).toBeVisible();
  await sonnetChip.focus();
  await expect(sonnetChip).toBeFocused(); // Enter goes to the chip, not to the body or the terminal
  await app.keyboard.press('Enter');
  await expect(selected(app)).toHaveAttribute('data-tab', sonnet.id);
  await expect(app.getByRole('dialog', { name: 'Edit card' })).toHaveCount(0);
  await app.locator('.ib.r').getByRole('button', { name: /^Board( · |$)/ }).click(); // v25f: opening a session closed the Board modal
  const gone = card.locator('.bra').filter({ hasText: 'session gone' });
  await expect(gone).toHaveText('docs ○ session gone');
  await expect(card.getByRole('button', { name: /session gone/ })).toHaveCount(0);
});

async function start(core: Core, project: string, label: string, token?: string) {
  const env = token ? { ...core.env, NUNCHIRO_TOKEN: token } : core.env;
  const args = ['session', 'start', '--kind', 'shell', '--project', project, '--label', label, '--', '/bin/sh', '-c', 'printf "TOKEN:%s\\n" "$NUNCHIRO_TOKEN"; exec cat'];
  const id = (JSON.parse(nunchiro(env, args)).session as { id: string }).id;
  let own = '';
  await expect.poll(() => (own = /TOKEN:(\S+)/.exec(core.read(id))?.[1] ?? '')).not.toBe('');
  return { id, token: own };
}

test('coordinator_opens_session: the coordinator name is a button named by the session that opens it', async ({ app, core }) => {
  const p = core.project('orch');
  const coord = await start(core, p, 'coord-1031');
  await start(core, p, 'w1', coord.token);
  const board = await openBoard(app, core);
  const indicator = board.locator('.bcoord');
  await expect(indicator).toContainText('Coordinator: coord-1031 · 1 child sessions');
  await indicator.getByRole('button', { name: 'coord-1031', exact: true }).click();
  await expect(selected(app)).toHaveAttribute('data-tab', coord.id);
});

test('truncated_text_has_title: a card note and a chip carry their full text in the tooltip', async ({ app, core }) => {
  const note = 'A long note that the card cuts after its second line, so the rest must be readable on hover without opening it';
  const s = core.shell(core.project('nunchiro'), 'Assignee with a very long session label');
  seed(core, [{ id: '3', title: 'Noted task', column: 'review', attachments: [{ session_id: s.id, role: 'implementation-review' }] }]);
  await overlay(app, { board: (b) => ({ ...b, cards: (b.cards as { id: string }[]).map((c) => (c.id === '3' ? { ...c, note } : c)) }) });
  await openBoard(app, core);
  const card = cardOf(app, 'Noted task');
  await expect(card.locator('.bnote')).toHaveAttribute('title', note);
  const chip = card.locator('.bra');
  await expect(chip).toHaveAttribute('title', /implementation-review/);
  await expect(chip).toHaveAttribute('title', /Assignee with a very long session label/);
});

test('list_fold_and_alt_move: list lanes fold like the grid, Alt+arrows move the focused row as on a card', async ({ app, core }) => {
  seed(core, [
    { id: 'a1', title: 'M1 first', column: 'todo', group: 'M1' },
    { id: 'a2', title: 'M1 second', column: 'todo', group: 'M1' },
    { id: 'b1', title: 'M2 only', column: 'working', group: 'M2' },
  ]);
  // The one-line list density in the board's own zone (the saved view, as the edit panel writes it).
  const zone = await (await openBoard(app, core)).getAttribute('data-zone');
  await app.evaluate((z) => localStorage.setItem(`nunchiro.board.view.${z}`, '{"lane":"group","density":"list"}'), zone);
  await app.reload();
  await app.mouse.move(2, 2);
  const list = app.locator('.board').getByRole('list', { name: 'Cards' });
  await expect(list.locator('.bltt')).toHaveText(['M2 only', 'M1 first', 'M1 second']);
  // Fold: the lane's header is a button with aria-expanded, as in the grid.
  const m2 = list.getByRole('button', { name: 'M2', exact: true });
  await expect(m2).toHaveAttribute('aria-expanded', 'true');
  await m2.click();
  await expect(m2).toHaveAttribute('aria-expanded', 'false');
  await expect(list.locator('.bltt')).toHaveText(['M1 first', 'M1 second']);
  await m2.press('Enter');
  await expect(list.locator('.bltt')).toHaveText(['M2 only', 'M1 first', 'M1 second']);
  // Alt+Down passes one card, Alt+Right moves to the next column; focus stays on the moved row.
  const row = (title: string) => list.locator('.bli').filter({ has: app.locator('.bltt', { hasText: title }) });
  await row('M1 first').focus();
  await app.keyboard.press('Alt+ArrowDown');
  await expect(list.locator('.bltt')).toHaveText(['M2 only', 'M1 second', 'M1 first']);
  await expect(row('M1 first')).toBeFocused();
  await app.keyboard.press('Alt+ArrowRight');
  await expect(row('M1 first').locator('.blcol')).toHaveText('Working');
  await expect(row('M1 first')).toBeFocused();
  await expect.poll(() => JSON.parse(fs.readFileSync(`${core.home}/board.json`, 'utf8')).manual.find((c: { id: string }) => c.id === 'a1').column).toBe('working');
  await expect(app.getByRole('dialog', { name: 'Edit card' })).toHaveCount(0);
});

test('column_title_esc_reverts_blur_safe: Esc reverts the field and keeps the editor, blur reverts, Enter commits; Alt+Up reorders a folded row', async ({ app, core }) => {
  seed(core, []);
  const board = await openBoard(app, core);
  const heads = board.locator('.bch b');
  await board.getByRole('button', { name: 'Columns', exact: true }).click();
  const dialog = app.getByRole('dialog', { name: 'Columns' });
  const title = dialog.getByLabel('Title of column 2');
  await title.fill('Typed');
  await title.press('Escape');
  await expect(title).toHaveValue('Working');
  await expect(dialog).toBeVisible();
  await title.fill('Blurred');
  await dialog.getByLabel('Title of column 1').focus();
  await expect(title).toHaveValue('Working');
  await expect(heads.nth(1)).toHaveText('Working');
  await title.fill('Doing');
  await title.press('Enter');
  await expect(heads.nth(1)).toHaveText('Doing');
  await dialog.getByRole('button', { name: 'Close' }).click();
  // The edit panel's rows are folded (no move buttons): Alt+Up and Alt+Down on a title move its column.
  await board.getByRole('button', { name: 'Edit board widget' }).click();
  const panel = app.getByRole('dialog', { name: 'Edit board widget' });
  await expect(panel.getByRole('button', { name: 'Move column 2 left' })).toHaveCount(0);
  await panel.getByLabel('Title of column 2').focus();
  await app.keyboard.press('Alt+ArrowUp');
  await expect(heads.first()).toHaveText('Doing');
  await expect(panel.getByLabel('Title of column 1')).toBeFocused();
  await app.keyboard.press('Alt+ArrowDown');
  await expect(heads.nth(1)).toHaveText('Doing');
});

test('gone_chip_tooltip: a chip whose session is gone says "<role> · session gone" in its tooltip and is no button', async ({ app, core }) => {
  seed(core, [{ id: '21', title: 'Gone task', column: 'todo', attachments: [{ session_id: 'nobody-here', role: 'docs' }, { session_id: 'nobody-else', role: '' }] }]);
  await openBoard(app, core);
  const chips = cardOf(app, 'Gone task').locator('.bra');
  await expect(chips).toHaveCount(2);
  await expect(chips.nth(0)).toHaveAttribute('title', 'docs · session gone');
  await expect(chips.nth(1)).toHaveAttribute('title', '— · session gone');
  for (const i of [0, 1]) expect(await chips.nth(i).evaluate((e) => e.tagName)).toBe('SPAN');
  await expect(cardOf(app, 'Gone task').getByRole('button', { name: /session gone/ })).toHaveCount(0);
});

// ticket 210 C7a: "needs you" on a column with nothing in it reads as an alert at 0; it takes the muted colours of the zero count.
test('board_zero_needs_you_label_is_muted: an empty needs-you column is muted, one holding a card keeps the alert style', async ({ app, core }) => {
  seed(core, []);
  await openBoard(app, core);
  const column = app.locator('.board [data-column="needs-decision"]');
  const label = column.locator('.bnd');
  const colours = (loc: typeof label) => loc.evaluate((el) => ({ color: getComputedStyle(el).color, border: getComputedStyle(el).borderTopColor }));
  await expect(label).toHaveText('needs you');
  const zero = await colours(column.locator('.bcount'));
  expect(await colours(label)).toEqual(zero); // the neutral colours of the other zero counts, no alert colour
  await expect(label).toHaveAttribute('title', /.+/); // the hint stays
  // A card in the column brings the alert style back.
  await app.locator('.board').getByRole('button', { name: '+ Card' }).first().click();
  const dialog = app.getByRole('dialog', { name: 'New card' });
  await dialog.getByLabel('Title').fill('Decide');
  await dialog.getByLabel('Column').selectOption('needs-decision');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(cardOf(app, 'Decide')).toBeVisible();
  await expect(column.locator('.bcount')).toHaveText('1');
  const alert = await colours(label);
  expect(alert.color).not.toEqual(zero.color);
  expect(alert.border).not.toEqual(zero.border);
});
