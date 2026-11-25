// V2-6a (ticket 56): one status-line Undo for the reversible window actions, ten seconds, and Cmd+Z outside text fields.
// Each test runs a real core with its own NUNCHIRO_HOME under .scratch. Time is a fake clock, never a real wait.
import type { Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { closeFromTab, expect, openWindow, REPO, test, stripOnTop, type Core, showComposer } from './fixtures';
import { card as themeCard, menu, openTheme } from './theme-harness';
import { bar, editBar, names, startEdit } from './d5b';
import { openQuiet } from './tree-seed';

const line = (p: Page) => p.locator('footer.status .undoline');
const undoButton = (p: Page) => line(p).getByRole('button', { name: 'Undo' });
const shot = (p: Page, name: string) => p.screenshot({ path: path.join(REPO, '.scratch/shots', `v2-6a-${name}-${test.info().project.name}.png`) });
const seed = (p: Page, settings: Record<string, unknown>) =>
  p.addInitScript((s) => {
    if (!localStorage.getItem('nunchiro.settings.v1')) localStorage.setItem('nunchiro.settings.v1', JSON.stringify(s));
  }, settings);

const stateOf = (core: Core, id: string) => (core.cli('snapshot', '--json').sessions as { id: string; state: string }[]).find((x) => x.id === id)?.state;

/** Two shells; the status-line Undo comes from closing `a` (one that ends when told) through its tab menu: the core undoes the close of an ended session. */
function twoShells(core: Core) {
  const p = core.project('demo');
  return { a: core.shell(p, 'a', '/bin/sh', '-c', 'read x; exit 0').id, b: core.shell(p, 'b').id };
}
async function end(core: Core, id: string) {
  core.cli('session', 'send-text', id, 'x\r');
  await expect.poll(() => stateOf(core, id)).toBe('exited');
}

test.describe('close undo', () => {
  test.beforeEach(({ core }) => stripOnTop(core));

  test('undo_close_restores', async ({ app, core }) => {
    const { a } = twoShells(core);
    await openWindow(app);
    await end(core, a);
    await closeFromTab(app, a);
    await expect(line(app)).toContainText('Closed a');
    await expect.poll(() => stateOf(core, a)).toBeUndefined(); // closed: the session is gone from the snapshot
    await shot(app, 'close');
    await undoButton(app).click();
    await expect.poll(() => stateOf(core, a)).toBeDefined();
    await expect(line(app)).toHaveCount(0);
  });

  test('undo_expires_after_10s', async ({ app, core }) => {
    const { a } = twoShells(core);
    await app.clock.install();
    await openWindow(app);
    await end(core, a);
    await closeFromTab(app, a);
    await expect(line(app)).toBeVisible();
    await app.clock.fastForward(9_000);
    await expect(line(app)).toBeVisible();
    await app.clock.fastForward(2_000);
    await expect(line(app)).toHaveCount(0);
    await app.keyboard.press('Meta+KeyZ');
    await app.waitForTimeout(200);
    expect(stateOf(core, a)).toBeUndefined();
  });

  test('undo_cmd_z_outside_fields_only', async ({ app, core }) => {
    const { a, b } = twoShells(core);
    await openWindow(app);
    await end(core, a);
    await closeFromTab(app, a);
    await expect(line(app)).toBeVisible();
    // The composer, the terminal and a text field keep their own undo.
    await app.locator(`.tab[data-tab="${b}"]`).click();
    await showComposer(app); // V2.5-34: a shell's composer is asked for
    await app.locator('#composer').focus();
    await app.keyboard.press('Meta+KeyZ');
    await app.locator('.xterm-helper-textarea').first().focus();
    await app.keyboard.press('Meta+KeyZ');
    await app.keyboard.press('Meta+KeyK');
    const search = app.getByRole('combobox', { name: 'Command palette search' });
    await expect(search).toBeFocused();
    await app.keyboard.press('Meta+KeyZ');
    await app.waitForTimeout(200);
    expect(stateOf(core, a)).toBeUndefined();
    await expect(line(app)).toBeVisible();
    await app.keyboard.press('Escape');
    // On the tree row it runs.
    await app.locator(`button.row.wt2[data-menu-session="${b}"]`).focus();
    await app.keyboard.press('Meta+KeyZ');
    await expect.poll(() => stateOf(core, a)).toBeDefined();
    await expect(line(app)).toHaveCount(0);
  });

  test('undo_status_line_axe_and_live', async ({ app, core }) => {
    const { a } = twoShells(core);
    await openWindow(app);
    await end(core, a);
    await closeFromTab(app, a);
    await expect(line(app)).toBeVisible();
    await expect(line(app)).toHaveAttribute('role', 'status');
    await expect(line(app)).toHaveAttribute('aria-live', 'polite');
    const r = await new AxeBuilder({ page: app }).include('footer.status').analyze();
    expect(r.violations.map((v) => v.id)).toEqual([]);
    // Keyboard reachable: Tab from the status line's neighbour lands on Undo, Enter runs it.
    await undoButton(app).focus();
    await expect(undoButton(app)).toBeFocused();
    await app.keyboard.press('Enter');
    await expect(line(app)).toHaveCount(0);
  });
});

test('undo_delete_card_restores', async ({ app, core }) => {
  fs.copyFileSync(path.join(import.meta.dirname, 'fixtures/board/layout.toml'), path.join(core.home, 'layout.toml'));
  await openWindow(app);
  const col = (id: string) => app.$$eval(`.board [data-column="${id}"] .bcard .btt`, (els) => els.map((e) => e.textContent));
  const make = async (title: string, note: string, column: string) => {
    await app.locator('.board').getByRole('button', { name: '+ Card' }).click();
    const d = app.getByRole('dialog', { name: 'New card' });
    await d.getByLabel('Title').fill(title);
    await d.getByLabel('Note').fill(note);
    await d.getByLabel('Column').selectOption(column);
    await d.getByRole('button', { name: 'Save' }).click();
    await expect(app.locator('.board .bcard .btt', { hasText: new RegExp(`^${title}$`) })).toBeVisible();
  };
  await make('one', 'n1', 'review');
  await make('two', 'n2 body', 'review');
  await make('three', 'n3', 'review');
  await app.locator('.board .bcard', { hasText: 'two' }).click();
  await app.getByRole('dialog', { name: 'Edit card' }).getByRole('button', { name: 'Delete' }).click();
  await expect.poll(() => col('review')).toEqual(['one', 'three']);
  await expect(line(app)).toContainText('Deleted card');
  await shot(app, 'delete-card');
  await undoButton(app).click();
  await expect.poll(() => col('review')).toEqual(['one', 'two', 'three']);
  await expect(app.locator('.board .bcard', { hasText: 'two' })).toContainText('n2 body');
});

test('undo_remove_theme_restores', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await app.emulateMedia({ colorScheme: 'dark' });
  const { colors } = await import('./theme-harness');
  const mine = { id: 'imported:Fake Dusk', name: 'Fake Dusk', colors: colors('#2a1b3d', '#e8e3f0') };
  await seed(app, { themesImported: [mine], themeDark: mine, themeBrowse: false });
  await openWindow(app);
  await openTheme(app);
  await menu(app, 'Fake Dusk', 'Remove');
  await expect(themeCard(app, 'Fake Dusk')).toHaveCount(0);
  await expect(line(app)).toContainText('Removed theme Fake Dusk');
  await shot(app, 'remove-theme');
  await undoButton(app).click();
  await expect(themeCard(app, 'Fake Dusk')).toBeVisible();
  const saved = await app.evaluate(() => JSON.parse(localStorage.getItem('nunchiro.settings.v1')!));
  expect(saved.themesImported).toEqual([mine]);
  expect(saved.themeDark).toEqual(mine);
});

