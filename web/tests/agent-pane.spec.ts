// AGENTVIEW: an agent session tab is the chat plus a right side pane (PTY, shells, Browser, Preview) that the Right bar's
// Terminal icon toggles. Real core, fake agents; one named test per acceptance item of the brief.
import AxeBuilder from '@axe-core/playwright';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { ENTRIES } from '../src/layout/registry';
import { DEFAULT_BINDINGS, conflicts } from '../src/keys';
import { expect, openWindow, REPO, terminalText, test, type Core } from './fixtures';
import { append, chat, openChat, rec, test as chatTest } from './fixtures/chat/harness';
import { bview, injectPending, item, maximisePane, newShell, pview, showPreview } from './agent-pane';
import { icon, lib, names, pageErrors, startEdit, stored } from './d5b';

const SEEN = 'window.__sent';
/** Every request this window sends over the core socket, in order. */
const record = (page: Page) =>
  page.addInitScript(() => {
    const w = window as unknown as { __sent: { op: string; [k: string]: unknown }[] };
    w.__sent = [];
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      try {
        const r = typeof data === 'string' ? JSON.parse(data).request : null;
        if (r) w.__sent.push(r);
      } catch {
        // Not JSON: not ours.
      }
      return send.call(this, data);
    };
  });
type Req = { op: string; id?: string; text?: string; keys?: unknown; session?: { kind: string; project: string } };
const sent = (page: Page, op: string) => page.evaluate(([o, k]) => (eval(k) as Req[]).filter((r) => r.op === o), [op, SEEN] as const);

const SIDE = '[data-side-pane]';
const pane = (page: Page) => page.locator(`${SIDE}:not([hidden])`);
const termIcon = (page: Page) => icon(page, 'right', 'Terminal');
const tab = (page: Page, name: string | RegExp) => pane(page).getByRole('tab', { name });
/** A worktree agent needs its project to be a repository of its own: without one, git found the checkout around .scratch
 *  (a run under GIT_CEILING_DIRECTORIES then failed with "not a git repository"). */
const agent = (core: Core, label: string, worktree = false) => {
  const dir = core.project(worktree ? label : 'agents'); // ticket 570: the sessions of a test share a project, so their tabs share a strip
  if (worktree) {
    const git = (...a: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { encoding: 'utf8' });
    git('init', '-q', '-b', 'main');
    git('commit', '-q', '--allow-empty', '-m', 'init');
  }
  return core.agent(dir, label, 'never-created', worktree);
};
const open = async (page: Page, id: string) => {
  await page.locator(`.tab[data-tab="${id}"]`).click();
  await expect(page.locator(`.chat[data-session="${id}"]`)).toBeVisible();
};

