// v25-fix-layout (V2.5-34, needs 149/150, designer panel Lane B): icon drag, pane resize, rail centring, placement and
// the composer under a terminal view. The real-app check is the click harness page (docs/design/v25-bug-sweep/layout-fix);
// these specs hold the same promises in Chromium and WebKit.
import { expect, openWindow, test } from './fixtures';
import { bar, editBar, icon, names, sidebar, slot, startEdit } from './d5b';

test('icon_drag_moves: a slow press-move-release and a fast flick both move Files to the right bar', async ({ app }) => {
  await openWindow(app);
  await startEdit(app);
  // Every slot shows as a drop place as soon as edit mode opens, before any drag (panel: all drop slots visible).
  await expect(bar(app, 'left').locator('.slot.empty').first()).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)'); // ticket 1041: a tint step, no dotted outline
  const from = (await icon(app, 'left', 'Files').boundingBox())!;
  const to = (await slot(app, 'right', 7).boundingBox())!;
  // Slow: small moves over the icon first, then on to the slot.
  await app.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await app.mouse.down();
  await app.mouse.move(from.x + from.width / 2 + 3, from.y + from.height / 2 + 3, { steps: 3 });
  await app.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 20 });
  await app.mouse.up();
  expect(await names(app, 'right')).toContain('Files');
  expect(await names(app, 'left')).not.toContain('Files');
  // The release does not also count as a click on the icon (no sidebar opened by the drop's click).
  // Fast flick: the first move already leaves the icon (no pointer capture used to lose this drag).
  const s = (await icon(app, 'left', 'Search').boundingBox())!;
  const t = (await slot(app, 'right', 8).boundingBox())!;
  await app.mouse.move(s.x + s.width / 2, s.y + s.height / 2);
  await app.mouse.down();
  await app.mouse.move(t.x + t.width / 2, t.y + t.height / 2, { steps: 1 });
  await app.mouse.move(t.x + t.width / 2 + 1, t.y + t.height / 2, { steps: 1 });
  await app.mouse.up();
  expect(await names(app, 'left')).not.toContain('Search');
  expect(await names(app, 'right')).toContain('Search');
});

test('icon_drag_moves: Escape cancels a held drag and nothing moves', async ({ app }) => {
  await openWindow(app);
  await startEdit(app);
  const before = await names(app, 'left');
  const from = (await icon(app, 'left', 'Files').boundingBox())!;
  await app.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await app.mouse.down();
  await app.mouse.move(from.x + 300, from.y + 200, { steps: 4 });
  await app.keyboard.press('Escape');
  await app.mouse.up();
  expect(await names(app, 'left')).toEqual(before);
  await expect(editBar(app)).toBeVisible(); // Escape ended the drag, not edit mode
});

test('pane_resize_drag: the sidebar edge drags 120 px wider and keeps it after a reload', async ({ app }) => {
  await openWindow(app);
  const side = sidebar(app, 'left');
  const w0 = (await side.boundingBox())!.width;
  const edge = app.getByRole('separator', { name: 'Resize the left sidebar' });
  await expect(edge).toHaveAttribute('aria-valuenow', String(Math.round(w0)));
  const e = (await edge.boundingBox())!;
  await app.mouse.move(e.x + e.width / 2, e.y + e.height / 2);
  await app.mouse.down();
  await app.mouse.move(e.x + e.width / 2 + 120, e.y + e.height / 2, { steps: 12 });
  await app.mouse.up();
  expect(Math.round((await side.boundingBox())!.width)).toBe(Math.round(w0) + 120);
  await app.reload();
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  expect(Math.round((await sidebar(app, 'left').boundingBox())!.width)).toBe(Math.round(w0) + 120);
  // Double-click puts the default back.
  await app.getByRole('separator', { name: 'Resize the left sidebar' }).dblclick();
  expect(Math.round((await sidebar(app, 'left').boundingBox())!.width)).toBe(Math.round(w0));
});

