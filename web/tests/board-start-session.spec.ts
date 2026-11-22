// Ticket 225 (needs 154 (1), needs 178 B7): "Start session…" in the card editor opens New session prefilled with the
// card's title, note and project; the user's own Start attaches the new session to the card as its worker through
// `board_task_put`. The lane never starts a session itself: Esc starts nothing and leaves the card as it was.
// v25-new-tab (ticket 290, needs 209): New session is the tab "+" popover now. The card's words wait in the new session's
// composer (typed there, not sent: needs 186 (2)); the popover has no message box, so "Start in background" is gone.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test, type Core } from './fixtures';
import { cardOf, openBoard, overlay, seed, type Seed } from './fixtures/board/coord';

type Manual = { id: string; note: string; attachments: { session_id: string; role: string }[] };
const store = (core: Core) => JSON.parse(fs.readFileSync(path.join(core.home, 'board.json'), 'utf8')) as { manual: Manual[] };
/** seed() writes every note empty; these cards carry one. */
function seedNotes(core: Core, cards: (Seed & { note?: string })[]) {
  seed(core, cards);
  const b = store(core);
  for (const m of b.manual) m.note = cards.find((c) => c.id === m.id)?.note ?? '';
  fs.writeFileSync(path.join(core.home, 'board.json'), JSON.stringify(b));
}
const sessions = (core: Core) => core.cli('snapshot', '--json').sessions as { id: string; project: string; kind: string }[];

/** The card's title: its centre may be an assignee chip, which opens that session instead of the editor. */
const openCard = (app: Page, title: string) => cardOf(app, title).locator('.btt').click();
/** Board → card (click 1) → the editor's labelled button (click 2) → the New tab popover. */
async function startFrom(app: Page, title: string, name: RegExp = /^Start session…$/) {
  await openCard(app, title);
  const editor = app.getByRole('dialog', { name: 'Edit card' });
  await editor.getByRole('button', { name }).click();
  const dlg = app.getByRole('dialog', { name: 'New tab' });
  await expect(dlg).toBeVisible();
  await expect(editor).toHaveCount(0);
  return dlg;
}
/** A folder typed in the search becomes the folder to start in (a project with no session yet is not listed). */
async function useFolder(dlg: ReturnType<Page['getByRole']>, dir: string) {
  await dlg.getByRole('combobox').fill(dir);
  await dlg.getByRole('option', { name: /Start in folder/ }).click();
  await expect(dlg).toContainText(`in ${path.basename(dir)}`);
}
const startClaude = (dlg: ReturnType<Page['getByRole']>) => dlg.getByRole('option', { name: 'Claude', exact: true }).click();

test('board_card_start_session_opens_prefilled_new_session', async ({ app, core }) => {
  const alpha = core.project('alpha');
  const s = core.shell(alpha, 'linked');
  seedNotes(core, [{ id: 'c1', title: 'Fix the login', column: 'todo', session_id: s.id, note: 'Steps:\n1. open\n2. sign in' }]);
  await openBoard(app, core);
  const dlg = await startFrom(app, 'Fix the login');
  // No message box in the popover; the folder is the card's project.
  await expect(dlg.getByRole('textbox', { name: 'First message' })).toHaveCount(0);
  await expect(dlg).toContainText('in alpha');
  await startClaude(dlg);
  // The card's words wait in the new session's composer, unsent.
  await expect.poll(() => sessions(core).filter((x) => x.kind === 'claude').length).toBe(1);
  await expect(app.locator('.cbox textarea').first()).toHaveValue('Fix the login\n\nSteps:\n1. open\n2. sign in');
});

test('board_started_session_attached_as_card_worker', async ({ app, core }) => {
  const alpha = core.project('alpha');
  // An attachment whose session is gone stays on the card: the new worker is added beside it.
  seedNotes(core, [{ id: 'c2', title: 'Ship it', column: 'todo', attachments: [{ session_id: 'gone-one', role: 'build' }] }]);
  const puts: unknown[] = [];
  await overlay(app, { forward: { board_task_put: (r) => (puts.push(r), r) } });
  await openBoard(app, core);
  const dlg = await startFrom(app, 'Ship it');
  await useFolder(dlg, alpha);
  await startClaude(dlg);
  await expect(dlg).toHaveCount(0);
  await expect.poll(() => sessions(core).filter((x) => x.kind === 'claude').length).toBe(1);
  const id = sessions(core).find((x) => x.kind === 'claude')!.id;
  await expect.poll(() => store(core).manual[0].attachments).toEqual([
    { session_id: 'gone-one', role: 'build' },
    { session_id: id, role: 'worker' },
  ]);
  expect(puts).toHaveLength(1);
  // The new session took the centre; back on the Board tab the card shows it: a live worker chip beside the gone build
  // chip (the board holds still under the pointer, needs 26).
  await app.locator('.ib.r').getByRole('button', { name: /^Board( · |$)/ }).click(); // the zone's Board tab is gone (ticket 284 item 1): the icon shows the board behind the new session
  await app.mouse.move(2, 2);
  await expect(cardOf(app, 'Ship it').locator('button.bra')).toContainText('worker');
});

test('board_start_session_does_not_start_without_user_confirm', async ({ app, core }) => {
  core.project('alpha');
  seedNotes(core, [{ id: 'c3', title: 'Not yet', column: 'todo', note: 'later' }]);
  const ops: string[] = [];
  await overlay(app, { forward: { start: (r) => (ops.push('start'), r), board_task_put: (r) => (ops.push('board_task_put'), r) } });
  await openBoard(app, core);
  const before = JSON.stringify(store(core).manual);
  const dlg = await startFrom(app, 'Not yet');
  await app.keyboard.press('Escape');
  await expect(dlg).toHaveCount(0);
  await app.waitForTimeout(300);
  expect(ops).toEqual([]);
  expect(sessions(core)).toEqual([]);
  expect(JSON.stringify(store(core).manual)).toBe(before);
});

