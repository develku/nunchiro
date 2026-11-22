// v25f (D-20261108-10): Settings and the Board open as one large modal over the workspace, never as a centre tab. Esc, the
// close button or the backdrop closes it and the tab that was active is still there, with its focus; the PTY behind keeps
// its size. Replaces rail-board-button.spec.ts (the Board icon used to place a centre Board tab).
import fs from 'node:fs';
import path from 'node:path';
import { expect, openWindow, test } from './fixtures';
import { BUCKETS } from '../src/board/watch';

const dialog = (app: import('@playwright/test').Page, name: string) => app.getByRole('dialog', { name });
const boardIcon = (app: import('@playwright/test').Page) => app.locator('.ib.r').getByRole('button', { name: /^Board( · |$)/ });

test('cmd_comma_toggles_settings_modal_and_esc_returns_to_the_tab', async ({ app, core }) => {
  const a = core.agent(core.project('a'), 'x', 'alpha');
  const b = core.agent(core.project('a'), 'y', 'beta');
  await openWindow(app);
  await app.locator(`.tab[data-tab="${a.id}"]`).click();
  const tab = app.locator(`.tab[data-tab="${a.id}"]`);
  await tab.focus();
  await app.keyboard.press('Meta+Comma');
  const settings = dialog(app, 'Settings');
  await expect(settings).toBeVisible();
  await expect(settings).toHaveAttribute('aria-modal', 'true');
  await expect(settings.locator('.settings nav')).toBeVisible(); // its own left nav and page, as before
  // Never a tab: the strip holds the two sessions only.
  await expect(app.locator('.tab[data-tab]')).toHaveCount(2);
  await expect(app.locator('.tab[data-tab="settings"]')).toHaveCount(0);
  // About 92% of the window, inset ~24 px.
  const box = (await settings.boundingBox())!;
  const vp = app.viewportSize()!;
  expect(box.x).toBeGreaterThanOrEqual(20);
  expect(box.x).toBeLessThanOrEqual(30);
  expect(box.width / vp.width).toBeGreaterThan(0.9);
  await app.keyboard.press('Escape');
  await expect(settings).toHaveCount(0);
  await expect(app.locator('.tab[aria-selected="true"]')).toHaveAttribute('data-tab', a.id);
  await expect(tab).toBeFocused();
  // ⌘, opens and closes again; the window state never saved a Settings tab.
  await app.keyboard.press('Meta+Comma');
  await expect(settings).toBeVisible();
  await app.keyboard.press('Meta+Comma');
  await expect(settings).toHaveCount(0);
  const saved = await app.evaluate(() => Object.entries(localStorage).filter(([k]) => k.startsWith('nunchiro.window.v1')).map(([, v]) => JSON.parse(v).tabs));
  for (const tabs of saved) expect(tabs).not.toContain('settings');
  expect(b.id).toBeTruthy();
});

test('board_icon_opens_board_modal_with_watch_columns_and_backdrop_closes', async ({ app, core }) => {
  await app.addInitScript(() => localStorage.removeItem('nunchiro.test.board-mode')); // the default (watch) view, as board-watch.spec.ts
  const a = core.agent(core.project('a'), 'x', 'alpha');
  await openWindow(app);
  await app.locator(`.tab[data-tab="${a.id}"]`).click();
  await boardIcon(app).click();
  const board = dialog(app, 'Board');
  await expect(board).toBeVisible();
  await expect(board.locator('.board[data-mode="watch"]')).toBeVisible();
  // The watch view's columns, unchanged, in the modal.
  await expect(board.locator('.wcol[data-bucket]')).toHaveCount(BUCKETS.length);
  // Nothing was placed in the layout.
  await expect(app.locator('.lz .wg[data-widget="board"]')).toHaveCount(0);
  // Opening Settings while the Board is open switches the content; the Board command (prefix K) switches back.
  await app.keyboard.press('Meta+Comma');
  await expect(dialog(app, 'Settings')).toBeVisible();
  await expect(app.getByRole('dialog')).toHaveCount(1);
  await app.keyboard.press('Control+Space');
  await app.keyboard.press('KeyK');
  await expect(board).toBeVisible();
  await expect(app.getByRole('dialog')).toHaveCount(1);
  // Backdrop click closes.
  await app.mouse.click(6, 400);
  await expect(app.getByRole('dialog')).toHaveCount(0);
  await expect(app.locator('.tab[aria-selected="true"]')).toHaveAttribute('data-tab', a.id);
});

