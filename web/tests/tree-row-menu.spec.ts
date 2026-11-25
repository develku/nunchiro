// V2.5-55 (ticket 214, needs 178 lane L5): every tree row has a menu. A working or waiting main-folder session row gets the
// `treerow` surface (inline Rename, Copy path), and tree rows are not text-selectable. The core cannot hold a session
// "working" on demand, so the window's socket is proxied and each session's attention is patched (as conformance-180.spec.ts);
// the patch follows the session id, because a rename changes the label it was first found by.
import type { Page } from '@playwright/test';
import { SURFACES } from '../src/menu/surfaces';
import { expect, grantClipboard, openWindow, test, type Core } from './fixtures';
import { openQuiet } from './tree-seed';
import { repo, worktree } from './visual/compare';

type Patch = { working?: boolean; waiting?: boolean; machine?: string };

async function patchSnapshots(app: Page) {
  const byLabel = new Map<string, Patch>();
  const idLabel = new Map<string, string>(); // session id -> the label it was first found by
  const sockets: { send(m: string): void }[] = [];
  const sent: string[] = []; // what the window sent to the core
  let last = '';
  const apply = (raw: string) => {
    const msg = JSON.parse(raw);
    for (const s of msg.sessions ?? []) {
      if (!idLabel.has(s.id) && byLabel.has(s.label)) idLabel.set(s.id, s.label);
      const p = byLabel.get(idLabel.get(s.id) ?? '');
      if (!p) continue;
      if (p.machine) s.machine = p.machine;
      Object.assign(s.attention, { working: !!p.working, stale: false, failed: false, waiting: !!p.waiting, last_activity: Date.now() - 600_000 });
      if (p.waiting)
        s.pending = [{ id: `d-${s.id}`, session_id: s.id, scope: s.project, kind: 'permission', text: `Run ${s.label} please?`, choices: [], observed_at: Date.now() - 60_000, actionable: true }];
    }
    return JSON.stringify(msg);
  };
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    sockets.push(ws);
    ws.onMessage((m) => (sent.push(String(m)), server.send(m)));
    server.onMessage((m) => {
      if (typeof m === 'string' && JSON.parse(m).event === 'snapshot') ws.send(apply((last = m)));
      else ws.send(m);
    });
  });
  return {
    sent,
    set(label: string, p: Patch) {
      byLabel.set(label, p);
      if (last) for (const ws of sockets) ws.send(apply(last));
    },
  };
}

const menu = (p: Page) => p.getByRole('menu', { name: 'Actions' });
const items = (p: Page) => menu(p).getByRole('menuitem');
const commands = (p: Page) => items(p).evaluateAll((els) => els.map((e) => e.getAttribute('data-command')));
const block = (p: Page, project: string) => p.locator(`.grp[data-project="${project}"]`);
const workRow = (p: Page, project = 'demo') => block(p, project).locator('.row.wt2[data-kind="work"]');
const field = (p: Page) => p.locator('.wtrename input');
const labelOf = (core: Core, id: string) => (core.cli('snapshot', '--json').sessions as { id: string; label: string }[]).find((s) => s.id === id)?.label;

/** One project with a working main-folder session `busy` (its row) and an idle one `calm`. */
async function setup(app: Page, core: Core) {
  const p = core.project('demo');
  const busy = core.shell(p, 'busy');
  const calm = core.shell(p, 'calm');
  const patch = await patchSnapshots(app);
  await openWindow(app);
  patch.set('busy', { working: true });
  await expect(workRow(app)).toHaveCount(1);
  return { p, busy, calm, patch };
}