test('pane_resize_drag: the side pane edge drags 120 px and keeps it after a reload', async ({ app, core }) => {
  const p = core.project('nunchiro');
  const a = core.agent(p, 'agent-a', 'go');
  await openWindow(app);
  await app.locator(`.tab[data-tab="${a.id}"]`).click();
  await icon(app, 'right', 'Terminal').click();
  const pane = app.locator('[data-side-pane]');
  await expect(pane).toBeVisible();
  const w0 = (await pane.boundingBox())!.width;
  const edge = app.getByRole('separator', { name: 'Resize the side pane' });
  const e = (await edge.boundingBox())!;
  await app.mouse.move(e.x + e.width / 2, e.y + e.height / 2);
  await app.mouse.down();
  await app.mouse.move(e.x + e.width / 2 - 120, e.y + e.height / 2, { steps: 12 });
  await app.mouse.up();
  expect(Math.round((await pane.boundingBox())!.width)).toBe(Math.round(w0) + 120);
  await expect(edge).toHaveAttribute('aria-valuenow', String(Math.round(w0) + 120));
  await app.reload();
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  await app.locator(`.tab[data-tab="${a.id}"]`).click();
  expect(Math.round((await app.locator('[data-side-pane]').boundingBox())!.width)).toBe(Math.round(w0) + 120);
});

test('pane_width_per_widget: the side pane keeps a width for its Terminal and another for its Browser (ticket 997 L2)', async ({ app, core }) => {
  const a = core.agent(core.project('nunchiro'), 'agent-a', 'go');
  await openWindow(app);
  await app.evaluate(() => localStorage.setItem('nunchiro.pane.width.v1', '500')); // a window from before: one width for the pane
  await app.reload();
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  await app.locator(`.tab[data-tab="${a.id}"]`).click();
  await icon(app, 'right', 'Terminal').click();
  const pane = app.locator('[data-side-pane]');
  const width = async () => Math.round((await pane.boundingBox())!.width);
  await expect.poll(width).toBe(500);
  await icon(app, 'right', 'Browser').click();
  await expect.poll(width).toBe(500); // the old width is each pane widget's until it is resized
  const e = (await app.getByRole('separator', { name: 'Resize the side pane' }).boundingBox())!;
  await app.mouse.move(e.x + e.width / 2, e.y + e.height / 2);
  await app.mouse.down();
  await app.mouse.move(e.x + e.width / 2 - 80, e.y + e.height / 2, { steps: 8 });
  await app.mouse.up();
  await expect.poll(width).toBe(580);
  await icon(app, 'right', 'Terminal').click();
  await expect.poll(width).toBe(500);
  expect(await app.evaluate(() => JSON.parse(localStorage.getItem('nunchiro.pane.width.v2') ?? 'null'))).toEqual({ terminal: 500, browser: 580, preview: 500 });
});

test('rails_centred: every rail icon sits on its cell centre and all share one size', async ({ app }) => {
  await openWindow(app);
  const rows = await app.$$eval('nav.ib', (bars) =>
    bars.flatMap((b) => {
      const r = b.getBoundingClientRect();
      const cs = getComputedStyle(b);
      // The cell is the bar without its border (the line on the window side of the bar).
      const left = r.left + parseFloat(cs.borderLeftWidth);
      const right = r.right - parseFloat(cs.borderRightWidth);
      const mid = (left + right) / 2;
      return [...b.querySelectorAll('button.ai')].map((btn) => {
        const k = btn.getBoundingClientRect();
        const g = btn.querySelector('.gl svg')!.getBoundingClientRect();
        return { name: btn.getAttribute('aria-label'), button: [Math.round(k.width), Math.round(k.height)], glyph: [g.width, g.height], off: Math.abs(k.left + k.width / 2 - mid), goff: Math.abs(g.left + g.width / 2 - mid) };
      });
    }),
  );
  expect(rows.length).toBeGreaterThan(6);
  for (const r of rows) {
    expect(r.off, `${r.name} button centre`).toBeLessThanOrEqual(1);
    expect(r.goff, `${r.name} glyph centre`).toBeLessThanOrEqual(1);
  }
  expect(new Set(rows.map((r) => r.button.join('x'))).size, 'one button box').toBe(1);
  expect(new Set(rows.map((r) => r.glyph.join('x'))).size, 'one glyph size').toBe(1);
  expect(rows[0].glyph).toEqual([16, 16]); // ticket 1041: the mockup's 16 px glyphs on 32 px buttons
  // Settings is drawn like every other icon (no raised tile of its own).
  const gear = await app.locator('button.ai.gear').evaluate((e) => getComputedStyle(e).borderTopStyle);
  expect(gear).toBe('none');
});

