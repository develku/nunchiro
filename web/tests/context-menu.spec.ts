// Ticket V2-6a: one context menu on tree rows, tabs, AGENTS rows, Files and Search rows, board cards and chat
// messages. Every item is a palette command with its binding shown. Playwright drives Chromium and WebKit, not
// WKWebView. axe-core checks the open menu only; a violation elsewhere on the page is not this ticket's.
import fs from 'node:fs';
import path from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { MENU_ONLY, SURFACES } from '../src/menu/surfaces';
import { expect, openWindow, test, stripOnTop, showComposer, grantClipboard, openSessionFromPalette } from './fixtures';
import { openQuiet } from './tree-seed';
import { patchSnapshots } from './visual/compare';
import { append, chat, expect as chatExpect, openChat, rec, test as chatTest } from './fixtures/chat/harness';
import { setup as filesSetup, row as fileRow } from './fixtures/files/harness';
import { hit, search, setup as searchSetup } from './fixtures/search/harness';

test.beforeEach(({ core }) => stripOnTop(core));

const menu = (p: Page) => p.getByRole('menu', { name: 'Actions' });
const items = (p: Page) => menu(p).getByRole('menuitem');
const names = (p: Page) => items(p).evaluateAll((els) => els.map((e) => e.querySelector('.mt')?.textContent));
const activeInside = (p: Page, sel: string) => p.evaluate((s) => !!document.activeElement?.closest(s), sel);

test('context_menu_items_map_to_palette_ids', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  core.shell(core.project('demo'), 'beta'); // needs 171: "Close other tabs" is in the palette only with a second tab
  await openWindow(app);
  await app.keyboard.press('Meta+KeyK');
  const ids = await app.locator('.palette [data-command]').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.command));
  for (const [surface, list] of Object.entries(SURFACES)) {
    expect(list.length, surface).toBeGreaterThan(0);
    for (const id of list) if (!MENU_ONLY.has(id)) expect(ids, `${surface}: ${id}`).toContain(id); // ticket 991 A10: those act on the row only
  }
});

test('context_menu_height_contains_every_item', async ({ app, core }) => {
  const s = core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await app.locator(`button.row.wt2[data-menu-session="${s.id}"]`).click({ button: 'right' });
  await expect(menu(app)).toBeVisible();
  const bounds = (await menu(app).boundingBox())!;
  const rows = await items(app).evaluateAll((els) => els.map((el) => {
    const r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom };
  }));
  expect(rows.length).toBeGreaterThan(1);
  for (const row of rows) {
    expect(row.top).toBeGreaterThanOrEqual(bounds.y);
    expect(row.bottom).toBeLessThanOrEqual(bounds.y + bounds.height);
  }
});

test('context_menu_keyboard_only', async ({ app, core }) => {
  const s = core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  const rowEl = app.locator(`button.row.wt2[data-menu-session="${s.id}"]`);
  await rowEl.focus();
  await app.keyboard.press('Shift+F10');
  await expect(menu(app)).toBeVisible();
  // Look 1117 v5 (A): an idle shell has no turn to stop; it is ended by Close session.
  expect(await names(app)).toEqual(['New session…', 'Restart session', 'Close session', 'Move to done', 'Rename session', 'Copy path', 'Open session in editor', 'Focus the terminal', 'Open Diff (changes since the session started)', 'Tidy worktrees…']);
  // The first item is current; arrows move; the menu key opens it the same way (below).
  await expect(menu(app)).toHaveAttribute('aria-activedescendant', /.+/);
  await app.keyboard.press('ArrowDown');
  await app.keyboard.press('ArrowDown');
  await expect(items(app).nth(2)).toHaveAttribute('data-current', '');
  // Esc closes and focus is back on the row.
  await app.keyboard.press('Escape');
  await expect(menu(app)).toHaveCount(0);
  await expect(rowEl).toBeFocused();
  // The menu key opens it too; Enter runs the item (rename opens the row's name field).
  await app.keyboard.press('ContextMenu');
  await expect(menu(app)).toBeVisible();
  for (let i = 0; i < 4; i++) await app.keyboard.press('ArrowDown');
  await app.keyboard.press('Enter');
  await expect(menu(app)).toHaveCount(0);
  await expect(app.getByRole('textbox', { name: 'Session name' })).toBeVisible();
});