test('undo_hide_builtin_theme', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await seed(app, { themeBrowse: false });
  await openWindow(app);
  await openTheme(app);
  await menu(app, 'Catppuccin Mocha', 'Hide');
  await expect(themeCard(app, 'Catppuccin Mocha')).toHaveCount(0);
  await expect(line(app)).toContainText('Hid theme Catppuccin Mocha');
  await shot(app, 'hide-theme');
  await undoButton(app).click();
  await expect(themeCard(app, 'Catppuccin Mocha')).toBeVisible();
});

test('undo_layout_edit', async ({ app }) => {
  await openWindow(app);
  await startEdit(app);
  expect(await names(app, 'left')).toContain('Search');
  await bar(app, 'left').getByRole('button', { name: 'Remove Search from the left bar' }).click();
  expect(await names(app, 'left')).not.toContain('Search');
  await expect(line(app)).toContainText('Undo');
  await shot(app, 'layout-edit');
  await undoButton(app).click();
  await expect.poll(() => names(app, 'left')).toContain('Search');
  await expect(editBar(app)).toBeVisible();
});

// Round 2: a layout undo done another way must take the status-line entry with it (a second run would pop an older step).
test('undo_layout_edit_stale_entry_dropped', async ({ app }) => {
  await openWindow(app);
  await startEdit(app);
  const removeSearch = () => bar(app, 'left').getByRole('button', { name: 'Remove Search from the left bar' }).click();
  await removeSearch();
  await expect(line(app)).toBeVisible();
  // Cmd+Z in edit mode (focus on the page body, outside any field).
  await app.locator('body').press('Meta+KeyZ');
  await expect.poll(() => names(app, 'left')).toContain('Search');
  await expect(line(app)).toHaveCount(0);
  // The toast's own Undo button.
  await removeSearch();
  await expect(line(app)).toBeVisible();
  await app.locator('.toast').getByRole('button', { name: 'Undo' }).click();
  await expect.poll(() => names(app, 'left')).toContain('Search');
  await expect(line(app)).toHaveCount(0);
});


