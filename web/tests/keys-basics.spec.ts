// needs 170 (3) keymap additions and the Keyboard page basics of needs 171 / 172: pane-focus chords, F2, ⌘/, the tab strip's
// arrow keys, the "No actions match" line, Enter on a row.
import type { Page } from '@playwright/test';
import { legacyLayout, expect, openWindow, test } from './fixtures';

const nav = (app: Page) => app.getByRole('navigation', { name: 'Settings pages' });
async function keysPage(app: Page) {
  await app.keyboard.press('Meta+Comma');
  await nav(app).getByRole('button', { name: 'Keyboard' }).click();
  await expect(app.locator('[data-keys-list]')).toBeVisible();
}
const row = (app: Page, id: string) => app.locator(`tr[data-command="${id}"]`);
/** A keydown on `target` (the page by default), reporting whether the app took it. */
const press = (page: Page, init: { code: string; metaKey?: boolean; altKey?: boolean; ctrlKey?: boolean }, target = 'body') =>
  page.evaluate(
    ([i, sel]) => {
      const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...(i as KeyboardEventInit) });
      (document.querySelector(sel as string) ?? document.body).dispatchEvent(e);
      return e.defaultPrevented;
    },
    [init, target] as const,
  );
const zoneOfFocus = (page: Page) => page.evaluate(() => document.activeElement?.closest('[data-zone-id]')?.getAttribute('data-zone-id') ?? null);
/** Puts the focus on the first thing inside the zone, the way a click would. */
const focusZoneById = (page: Page, id: string) =>
  page.evaluate((z) => {
    const el = document.querySelector<HTMLElement>(`[data-zone-id="${z}"]`)!;
    (el.querySelector<HTMLElement>(':is(textarea, input, button, [tabindex]):not([hidden])') ?? el).focus();
  }, id);

test('pane_focus_chords: ⌥⌘→ moves the focus to the zone pane mode would pick, nothing at an edge, rebindable', async ({ app, core }) => {
  legacyLayout(core); // a left column with a `tree` zone beside the centre column (the default window has one zone)
  core.shell(core.project('demo'), 'one');
  await openWindow(app);
  await focusZoneById(app, 'tree');
  expect(await zoneOfFocus(app)).toBe('tree');
  // Pane mode's own pick: prefix r, l, Enter.
  await app.keyboard.press('Control+Period');
  await app.keyboard.press('KeyR');
  await app.keyboard.press('KeyL');
  await app.keyboard.press('Enter');
  const picked = await zoneOfFocus(app);
  expect(picked).not.toBe('tree');
  await focusZoneById(app, 'tree');
  expect(await press(app, { code: 'ArrowRight', metaKey: true, altKey: true })).toBe(true);
  expect(await zoneOfFocus(app)).toBe(picked);
  // At the right edge: handled, nothing moves.
  expect(await press(app, { code: 'ArrowRight', metaKey: true, altKey: true })).toBe(true);
  expect(await zoneOfFocus(app)).toBe(picked);
  // And back: ⌥⌘← from the centre.
  expect(await press(app, { code: 'ArrowLeft', metaKey: true, altKey: true })).toBe(true);
  expect(await zoneOfFocus(app)).toBe('tree');
  // final.html: while they follow the arrows together the four ids are one row in Focus.
  await keysPage(app);
  await expect(app.locator('[data-area="focus"] tr[data-command="pane.focus"] td').nth(1)).toHaveText('⌥⌘←→↑↓');
});

test('pane_focus_chord_rebound: rebound to ⌥L the old chord does nothing and the new one moves', async ({ app, core }) => {
  legacyLayout(core);
  core.shell(core.project('demo'), 'one');
  await app.addInitScript(() => localStorage.getItem('nunchiro.settings.v1') === null && localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ bindings: { 'pane.focus.right': ['Alt+KeyL'] } })));
  await openWindow(app);
  await focusZoneById(app, 'tree');
  expect(await press(app, { code: 'ArrowRight', metaKey: true, altKey: true })).toBe(false);
  expect(await zoneOfFocus(app)).toBe('tree');
  expect(await press(app, { code: 'KeyL', altKey: true })).toBe(true);
  expect(await zoneOfFocus(app)).not.toBe('tree');
});

test('f2_renames_tab_not_in_terminal: F2 starts the active tab’s rename; inside a terminal the agent gets the F2 bytes', async ({ app, core }) => {
  const id = core.shell(core.project('demo'), 'raw', '/bin/sh', '-c', 'stty raw -echo; exec cat -v').id;
  await openWindow(app);
  await app.locator(`.tab[data-tab="${id}"]`).click();
  await app.keyboard.press('F2');
  await expect(app.locator(`.tab[data-tab="${id}"] input`)).toBeVisible();
  await app.keyboard.press('Escape');
  await expect(app.locator(`.tab[data-tab="${id}"] input`)).toHaveCount(0);
  // The old binding still works.
  await app.locator(`.tab[data-tab="${id}"]`).click();
  await app.keyboard.press('Control+Period');
  await app.keyboard.press('Comma');
  await expect(app.locator(`.tab[data-tab="${id}"] input`)).toBeVisible();
  await app.keyboard.press('Escape');
  // Escape hands focus back to the tab on a timer (useTabs focusTab); under load it can land after the focus below and take it.
  await expect(app.locator(`.tab[data-tab="${id}"]`)).toBeFocused();
  // Inside the terminal F2 is the agent's.
  const area = `.term[data-session="${id}"] .xterm-helper-textarea`;
  await app.locator(area).focus();
  expect(await press(app, { code: 'F2' }, area)).toBe(false);
  await app.keyboard.press('F2');
  await expect.poll(() => core.read(id)).toContain('^[OQ');
  await expect(app.locator(`.tab[data-tab="${id}"] input`)).toHaveCount(0);
});

