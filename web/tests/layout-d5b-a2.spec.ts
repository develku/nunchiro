// LAYOUT D5b lane A, part 2 (snap grid, approval, presets, undo, keyboard, title bar, persistence): A20-A38.
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { builtIn } from '../src/layout/presets';
import { expect, openWindow, test } from './fixtures';
import { openQuiet } from './tree-seed';
import { at, bar, barBefore, barEnd, card, drag, slot, editBar, endEdit, icon, layoutButton, lib, names, pageErrors, readLayout, sidebar, startEdit, stored, toast, unapproved, zones, layoutCli } from './d5b';

const KEY = 'nunchiro.settings.v1';
const seed = (page: Page, patch: Record<string, unknown>) => page.addInitScript(([k, p]) => (localStorage.getItem(k as string) ?? localStorage.setItem(k as string, JSON.stringify(p))), [KEY, patch] as const);
const palette = async (page: Page, text: string) => {
  const input = page.locator('.palette input');
  // The key binding is live a moment after the window connects: press until the palette is there.
  await expect(async () => {
    if (!(await input.isVisible())) await page.keyboard.press('Meta+k');
    await expect(input).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 10_000 });
  await input.fill(text);
};
const run = async (page: Page, text: string) => {
  await palette(page, text);
  await page.keyboard.press('Enter');
};
const presets = (page: Page) => editBar(page).getByRole('button', { name: /^Presets/ });
const menu = (page: Page) => page.getByRole('menu', { name: 'Presets' });
// Ticket 162 (needs 146) replaced A20's snap grid with one landing area shown only while a widget is dragged.
const grid = async (page: Page) => ({ grids: await page.locator('.layout .snapgrid').count(), landing: await page.locator('.dropprev').count() });
const titleRadio = (page: Page, v: 'always' | 'auto' | 'hidden') => page.locator(`input[name="titlebar"][value="${v}"]`);
const items = async (page: Page) => (await menu(page).getByRole('menuitemradio').allInnerTexts()).map((t) => t.replace('✓', '').trim());

test('layout_a20_snap_grid', async ({ app, core }) => {
  await openWindow(app);
  expect(await grid(app)).toEqual({ grids: 0, landing: 0 });
  await startEdit(app);
  expect(await grid(app)).toEqual({ grids: 0, landing: 0 });
  await drag(app, card(app, 'files'), await at(app, 'terminal', 0.5, 0.5), { release: false });
  expect(await grid(app)).toEqual({ grids: 0, landing: 1 });
  await app.keyboard.press('Escape');
  await app.mouse.up();
  expect(await grid(app)).toEqual({ grids: 0, landing: 0 });
  // A divider drag shows only the divider moving (a row split gives a divider with a width).
  await layoutCli(app, core, 'split right board --zone terminal');
  const gutter = app.locator('.gutter[data-split="row"]').first();
  const b = (await gutter.boundingBox())!;
  await app.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await app.mouse.down();
  await app.mouse.move(b.x + b.width / 2 - 40, b.y + b.height / 2, { steps: 4 });
  await expect(app.locator('.layout')).toHaveAttribute('data-resizing', 'true');
  expect(await grid(app)).toEqual({ grids: 0, landing: 0 });
  await app.mouse.up();
  expect(await grid(app)).toEqual({ grids: 0, landing: 0 });
});

test('layout_a21_approval_badge_opens_sheet', async ({ app, core }) => {
  unapproved(core, 'alpha-feed');
  await openWindow(app);
  await startEdit(app);
  await card(app, 'widget:alpha-feed').getByRole('button', { name: 'Needs approval' }).click();
  const sheet = app.getByRole('dialog', { name: /Allow “alpha-feed”/ });
  await expect(sheet).toBeVisible();
  await expect(sheet.locator('li').first()).toBeVisible(); // the permission list, from the core's parsed manifest
  await sheet.getByRole('button', { name: 'Cancel' }).click(); // the existing sheet's own button
  await expect(sheet).toBeHidden();
  await card(app, 'widget:alpha-feed').getByRole('button', { name: 'Needs approval' }).click();
  await expect(sheet).toBeVisible();
  await app.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  await expect(editBar(app)).toBeVisible(); // Esc closed the sheet only
});

