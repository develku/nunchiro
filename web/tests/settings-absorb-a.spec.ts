// Ticket 217 (needs 178 lane L8): Settings search in place (A13, B17), the Notifications page's default level, permission
// line and test button (B4), theme tiles (C8), the font sample (C9) and the 100 % mark on the chat width bar (C10).
import type { Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { expect, openWindow, REPO, test, type Core } from './fixtures';
import { harness } from './theme-harness';

const nav = (app: Page) => app.getByRole('navigation', { name: 'Settings pages' });
const search = (app: Page) => app.getByRole('searchbox', { name: 'Search settings' });
const pages = (app: Page) => nav(app).locator('button[data-page]'); // needs 192 (ticket 250): page buttons sit in groups

async function noThemeFetch(app: Page) {
  // The Theme gallery asks for the online index when Appearance opens: answered here, never the network.
  await harness(app, [], () => {
    throw new Error('no theme file in this spec');
  });
}

async function openSettings(app: Page) {
  await app.getByRole('navigation', { name: 'Left bar' }).getByRole('button', { name: 'Settings' }).click();
  await expect(nav(app)).toBeVisible();
}

/** Stands in for the browser's Notification with the given permission; records each one raised and each permission ask. */
async function fakeNotification(page: Page, permission: 'granted' | 'denied' | 'default') {
  await page.addInitScript((perm) => {
    const w = window as unknown as { __notes: { title: string; body: string }[]; __asked: number };
    w.__notes = [];
    w.__asked = 0;
    class Fake {
      static permission = perm;
      static requestPermission = async () => (w.__asked++, 'granted');
      onclick: null | (() => void) = null;
      constructor(title: string, o: { body: string }) {
        w.__notes.push({ title, body: o.body });
      }
      close() {}
    }
    (window as unknown as { Notification: unknown }).Notification = Fake;
  }, permission);
}
const notes = (page: Page) => page.evaluate(() => (window as unknown as { __notes: { title: string; body: string }[] }).__notes);

/** Restarts the core with a short stale time, so a quiet turn raises a `stale` item (a notification at level all). */
async function staleCore(core: Core, page: Page, ms: number) {
  fs.writeFileSync(path.join(core.home, 'settings.json'), JSON.stringify({ worktrees_dir: path.join(core.home, 'wt'), stale_after_ms: ms }));
  core.proc.kill('SIGKILL');
  await expect.poll(() => core.proc.exitCode !== null || core.proc.signalCode !== null).toBe(true);
  fs.rmSync(path.join(core.home, 'window.json'), { force: true });
  fs.rmSync(path.join(core.home, 'core.sock'), { force: true });
  core.proc = spawn(path.join(REPO, 'target/debug/nunchiro'), ['serve'], { env: core.env, stdio: 'ignore' });
  await core.ready();
  await page.addInitScript((boot) => Object.assign(window.__NUNCHIRO__ ?? {}, boot), core.boot());
}

/** The core holds a `stale` item for the session (the window's notification decision follows from it). */
const stale = (core: Core, id: string) =>
  expect.poll(() => (core.cli('snapshot', '--json').sessions as { id: string; pending: { kind: string }[] }[]).find((s) => s.id === id)?.pending.some((d) => d.kind === 'stale'), { timeout: 10_000 }).toBe(true);

async function openAlerts(app: Page) {
  await openSettings(app);
  await nav(app).getByRole('button', { name: 'Notifications' }).click();
}

/** Picks a level in the header chip of the shown session (needs 130 menu). */
async function chipLevel(app: Page, name: string, level: 'all' | 'waiting only' | 'muted') {
  await app.getByRole('button', { name: `Notifications for ${name}` }).click();
  await app.getByRole('menuitem', { name: `notify: ${level}` }).click();
}

test('settings_search_focused_on_open_unless_deep_link: the search box takes focus on open; a palette link to a field keeps its field', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await noThemeFetch(app);
  await openWindow(app);
  await openSettings(app);
  await expect(search(app)).toBeFocused();
  // A fresh window opened on a field from the palette: the field, not the box.
  await app.keyboard.press('Escape'); // v25f: a reload keeps an open modal
  await expect(app.locator('.ovl')).toHaveCount(0); // closed and saved before the reload
  await app.reload();
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  await app.getByRole('button', { name: 'Open command palette' }).click(); // the visible control: an early chord can be dropped (ticket 106)
  await app.getByRole('dialog', { name: 'Command palette' }).locator('[data-command="settings.terminal.termFontSize"]').click();
  await expect(app.getByRole('spinbutton', { name: 'Terminal font size' })).toBeFocused();
});