test('context_menu_runs_on_the_row_it_opened_from', async ({ app, core }) => {
  const p = core.project('demo');
  core.shell(p, 'alpha');
  const b = core.shell(p, 'beta');
  await openWindow(app);
  // beta is not the active tab: the item acts on beta, not on the active session.
  await app.locator(`button.row.wt2[data-menu-session="${b.id}"]`).click({ button: 'right' });
  await items(app).filter({ hasText: 'Rename session' }).click();
  await expect(app.getByRole('textbox', { name: 'Session name' })).toBeVisible();
});

test('context_menu_shows_bindings', async ({ app, core }) => {
  const s = core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await app.locator(`button.row.wt2[data-menu-session="${s.id}"]`).click({ button: 'right' });
  const item = (t: string) => items(app).filter({ hasText: t });
  await expect(item('New session…').locator('.kbd')).toHaveText('⌘T');
  await expect(item('Focus the terminal').locator('.kbd')).toHaveText('◆ o');
  // No binding, no key chip.
  await expect(item('Stop this session').locator('.kbd')).toHaveCount(0);
});

for (const into of ['terminal', 'composer'] as const) {
  test(`context_menu_no_focus_steal: ${into}`, async ({ app, core }) => {
    const p = core.project('demo');
    const a = core.shell(p, 'alpha');
    const b = core.shell(p, 'beta');
    await openWindow(app);
    await app.locator(`.tab[data-tab="${a.id}"]`).click();
    if (into === 'composer') await showComposer(app); // V2.5-34: a shell's composer is asked for
    const where = into === 'terminal' ? `.term[data-session="${a.id}"]` : '.cbox';
    await app.locator(into === 'terminal' ? `.term[data-session="${a.id}"] .xterm-helper-textarea` : '.cbox textarea').focus();
    expect(await activeInside(app, where)).toBe(true);
    await app.locator(`.tab[data-tab="${b.id}"]`).click({ button: 'right' });
    await expect(menu(app)).toBeVisible();
    expect(await activeInside(app, where)).toBe(true);
    await app.keyboard.press('Escape');
    await expect(menu(app)).toHaveCount(0);
    expect(await activeInside(app, where)).toBe(true);
  });
}

test('terminal_and_text_field_right_click_unchanged', async ({ app, core }) => {
  const s = core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await showComposer(app); // V2.5-34: a shell's composer is asked for
  // The event itself stays unhandled (defaultPrevented false), so the platform and xterm menus and copy/paste keep working.
  const plain = (sel: string) =>
    app.locator(sel).first().evaluate((el) => {
      const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 });
      el.dispatchEvent(ev);
      return ev.defaultPrevented;
    });
  expect(await plain(`.term[data-session="${s.id}"] .xterm-screen`)).toBe(false);
  expect(await plain('.cbox textarea')).toBe(false);
  await app.locator('.cbox textarea').click({ button: 'right' });
  await expect(menu(app)).toHaveCount(0);
  // Sanity: the same probe on a menu row is handled.
  expect(await plain(`button.row.wt2[data-menu-session="${s.id}"]`)).toBe(true);
  // Ticket 991 A6: empty space (the tree below its rows, the page itself) never gets the web view's Reload / AutoFill menu.
  expect(await plain('.tree')).toBe(true);
  expect(await plain('body')).toBe(true);
  await expect(menu(app)).toHaveCount(0);
});

test('context_menu_every_surface: project head, tab, session row', async ({ app, core }) => {
  const s = core.shell(core.project('demo'), 'alpha');
  openQuiet(core); // V2-9a: quiet projects start folded
  await openWindow(app);
  // Ticket 1032: the tree's first head is the Assistants group's (no menu), so the project's head is named.
  for (const sel of ['.tree .grp[data-project] .row.head .n', `.tab[data-tab="${s.id}"]`, `button.row.wt2[data-menu-session="${s.id}"]`]) {
    await app.locator(sel).first().click({ button: 'right' });
    await expect(menu(app), sel).toBeVisible();
    expect((await names(app)).length, sel).toBeGreaterThan(0);
    await app.keyboard.press('Escape');
    await expect(menu(app)).toHaveCount(0);
  }
  // The tab's menu also moves it.
  await app.locator(`.tab[data-tab="${s.id}"]`).click({ button: 'right' });
  expect(await names(app)).toContain('Move the tab left');
});