test('layout_a22_unapproved_not_placeable', async ({ app, core }) => {
  unapproved(core, 'alpha-feed', 'beta-feed');
  await openWindow(app);
  await startEdit(app);
  const grip = card(app, 'widget:alpha-feed').locator('.tx'); // not the badge
  await grip.scrollIntoViewIfNeeded(); // the list scrolls: user widgets follow the built-in ones
  await drag(app, grip, await barEnd(app, 'left'));
  expect(await names(app, 'left')).toEqual(['Tree', 'Files', 'Search', 'Settings']);
  await expect(toast(app)).toContainText('needs approval');
  await drag(app, grip, await at(app, 'terminal', 0.92, 0.5));
  expect(await zones(app)).toEqual(['terminal', 'composer']);
  // Approve through the sheet; the card can then be placed and the pending count drops.
  await card(app, 'widget:alpha-feed').getByRole('button', { name: 'Needs approval' }).click();
  await app.getByRole('button', { name: 'Allow read only' }).click();
  await expect(card(app, 'widget:alpha-feed').getByRole('button', { name: 'Needs approval' })).toHaveCount(0);
  await expect(lib(app).getByRole('button', { name: /My widgets/ })).toContainText('1 to approve');
  await drag(app, grip, await barEnd(app, 'left'));
  expect(await names(app, 'left')).toEqual(['Tree', 'Files', 'Search', 'alpha-feed', 'Settings']);
});

test('layout_a23_presets_load', async ({ app }) => {
  await openWindow(app);
  await startEdit(app);
  await presets(app).click();
  expect(await items(app)).toEqual(['Default', 'Review', 'Focus']);
  await expect(menu(app).getByRole('menuitemradio', { name: 'Default' })).toHaveAttribute('aria-checked', 'true');
  await menu(app).getByRole('menuitemradio', { name: 'Review' }).click();
  expect(await zones(app)).toEqual(['terminal', 'composer', 'diff']);
  const review = builtIn('Review')!;
  expect(await names(app, 'right')).toEqual(review.bars.right.filter((w): w is string => !!w).map((w) => w[0].toUpperCase() + w.slice(1)));
  await expect(sidebar(app, 'right')).toHaveCount(0); // Preview is not on a bar (AGENTVIEW); Review brings the Diff zone
  await presets(app).click();
  await expect(menu(app).getByRole('menuitemradio', { name: 'Review' })).toHaveAttribute('aria-checked', 'true');
  await menu(app).getByRole('menuitemradio', { name: 'Focus' }).click();
  await expect(sidebar(app, 'left')).toHaveCount(0);
  await expect(sidebar(app, 'right')).toHaveCount(0);
  expect(await zones(app)).toEqual(['terminal', 'composer']);
});

test('layout_a24_presets_dirty_save_as', async ({ app }) => {
  await openWindow(app);
  await startEdit(app);
  await presets(app).click();
  await expect(menu(app).getByRole('menuitem', { name: 'Save', exact: true })).toBeDisabled();
  await app.keyboard.press('Escape');
  await drag(app, icon(app, 'left', 'Files'), await barEnd(app, 'left'));
  await expect(presets(app).getByRole('img', { name: 'changed since loaded' })).toBeVisible();
  await presets(app).click();
  await expect(menu(app).getByRole('menuitem', { name: 'Save', exact: true })).toBeEnabled();
  await menu(app).getByRole('menuitem', { name: 'Save as…' }).click();
  await menu(app).getByRole('textbox', { name: 'Preset name' }).fill('mine');
  await menu(app).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(presets(app)).toContainText('mine');
  await expect(presets(app).getByRole('img', { name: 'changed since loaded' })).toHaveCount(0);
  const mine = await names(app, 'left');
  await drag(app, icon(app, 'left', 'Search'), await barBefore(app, 'left', 0));
  expect(await names(app, 'left')).not.toEqual(mine);
  await app.reload();
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  await startEdit(app);
  await presets(app).click();
  expect(await items(app)).toEqual(['Default', 'Review', 'Focus', 'mine']);
  await menu(app).getByRole('menuitemradio', { name: 'mine' }).click();
  expect(await names(app, 'left')).toEqual(mine);
});

