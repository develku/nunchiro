// The default keymap and the key dispatch behind it (needs 166, recommended map of .scratch/keymap-proposal/keymap.md):
// ⌘ chords first, the old prefix keys as second bindings, ⌘W / ⌘N / Ctrl+O as rebindable commands.
import type { Page } from '@playwright/test';
import { conflicts, DEFAULT_BINDINGS, merge, resolve, SETTINGS_ONLY, unassigned } from '../src/keys';
import { expect, openWindow, test } from './fixtures';
import { openQuiet } from './tree-seed';
import { repo } from './visual/compare';

const activeTab = (page: Page) => page.locator('.tab[aria-selected="true"]').getAttribute('data-tab');
/** A key sent straight to the window (it works when the pointer or focus is anywhere), reporting whether the app took it. */
const press = (page: Page, init: { code: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean }, onTarget = 'document.body') =>
  page.evaluate(
    ([i, sel]) => {
      const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...(i as KeyboardEventInit) });
      (document.querySelector(sel as string) ?? document.body).dispatchEvent(e);
      return e.defaultPrevented;
    },
    [init, onTarget] as const,
  );
const rebind = (page: Page, bindings: Record<string, string[]>) => page.addInitScript((b) => localStorage.getItem('nunchiro.settings.v1') === null && localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ bindings: b })), bindings);
/** A fake desktop app: every `invoke` is recorded. */
const fakeApp = (page: Page) =>
  page.addInitScript(() => {
    const w = window as unknown as { __invoked: [string, unknown][]; __TAURI_INTERNALS__: unknown };
    w.__invoked = [];
    w.__TAURI_INTERNALS__ = { invoke: (cmd: string, args: unknown) => (w.__invoked.push([cmd, args]), Promise.resolve(null)), transformCallback: () => 1, metadata: {} };
  });
const invoked = (page: Page) => page.evaluate(() => (window as unknown as { __invoked: [string, unknown][] }).__invoked.map(([c]) => c));