test('context_menu_every_surface: Files row', async ({ app, core }) => {
  await filesSetup(app, core);
  await fileRow(app, 'hello.ts').click({ button: 'right' });
  await expect(menu(app)).toBeVisible();
  expect((await names(app)).length).toBeGreaterThan(0);
});

test('context_menu_every_surface: Search row', async ({ app, core }) => {
  await searchSetup(app, core);
  await search(app, 'needle');
  await hit(app, 'src/app.ts', 2).click({ button: 'right' });
  await expect(menu(app)).toBeVisible();
  expect((await names(app)).length).toBeGreaterThan(0);
});

test('context_menu_every_surface: board card', async ({ app, core }) => {
  fs.copyFileSync(path.join(import.meta.dirname, 'fixtures/board/layout.toml'), path.join(core.home, 'layout.toml'));
  core.shell(core.project('demo'), 'busy');
  await openWindow(app);
  await app.locator('.board .bcard').first().click({ button: 'right' });
  await expect(menu(app)).toBeVisible();
  expect((await names(app)).length).toBeGreaterThan(0);
});

chatTest('context_menu_every_surface: chat message', async ({ page, chatCore }) => {
  const s = chatCore.chat();
  await openChat(page, s.id);
  append(s.file, rec.user('안녕'), rec.assistant('네, 확인했습니다.'));
  const msg = chat(page, s.id).locator('[data-menu="chat"]').first();
  await chatExpect(msg).toBeVisible();
  await msg.click({ button: 'right' });
  await chatExpect(menu(page)).toBeVisible();
  chatExpect((await names(page)).length).toBeGreaterThan(0);
});

test('context_menu_enabled_follows_the_row_not_the_active_tab', async ({ app, core }) => {
  const s = core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await app.locator(`.tab[data-tab="${s.id}"]`).hover(); // the tab's close button shows on hover
  await app.locator(`.tab[data-tab="${s.id}"] ~ .x`).click(); // v25f: Settings is a modal, not a tab; with the only tab closed no session is current
  await expect(app.locator('.tab[data-tab]')).toHaveCount(0);
  await app.locator(`button.row.wt2[data-menu-session="${s.id}"]`).click({ button: 'right' });
  const rename = items(app).filter({ hasText: 'Rename session' });
  await expect(rename).not.toHaveAttribute('aria-disabled', 'true');
  await rename.click();
  await expect(app.getByRole('textbox', { name: 'Session name' })).toBeVisible();
});

// V2-6a follow-up: an item disabled for the row's session runs nothing and does not activate that session. Since look 1117
// (744eaefbf) an ended row offers no Stop at all, so the disabled item here is Restart on a live session's tab.
test('stopped_row_item_is_disabled_without_activating', async ({ app, core }) => {
  const p = core.project('demo');
  const live = core.shell(p, 'alpha');
  const gone = core.shell(p, 'gone', '/bin/sh', '-c', 'exit 0');
  await openWindow(app);
  await expect.poll(() => (core.cli('snapshot', '--json').sessions as { id: string; state: string }[]).find((s) => s.id === gone.id)?.state).not.toBe('running');
  await openSessionFromPalette(app, gone.id); // the stopped session is the active one
  const selected = app.locator('.tab[aria-selected="true"]');
  await expect(selected).toHaveAttribute('data-tab', gone.id);
  await app.locator(`.tab[data-tab="${gone.id}"]`).click({ button: 'right' });
  await expect(items(app).filter({ hasText: 'Stop this session' })).toHaveCount(0);
  await app.keyboard.press('Escape');
  await app.locator(`.tab[data-tab="${live.id}"]`).click({ button: 'right' });
  const restart = items(app).filter({ hasText: 'Restart session' });
  await expect(restart).toHaveAttribute('aria-disabled', 'true'); // a running session has nothing to restart
  await restart.click({ force: true }); // a disabled item still takes a click; Playwright would wait for it otherwise
  await expect(menu(app)).toHaveCount(0);
  await expect(selected).toHaveAttribute('data-tab', gone.id);
  // By keyboard, the same.
  await app.mouse.move(0, 0); // a pointer left over an item would make it current when the menu opens under it
  await app.locator(`.tab[data-tab="${live.id}"]`).focus();
  await app.keyboard.press('Shift+F10');
  await expect(menu(app)).toBeFocused(); // a key sent before the menu takes focus goes to the row
  while ((await restart.getAttribute('data-current')) === null) await app.keyboard.press('ArrowDown');
  await app.keyboard.press('Enter');
  await expect(menu(app)).toHaveCount(0);
  await expect(selected).toHaveAttribute('data-tab', gone.id);
  expect((core.cli('snapshot', '--json').sessions as { id: string; state: string }[]).find((s) => s.id === live.id)?.state).toBe('running');
});