test('layout_a26_reset_default', async ({ app, core }) => {
  await openWindow(app);
  await startEdit(app);
  await drag(app, icon(app, 'left', 'Files'), await barEnd(app, 'right'));
  await layoutCli(app, core, 'split right board --zone terminal');
  expect(await zones(app)).toContain('board');
  await editBar(app).getByRole('button', { name: 'Default', exact: true }).click();
  expect(await names(app, 'left')).toEqual(['Tree', 'Files', 'Search', 'Settings']);
  expect(await names(app, 'right')).toEqual(['Board', 'Decisions', 'Terminal', 'Browser', 'Diff', 'Artifacts', 'History', 'Layout']); // ticket 1073: History is placed
  expect(await zones(app)).toEqual(['terminal', 'composer']);
  await toast(app).getByRole('button', { name: 'Undo' }).click();
  expect(await names(app, 'right')).toContain('Files');
  expect(await zones(app)).toContain('board');
});

test('layout_a27_undo_toast_and_keys', async ({ app }) => {
  await openWindow(app);
  await startEdit(app);
  await drag(app, icon(app, 'left', 'Files'), await barEnd(app, 'left'));
  await expect(toast(app)).toContainText('Files moved to the left bar');
  await expect(toast(app).getByRole('button', { name: 'Undo' })).toBeVisible();
  await expect(toast(app).locator('kbd')).toHaveText('⌘Z');
  // needs 153: the zone step is a library drop now (no typed line); its toast names it in plain words.
  await drag(app, card(app, 'board'), await at(app, 'terminal', 0.9, 0.5));
  await expect(toast(app)).toContainText('Board moved to the main area');
  await expect(toast(app)).not.toContainText(':');
  await app.locator('.estrip .etitle').click(); // focus in the window, outside any field
  await app.keyboard.press('Meta+z');
  expect(await zones(app)).toEqual(['terminal', 'composer']);
  expect(await names(app, 'left')).toEqual(['Tree', 'Search', 'Files', 'Settings']);
  await app.keyboard.press('Control+z');
  expect(await names(app, 'left')).toEqual(['Tree', 'Files', 'Search', 'Settings']);
  // Zone changes and a preset load are steps too.
  await presets(app).click();
  await menu(app).getByRole('menuitemradio', { name: 'Review' }).click();
  await expect(toast(app)).toContainText('Loaded preset Review');
  await toast(app).getByRole('button', { name: 'Undo' }).click();
  expect(await zones(app)).toEqual(['terminal', 'composer']);
});

test('layout_a28_esc_cancel_and_noop', async ({ app }) => {
  await openWindow(app);
  await startEdit(app);
  await drag(app, icon(app, 'left', 'Files'), await barEnd(app, 'right'), { release: false });
  await expect(app.locator('.dragl .ins')).toHaveCount(1);
  await app.keyboard.press('Escape');
  await expect(app.locator('.dragl')).toHaveCount(0);
  await app.mouse.up();
  expect(await names(app, 'left')).toEqual(['Tree', 'Files', 'Search', 'Settings']);
  await expect(editBar(app)).toBeVisible(); // Esc cancelled the drag only
  await drag(app, card(app, 'files'), await at(app, 'terminal', 0.5, 0.5), { release: false });
  await app.keyboard.press('Escape');
  await expect(app.locator('.compass')).toHaveCount(0);
  await app.mouse.up();
  expect(await zones(app)).toEqual(['terminal', 'composer']);
  // Dropping an icon on its own place is not a step.
  await drag(app, icon(app, 'left', 'Files'), await barBefore(app, 'left', 1));
  await expect(toast(app)).toHaveCount(0);
  await expect(editBar(app).getByRole('button', { name: /^Undo/ })).toBeDisabled();
  await expect(presets(app).getByRole('img', { name: 'changed since loaded' })).toHaveCount(0);
});

