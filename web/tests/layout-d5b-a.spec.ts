// LAYOUT D5b lane A (icon bars, sidebars, edit mode, library): promises A01-A19. Every test runs a real core with
// its own NUNCHIRO_HOME under .scratch. UI text is English; the mockup's Korean names are in the promises file.
import fs from 'node:fs';
import { ENTRIES } from '../src/layout/registry';
import { defaultLayout } from '../src/layout/model';
import { expect, openWindow, test, type Core } from './fixtures';
import { mates } from './leader-990';
import { at, bar, barBefore, barEnd, card, drag, slot, editBar, endEdit, icon, layoutButton, layoutFile, lib, names, pageErrors, readLayout, sidebar, startEdit, stored, toast, unapproved, zone, zones } from './d5b';

/** The pre-D5b default layout.toml (the tree was a zone). */
const OLD_DEFAULT = `version = 1
locked = false

[root]
id = "main"
split = "row"

[[root.children]]
id = "left"
size = 256
split = "column"

[[root.children.children]]
id = "tree"
widgets = ["tree"]

[[root.children.children]]
id = "agents"
size = 190
widgets = ["agents"]

[[root.children]]
id = "centre"
split = "column"

[[root.children.children]]
id = "terminal"
widgets = ["terminal"]

[[root.children.children]]
id = "waiting"
widgets = ["waiting"]

[[root.children.children]]
id = "composer"
widgets = ["composer"]
`;

test('layout_a01_default_bars', async ({ app }) => {
  await openWindow(app);
  // ICONBAR: slots; Settings and Layout are icons like the rest, at the feet of the two bars (v25 placement, owner 2026-10-31).
  expect(await names(app, 'left')).toEqual(['Tree', 'Files', 'Search', 'Settings']);
  expect(await names(app, 'right')).toEqual(['Board', 'Decisions', 'Terminal', 'Browser', 'Diff', 'Artifacts', 'Schedules', 'History', 'Layout']); // ticket 1022: History after it; owner pick 16:5x: no Preview on the bar; ticket 993: Schedules joins the next free slot
  await expect(bar(app, 'right').locator('[data-slot="9"] .lay')).toHaveCount(1);
  await expect(bar(app, 'left').locator('[data-slot="9"] .gear')).toHaveCount(1);
  await expect(sidebar(app, 'right')).toHaveCount(0); // the right sidebar starts closed
  // A fill in the default theme computes to a real colour (a token cycle once blanked every one: --line vs --g3). Ticket
  // 1041: the bar and the sidebar have no border; the page tint parts them from the centre.
  for (const sel of ['nav.ib.l', 'aside.sbar.l']) {
    const c = await app.locator(sel).evaluate((e) => getComputedStyle(e).backgroundColor);
    expect(c, sel).not.toMatch(/^(rgba\(0, 0, 0, 0\)|transparent)$/);
  }
  // LAYOUTBTN: Layout is an icon on the right bar, not in the title bar.
  await expect(bar(app, 'left').getByRole('button', { name: /layout/i })).toHaveCount(0);
  await expect(app.locator('header.title').getByRole('button', { name: /layout/i })).toHaveCount(0);
  for (const tip of await app.$$eval('nav.ib button.ai', (els) => els.map((e) => e.getAttribute('data-tip')))) expect(tip?.trim()).toBeTruthy(); // ticket 1041: the name is the tooltip
});

test('layout_a02_one_widget_per_side', async ({ app }) => {
  await openWindow(app);
  await expect(sidebar(app, 'left').locator('.sbh b')).toHaveText('Tree');
  await expect(sidebar(app, 'left').locator('.tree')).toHaveCount(1);
  await icon(app, 'left', 'Files').click();
  await expect(sidebar(app, 'left').locator('.sbh b')).toHaveText('Files');
  await expect(sidebar(app, 'left').locator('.tree')).toHaveCount(0);
  await expect(sidebar(app, 'left').locator('.sbb > *')).toHaveCount(1);
  await expect(app.locator('aside.sbar[data-side="left"]')).toHaveCount(1);
  await icon(app, 'right', 'Diff').click();
  await expect(sidebar(app, 'right').locator('.sbh b')).toHaveText('Diff');
  await icon(app, 'right', 'Artifacts').click();
  await expect(sidebar(app, 'right').locator('.sbh b')).toHaveText('Artifacts');
  await expect(app.locator('aside.sbar[data-side="right"]')).toHaveCount(1);
});