test('modal_close_button_and_focus_trap', async ({ app, core }) => {
  core.agent(core.project('a'), 'x', 'alpha');
  await openWindow(app);
  await app.keyboard.press('Meta+Comma');
  const settings = dialog(app, 'Settings');
  await expect(settings).toBeVisible();
  // Tab never leaves the dialog, forwards or backwards.
  for (let i = 0; i < 60; i++) {
    await app.keyboard.press(i % 3 ? 'Tab' : 'Shift+Tab'); // plain Tab on WebKit too: it skips buttons, the trap must still hold
    expect(await app.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(true);
  }
  await settings.getByRole('button', { name: 'Close Settings' }).click();
  await expect(settings).toHaveCount(0);
});

test('saved_layout_with_centre_board_migrates_to_the_board_modal', async ({ app, core }) => {
  core.agent(core.project('a'), 'x', 'alpha');
  // An old layout: the Board stacked as a tab of the centre (terminal) zone, in front.
  fs.writeFileSync(
    path.join(core.home, 'layout.toml'),
    'version = 1\nlocked = false\n\n[root]\nid = "centre"\nsplit = "column"\n\n[[root.children]]\nid = "terminal"\nactive = 1\nwidgets = ["terminal", "board"]\n\n[[root.children]]\nid = "composer"\nwidgets = ["composer"]\n',
  );
  await openWindow(app);
  await expect(dialog(app, 'Board')).toBeVisible();
  await expect(dialog(app, 'Board').locator('.board')).toBeVisible();
  await expect(app.locator('.lz .wg[data-widget="board"]')).toHaveCount(0);
  await expect.poll(() => fs.readFileSync(path.join(core.home, 'layout.toml'), 'utf8')).not.toMatch(/widgets = \[[^\]]*"board"/);
  await app.keyboard.press('Escape');
  await expect(app.getByRole('dialog')).toHaveCount(0);
  // Once migrated, a reload opens no modal.
  await app.reload();
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  await app.waitForTimeout(500);
  await expect(app.getByRole('dialog')).toHaveCount(0);
});

test('terminal_behind_the_modal_is_not_resized', async ({ app, core }) => {
  // Counts SIGWINCH: any PTY resize while the modal is open shows as a line.
  const s = core.shell(core.project('demo'), 'winch', '/bin/sh', '-c', 'trap "echo WINCH" WINCH; echo ready; while :; do sleep 0.1; done');
  await openWindow(app);
  await app.locator(`.tab[data-tab="${s.id}"]`).click();
  await expect.poll(() => core.read(s.id)).toContain('ready');
  await app.waitForTimeout(800); // the first fit settles
  const before = (core.read(s.id).match(/WINCH/g) ?? []).length;
  await app.keyboard.press('Meta+Comma');
  await expect(dialog(app, 'Settings')).toBeVisible();
  await boardIcon(app).evaluate((e: HTMLElement) => e.click());
  await expect(dialog(app, 'Board')).toBeVisible();
  await app.waitForTimeout(600);
  await app.keyboard.press('Escape');
  await expect(app.getByRole('dialog')).toHaveCount(0);
  await app.waitForTimeout(600);
  expect((core.read(s.id).match(/WINCH/g) ?? []).length).toBe(before);
});

test('cmd_w_with_a_modal_open_closes_the_modal_only', async ({ app, core }) => {
  const a = core.agent(core.project('a'), 'x', 'alpha');
  core.agent(core.project('a'), 'y', 'beta');
  await openWindow(app);
  await app.locator(`.tab[data-tab="${a.id}"]`).click();
  for (const open of [() => app.keyboard.press('Meta+Comma'), () => boardIcon(app).click()]) {
    await open();
    await expect(app.getByRole('dialog')).toHaveCount(1);
    await app.keyboard.press('Meta+KeyW');
    await expect(app.getByRole('dialog')).toHaveCount(0);
    await expect(app.locator('.tab[data-tab]')).toHaveCount(2); // the tab hidden behind it stays
    await expect(app.locator('.tab[aria-selected="true"]')).toHaveAttribute('data-tab', a.id);
  }
});