test('layout_a29_keyboard_move', async ({ app }) => {
  await openWindow(app);
  await startEdit(app);
  await icon(app, 'left', 'Files').focus();
  await app.keyboard.press('Alt+ArrowDown');
  expect(await names(app, 'left')).toEqual(['Tree', 'Search', 'Files', 'Settings']);
  await expect(toast(app).getByRole('button', { name: 'Undo' })).toBeVisible();
  await expect(icon(app, 'left', 'Files')).toBeFocused();
  // Alt+Right: the same slot of the right bar; Terminal was there (v25 placement), so the two swap.
  await app.keyboard.press('Alt+ArrowRight');
  expect(await names(app, 'right')).toEqual(['Board', 'Decisions', 'Files', 'Browser', 'Diff', 'Artifacts', 'History', 'Layout']);
  expect(await names(app, 'left')).toEqual(['Tree', 'Search', 'Terminal', 'Settings']);
  await expect(icon(app, 'right', 'Files')).toBeFocused();
  await app.keyboard.press('Alt+ArrowUp');
  expect(await names(app, 'right')).toEqual(['Board', 'Files', 'Decisions', 'Browser', 'Diff', 'Artifacts', 'History', 'Layout']);
  await expect(icon(app, 'right', 'Files')).toBeFocused(); // the focus follows the icon to its new slot
  await app.keyboard.press('Delete');
  expect(await names(app, 'right')).toEqual(['Board', 'Decisions', 'Browser', 'Diff', 'Artifacts', 'History', 'Layout']);
  await icon(app, 'left', 'Tree').focus();
  await app.keyboard.press('Delete');
  expect(await names(app, 'left')).toContain('Tree');
  await expect(toast(app)).toContainText('Tree is required');
  // Enter on a library card adds it to the first free slot of the left bar.
  await card(app, 'files').focus();
  await app.keyboard.press('Enter');
  expect(await names(app, 'left')).toEqual(['Tree', 'Search', 'Terminal', 'Files', 'Settings']);
});

test('layout_a30_title_bar_setting', async ({ app }) => {
  await openWindow(app);
  await app.getByRole('button', { name: 'Settings' }).click();
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Appearance' }).click(); // v25-fix-settings: Settings opens on General; the title bar is on Appearance
  await expect(app.getByRole('radio', { name: 'Always shown' })).toBeChecked();
  await expect(app.getByRole('radio', { name: 'Auto-hide' })).not.toBeChecked();
  await titleRadio(app, 'auto').focus(); // elsewhere first
  await run(app, 'Settings: Title bar');
  await expect(app.locator('input[name="titlebar"]:checked')).toBeFocused();
});

test('layout_a31_auto_hide', async ({ app }) => {
  await seed(app, { titleBar: 'auto' });
  await openWindow(app);
  await expect(app.locator('header.title')).toBeHidden();
  await app.mouse.move(700, 2);
  await expect(app.locator('header.title')).toBeVisible();
  await app.mouse.move(700, 400);
  await expect(app.locator('header.title')).toBeHidden();
  // Open the palette on the revealed bar: the bar stays while it is open.
  await app.mouse.move(700, 2);
  await app.keyboard.press('Meta+k');
  await app.mouse.move(700, 500);
  await expect(app.locator('header.title')).toBeVisible();
});

test('layout_a32_hidden_one_time_hint', async ({ app }) => {
  await openWindow(app);
  await app.getByRole('button', { name: 'Settings' }).click();
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Appearance' }).click(); // v25-fix-settings: Settings opens on General; the title bar is on Appearance
  await titleRadio(app, 'hidden').check();
  await expect(app.locator('header.title')).toHaveCount(0);
  await expect(app.locator('.titlehint')).toContainText('Title bar hidden');
  await expect(app.locator('.titlehint .kbd')).toBeVisible();
  await expect(app.locator('.titlehint')).toContainText('Show title bar');
  await titleRadio(app, 'always').check();
  await expect(app.locator('.titlehint')).toHaveCount(0);
  await titleRadio(app, 'hidden').check();
  await expect(app.locator('.titlehint')).toHaveCount(0); // it does not come back
  await app.reload();
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  await expect(app.locator('header.title')).toHaveCount(0);
  await expect(app.locator('.titlehint')).toHaveCount(0);
});