// What the table of the brief (item B and G) sets; every other id keeps the value it had before the lane.
const CHANGED: Record<string, string[]> = {
  'palette.open': ['Meta+KeyK', 'Shift+Meta+KeyP'],
  'worktree.create': ['Meta+KeyN'],
  'tab.close': ['Meta+KeyW'],
  'session.new': ['Meta+KeyT', 'prefix KeyC'],
  // v25-new-tab (needs 209): the New tab popover's rows have keys of their own.
  'session.new.terminal': ['Control+Shift+Backquote'], // v25-reopen-tab (ticket 299): ⇧⌘T is Reopen closed tab, as in a browser
  'tab.reopen': ['Shift+Meta+KeyT'],
  'tab.new.browser': ['Shift+Meta+KeyB'],
  'browser.tab.next': ['prefix Shift+BracketRight'], // ticket 328
  'browser.tab.prev': ['prefix Shift+BracketLeft'],
  'browser.tab.close': ['prefix Shift+KeyW'],
  'browser.tab.new': ['prefix Shift+KeyT'],
  'session.new.claude': ['Shift+Meta+KeyC'],
  'session.new.codex': ['Shift+Meta+KeyO'],
  'session.next': ['Shift+Meta+BracketRight', 'prefix KeyN'],
  'session.prev': ['Shift+Meta+BracketLeft', 'prefix KeyP'],
  'sidebar.left.toggle': ['Meta+KeyB', 'prefix KeyB'],
  'sidebar.right.toggle': ['Alt+Meta+KeyB'], // v25f F13
  'bars.toggle': ['Shift+Meta+Backslash'],
  'files.show': ['Shift+Meta+KeyE', 'prefix KeyX'],
  'search.open': ['Shift+Meta+KeyF', 'prefix KeyS'],
  'search.sessions': ['Alt+Meta+KeyF'], // ticket 1130 C3
  'pane.shell.new': ['Control+Backquote'], // ticket 1130 C4
  'chat.cycleView': ['Control+KeyO'],
  'keys.help': ['prefix Shift+Slash'],
  'keys.sheet': ['Meta+Slash'], // ticket 1099: ⌘/ is the whole sheet (mockup cohesion-1099 panel 5)
  'session.side-chat': ['prefix KeyA'], // ticket 1099: the side chat had only its header button
  'tab.rename': ['prefix Comma', 'F2'],
  'pane.focus.left': ['Alt+Meta+ArrowLeft'],
  'pane.focus.right': ['Alt+Meta+ArrowRight'],
  'pane.focus.up': ['Alt+Meta+ArrowUp'],
  'pane.focus.down': ['Alt+Meta+ArrowDown'],
  'settings.search': ['Meta+KeyF'], // ticket 516: Settings only (SETTINGS_ONLY), beside terminal.find's ⌘F
  ...Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => [`session.jump.${n}`, [`Meta+Digit${n}`, `prefix Digit${n}`]])),
  ...Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => [`project.jump.${n}`, [`Control+Digit${n}`]])), // ticket 570
};
/** The map before the lane, for the ids it did not touch (written out, not read from keys.ts). */
const KEPT: Record<string, string[]> = {
  prefix: ['Control+Period', 'Control+Space'],
  'settings.open': ['Meta+Comma'],
  'zoom.in': ['Meta+Equal', 'Shift+Meta+Equal'], // ticket 1071: were font.* (v1a-39)
  'zoom.out': ['Meta+Minus'],
  'zoom.reset': ['Meta+Digit0'],
  'hints.show': ['prefix KeyF'],
  'hints.copy': ['prefix KeyY'],
  'terminal.find': ['Meta+KeyF'],
  'terminal.copy': ['prefix BracketLeft'],
  'terminal.edit': ['prefix KeyV'],
  'zone.zoom': ['prefix KeyZ'],
  'session.last': ['prefix Tab'],
  'decision.back': ['Meta+BracketLeft'],
  'tab.move.left': ['prefix Shift+Comma'],
  'tab.move.right': ['prefix Shift+Period'],
  'window.detach': ['prefix KeyD'],
  'waiting.next': ['prefix KeyW'],
  'layout.edit': ['prefix KeyL'],
  'pane.mode': ['prefix KeyR'],
  'composer.toggle': ['prefix KeyT'],
  'composer.steerNow': ['Control+Enter'],
  'composer.backgroundSend': ['Meta+Enter'],
  'focus.tree': ['prefix KeyE'],
  'focus.composer': ['prefix KeyI'],
  'focus.terminal': ['prefix KeyO'],
  'pane.toggle': ['Meta+KeyJ'],
  'pane.maximize': ['Shift+Meta+Enter'],
  'split.right': ['Meta+KeyD', 'prefix Shift+Digit5'],
  'split.down': ['Shift+Meta+KeyD', 'prefix Shift+Quote'],
  'diff.open': ['prefix KeyG'],
  'artifacts.toggle': ['prefix KeyM'],
  'board.toggle': ['prefix KeyK'],
  'preview.toggle': ['prefix KeyQ'],
  'projects.pick': ['prefix KeyJ'],
  'files.quickOpen': ['Meta+KeyP'], // ticket 821
  'session.new.worktree': ['Shift+Meta+KeyN'], // ticket 1130 C2
};

test('default_keymap_table: DEFAULT_BINDINGS is the brief’s table for the changed ids, the old value for the rest, every id has an area', () => {
  expect(DEFAULT_BINDINGS).toEqual({ ...KEPT, ...CHANGED });
  expect(unassigned(DEFAULT_BINDINGS)).toEqual([]);
  // An explicit area for the new ids (the stem would have put them in Other).
  for (const id of ['worktree.create', 'tab.close', 'chat.cycleView', 'pane.focus.left']) expect(unassigned({ [id]: ['Meta+KeyU'] }), id).toEqual([]);
});