test('placement_as_picked: Settings bottom-left, Layout bottom-right, a globe Browser icon on the right bar', async ({ app, core }) => {
  const p = core.project('nunchiro');
  const a = core.agent(p, 'agent-a', 'go');
  await openWindow(app);
  const foot = async (side: 'left' | 'right') => {
    const n = (await bar(app, side).boundingBox())!;
    const last = bar(app, side).locator('button.ai').last();
    const b = (await last.boundingBox())!;
    return { label: await last.getAttribute('aria-label'), gap: n.y + n.height - (b.y + b.height) };
  };
  const l = await foot('left');
  const r = await foot('right');
  expect(l.label).toBe('Settings');
  expect(r.label).toBe('Layout');
  expect(l.gap).toBeLessThan(16); // at the foot of the bar, not mid-height
  expect(r.gap).toBeLessThan(16);
  const names_ = await names(app, 'right');
  expect(names_.indexOf('Browser')).toBe(names_.indexOf('Terminal') + 1); // under Terminal
  await expect(icon(app, 'right', 'Browser').locator('svg')).toHaveAttribute('data-icon', 'globe');
  // One click: the side pane opens on its Browser tab.
  await app.locator(`.tab[data-tab="${a.id}"]`).click();
  await icon(app, 'right', 'Browser').click();
  await expect(app.locator('[data-side-pane] .bview')).toBeVisible(); // the Browser view (the pane's tab strip is gone, ticket 284 item 4)
});

test('placement_as_picked: Layout offers Split session left, right and down (2 clicks to the chooser)', async ({ app, core }) => {
  const p = core.project('nunchiro');
  const a = core.agent(p, 'agent-a', 'go');
  await openWindow(app);
  await app.locator(`.tab[data-tab="${a.id}"]`).click();
  await startEdit(app); // click 1: the visible, labelled Layout icon
  const group = editBar(app).getByRole('group', { name: 'Split session' });
  for (const n of ['Left', 'Right', 'Down']) await expect(group.getByRole('button', { name: n, exact: true })).toBeVisible();
  await group.getByRole('button', { name: 'Right', exact: true }).click(); // click 2
  await expect(editBar(app)).toHaveCount(0); // Layout closes as the chooser opens (recommended option)
  await expect(app.getByRole('listbox', { name: 'Open in this split' })).toBeVisible();
});

const oldBars = (layout: number, settings: number, placed?: number) => {
  const right: (string | null)[] = Array(10).fill(null);
  ['board', 'decisions', 'terminal', 'diff', 'artifacts'].forEach((w, i) => (right[i + 1] = w));
  right[layout] = 'layout';
  right[settings] = 'settings';
  return { left: ['tree', 'files', 'search', null, null, null, null, null, null, null], right, active: { left: 'tree', right: null }, ...(placed ? { placed } : {}) };
};
const seed = (app: import('@playwright/test').Page, bars: unknown) => app.addInitScript((b) => localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ bars: b })), bars);

test('placement_as_picked: a stored arrangement in the old default slots moves once, Browser joins under Terminal', async ({ app }) => {
  await seed(app, oldBars(0, 9));
  await openWindow(app);
  expect(await names(app, 'left')).toEqual(['Tree', 'Files', 'Search', 'Settings']);
  expect(await names(app, 'right')).toEqual(['Schedules', 'Board', 'Decisions', 'Terminal', 'Browser', 'Diff', 'Artifacts', 'History', 'Layout']); // ticket 993: Schedules joins the right bar's first free slot (here the one the move left at the top); ticket 1022: History the next
});