test('tree_main_folder_session_row_has_row_menu', async ({ app, core }) => {
  const { calm } = await setup(app, core);
  const calmTab = app.locator(`.tab[data-tab="${calm.id}"]`);
  await app.evaluate(() => {
    const w = window as unknown as { __cm: boolean[] };
    w.__cm = [];
    window.addEventListener('contextmenu', (e) => w.__cm.push(e.defaultPrevented)); // bubble phase: after the menu's own listener
  });
  const row = workRow(app);
  await row.click({ button: 'right' });
  await expect(menu(app)).toBeVisible();
  expect(await commands(app)).toEqual(SURFACES.treerow);
  expect(SURFACES.treerow).toEqual(['session.new', 'session.stop', 'session.restart', 'session.close', 'session.settle', 'session.rename', 'session.copy-path', 'session.open-editor', 'focus.terminal', 'diff.open', 'worktree.tidy']);
  expect(await app.evaluate(() => (window as unknown as { __cm: boolean[] }).__cm)).toEqual([true]); // no WebKit Look Up menu
  await expect(menu(app).locator('.mhd')).toHaveText('busy · session'); // A14: a main-folder row is no worktree row
  await expect(items(app).nth(1)).toHaveText('Stop this session'); // A14: the row's own session
  // Arrows move between items; Esc closes it.
  await expect(items(app).nth(0)).toHaveAttribute('data-current', '');
  await app.keyboard.press('ArrowDown');
  await app.keyboard.press('ArrowDown');
  await expect(items(app).nth(2)).toHaveAttribute('data-current', '');
  await app.keyboard.press('Escape');
  await expect(menu(app)).toHaveCount(0);
  // Keyboard: Shift+F10 on the focused row opens it; Esc hands focus back to the row.
  await row.focus();
  await app.keyboard.press('Shift+F10');
  await expect(menu(app)).toBeVisible();
  expect(await commands(app)).toEqual(SURFACES.treerow);
  await app.keyboard.press('Escape');
  await expect(menu(app)).toHaveCount(0);
  await expect(row).toBeFocused();
  // Click and Enter open the session (the basics of a row).
  await calmTab.click();
  await expect(row).not.toHaveAttribute('aria-current', 'true');
  await row.click();
  await expect(row).toHaveAttribute('aria-current', 'true');
  await calmTab.click();
  await row.focus();
  await app.keyboard.press('Enter');
  await expect(row).toHaveAttribute('aria-current', 'true');
});

test('tree_worktree_row_menu_keeps_mockup_05_order', async ({ app, core }) => {
  const p = repo(core, 'lumen');
  worktree(core, p, 'feature-x');
  openQuiet(core, 'lumen');
  await openWindow(app);
  const row = app.locator('[data-menu="worktree"]', { hasText: 'feature-x' }).first();
  await expect(row).toBeVisible();
  await row.click({ button: 'right' });
  await expect(menu(app)).toBeVisible();
  expect(await commands(app)).toEqual(['worktree.open', 'session.new', 'worktree.rename', 'worktree.copy-path', 'worktree.reveal', 'worktree.open-editor', 'session.restart', 'session.close', 'session.settle', 'diff.open', 'worktree.remove']); // 1063: Move to done; A14: its session's items too; its idle shell has no Stop (4bf0a62d4)
});