chatTest('chat_row_context_menu_by_keyboard', async ({ page, chatCore }) => {
  const s = chatCore.chat();
  await openChat(page, s.id);
  append(s.file, rec.user('안녕'), rec.assistant('네, 확인했습니다.'));
  const msg = chat(page, s.id).locator('[data-menu="chat"]').first();
  await chatExpect(msg).toBeVisible();
  for (const key of ['Shift+F10', 'ContextMenu']) {
    await msg.click();
    await chatExpect(msg).toBeFocused();
    await page.keyboard.press(key);
    await chatExpect(menu(page), key).toBeVisible();
    const box = await menu(page).boundingBox();
    const row = await msg.boundingBox();
    chatExpect(Math.abs(box!.y - (row!.y + row!.height)), key).toBeLessThan(40); // opened at the row, not the pointer
    await page.keyboard.press('ArrowDown');
    await chatExpect(items(page).nth(1), key).toHaveAttribute('data-current', '');
    await page.keyboard.press('Escape');
    await chatExpect(menu(page), key).toHaveCount(0);
    await chatExpect(msg, key).toBeFocused();
  }
});

test('context_menu_keeps_the_focus_ring_of_its_rows', async ({ app, core }) => {
  const s = core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await app.locator(`button.row.wt2[data-menu-session="${s.id}"]`).focus();
  await app.keyboard.press('Shift+F10'); // a keyboard-driven focus comes back to the row on Esc: :focus-visible applies
  await app.keyboard.press('Escape');
  await expect(app.locator(`button.row.wt2[data-menu-session="${s.id}"]`)).toBeFocused();
  const ring = await app.locator(`button.row.wt2[data-menu-session="${s.id}"]`).evaluate((e) => getComputedStyle(e).outlineStyle !== 'none' || getComputedStyle(e).boxShadow !== 'none');
  expect(ring).toBe(true);
});