// Bare chords (no Meta) a default may hold. ⌃⇧` is the editors' new terminal (ticket 299): allowed for that command id alone.
const BARE = new Set(['Control+Enter', 'Control+KeyO', 'F2']);
// Ticket 570 (owner, 2026-11-13): ⌃1-9 show the tree's projects, as ⌘ digits stay the shown project's tabs.
// Ticket 1130 C4: ⌃` is the shell beside the agent (Claude Desktop's terminal key); in a PTY it would only send NUL.
const BARE_FOR = new Map([['Control+Shift+Backquote', 'session.new.terminal'], ['Control+Backquote', 'pane.shell.new'], ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => [`Control+Digit${n}`, `project.jump.${n}`] as const)]);
// Alt+Meta+KeyB: the owner's right-sidebar key (v25f F13); Alt+Meta+KeyF: Search sessions beside ⇧⌘F (ticket 1130 C3).
const PANE = new Set(['Alt+Meta+ArrowLeft', 'Alt+Meta+ArrowRight', 'Alt+Meta+ArrowUp', 'Alt+Meta+ArrowDown', 'Alt+Meta+KeyB', 'Alt+Meta+KeyF']);
/** What breaks the "no bare default" rule in `bindings`, as `id chord` lines. */
const bareViolations = (bindings: Record<string, string[]>) => {
  const bad: string[] = [];
  for (const [id, bs] of Object.entries(bindings))
    for (const b of bs) {
      if (b.startsWith('prefix ') || id === 'prefix') continue; // the prefix and its second bindings
      const ok = /(^|\+)Alt(\+|$)/.test(b) ? PANE.has(b) : b.split('+').includes('Meta') || BARE.has(b) || BARE_FOR.get(b) === id;
      if (!ok) bad.push(`${id} ${b}`);
    }
  return bad;
};

test('no_default_takes_alt_or_bare_keys: every direct default carries Meta (Control+Enter, Control+O, F2 and the prefix aside); Alt only with Meta on the pane-focus chords', () => {
  expect(bareViolations(DEFAULT_BINDINGS)).toEqual([]);
  // A second binding never reuses a key (no default holds another command's chord). A Settings-only command (ticket 516)
  // is checked against the other Settings-only ones alone: it holds its key only while Settings is open.
  for (const only of [false, true]) {
    const seen = new Map<string, string>();
    for (const [id, bs] of Object.entries(DEFAULT_BINDINGS)) if (SETTINGS_ONLY.includes(id) === only) for (const b of bs) expect(seen.get(b), `${b}: ${id} and ${seen.get(b)}`).toBeUndefined(), seen.set(b, id);
  }
});

test('settings_only_keys: ⌘F is the terminal find outside Settings and the Settings search inside it', () => {
  const b = merge({});
  expect(resolve(b, 'Meta+KeyF', false)).toEqual({ kind: 'command', id: 'terminal.find' });
  expect(resolve(b, 'Meta+KeyF', false, true)).toEqual({ kind: 'command', id: 'settings.search' });
  // Rebound elsewhere, the Settings search leaves ⌘F to the terminal find in Settings too.
  expect(resolve(merge({ 'settings.search': ['Shift+Meta+KeyL'] }), 'Meta+KeyF', false, true)).toEqual({ kind: 'command', id: 'terminal.find' });
  expect(resolve(merge({ 'settings.search': ['Shift+Meta+KeyL'] }), 'Shift+Meta+KeyL', false, true)).toEqual({ kind: 'command', id: 'settings.search' });
  // Only the ⌘F pair is exempt from the clash check: ⌘K for the Settings search is the palette's key, and says so.
  expect(conflicts(b, 'Meta+KeyF', 'settings.search')).toEqual([]);
  expect(conflicts(b, 'Meta+KeyF', 'terminal.find')).toEqual([]);
  expect(conflicts(b, 'Meta+KeyK', 'settings.search')).toEqual(['palette.open']);
  expect(conflicts({ ...b, 'settings.search': ['Meta+KeyK'] }, 'Meta+KeyK', 'palette.open')).toEqual(['settings.search']);
});

test('keys_defaults_backquote_allowed_for_terminal_only: ⌃⇧` is a bare default for the terminal command alone; another command taking it fails the guard', () => {
  expect(DEFAULT_BINDINGS['session.new.terminal']).toEqual(['Control+Shift+Backquote']);
  expect(bareViolations({ 'session.new.terminal': ['Control+Shift+Backquote'] })).toEqual([]);
  // Mutation check: the same chord on any other command, alone or beside the terminal's, is reported.
  expect(bareViolations({ 'tab.reopen': ['Control+Shift+Backquote'] })).toEqual(['tab.reopen Control+Shift+Backquote']);
  expect(bareViolations({ ...DEFAULT_BINDINGS, 'session.new': ['Control+Shift+Backquote'] })).toEqual(['session.new Control+Shift+Backquote']);
  // The other bare chords stay as they were.
  expect(bareViolations({ 'tab.reopen': ['Control+Enter'], x: ['F2'], y: ['Control+KeyO'] })).toEqual([]);
  expect(bareViolations({ x: ['Control+KeyP'] })).toEqual(['x Control+KeyP']);
});

