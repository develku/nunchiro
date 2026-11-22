// v25-shell-chrome (tickets 283, 284 items 1, 2, 4; 282 items 1-2; 294 item 5; needs 205, 206, 207, 213): icon bars,
// sidebars, the main zone, window restore, the status line. Each test name is an acceptance key of the brief.
import fs from 'node:fs';
import path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { REPO, expect, openWindow, test, type Core } from './fixtures';
import { fakes, gitRepo, PERMISSION, show } from './decision-rows-seed';
import { bar, icon, sidebar, stored } from './d5b';

const SHOTS = path.join(REPO, '.scratch', 'shots-v25-shell-chrome');
const left = (p: Page) => sidebar(p, 'left');
const right = (p: Page) => sidebar(p, 'right');
const edge = (p: Page, side: 'left' | 'right') => p.getByRole('separator', { name: `Resize the ${side} sidebar` });
const wide = async (l: Locator) => Math.round((await l.boundingBox())!.width);
const palette = async (p: Page, text: string) => {
  await p.keyboard.press('Meta+KeyK');
  await p.getByRole('dialog', { name: 'Command palette' }).getByRole('combobox').or(p.getByRole('dialog', { name: 'Command palette' }).getByRole('textbox')).first().fill(text);
  await p.keyboard.press('Enter');
};
/** Drags a separator by dx from its centre. */
async function dragBy(p: Page, handle: Locator, dx: number) {
  const b = (await handle.boundingBox())!;
  const [x, y] = [b.x + b.width / 2, b.y + b.height / 2];
  await p.mouse.move(x, y);
  await p.mouse.down();
  await p.mouse.move(x + dx, y, { steps: 12 });
  await p.mouse.up();
}
/** A token as the browser resolves it for `prop`. */
const token = (p: Page, name: string, prop: 'color' | 'backgroundColor' = 'color') =>
  p.evaluate(([n, k]) => {
    const d = document.createElement('i');
    d.style[k as 'color'] = `var(${n})`;
    document.body.append(d);
    const c = getComputedStyle(d)[k as 'color'];
    d.remove();
    return c;
  }, [name, prop]);
const sty = (l: Locator, prop: 'color' | 'fill' | 'stroke' | 'backgroundColor') => l.evaluate((e, k) => getComputedStyle(e)[k], prop);

async function waiting(app: Page, core: Core) {
  fakes(core);
  const a = core.agent(gitRepo(core, 'repo'), 'wt-a', 'go-a', true);
  await openWindow(app);
  show(a.cwd, 'go-a', PERMISSION('rm x'));
  return a;
}

// ---- Ticket 283: icon bars and sidebars -------------------------------------------------------------------------------

// Ticket 1041 (owner 2026-11-22, supersedes the accent fill of ticket 283): the open widget is one tint step, a pill.
test('rail_active_icon_tint: the open widget sits on the selected tint in the text colour; the others stay grey on no fill', async ({ app }) => {
  await openWindow(app);
  const on = bar(app, 'left').locator('button.ai[aria-pressed="true"]');
  await expect(on).toHaveCount(1);
  expect(await sty(on, 'backgroundColor')).toBe(await token(app, '--select-bg', 'backgroundColor'));
  expect(await sty(on, 'color')).toBe(await token(app, '--select-text'));
  expect(await sty(on.locator('.gl svg'), 'color')).not.toBe(await token(app, '--accent'));
  const off = icon(app, 'left', 'Files');
  expect(await sty(off, 'backgroundColor')).toBe('rgba(0, 0, 0, 0)');
  expect(await sty(off, 'color')).toBe(await token(app, '--muted'));
});

test('rail_has_no_active_side_bar: no blue bar on the open icon, on either bar', async ({ app }) => {
  await openWindow(app);
  await icon(app, 'right', 'Diff').click();
  await expect(right(app)).toBeVisible();
  for (const side of ['left', 'right'] as const) {
    const on = bar(app, side).locator('button.ai[aria-pressed="true"]');
    await expect(on).toHaveCount(1);
    expect(await on.evaluate((e) => getComputedStyle(e, '::before').content)).toMatch(/^(none|normal)$/);
  }
});