test('no_chat_terminal_toggle', async ({ app, core }) => {
  const errors = pageErrors(app);
  agent(core, 'a');
  // Garbage and old values of the removed store load without an error.
  for (const raw of ['{"x":"zzz","y":"terminal"}', '[1,2', 'null', '"terminal"']) {
    await app.addInitScript((r) => sessionStorage.getItem('seeded') || (localStorage.setItem('nunchiro.chatView.v1', r), sessionStorage.setItem('seeded', '1')), raw);
    await openWindow(app, {}, core);
    await app.evaluate(() => sessionStorage.clear());
    await app.reload();
  }
  await openWindow(app, {}, core);
  await expect(app.getByRole('button', { name: /chat view|terminal view|Chat \| Terminal|채팅 \| 터미널/i })).toHaveCount(0);
  await expect(app.getByText(/채팅 \| 터미널|Chat \| Terminal/)).toHaveCount(0);
  await app.keyboard.press('Meta+KeyK');
  const palette = app.getByRole('dialog', { name: 'Command palette' });
  await palette.getByRole('combobox').fill('view');
  await expect(palette.locator('[data-command^="view."]')).toHaveCount(0);
  // The removed titles were "Show the chat view", "Show the terminal view" and "Switch between chat and terminal" (dbdc7c79);
  // "Cycle the chat view" is the later Normal/Thinking/Verbose transcript view (chat/view.ts, needs 166), not a toggle.
  await expect(palette.getByText(/(?<!Cycle the )chat view|terminal view|Switch between chat and terminal/i)).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('header_has_no_icons', async ({ app, core }) => {
  const a = agent(core, 'a');
  await openWindow(app, {}, core);
  await open(app, a.id);
  const head = app.locator('.shead');
  await expect(head).toContainText('a');
  // Ticket 60's NODUP rule took the chat/terminal view toggles out of the header (the palette has them), not every
  // control. The header's buttons are: notify (needs 121, 130), "Side chat" for a running Claude or Codex session
  // (needs 124, V2-CF5), and the mockup's Diff only while Diff sits on neither bar. needs 109 (one Diff control per
  // screen, ticket 180, 8c00145e) leaves the right bar's Diff icon as the control in the default window, so Diff is
  // not here (the off-bar header Diff is pinned in fidelity-composer.spec.ts `header_controls_styled`). Still no view toggle.
  await expect(head.getByRole('button')).toHaveCount(2);
  await expect(head.getByRole('button', { name: 'Side chat' })).toBeVisible();
  await expect(head.getByRole('button', { name: 'Diff' })).toHaveCount(0);
  await expect(app.getByRole('navigation', { name: 'Right bar' }).getByRole('button', { name: 'Diff', exact: true })).toHaveCount(1);
  await expect(head.getByRole('button', { name: /notifications/i })).toBeVisible();
  await expect(head.getByRole('button', { name: /chat view|terminal view|Chat \| Terminal/i })).toHaveCount(0);
  await expect(head.locator('img')).toHaveCount(0);
  // No icon of its own beside the text: the only svg is the notify caret, inside that button.
  expect(await head.locator('svg').count()).toBe(await head.locator('button svg').count());
});

test('terminal_widget_on_right_bar', async ({ app, core }) => {
  const a = agent(core, 'a');
  await openWindow(app, {}, core);
  await open(app, a.id);
  const right = (await names(app, 'right')).filter((n) => n !== 'Layout' && n !== 'Settings');
  expect(right).toEqual(['Board', 'Decisions', 'Terminal', 'Browser', 'Diff', 'Artifacts', 'Schedules', 'History']); // ticket 1022: History after it; ticket 993: Schedules joins the next free slot
  await startEdit(app);
  await expect(lib(app).locator('.lcard[data-card="terminal"]')).toHaveCount(1);
  await expect(lib(app).locator('.lcard', { hasText: /^Terminal/ })).toHaveCount(1);
  await app.keyboard.press('Escape');
  await expect(termIcon(app)).toHaveAttribute('aria-pressed', 'false');
  await termIcon(app).click();
  await expect(pane(app)).toBeVisible();
  await expect(termIcon(app)).toHaveAttribute('aria-pressed', 'true');
  await expect(app.locator('aside.sbar[data-side="right"]')).toHaveCount(0);
  await termIcon(app).click();
  await expect(pane(app)).toHaveCount(0);
  await expect(termIcon(app)).toHaveAttribute('aria-pressed', 'false');
});

test('pane_default_closed_per_session', async ({ app, core }) => {
  const a = agent(core, 'a');
  const b = agent(core, 'b');
  await openWindow(app, {}, core);
  await open(app, a.id);
  await expect(pane(app)).toHaveCount(0);
  await open(app, b.id);
  await expect(pane(app)).toHaveCount(0);
  await open(app, a.id);
  await termIcon(app).click();
  await expect(pane(app)).toBeVisible();
  await open(app, b.id);
  await expect(pane(app)).toHaveCount(0);
  await expect(termIcon(app)).toHaveAttribute('aria-pressed', 'false');
  await open(app, a.id);
  await expect(pane(app)).toBeVisible();
  await app.reload();
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  await open(app, a.id);
  await expect(pane(app)).toBeVisible();
  await open(app, b.id);
  await expect(pane(app)).toHaveCount(0);
  // A broken store is ignored, not partially trusted.
  await app.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('nunchiro.pane')).forEach((k) => localStorage.setItem(k, '{"x":[1')));
  const errors = pageErrors(app);
  await app.reload();
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  await open(app, a.id);
  await expect(pane(app)).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('pane_keys', async ({ app, core }) => {
  expect(conflicts(DEFAULT_BINDINGS, 'Meta+KeyJ', 'pane.toggle')).toEqual([]);
  expect(DEFAULT_BINDINGS['pane.toggle']).toEqual(['Meta+KeyJ']);
  expect(DEFAULT_BINDINGS['pane.maximize']).toEqual(['Shift+Meta+Enter']);
  expect(DEFAULT_BINDINGS['pane.shell.new']).toBeUndefined();
  const a = agent(core, 'a');
  await record(app);
  await openWindow(app, {}, core);
  await open(app, a.id);
  await app.keyboard.press('Meta+KeyJ');
  await expect(pane(app)).toBeVisible();
  await app.keyboard.press('Meta+KeyJ');
  await expect(pane(app)).toHaveCount(0);
  // prefix o opens it on the PTY tab and focuses its terminal.
  await app.locator('.cbox textarea').focus();
  await app.keyboard.press('Control+Period');
  await app.keyboard.press('KeyO');
  await expect(pane(app)).toBeVisible();
  await expect(app.locator(`.term[data-session="${a.id}"]`)).toBeVisible(); // the PTY view (the tab strip is gone)
  await expect(app.locator(`.term[data-session="${a.id}"] .xterm-helper-textarea`)).toBeFocused();
  await app.keyboard.press('Shift+Meta+Enter');
  await expect(pane(app)).toHaveAttribute('data-max', '');
  await app.keyboard.press('Shift+Meta+Enter');
  await expect(pane(app)).not.toHaveAttribute('data-max', '');
  // The terminal received none of the chords.
  expect((await sent(app, 'send_text')).filter((r) => r.id === a.id)).toEqual([]);
  expect((await sent(app, 'send_keys')).filter((r) => r.id === a.id)).toEqual([]);
  // Palette and Keys page list them.
  await app.keyboard.press('Meta+KeyK');
  const palette = app.getByRole('dialog', { name: 'Command palette' });
  for (const id of ['pane.toggle', 'pane.maximize', 'pane.shell.new']) await expect(palette.locator(`[data-command="${id}"]`)).toBeVisible();
});

test('pane_tabs_exact', async ({ app, core }) => {
  const a = agent(core, 'a');
  await openWindow(app, {}, core);
  await open(app, a.id);
  await termIcon(app).click();
  // v25-shell-chrome (ticket 284 item 4): no top strip. The PTY is the view that opens; Browser and Preview come from their own icon and command.
  await expect(pane(app).getByRole('tab')).toHaveCount(0);
  await expect(pane(app).getByRole('button', { name: /^\+ Shell$/ })).toHaveCount(0);
  await expect(app.locator(`.term[data-session="${a.id}"]`)).toBeVisible();
  await icon(app, 'right', 'Browser').click();
  await expect(bview(app)).toBeVisible();
  await showPreview(app);
  await expect(pview(app)).toBeVisible();
  await expect(pane(app).getByRole('tab', { name: /Diff|Artifacts/ })).toHaveCount(0);
  await expect(app.locator('nav[data-bar]').getByRole('button', { name: /^Preview/ })).toHaveCount(0);
});

test('no_bar_holds_preview', async ({ app, core }) => {
  const a = agent(core, 'a');
  await openWindow(app, {}, core);
  await open(app, a.id);
  // A saved arrangement from the interim build (Preview on the bar) loses it on load.
  await app.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('nunchiro.settings.v1') ?? '{}');
    const bars = s.bars ?? { left: ['tree', 'files', 'search'], right: ['layout', 'board', 'preview', 'diff', 'artifacts', null, null, null, null, 'settings'], active: { left: 'tree', right: null } };
    bars.right = bars.right.map((x: string | null) => x);
    bars.right[2] = 'preview';
    localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ ...s, bars }));
  });
  await app.reload();
  await openWindow(app, {}, core);
  for (const side of ['left', 'right'] as const) expect(await names(app, side)).not.toContain('Preview');
  expect(JSON.stringify((await stored(app)).bars)).not.toContain('preview');
  await open(app, a.id);
  // The Review preset used to bring Preview in; no preset puts it on a bar.
  for (const p of ['Review', 'Focus', 'Default']) {
    await app.keyboard.press('Meta+KeyK');
    const palette = app.getByRole('dialog', { name: 'Command palette' });
    await palette.getByRole('combobox').fill(`preset ${p}`);
    const hit = palette.locator('[data-command]').first();
    if (await hit.count()) await hit.click();
    else await app.keyboard.press('Escape');
    for (const side of ['left', 'right'] as const) expect(await names(app, side)).not.toContain('Preview');
  }
  expect(ENTRIES.some((e) => e.kind === 'preview')).toBe(true); // the kind stays for zones
});