/** Serious or critical axe violations inside the open menu. */
const axeBad = async (p: Page) => {
  const r = await new AxeBuilder({ page: p }).include('[role="menu"]').analyze();
  return r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}: ${v.help}`);
};

test('context_menu_axe_clean: tree row, tab', async ({ app, core }) => {
  const s = core.shell(core.project('demo'), 'alpha');
  openQuiet(core); // V2-9a: quiet projects start folded
  await openWindow(app);
  for (const sel of ['.tree .grp[data-project] .row.head .n', `.tab[data-tab="${s.id}"]`]) {
    await app.locator(sel).first().click({ button: 'right' });
    await expect(menu(app), sel).toBeVisible();
    expect(await axeBad(app), sel).toEqual([]);
    await app.keyboard.press('Escape');
  }
  // Keyboard-opened (focus inside the menu, aria-activedescendant set).
  await app.locator(`button.row.wt2[data-menu-session="${s.id}"]`).focus();
  await app.keyboard.press('Shift+F10');
  await expect(menu(app)).toBeVisible(); // axe on a not-yet-mounted menu reports a clean empty result
  expect(await axeBad(app)).toEqual([]);
});

test('context_menu_axe_clean: Files row', async ({ app, core }) => {
  await filesSetup(app, core);
  await fileRow(app, 'hello.ts').click({ button: 'right' });
  await expect(menu(app)).toBeVisible();
  expect(await axeBad(app)).toEqual([]);
});

test('context_menu_axe_clean: Search row', async ({ app, core }) => {
  await searchSetup(app, core);
  await search(app, 'needle');
  await hit(app, 'src/app.ts', 2).click({ button: 'right' });
  await expect(menu(app)).toBeVisible();
  expect(await axeBad(app)).toEqual([]);
});

test('context_menu_axe_clean: board card', async ({ app, core }) => {
  fs.copyFileSync(path.join(import.meta.dirname, 'fixtures/board/layout.toml'), path.join(core.home, 'layout.toml'));
  core.shell(core.project('demo'), 'busy');
  await openWindow(app);
  await app.locator('.board .bcard').first().click({ button: 'right' });
  await expect(menu(app)).toBeVisible();
  expect(await axeBad(app)).toEqual([]);
});

chatTest('context_menu_axe_clean: chat message', async ({ page, chatCore }) => {
  const s = chatCore.chat();
  await openChat(page, s.id);
  append(s.file, rec.user('안녕'), rec.assistant('네, 확인했습니다.'));
  const msg = chat(page, s.id).locator('[data-menu="chat"]').first();
  await chatExpect(msg).toBeVisible();
  await msg.click({ button: 'right' });
  await chatExpect(menu(page)).toBeVisible();
  chatExpect(await axeBad(page)).toEqual([]);
});

// system4 (needs 171, 172): the menu hands data-menu-arg to every command, enables an item per target, draws danger on any surface.
// The probe surface, commands and danger id go into the live tables through the suite-only seam in ContextMenu.tsx.
type Probe = { SURFACES: Record<string, string[]>; DANGER: Set<string>; commands: { id: string; title: string; enabled?: boolean; enabledFor?: (t: { session?: string; arg?: string }) => boolean; run: (a?: string) => void }[] };
type Calls = { calls: unknown[]; open: boolean };
type W = { __menuProbe: Probe } & Partial<Calls>;

/** A probe surface `probe` with these commands: each records [id, arg] in window.calls; `gate` is the flag enabledFor reads. */
const addProbe = (p: Page, ids: string[], opts: { danger?: string[]; guarded?: string[] } = {}) =>
  p.evaluate(
    ({ ids, opts }) => {
      const w = window as unknown as W;
      w.calls = [];
      w.open = true;
      w.__menuProbe.SURFACES.probe = ids;
      for (const d of opts.danger ?? []) w.__menuProbe.DANGER.add(d);
      for (const id of ids)
        w.__menuProbe.commands.push({
          id,
          title: `Probe ${id}`,
          run: (a) => w.calls!.push([id, a]),
          ...((opts.guarded ?? []).includes(id) ? { enabledFor: (t: { arg?: string }) => w.open! && t.arg !== 'no' } : {}),
        });
    },
    { ids, opts },
  );
const calls = (p: Page) => p.evaluate(() => (window as unknown as W).calls);
/** A focusable row of surface `menu` (no session unless given), parked top-left. */
const addRow = (p: Page, id: string, attrs: Record<string, string>) =>
  p.evaluate(
    ({ id, attrs }) => {
      const el = document.createElement('div');
      el.id = id;
      el.tabIndex = 0;
      el.textContent = id;
      el.style.cssText = `position:fixed;left:${200 + document.querySelectorAll('[data-probe-row]').length * 160}px;top:300px;padding:6px;background:#333;color:#fff;z-index:1`;
      el.dataset.probeRow = '';
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
      document.body.append(el);
    },
    { id, attrs },
  );
const HOSTILE = ['javascript:alert(1)', '../../etc/passwd', '<img src=x onerror=alert(1)>'];

test('menu_arg_reaches_every_command', async ({ app }) => {
  await openWindow(app);
  const url0 = app.url();
  await addProbe(app, ['probe.a']);
  const dialogs: string[] = [];
  app.on('dialog', (d) => (dialogs.push(d.message()), void d.dismiss()));
  for (const [i, arg] of HOSTILE.entries()) {
    await addRow(app, `r${i}`, { 'data-menu': 'probe', 'data-menu-arg': arg });
    // click
    await app.locator(`#r${i}`).click({ button: 'right' });
    await items(app).first().click();
    // Enter on the first item of a pointer-opened menu
    await app.locator(`#r${i}`).click({ button: 'right' });
    await app.keyboard.press('Enter');
    // the menu key, then Enter
    await app.locator(`#r${i}`).focus();
    await app.keyboard.press('ContextMenu');
    await expect(menu(app)).toBeFocused();
    await app.keyboard.press('Enter');
    await expect(menu(app)).toHaveCount(0);
    expect((await calls(app))!.slice(-3), arg).toEqual([['probe.a', arg], ['probe.a', arg], ['probe.a', arg]]);
  }
  expect(dialogs).toEqual([]);
  expect(app.url()).toBe(url0); // nothing navigated to the arg
});