test('cmd_t_opens_new_session: ⌘T from the page and from inside a terminal; the prefix c still does', async ({ app, core }) => {
  const id = core.shell(core.project('demo'), 'alpha').id;
  await openWindow(app);
  const dialog = app.getByRole('dialog', { name: 'New tab' }); // v25-new-tab: the popover (needs 209)
  await app.keyboard.press('Meta+KeyT');
  await expect(dialog).toBeVisible();
  await app.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await app.locator(`.term[data-session="${id}"] .xterm-helper-textarea`).focus();
  expect(await app.evaluate(() => document.activeElement?.classList.contains('xterm-helper-textarea'))).toBe(true);
  await app.keyboard.press('Meta+KeyT');
  await expect(dialog).toBeVisible();
  await app.keyboard.press('Escape');
  await app.locator(`.tab[data-tab="${id}"]`).click();
  await app.keyboard.press('Control+Period');
  await app.keyboard.press('KeyC');
  await expect(dialog).toBeVisible();
});

test('cmd_w_closes_session_tab_and_undo_restores: ⌘W closes the active tab (the session keeps running), Undo puts it back', async ({ app, core }) => {
  const p = core.project('demo');
  const ids = ['one', 'two', 'three'].map((l) => core.shell(p, l).id);
  await openWindow(app);
  await app.locator(`.tab[data-tab="${ids[1]}"]`).click();
  await app.keyboard.press('Meta+KeyW');
  await expect(app.locator('.tab[data-tab]')).toHaveCount(2);
  await expect(app.locator(`.tab[data-tab="${ids[1]}"]`)).toHaveCount(0);
  expect((core.cli('snapshot', '--json').sessions as { state: string }[]).filter((s) => s.state === 'running')).toHaveLength(3);
  await app.getByRole('status').filter({ hasText: 'tab closed' }).getByRole('button', { name: 'Undo' }).click();
  await expect(app.locator('.tab[data-tab]')).toHaveCount(3);
  expect(await app.locator('.tab[data-tab]').evaluateAll((els) => els.map((e) => e.getAttribute('data-tab')))).toEqual(ids);
});

test('cmd_w_with_no_tab_does_nothing: the key is taken, nothing closes and the app’s close_window is never invoked', async ({ app, core }) => {
  await fakeApp(app);
  await openWindow(app);
  await expect(app.locator('.tab[data-tab]')).toHaveCount(0);
  expect(await press(app, { code: 'KeyW', metaKey: true })).toBe(true);
  expect(await press(app, { code: 'KeyW', metaKey: true })).toBe(true);
  const calls = await invoked(app);
  expect(calls.filter((c) => /close_window|window\|(close|destroy)/.test(c))).toEqual([]);
  await expect(app.locator('.sbar, .status').first()).toBeVisible(); // the window is still there
  void core;
});

test('cmd_n_is_rebindable: ⌘N opens New worktree; rebound to ⌥N only the new key does; unbound, neither', async ({ app, core }) => {
  const p = repo(core, 'nunchiro');
  core.shell(p, 'main');
  openQuiet(core);
  await rebind(app, {});
  await app.routeWebSocket(/\/ws$/, (ws) => { // The snapshot (the project New worktree acts on) lands late: a key pressed before it finds the command disabled.
    const server = ws.connectToServer();
    ws.onMessage((m) => server.send(m));
    server.onMessage((m) => { const o = typeof m === 'string' ? JSON.parse(m) : null; if (o?.event === 'snapshot') setTimeout(() => ws.send(m), 1500); else ws.send(m); });
  });
  await openWindow(app);
  const dialog = app.getByRole('dialog', { name: 'New worktree' });
  await app.keyboard.press('Meta+KeyN');
  await expect(dialog).toBeVisible();
  await app.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  // Rebound: the settings are read at start, so a fresh page takes the override.
  const set = (b: Record<string, string[]>) => app.evaluate((x) => localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ bindings: x })), b);
  await set({ 'worktree.create': ['Alt+KeyN'] });
  await app.reload();
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  await expect(app.locator('.tab[data-tab]')).toContainText('shell · main'); // the snapshot (v25-shell-chrome: the restored tab shows before it, with no name yet)
  await app.keyboard.press('Meta+KeyN');
  await expect(dialog).toHaveCount(0);
  await app.keyboard.press('Alt+KeyN');
  await expect(dialog).toBeVisible();
  await app.keyboard.press('Escape');
  await set({ 'worktree.create': [] });
  await app.reload();
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  await expect(app.locator('.tab[data-tab]')).toContainText('shell · main'); // the snapshot (v25-shell-chrome: the restored tab shows before it, with no name yet)
  for (const code of ['Meta+KeyN', 'Alt+KeyN']) {
    await app.keyboard.press(code);
    await expect(dialog).toHaveCount(0);
  }
});