test('pane_pty_is_session_terminal', async ({ app, core }) => {
  const a = agent(core, 'a');
  await record(app);
  await openWindow(app, {}, core);
  await open(app, a.id);
  await termIcon(app).click();
  await expect(app.locator(`.term[data-session="${a.id}"] .xterm-screen`)).toBeVisible();
  await expect.poll(() => terminalText(app, a.id)).toContain('fake agent ready');
  await app.locator(`.term[data-session="${a.id}"] .xterm-helper-textarea`).focus();
  await app.keyboard.type('hello');
  await expect.poll(async () => (await sent(app, 'send_text')).filter((r) => r.id === a.id).map((r) => r.text).join('')).toBe('hello');
  // The pane's terminal is the only one for this session.
  await expect(app.locator(`.term[data-session="${a.id}"]`)).toHaveCount(1);
});

test('pane_shell_tabs', async ({ app, core }) => {
  const a = agent(core, 'a', true);
  await record(app);
  await openWindow(app, {}, core);
  await open(app, a.id);
  await termIcon(app).click();
  await expect(pane(app).getByRole('button', { name: /^Close shell/ })).toHaveCount(0);
  await newShell(app);
  const start = await expect.poll(async () => (await sent(app, 'start')).length).toBe(1).then(() => sent(app, 'start'));
  expect(start[0].session).toMatchObject({ kind: 'shell', project: a.cwd });
  const shellsNow = () => (core.cli('snapshot', '--json').sessions as { id: string; kind: string; cwd: string }[]).filter((s) => s.kind === 'shell');
  await expect.poll(() => shellsNow().length).toBe(1);
  const shells = shellsNow();
  expect(fs.realpathSync(shells[0].cwd)).toBe(fs.realpathSync(a.cwd));
  await expect(tab(app, /shell/i)).toHaveAttribute('aria-selected', 'true');
  await expect(app.locator('.tabs .tab', { hasText: /shell/ })).toHaveCount(0); // not also a window tab
  await expect(app.locator(`.term[data-session="${shells[0].id}"] .xterm-screen`)).toBeVisible();
  await pane(app).getByRole('button', { name: /^Close shell/ }).click();
  await expect(tab(app, /shell/i)).toHaveCount(0);
  await expect.poll(() => (core.cli('snapshot', '--json').sessions as { id: string; state: string }[]).find((s) => s.id === shells[0].id)?.state).not.toBe('running');
});