test('layout_a03_click_again_collapses', async ({ app }) => {
  await openWindow(app);
  const tree = icon(app, 'left', 'Tree');
  await tree.click();
  await expect(sidebar(app, 'left')).toHaveCount(0);
  await expect(tree).toHaveAttribute('aria-pressed', 'false');
  await tree.click();
  await expect(sidebar(app, 'left')).toBeVisible();
  await expect(tree).toHaveAttribute('aria-pressed', 'true');
});

test('layout_1020_tree_icon_from_settings_brings_the_tree', async ({ app }) => {
  // Ticket 1020, as VS Code's activity bar: the tree behind the Settings modal is not in front, so its icon closes Settings
  // and keeps the tree; only a click while it is in front hides it.
  await openWindow(app);
  const tree = icon(app, 'left', 'Tree');
  const dialog = app.getByRole('dialog', { name: 'Settings' });
  // The full-size modal covers the bar: the look pressed the icon through accessibility, a click with no pointer.
  await icon(app, 'left', 'Settings').click();
  await expect(dialog).toBeVisible();
  await tree.dispatchEvent('click');
  await expect(dialog).toHaveCount(0);
  await expect(sidebar(app, 'left').locator('.tree')).toBeVisible();
  await expect(tree).toHaveAttribute('aria-pressed', 'true');
  // A smaller modal leaves the bar under its shade: the press closes Settings, and the click under it must not hide the tree.
  await app.evaluate(() => localStorage.setItem('nunchiro.overlay.size.settings', JSON.stringify({ w: 640, h: 420 })));
  const box = (await tree.boundingBox())!;
  await icon(app, 'left', 'Settings').click();
  await expect(dialog).toBeVisible();
  await app.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(dialog).toHaveCount(0);
  await expect(sidebar(app, 'left').locator('.tree')).toBeVisible();
  // With the tree hidden first, the icon from Settings shows it (not a second toggle).
  await tree.click();
  await expect(sidebar(app, 'left')).toHaveCount(0);
  await icon(app, 'left', 'Settings').click();
  await tree.dispatchEvent('click');
  await expect(dialog).toHaveCount(0);
  await expect(sidebar(app, 'left').locator('.tree')).toBeVisible();
  // In front, a click still hides it (layout_a03).
  await tree.click();
  await expect(sidebar(app, 'left')).toHaveCount(0);
});

test('layout_1020_team_and_schedules_from_settings_stay_shown', async ({ app, core }) => {
  // Ticket 1020 round 2 (Fable review SHOULD 2): Team and Schedules follow the same rule as the tree.
  core.project('demo');
  mates(core, [{ id: 'mate-chief', name: 'Chief', lead: true }]);
  await openWindow(app, {}, core);
  if (await app.locator('.ovl .ovl-x').isVisible()) await app.locator('.ovl .ovl-x').click(); // a first run opens Settings
  const dialog = app.getByRole('dialog', { name: 'Settings' });
  for (const [name, view] of [['Team', '.sbar[data-widget="team"] .teamv'], ['Schedules', '.sbar[data-widget="schedules"] .schedv']]) {
    const ic = app.getByRole('navigation', { name: 'Right bar' }).getByRole('button', { name, exact: true });
    await ic.click();
    await expect(app.locator(view), name).toBeVisible();
    await icon(app, 'left', 'Settings').click();
    await expect(dialog).toBeVisible();
    await ic.dispatchEvent('click'); // the look's accessibility press: the modal covers the bar
    await expect(dialog, name).toHaveCount(0);
    await expect(app.locator(view), name).toBeVisible();
    await ic.click(); // in front, a click hides it
    await expect(app.locator(view), name).toHaveCount(0);
  }
});

test('layout_a04_board_opens_modal', async ({ app, core }) => {
  await openWindow(app);
  await icon(app, 'right', 'Diff').click();
  await icon(app, 'right', 'Board').click();
  await expect(app.getByRole('dialog', { name: 'Board' })).toBeVisible(); // a modal now, not a centre tab (v25f)
  await expect(sidebar(app, 'right').locator('.sbh b')).toHaveText('Diff');
  expect(await readLayout(core)).not.toContain('board');
});

