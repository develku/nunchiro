// Settings > Keyboard, page A (needs 166; frame docs/design/v25-keys-redesign/fa-light.png): one scrollable list, the
// recorder inside the row, second bindings as "or", filters. Each test is named for the acceptance item it proves.
import fs from 'node:fs';
import path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { AREAS } from '../src/keys';
import { expect, openWindow, REPO, test } from './fixtures';

const nav = (app: Page) => app.getByRole('navigation', { name: 'Settings pages' });
async function keysPage(app: Page) {
  if (!(await nav(app).isVisible())) await app.keyboard.press('Meta+Comma'); // v25f: the shortcut toggles the modal
  await nav(app).getByRole('button', { name: 'Keyboard' }).click();
  await expect(app.locator('[data-keys-list]')).toBeVisible();
  return app.locator('[data-keys-list]');
}
const row = (app: Page, id: string) => app.locator(id === 'prefix' ? '[data-command="prefix"]' : `tr[data-command="${id}"]`);
const stored = (app: Page) => app.evaluate(() => JSON.parse(localStorage.getItem('nunchiro.settings.v1') ?? '{}').bindings ?? {}) as Promise<Record<string, string[]>>;
const change = (app: Page, id: string, title: string) => row(app, id).getByRole('button', { name: `Change ${title}` });
const box = (app: Page) => app.locator('.krec-box');
/** A keydown as a Korean input source produces it: the physical code with a Hangul key value, keyCode 229, not composing. */
const korean = (app: Page, init: { code: string; key: string; ctrlKey?: boolean; isComposing?: boolean }) =>
  app.evaluate((i) => window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, keyCode: 229, ...i })), init);
/** Settings preloaded with overrides, as an earlier session left them. */
const withBindings = (app: Page, bindings: Record<string, string[]>) =>
  app.addInitScript((b) => localStorage.getItem('nunchiro.settings.v1') === null && localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ bindings: b })), bindings);

test('keys_one_scrollable_list: one [data-keys-list], no cards or key map, sticky area headers in AREAS order, .sbody the only scroller', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await keysPage(app);
  await expect(app.locator('[data-keys-list]')).toHaveCount(1);
  await expect(app.locator('.sbody [data-keys-list] .keys-card')).toHaveCount(0); // needs 192 (ticket 250): the hints cards follow the list
  for (const name of ['Key bindings', 'Key map']) await expect(app.getByRole('region', { name })).toHaveCount(0);
  await expect(app.locator('.sbody [data-keys-list] .hk-board')).toHaveCount(0); // needs 192 (ticket 250): the drawing is in the hints part
  const heads = app.locator('[data-keys-list] > section.karea:not(.kmode) > h3');
  await expect(heads).toHaveText(AREAS.filter((a) => a !== 'Other'));
  for (const h of await heads.all()) expect(await h.evaluate((e) => getComputedStyle(e).position)).toBe('sticky');
  // Scrolled into Sessions and tabs, its header sits at the scroller's top.
  const at = await app.evaluate(() => {
    const sbody = document.querySelector('.sbody')!;
    const area = document.querySelector('[data-keys-list] > section[data-area="sessions-and-tabs"]')!;
    sbody.scrollTop = area.getBoundingClientRect().top - sbody.getBoundingClientRect().top + sbody.scrollTop + 120;
    const head = area.querySelector('h3')!.getBoundingClientRect();
    return { head: head.top, top: sbody.getBoundingClientRect().top };
  });
  expect(Math.abs(at.head - at.top)).toBeLessThanOrEqual(2);
  // Between a row and the window only .sbody scrolls vertically.
  const scrollers = await row(app, 'session.new').evaluate((el) => {
    const out: string[] = [];
    for (let e = el.parentElement; e; e = e.parentElement) {
      const oy = getComputedStyle(e).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && e.scrollHeight > e.clientHeight + 1) out.push(e.className || e.tagName);
    }
    return out;
  });
  expect(scrollers).toEqual(['sbody']);
});