test('settings_search_autocorrect_spellcheck_off: no spellcheck, autocorrect or autocapitalize on the search box', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await openSettings(app);
  await expect(search(app)).toHaveAttribute('spellcheck', 'false');
  await expect(search(app)).toHaveAttribute('autocorrect', 'off');
  await expect(search(app)).toHaveAttribute('autocapitalize', 'off');
});

test('settings_search_filters_pages_and_rows_with_empty_state: pages and rows filter in place; no match shows one status card', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await noThemeFetch(app);
  await openWindow(app);
  await openSettings(app);
  expect(await pages(app).count()).toBeGreaterThan(5);
  // A field query: only Appearance stays in the nav, and only the matching row stays on its page.
  await search(app).fill('terminal font size');
  await expect(pages(app)).toHaveText(['Terminal']); // needs 192 (ticket 250): the terminal font rows moved to Terminal
  await expect(app.getByRole('spinbutton', { name: 'Terminal font size' })).toBeVisible();
  for (const other of ['Tab font size', 'Row height']) await expect(app.getByRole('spinbutton', { name: other })).toBeHidden();
  await expect(app.getByRole('slider', { name: 'Chat width' })).toBeHidden();
  await expect(app.getByRole('searchbox', { name: 'Search themes' })).toBeHidden();
  // Nothing is drawn over the page body: the rows themselves are the results.
  await expect(app.locator('.settings .sbody').getByRole('list', { name: 'Matching settings' })).toHaveCount(0);
  await expect(app.locator('.settings .sbody .ssearch')).toHaveCount(0);
  // A page title query shows that page whole.
  await search(app).fill('notifications');
  await expect(pages(app)).toHaveText(['Notifications']);
  await expect(app.getByRole('slider', { name: 'Sound volume' })).toBeVisible();
  await expect(app.getByRole('radio', { name: /Answer strip/ }).first()).toBeVisible();
  // No match anywhere: one status card instead of the page, and no page in the nav.
  await search(app).fill('zzzz-nothing');
  const empty = app.locator('.settings .sbody').getByRole('status');
  await expect(empty).toContainText('zzzz-nothing');
  await expect(pages(app)).toHaveCount(0);
  await expect(app.locator('.settings .sbody h2').filter({ visible: true })).toHaveCount(0);
  // Clearing the query brings every page back.
  await search(app).fill('');
  expect(await pages(app).count()).toBeGreaterThan(5);
  await expect(app.locator('.settings .sbody h2').first()).toBeVisible();
});

test('settings_search_clear_button_and_esc_return_focus: Clear search (click, Enter, Space) and Esc empty the box and keep focus there', async ({ app, core, browserName }) => {
  // WebKit's Tab skips buttons unless Full Keyboard Access is on; Option+Tab walks every control (ticket 478).
  const tab = browserName === 'webkit' ? 'Alt+Tab' : 'Tab';
  core.shell(core.project('demo'), 'alpha');
  await noThemeFetch(app);
  await openWindow(app);
  await openSettings(app);
  const clear = app.getByRole('button', { name: 'Clear search' });
  await search(app).fill('zzzz-nothing');
  await clear.click();
  await expect(search(app)).toHaveValue('');
  await expect(search(app)).toBeFocused();
  for (const key of ['Enter', 'Space']) {
    await search(app).fill('zzzz-nothing');
    await search(app).press(tab); // the nav holds no page and no match: the card's button is next
    await expect(clear).toBeFocused();
    await expect(clear).toHaveCSS('outline-style', 'solid'); // the shared focus ring
    await app.keyboard.press(key);
    await expect(search(app), key).toHaveValue('');
    await expect(search(app), key).toBeFocused();
  }
  await search(app).fill('font');
  await search(app).press('Escape');
  await expect(search(app)).toHaveValue('');
  await expect(search(app)).toBeFocused();
  await expect(app.getByRole('region', { name: 'Settings', exact: true })).toBeVisible();
});