test('rail_waiting_dot_independent_of_active: a pending decision dots the Decisions icon, open or not, and no other icon', async ({ app, core }) => {
  await waiting(app, core);
  const dec = icon(app, 'right', 'Decisions');
  const dot = dec.locator('.wdot');
  await expect(dot).toBeVisible({ timeout: 8000 });
  await expect(dec).toHaveAttribute('aria-pressed', 'false'); // not the open one
  await expect(icon(app, 'left', 'Files').locator('.wdot')).toHaveCount(0);
  const b = (await dec.boundingBox())!;
  const d = (await dot.boundingBox())!;
  expect(d.x + d.width / 2).toBeGreaterThan(b.x + b.width / 2); // top right of the icon
  expect(d.y + d.height / 2).toBeLessThan(b.y + b.height / 2);
  await dec.click();
  await expect(dec).toHaveAttribute('aria-pressed', 'true');
  await expect(dot).toBeVisible(); // the active mark does not take it away
  await dec.click();
  await expect(dot).toBeVisible();
});

test('rail_top_button_hides_and_shows_sidebar: the first control of each icon bar toggles that side; Cmd+B still does', async ({ app }) => {
  await openWindow(app);
  const hide = bar(app, 'left').getByRole('button', { name: 'Hide left sidebar' });
  await expect(hide).toBeVisible();
  const first = (await bar(app, 'left').locator('.slot').first().boundingBox())!;
  expect((await hide.boundingBox())!.y + (await hide.boundingBox())!.height).toBeLessThanOrEqual(first.y + 1); // above every icon
  await hide.click();
  await expect(left(app)).toHaveCount(0);
  const show = bar(app, 'left').getByRole('button', { name: 'Show left sidebar' });
  await expect(show).toHaveAttribute('aria-expanded', 'false');
  await show.click();
  await expect(left(app)).toHaveAttribute('data-widget', 'tree');
  await app.keyboard.press('Meta+KeyB');
  await expect(left(app)).toHaveCount(0);
  await app.keyboard.press('Meta+KeyB');
  await expect(left(app)).toBeVisible();
  // The right side: closed at first; its top button opens the first widget it can show.
  await bar(app, 'right').getByRole('button', { name: 'Show right sidebar' }).click();
  await expect(right(app)).toBeVisible();
  await bar(app, 'right').getByRole('button', { name: 'Hide right sidebar' }).click();
  await expect(right(app)).toHaveCount(0);
  // v25f F13: the button toggles only its sidebar, the bar stays; its tooltip names the key on both sides.
  await expect(bar(app, 'right')).toBeVisible();
  await expect(bar(app, 'left').locator('.sidebtn')).toHaveAttribute('data-tip-cmd', 'sidebar.left.toggle');
  await expect(bar(app, 'right').locator('.sidebtn')).toHaveAttribute('data-tip-cmd', 'sidebar.right.toggle');
});

// v25f F12 (owner 11-08, amends needs 206 / ticket 283 items 4 and 7): each sidebar keeps its own width.
test('sidebars_resize_per_side: dragging the right sidebar leaves the left width, and the other way round', async ({ app }) => {
  await openWindow(app);
  await icon(app, 'right', 'Decisions').click();
  await expect(right(app)).toBeVisible();
  const w0 = await wide(left(app));
  expect(await wide(right(app))).toBe(w0);
  await dragBy(app, edge(app, 'right'), -60); // the right edge: a drag away from the window edge widens it
  expect(await wide(right(app))).toBe(w0 + 60);
  expect(await wide(left(app))).toBe(w0);
  await dragBy(app, edge(app, 'left'), 30);
  expect(await wide(left(app))).toBe(w0 + 30);
  expect(await wide(right(app))).toBe(w0 + 60);
  await expect.poll(async () => (await stored(app)).bars.widgetW).toEqual({ tree: w0 + 30, decisions: w0 + 60 });
});

