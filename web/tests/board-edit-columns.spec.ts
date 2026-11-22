// V2.5-38 (ticket 186, needs 155 draft B): the pencil's edit panel edits columns through the ColumnEditor path and
// `board_columns_put` (revision checked). Real core; every route starts at the labelled Board icon and the pencil.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, openWindow, test, type Core } from './fixtures';
import { openBoard } from './fixtures/board/coord';

const toml = (core: Core) => path.join(core.home, 'board.toml');
const titles = (app: Page) => app.locator('.board .bch b').allInnerTexts();

/** The labelled Board icon (one click), then the pencil (two): the edit panel. */
async function editPanel(app: Page, core?: Core) {
  const board = await openBoard(app, core);
  await board.getByRole('button', { name: 'Edit board widget' }).click();
  const panel = app.getByRole('dialog', { name: 'Edit board widget' });
  await expect(panel).toBeVisible();
  return panel;
}
async function rename(panel: ReturnType<Page['getByRole']>, n: number, title: string) {
  await panel.getByLabel(`Title of column ${n}`).fill(title);
  await panel.getByLabel(`Title of column ${n}`).press('Enter');
}

test('board_edit_columns_round_trip: add, rename, drag-reorder and Done proof survive reload and a core restart', async ({ app, core }) => {
  const panel = await editPanel(app, core);
  await expect.poll(() => titles(app)).toEqual(['To do', 'Working', 'Needs decision', 'Review', 'Done']);
  await panel.getByRole('button', { name: '+ Add column' }).click();
  await expect.poll(() => titles(app)).toEqual(['To do', 'Working', 'Needs decision', 'Review', 'Done', 'Column 6']);
  // A 9-character Korean title.
  const korean = '디자인검토대기열임';
  expect([...korean].length).toBe(9);
  await rename(panel, 6, korean);
  await expect.poll(() => titles(app)).toEqual(['To do', 'Working', 'Needs decision', 'Review', 'Done', korean]);
  // Drag its handle onto the first row: it takes that place, the rest keep their order.
  await panel.locator('[data-column-row="column-6"] .bgrip').dragTo(panel.locator('[data-column-row="todo"]'));
  await expect.poll(() => titles(app)).toEqual([korean, 'To do', 'Working', 'Needs decision', 'Review', 'Done']);
  // Done's proof (on by default) off: the Done header loses its proof badge and board.toml says so.
  const proof = panel.getByRole('switch', { name: 'receipt required (proof)' });
  await expect(proof).toBeChecked();
  await expect(app.locator('.board .bcol[data-head="done"] .bproof')).toHaveText('proof');
  await proof.click();
  await expect(proof).not.toBeChecked();
  await expect(app.locator('.board .bcol[data-head="done"] .bproof')).toHaveCount(0);
  await expect.poll(() => fs.readFileSync(toml(core), 'utf8')).toMatch(/id = "done"\ntitle = "Done"\nstates = \["done"\]\nproof = false\n/);
  const written = fs.readFileSync(toml(core), 'utf8');
  expect(written.indexOf('id = "column-6"')).toBeLessThan(written.indexOf('id = "todo"'));
  // Reload, then a fresh core on the same home: the same board.
  await app.reload();
  await expect.poll(() => titles(app)).toEqual([korean, 'To do', 'Working', 'Needs decision', 'Review', 'Done']);
  core.run(['serve', 'stop', '--yes']);
  await core.restart();
  // A fresh core writes a fresh window token: the window opens again with it.
  await app.addInitScript((boot) => (window.__NUNCHIRO__ = boot), core.boot());
  await openWindow(app, {}, core);
  await expect.poll(() => titles(app)).toEqual([korean, 'To do', 'Working', 'Needs decision', 'Review', 'Done']);
  await expect(app.locator('.board .bcol[data-head="done"] .bproof')).toHaveCount(0);
  expect(fs.readFileSync(toml(core), 'utf8')).toBe(written);
});

test('board_edit_columns_round_trip edge: an existing or empty name is refused with a line; a 200-character name is kept', async ({ app, core }) => {
  const panel = await editPanel(app, core);
  await expect.poll(() => titles(app)).toEqual(['To do', 'Working', 'Needs decision', 'Review', 'Done']);
  // First a real write, so the refusals below are checked against an existing file.
  await rename(panel, 1, 'Backlog');
  await expect.poll(() => titles(app)).toEqual(['Backlog', 'Working', 'Needs decision', 'Review', 'Done']);
  const before = fs.readFileSync(toml(core), 'utf8');
  await rename(panel, 2, 'Review');
  await expect(panel.getByRole('alert')).toHaveText('another column is already called Review');
  await rename(panel, 2, '   ');
  await expect(panel.getByRole('alert')).toHaveText('column title: 1 to 256 bytes');
  expect(fs.readFileSync(toml(core), 'utf8')).toBe(before);
  expect(await titles(app)).toEqual(['Backlog', 'Working', 'Needs decision', 'Review', 'Done']);
  const long = 'L'.repeat(200);
  await rename(panel, 2, long);
  await expect.poll(() => titles(app)).toEqual(['Backlog', long, 'Needs decision', 'Review', 'Done']);
  await expect(panel.getByRole('alert')).toHaveCount(0);
  expect(fs.readFileSync(toml(core), 'utf8')).toContain(`title = "${long}"`);
});