test('keys_change_fits_screen: recording on the last visible row and on a conflict row leaves the layout in place at three sizes', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  for (const [w, h] of [[1440, 900], [1024, 700], [800, 700]]) {
    await app.setViewportSize({ width: w, height: h });
    await keysPage(app);
    const sbody = app.locator('.sbody');
    const noOverflow = async (el: Locator) => expect(await el.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
    // The last row that is fully on screen, and a row that will show a conflict line.
    // Not the shared Hand off row: its Change opens it into a row per agent (tickets 318, 319), so the row itself is gone. The
    // list is left scrolled by the size before, and in WebKit (rows 0.8px shorter) that row was the last one on screen at
    // one of the sizes: the test waited for it until its timeout (lane w69).
    const last = await app.evaluate(() => {
      const rows = [...document.querySelectorAll<HTMLElement>('[data-keys-list] tr[data-command]')].filter((r) => r.getBoundingClientRect().bottom <= innerHeight && r.dataset.command !== 'handoff');
      return rows.at(-1)!.dataset.command!;
    });
    for (const [id, conflict] of [[last, false], ['tab.rename', true]] as const) {
      const r = row(app, id);
      await r.scrollIntoViewIfNeeded();
      const before = await r.evaluate((e) => ({ h: e.getBoundingClientRect().height, act: e.querySelector('td.kact')!.getBoundingClientRect().left }));
      await r.locator('button.kedit').click();
      if (conflict) {
        await app.keyboard.press('Control+Period');
        await app.keyboard.press('KeyB');
        await expect(r.getByRole('alert')).toContainText('is used by');
      }
      const after = await r.evaluate((e) => ({ h: e.getBoundingClientRect().height, act: e.querySelector('td.kact')!.getBoundingClientRect().left, rec: e.querySelector('.krec')!.getBoundingClientRect().right }));
      await noOverflow(sbody);
      await noOverflow(r);
      expect(Math.abs(after.act - before.act), `${w}: ${id} actions column`).toBeLessThanOrEqual(1);
      expect(after.rec, `${w}: ${id} recorder ends left of the column`).toBeLessThanOrEqual(after.act);
      expect(after.h - before.h, `${w}: ${id} growth`).toBeLessThanOrEqual(80);
      await app.keyboard.press('Escape');
    }
  }
});

test('keys_press_to_record_no_prefix_question: press the shortcut; a prefix press is shown as the prefix chip and the key', async ({ app, core }) => {
  const id = core.shell(core.project('demo'), 'alpha').id;
  await openWindow(app);
  await keysPage(app);
  const r = row(app, 'focus.composer');
  await change(app, 'focus.composer', 'Focus the composer').click();
  await expect(r.getByRole('button', { name: 'Direct chord' })).toHaveCount(0);
  await expect(r.getByRole('button', { name: /then a key/ })).toHaveCount(0);
  await app.keyboard.press('Meta+KeyU');
  await expect(box(app)).toHaveText('⌘U');
  await app.keyboard.press('Control+Period');
  await expect(box(app)).toContainText('◆');
  await expect(box(app)).toContainText('›');
  await expect(box(app)).toContainText('prefix detected, press the next key…');
  await app.keyboard.press('KeyU');
  await expect(box(app)).toHaveText('◆ u');
  await app.keyboard.press('Enter');
  await expect(box(app)).toHaveCount(0);
  await expect.poll(() => stored(app)).toMatchObject({ 'focus.composer': ['prefix KeyU'] });
  // Capture leaks nothing: ⌘T is New session's key, yet recording it opens no dialog and sends no byte to the terminal.
  await change(app, 'focus.composer', 'Focus the composer').click();
  await app.keyboard.press('Meta+KeyT');
  await expect(box(app)).toHaveText('⌘T');
  await expect(app.locator('dialog.newsess')).toHaveCount(0);
  expect(core.read(id)).toBe('');
  await app.keyboard.press('Escape');
  // The page reads the same after the prefix changes: the chips follow.
  await change(app, 'prefix', "Prefix (the key before a command's key)").click();
  await app.keyboard.press('Control+KeyB');
  await app.keyboard.press('Enter');
  await expect(r.locator('.kcaps')).toHaveText('◆ u');
  await change(app, 'focus.composer', 'Focus the composer').click();
  await app.keyboard.press('Control+KeyB');
  await expect(box(app)).toContainText('◆');
  await expect(box(app)).toContainText('prefix detected');
});