test('board_start_session_button_label_for_card_with_live_worker', async ({ app, core }) => {
  const alpha = core.project('alpha');
  const w = core.shell(alpha, 'worker-1');
  seed(core, [
    { id: 'c4', title: 'Busy card', column: 'working', attachments: [{ session_id: w.id, role: 'worker' }] },
    { id: 'c5', title: 'Idle card', column: 'todo', attachments: [{ session_id: 'gone-two', role: 'build' }] },
    { id: 'c6', title: 'Done card', column: 'done' },
  ]);
  await openBoard(app, core);
  const editor = app.getByRole('dialog', { name: 'Edit card' });
  await openCard(app, 'Busy card');
  await expect(editor.getByRole('button', { name: 'Start another session…' })).toBeVisible();
  await expect(editor.getByRole('button', { name: 'Start session…', exact: true })).toHaveCount(0);
  await app.keyboard.press('Escape');
  await openCard(app, 'Idle card');
  // A gone attachment is no live worker: the plain label.
  await expect(editor.getByRole('button', { name: 'Start session…', exact: true })).toBeVisible();
  await app.keyboard.press('Escape');
  // rc2b-fb item 4 (needs 190 (2)): a Done card's click opens its details in place; its editor is the menu's Edit card.
  await cardOf(app, 'Done card').locator('.btt').click({ button: 'right' });
  await app.getByRole('menuitem', { name: /^Edit card/ }).click();
  await expect(editor).toBeVisible();
  await expect(editor.getByRole('button', { name: /^Start (another )?session…$/ })).toHaveCount(0);
  await app.keyboard.press('Escape');
  // A new card has no id to attach to: no button there either.
  await app.locator('.board').getByRole('button', { name: '+ Card', exact: true }).click();
  const added = app.getByRole('dialog', { name: 'New card' });
  await expect(added).toBeVisible();
  await expect(added.getByRole('button', { name: /^Start (another )?session…$/ })).toHaveCount(0);
});

test('board_start_session_button_basics: a real button, Enter and Space open the dialog, a focus ring, Esc returns', async ({ app, core, browserName }) => {
  // WebKit's Tab skips buttons unless Full Keyboard Access is on; Option+Tab walks every control (ticket 478).
  const tab = browserName === 'webkit' ? 'Alt+Tab' : 'Tab';
  core.project('alpha');
  seed(core, [{ id: 'c7', title: 'Keys', column: 'todo' }]);
  await openBoard(app, core);
  for (const key of ['Enter', 'Space']) {
    await openCard(app, 'Keys');
    const button = app.getByRole('dialog', { name: 'Edit card' }).getByRole('button', { name: 'Start session…', exact: true });
    expect(await button.evaluate((el) => el.tagName)).toBe('BUTTON');
    // By keyboard (Tab from the title), so the shared :focus-visible ring shows.
    for (let i = 0; i < 8 && !(await button.evaluate((el) => el === document.activeElement)); i++) await app.keyboard.press(tab);
    await expect(button).toBeFocused();
    expect(await button.evaluate((el) => getComputedStyle(el).outlineStyle)).not.toBe('none');
    await app.keyboard.press(key);
    const dlg = app.getByRole('dialog', { name: 'New tab' });
    await expect(dlg).toBeVisible();
    await app.keyboard.press('Escape');
    await expect(dlg).toHaveCount(0);
  }
});

test('board_start_session_attach_refusal_is_noted_not_retried', async ({ app, core }) => {
  const alpha = core.project('alpha');
  seed(core, [{ id: 'c8', title: 'Refused', column: 'todo' }]);
  const puts: unknown[] = [];
  // The core refuses: the write names a card that is not there.
  await overlay(app, { forward: { board_task_put: (r) => (puts.push(r), { ...r, id: 'no-such-card' }) } });
  await openBoard(app, core);
  const dlg = await startFrom(app, 'Refused');
  await useFolder(dlg, alpha);
  await startClaude(dlg);
  await expect(app.getByText(/^Started, but could not attach to the card: /)).toBeVisible();
  // The session still started; the write went once and the card is unchanged.
  await expect.poll(() => sessions(core).filter((x) => x.kind === 'claude').length).toBe(1);
  await app.waitForTimeout(500);
  expect(puts).toHaveLength(1);
  expect(store(core).manual[0].attachments).toEqual([]);
});

// Needs 186 (2), ticket 227: a card's start only leaves its words in the composer; nothing is sent (v25-new-tab: the popover has no
// "Start in background", needs 209 item 2).
test('board_start_prefills_composer_without_sending', async ({ app, core }) => {
  const alpha = core.project('alpha');
  seedNotes(core, [{ id: 'c9', title: 'Send me', column: 'todo', note: 'the note' }]);
  const prompts: { id: string; text: string }[] = [];
  await overlay(app, { forward: { agent_prompt: (r) => (prompts.push(r as { id: string; text: string }), r) } });
  await openBoard(app, core);
  const dlg = await startFrom(app, 'Send me');
  await useFolder(dlg, alpha);
  await startClaude(dlg);
  await expect.poll(() => sessions(core).filter((x) => x.kind === 'claude').length).toBe(1);
  await expect.poll(() => store(core).manual[0].attachments.map((a) => a.role)).toEqual(['worker']);
  await expect(app.locator('.cbox textarea').first()).toHaveValue('Send me\n\nthe note');
  await app.waitForTimeout(500);
  expect(prompts).toEqual([]);
});