test('pane_browser_needs_app', async ({ app, core }) => {
  const a = agent(core, 'a');
  const requests: string[] = [];
  await openWindow(app, {}, core);
  await open(app, a.id);
  await termIcon(app).click();
  app.on('request', (r) => requests.push(r.url()));
  await icon(app, 'right', 'Browser').click();
  await expect(pane(app)).toContainText('The browser needs the Nunchiro app');
  await expect(pane(app).locator('iframe')).toHaveCount(0);
  await expect(pane(app).getByLabel('Address')).toBeDisabled();
  await app.waitForTimeout(300);
  expect(requests.filter((u) => !u.startsWith('data:'))).toEqual([]);
});

chatTest('pane_preview_tab', async ({ page, chatCore }) => {
  const s = chatCore.chat();
  const md = '# Seeded preview\n\nbody text';
  fs.writeFileSync(path.join(s.cwd, 'note.md'), md);
  append(s.file, [
    rec.use('w1', 'Write', { file_path: path.join(s.cwd, 'note.md'), content: md }),
    rec.result('w1', `File created successfully at: ${path.join(s.cwd, 'note.md')}`, { toolUseResult: { type: 'create', filePath: path.join(s.cwd, 'note.md'), content: md, structuredPatch: [] } }),
  ]);
  await openChat(page, s.id);
  const termI = icon(page, 'right', 'Terminal');
  await termI.click();
  await showPreview(page);
  await expect(pane(page).locator('.preview')).toContainText('Nothing to preview yet');
  await termI.click(); // the pane is on Preview: the Terminal icon brings the PTY back (the strip's PTY tab is gone)
  await expect(page.locator('[data-side-pane] .term')).toBeVisible();
  await termI.click();
  await expect(pane(page)).toHaveCount(0);
  // Open on a chat card shows the pane on the Preview tab, with the session's current target.
  await chat(page, s.id).locator('.acard[data-path="note.md"]').getByRole('button', { name: 'Open' }).click();
  await expect(pane(page)).toBeVisible();
  await expect(pview(page)).toBeVisible(); // the Preview view
  await expect(pane(page).locator('.preview .pv-body h1')).toHaveText('Seeded preview');
  await expect(page.locator('nav[data-bar]').getByRole('button', { name: /^Preview/ })).toHaveCount(0);
  await expect(page.locator('aside.sbar[data-side="right"]')).toHaveCount(0);
});