test('keys_recorder_second_prefix_refused: the prefix twice is refused, Esc cancels, a bare Enter is never recorded', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await keysPage(app);
  const r = row(app, 'focus.composer');
  await change(app, 'focus.composer', 'Focus the composer').click();
  await app.keyboard.press('Control+Period');
  await app.keyboard.press('Control+Period');
  await expect(r.getByRole('alert')).toHaveText('⌃. ⌃. is the prefix pressed twice. Nunchiro sends it to the agent.');
  await expect(box(app)).toContainText('prefix detected');
  await app.keyboard.press('Control+Space'); // the second default prefix chord is the prefix too
  await expect(r.getByRole('alert')).toContainText('is the prefix pressed twice');
  await expect(box(app)).toContainText('prefix detected'); // still recording, nothing saved
  expect(await stored(app)).toEqual({});
  await app.keyboard.press('Escape');
  await expect(box(app)).toHaveCount(0);
  expect(await stored(app)).toEqual({});
  await change(app, 'focus.composer', 'Focus the composer').click();
  await app.keyboard.press('Enter');
  await expect(box(app)).toHaveText('press a shortcut…');
  expect(await stored(app)).toEqual({});
});

test('keys_recorder_korean_input_source: keys are recorded by code under a Korean source; composing keys are ignored', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await keysPage(app);
  await change(app, 'session.new', 'New session…').click();
  await korean(app, { code: 'Period', key: '.', ctrlKey: true });
  await expect(box(app)).toContainText('prefix detected');
  await korean(app, { code: 'KeyC', key: 'ㅊ' });
  await expect(box(app)).toHaveText('◆ c');
  await korean(app, { code: 'KeyV', key: 'ㅍ', isComposing: true });
  await expect(box(app)).toHaveText('◆ c');
  await app.keyboard.press('Escape');
  // Saved by code on another row: prefix then u as a Korean source sends them.
  await change(app, 'focus.composer', 'Focus the composer').click();
  await korean(app, { code: 'Period', key: '.', ctrlKey: true });
  await korean(app, { code: 'KeyU', key: 'ㅕ' });
  await app.keyboard.press('Enter');
  await expect.poll(() => stored(app)).toMatchObject({ 'focus.composer': ['prefix KeyU'] });
});

test('keys_recorder_conflict_replace_and_pick_another: a held key is shown before it is taken; Replace is one click, no dialog', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await keysPage(app);
  const r = row(app, 'tab.rename');
  const taker = (await row(app, 'sidebar.left.toggle').locator('td').first().innerText()).replace(/\s*Changed by you$/, '');
  await change(app, 'tab.rename', 'Rename the session tab').click();
  await app.keyboard.press('Control+Period');
  await app.keyboard.press('KeyB');
  await expect(r.getByRole('alert')).toContainText(`is used by “${taker}”`);
  await expect(r.getByRole('alert')).toContainText('◆ b');
  await app.keyboard.press('Enter'); // a held key is never taken by Enter
  expect(await stored(app)).toEqual({});
  await r.getByRole('button', { name: 'Pick another' }).click();
  await expect(box(app)).toHaveText('press a shortcut…');
  await expect(r.getByRole('alert')).toHaveCount(0);
  await app.keyboard.press('Control+Period');
  await app.keyboard.press('KeyB');
  await r.getByRole('button', { name: 'Replace' }).click();
  await expect(app.locator('[role="dialog"]:not(.ovl-panel)')).toHaveCount(0); // v25f: Settings itself is a dialog
  await expect(box(app)).toHaveCount(0);
  const now = await stored(app);
  expect(now['tab.rename']).toContain('prefix KeyB');
  expect(now['sidebar.left.toggle']).not.toContain('prefix KeyB');
  expect(now['sidebar.left.toggle']).toEqual(['Meta+KeyB']);
});

test('keys_recorder_risk_warning_kept: a bare key or Ctrl+C warns and is saved only by the Save button', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await keysPage(app);
  const r = row(app, 'focus.tree');
  await change(app, 'focus.tree', 'Focus the tree').click();
  await app.keyboard.press('KeyJ');
  await expect(r.locator('.warn')).toContainText('no modifier');
  await app.keyboard.press('Enter');
  expect(await stored(app)).toEqual({}); // Enter does not confirm a warning
  await r.getByRole('button', { name: 'Save' }).click();
  await expect.poll(() => stored(app)).toMatchObject({ 'focus.tree': ['KeyJ'] });
  await change(app, 'focus.tree', 'Focus the tree').click();
  await app.keyboard.press('Control+KeyC');
  await expect(r.locator('.warn')).toContainText('interrupt');
  await r.getByRole('button', { name: 'Cancel' }).click();
  expect((await stored(app))['focus.tree']).toEqual(['KeyJ']);
  // After the prefix a bare key is the point: no warning, and Enter saves.
  await change(app, 'focus.tree', 'Focus the tree').click();
  await app.keyboard.press('Control+Period');
  await app.keyboard.press('KeyU');
  await expect(r.locator('.warn')).toHaveCount(0);
  await app.keyboard.press('Enter');
  await expect.poll(() => stored(app)).toMatchObject({ 'focus.tree': ['prefix KeyU'] });
});