// RC2b (V2-8a create_one_field_forms red): a chord whose dispatch commits a render before the app's own key listener
// still reaches it. The tree's menu-project clear runs on every keydown first; with an app update pending (here a tab
// switch in the same key, in the window a core message) React commits right there, and the listener the app re-added
// on each render was skipped for that key.
test('cmd_n_survives_a_render_in_its_dispatch: ⌘N opens New worktree when the app renders while the key is dispatched', async ({ app, core }) => {
  const p = repo(core, 'nunchiro');
  core.shell(p, 'main');
  const other = core.shell(p, 'other');
  openQuiet(core);
  // Registered before the app's listeners: on ⌘N it switches the tab, as a core message landing then would.
  await app.addInitScript((id) => window.addEventListener('keydown', (e) => e.code === 'KeyN' && e.metaKey && window.dispatchEvent(new CustomEvent('nunchiro:session.open', { detail: { id } })), true), other.id);
  await openWindow(app);
  await app.keyboard.press('Meta+KeyN');
  await expect(app.locator('.tab[aria-selected="true"]')).toHaveAttribute('data-tab', other.id);
  await expect(app.getByRole('dialog', { name: 'New worktree' })).toBeVisible();
});

// V2-8a and needs 166: F2 on a focused worktree row edits that row's label; anywhere else it renames the active tab.
test('keys_f2_row_vs_tab: F2 on a focused worktree row opens its label field, not the tab’s; F2 on the page body renames the tab', async ({ app, core }) => {
  const p = repo(core, 'nunchiro');
  core.cli('worktree', 'create', '--project', p, '--branch', 'named', '--no-focus');
  core.shell(p, 'main-shell');
  openQuiet(core);
  await openWindow(app);
  const label = app.getByRole('textbox', { name: /Worktree label/ });
  const tabBox = app.getByRole('textbox', { name: 'Rename main-shell' });
  await app.locator('.row.wt2').filter({ hasText: 'named' }).first().focus();
  await app.keyboard.press('F2');
  await expect(label).toBeFocused();
  await expect(tabBox).toHaveCount(0);
  await app.keyboard.press('Escape');
  await expect(label).toHaveCount(0);
  await app.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await app.keyboard.press('F2');
  await expect(tabBox).toBeFocused();
  await expect(label).toHaveCount(0);
});

test('cmd_digit_goes_to_tab_and_nine_is_the_ninth: ⌘1 and ⌘9 pick tabs, the prefix digit still does, a missing tab does nothing', async ({ app, core }) => {
  const p = core.project('demo');
  const ids = Array.from({ length: 9 }, (_, i) => core.shell(p, `s${i + 1}`).id);
  await openWindow(app);
  await app.keyboard.press('Meta+Digit9');
  expect(await activeTab(app)).toBe(ids[8]);
  await app.keyboard.press('Meta+Digit1');
  expect(await activeTab(app)).toBe(ids[0]);
  await app.keyboard.press('Control+Period');
  await app.keyboard.press('Digit3');
  expect(await activeTab(app)).toBe(ids[2]);
  await app.keyboard.press('Meta+Digit5');
  expect(await activeTab(app)).toBe(ids[4]);
});

test('cmd_digit_with_fewer_tabs: a tab that does not exist is not opened', async ({ app, core }) => {
  const p = core.project('demo');
  const ids = ['one', 'two'].map((l) => core.shell(p, l).id);
  await openWindow(app);
  await app.keyboard.press('Meta+Digit2');
  expect(await activeTab(app)).toBe(ids[1]);
  await app.keyboard.press('Meta+Digit7');
  expect(await activeTab(app)).toBe(ids[1]);
});