test('pane_resize_and_maximize', async ({ app, core }) => {
  const a = agent(core, 'a');
  await openWindow(app, {}, core);
  await open(app, a.id);
  await termIcon(app).click();
  const width = async () => Math.round((await pane(app).boundingBox())!.width);
  const chatWidth = async () => Math.round((await app.locator(`.chat[data-session="${a.id}"]`).boundingBox())!.width);
  const w0 = await width();
  const div = app.locator('[data-pane-divider]');
  const d = (await div.boundingBox())!;
  await app.mouse.move(d.x + d.width / 2, d.y + 100);
  await app.mouse.down();
  await app.mouse.move(d.x - 120, d.y + 100, { steps: 6 });
  await app.mouse.up();
  expect(await width()).toBeGreaterThan(w0 + 80);
  // Never below the minimums: pane 280, chat 320.
  const d2 = (await div.boundingBox())!;
  await app.mouse.move(d2.x + 2, d2.y + 100);
  await app.mouse.down();
  await app.mouse.move(d2.x + 2000, d2.y + 100, { steps: 6 });
  await app.mouse.up();
  expect(await width()).toBeGreaterThanOrEqual(280);
  const d3 = (await div.boundingBox())!;
  await app.mouse.move(d3.x + 2, d3.y + 100);
  await app.mouse.down();
  await app.mouse.move(-2000, d3.y + 100, { steps: 6 });
  await app.mouse.up();
  expect(await chatWidth()).toBeGreaterThanOrEqual(320);
  const w1 = await width();
  await app.reload();
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  await open(app, a.id);
  expect(Math.abs((await width()) - w1)).toBeLessThanOrEqual(1);
  const full = (await app.locator('.shead').boundingBox())!.width;
  await maximisePane(app);
  await expect(pane(app)).toHaveAttribute('data-max', '');
  expect(Math.abs((await width()) - full)).toBeLessThanOrEqual(2);
  await maximisePane(app);
  await expect(pane(app)).not.toHaveAttribute('data-max', '');
  expect(Math.abs((await width()) - w1)).toBeLessThanOrEqual(1);
});