test('notifications_default_level_applies_to_new_sessions: the default from Settings is the level of a session with none stored', async ({ app, core }) => {
  await staleCore(core, app, 5000);
  await fakeNotification(app, 'granted');
  await app.addInitScript(() => (document.hasFocus = () => false)); // ticket 316: the session in front stays quiet while focused
  await noThemeFetch(app);
  const p = core.project('nunchiro');
  await openWindow(app);
  await openSettings(app);
  await nav(app).getByRole('button', { name: 'Notifications' }).click();
  const group = app.getByRole('radiogroup', { name: 'Default for new sessions' });
  await expect(group.getByRole('radio', { name: 'All' })).toBeChecked();
  await group.getByRole('radio', { name: 'Muted' }).click();
  await expect(group.getByRole('radio', { name: 'Muted' })).toBeChecked();
  expect(await app.evaluate(() => JSON.parse(localStorage.getItem('nunchiro.settings.v1')!).notifyDefault)).toBe('muted');
  // Two new sessions: one keeps the default, the other is set to all in its chip before it goes stale.
  // B14 (ticket 991): only a turn in progress goes stale, so these are agents mid-turn with no output.
  const quiet = core.agent(p, 'quiet', 'never');
  const loud = core.agent(p, 'loud', 'never');
  for (const s of [quiet, loud]) core.hook(s.id, 'UserPromptSubmit');
  await expect(app.locator(`.tab[data-tab="${loud.id}"]`)).toBeVisible();
  await app.keyboard.press('Escape'); // v25f: close the modal before the tabs behind it
  await app.locator(`.tab[data-tab="${quiet.id}"]`).click();
  await expect(app.getByRole('button', { name: 'Notifications for quiet' })).toHaveAttribute('data-tip', /notify: muted/);
  await app.locator(`.tab[data-tab="${loud.id}"]`).click();
  await chipLevel(app, 'loud', 'all');
  await stale(core, quiet.id);
  await stale(core, loud.id);
  await expect.poll(() => notes(app)).toHaveLength(1);
  expect((await notes(app))[0].title).toContain('loud');
  // Back to All: a session with no stored level follows it at once.
  await openSettings(app);
  await nav(app).getByRole('button', { name: 'Notifications' }).click();
  await group.getByRole('radio', { name: 'All' }).press('Space');
  await expect(group.getByRole('radio', { name: 'All' })).toBeChecked();
  await app.keyboard.press('Escape');
  await app.locator(`.tab[data-tab="${quiet.id}"]`).click();
  await expect(app.getByRole('button', { name: 'Notifications for quiet' })).toHaveAttribute('data-tip', /notify: all/);
});

test('notifications_stored_level_beats_default: a session level set in its chip wins over the default', async ({ app, core }) => {
  await staleCore(core, app, 5000);
  await fakeNotification(app, 'granted');
  await app.addInitScript(() => localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ notifyDefault: 'waiting' })));
  const p = core.project('nunchiro');
  await openWindow(app);
  const a = core.agent(p, 'aye', 'never');
  const b = core.agent(p, 'bee', 'never');
  const c = core.agent(p, 'sea', 'never');
  for (const s of [a, b, c]) core.hook(s.id, 'UserPromptSubmit'); // B14: mid-turn, so quiet means stale
  await expect(app.locator(`.tab[data-tab="${c.id}"]`)).toBeVisible();
  await app.locator(`.tab[data-tab="${a.id}"]`).click();
  await chipLevel(app, 'aye', 'all');
  await app.locator(`.tab[data-tab="${b.id}"]`).click();
  await chipLevel(app, 'bee', 'muted');
  await app.locator(`.tab[data-tab="${c.id}"]`).click();
  await expect(app.getByRole('button', { name: 'Notifications for sea' })).toHaveAttribute('data-tip', /notify: waiting only/);
  await app.locator(`.tab[data-tab="${b.id}"]`).click();
  await expect(app.getByRole('button', { name: 'Notifications for bee' })).toHaveAttribute('data-tip', /notify: muted/);
  for (const s of [a, b, c]) await stale(core, s.id);
  // Stale is not a waiting kind: only the session stored at all is told.
  await expect.poll(() => notes(app)).toHaveLength(1);
  expect((await notes(app))[0].title).toContain('aye');
  // A store holding a level that does not exist reads as the default all (this init script runs after the one above).
  await app.addInitScript(() => localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ notifyDefault: 'very loud' })));
  await app.reload();
  await app.locator(`.tab[data-tab="${c.id}"]`).click();
  await expect(app.getByRole('button', { name: 'Notifications for sea' })).toHaveAttribute('data-tip', /notify: all/);
});

