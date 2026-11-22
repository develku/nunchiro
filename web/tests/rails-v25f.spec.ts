// v25f-rails-terminal (owner RC feedback 11-08): F12, an older store's one shared sidebar width becomes both sides' (the drag specs are in
// shell-chrome.spec.ts). F4 (widgets from behind a Settings tab) gave way to the Settings modal (D-20261108-13).
import { expect, openWindow, test } from './fixtures';
import { icon, sidebar } from './d5b';
import { cleanBars, defaultBars } from '../src/layout/bars';
import { parseWidths } from '../src/pane/store';

test('settings_modal_keeps_rails: the rails stay as they were behind the Settings modal and work once it closes', async ({ app, core }) => {
  const s = core.shell(core.project('demo'), 'work');
  await openWindow(app, {}, core);
  const tab = app.locator(`.tab[data-tab="${s.id}"]`);
  await tab.click();
  await expect(sidebar(app, 'left')).toHaveAttribute('data-widget', 'tree');
  await icon(app, 'left', 'Settings').click();
  await expect(app.locator('.ovl[data-overlay="settings"]')).toBeVisible();
  await expect(sidebar(app, 'left')).toHaveAttribute('data-widget', 'tree'); // the modal covers the sidebar, it never closes it
  await expect(tab).toHaveAttribute('aria-selected', 'true');
  await app.keyboard.press('Escape');
  await expect(app.locator('.ovl')).toHaveCount(0);
  await icon(app, 'left', 'Files').click();
  await expect(sidebar(app, 'left')).toHaveAttribute('data-widget', 'files');
  await expect(tab).toHaveAttribute('aria-selected', 'true');
});

test('sidebar_width_migrates_to_both_sides: a stored single width is both sides; a bad side is dropped alone', () => {
  expect(cleanBars({ ...defaultBars(), sidebarW: 300 })!.sidebarW).toEqual({ left: 300, right: 300 });
  expect(cleanBars({ ...defaultBars(), sidebarW: { left: 280, right: 9999 } })!.sidebarW).toEqual({ left: 280 });
  expect(cleanBars({ ...defaultBars(), sidebarW: 'x' })!.sidebarW).toBeUndefined();
});

test('widget_widths_parse: each widget’s width is kept alone; a bad one is dropped, the rest stay (ticket 997 L2)', () => {
  expect(cleanBars({ ...defaultBars(), widgetW: { decisions: 300.4, diff: 9999, tree: 'x' } })!.widgetW).toEqual({ decisions: 300 });
  expect(cleanBars({ ...defaultBars(), widgetW: [300] })!.widgetW).toBeUndefined();
  expect(parseWidths(null, 500)).toEqual({ terminal: 500, browser: 500, preview: 500 }); // the v1 single pane width seeds each pane widget
  expect(parseWidths({ browser: 600, preview: 10 }, 500)).toEqual({ browser: 600 }); // a v2 store wins; out of range is dropped
  expect(parseWidths(null, 'x')).toEqual({});
});

test('C21 C22 C23 settings_is_a_modal_surface: ⌘A selects only in a field, the workspace behind is inert, and New session closes Settings first', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app, {}, core);
  const settings = app.getByRole('dialog', { name: 'Settings' });
  // C23: an open New tab popover closes when Settings opens.
  await app.keyboard.press('Meta+KeyT');
  const popover = app.getByRole('dialog', { name: 'New tab' });
  await expect(popover).toBeVisible();
  await app.keyboard.press('Escape');
  await expect(popover).toHaveCount(0);
  await app.getByRole('navigation', { name: 'Left bar' }).getByRole('button', { name: 'Settings' }).click();
  await expect(settings).toBeVisible();
  // C22: the title bar and the workspace are inert behind it; the status bar (its Undo line) is not.
  expect(await app.evaluate(() => ['.win > .body', '.win > .title'].map((s) => (document.querySelector(s) as HTMLElement | null)?.inert ?? null))).toEqual([true, true]);
  expect(await app.evaluate(() => (document.querySelector('.win > .status') as HTMLElement).inert)).toBe(false);
  // C21: ⌘A outside a field selects nothing; inside a field it selects the field's text.
  await app.locator('.ovl-panel').focus();
  await app.keyboard.press('Meta+KeyA');
  expect(await app.evaluate(() => String(getSelection()))).toBe('');
  const search = settings.getByRole('searchbox').first();
  await search.fill('font');
  await search.press('Meta+KeyA');
  expect(await search.evaluate((i: HTMLInputElement) => [i.selectionStart, i.selectionEnd])).toEqual([0, 4]);
  // C23: the New session key closes Settings and opens the popover, never under or over it.
  await app.keyboard.press('Meta+KeyT');
  await expect(settings).toHaveCount(0);
  await expect(popover).toBeVisible();
  expect(await app.evaluate(() => (document.querySelector('.win > .body') as HTMLElement).inert)).toBe(false);
});
