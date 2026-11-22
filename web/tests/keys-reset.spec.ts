// needs 170 (3): the fixed reset chord (⌃⌥⇧Esc) and the last good keymap kept beside a broken store.
import type { Page } from '@playwright/test';
import { DEFAULT_BINDINGS, merge, RESET_CHORD, conflicts } from '../src/keys';
import { parse } from '../src/settings';
import { expect, openWindow, test } from './fixtures';
import { closeSettings, openSettings } from './settings-modal';

const KEY = 'nunchiro.settings.v1';
const nav = (app: Page) => app.getByRole('navigation', { name: 'Settings pages' });
async function keysPage(app: Page) {
  await openSettings(app);
  await nav(app).getByRole('button', { name: 'Keyboard' }).click();
  await expect(app.locator('[data-keys-list]')).toBeVisible();
}
const stored = (app: Page) => app.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? '{}').bindings ?? {}, KEY) as Promise<Record<string, string[]>>;
const THREE = { 'focus.tree': ['Meta+KeyU'], 'tab.move.left': ['Meta+KeyY'], 'focus.composer': ['Meta+KeyG'] };
const seed = (app: Page, bindings: Record<string, unknown>) => app.addInitScript(([k, b]) => localStorage.getItem(k as string) === null && localStorage.setItem(k as string, JSON.stringify({ bindings: b })), [KEY, bindings] as const);
/** The chord on the page, the window, or a terminal's own input. */
const chord = (page: Page, target = 'body') =>
  page.evaluate(
    (sel) => {
      const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, code: 'Escape', ctrlKey: true, altKey: true, shiftKey: true });
      (document.querySelector(sel) ?? document.body).dispatchEvent(e);
      return e.defaultPrevented;
    },
    target,
  );

test('reset_all_button_undo: Reset all closes the recorder and clears the keys; Undo restores them and keeps a key bound since', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await keysPage(app);
  const cell = (id: string) => app.locator(`tr[data-command="${id}"] td`).nth(1);
  const bind = async (id: string, keys: string) => {
    await app.locator(`tr[data-command="${id}"] button.kedit`).click();
    await app.keyboard.press(keys);
    await app.keyboard.press('Enter');
    await expect(app.locator('.krec-box')).toHaveCount(0);
  };
  await bind('focus.tree', 'Control+Alt+KeyU');
  await expect(cell('focus.tree')).toHaveText('⌃⌥U');
  await app.locator('tr[data-command="tab.move.left"] button.kedit').click();
  await expect(app.locator('.krec-box')).toHaveCount(1);
  await app.getByRole('button', { name: 'Reset all to defaults' }).click();
  await expect(app.locator('.krec-box')).toHaveCount(0);
  await expect.poll(() => stored(app)).toEqual({});
  await expect(cell('focus.tree')).toHaveText(/◆\s*e/);
  await bind('tab.move.left', 'Control+Alt+KeyY');
  await app.getByRole('status').filter({ hasText: 'Key changes cleared' }).getByRole('button', { name: 'Undo' }).click();
  await expect.poll(() => stored(app)).toEqual({ 'focus.tree': ['Control+Alt+KeyU'], 'tab.move.left': ['Control+Alt+KeyY'] });
  await expect(cell('focus.tree')).toHaveText('⌃⌥U');
});

test('reset_chord_fixed: ⌃⌥⇧Esc clears the overrides from the page, while recording and inside a terminal; one Undo restores them', async ({ app, core }) => {
  const id = core.shell(core.project('demo'), 'raw', '/bin/sh', '-c', 'stty raw -echo; exec cat -v').id;
  await seed(app, THREE);
  await openWindow(app);
  await keysPage(app);
  expect(await stored(app)).toEqual(THREE);
  // The fixed-keys card names it.
  await expect(app.getByRole('region', { name: 'Fixed keys (cannot be changed)' })).toContainText('⌃⌥⇧Esc');
  // From the page.
  expect(await chord(app)).toBe(true);
  await expect.poll(() => stored(app)).toEqual({});
  await expect(app.getByRole('status').filter({ hasText: 'Keys reset to defaults' })).toBeVisible();
  await expect(app.locator('tr[data-command="focus.tree"] td').nth(1)).toHaveText(/◆\s*e/);
  await app.getByRole('status').filter({ hasText: 'Key changes cleared' }).getByRole('button', { name: 'Undo' }).click();
  await expect.poll(() => stored(app)).toEqual(THREE);
  // While recording: the recorder says so and the chord still clears.
  await app.locator('tr[data-command="focus.composer"] button.kedit').click();
  await app.keyboard.press('Control+Alt+Shift+Escape');
  await expect(app.locator('tr[data-command="focus.composer"] [role="alert"]')).toHaveText('⌃⌥⇧Esc is the fixed reset chord');
  await expect.poll(() => stored(app)).toEqual({});
  await app.keyboard.press('Escape');
  await app.getByRole('status').filter({ hasText: 'Key changes cleared' }).getByRole('button', { name: 'Undo' }).click();
  await expect.poll(() => stored(app)).toEqual(THREE);
  // Inside a terminal: taken, and no byte reaches the agent.
  await closeSettings(app); // the tab sits behind the Settings modal
  const area = `.term[data-session="${id}"] .xterm-helper-textarea`;
  await app.locator(`.tab[data-tab="${id}"]`).click();
  await app.locator(area).focus();
  expect(await chord(app, area)).toBe(true);
  await expect.poll(() => stored(app)).toEqual({});
  expect(core.read(id)).toBe('');
  // The chord is nobody's binding.
  expect(Object.values(DEFAULT_BINDINGS).flat()).not.toContain(RESET_CHORD);
  expect(Object.values(merge({})).flat()).not.toContain(RESET_CHORD);
  expect(conflicts(merge({}), RESET_CHORD, 'x')).toEqual([]);
});