test('notifications_send_test_button: Send test notification raises one titled "Nunchiro test" and reads Sent for 2 s', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await fakeNotification(app, 'granted');
  await openWindow(app);
  await openSettings(app);
  await nav(app).getByRole('button', { name: 'Notifications' }).click();
  const send = app.getByRole('button', { name: 'Send test notification' });
  await send.click();
  await expect.poll(() => notes(app)).toHaveLength(1);
  expect((await notes(app))[0].title).toBe('Nunchiro test');
  await expect(app.getByRole('button', { name: 'Sent' })).toBeVisible();
  await expect(send).toBeVisible({ timeout: 4000 });
  // Keyboard: Enter on the focused button sends another.
  await send.focus();
  await app.keyboard.press('Enter');
  await expect.poll(() => notes(app)).toHaveLength(2);
});

test('notifications_app_reports_macos: in the app the row shows what macOS says and the test says what happened', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await app.addInitScript(() => {
    const w = window as unknown as { __perm: string; __answer: () => void; __calls: { cmd: string; args: { title?: string } }[]; __TAURI_INTERNALS__: unknown };
    w.__perm = 'denied';
    w.__calls = [];
    w.__TAURI_INTERNALS__ = { invoke: (cmd: string, args: { title?: string }) => (w.__calls.push({ cmd, args }), Promise.resolve(cmd === 'notification_permission' ? w.__perm : cmd === 'ask_notification_permission' ? new Promise((done) => (w.__answer = () => done((w.__perm = 'granted')))) : null)), transformCallback: () => 0, metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main', windowLabel: 'main' } } };
  });
  await openWindow(app);
  await openSettings(app);
  await nav(app).getByRole('button', { name: 'Notifications' }).click();
  const calls = () => app.evaluate(() => (window as unknown as { __calls: { cmd: string; args: { title?: string } }[] }).__calls.filter((c) => c.cmd === 'notify').map((c) => c.args.title));
  const perm = (v: string) => app.evaluate((x) => ((window as unknown as { __perm: string }).__perm = x, window.dispatchEvent(new Event('focus'))), v);
  const row = app.locator('section[aria-labelledby="h-system-notes"]');
  const send = app.getByRole('button', { name: 'Send test notification' });
  // Blocked by macOS: said so, the row keeps its own description, and the test sends nothing and never reads Sent.
  await expect(row.locator('.snm .chip')).toHaveText('Blocked');
  await expect(row.getByText('Notification Center tells you')).toBeVisible();
  await expect(row.getByText(/is not delivering notifications/)).toBeVisible();
  const reads = () => app.evaluate(() => (window as unknown as { __calls: { cmd: string }[] }).__calls.filter((c) => c.cmd === 'notification_permission').length);
  const before = await reads();
  await send.click();
  await expect.poll(reads).toBe(before + 2); // the test's own read and the one after it: finished before the state changes below
  await expect(app.getByRole('button', { name: 'Sent' })).toHaveCount(0);
  expect(await calls()).toEqual([]);
  // The switch flipped in System Settings: seen on coming back, and the test goes through the shell.
  await perm('granted');
  await expect(row.locator('.snm .chip')).toHaveText('Allowed');
  await send.click();
  await expect.poll(calls).toEqual(['Nunchiro test']);
  await expect(app.getByRole('button', { name: 'Sent' })).toBeVisible();
  await expect(row.getByRole('status')).toHaveText('Sent');
  // macOS gave no answer: sent, without claiming it was shown.
  await perm('unknown');
  await expect(row.locator('.snm .chip')).toHaveCount(0);
  await expect(send).toBeVisible({ timeout: 4000 });
  await send.click();
  await expect(row.getByText('Sent, but Nunchiro cannot tell whether macOS showed it.')).toBeVisible();
  // Not asked yet: Ask now goes to macOS and the chip follows its answer.
  await perm('default');
  await expect(row.locator('.snm .chip')).toHaveText('Not asked yet');
  await row.getByRole('button', { name: 'Ask now' }).click();
  await expect(row.getByRole('button', { name: 'Ask now' })).toBeDisabled();
  await expect.poll(() => app.evaluate(() => typeof (window as unknown as { __answer?: unknown }).__answer)).toBe('function'); // set once the shell call is out
  await app.evaluate(() => (window as unknown as { __answer: () => void }).__answer());
  await expect(row.locator('.snm .chip')).toHaveText('Allowed');
  await expect(row.getByRole('button', { name: 'Ask now' })).toHaveCount(0);
});