// Ticket 997 L2 (rule A7, owner 11-19): each widget keeps the width the user gave it; a widget not resized since takes its side's older width.
test('widget_width_kept_per_widget: two widgets on one side keep their own widths, after a reload too; the palette steps the shown one', async ({ app }) => {
  await openWindow(app);
  await icon(app, 'right', 'Decisions').click();
  const w0 = await wide(right(app));
  await dragBy(app, edge(app, 'right'), -60);
  expect(await wide(right(app))).toBe(w0 + 60);
  await icon(app, 'right', 'Diff').click();
  await expect(right(app)).toHaveAttribute('data-widget', 'diff');
  expect(await wide(right(app))).toBe(w0); // not the width Decisions was given
  await dragBy(app, edge(app, 'right'), -20);
  await icon(app, 'right', 'Decisions').click();
  await expect.poll(() => wide(right(app))).toBe(w0 + 60);
  await app.reload();
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  await expect.poll(() => wide(right(app))).toBe(w0 + 60);
  await palette(app, 'Sidebars wider');
  await expect.poll(() => wide(right(app))).toBe(w0 + 84);
  await icon(app, 'right', 'Diff').click();
  await expect.poll(() => wide(right(app))).toBe(w0 + 20); // the step was Decisions' alone
  // An arrangement from before per-widget widths: a widget never resized since opens at its side's old width.
  await app.evaluate(() => {
    const k = 'nunchiro.settings.v1';
    const s = JSON.parse(localStorage.getItem(k) ?? '{}');
    localStorage.setItem(k, JSON.stringify({ ...s, bars: { ...s.bars, sidebarW: { right: 330 }, widgetW: { decisions: 300 } } }));
  });
  await app.reload();
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  await expect(right(app)).toHaveAttribute('data-widget', 'diff'); // still open from before the reload
  await expect.poll(() => wide(right(app))).toBe(330);
  await icon(app, 'right', 'Decisions').click();
  await expect.poll(() => wide(right(app))).toBe(300);
});

test('edge_double_click_restores_default: a double-click on an edge puts the default width on that side only', async ({ app }) => {
  await openWindow(app);
  await icon(app, 'right', 'Decisions').click();
  const w0 = await wide(left(app));
  await dragBy(app, edge(app, 'left'), 80);
  await dragBy(app, edge(app, 'right'), -40);
  await edge(app, 'right').dblclick();
  expect(await wide(right(app))).toBe(w0);
  expect(await wide(left(app))).toBe(w0 + 80);
});

test('sidebar_width_saved_per_layout: the width is kept with the layout; a saved preset brings its own back', async ({ app }) => {
  await openWindow(app);
  const w0 = await wide(left(app));
  await dragBy(app, edge(app, 'left'), 70);
  await expect.poll(async () => (await stored(app)).bars.widgetW?.tree).toBe(w0 + 70);
  await app.reload();
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  expect(await wide(left(app))).toBe(w0 + 70);
  // Save this layout as "wide", change the width, load "wide": its width returns.
  await bar(app, 'right').getByRole('button', { name: 'Layout' }).click();
  const strip = app.getByRole('toolbar', { name: 'Layout edit' });
  await strip.getByRole('button', { name: /^Presets/ }).click();
  await app.getByRole('menuitem', { name: 'Save as…' }).click();
  await app.getByRole('textbox', { name: 'Preset name' }).fill('wide');
  await app.keyboard.press('Enter');
  await dragBy(app, edge(app, 'left'), -50);
  expect(await wide(left(app))).toBe(w0 + 20);
  await strip.getByRole('button', { name: /^Presets/ }).click();
  await app.getByRole('menuitemradio', { name: 'wide' }).click();
  await expect.poll(() => wide(left(app))).toBe(w0 + 70);
});