test('keys_new_session_once: one New session row, no key-map cap, the background send is a different action', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await keysPage(app);
  await expect(app.locator('[data-command="session.new"]')).toHaveCount(1);
  await expect(app.locator('[data-keys-list] .hk-key')).toHaveCount(0); // needs 192 (ticket 250): the drawing is in the hints part
  await expect(row(app, 'composer.backgroundSend').locator('td').first()).toHaveText('Send as new session, stay here');
  // The palette shows the same title.
  await app.keyboard.press('Meta+KeyK');
  await expect(app.getByRole('dialog', { name: 'Command palette' }).locator('[data-command="composer.backgroundSend"]')).toContainText('Send as new session, stay here');
});

test('keys_second_binding_or: or on one row, + adds, Remove deletes one slot, reset restores both defaults', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await keysPage(app);
  const r = row(app, 'session.new');
  await expect(r.locator('td').nth(1)).toHaveText(/^⌘T\s*or\s*◆\s*c$/);
  await expect(r.getByRole('button', { name: 'Reset New session…' })).toHaveCount(0);
  await r.getByRole('button', { name: 'Add a second shortcut to New session…' }).click();
  await app.keyboard.press('Meta+KeyU');
  await app.keyboard.press('Enter');
  await expect.poll(() => stored(app)).toMatchObject({ 'session.new': ['Meta+KeyT', 'prefix KeyC', 'Meta+KeyU'] });
  await expect(r.locator('td').nth(1)).toHaveText(/⌘T\s*or\s*◆\s*c\s*or\s*⌘U/);
  // Remove deletes only the recorded slot.
  await r.locator('.kslot[data-slot="2"]').click();
  await r.getByRole('button', { name: 'Remove' }).click();
  await expect.poll(() => stored(app)).toMatchObject({ 'session.new': ['Meta+KeyT', 'prefix KeyC'] });
  await r.locator('.kslot[data-slot="0"]').click();
  await r.getByRole('button', { name: 'Remove' }).click();
  await expect.poll(() => stored(app)).toMatchObject({ 'session.new': ['prefix KeyC'] });
  // Reset restores every default and goes away.
  await r.getByRole('button', { name: 'Reset New session…' }).click();
  await expect(r.locator('td').nth(1)).toHaveText(/^⌘T\s*or\s*◆\s*c$/);
  await expect(r.getByRole('button', { name: 'Reset New session…' })).toHaveCount(0);
  expect(await stored(app)).not.toHaveProperty('session.new');
  // The prefix row names its default after a change.
  const p = row(app, 'prefix');
  await expect(p).not.toContainText('changed');
  await change(app, 'prefix', "Prefix (the key before a command's key)").click();
  await app.keyboard.press('Control+KeyB');
  await app.keyboard.press('Enter');
  await expect(p).toContainText('changed · default ⌃. or ⌃␣');
  await p.getByRole('button', { name: "Reset Prefix (the key before a command's key)" }).click();
  await expect(p).not.toContainText('changed');
});