// Look 1117 v7 (S2-2): "Create a new session…" on a worktree row opened the popover on the project's main checkout
// ("in lumen / Current checkout") and the session started there. The popover opens with the row's worktree chosen and
// the session starts in its folder; the other two places are one click away, and the plain command is as before.
test('worktree_row_new_session_starts_in_that_worktree', async ({ app, core }) => {
  const p = repo(core, 'lumen');
  worktree(core, p, 'feature-x');
  const w = (core.cli('snapshot', '--json').sessions as { label: string; cwd: string }[]).find((s) => s.label === 'feature-x')!.cwd; // its shell runs in the folder
  expect(w).not.toBe(p);
  openQuiet(core, 'lumen');
  await openWindow(app);
  const row = app.locator('[data-menu="worktree"]', { hasText: 'feature-x' }).first();
  const dlg = app.getByRole('dialog', { name: 'New tab' });
  const places = dlg.getByRole('radiogroup', { name: 'Where the session works' }).getByRole('radio');
  const claude = () => (core.cli('snapshot', '--json').sessions as { id: string; kind: string; project: string; cwd: string }[]).filter((s) => s.kind === 'claude');
  const fromRow = async () => {
    await row.click({ button: 'right' });
    await menu(app).locator('[data-command="session.new"]').click();
    await expect(dlg).toBeVisible();
  };
  await fromRow();
  await expect(dlg.locator('.nt-in')).toHaveText('in lumen');
  await expect(places).toHaveText(['feature-x', 'Current folder', 'New worktree']);
  await expect(places.nth(0)).toHaveAttribute('aria-checked', 'true');
  await expect(places.nth(0)).toHaveAttribute('title', w);
  await dlg.getByRole('option', { name: 'Claude', exact: true }).click();
  await expect(dlg).toHaveCount(0, { timeout: 15_000 });
  await expect.poll(() => claude().map((s) => [s.project, s.cwd])).toEqual([[p, w]]);
  // The same row again, Current checkout picked: the main checkout, as the choice says.
  await fromRow();
  await places.nth(0).press('ArrowRight');
  await expect(places.nth(1)).toHaveAttribute('aria-checked', 'true');
  await dlg.getByRole('option', { name: 'Claude', exact: true }).click();
  await expect(dlg).toHaveCount(0, { timeout: 15_000 });
  await expect.poll(() => claude().map((s) => s.cwd).sort()).toEqual([p, w].sort());
  // Not from a worktree row (the palette's command): the two places, the project's checkout chosen.
  await app.keyboard.press('Meta+KeyK');
  await app.getByRole('dialog', { name: 'Command palette' }).locator('[data-command="session.new"]').click();
  await expect(places).toHaveText(['Current folder', 'New worktree']);
  await expect(places.nth(0)).toHaveAttribute('aria-checked', 'true');
});

test('tree_main_row_has_the_same_more_button_A14', async ({ app, core }) => {
  // Q6 A14: one row menu: a main-folder row opens its menu from the same ⋯ button as a worktree row, and a worktree row
  // with a session offers the same session items (restart, close, diff).
  await setup(app, core);
  const wrap = workRow(app).locator('xpath=..');
  await wrap.hover();
  await wrap.locator('.wtmore').click();
  await expect(menu(app)).toBeVisible();
  expect(await commands(app)).toEqual(SURFACES.treerow);
  for (const id of ['session.stop', 'session.restart', 'session.close', 'diff.open']) expect(SURFACES.worktree).toContain(id);
});

test('tree_row_settle_folds_a_finished_row_into_done_Q7_4', async ({ app, core }) => {
  // Q7 point 4: Settle (Move to done) takes a finished main-folder row out of the tree; it comes back when it works again.
  // Ticket 1022: it is counted by the head's hollow bars (no "N done" fold, no "just finished" row for a move).
  const { patch } = await setup(app, core);
  const calm = block(app, 'demo').locator('.row.wt2', { hasText: 'calm' });
  const mark = block(app, 'demo').locator('.row.head > .dbar');
  await expect(calm).toHaveCount(1);
  const idleBars = () => block(app, 'demo').locator('.row.head > .cstrip > .sg[data-tone="g"]').evaluateAll((es) => es.reduce((n, e) => n + Number((e as HTMLElement).dataset.n), 0));
  const idle0 = await idleBars();
  const marked0 = (await mark.count()) ? Number(await mark.getAttribute('data-done-bars')) : 0;
  await calm.click({ button: 'right' });
  await menu(app).getByRole('menuitem', { name: 'Move to done' }).click();
  await expect(calm).toHaveCount(0);
  await expect(block(app, 'demo').locator('.row.wt2.just')).toHaveCount(0);
  await expect(mark).toHaveAttribute('data-done-bars', String(marked0 + 1));
  // Seventh look (A S3-4): the move says what it did and offers Undo, as Close session does; Undo brings the row back.
  await app.getByRole('status').filter({ hasText: 'Moved calm to done' }).getByRole('button', { name: 'Undo' }).click();
  await expect(calm).toHaveCount(1);
  if (marked0) await expect(mark).toHaveAttribute('data-done-bars', String(marked0));
  else await expect(mark).toHaveCount(0);
  await calm.click({ button: 'right' });
  await menu(app).getByRole('menuitem', { name: 'Move to done' }).click();
  await expect(calm).toHaveCount(0);
  // Look 1117 v3 (item 13): a moved row counts as done, not idle, in the head's strip, and stays moved after a reload.
  await expect.poll(idleBars).toBe(idle0 - 1);
  await app.reload();
  await expect(mark).toHaveAttribute('data-done-bars', String(marked0 + 1));
  await expect(calm).toHaveCount(0);
  await expect.poll(idleBars).toBe(idle0 - 1);
  patch.set('calm', { working: true });
  await expect(calm).toHaveCount(1);
});