// Ticket 1041 (owner 2026-11-22): icons only at one width; ticket 283's label steps and bar-width drag are gone.
test('rail_icons_only_fixed_width: both bars are 48 px of 32 px icons with no label and no width handle; an old stored width is ignored', async ({ app }) => {
  await app.addInitScript(() => {
    if (sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded', '1');
    const k = 'nunchiro.settings.v1';
    const s = JSON.parse(localStorage.getItem(k) ?? '{}');
    if (s.bars) localStorage.setItem(k, JSON.stringify({ ...s, bars: { ...s.bars, barW: 34 } }));
  });
  await openWindow(app);
  await app.reload(); // the second load reads the store the first one wrote, with the old width added
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  for (const side of ['left', 'right'] as const) {
    expect(Math.round((await bar(app, side).boundingBox())!.width)).toBe(48);
    await expect(bar(app, side).locator('.al')).toHaveCount(0);
    await expect(bar(app, side).getByRole('separator')).toHaveCount(0);
    await expect(bar(app, side)).not.toHaveAttribute('data-compact');
    const b = (await bar(app, side).locator('button.ai').first().boundingBox())!;
    expect([Math.round(b.width), Math.round(b.height)]).toEqual([32, 32]);
  }
  await expect.poll(async () => (await stored(app)).bars?.barW).toBeUndefined();
  fs.mkdirSync(SHOTS, { recursive: true });
  await app.mouse.move(700, 400);
  await app.screenshot({ path: path.join(SHOTS, 'rails-icons-only.png'), clip: { x: 0, y: 0, width: 160, height: 480 } });
});

test('rail_tooltip_full_name: hover names the widget, with its key', async ({ app }) => {
  await openWindow(app);
  await bar(app, 'right').locator('button.ai[aria-label="Decisions"]').hover();
  await expect(app.locator('#app-tip')).toContainText('Decisions');
  await app.mouse.move(700, 400);
  await expect(app.locator('#app-tip')).toBeHidden();
  await bar(app, 'left').locator('button.ai[aria-label="Files"]').hover();
  await expect(app.locator('#app-tip')).toContainText('Files');
  await expect(app.locator('#app-tip')).toContainText('⇧⌘E');
});

test('rail_keeps_active_and_waiting_marks: the open icon keeps its tint and the waiting dot sits inside its button', async ({ app, core }) => {
  await waiting(app, core);
  await expect(icon(app, 'right', 'Decisions').locator('.wdot')).toBeVisible({ timeout: 8000 });
  const dec = bar(app, 'right').locator('button.ai[aria-label="Decisions"]');
  await dec.click();
  await expect(dec).toHaveAttribute('aria-pressed', 'true');
  await expect(dec.locator('.gl svg')).toBeVisible();
  expect(await sty(dec, 'backgroundColor')).toBe(await token(app, '--select-bg', 'backgroundColor'));
  const b = (await dec.boundingBox())!;
  const d = (await dec.locator('.wdot').boundingBox())!;
  expect(d.x).toBeGreaterThanOrEqual(b.x);
  expect(d.x + d.width).toBeLessThanOrEqual(b.x + b.width + 1);
  expect(d.y).toBeGreaterThanOrEqual(b.y - 1);
  expect(await sty(dec.locator('.wdot'), 'backgroundColor')).toBe(await token(app, '--light-you', 'backgroundColor'));
});

test('panel_drag_below_min_closes: dragging a sidebar edge under its minimum closes it; the button and Cmd+B reopen it at the last width', async ({ app }) => {
  await openWindow(app);
  await icon(app, 'right', 'Decisions').click();
  await dragBy(app, edge(app, 'left'), 40);
  const w = await wide(left(app));
  await dragBy(app, edge(app, 'left'), -(w - 60));
  await expect(left(app)).toHaveCount(0);
  await expect(right(app)).toBeVisible(); // only the dragged side closes
  await bar(app, 'left').getByRole('button', { name: 'Show left sidebar' }).click();
  expect(await wide(left(app))).toBe(w);
  await dragBy(app, edge(app, 'left'), -(w - 60));
  await expect(left(app)).toHaveCount(0);
  await app.keyboard.press('Meta+KeyB');
  await expect(left(app)).toBeVisible();
  expect(await wide(left(app))).toBe(w);
});

test('other_side_opens_at_own_width: a sidebar opened later keeps its own width, not the other one\'s', async ({ app }) => {
  await openWindow(app);
  const w0 = await wide(left(app));
  await dragBy(app, edge(app, 'left'), 90);
  await icon(app, 'right', 'Diff').click();
  await expect(right(app)).toBeVisible();
  expect(await wide(right(app))).toBe(w0);
});

test('palette_sidebar_wider_narrower: two palette commands step the widget shown on each side', async ({ app }) => {
  await openWindow(app);
  await icon(app, 'right', 'Decisions').click();
  const w0 = await wide(left(app));
  await palette(app, 'Sidebars wider');
  await expect.poll(() => wide(left(app))).toBeGreaterThan(w0);
  const w1 = await wide(left(app));
  expect(await wide(right(app))).toBe(w1);
  await palette(app, 'Sidebars narrower');
  await expect.poll(() => wide(left(app))).toBe(w0);
  expect(await wide(right(app))).toBe(w0);
});

// ---- Ticket 284: the main zone, sidebar headers, the terminal widget -------------------------------------------------------

test('main_zone_has_no_terminal_board_strip: stacking the Board shows no Terminal / Board tab strip', async ({ app, core }) => {
  core.agent(core.project('a'), 'x', 'alpha');
  await openWindow(app);
  await bar(app, 'right').getByRole('button', { name: /^Board( · |$)/ }).click();
  await expect(app.locator('.board')).toBeVisible();
  await expect(app.getByRole('tablist', { name: /^Zone / })).toBeHidden();
  await expect(app.getByRole('tab', { name: 'Terminal', exact: true })).toBeHidden();
  await expect(app.getByRole('tab', { name: 'Board', exact: true })).toBeHidden();
});

test('board_and_terminal_reachable_as_widgets: the Board and Terminal icons switch between them', async ({ app, core }) => {
  const a = core.agent(core.project('a'), 'x', 'alpha');
  await openWindow(app);
  await app.locator(`.tab[data-tab="${a.id}"]`).click();
  const boardIcon = bar(app, 'right').getByRole('button', { name: /^Board( · |$)/ });
  await boardIcon.click();
  await expect(app.locator('.ovl[data-overlay="board"] .board')).toBeVisible(); // v25f: the Board is a modal over the rails
  await app.keyboard.press('Escape');
  await expect(app.locator('.board')).toHaveCount(0);
  await icon(app, 'right', 'Terminal').click();
  await expect(app.locator('[data-side-pane]')).toBeVisible();
  await boardIcon.click();
  await expect(app.locator('.ovl[data-overlay="board"] .board')).toBeVisible();
  await app.keyboard.press('Escape');
  await expect(app.locator('.board')).toHaveCount(0);
  await expect(app.locator('[data-side-pane]')).toBeVisible(); // the pane stayed behind the modal
});

test('sidebar_header_has_no_side_label: a sidebar header names its widget only', async ({ app }) => {
  await openWindow(app);
  await icon(app, 'right', 'Diff').click();
  for (const s of [left(app), right(app)]) {
    const head = s.locator('.sbh');
    await expect(head).toBeVisible();
    const text = (await head.innerText()).trim();
    expect(text).not.toMatch(/sidebar/i);
    expect(text).toMatch(/^(Tree|Diff)$/);
  }
});

test('terminal_widget_has_no_top_strip: the side pane opens on its terminal with no tab strip, buttons or key hint', async ({ app, core }) => {
  const a = core.agent(core.project('a'), 'x', 'alpha');
  await openWindow(app);
  await app.locator(`.tab[data-tab="${a.id}"]`).click();
  await icon(app, 'right', 'Terminal').click();
  const pane = app.locator('[data-side-pane]');
  await expect(pane).toBeVisible();
  await expect(pane.locator('.tdh')).toHaveCount(0);
  for (const name of ['+ Shell', 'Browser', 'Preview']) await expect(pane.getByRole('button', { name, exact: true })).toHaveCount(0);
  await expect(pane.getByRole('button', { name: /Maximize the pane|Restore the pane|Close the side pane/ })).toHaveCount(0);
  await expect(pane).not.toContainText('side by side');
  await expect(pane.locator('.term')).toBeVisible(); // the terminal itself is there
});

test('new_shell_and_split_from_palette: a shell and a split are still one palette command away', async ({ app, core }) => {
  const a = core.agent(core.project('a'), 'x', 'alpha');
  await openWindow(app);
  await app.locator(`.tab[data-tab="${a.id}"]`).click();
  await icon(app, 'right', 'Terminal').click();
  await expect(app.locator('[data-side-pane]')).toBeVisible();
  await palette(app, 'New shell in the side pane');
  await expect(app.locator('[data-side-pane] .term')).toHaveCount(2); // the agent's PTY and the new shell
  await palette(app, 'Split right');
  await expect(app.locator('[data-split-id]')).toHaveCount(1);
});

// ---- Ticket 282: restore the window ---------------------------------------------------------------------------------------

const tabIds = (p: Page) => p.locator('.tab[data-tab]').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.tab));
const reopen = async (app: Page) => {
  await app.reload();
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  await expect(app.locator('.tab[data-tab]').first()).toBeVisible();
};