test('notifications_macos_not_delivering_line: denied shows the System Settings line; not asked shows Ask now', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await fakeNotification(app, 'denied');
  await openWindow(app);
  await openSettings(app);
  await nav(app).getByRole('button', { name: 'Notifications' }).click();
  // Ticket 475 replaced the denied line with the row's Why line (AlertsPage.tsx `settingsWhy.notifyBlocked`).
  const line = app.getByText('macOS is not delivering notifications for Nunchiro. Turn them on in System Settings > Notifications > Nunchiro.');
  await expect(line).toBeVisible();
  await expect(app.getByText('Notification Center tells you')).toBeVisible(); // ticket 316: the status no longer replaces it
  await expect(line.getByRole('link')).toHaveCount(0);
  await expect(line.getByRole('button')).toHaveCount(0);
  await expect(app.getByRole('button', { name: 'Ask now' })).toHaveCount(0);
  // Not asked yet: the line says so and Ask now asks once.
  await fakeNotification(app, 'default');
  await app.keyboard.press('Escape'); // v25f: a reload keeps an open modal
  await expect(app.locator('.ovl')).toHaveCount(0); // closed and saved before the reload
  await app.reload();
  await openAlerts(app);
  await expect(app.getByText('Not asked yet')).toBeVisible();
  await expect(line).toHaveCount(0);
  await app.getByRole('button', { name: 'Ask now' }).click();
  await expect.poll(() => app.evaluate(() => (window as unknown as { __asked: number }).__asked)).toBe(1);
  // Granted: neither line.
  await fakeNotification(app, 'granted');
  await app.keyboard.press('Escape'); // v25f: a reload keeps an open modal
  await expect(app.locator('.ovl')).toHaveCount(0); // closed and saved before the reload
  await app.reload();
  await openAlerts(app);
  await expect(app.getByRole('button', { name: 'Send test notification' })).toBeVisible();
  await expect(app.getByText('Not asked yet')).toHaveCount(0);
  await expect(line).toHaveCount(0);
});

test('theme_tiles_hover_preview_click_applies: each tile is a mini window in its own colours; hover previews, Esc reverts, a click applies (D-20261108-12)', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await noThemeFetch(app);
  await openWindow(app);
  await openSettings(app);
  await nav(app).getByRole('button', { name: 'Appearance' }).click();
  const tiles = app.locator('.tcard[data-theme-id] .tpick');
  await expect(tiles.first()).toBeVisible();
  const parts = await tiles.evaluateAll((els) =>
    els.slice(0, 4).map((el) => {
      const bg = (sel: string) => (el.querySelector(sel) ? getComputedStyle(el.querySelector(sel)!).backgroundColor : null);
      return { title: bg('.ttitle'), side: bg('.tside'), chip: bg('.tchip'), lines: el.querySelectorAll('.tterm > span').length };
    }),
  );
  for (const p of parts) {
    expect(p.title).toBeTruthy();
    expect(p.side).toBeTruthy();
    expect(p.chip).toBeTruthy();
    expect(p.lines).toBeGreaterThanOrEqual(2);
  }
  // The first two tiles are a light and a dark theme: their title bars differ, each in its own colours.
  expect(parts[0].title).not.toBe(parts[1].title);
  // Hover previews, Esc reverts.
  // Pin the tile by its theme id in one resolution: the catalog tiles arrive after the first two and are inserted
  // between them, so a live "first unpressed" locator moves to another card once the grid fills (rc2c-testfix).
  const id = await app.locator('.tcard[data-theme-id]:has(.tpick[aria-pressed="false"])').first().getAttribute('data-theme-id');
  const other = app.locator(`.tcard[data-theme-id="${id}"] .tpick`);
  await other.hover();
  await expect(other).toHaveAttribute('data-trial', 'true');
  await app.keyboard.press('Escape');
  await expect(other).not.toHaveAttribute('data-trial', 'true');
  // A click: the tile is the applied one, no Keep step.
  await other.click();
  await expect(app.locator(`.tcard[data-theme-id="${id}"] .tpick`)).toHaveAttribute('aria-pressed', 'true');
});