// v25f-title-hidden: Hidden also hides the traffic lights (the app's `window_buttons`), the tab row drags the window and
// the edit bar leaves no gap for the lights; the other two keep them. The app's bridge is faked and every call recorded.
test('layout_a32_hidden_window_buttons', async ({ app }) => {
  await app.addInitScript(() => {
    const w = window as unknown as { __calls: [string, unknown][]; __TAURI_INTERNALS__: unknown };
    w.__calls = [];
    w.__TAURI_INTERNALS__ = { invoke: (cmd: string, args: unknown) => (w.__calls.push([cmd, args]), Promise.resolve(null)), transformCallback: () => 1, metadata: {} };
  });
  const last = () => app.evaluate(() => (window as unknown as { __calls: [string, { shown: boolean }][] }).__calls.filter((c) => c[0] === 'window_buttons').at(-1)?.[1].shown);
  await openWindow(app);
  await expect.poll(last).toBe(true);
  await app.getByRole('button', { name: 'Settings' }).click();
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Appearance' }).click();
  await titleRadio(app, 'hidden').check();
  await expect.poll(last).toBe(false);
  await expect(app.locator('.zh').first()).toHaveAttribute('data-tauri-drag-region', 'deep');
  await app.getByRole('button', { name: 'Close Settings' }).click(); // Settings is a modal: what sits behind it cannot be clicked
  await startEdit(app);
  expect(await editBar(app).evaluate((e) => getComputedStyle(e).paddingLeft)).toBe('10px');
  await endEdit(app);
  await app.getByRole('button', { name: 'Settings' }).click();
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Appearance' }).click();
  for (const mode of ['auto', 'always'] as const) {
    await titleRadio(app, mode).check();
    await expect.poll(last).toBe(true);
    await expect(app.locator('.zh').first()).not.toHaveAttribute('data-tauri-drag-region');
  }
});

for (const mode of ['always', 'auto', 'hidden'] as const)
  test(`layout_a33_palette_always_offers (${mode})`, async ({ app }) => {
    await seed(app, { titleBar: mode, titleHint: true });
    await openWindow(app);
    await palette(app, 'Edit layout');
    await expect(app.locator('.palette li', { hasText: 'Edit layout' })).toBeVisible();
    await app.locator('.palette input').fill('Show title bar');
    await expect(app.locator('.palette li', { hasText: 'Show title bar' })).toBeVisible();
    await app.locator('.palette input').fill('Edit layout');
    await app.keyboard.press('Enter');
    await expect(editBar(app)).toBeVisible();
    await endEdit(app);
    await run(app, 'Show title bar');
    await expect(app.locator('header.title')).toBeVisible();
    expect((await stored(app)).titleBar).toBe('always');
  });

test('layout_a34_persistence', async ({ app }) => {
  await openWindow(app);
  await startEdit(app);
  await drag(app, icon(app, 'left', 'Files'), await barEnd(app, 'right'));
  await drag(app, icon(app, 'left', 'Search'), await barBefore(app, 'right', 0));
  await endEdit(app);
  await icon(app, 'left', 'Tree').click(); // collapse the left sidebar
  await app.getByRole('button', { name: 'Settings' }).click();
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Appearance' }).click(); // v25-fix-settings: Settings opens on General; the title bar is on Appearance
  await titleRadio(app, 'hidden').check();
  const before = { left: await names(app, 'left'), right: await names(app, 'right') };
  await app.reload();
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  expect({ left: await names(app, 'left'), right: await names(app, 'right') }).toEqual(before);
  await expect(sidebar(app, 'left')).toHaveCount(0);
  await expect(sidebar(app, 'right').locator('.sbh b')).toHaveText('Search'); // the last one opened
  await expect(app.locator('header.title')).toHaveCount(0);
  // A broken stored value falls back to the default, without a page error.
  const errors = pageErrors(app);
  await app.evaluate((k) => localStorage.setItem(k, JSON.stringify({ bars: { left: 5, right: ['files', 'files'], active: {} }, titleBar: 'sideways', presets: [{ name: 3 }] })), KEY);
  await app.reload();
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  expect(await names(app, 'left')).toEqual(['Tree', 'Files', 'Search', 'Settings']);
  expect(await names(app, 'right')).toEqual(['Board', 'Decisions', 'Terminal', 'Browser', 'Diff', 'Artifacts', 'History', 'Schedules', 'Layout']); // ticket 1073: History placed after Artifacts, Schedules after it; ticket 993: Schedules joins the right bar's next free slot (outside Layout edit)
  await expect(app.locator('header.title')).toBeVisible();
  expect(errors).toEqual([]);
});