// Ticket 991: restore_reopens_last_tabs_and_splits failed once with the newest of its three tabs first. Sessions the
// window first sees together were ordered by pid, and the system's pids wrap around. They open in the order they were
// started (the snapshot's order), whatever their pids are.
test('tabs_of_sessions_seen_together_open_in_start_order: not in pid order', async ({ app, core }) => {
  const p = core.project('demo');
  const started = ['one', 'two', 'three', 'four', 'five'].map((l) => core.shell(p, l).id);
  // As after a wrap: each later session has a lower pid than the one before it.
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => server.send(m));
    server.onMessage((m) => {
      const f = typeof m === 'string' ? JSON.parse(m) : null;
      if (f?.event !== 'snapshot') return ws.send(m);
      for (const s of f.sessions ?? []) if (started.includes(s.id)) s.pid = 90000 - started.indexOf(s.id);
      ws.send(JSON.stringify(f));
    });
  });
  expect((core.cli('snapshot', '--json').sessions as { id: string }[]).map((s) => s.id)).toEqual(started); // the core's own list
  await openWindow(app);
  await expect(app.locator('.tab[data-tab]')).toHaveCount(started.length);
  expect(await tabIds(app)).toEqual(started);
});

test('restore_reopens_last_tabs_and_splits: quit with 3 tabs and a split, reopen: same tabs, same focus, no resume strip', async ({ app, core }) => {
  const p = core.project('demo');
  const [a, b, c, d] = ['one', 'two', 'three', 'four'].map((l) => core.shell(p, l).id);
  await openWindow(app);
  await app.locator(`.tab[data-tab="${d}"]`).click({ button: 'middle' }); // four was closed before the quit: it stays closed
  await app.locator(`.tab[data-tab="${b}"]`).click();
  await palette(app, 'Split right');
  await expect(app.locator('[data-split-id]')).toHaveCount(1);
  expect(await tabIds(app)).toEqual([a, b, c]);
  await reopen(app);
  expect(await tabIds(app)).toEqual([a, b, c]);
  await expect(app.locator(`.tab[data-tab="${b}"]`)).toHaveAttribute('aria-selected', 'true');
  await expect(app.locator('[data-split-id]')).toHaveCount(1);
  await expect(app.getByText('Resume where you left off')).toHaveCount(0);
  await expect(app.getByRole('button', { name: /^Resume/ })).toHaveCount(0);
});