test('board_edit_columns_round_trip edge: a stale revision (another window saved first) shows the conflict line and writes nothing', async ({ app, core }) => {
  const panel = await editPanel(app, core);
  await rename(panel, 1, 'First');
  await expect.poll(() => titles(app)).toEqual(['First', 'Working', 'Needs decision', 'Review', 'Done']);
  const other = await app.context().newPage();
  await other.addInitScript((boot) => (window.__NUNCHIRO__ = boot), core.boot());
  // v25f: each window opens its own Board modal, then its pencil.
  await openWindow(other, {}, core);
  await other.locator('.ib.r').getByRole('button', { name: /^Board( · |$)/ }).click();
  await other.locator('.board').getByRole('button', { name: 'Edit board widget' }).click();
  const otherPanel = other.getByRole('dialog', { name: 'Edit board widget' });
  // The second window holds its board (focus inside), then the first one writes.
  await otherPanel.getByLabel('Title of column 2').focus();
  await rename(panel, 1, '첫 창');
  await expect.poll(() => fs.readFileSync(toml(core), 'utf8')).toContain('title = "첫 창"');
  const saved = fs.readFileSync(toml(core), 'utf8');
  await rename(otherPanel, 2, '둘째 창');
  await expect(otherPanel.getByRole('alert')).toHaveText('board.toml was changed elsewhere and has been reloaded. Make your change again.');
  expect(fs.readFileSync(toml(core), 'utf8')).toBe(saved);
  await other.close();
});

test('board_edit_columns_round_trip: the pencil is a visible labelled control and the panel closes with Done', async ({ app, core }) => {
  await openWindow(app, {}, core);
  await app.locator('.ib.r').getByRole('button', { name: /^Board( · |$)/ }).click();
  const pencil = app.locator('.board').getByRole('button', { name: 'Edit board widget' });
  await expect(pencil).toBeVisible();
  await expect(pencil).toHaveAttribute('aria-pressed', 'false');
  await pencil.click();
  await expect(pencil).toHaveAttribute('aria-pressed', 'true');
  const panel = app.getByRole('dialog', { name: 'Edit board widget' });
  await expect(panel.locator('.bepfoot')).toHaveText("Saved: board.toml · this widget's view is saved with its zone (can sit in any zone)");
  // Rows are one line (draft B); "Claimed states…" opens each row's decision, states, move and delete controls.
  await expect(panel.getByRole('group', { name: 'States column 1 takes' })).toHaveCount(0);
  await panel.getByRole('button', { name: 'Claimed states…' }).click();
  await expect(panel.getByRole('button', { name: 'Claimed states…' })).toHaveAttribute('aria-expanded', 'true');
  await expect(panel.getByRole('group', { name: 'States column 1 takes' })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Delete column 5' })).toBeVisible();
  // "Rename" selects the title of the row last focused.
  await panel.getByLabel('Title of column 2').focus();
  await panel.getByRole('button', { name: 'Rename' }).click();
  await expect(panel.getByLabel('Title of column 2')).toBeFocused();
  await panel.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(panel).toHaveCount(0);
});

// needs 162 (draft B): the ⋮⋮ column handle stays visible without hover or focus, on a desktop and a touch-sized window.
test('board_column_handle_always_visible: in edit mode every column handle is shown with the pointer away, at 1440 and 390 px', async ({ app, core }) => {
  const panel = await editPanel(app, core);
  for (const width of [1440, 390]) {
    await app.setViewportSize({ width, height: 900 });
    await expect(panel).toBeVisible();
    await app.mouse.move(1, 1); // parked away from the column rows
    await app.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    const grips = panel.locator('[data-column-row] .bgrip');
    await expect(grips).toHaveCount(5);
    for (const grip of await grips.all()) {
      const shown = await grip.evaluate((e) => {
        const cs = getComputedStyle(e);
        const r = e.getBoundingClientRect();
        return { opacity: cs.opacity, visibility: cs.visibility, display: cs.display, w: r.width, h: r.height, text: e.textContent };
      });
      expect(shown, `${width} px`).toMatchObject({ opacity: '1', visibility: 'visible' });
      expect(shown.display, `${width} px`).not.toBe('none');
      expect(shown.w * shown.h, `${width} px`).toBeGreaterThan(0);
      expect(shown.text?.trim(), `${width} px`).toBe('⋮⋮');
      await expect(grip).toBeInViewport();
    }
  }
});