test('tree_row_rename_is_prefilled_and_keeps_user_name', async ({ app, core }) => {
  const { p, busy, patch } = await setup(app, core);
  const row = workRow(app);
  await row.click({ button: 'right' });
  await menu(app).getByRole('menuitem', { name: 'Rename session' }).click();
  await expect(menu(app)).toHaveCount(0);
  await expect(field(app)).toBeVisible();
  await expect(field(app)).toBeFocused();
  await expect(field(app)).toHaveValue('busy');
  expect(await field(app).evaluate((e: HTMLInputElement) => [e.selectionStart, e.selectionEnd])).toEqual([0, 4]); // prefilled and selected
  await field(app).fill('release prep');
  await field(app).press('Enter');
  await expect(field(app)).toHaveCount(0);
  await expect(workRow(app).locator('.nm')).toHaveText('release prep');
  await expect(workRow(app)).toBeFocused();
  // The core carries it, and the label request had the new name.
  await expect.poll(() => labelOf(core, busy.id)).toBe('release prep');
  const asked = patch.sent.map((m) => JSON.parse(m)).map((m) => m.request ?? m).find((r) => r.op === 'label');
  expect(asked).toMatchObject({ id: busy.id, label: 'release prep' });
  // A later snapshot (a new session arrives) does not change it.
  core.shell(p, 'later');
  await expect(app.locator('.tab[data-tab]')).toHaveCount(3);
  await expect(workRow(app).locator('.nm')).toHaveText('release prep');
  // F2 on the focused row opens the same field, and the tab's own rename stays closed.
  await workRow(app).focus();
  await app.keyboard.press('F2');
  await expect(field(app)).toHaveValue('release prep');
  await expect(app.locator('.tab input')).toHaveCount(0);
});

test('tree_row_rename_esc_cancels_and_returns_focus', async ({ app, core }) => {
  const { busy } = await setup(app, core);
  await workRow(app).focus();
  await app.keyboard.press('F2');
  await expect(field(app)).toBeFocused();
  await field(app).fill('never saved');
  await app.keyboard.press('Escape');
  await expect(field(app)).toHaveCount(0);
  await expect(workRow(app).locator('.nm')).toHaveText('busy');
  await expect(workRow(app)).toBeFocused();
  expect(labelOf(core, busy.id)).toBe('busy');
  // An empty name is refused: the field shows why and stays open.
  await app.keyboard.press('F2');
  await field(app).fill('   ');
  await field(app).press('Enter');
  await expect(field(app)).toBeVisible();
  await expect(field(app)).toHaveAttribute('aria-invalid', 'true');
  await expect(field(app)).toHaveAttribute('title', /name/i);
  expect(labelOf(core, busy.id)).toBe('busy');
  await app.keyboard.press('Escape');
  await expect(workRow(app)).toBeFocused();
});

test('tree_row_copy_path', async ({ app, core }) => {
  await grantClipboard(app);
  const { busy } = await setup(app, core);
  const cwd = (core.cli('snapshot', '--json').sessions as { id: string; cwd: string }[]).find((s) => s.id === busy.id)!.cwd;
  await workRow(app).click({ button: 'right' });
  await menu(app).getByRole('menuitem', { name: 'Copy path' }).click();
  await expect(menu(app)).toHaveCount(0);
  expect(await app.evaluate(() => navigator.clipboard.readText())).toBe(cwd);
});