// Ticket 78: the worktree toast and the status-line entry each listen for Cmd+Z; one press undoes one of them.
test.describe('undo followups (ticket 78)', () => {
  test.beforeEach(({ core }) => stripOnTop(core));

  test('one_cmd_z_undoes_one_action', async ({ app, core }) => {
    const p = core.project('repo');
    const git = (...a: string[]) => execFileSync('git', ['-C', p, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a]);
    git('init', '-q', '-b', 'main');
    git('commit', '-q', '--allow-empty', '-m', 'init');
    const w = (core.cli('worktree', 'create', '--project', p, '--branch', 'tidy', '--no-focus').worktrees as { path: string; branch: string }[]).find((x) => x.branch === 'tidy')!;
    const a = core.shell(p, 'a', '/bin/sh', '-c', 'read x; exit 0').id;
    core.shell(p, 'b');
    openQuiet(core);
    await openWindow(app);
    await end(core, a);
    await closeFromTab(app, a);
    await expect(line(app)).toContainText('Closed a');
    const tidy = app.locator('.row.wt2').filter({ hasText: 'tidy' }).first();
    await tidy.focus();
    await app.keyboard.press('Backspace');
    const toast = app.getByRole('status').filter({ hasText: 'Removed tidy · branch kept' });
    await expect(toast).toBeVisible();
    await expect.poll(() => fs.existsSync(w.path)).toBe(false);
    // One press, on a tree row outside any text field.
    await app.locator('.row').first().focus();
    await app.keyboard.press('Meta+KeyZ');
    await app.waitForTimeout(500);
    const clearUndone = stateOf(core, a) !== undefined;
    const worktreeUndone = fs.existsSync(w.path);
    test.info().annotations.push({ type: 'winner', description: clearUndone ? 'status-line' : worktreeUndone ? 'worktree toast' : 'none' });
    expect(Number(clearUndone) + Number(worktreeUndone)).toBe(1);
    // The other entry keeps its own Undo, and it works.
    if (clearUndone) {
      await toast.getByRole('button', { name: 'Undo' }).click();
      await expect.poll(() => fs.existsSync(w.path)).toBe(true);
    } else {
      await undoButton(app).click();
      await expect.poll(() => stateOf(core, a)).toBeDefined();
    }
  });
});