test('keys_filters_and_search: chips filter with aria-pressed; a pressed key and a title search find rows; a hidden jump is cleared and named', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await withBindings(app, { 'focus.tree': ['Meta+KeyU'], 'focus.composer': ['Meta+KeyU'], 'tab.move.left': [] });
  await openWindow(app);
  await keysPage(app);
  const rows = app.locator('[data-keys-list] tr[data-command]');
  const chip = (name: string) => app.getByRole('group', { name: 'Filter actions' }).getByRole('button', { name: new RegExp(`^${name} \\d+$`) }); // the chip name carries its count (the owner D1 2026-11-06, ticket 223 B15)
  await expect(chip('All')).toHaveAttribute('aria-pressed', 'true');
  const all = await rows.count();
  await chip('Changed').click();
  await expect(chip('Changed')).toHaveAttribute('aria-pressed', 'true');
  await expect(chip('All')).toHaveAttribute('aria-pressed', 'false');
  await expect(rows).toHaveCount(3);
  await chip('Conflicts').click();
  await expect(rows).toHaveCount(2);
  expect((await rows.evaluateAll((els) => els.map((e) => e.getAttribute('data-command')))).sort()).toEqual(['focus.composer', 'focus.tree']);
  await chip('No key').click();
  expect(await rows.count()).toBeGreaterThan(1);
  await expect(row(app, 'tab.move.left')).toHaveCount(1);
  await expect(row(app, 'palette.open')).toHaveCount(0);
  await chip('All').click();
  await expect(rows).toHaveCount(all);
  // A pressed key finds its row: , is tab.rename, ⌘K is palette.open.
  const record = app.getByRole('button', { name: 'Record' });
  await record.click();
  await expect(record).toHaveAttribute('aria-pressed', 'true');
  await app.keyboard.press('Comma');
  await expect(record).toHaveAttribute('aria-pressed', 'false');
  await expect(app.getByRole('status').filter({ hasText: 'Bound to ,' })).toBeVisible();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toHaveAttribute('data-command', 'tab.rename');
  await record.click();
  await app.keyboard.press('Meta+KeyK');
  await expect(app.getByRole('dialog', { name: 'Command palette' })).toHaveCount(0);
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toHaveAttribute('data-command', 'palette.open');
  await app.getByRole('button', { name: 'Clear the key' }).click();
  await app.getByRole('searchbox', { name: 'Search actions or keys' }).fill('rename');
  await expect(rows.first()).toHaveAttribute('data-command', 'tab.rename');
  expect(await rows.count()).toBeGreaterThanOrEqual(3);
  // A jump to a row the search hides clears the search and the status line names the row.
  await app.getByRole('searchbox', { name: 'Search actions or keys' }).fill('font');
  await app.evaluate(() => window.dispatchEvent(new CustomEvent('nunchiro:keys.jump', { detail: 'tab.rename' })));
  await expect(app.getByRole('status').filter({ hasText: 'Cleared the search to show Rename the session tab.' })).toBeVisible();
  await expect(app.getByRole('searchbox', { name: 'Search actions or keys' })).toHaveValue('');
  await expect(row(app, 'tab.rename')).toBeVisible();
});

test('keys_filter_chips_show_counts: each chip counts its rows over all actions, not the search; only a non-zero Conflicts count is warn-coloured', async ({ app, core }) => {
  // The owner D1 2026-11-06 (ticket 223 B15): counts on the four chips, the app labels kept.
  core.shell(core.project('demo'), 'alpha');
  await withBindings(app, { 'focus.tree': ['Meta+KeyU'], 'focus.composer': ['Meta+KeyU'], 'tab.move.left': [] });
  await openWindow(app);
  await keysPage(app);
  const rows = app.locator('[data-keys-list] tr[data-command]');
  const chips = app.getByRole('group', { name: 'Filter actions' }).getByRole('button');
  const n = (i: number) => chips.nth(i).locator('.kcount');
  const shownBy = async (i: number) => (await chips.nth(i).click(), await expect(chips.nth(i)).toHaveAttribute('aria-pressed', 'true'), rows.count());
  const none = await shownBy(3);
  const all = await shownBy(0);
  await expect(chips).toHaveText([`All ${all + 1}`, 'Changed 3', 'Conflicts 2', `No key ${none}`]);
  expect(all).toBeGreaterThan(none);
  // The counts are over all actions: a search narrows the rows, not the numbers.
  await app.getByRole('searchbox', { name: 'Search actions or keys' }).fill('rename');
  await expect(rows).not.toHaveCount(all);
  await expect(chips).toHaveText([`All ${all + 1}`, 'Changed 3', 'Conflicts 2', `No key ${none}`]);
  await app.getByRole('searchbox', { name: 'Search actions or keys' }).fill('');
  const colours = () =>
    chips.evaluateAll((els) => {
      const probe = document.body.appendChild(document.createElement('span'));
      probe.style.color = 'var(--warn)';
      const warn = getComputedStyle(probe).color;
      probe.remove();
      return { warn, counts: els.map((e) => getComputedStyle(e.querySelector('.kcount')!).color) };
    });
  let c = await colours();
  expect(c.counts[2]).toBe(c.warn);
  for (const i of [0, 1, 3]) expect(c.counts[i], `chip ${i}`).not.toBe(c.warn);
  // Removing the clash makes Conflicts 0, no longer warn-coloured.
  await change(app, 'focus.composer', 'Focus the composer').click();
  await row(app, 'focus.composer').getByRole('button', { name: 'Remove' }).click();
  await expect(n(2)).toHaveText('0');
  await expect(n(3)).toHaveText(String(none + 1));
  c = await colours();
  expect(c.counts[2]).not.toBe(c.warn);
  expect(c.counts[2]).toBe(c.counts[1]);
});