// Ticket 375: Open in editor opens the row's own folder (a worktree's, never the main checkout); a session on another
// machine lists it off and says why (a row's menu reads `enabledFor`, not the active session's `enabled`).
test('tree_row_open_in_editor_opens_the_rows_folder', async ({ app, core }) => {
  const p = repo(core, 'lumen');
  worktree(core, p, 'feature-x');
  const wt = (core.cli('snapshot', '--json').sessions as { label: string; cwd: string }[]).find((s) => s.label === 'feature-x')!;
  openQuiet(core, 'lumen');
  await openWindow(app);
  const row = app.locator('[data-menu="worktree"]', { hasText: 'feature-x' }).first();
  await row.click({ button: 'right' });
  await menu(app).getByRole('menuitem', { name: 'Open in editor' }).click();
  await expect.poll(() => core.opened()).toBe(`open\n-t\n${wt.cwd}\n`);
});

test('tree_row_open_in_editor_main_row_and_remote', async ({ app, core }) => {
  const { patch, busy } = await setup(app, core);
  const cwd = (core.cli('snapshot', '--json').sessions as { id: string; cwd: string }[]).find((s) => s.id === busy.id)!.cwd;
  await workRow(app).click({ button: 'right' });
  await menu(app).getByRole('menuitem', { name: 'Open session in editor' }).click();
  await expect.poll(() => core.opened()).toBe(`open\n-t\n${cwd}\n`);
  patch.set('busy', { working: true, machine: 'mbp' });
  await workRow(app).click({ button: 'right' });
  const ed = menu(app).getByRole('menuitem', { name: 'Open session in editor' });
  await expect(ed).toHaveAttribute('aria-disabled', 'true');
  await expect(ed).toHaveAttribute('title', /another machine/i);
  await ed.click({ force: true });
  expect(core.opened()).toBe(`open\n-t\n${cwd}\n`);
});

test('tree_rows_not_text_selectable', async ({ app, core }) => {
  const p = repo(core, 'lumen');
  worktree(core, p, 'feature-x');
  core.shell(p, 'busy');
  core.shell(p, 'asks');
  openQuiet(core, 'lumen');
  const patch = await patchSnapshots(app);
  await openWindow(app);
  patch.set('busy', { working: true });
  patch.set('asks', { waiting: true });
  const sel = (l: ReturnType<Page['locator']>) => l.evaluate((e) => getComputedStyle(e).userSelect);
  const main = block(app, 'lumen').locator('.row.wt2[data-kind="work"]');
  await expect(main).toHaveCount(1);
  expect(await sel(main)).toBe('none');
  expect(await sel(main.locator('.nm'))).toBe('none');
  expect(await sel(app.locator('[data-menu="worktree"]', { hasText: 'feature-x' }).first())).toBe('none');
  expect(await sel(block(app, 'lumen').locator('.row.head b'))).toBe('none');
  await main.locator('.nm').dblclick();
  expect(await app.evaluate(() => window.getSelection()?.toString())).toBe('');
  // The decision line under a row stays selectable.
  const line = block(app, 'lumen').locator('.q .qt').first();
  await expect(line).toBeVisible();
  expect(await sel(line)).not.toBe('none');
});

// Look 1117 (S3, F2): a finished worktree row's menu offered "Stop this session" (greyed): nothing runs to stop there.
test('finished_row_menu_offers_no_stop', async ({ app, core }) => {
  const p = repo(core, 'lumen');
  worktree(core, p, 'feature-x');
  openQuiet(core, 'lumen');
  const s = (core.cli('snapshot', '--json').sessions as { id: string; label: string }[]).find((x) => x.label === 'feature-x')!;
  core.cli('session', 'send-text', s.id, 'exit\r');
  await expect.poll(() => (core.cli('snapshot', '--json').sessions as { id: string; state: string }[]).find((x) => x.id === s.id)?.state).toBe('exited');
  await openWindow(app);
  // Ticket 1063: the finished worktree row leaves the tree; its session's menu is now the one in the head's done popover.
  await expect(app.locator('.row.wt2', { hasText: 'feature-x' })).toHaveCount(0);
  await app.locator('.grp[data-project="lumen"] > .row.head button.dbar').click();
  await app.locator(`[data-done-pop] [data-done-item="${s.id}"]`).click({ button: 'right' });
  await expect(menu(app)).toBeVisible();
  const ids = await commands(app);
  expect(ids).toContain('session.restart');
  expect(ids).not.toContain('session.stop');
});