test('layout_a05_docks_gone_commands_kept', async ({ app }) => {
  await openWindow(app);
  await expect(app.locator('.body > .dock')).toHaveCount(0); // the tree's own root keeps the class, inside the sidebar
  await expect(app.getByRole('button', { name: /Move .* to other side/ })).toHaveCount(0);
  await icon(app, 'left', 'Files').click();
  await expect(app.getByRole('button', { name: /Move .* to other side/ })).toHaveCount(0);
  await expect(app.locator('.dock.fdock, .dock.sdock, .dock.pdock')).toHaveCount(0);
  // The palette's command moves Files to the other bar; files.show then acts on the bar it is on now.
  await app.getByRole('button', { name: 'Open command palette' }).click();
  await app.getByRole('combobox').fill('Move Files to other side');
  await app.keyboard.press('Enter');
  await expect(toast(app)).toContainText('Files moved to the right bar');
  expect(await names(app, 'right')).toContain('Files');
  await icon(app, 'right', 'Files').click(); // Files is open on its new bar: collapse it, then the command opens it there
  await expect(sidebar(app, 'right')).toHaveCount(0);
  await app.getByRole('button', { name: 'Open command palette' }).click();
  await app.getByRole('combobox').fill('Show or hide Files');
  await app.keyboard.press('Enter');
  await expect(sidebar(app, 'right').locator('.sbh b')).toHaveText('Files');
});

test('layout_a06_tree_zone_kept', async ({ app, core }) => {
  // The default: no tree zone, and the web and core defaults name the same zones (the core pins the same literal in cargo).
  expect(JSON.stringify(defaultLayout().root)).toBe(
    JSON.stringify({ id: 'centre', split: 'column', children: [{ id: 'terminal', widgets: ['terminal'] }, { id: 'composer', widgets: ['composer'] }] }),
  );
  const errors = pageErrors(app);
  fs.writeFileSync(layoutFile(core), OLD_DEFAULT);
  await openWindow(app);
  // needs 157 (2) replaces A06 "the tree is a sidebar widget, not a zone": the Tree is a widget, so a file with a tree
  // zone loads with it kept (no one-time removal, no notice); the zone wins over the bar icon (one Tree, a move).
  expect(await zones(app)).toEqual(['tree', 'agents', 'terminal', 'waiting', 'composer']);
  await expect(zone(app, 'tree').locator('.tree')).toHaveCount(1);
  await expect.poll(() => names(app, 'left')).toEqual(['Files', 'Search', 'Settings']);
  await expect(app.locator('.lnote')).toHaveCount(0);
  expect(readLayout(core)).toContain('widgets = ["tree"]');
  expect(readLayout(core)).toContain('widgets = ["agents"]');
  expect(errors).toEqual([]);
});

test('layout_a07_title_bar_button_edit_mode', async ({ app }) => {
  await openWindow(app);
  await expect(layoutButton(app)).toHaveAccessibleName('Layout');
  await expect(layoutButton(app)).toHaveAttribute('aria-pressed', 'false');
  await layoutButton(app).click();
  await expect(layoutButton(app)).toHaveAccessibleName('Editing layout · Done');
  await expect(layoutButton(app)).toHaveAttribute('aria-pressed', 'true');
  await expect(editBar(app)).toBeVisible();
  await expect(lib(app)).toBeVisible();
  // Ticket 1041: edit mode shows every slot as a tint step (no dashed outline) and a grab cursor; the Layout button is the
  // selected tint, not orange, and the edit bar has no orange rule. The button is fixed (no remove, no drag handle in the list).
  expect(await icon(app, 'left', 'Files').evaluate((e) => [getComputedStyle(e).outlineStyle, getComputedStyle(e).cursor])).toEqual(['none', 'grab']);
  const slotBg = await icon(app, 'left', 'Files').evaluate((e) => getComputedStyle(e.closest('.slot')!).backgroundColor);
  expect(slotBg).not.toBe('rgba(0, 0, 0, 0)');
  const lay = await layoutButton(app).evaluate((e) => getComputedStyle(e).backgroundColor);
  expect(lay).not.toBe('rgba(0, 0, 0, 0)');
  expect(lay).not.toBe(await app.evaluate(() => { const d = document.createElement('i'); d.style.color = 'var(--you)'; document.body.append(d); const c = getComputedStyle(d).color; d.remove(); return c; }));
  expect(await editBar(app).evaluate((e) => getComputedStyle(e).borderBottomStyle)).toBe('none');
  await expect(bar(app, 'right').locator('.aiw:has(.lay) .rx')).toHaveCount(0); // it moves but cannot be removed
});