test('keys_jump_row_moves_nine: one jump row; a digit on it moves all nine together; another key is refused', async ({ app, core }) => {
  const p = core.project('demo');
  const ids = ['one', 'two', 'three'].map((l) => core.shell(p, l).id);
  await openWindow(app);
  await keysPage(app);
  for (let n = 1; n <= 9; n++) await expect(app.locator(`[data-command="session.jump.${n}"]`)).toHaveCount(0);
  const r = row(app, 'session.jump');
  await expect(r).toHaveCount(1);
  await expect(r.locator('td').first().locator('.ktitle')).toHaveText('Go to tab 1-9'); // needs 192 (ticket 250 r3): the draft's description follows the name
  await expect(r.locator('td').nth(1)).toHaveText(/^⌘1-9\s*or\s*◆\s*1-9$/);
  await change(app, 'session.jump', 'Go to tab 1-9').click();
  await app.keyboard.press('Alt+KeyJ'); // not a digit: refused, still recording
  await expect(r.getByRole('alert')).toContainText('digit');
  await expect(box(app)).toHaveText('press a shortcut…');
  await app.keyboard.press('Alt+Digit4');
  await expect(box(app)).toHaveText('⌥1-9');
  await app.keyboard.press('Enter');
  await expect.poll(async () => (await stored(app))['session.jump.9']).toEqual(['Alt+Digit9', 'prefix Digit9']);
  expect((await stored(app))['session.jump.1']).toEqual(['Alt+Digit1', 'prefix Digit1']);
  await app.keyboard.press('Escape'); // v25f: close the modal before the tabs behind it
  await app.locator(`.tab[data-tab="${ids[0]}"]`).click();
  await app.keyboard.press('Alt+Digit3');
  await expect(app.locator('.tab[aria-selected="true"]')).toHaveAttribute('data-tab', ids[2]);
});