test('pane_auto_open_blocked_tui', async ({ app, core }) => {
  const a = agent(core, 'a');
  const state = await injectPending(app);
  await openWindow(app, {}, core);
  await open(app, a.id);
  await expect(pane(app)).toHaveCount(0);
  // A dialog item: the chat cannot draw it.
  state.items[a.id] = [item(a.id, 'dialog', ['screen'])];
  state.push();
  await expect(pane(app)).toBeVisible();
  await expect(pane(app)).toHaveClass(/tui/);
  await expect(pane(app).locator('.need')).toContainText("Needs your answer here: chat cannot show this question");
  await expect(app.locator(`.term[data-session="${a.id}"]`)).toBeVisible(); // the PTY view
  await expect(app.locator(`.term[data-session="${a.id}"] .xterm-helper-textarea`)).toBeFocused();
  // Cleared: an auto-opened pane closes.
  state.items[a.id] = [];
  state.push();
  await expect(pane(app)).toHaveCount(0);
  // A screen-only item (hooks silent) opens it too; a hook-backed permission does not.
  state.items[a.id] = [item(a.id, 'permission', ['hook', 'screen'])];
  state.push();
  await app.waitForTimeout(300);
  await expect(pane(app)).toHaveCount(0);
  state.items[a.id] = [item(a.id, 'permission', ['screen'])];
  state.push();
  await expect(pane(app)).toBeVisible();
  // One the user opened stays when the item clears.
  state.items[a.id] = [];
  state.push();
  await expect(pane(app)).toHaveCount(0);
  await termIcon(app).click();
  state.items[a.id] = [item(a.id, 'dialog', ['screen'])];
  state.push();
  await expect(pane(app)).toHaveClass(/tui/);
  state.items[a.id] = [];
  state.push();
  await expect(pane(app)).not.toHaveClass(/tui/);
  await expect(pane(app)).toBeVisible();
});

test('pane_auto_open_keeps_composer_focus', async ({ app, core }) => {
  const a = agent(core, 'a');
  const state = await injectPending(app);
  await openWindow(app, {}, core);
  await open(app, a.id);
  const composer = app.locator('.cbox textarea');
  await composer.fill('half a sentence');
  await composer.focus();
  state.items[a.id] = [item(a.id, 'dialog', ['screen'])];
  state.push();
  await expect(pane(app)).toHaveClass(/tui/);
  await expect(composer).toBeFocused();
  await expect(composer).toHaveValue('half a sentence');
});

test('pane_auto_open_keeps_empty_composer_focus', async ({ app, core }) => {
  // The decisions-widget promise: a new prompt never moves focus off the composer, with or without a draft.
  const a = agent(core, 'a');
  const state = await injectPending(app);
  await openWindow(app, {}, core);
  await open(app, a.id);
  const composer = app.locator('.cbox textarea');
  await composer.focus();
  state.items[a.id] = [item(a.id, 'dialog', ['screen'])];
  state.push();
  await expect(pane(app)).toHaveClass(/tui/);
  await app.waitForTimeout(300);
  await expect(composer).toBeFocused();
});

test('selection_to_composer_no_send', async ({ app, core }) => {
  const a = agent(core, 'a');
  await record(app);
  await openWindow(app, {}, core);
  await open(app, a.id);
  await termIcon(app).click();
  await expect.poll(() => terminalText(app, a.id)).toContain('fake agent ready');
  await app.evaluate((id) => {
    const t = (window as unknown as { __terminals?: Map<string, { selectAll(): void }> }).__terminals?.get(id);
    t?.selectAll();
  }, a.id);
  const row = app.locator(`.term[data-session="${a.id}"] .xterm-rows`);
  const b = (await row.boundingBox())!;
  await app.mouse.move(b.x + 2, b.y + 4);
  await app.mouse.down();
  await app.mouse.move(b.x + 120, b.y + 4, { steps: 5 });
  await app.mouse.up();
  const insert = pane(app).getByRole('button', { name: 'Insert in composer' });
  await expect(insert).toBeVisible();
  const before = (await sent(app, 'send_text')).length;
  await insert.click();
  await expect(app.locator('.cbox textarea')).toHaveValue(/fake agent/);
  await expect(app.locator('.cbox textarea')).toBeFocused();
  expect((await sent(app, 'send_text')).length).toBe(before);
  await expect(insert).toHaveCount(0);
});