test('menu_enabled_for_follows_the_target', async ({ app }) => {
  await openWindow(app);
  await addProbe(app, ['probe.guarded'], { guarded: ['probe.guarded'] });
  await addRow(app, 'yes', { 'data-menu': 'probe', 'data-menu-arg': 'yes' });
  await addRow(app, 'no', { 'data-menu': 'probe', 'data-menu-arg': 'no' });
  await app.locator('#yes').click({ button: 'right' });
  await expect(items(app)).not.toHaveAttribute('aria-disabled', 'true');
  await items(app).click();
  await expect(menu(app)).toHaveCount(0);
  expect(await calls(app)).toEqual([['probe.guarded', 'yes']]);
  // the same surface, another target: listed, aria-disabled, runs nothing, closes the menu
  await app.locator('#no').click({ button: 'right' });
  await expect(items(app)).toHaveAttribute('aria-disabled', 'true');
  await items(app).click({ force: true });
  await expect(menu(app)).toHaveCount(0);
  await app.locator('#no').focus();
  await app.keyboard.press('ContextMenu');
  await app.keyboard.press('Enter');
  await expect(menu(app)).toHaveCount(0);
  expect(await calls(app)).toEqual([['probe.guarded', 'yes']]);
});

// The row's menu asks the row's own session, not the active one, whether Stop applies.
test('menu_stop_follows_the_row_target', async ({ app, core }) => {
  const p = core.project('demo');
  const live = core.shell(p, 'alpha');
  const gone = core.shell(p, 'gone', '/bin/sh', '-c', 'exit 0');
  await patchSnapshots(app, { alpha: { working: true } }); // a working turn is what Stop stops (an idle shell has none)
  await openWindow(app);
  await expect.poll(() => (core.cli('snapshot', '--json').sessions as { id: string; state: string }[]).find((s) => s.id === gone.id)?.state).not.toBe('running');
  const stop = items(app).filter({ hasText: 'Stop this session' });
  await openSessionFromPalette(app, gone.id); // the stopped session is the active one, the live row must still be stoppable
  await app.locator(`button.row.wt2[data-menu-session="${live.id}"]`).click({ button: 'right' });
  await expect(stop).not.toHaveAttribute('aria-disabled', 'true');
  await app.keyboard.press('Escape');
  await app.locator(`.tab[data-tab="${live.id}"]`).click();
  await app.locator(`.tab[data-tab="${gone.id}"]`).click({ button: 'right' });
  await expect(menu(app)).toBeVisible();
  await expect(stop).toHaveCount(0); // the active session can stop, the ended session's menu still offers no Stop
});

test('menu_danger_on_any_surface', async ({ app }) => {
  await openWindow(app);
  await addProbe(app, ['probe.safe', 'probe.danger'], { danger: ['probe.danger'] });
  await addRow(app, 'p', { 'data-menu': 'probe' });
  await app.locator('#p').click({ button: 'right' });
  const danger = await items(app).evaluateAll((els) => els.map((e) => [e.getAttribute('data-command'), e.hasAttribute('data-danger')]));
  expect(danger).toEqual([['probe.safe', false], ['probe.danger', true]]);
  await app.keyboard.press('Escape');
  // the worktree surface keeps its red Remove and nothing else red
  await addRow(app, 'w', { 'data-menu': 'worktree' });
  await app.locator('#w').click({ button: 'right' });
  const wt = await items(app).evaluateAll((els) => els.filter((e) => e.hasAttribute('data-danger')).map((e) => e.getAttribute('data-command')));
  expect(wt).toEqual(['worktree.remove']);
});