// needs 153 (owner 2026-10-31) replaced A35's window command line: no ':' field, no ':' key, no drag echo, no palette entry;
// the same words still drive `nunchiro layout` through the window.
test('layout_a35_no_command_line_cli_kept', async ({ app, core }) => {
  await openWindow(app);
  await startEdit(app);
  await expect(editBar(app).getByRole('combobox')).toHaveCount(0);
  await expect(editBar(app)).not.toContainText(':split');
  await app.locator('.estrip .etitle').click();
  await app.keyboard.press('Shift+Semicolon');
  await expect(app.locator('input[aria-label="Layout command"]')).toHaveCount(0);
  await layoutCli(app, core, 'split right board --zone terminal');
  await expect.poll(() => zones(app)).toEqual(['terminal', 'board', 'composer']);
  await endEdit(app);
  await expect.poll(() => readLayout(core)).toContain('widgets = ["board"]');
});

test('layout_a36_seam_no_project_targets', async ({ app, core }) => {
  // Lane B extended the seam (TARGETS) with project rows: a widget over a row now highlights it and a drop nests it;
  // the main zones are untouched either way.
  const p = core.project('nunchiro');
  core.shell(p, 'one');
  openQuiet(core, 'nunchiro');
  await openWindow(app);
  await startEdit(app);
  const row = app.locator('.sbar .tree .row.head[data-project-path]').first();
  await expect(row).toBeVisible();
  const before = JSON.stringify(await stored(app));
  await drag(app, card(app, 'context'), row, { release: false });
  await expect(app.locator('.dropprev')).toHaveCount(1);
  await expect(app.locator('.tree [data-hot]')).toHaveCount(1);
  await app.mouse.up();
  expect(JSON.stringify(await stored(app))).not.toBe(before);
  expect((await stored(app)).bars.nest).toEqual({ [p]: ['context'] });
  expect(await zones(app)).toEqual(['terminal', 'composer']);
});

// V2.5-41 (lane v25-layout-flakes): the widget list's note pushes the cards down when the list arrives, so a drag aimed
// before then grabbed the card above (b06 nested Files for Board, a36 grabbed Tree for Agents). The library says it is busy
// until the list is in, and startEdit waits for that.
test('library_busy_until_widget_list', async ({ app }) => {
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const ids = new Set<number>();
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => {
      if (typeof m === 'string' && m.includes('"widget_list"')) ids.add(JSON.parse(m).id);
      server.send(m);
    });
    server.onMessage((m) => (typeof m === 'string' && ids.has(JSON.parse(m).id) ? void held.then(() => ws.send(m)) : ws.send(m)));
  });
  await openWindow(app);
  await layoutButton(app).click();
  await expect(lib(app)).toHaveAttribute('aria-busy', 'true');
  release();
  await expect(lib(app)).not.toHaveAttribute('aria-busy', /.*/);
  await expect(lib(app).locator('.lnote')).toBeVisible(); // the note that moves the cards is in before the busy mark goes
});

test('layout_a37_two_clicks', async ({ app }) => {
  await openWindow(app);
  await layoutButton(app).click(); // Layout: 1
  await expect(editBar(app)).toBeVisible();
  await expect(lib(app)).toBeVisible(); // the library: the same click
  await endEdit(app);
  await icon(app, 'left', 'Files').click(); // a bar widget: 1
  await expect(sidebar(app, 'left').locator('.sbh b')).toHaveText('Files');
  await app.getByRole('button', { name: 'Settings' }).click();
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Appearance' }).click(); // v25-fix-settings: Settings opens on General; the title bar is on Appearance // Title bar setting: 1 (gear) + Appearance
  await expect(app.getByRole('radio', { name: 'Always shown' })).toBeVisible();
});