test('layout_a08_done_and_esc', async ({ app }) => {
  await openWindow(app);
  await startEdit(app);
  await layoutButton(app).click();
  await expect(lib(app)).toBeHidden();
  await startEdit(app);
  await endEdit(app);
  await expect(lib(app)).toBeHidden();
  await startEdit(app);
  await app.locator('.estrip .etitle').click(); // focus outside the fields
  await app.keyboard.press('Escape');
  await expect(lib(app)).toBeHidden();
  await expect(editBar(app)).toBeHidden();
});

test('layout_a09_no_drag_outside_edit', async ({ app }) => {
  await openWindow(app);
  await drag(app, icon(app, 'left', 'Files'), await centre(app, 'right'));
  expect(await names(app, 'left')).toEqual(['Tree', 'Files', 'Search', 'Settings']);
  expect(await names(app, 'right')).toEqual(['Board', 'Decisions', 'Terminal', 'Browser', 'Diff', 'Artifacts', 'Schedules', 'History', 'Layout']); // ticket 1022: History after it; ticket 993: Schedules joins the right bar's next free slot (outside Layout edit)
  await expect(toast(app)).toContainText('Turn on Layout to move icons');
});

async function centre(app: import('@playwright/test').Page, side: 'left' | 'right') {
  const b = (await bar(app, side).boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + 40 };
}

test('layout_a10_move_and_reorder', async ({ app }) => {
  await openWindow(app);
  await startEdit(app);
  await drag(app, icon(app, 'left', 'Files'), await barEnd(app, 'left'));
  // ICONBAR: into the empty slot 3; the slot it left stays empty.
  expect(await names(app, 'left')).toEqual(['Tree', 'Search', 'Files', 'Settings']);
  await expect(slot(app, 'left', 1)).toHaveClass(/empty/);
  // To an occupied slot of the other bar: the two swap; the slot aimed at shows mid-drag; the moved widget opens on its new side.
  await drag(app, icon(app, 'left', 'Search'), await barBefore(app, 'right', 0), { release: false });
  await expect(app.locator('.dragl .ins')).toHaveCount(1);
  await app.mouse.up();
  expect(await names(app, 'right')).toEqual(['Search', 'Decisions', 'Terminal', 'Browser', 'Diff', 'Artifacts', 'Layout']);
  expect(await names(app, 'left')).toEqual(['Tree', 'Board', 'Files', 'Settings']);
  await expect(sidebar(app, 'right').locator('.sbh b')).toHaveText('Search');
  await expect(toast(app)).toContainText('Search moved to the right bar');
});

test('layout_a11_remove_icon', async ({ app }) => {
  await openWindow(app);
  await startEdit(app);
  await bar(app, 'left').getByRole('button', { name: 'Remove Search from the left bar' }).click();
  expect(await names(app, 'left')).toEqual(['Tree', 'Files', 'Settings']);
  await expect(toast(app).getByRole('button', { name: 'Undo' })).toBeVisible();
  await drag(app, icon(app, 'right', 'Diff'), app.locator('[data-remove-area]'));
  expect(await names(app, 'right')).toEqual(['Board', 'Decisions', 'Terminal', 'Browser', 'Artifacts', 'Layout']);
  // Settings and Layout move but cannot be removed: no ✕, and the remove area refuses them.
  await expect(app.locator('nav.ib').getByRole('button', { name: /^Remove (Settings|Layout|Browser)/ })).toHaveCount(0);
  await drag(app, icon(app, 'left', 'Settings'), app.locator('[data-remove-area]'));
  await expect(toast(app)).toContainText('Settings cannot be removed');
  expect(await names(app, 'right')).toEqual(['Board', 'Decisions', 'Terminal', 'Browser', 'Artifacts', 'Layout']);
});

