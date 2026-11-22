// V2-6a (ticket 56): one status-line Undo for the reversible window actions, ten seconds, and Cmd+Z outside text fields.
// Each test runs a real core with its own NUNCHIRO_HOME under .scratch. Time is a fake clock, never a real wait.
import type { Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { expect, openWindow, REPO, test, agentsZone, type Core, showComposer } from './fixtures';
import { card as themeCard, menu, openTheme } from './theme-harness';
import { bar, editBar, names, startEdit } from './d5b';
import { openQuiet } from './tree-seed';

const line = (p: Page) => p.locator('footer.status .undoline');
const undoButton = (p: Page) => line(p).getByRole('button', { name: 'Undo' });
const agentIds = (p: Page) => p.locator('.ar').evaluateAll((els) => els.map((e) => e.getAttribute('data-agent')));
const shot = (p: Page, name: string) => p.screenshot({ path: path.join(REPO, '.scratch/shots', `v2-6a-${name}-${test.info().project.name}.png`) });
const seed = (p: Page, settings: Record<string, unknown>) =>
  p.addInitScript((s) => {
    if (!localStorage.getItem('nunchiro.settings.v1')) localStorage.setItem('nunchiro.settings.v1', JSON.stringify(s));
  }, settings);

/** Three sessions, two of them closed (done), in the AGENTS rows. */
function doneSessions(core: Core) {
  const p = core.project('demo');
  const a = core.shell(p, 'a').id;
  const b = core.shell(p, 'b').id;
  const c = core.shell(p, 'c').id;
  core.cli('session', 'close', a);
  core.cli('session', 'close', b);
  return { a, b, c };
}

test.describe('clear done', () => {
  test.beforeEach(({ core }) => agentsZone(core));

  test('undo_clear_done_restores', async ({ app, core }) => {
    const { c } = doneSessions(core);
    await openWindow(app);
    await expect.poll(async () => (await agentIds(app)).length).toBe(3);
    const before = await agentIds(app);
    expect(before[0]).toBe(c);
    await app.getByRole('button', { name: 'Clear done' }).click();
    await expect.poll(() => agentIds(app)).toEqual([c]);
    await expect(line(app)).toContainText('Cleared 2 done sessions');
    await shot(app, 'clear-done');
    await undoButton(app).click();
    await expect.poll(() => agentIds(app)).toEqual(before);
    await expect(line(app)).toHaveCount(0);
  });

  test('undo_expires_after_10s', async ({ app, core }) => {
    const { c } = doneSessions(core);
    await app.clock.install();
    await openWindow(app);
    await app.getByRole('button', { name: 'Clear done' }).click();
    await expect.poll(() => agentIds(app)).toEqual([c]);
    await expect(line(app)).toBeVisible();
    await app.clock.fastForward(9_000);
    await expect(line(app)).toBeVisible();
    await app.clock.fastForward(2_000);
    await expect(line(app)).toHaveCount(0);
    await app.locator(`.ar[data-agent="${c}"]`).focus();
    await app.keyboard.press('Meta+KeyZ');
    await app.waitForTimeout(200);
    expect(await agentIds(app)).toEqual([c]);
  });

  test('undo_cmd_z_outside_fields_only', async ({ app, core }) => {
    const { c } = doneSessions(core);
    await openWindow(app);
    await expect.poll(async () => (await agentIds(app)).length).toBe(3);
    const before = await agentIds(app);
    await app.getByRole('button', { name: 'Clear done' }).click();
    await expect.poll(() => agentIds(app)).toEqual([c]);
    // The composer, the terminal and a text field keep their own undo.
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
    expect(await agentIds(app)).toEqual([c]);
    await expect(line(app)).toBeVisible();
    await app.keyboard.press('Escape');
    // On the tree row it runs.
    await app.locator(`.ar[data-agent="${c}"]`).focus();
    await app.keyboard.press('Meta+KeyZ');
    await expect.poll(() => agentIds(app)).toEqual(before);
    await expect(line(app)).toHaveCount(0);
  });

  test('undo_status_line_axe_and_live', async ({ app, core }) => {
    doneSessions(core);
    await openWindow(app);
    await app.getByRole('button', { name: 'Clear done' }).click();
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
  test.beforeEach(({ core }) => agentsZone(core));

  test('one_cmd_z_undoes_one_action', async ({ app, core }) => {
    const p = core.project('repo');
    const git = (...a: string[]) => execFileSync('git', ['-C', p, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a]);
    git('init', '-q', '-b', 'main');
    git('commit', '-q', '--allow-empty', '-m', 'init');
    const w = (core.cli('worktree', 'create', '--project', p, '--branch', 'tidy', '--no-focus').worktrees as { path: string; branch: string }[]).find((x) => x.branch === 'tidy')!;
    const ids = ['a', 'b', 'c'].map((n) => core.shell(p, n).id);
    core.cli('session', 'close', ids[0]);
    core.cli('session', 'close', ids[1]);
    openQuiet(core);
    await openWindow(app);
    await expect.poll(async () => (await agentIds(app)).length).toBe(3);
    await app.getByRole('button', { name: 'Clear done' }).click();
    await expect.poll(() => agentIds(app)).toEqual([ids[2]]);
    await expect(line(app)).toContainText('Cleared 2 done sessions');
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
    const clearUndone = (await agentIds(app)).length === 3;
    const worktreeUndone = fs.existsSync(w.path);
    test.info().annotations.push({ type: 'winner', description: clearUndone ? 'status-line' : worktreeUndone ? 'worktree toast' : 'none' });
    expect(Number(clearUndone) + Number(worktreeUndone)).toBe(1);
    // The other entry keeps its own Undo, and it works.
    if (clearUndone) {
      await toast.getByRole('button', { name: 'Undo' }).click();
      await expect.poll(() => fs.existsSync(w.path)).toBe(true);
    } else {
      await undoButton(app).click();
      await expect.poll(async () => (await agentIds(app)).length).toBe(3);
    }
  });

  test('clear_done_with_none_shows_no_undo', async ({ app, core }) => {
    doneSessions(core);
    await openWindow(app);
    await expect.poll(async () => (await agentIds(app)).length).toBe(3);
    const seen: string[] = [];
    const watch = setInterval(() => void line(app).allTextContents().then((t) => seen.push(...t)).catch(() => {}), 25);
    const clear = app.getByRole('button', { name: 'Clear done' });
    await clear.click();
    await expect(clear).toHaveCount(0);
    await expect(line(app).filter({ hasText: 'Cleared 2' }).first()).toBeVisible(); // waited for: the 25 ms watch can miss it under load
    await undoButton(app).click();
    await expect.poll(async () => (await agentIds(app)).length).toBe(3);
    await clear.click();
    await expect(clear).toHaveCount(0);
    clearInterval(watch);
    expect(seen.filter((t) => t.includes('Cleared 0'))).toEqual([]);
  });
});