for (const scheme of ['light', 'dark'] as const)
  test(`layout_a38_themes_axe_no_errors (${scheme})`, async ({ app, core }) => {
    unapproved(core, 'alpha-feed');
    const errors = pageErrors(app);
    await app.emulateMedia({ colorScheme: scheme });
    await openWindow(app);
    const axe = async (what: string, include: string | string[]) => {
      // needs 212 (themes as written) + ticket 250 r3: a theme card's preview shows that theme's own palette (incidental text,
      // WCAG 1.4.3), now in view on the compact Appearance page; the rest of Settings is still checked.
      const b = new AxeBuilder({ page: app }).exclude('.tw');
      for (const i of [include].flat()) b.include(i);
      const r = await b.analyze();
      expect(r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${what}: ${v.id}: ${v.help} ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);
    };
    const shell = ['nav.ib', 'aside.sbar'];
    await axe('bars and sidebars', shell);
    await startEdit(app);
    await axe('edit mode with library', [...shell, '.lib']);
    await axe('edit bar', '.estrip');
    await card(app, 'widget:alpha-feed').getByRole('button', { name: 'Needs approval' }).click();
    await expect(app.getByRole('dialog')).toBeVisible();
    await axe('approval sheet', '.ps');
    await app.keyboard.press('Escape');
    await endEdit(app);
    await app.getByRole('button', { name: 'Settings' }).click();
    await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Appearance' }).click(); // v25-fix-settings: Settings opens on General; the title bar is on Appearance
    await expect(app.getByRole('radio', { name: 'Always shown' })).toBeVisible();
    await axe('Appearance page', '.sbody');
    expect(errors).toEqual([]);
  });

// ICONBAR (owner decision): the bars are columns of icon-size slots, like a phone's home screen.
test('layout_a39_slots_empty_swap_dotted_persist_overflow', async ({ app }) => {
  await openWindow(app);
  await startEdit(app);
  // An icon goes into any slot; empty slots stay empty.
  await drag(app, icon(app, 'left', 'Search'), await barBefore(app, 'left', 7));
  await expect(slot(app, 'left', 7).locator('.ai')).toHaveAccessibleName('Search');
  await expect(slot(app, 'left', 2)).toHaveClass(/empty/);
  // An occupied slot swaps.
  await drag(app, icon(app, 'left', 'Files'), await barBefore(app, 'left', 7));
  await expect(slot(app, 'left', 7).locator('.ai')).toHaveAccessibleName('Files');
  await expect(slot(app, 'left', 1).locator('.ai')).toHaveAccessibleName('Search');
  // Every drop place shows in edit mode, before and while an icon is held (v25 panel, Lane B); ticket 1041: as a tint step.
  const tinted = async () => expect(slot(app, 'left', 5)).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await tinted();
  await drag(app, icon(app, 'left', 'Tree'), await barBefore(app, 'left', 5), { release: false });
  await tinted();
  await app.keyboard.press('Escape');
  await app.mouse.up();
  await tinted();
  // Settings and Layout move like the others.
  await drag(app, icon(app, 'left', 'Settings'), await barBefore(app, 'right', 8));
  await expect(slot(app, 'right', 8).locator('.gear')).toHaveCount(1);
  await endEdit(app);
  // Slot positions persist.
  await app.reload();
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  await expect(slot(app, 'left', 7).locator('.ai')).toHaveAccessibleName('Files');
  await expect(slot(app, 'right', 8).locator('.gear')).toHaveCount(1);
  // A short window cuts the lower slots off: their icons go behind ⋯.
  await app.setViewportSize({ width: 1440, height: 340 }); // ticket 1041: 36 px slots, so a shorter window than before
  const more = bar(app, 'left').getByRole('button', { name: /more icons/ });
  await expect(more).toBeVisible();
  await expect(bar(app, 'left').locator('.ai[aria-label="Files"]')).toHaveCount(0);
  await more.click();
  const item = app.getByRole('menu', { name: 'More icons' }).getByRole('menuitem', { name: 'Files' });
  await expect(item).toBeVisible();
  const before = await sidebar(app, 'left').count();
  await item.click(); // it acts like the icon: Files opens or collapses its sidebar
  await expect(sidebar(app, 'left')).toHaveCount(before ? 0 : 1);
});