test('layout_a12_tree_required', async ({ app }) => {
  // Kept by needs 157 (2): the Tree is never removed; it may now leave both bars for a main zone.
  await openWindow(app);
  await startEdit(app);
  await expect(bar(app, 'left').getByRole('button', { name: /Remove Tree/ })).toHaveCount(0);
  await expect(bar(app, 'left').locator('.req')).toHaveCount(0); // needs 162 replaces needs 100's tag
  await drag(app, icon(app, 'left', 'Tree'), app.locator('[data-remove-area]'), { release: false });
  await expect(app.locator('.dropprev[data-error="true"]')).toContainText('Tree is required and cannot be removed');
  await app.mouse.up();
  expect(await names(app, 'left')).toEqual(['Tree', 'Files', 'Search', 'Settings']);
  await expect(toast(app)).toContainText('Tree is required and cannot be removed');
  await drag(app, icon(app, 'left', 'Tree'), await barEnd(app, 'right'));
  expect(await names(app, 'right')).toEqual(['Board', 'Decisions', 'Terminal', 'Browser', 'Diff', 'Artifacts', 'Tree', 'Layout']);
  expect(await names(app, 'left')).toEqual(['Files', 'Search', 'Settings']);
  await drag(app, icon(app, 'right', 'Tree'), await barBefore(app, 'left', 0));
  expect(await names(app, 'left')).toEqual(['Tree', 'Files', 'Search', 'Settings']);
  // In a zone it is on neither bar, and its zone has no ✕ either.
  await drag(app, icon(app, 'left', 'Tree'), await at(app, 'terminal', 0.9, 0.5));
  expect(await names(app, 'left')).toEqual(['Files', 'Search', 'Settings']);
  expect(await names(app, 'right')).not.toContain('Tree');
  await expect(zone(app, 'tree').getByRole('button', { name: /^Remove Tree/ })).toHaveCount(0);
});

test('decisions_no_required_tag', async ({ app }) => {
  // needs 162: like the Tree, Decisions is movable and not removable, with no tag and no ✕.
  await openWindow(app);
  await startEdit(app);
  await expect(bar(app, 'right').getByRole('button', { name: /Remove Decisions/ })).toHaveCount(0);
  await expect(bar(app, 'right').locator('.req')).toHaveCount(0);
  await drag(app, icon(app, 'right', 'Decisions'), app.locator('[data-remove-area]'), { release: false });
  await expect(app.locator('.dropprev[data-error="true"]')).toContainText('Decisions is required because it holds the risky Allow answers');
  await app.mouse.up();
  await expect(toast(app)).toContainText('Decisions is required because it holds the risky Allow answers');
  expect(await names(app, 'right')).toContain('Decisions');
});

test('layout_a13_tree_accepted_in_main', async ({ app, core }) => {
  // needs 157 (2) replaces A13 "refused in the main area" (D36): the compass takes the Tree over a zone like any widget.
  await openWindow(app);
  await startEdit(app);
  await drag(app, icon(app, 'left', 'Tree'), await at(app, 'terminal', 0.9, 0.5), { release: false });
  await expect(app.locator('.dropprev')).toHaveAttribute('data-error', 'false');
  await expect(app.locator('.dropprev')).toContainText('Split right · Tree · split right of Chat');
  await expect(app.locator('.compass')).toBeVisible();
  await app.mouse.up();
  expect(await zones(app)).toEqual(['terminal', 'tree', 'composer']);
  expect(await names(app, 'left')).toEqual(['Files', 'Search', 'Settings']);
  expect((await stored(app)).bars.left).not.toContain('tree');
  await endEdit(app);
  await expect.poll(() => readLayout(core)).toContain('widgets = ["tree"]');
});

test('layout_a14_main_only_widgets', async ({ app }) => {
  await openWindow(app);
  await startEdit(app);
  // AGENTVIEW (TERMW): the Terminal widget is bar-placeable now (its icon toggles the side pane); Preview is never on a bar (RIGHTBAR).
  for (const kind of ['composer', 'waiting', 'preview']) {
    await drag(app, card(app, kind), await barEnd(app, 'left'));
    expect(await names(app, 'left')).toEqual(['Tree', 'Files', 'Search', 'Settings']);
    await expect(toast(app)).toContainText('can only be in the main area');
  }
});

const userCards = (core: Core) => {
  unapproved(core, 'alpha-feed', 'beta-feed');
};

test('layout_a15_library_lists_and_places', async ({ app, core }) => {
  userCards(core);
  await openWindow(app);
  await startEdit(app);
  await expect(app.locator('.lib .lcard:not(.ask)')).toHaveCount(ENTRIES.length + 2);
  for (const e of ENTRIES) await expect(card(app, e.kind)).toBeVisible();
  await expect(card(app, 'widget:alpha-feed')).toBeVisible();
  await expect(card(app, 'files').locator('.lpl')).toHaveText('Left bar');
  await expect(card(app, 'diff').locator('.lpl')).toHaveText('Right bar');
  await expect(card(app, 'terminal').locator('.lpl')).toHaveText('Right bar');
  await bar(app, 'left').getByRole('button', { name: 'Remove Search from the left bar' }).click();
  await expect(card(app, 'search').locator('.lpl')).toHaveCount(0);
});