test('broken_key_file_keeps_last_good: parse keeps the last good keymap, clean false; with none it falls back to {}', () => {
  const good = JSON.stringify({ 'focus.tree': ['Meta+KeyU'] });
  for (const bad of [5, [1, 2], { x: [1] }, { x: 'Meta+KeyU' }]) {
    const r = parse(JSON.stringify({ bindings: bad }), good);
    expect(r.settings.bindings, JSON.stringify(bad)).toEqual({ 'focus.tree': ['Meta+KeyU'] });
    expect(r.clean).toBe(false);
    const none = parse(JSON.stringify({ bindings: bad }), null);
    expect(none.settings.bindings).toEqual({});
    expect(none.clean).toBe(false);
  }
  // A last-good copy that no longer validates is not used either.
  expect(parse(JSON.stringify({ bindings: 5 }), JSON.stringify({ x: 3 })).settings.bindings).toEqual({});
  // A clean store with its own bindings is untouched (an emptied map written by a reset is a map too).
  expect(parse(JSON.stringify({ bindings: { 'focus.tree': ['KeyJ'] } }), good)).toMatchObject({ clean: true, settings: { bindings: { 'focus.tree': ['KeyJ'] } } });
  expect(parse(JSON.stringify({ bindings: {} }), good)).toMatchObject({ clean: true, settings: { bindings: {} } });
  // Strict review SHOULD 1: a store that does not parse at all (truncated JSON, not an object) or has no `bindings` keeps the
  // last good keymap too, so the save that follows never overwrites `.lastgood` with the defaults.
  for (const raw of ['{"bindings":{', '[1,2]', 'null', '{"density":"compact"}', '{}']) {
    const r = parse(raw, good);
    expect(r.settings.bindings, raw).toEqual({ 'focus.tree': ['Meta+KeyU'] });
    expect(r.clean, raw).toBe(raw === '{"density":"compact"}' || raw === '{}');
  }
  expect(parse('{"bindings":{', null).settings.bindings).toEqual({});
});

test('broken_key_file_keeps_last_good (window): a corrupted bindings value on disk keeps the saved keymap, the raw copy and the notice', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await keysPage(app);
  await app.locator('tr[data-command="focus.tree"] button.kedit').click();
  await app.keyboard.press('Meta+KeyU');
  await app.keyboard.press('Enter');
  await expect.poll(() => stored(app)).toEqual({ 'focus.tree': ['Meta+KeyU'] });
  expect(await app.evaluate((k) => localStorage.getItem(`${k}.lastgood`), KEY)).toBe(JSON.stringify({ 'focus.tree': ['Meta+KeyU'] }));
  // Corrupt the bindings (a number, then an array of numbers), keep the rest, and reload.
  for (const bad of [5, [1, 2]]) {
    const raw = await app.evaluate(([k, b]) => {
      const s = JSON.parse(localStorage.getItem(k as string)!);
      s.bindings = b;
      const text = JSON.stringify(s);
      localStorage.setItem(k as string, text);
      return text;
    }, [KEY, bad] as const);
    await app.reload();
    await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
    expect(await app.evaluate((k) => localStorage.getItem(`${k}.bak`), KEY)).toBe(raw);
    expect(await stored(app)).toEqual({ 'focus.tree': ['Meta+KeyU'] });
    await keysPage(app);
    await expect(app.locator('tr[data-command="focus.tree"] td').nth(1)).toHaveText('⌘U');
    await app.keyboard.press('Meta+KeyW'); // back to the session tabs for the next round
  }
  // A store that no longer parses: the keymap and `.lastgood` both survive the start-up save (strict review SHOULD 1).
  await app.evaluate((k) => (localStorage.setItem(k, JSON.stringify({ bindings: { 'focus.tree': ['Meta+KeyU'] } })), localStorage.setItem(`${k}.lastgood`, JSON.stringify({ 'focus.tree': ['Meta+KeyU'] }))), KEY);
  await app.reload();
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  await app.evaluate((k) => localStorage.setItem(k, '{"bindings":{'), KEY);
  await app.reload();
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  expect(await stored(app)).toEqual({ 'focus.tree': ['Meta+KeyU'] });
  expect(await app.evaluate((k) => localStorage.getItem(`${k}.lastgood`), KEY)).toBe(JSON.stringify({ 'focus.tree': ['Meta+KeyU'] }));
  expect(await app.evaluate((k) => localStorage.getItem(`${k}.bak`), KEY)).toBe('{"bindings":{');
  // With no last-good copy it falls back to the defaults, as before.
  await app.evaluate((k) => (localStorage.removeItem(`${k}.lastgood`), localStorage.setItem(k, JSON.stringify({ bindings: 5 }))), KEY);
  await app.reload();
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  expect(await stored(app)).toEqual({});
});