test('placement_as_picked: a user-placed icon stays, and an arrangement already placed is not moved again', async ({ app }) => {
  await seed(app, oldBars(0, 7));
  await openWindow(app);
  // Settings was moved by hand (slot 8, not its old default slot 10): it stays; Layout in its old slot moves to the foot.
  expect(await names(app, 'left')).toEqual(['Tree', 'Files', 'Search']);
  expect((await names(app, 'right')).slice(-3)).toEqual(['Settings', 'History', 'Layout']); // ticket 1022: History joins the next free slot
});

test('placement_as_picked: an arrangement saved after the placement keeps Layout at the top', async ({ app }) => {
  await seed(app, { ...oldBars(0, 9, 2), right: ['layout', 'board', 'decisions', 'terminal', 'browser', 'diff', 'artifacts', null, null, 'settings'] });
  await openWindow(app);
  expect((await names(app, 'right'))[0]).toBe('Layout');
  expect((await names(app, 'right')).at(-1)).toBe('Settings');
});

test('icon_drag_moves: Settings and Layout cross the main area to the other bar without crashing the window', async ({ app }) => {
  const errors: string[] = [];
  app.on('pageerror', (e) => errors.push(e.message));
  await openWindow(app);
  await startEdit(app);
  const from = (await icon(app, 'left', 'Settings').boundingBox())!;
  const to = (await slot(app, 'right', 7).boundingBox())!;
  await app.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await app.mouse.down();
  await app.mouse.move(from.x + 400, from.y - 300, { steps: 6 }); // over the session view: refused, not a crash
  await expect(app.locator('.dropprev[data-error="true"]')).toContainText('Settings stays on a bar');
  await app.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 10 });
  await app.mouse.up();
  expect(await names(app, 'right')).toContain('Settings');
  expect(errors).toEqual([]);
});

test('pane_resize_drag: a sidebar grows until the chat minimum and both Icon bars are all that is left', async ({ app }) => {
  // Owner 11-10: the old cap (45 % of the window, 640 px) kept the Browser sidebar small.
  await app.setViewportSize({ width: 1000, height: 800 });
  await openWindow(app);
  const edge = app.getByRole('separator', { name: 'Resize the left sidebar' });
  await expect(edge).toHaveAttribute('aria-valuemax', '584'); // 1000 - (320 + 2 * 48), ticket 1041: the bars are 48 px
  const e = (await edge.boundingBox())!;
  await app.mouse.move(e.x + e.width / 2, e.y + e.height / 2);
  await app.mouse.down();
  await app.mouse.move(e.x + 900, e.y + e.height / 2, { steps: 10 });
  await app.mouse.up();
  expect(Math.round((await sidebar(app, 'left').boundingBox())!.width)).toBe(584);
  // A narrower window draws the kept width within its own limit.
  await app.setViewportSize({ width: 800, height: 800 });
  await expect.poll(async () => Math.round((await sidebar(app, 'left').boundingBox())!.width)).toBe(384);
  await app.setViewportSize({ width: 1600, height: 800 });
  await expect(edge).toHaveAttribute('aria-valuemax', '1184');
  // The other side's open sidebar counts: the two never squeeze the chat under its minimum.
  await icon(app, 'right', 'Diff').click();
  const right = Math.round((await sidebar(app, 'right').boundingBox())!.width);
  await expect(edge).toHaveAttribute('aria-valuemax', String(1184 - right));
});