test('ended_session_restores_read_only_without_strip: an ended tab comes back read-only with no warning or Resume strip', async ({ app, core }) => {
  const p = core.project('demo');
  const live = core.shell(p, 'live').id;
  const gone = core.shell(p, 'gone').id;
  await openWindow(app);
  await app.locator(`.tab[data-tab="${gone}"]`).click();
  core.windowClose(gone); // ticket 1013 F6: the window's own Close keeps the done tab
  await expect(app.locator(`.tab[data-tab="${gone}"] .tdot`)).toHaveAttribute('data-s', 'done');
  await reopen(app);
  expect(await tabIds(app)).toEqual([live, gone]);
  await expect(app.locator(`.tab[data-tab="${gone}"]`)).toHaveAttribute('aria-selected', 'true');
  await expect(app.locator('.roterm .term')).toBeVisible(); // read-only: the scrollback, no input
  await expect(app.locator('.resume')).toHaveCount(0);
  await expect(app.getByRole('button', { name: /^Resume/ })).toHaveCount(0);
});

test('restart_from_tab_menu_and_palette: "Restart session" restarts an ended tab from its menu and from the palette', async ({ app, core }) => {
  const p = core.project('demo');
  const first = core.shell(p, 'job').id;
  await openWindow(app);
  await app.locator(`.tab[data-tab="${first}"]`).click();
  core.windowClose(first); // ticket 1013 F6: the window's own Close keeps the done tab
  const tab = app.locator(`.tab[data-tab="${first}"]`);
  await expect(tab.locator('.tdot')).toHaveAttribute('data-s', 'done');
  await tab.click({ button: 'right' });
  const menu = app.getByRole('menu', { name: 'Actions' });
  await expect(menu.getByRole('menuitem', { name: 'Restart session' })).toBeVisible();
  await menu.getByRole('menuitem', { name: 'Restart session' }).click();
  await expect(app.locator(`.tab[data-tab="${first}"]`)).toHaveCount(0); // the tab followed the session to its new id
  const second = (await tabIds(app))[0]!;
  await expect(app.locator(`.tab[data-tab="${second}"] .tdot`)).not.toHaveAttribute('data-s', 'done'); // running again
  // A running session offers no restart; end it again and use the palette.
  await app.locator(`.tab[data-tab="${second}"]`).click({ button: 'right' });
  await expect(app.getByRole('menu', { name: 'Actions' }).getByRole('menuitem', { name: 'Restart session' })).toHaveAttribute('aria-disabled', 'true');
  await app.keyboard.press('Escape');
  core.windowClose(second); // ticket 1013 F6: the window's own Close keeps the done tab
  await expect(app.locator(`.tab[data-tab="${second}"] .tdot`)).toHaveAttribute('data-s', 'done');
  await palette(app, 'Restart session');
  await expect(app.locator(`.tab[data-tab="${second}"]`)).toHaveCount(0);
  const third = (await tabIds(app))[0]!;
  expect(third).not.toBe(second);
  await expect(app.locator(`.tab[data-tab="${third}"] .tdot`)).not.toHaveAttribute('data-s', 'done');
});