test('cmd_chords_for_sessions_and_views: ⌘⇧] and ⌘⇧[ move sessions, ⌘B the sidebar, ⌘⇧E Files, ⌘⇧F Search, ⌘K and ⌘⇧P the palette; the old keys work', async ({ app, core }) => {
  const p = core.project('demo');
  const ids = ['one', 'two', 'three'].map((l) => core.shell(p, l).id);
  await openWindow(app);
  await app.keyboard.press('Shift+Meta+BracketRight');
  expect(await activeTab(app)).toBe(ids[1]);
  await app.keyboard.press('Shift+Meta+BracketLeft');
  expect(await activeTab(app)).toBe(ids[0]);
  await app.keyboard.press('Control+Period');
  await app.keyboard.press('KeyN');
  expect(await activeTab(app)).toBe(ids[1]);
  await app.keyboard.press('Control+Period');
  await app.keyboard.press('KeyP');
  expect(await activeTab(app)).toBe(ids[0]);
  // The palette: both chords, and Esc closes.
  const palette = app.getByRole('dialog', { name: 'Command palette' });
  for (const k of ['Meta+KeyK', 'Shift+Meta+KeyP']) {
    await app.keyboard.press(k);
    await expect(palette).toBeVisible();
    await app.keyboard.press('Escape');
    await expect(palette).toHaveCount(0);
  }
  // The views: each new chord does what the old prefix key does.
  const files = app.locator('.ai[data-hint-icon="files.show"]');
  const search = app.locator('.ai[data-hint-icon="search.open"]');
  const sidebar = app.locator('.tree').first();
  const seen = async () => [await files.getAttribute('aria-pressed'), await search.getAttribute('aria-pressed'), await sidebar.isVisible()];
  const start = await seen();
  await app.keyboard.press('Shift+Meta+KeyE');
  await expect.poll(async () => (await seen())[0]).not.toBe(start[0]);
  await app.keyboard.press('Shift+Meta+KeyF');
  await expect.poll(async () => (await seen())[1]).not.toBe(start[1]);
  await app.keyboard.press('Meta+KeyB');
  await expect.poll(async () => (await seen())[2]).not.toBe(start[2]);
});

test('old_prefix_keys_still_work: prefix then c n p b x s 1-9 run their commands and ? lists them', async ({ app, core }) => {
  const p = core.project('demo');
  const ids = ['one', 'two', 'three'].map((l) => core.shell(p, l).id);
  await openWindow(app);
  const prefix = async (k: string) => (await app.keyboard.press('Control+Period'), await app.keyboard.press(k));
  await prefix('KeyN');
  expect(await activeTab(app)).toBe(ids[1]);
  await prefix('KeyP');
  expect(await activeTab(app)).toBe(ids[0]);
  await prefix('Digit3');
  expect(await activeTab(app)).toBe(ids[2]);
  await prefix('KeyC');
  await expect(app.getByRole('dialog', { name: 'New tab' })).toBeVisible();
  await app.keyboard.press('Escape');
  for (const [k, id] of [['KeyB', 'sidebar.left.toggle'], ['KeyX', 'files.show'], ['KeyS', 'search.open']] as const) {
    const before = await app.evaluate(() => document.body.innerHTML.length);
    await prefix(k);
    await expect.poll(() => app.evaluate(() => document.body.innerHTML.length), id).not.toBe(before);
    await prefix(k);
  }
  await app.keyboard.press('Control+Period');
  await app.keyboard.press('Shift+Slash');
  const help = app.locator('.prefix-help');
  await expect(help).toBeVisible();
  for (const key of ['c', 'n', 'p', 'b', 'x', 's']) await expect(help.locator('.kbd', { hasText: new RegExp(`^${key}$`) }).first()).toBeVisible();
});