test('shell_session_centre_terminal', async ({ app, core }) => {
  const sh = core.shell(core.project('s'), 'sh1');
  await openWindow(app, {}, core);
  await app.locator(`.tab[data-tab="${sh.id}"]`).click();
  await expect(app.locator(`.pane .term[data-session="${sh.id}"] .xterm-screen`)).toBeVisible();
  await expect(termIcon(app)).toHaveAttribute('aria-pressed', 'false');
  await termIcon(app).click();
  await expect(pane(app)).toHaveCount(0);
  await expect(app.locator(`.term[data-session="${sh.id}"]`)).toHaveCount(1);
});

test('reach_two_clicks', async ({ app, core }) => {
  const a = agent(core, 'a');
  await openWindow(app, {}, core);
  await open(app, a.id);
  await termIcon(app).click(); // click 1: the pane (the PTY)
  await expect(app.locator(`.term[data-session="${a.id}"]`)).toBeVisible();
  await icon(app, 'right', 'Browser').click(); // the Browser icon: one click
  await expect(bview(app)).toBeVisible();
  await termIcon(app).click(); // the Terminal icon brings the PTY back from another view
  await expect(app.locator(`.term[data-session="${a.id}"]`)).toBeVisible();
  await app.getByRole('button', { name: 'Open command palette' }).click(); // Preview: the palette button, then its command row
  await app.locator('.palette [data-command="preview.toggle"]').click();
  await expect(pview(app)).toBeVisible();
});

test('axe_pane', async ({ app, core }) => {
  const a = agent(core, 'a');
  const state = await injectPending(app);
  await openWindow(app, {}, core);
  await open(app, a.id);
  const check = async (label: string) => {
    const r = await new AxeBuilder({ page: app }).include(SIDE).analyze();
    expect(r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${label} ${v.id}: ${v.help}`)).toEqual([]);
  };
  for (const scheme of ['light', 'dark'] as const) {
    await app.emulateMedia({ colorScheme: scheme });
    await termIcon(app).click();
    await expect(pane(app)).toBeVisible();
    await check(`${scheme} open`);
    await icon(app, 'right', 'Browser').click();
    await check(`${scheme} Browser`);
    await showPreview(app);
    await check(`${scheme} Preview`);
    await termIcon(app).click();
    await maximisePane(app);
    await check(`${scheme} max`);
    await maximisePane(app);
    state.items[a.id] = [item(a.id, 'dialog', ['screen'])];
    state.push();
    await expect(pane(app)).toHaveClass(/tui/);
    await check(`${scheme} tui`);
    state.items[a.id] = [];
    state.push();
    await termIcon(app).click();
    await expect(pane(app)).toHaveCount(0);
  }
});

test('only_pane_shortcuts_unused', async () => {
  // A removed id has no default and no entry in the area table.
  for (const id of ['view.chat', 'view.terminal', 'view.toggle']) expect(DEFAULT_BINDINGS[id]).toBeUndefined();
  expect(REPO).toBeTruthy();
});

chatTest('pane_keeps_composer_chips_whole: the composer card leaves the pane column only while that column holds its chips on one line; narrower, it spans under the pane (ticket 991 B8, C12)', async ({ page, chatCore }) => {
  const s = chatCore.chat('chips', true, true, 'p');
  append(s.file, rec.user('go'), rec.assistant('ok'));
  const cut = () => page.locator('.composer:not([data-pinned]) .cbox .chips').evaluate((c) => [...c.querySelectorAll<HTMLElement>('.chip, .pk-chip')].filter((e) => e.offsetWidth && e.scrollWidth > e.clientWidth).map((e) => e.innerText));
  for (const width of [1300, 1700]) {
    await page.setViewportSize({ width, height: 800 });
    await openChat(page, s.id);
    if (!(await pane(page).count())) await termIcon(page).click();
    await expect(pane(page)).toBeVisible();
    await expect.poll(cut).toEqual([]);
  }
  // Wide enough, the card still stays out of the pane's column (C12).
  const card = await page.locator('.composer:not([data-pinned]) .cbox').boundingBox();
  const side = await pane(page).boundingBox();
  expect(card!.x + card!.width).toBeLessThanOrEqual(side!.x);
});