// ---- Ticket 294 item 5 ---------------------------------------------------------------------------------------------------

test('status_line_has_no_stale_layout_notice: the status line never says the answer strip was removed', async ({ app }) => {
  await openWindow(app);
  const foot = app.locator('footer.status');
  await expect(foot).toBeVisible();
  await expect(foot).not.toContainText('answer strip removed');
  await expect(foot).not.toContainText('signals only');
});

// ---- Basics (needs 172) and entry points ---------------------------------------------------------------------------------

test('shell_chrome_basic_interactions: the new button, the handles and the menu entry take keys, show a name and give focus back', async ({ app, core }) => {
  const p = core.project('demo');
  const s = core.shell(p, 'job').id;
  await openWindow(app);
  // Button: focusable, Enter and Space toggle, the hover name carries the key.
  const hide = bar(app, 'left').getByRole('button', { name: 'Hide left sidebar' });
  await hide.focus();
  await app.keyboard.press('Enter');
  await expect(left(app)).toHaveCount(0);
  const show = bar(app, 'left').getByRole('button', { name: 'Show left sidebar' });
  await show.focus();
  await app.keyboard.press('Space');
  await expect(left(app)).toBeVisible();
  await app.mouse.move(700, 400);
  await bar(app, 'left').getByRole('button', { name: 'Hide left sidebar' }).hover();
  await expect(app.locator('#app-tip')).toContainText('Hide left sidebar');
  // Sidebar edge: arrows resize that side only (v25f F12), double-click default.
  await icon(app, 'right', 'Decisions').click();
  const w0 = await wide(left(app));
  await edge(app, 'left').focus();
  await app.keyboard.press('ArrowRight');
  expect(await wide(left(app))).toBe(w0 + 24);
  expect(await wide(right(app))).toBe(w0);
  await expect(edge(app, 'left')).toBeFocused();
  // Tab menu: Esc closes it and focus returns to the tab; arrows reach Restart session.
  core.windowClose(s); // ticket 1013 F6: the window's own Close keeps the done tab
  const tab = app.locator(`.tab[data-tab="${s}"]`);
  await expect(tab.locator('.tdot')).toHaveAttribute('data-s', 'done');
  await tab.focus();
  await app.keyboard.press('Shift+F10');
  const menu = app.getByRole('menu', { name: 'Actions' });
  await expect(menu).toBeVisible();
  await app.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(tab).toBeFocused();
  await app.keyboard.press('Shift+F10');
  const restartId = await menu.getByRole('menuitem', { name: 'Restart session' }).getAttribute('id');
  for (let i = 0; i < 12 && (await menu.getAttribute('aria-activedescendant')) !== restartId; i++) await app.keyboard.press('ArrowDown');
  await app.keyboard.press('Enter');
  await expect(app.locator(`.tab[data-tab="${s}"]`)).toHaveCount(0); // restarted: the tab followed the session
});