test('ctrl_o_rebinds_and_terminal_keeps_it: Ctrl+O cycles the chat view; rebound, only the new key does; inside a terminal it is the agent’s', async ({ app, core }) => {
  const p = core.project('demo');
  // A raw-mode cat shows each byte it receives: ^O is 0x0f.
  const id = core.shell(p, 'raw', '/bin/sh', '-c', 'stty raw -echo; exec cat -v').id;
  await openWindow(app);
  const view = () => app.evaluate(() => localStorage.getItem('nunchiro.chatView.v2'));
  await app.locator(`.tab[data-tab="${id}"]`).click();
  // On the page: the key is taken and the view cycles.
  expect(await press(app, { code: 'KeyO', ctrlKey: true })).toBe(true);
  await expect.poll(view).toBe('thinking');
  // Inside a terminal: not taken, and the agent receives 0x0f.
  await app.locator(`.term[data-session="${id}"] .xterm-helper-textarea`).focus();
  expect(await press(app, { code: 'KeyO', ctrlKey: true }, `.term[data-session="${id}"] .xterm-helper-textarea`)).toBe(false);
  expect(await view()).toBe('thinking');
  await app.keyboard.press('Control+KeyO');
  await expect.poll(() => core.read(id)).toContain('^O');
  expect(await view()).toBe('thinking');
  // Rebound to Alt+O: the new key cycles, the old one does not.
  await app.evaluate(() => localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ bindings: { 'chat.cycleView': ['Alt+KeyO'] } })));
  await app.reload();
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  expect(await press(app, { code: 'KeyO', ctrlKey: true })).toBe(false);
  expect(await view()).toBe('thinking');
  expect(await press(app, { code: 'KeyO', altKey: true })).toBe(true);
  await expect.poll(view).toBe('verbose');
});

test('new_default_never_takes_a_users_key: an override that gives ⌘T to another command leaves New session the prefix c only', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  expect(merge({ 'focus.tree': ['Meta+KeyT'] })['session.new']).toEqual(['prefix KeyC']);
  await rebind(app, { 'focus.tree': ['Meta+KeyT'] });
  await openWindow(app);
  await app.keyboard.press('Meta+Comma');
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Keyboard' }).click();
  await expect(app.locator('tr[data-command="session.new"] td').nth(1)).toHaveText(/^◆\s*c$/); // the prefix shows as ◆ since 50239d412
  await expect(app.locator('tr[data-command="focus.tree"] td').nth(1)).toHaveText('⌘T');
  await expect(app.locator('tr[data-command="session.new"] [role="alert"]')).toHaveCount(0);
  await app.getByRole('button', { name: 'Conflicts' }).click();
  await expect(app.locator('[data-keys-list] tr[data-command]')).toHaveCount(0);
  await expect(app.getByText('No actions match')).toBeVisible();
});

test('tooltips_follow_first_binding: Files (⇧⌘E), Search (⇧⌘F), New session shows ⌘T; an unbound command shows its name alone', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await rebind(app, { 'search.open': [] });
  await openWindow(app);
  const tip = app.getByRole('tooltip');
  await app.locator('.ai[data-hint-icon="files.show"]').hover();
  await expect(tip).toHaveText('Files (⇧⌘E)');
  await app.locator('.ai[data-hint-icon="search.open"]').hover();
  await expect(tip).toHaveText('Search');
  await app.locator('.tab[data-tab]').first().click({ button: 'right' });
  await expect(app.getByRole('menu', { name: 'Actions' }).getByRole('menuitem', { name: /New session…/ }).locator('.kbd')).toHaveText('⌘T');
});

test('path_reveal_refuses_a_relative_path: Reveal in Finder takes an absolute path only', async ({ app, core }) => {
  await fakeApp(app);
  await openWindow(app, {}, core);
  const row = (id: string, arg: string) =>
    app.evaluate(
      ({ id, arg }) => {
        const el = document.createElement('div');
        el.id = id;
        el.tabIndex = 0;
        el.textContent = id;
        el.dataset.menu = 'path';
        el.dataset.menuArg = arg;
        // Clear of the left sidebar's resize handle, which reaches 8 px past its edge (about x 298-306 here).
        el.style.cssText = 'position:fixed;left:600px;top:300px;padding:6px;background:#333;color:#fff;z-index:1';
        document.body.append(el);
      },
      { id, arg },
    );
  const reveal = () => app.getByRole('menu', { name: 'Actions' }).getByRole('menuitem').nth(1);
  await row('rel', 'src/app.ts');
  await app.locator('#rel').click({ button: 'right' });
  await expect(reveal()).toHaveAttribute('aria-disabled', 'true');
  await reveal().click({ force: true });
  expect((await invoked(app)).filter((c) => c.includes('reveal'))).toEqual([]);
  await app.keyboard.press('Escape');
  await row('abs', '/work/demo/src/app.ts');
  await app.locator('#abs').click({ button: 'right' });
  await expect(reveal()).not.toHaveAttribute('aria-disabled', 'true');
  await reveal().click();
  await expect.poll(async () => (await invoked(app)).filter((c) => c.includes('reveal'))).toEqual(['plugin:opener|reveal_item_in_dir']);
});