test('layout_a16_library_chips_pending', async ({ app, core }) => {
  userCards(core);
  await openWindow(app);
  await startEdit(app);
  await lib(app).getByRole('button', { name: 'Built-in' }).click();
  await expect(app.locator('.lib .lcard:not(.ask)')).toHaveCount(ENTRIES.length);
  await expect(app.locator('.lib .lcard[data-card^="widget:"]')).toHaveCount(0);
  await lib(app).getByRole('button', { name: /My widgets/ }).click();
  await expect(app.locator('.lib .lcard:not(.ask)')).toHaveCount(2);
  await expect(lib(app).getByRole('button', { name: /My widgets/ })).toContainText('2 to approve');
  await lib(app).getByRole('button', { name: 'All' }).click();
  await expect(app.locator('.lib .lcard:not(.ask)')).toHaveCount(ENTRIES.length + 2);
});

test('layout_a17_library_search', async ({ app }) => {
  await openWindow(app);
  await startEdit(app);
  const find = lib(app).getByRole('searchbox', { name: 'Search widgets' });
  await find.fill('board');
  await expect(app.locator('.lib .lcard:not(.ask)')).toHaveCount(1);
  await find.fill('보드');
  await expect(app.locator('.lib .lcard:not(.ask)')).toHaveCount(1);
  await expect(card(app, 'board')).toBeVisible();
  await find.fill('zzz');
  await expect(app.locator('.lib .lcard:not(.ask)')).toHaveCount(0);
  await expect(lib(app)).toContainText('No widget matches');
});

test('layout_a18_card_to_bar', async ({ app }) => {
  await openWindow(app);
  await startEdit(app);
  await drag(app, card(app, 'agents'), await barBefore(app, 'right', 0));
  // The card dropped on an occupied slot takes it; the displaced Board goes to the first free slot.
  expect(await names(app, 'right')).toEqual(['Agents', 'Decisions', 'Terminal', 'Browser', 'Diff', 'Artifacts', 'Board', 'Layout']);
  await expect(sidebar(app, 'right').locator('.sbh b')).toHaveText('Agents');
  await drag(app, card(app, 'files'), await barEnd(app, 'right'));
  expect(await names(app, 'left')).toEqual(['Tree', 'Search', 'Settings']);
  expect(await names(app, 'right')).toContain('Files');
});

test('layout_a19_compass', async ({ app }) => {
  await openWindow(app);
  await startEdit(app);
  // Mid-drag over the terminal: five arms, the aimed one filled, a preview in the same direction and a caption.
  await drag(app, card(app, 'files'), await at(app, 'terminal', 0.92, 0.5), { release: false });
  await expect(app.locator('.compass i')).toHaveCount(5);
  await expect(app.locator('.compass i[data-on="true"]')).toHaveAttribute('data-arm', 'right');
  await expect(app.locator('.dropprev')).toHaveAttribute('data-dir', 'right');
  await expect(app.locator('.dropl')).toContainText('Split right');
  await app.mouse.move(...(Object.values(await at(app, 'terminal', 0.5, 0.92)) as [number, number]), { steps: 4 });
  await expect(app.locator('.dropl')).toContainText('Split below');
  await app.mouse.move(...(Object.values(await at(app, 'terminal', 0.5, 0.5)) as [number, number]), { steps: 4 });
  await expect(app.locator('.compass i[data-on="true"]')).toHaveAttribute('data-arm', 'centre');
  await expect(app.locator('.dropl')).toContainText('Add as tab');
  await app.mouse.move(...(Object.values(await at(app, 'terminal', 0.92, 0.5)) as [number, number]), { steps: 4 });
  await app.mouse.up();
  // The Files icon left its bar and Files is a zone beside the terminal.
  expect(await names(app, 'left')).toEqual(['Tree', 'Search', 'Settings']);
  expect(await zones(app)).toContain('files');
  const t = (await zone(app, 'terminal').boundingBox())!;
  expect((await zone(app, 'files').boundingBox())!.x).toBeGreaterThan(t.x + t.width - 2);
  // The centre makes a tab; a bar icon placed there leaves its bar.
  await drag(app, icon(app, 'left', 'Search'), await at(app, 'terminal', 0.5, 0.5));
  expect(await names(app, 'left')).toEqual(['Tree', 'Settings']);
  await expect(zone(app, 'terminal').locator('.ztabs [role="tab"]')).toHaveText(['Terminal', 'Search']);
});