test('cmd_slash_shows_key_help: ⌘/ shows the whole key sheet with its rows; Esc closes; the prefix ? shows the shorter prefix list (ticket 1099)', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  const help = app.locator('.prefix-help');
  await app.keyboard.press('Meta+Slash');
  await expect(help).toBeVisible();
  await expect(help.locator('.ph-row[data-command="session.new"]')).toHaveCount(1);
  expect(await help.locator('.ph-row').count()).toBeGreaterThan(10);
  const rows = await help.locator('.ph-row').count();
  await app.keyboard.press('Escape');
  await expect(help).toHaveCount(0);
  await app.keyboard.press('Control+Period');
  await app.keyboard.press('Shift+Slash');
  await expect(help).toBeVisible();
  expect(await help.locator('.ph-row').count()).toBeLessThan(rows); // ticket 1099: ◆ ? lists only the keys after the prefix
  await expect(help.locator('.ph-row[data-command="session.new"]')).toHaveCount(1); // its ◆ c
});

test('keys_tabs_arrow_keys: ArrowRight/Left/Home/End move the Shortcuts | Hints tabs and select as they go', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await keysPage(app);
  // needs 192 (ticket 250): no Shortcuts | Hints tabs; the keyboard path to the hints is the Options button on the hints
  // row (Tab reaches it, Enter moves focus to the hints part), and the list stays above it on the same page.
  await expect(app.locator('.settings').getByRole('tab')).toHaveCount(0);
  const options = app.getByRole('button', { name: 'Options ↓' });
  await options.focus();
  await app.keyboard.press('Enter');
  await expect(app.getByRole('heading', { name: /^Hints/, level: 2 })).toBeFocused();
  await expect(app.getByRole('textbox', { name: 'Hint alphabet' })).toBeVisible();
  await options.focus();
  await app.keyboard.press('Space');
  await expect(app.getByRole('heading', { name: /^Hints/, level: 2 })).toBeFocused();
  await expect(app.locator('[data-keys-list]')).toBeVisible();
});

test('keys_no_match_line: a search or a chip with no rows says so, in English and Korean, and Clear filters restores the list', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await keysPage(app);
  const rows = app.locator('[data-keys-list] tr[data-command]');
  const all = await rows.count();
  const search = app.getByRole('searchbox', { name: 'Search actions or keys' });
  await search.fill('zzzz-no-such-action');
  await expect(rows).toHaveCount(0);
  await expect(app.getByText('No actions match')).toBeVisible();
  await app.getByRole('button', { name: 'Clear filters' }).click();
  await expect(search).toHaveValue('');
  await expect(rows).toHaveCount(all);
  // A chip with no rows: nothing was changed yet.
  await app.getByRole('button', { name: /^Changed \d+$/ }).click();
  await expect(app.getByText('No actions match')).toBeVisible();
  await app.getByRole('button', { name: 'Clear filters' }).click();
  await expect(app.getByRole('button', { name: /^All \d+$/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(rows).toHaveCount(all);
});

test('keys_no_match_line_korean: the line and the button read in Korean', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await app.evaluate(() => localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ language: 'ko' })));
  await app.reload();
  await expect(app.locator('.tab[data-tab]')).toHaveCount(1); // the status line is Korean now: the tab is the sign the window is up
  await app.keyboard.press('Meta+Comma');
  await app.locator('.settings nav button').filter({ hasText: '키보드' }).click();
  await app.getByRole('searchbox', { name: '동작이나 키 검색' }).fill('zzzz-no-such-action');
  await expect(app.getByText('일치하는 동작이 없습니다')).toBeVisible();
  await expect(app.getByRole('button', { name: '필터 지우기' })).toBeVisible();
});

test('keys_row_enter_records: Enter on a focused row starts its recording; Esc returns the focus to the row; Enter on ✎ works once', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await keysPage(app);
  const r = row(app, 'focus.tree');
  await r.focus();
  await app.keyboard.press('Enter');
  await expect(app.locator('.krec')).toBeFocused();
  await expect(app.locator('.krec-box')).toHaveText('press a shortcut…');
  await app.keyboard.press('Escape');
  await expect(app.locator('.krec')).toHaveCount(0);
  await expect(r).toBeFocused();
  // Enter on the row's own ✎ button records once (the row does not start a second recording).
  await r.getByRole('button', { name: 'Change Focus the tree' }).focus();
  await app.keyboard.press('Enter');
  await expect(app.locator('.krec')).toHaveCount(1);
  await expect(app.locator('.krec')).toBeFocused();
  await app.keyboard.press('Escape');
  await expect(r.getByRole('button', { name: 'Change Focus the tree' })).toBeFocused();
});