test('keys_which_key_delay_kept: the prefix help delay field takes 0 to 5000 and leaves the setting alone outside it', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await keysPage(app);
  const field = app.getByRole('spinbutton', { name: 'Prefix help delay (ms, 0 = off)' });
  const delay = () => app.evaluate(() => JSON.parse(localStorage.getItem('nunchiro.settings.v1') ?? '{}').prefixHelpDelay);
  await field.fill('5000');
  await expect.poll(delay).toBe(5000);
  await field.fill('5001');
  await field.fill('2.5');
  await field.fill('');
  expect(await delay()).toBe(5000);
  await field.fill('0');
  await expect.poll(delay).toBe(0);
  // needs 192 (ticket 250 r3): it sits with the prefix at the top of the list (final.html's prefix card), before the first area.
  const order = await app.evaluate(() => {
    const prefix = document.querySelector('section[data-area="prefix"]')!;
    const first = document.querySelector('[data-keys-list] section[data-area="palette-and-window"]')!;
    const f = document.querySelector('input[data-setting="prefixHelpDelay"]')!;
    return !!(prefix.compareDocumentPosition(f) & Node.DOCUMENT_POSITION_FOLLOWING) && !!(f.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
  expect(order).toBe(true);
});

test('keys_hints_tab_kept: Hints keeps the alphabet field and the drawing; no Key map tab; the sub-nav button and a search hit land on it', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await keysPage(app);
  // needs 192 (ticket 250): no tabs; the shortcuts list, then the hints part (heading "Hints") on the same page.
  const part = app.getByRole('heading', { name: /^Hints/, level: 2 });
  await expect(app.locator('.settings').getByRole('tab', { name: 'Key map' })).toHaveCount(0);
  await expect(app.locator('.settings').getByRole('tablist')).toHaveCount(0);
  await app.getByRole('button', { name: 'Options ↓' }).click();
  await expect(app.getByRole('textbox', { name: 'Hint alphabet' })).toBeVisible();
  await expect(app.locator('.sbody .hk-board')).toHaveCount(1);
  await expect(app.getByRole('region', { name: 'Hints' }).locator('.hk-scroll')).toHaveCount(1);
  // The Options link opens it from the top of the list.
  await app.locator('.settings .sbody').evaluate((el) => (el.scrollTop = 0));
  await app.getByRole('button', { name: 'Options ↓' }).click();
  await expect(part).toBeFocused();
  await expect(app.getByRole('textbox', { name: 'Hint alphabet' })).toBeVisible();
  // So does a settings search hit for "Hint alphabet" (the search box, then its result).
  await app.locator('.settings .sbody').evaluate((el) => (el.scrollTop = 0));
  await app.getByRole('searchbox', { name: 'Search settings' }).fill('Hint label keys');
  await app.getByRole('list', { name: 'Matching settings' }).getByRole('button').filter({ hasText: /^Hint alphabet/ }).click(); // ticket 991 C14: the row's own title
  await expect(app.locator('[data-setting="hintKeys"]')).toBeFocused();
  await expect(app.getByRole('textbox', { name: 'Hint alphabet' })).toBeVisible();
});

test('keys_list_conformance_frame_a: the app page carries the frame structure in light and dark and writes its screenshots', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  const dir = path.join(REPO, '.scratch/keys-redesign');
  fs.mkdirSync(dir, { recursive: true });
  for (const scheme of ['light', 'dark'] as const) {
    await app.emulateMedia({ colorScheme: scheme });
    await keysPage(app);
    await expect(app.getByRole('heading', { level: 1, name: 'Keyboard' })).toBeVisible(); // needs 192 (ticket 250): the page title is the h1
    const search = app.locator('.ksearch');
    await expect(search.getByRole('searchbox', { name: 'Search actions or keys' })).toBeVisible();
    await expect(app.locator('.kbar').getByRole('button', { name: 'Record' })).toBeVisible(); // final.html: beside the field, not in it
    await expect(app.getByRole('group', { name: 'Filter actions' }).getByRole('button')).toHaveText([/^All \d+$/, /^Changed \d+$/, /^Conflicts \d+$/, /^No key \d+$/]);
    await expect(app.locator('[data-command="prefix"] .kcell')).toHaveText(/^⌃\.\s*or\s*⌃␣$/);
    await expect(app.getByRole('region', { name: 'Fixed keys (cannot be changed)' })).toBeVisible();
    await app.screenshot({ path: path.join(dir, `app-${scheme}.png`) });
  }
});

test('keys_reachable_within_two_clicks: Settings then Keyboard shows the list with a Change button on each row; the palette reaches it too', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await app.getByRole('button', { name: 'Settings', exact: true }).click();
  await nav(app).getByRole('button', { name: 'Keyboard' }).click();
  await expect(app.locator('[data-keys-list]')).toBeVisible();
  const rows = await app.locator('[data-keys-list] tr[data-command]').count();
  expect(rows).toBeGreaterThan(40);
  await expect(app.locator('[data-keys-list] tr[data-command] button.kedit')).toHaveCount(rows);
  for (const b of await app.locator('[data-keys-list] tr[data-command] button.kedit').all()) expect(await b.getAttribute('aria-label')).toMatch(/^Change /);
  await app.keyboard.press('Escape'); // v25f: a reload keeps an open modal
  await expect(app.locator('.ovl')).toHaveCount(0); // closed and saved before the reload
  await app.reload();
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  await app.keyboard.press('Meta+KeyK');
  await app.getByRole('dialog', { name: 'Command palette' }).locator('[data-command="settings.open"]').click();
  await nav(app).getByRole('button', { name: 'Keyboard' }).click();
  await expect(app.locator('[data-keys-list]')).toBeVisible();
});

test('keys_page_lists_reopen_closed_tab: the row is listed and rebindable while no tab was closed', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await keysPage(app);
  await expect(row(app, 'tab.reopen')).toHaveCount(1);
  await expect(change(app, 'tab.reopen', 'Reopen closed tab')).toBeVisible();
});