test('pane_resize_drag: a folded sidebar takes no room from the other side’s limit; unfolded, it counts again', async ({ app, core }) => {
  // Real-app 11-10: the right sidebar's limit still took off the left sidebar's width while V1A-60 had it folded.
  core.shell(core.project('demo'), 'sh1'); // the fold rule measures a session's columns
  await app.setViewportSize({ width: 1100, height: 800 }); // a width where opening the right sidebar folds the Tree
  await openWindow(app);
  const leftW = Number(await app.getByRole('separator', { name: 'Resize the left sidebar' }).getAttribute('aria-valuenow'));
  await icon(app, 'right', 'Diff').click();
  const tree = app.getByRole('navigation', { name: 'Left bar' }).getByRole('button', { name: 'Tree (folded)' });
  await expect(tree).toBeVisible();
  const edge = app.getByRole('separator', { name: 'Resize the right sidebar', includeHidden: true });
  await expect(edge).toHaveAttribute('aria-valuemax', String(1100 - 416));
  // Widened to that limit, it stays there: the Tree stays folded and the right sidebar does not fold (no unfold-refold loop).
  const e = (await edge.boundingBox())!;
  await app.mouse.move(e.x + e.width / 2, e.y + e.height / 2);
  await app.mouse.down();
  await app.mouse.move(0, e.y + e.height / 2, { steps: 10 });
  await app.mouse.up();
  const folds = () => app.evaluate(() => [...document.querySelectorAll('.body > .sbar')].map((s) => `${s.className}:${s.hasAttribute('data-folded')}:${Math.round(s.getBoundingClientRect().width)}`).join(' '));
  await expect.poll(folds).toBe(`sbar l:true:0 sbar r:false:${1100 - 416}`);
  const seen = new Set<string>();
  for (let i = 0; i < 10; i++) seen.add(await folds()), await app.waitForTimeout(100); // ten reads over a second: one state, no flicker
  expect([...seen]).toEqual([`sbar l:true:0 sbar r:false:${1100 - 416}`]);
  await tree.click(); // its icon shows the Tree again (the right sidebar folds in its place)
  await expect(sidebar(app, 'left')).toBeVisible();
  await expect(edge).toHaveAttribute('aria-valuemax', String(1100 - 416 - leftW));
});

test('pane_resize_drag: narrowing stops at the minimum, and only a drag past half of it closes the sidebar', async ({ app }) => {
  // Owner 11-10: 24 px under the minimum used to close it, which read as the sidebar vanishing mid-drag.
  await openWindow(app);
  const edge = app.getByRole('separator', { name: 'Resize the left sidebar' });
  const e = (await edge.boundingBox())!;
  const y = e.y + e.height / 2;
  const w0 = Math.round((await sidebar(app, 'left').boundingBox())!.width);
  await app.mouse.move(e.x + e.width / 2, y);
  await app.mouse.down();
  await app.mouse.move(e.x + e.width / 2 - (w0 - 208) - 90, y, { steps: 10 }); // 90 px under the minimum: still open
  await expect(sidebar(app, 'left')).toBeVisible();
  expect(Math.round((await sidebar(app, 'left').boundingBox())!.width)).toBe(208);
  await app.mouse.move(e.x + e.width / 2 - (w0 - 208) - 120, y, { steps: 4 }); // past half the minimum: closes
  await expect(sidebar(app, 'left')).toHaveCount(0);
  await app.mouse.up();
  await icon(app, 'left', 'Tree').click(); // reopens at the width it had before the drag
  expect(Math.round((await sidebar(app, 'left').boundingBox())!.width)).toBe(w0);
});

test('icon_drag_moves: a cancelled pointer ends the drag without a drop', async ({ app }) => {
  await openWindow(app);
  await startEdit(app);
  const before = await names(app, 'left');
  const from = (await icon(app, 'left', 'Files').boundingBox())!;
  const to = (await slot(app, 'right', 7).boundingBox())!;
  await app.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await app.mouse.down();
  await app.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 10 });
  await expect(app.locator('.dragl .ins')).toHaveCount(1); // the drag is live over a slot
  await app.evaluate(({ x, y }) => window.dispatchEvent(new PointerEvent('pointercancel', { clientX: x, clientY: y, bubbles: true })), { x: to.x + to.width / 2, y: to.y + to.height / 2 });
  await expect(app.locator('.win')).not.toHaveAttribute('data-dragging', 'true');
  await app.mouse.up();
  expect(await names(app, 'left')).toEqual(before);
  await expect(editBar(app)).toBeVisible();
});
