// Ticket 225: New session takes a card's pending start once (web/src/board/startFromCard.ts). A later open is the plain
// popover, one not opened from a card never writes the board, and the card text is a plain value capped at 4000.
// v25-new-tab (needs 209): the popover has no message box; the card's text lands in the new session's composer, unsent.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test, type Core } from './fixtures';
import { cardOf, openBoard, overlay, seed } from './fixtures/board/coord';

const sessions = (core: Core) => core.cli('snapshot', '--json').sessions as { kind: string }[];
/** The plain route: the command palette's "New session…". */
async function paletteNew(app: Page) {
  await app.keyboard.press('Meta+KeyK');
  await app.getByRole('dialog', { name: 'Command palette' }).locator('[data-command="session.new"]').click();
  const dlg = app.getByRole('dialog', { name: 'New tab' });
  await expect(dlg).toBeVisible();
  return dlg;
}
/** A typed folder becomes the folder to start in. */
async function useFolder(dlg: ReturnType<Page['getByRole']>, dir: string) {
  await dlg.getByRole('combobox').fill(dir);
  await dlg.getByRole('option', { name: /Start in folder/ }).click();
}
async function fromCard(app: Page, title: string) {
  await cardOf(app, title).locator('.btt').click();
  await app.getByRole('dialog', { name: 'Edit card' }).getByRole('button', { name: 'Start session…', exact: true }).click();
  const dlg = app.getByRole('dialog', { name: 'New tab' });
  await expect(dlg).toBeVisible();
  return dlg;
}

test('new_session_pending_start_used_once', async ({ app, core }) => {
  const alpha = core.project('alpha');
  seed(core, [{ id: 'p1', title: 'Once only', column: 'todo' }]);
  await openBoard(app, core);
  let dlg = await fromCard(app, 'Once only');
  await expect(dlg.getByRole('textbox', { name: 'First message' })).toHaveCount(0);
  await app.keyboard.press('Escape');
  await expect(dlg).toHaveCount(0);
  // The next, plain open starts a session with an empty composer: the card's words were taken once.
  dlg = await paletteNew(app);
  await useFolder(dlg, alpha);
  await dlg.getByRole('option', { name: 'Claude', exact: true }).click();
  await expect.poll(() => sessions(core).filter((s) => s.kind === 'claude').length).toBe(1);
  await expect(app.locator('.cbox textarea').first()).toHaveValue('');
});

test('new_session_without_card_never_attaches', async ({ app, core }) => {
  const alpha = core.project('alpha');
  seed(core, [{ id: 'p2', title: 'Untouched', column: 'todo' }]);
  const puts: unknown[] = [];
  await overlay(app, { forward: { board_task_put: (r) => (puts.push(r), r) } });
  // A card's start that was cancelled leaves nothing behind for the next, plain open.
  await openBoard(app, core);
  const first = await fromCard(app, 'Untouched');
  await app.keyboard.press('Escape');
  await expect(first).toHaveCount(0);
  const dlg = await paletteNew(app);
  await useFolder(dlg, alpha);
  await dlg.getByRole('option', { name: 'Claude', exact: true }).click();
  await expect.poll(() => sessions(core).filter((s) => s.kind === 'claude').length).toBe(1);
  await app.waitForTimeout(500);
  expect(puts).toEqual([]);
});

test('new_session_prefill_is_plain_text_capped', async ({ app, core }) => {
  const alpha = core.project('alpha');
  seed(core, [{ id: 'p3', title: '<b>Bold</b> & <i>x</i>', column: 'todo' }]);
  const note = '<img src=x onerror="window.__hit=1">' + 'n'.repeat(5000);
  const file = path.join(core.home, 'board.json');
  const b = JSON.parse(fs.readFileSync(file, 'utf8'));
  b.manual[0].note = note;
  fs.writeFileSync(file, JSON.stringify(b));
  await openBoard(app, core);
  const dlg = await fromCard(app, '<b>Bold</b> & <i>x</i>');
  const text = `<b>Bold</b> & <i>x</i>\n\n${note}`.slice(0, 4000);
  await expect(dlg.locator('img')).toHaveCount(0);
  await useFolder(dlg, alpha);
  await dlg.getByRole('option', { name: 'Claude', exact: true }).click();
  await expect(app.locator('.cbox textarea').first()).toHaveValue(text);
  expect(await app.evaluate(() => (window as unknown as { __hit?: number }).__hit)).toBeUndefined();
});