// Look 1117 v3 (C): the Korean row menu had two English items, "Focus the terminal" and "Open Diff (…)".
test('row_menu_items_in_korean', async ({ app, core }) => {
  core.shell(core.project('demo'), 'calm');
  await app.addInitScript(() => localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ language: 'ko' })));
  await app.goto('/');
  await expect(app.locator('.tab[data-tab]')).toHaveCount(1);
  await app.locator('.row.wt2', { hasText: 'calm' }).first().click({ button: 'right' });
  const items = await app.getByRole('menu').getByRole('menuitem').allTextContents();
  expect(items.length).toBeGreaterThan(3);
  expect(items.filter((x) => /[A-Za-z]{4,}/.test(x.replace(/Diff|F2|⌘|⌃|⇧/g, '')))).toEqual([]);
});

// Look 1117 v3 (C): a row menu stayed open on top of the Settings dialog; a dialog taking the focus ends it.
test('row_menu_closes_when_a_dialog_takes_focus', async ({ app, core }) => {
  core.shell(core.project('demo'), 'calm');
  await openWindow(app);
  await app.locator('.row.wt2', { hasText: 'calm' }).first().click({ button: 'right' });
  await expect(menu(app)).toBeVisible();
  // A terminal that takes the focus late (a session that has just started) leaves the menu the user opened (wave 15).
  await app.evaluate(() => document.querySelector<HTMLElement>('.xterm-helper-textarea, .tab[data-tab]')!.focus());
  await expect(menu(app)).toBeVisible();
  // Look 1117 v11 (A): a session started meanwhile (from the CLI) leaves the menu opened from the row's ⋯, also once the
  // tree, which holds still for 5 s, takes the new row (in the real app the menu went at that moment).
  await app.keyboard.press('Escape');
  await app.locator('.wtwrap', { hasText: 'calm' }).first().hover();
  await app.locator('.wtwrap', { hasText: 'calm' }).first().locator('.wtmore').click();
  const items = await menu(app).getByRole('menuitem').count();
  expect(items).toBeGreaterThan(3);
  core.shell(core.project('demo'), 'fresh');
  await expect(app.locator('.row.wt2', { hasText: 'fresh' })).toHaveCount(1, { timeout: 10_000 });
  await expect(menu(app).getByRole('menuitem')).toHaveCount(items);
  // A dialog's first field takes the focus when it opens: that ends the menu.
  await app.evaluate(() => {
    const d = document.body.appendChild(Object.assign(document.createElement('div'), { innerHTML: '<input>' }));
    d.setAttribute('role', 'dialog');
    d.querySelector('input')!.focus();
  });
  await expect(menu(app)).toHaveCount(0);
});

test('tree_rows_with_one_name_say_their_agent (seventh look, B S3): a Claude and a shell session named alike each say their agent first, as their tabs do; a row with its own name says none', async ({ app, core }) => {
  const p = core.project('demo');
  core.shell(p, 'same');
  core.agent(p, 'same', 'go');
  core.shell(p, 'other');
  await openWindow(app);
  const rows = block(app, 'demo').locator('.row.wt2');
  await expect(rows).toHaveCount(3);
  expect((await rows.filter({ hasText: 'same' }).locator('.pre').allInnerTexts()).map((x) => x.trim()).sort()).toEqual(['claude ·', 'shell ·']);
  await expect(rows.filter({ hasText: 'other' }).locator('.pre')).toHaveCount(0);
  // Words only: a row's icon stays its state (no agent face in the tree).
  await expect(rows.locator('.agent-logo, .lead-av')).toHaveCount(0);
  // Eighth look (B6-S3-3): two first messages that start alike are cut to the same text in a row; they say their agent too.
  core.shell(p, 'Use no connector or MCP tool. Run the tests');
  core.agent(p, 'Use no connector or MCP tool. Reply with pong', 'go');
  await expect(rows).toHaveCount(5);
  expect((await rows.filter({ hasText: 'Use no connector' }).locator('.pre').allInnerTexts()).map((x) => x.trim()).sort()).toEqual(['claude ·', 'shell ·']);
});