test('menu_stale_command_does_nothing', async ({ app }) => {
  await openWindow(app);
  await addProbe(app, ['probe.guarded', 'probe.plain'], { guarded: ['probe.guarded'] });
  await addRow(app, 'p', { 'data-menu': 'probe', 'data-menu-arg': 'x' });
  // removed from the registry between open and click
  await app.locator('#p').click({ button: 'right' });
  await expect(items(app)).toHaveCount(2);
  await app.evaluate(() => ((window as unknown as W).__menuProbe.commands.length = 0));
  await items(app).first().click();
  await expect(menu(app)).toHaveCount(0);
  // disabled between open and click (the fresh test, not the look)
  await addProbe(app, ['probe.guarded'], { guarded: ['probe.guarded'] });
  await app.locator('#p').click({ button: 'right' });
  await app.evaluate(() => ((window as unknown as W).open = false));
  await items(app).first().click();
  await expect(menu(app)).toHaveCount(0);
  expect(await calls(app)).toEqual([]);
});

const clip = (p: Page) => p.evaluate(() => navigator.clipboard.readText());
/** The palette leaves these commands out: they need an argument only a menu row carries (ticket 991 A10). */
const paletteInert = async (p: Page, ids: string[]) => {
  await p.keyboard.press('Meta+KeyK');
  await expect(p.locator('.palette [data-command]').first()).toBeVisible();
  for (const id of ids) await expect(p.locator(`.palette [data-command="${id}"]`)).toHaveCount(0);
  await p.keyboard.press('Escape');
};
const PATH = '/work/demo/src/../app.ts';

test('path_surface_items: plain browser', async ({ app }) => {
  await grantClipboard(app);
  await openWindow(app);
  await addRow(app, 'f', { 'data-menu': 'path', 'data-menu-arg': PATH });
  await app.locator('#f').click({ button: 'right' });
  expect(await names(app)).toEqual(['Copy path', 'Reveal in Finder']);
  await expect(items(app).nth(0)).not.toHaveAttribute('aria-disabled', 'true');
  await expect(items(app).nth(1)).toHaveAttribute('aria-disabled', 'true'); // Reveal needs the app
  await items(app).nth(1).click({ force: true });
  await expect(menu(app)).toHaveCount(0);
  await app.locator('#f').click({ button: 'right' });
  await items(app).nth(0).click();
  await expect(menu(app)).toHaveCount(0);
  expect(await clip(app)).toBe(PATH);
  // no argument: both are inert on the row
  await addRow(app, 'g', { 'data-menu': 'path' });
  await app.locator('#g').click({ button: 'right' });
  await expect(items(app)).toHaveCount(2);
  for (const i of [0, 1]) await expect(items(app).nth(i)).toHaveAttribute('aria-disabled', 'true');
  await app.keyboard.press('Escape');
  await paletteInert(app, ['path.copy', 'path.reveal']);
});

test('path_surface_items: in the app, Reveal calls the opener with the arg', async ({ app, core }) => {
  await app.addInitScript(() => {
    const w = window as unknown as { __invoked: [string, unknown][]; __TAURI_INTERNALS__: unknown };
    w.__invoked = [];
    w.__TAURI_INTERNALS__ = { invoke: (cmd: string, args: unknown) => (w.__invoked.push([cmd, args]), Promise.resolve(null)) };
  });
  await openWindow(app, {}, core);
  await addRow(app, 'f', { 'data-menu': 'path', 'data-menu-arg': PATH });
  await app.locator('#f').click({ button: 'right' });
  await expect(items(app).nth(1)).not.toHaveAttribute('aria-disabled', 'true');
  await items(app).nth(1).click();
  await expect.poll(() => app.evaluate(() => (window as unknown as { __invoked: [string, { paths?: string[] }][] }).__invoked.filter(([c]) => c === 'plugin:opener|reveal_item_in_dir').map(([, a]) => a.paths))).toEqual([[PATH]]);
});

test('message_surface_copy', async ({ app }) => {
  await grantClipboard(app);
  await openWindow(app);
  const text = 'line one\nline <b>two</b> javascript:alert(1)';
  await addRow(app, 'm', { 'data-menu': 'message', 'data-menu-arg': text });
  await app.locator('#m').click({ button: 'right' });
  expect(await names(app)).toEqual(['Copy']);
  await items(app).click();
  expect(await clip(app)).toBe(text);
  await addRow(app, 'e', { 'data-menu': 'message' });
  await app.locator('#e').click({ button: 'right' });
  await expect(items(app)).toHaveAttribute('aria-disabled', 'true');
  await app.keyboard.press('Escape');
  await paletteInert(app, ['message.copy']);
});