test('shell_chrome_controls_within_two_clicks: every new control is reached from a visible, labelled one in two clicks', async ({ app, core }) => {
  const p = core.project('demo');
  const s = core.shell(p, 'job').id;
  await openWindow(app);
  // 1 click: the hide / show buttons. The sidebar edge is a visible separator (drag, arrows, double-click).
  await bar(app, 'left').getByRole('button', { name: 'Hide left sidebar' }).click();
  await expect(left(app)).toHaveCount(0);
  await bar(app, 'left').getByRole('button', { name: 'Show left sidebar' }).click();
  await expect(edge(app, 'left')).toBeVisible();
  // 2 clicks: the title bar's palette button, then the command row.
  const w0 = await wide(left(app));
  await app.getByRole('button', { name: 'Open command palette' }).click();
  await app.locator('.palette [data-command="sidebars.wider"]').click();
  await expect.poll(() => wide(left(app))).toBeGreaterThan(w0);
  // 2 clicks: the ended tab's right-click menu, then Restart session.
  core.windowClose(s); // ticket 1013 F6: the window's own Close keeps the done tab
  await expect(app.locator(`.tab[data-tab="${s}"] .tdot`)).toHaveAttribute('data-s', 'done');
  await app.locator(`.tab[data-tab="${s}"]`).click({ button: 'right' });
  await app.getByRole('menuitem', { name: 'Restart session' }).click();
  await expect(app.locator(`.tab[data-tab="${s}"]`)).toHaveCount(0);
});