test('font_sample_beside_steppers: a hidden-from-readers sample follows the terminal font size and family as they change', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await noThemeFetch(app);
  await openWindow(app);
  await openSettings(app);
  await nav(app).getByRole('button', { name: 'Terminal', exact: true }).click(); // needs 192 (ticket 250)
  const size = app.getByRole('spinbutton', { name: 'Terminal font size' });
  const sample = app.locator('.fsample');
  await expect(sample).toHaveAttribute('aria-hidden', 'true');
  await expect(sample.locator('.fs-chat')).toHaveCount(2);
  await expect(sample.locator('.fs-chat').first()).toHaveText('Fix the failing test in api/'); // Q5-7: prose from the catalogue
  const term = sample.locator('.fs-term');
  await expect(term).toHaveCount(1);
  // Beside the stepper: on the same row, to its right.
  const [a, b] = [await size.boundingBox(), await sample.boundingBox()];
  expect(b!.x).toBeGreaterThan(a!.x + a!.width - 1);
  expect(b!.y).toBeLessThan(a!.y + a!.height);
  await expect(term).toHaveCSS('font-size', '12px');
  await app.getByRole('button', { name: 'Increase Terminal font size' }).click();
  await expect(term).toHaveCSS('font-size', '13px');
  await size.fill('17');
  await expect(term).toHaveCSS('font-size', '17px');
  const family = await app.evaluate(() => JSON.parse(localStorage.getItem('nunchiro.settings.v1')!).termFont as string);
  // The computed list drops the quotes a one-word name does not need: compared without spaces and quotes.
  expect(await term.evaluate((el) => getComputedStyle(el).fontFamily.replace(/[\s"']/g, ''))).toBe(family.replace(/[\s"']/g, ''));
  // Another family: the sample follows it.
  await app.getByRole('button', { name: /Terminal font/ }).first().click();
  await app.getByRole('option', { name: /Custom/ }).click();
  await app.getByRole('textbox', { name: 'Custom font list' }).fill('Menlo, monospace');
  await expect.poll(() => term.evaluate((el) => getComputedStyle(el).fontFamily.replace(/\s/g, ''))).toBe('Menlo,monospace');
});

test('chat_width_bar_marks_100_percent: the 60-160 % bar carries a 100% tick under the thumb position of 100', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await noThemeFetch(app);
  await openWindow(app);
  await openSettings(app);
  await nav(app).getByRole('button', { name: 'Appearance' }).click();
  // needs 192 (ticket 250 r3) (review MUST 1): final.html draws a stepper, not a bar; 100 % is the default its row names.
  const bar = app.getByRole('spinbutton', { name: 'Chat width' });
  await expect(bar).toHaveAttribute('min', '60');
  await expect(bar).toHaveAttribute('max', '160');
  await expect(bar).toHaveValue('100');
  const row = app.locator('.srow').filter({ has: bar });
  await expect(row).toContainText('default 100 %');
  await expect(row.locator('.unit')).toHaveText('%');
  await expect(row.locator('.sds')).toHaveCSS('font-size', /^(1[1-9]|[2-9]\d)(\.\d+)?px$/); // the 11 px floor
});

// Q5-7 (look 1117): the sample's chat lines are prose and follow the window's language; the terminal line is a command.
test('font_sample_chat_lines_follow_language (Q5-7)', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await noThemeFetch(app);
  await app.addInitScript(() => localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ language: 'ko' })));
  await app.goto('/');
  await expect(app.locator('.tab[data-tab]')).toHaveCount(1);
  await app.keyboard.press('Meta+Comma');
  await app.locator('.settings > nav button[data-page="terminal"]').click();
  const sample = app.locator('.fsample');
  await expect(sample.locator('.fs-chat').first()).toHaveText('api/의 실패하는 테스트를 고쳐 주세요');
  await expect(sample.locator('.fs-term')).toHaveText('~/api $ cargo test   ok');
});
