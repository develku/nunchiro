// LAYOUT D5b lane B: widgets nest under a project in the tree as sub-views; the Tree icon opens a project picker (B01-B08).
import AxeBuilder from '@axe-core/playwright';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { cleanBars, defaultBars, members, refuses } from '../src/layout/bars';
import { builtIn } from '../src/layout/presets';
import { type Core, expect, openWindow, test } from './fixtures';
import { makeT } from './i18n-tables';
import { card, drag, editBar, icon, names, pageErrors, startEdit, stored, toast } from './d5b';
import { openQuiet, seed as treeEdit } from './tree-seed';

const KEY = 'nunchiro.settings.v1';
const heads = (page: Page) => page.locator('.sbar .tree .row.head[data-project-path]');
const head = (page: Page, name: string) => heads(page).filter({ has: page.locator('.n b', { hasText: new RegExp(`^${name}$`) }) });
const grp = (page: Page, name: string) => page.locator(`.sbar .tree .grp[data-project="${name}"]`);
const view = (page: Page, name: string, kind: string) => grp(page, name).locator(`.view[data-view="${kind}"]`);
const toggle = (page: Page, name: string, kind: string) => view(page, name, kind).locator('.vh button.vt');
const pill = (l: Locator) => l.evaluate((e) => getComputedStyle(e, '::after').content);
const picker = (page: Page) => page.getByRole('dialog', { name: /^Projects for / });
/** A library card scrolled into view (the list scrolls; a card below the fold would otherwise grab its neighbour). */
const lc = async (page: Page, kind: string) => {
  await card(page, kind).scrollIntoViewIfNeeded();
  return card(page, kind);
};
const nestOf = async (page: Page) => (await stored(page)).bars?.nest ?? {};

/** nunchiro (with a second, waiting-free session) and lumen, each with a main-folder shell session. */
function seed(core: Core) {
  const nun = core.project('nunchiro');
  const kuv = core.project('lumen');
  core.shell(nun, 'one');
  core.shell(nun, 'two');
  core.shell(kuv, 'backtest');
  fs.writeFileSync(path.join(kuv, 'only-lumen.txt'), 'needle-in-lumen\n');
  fs.writeFileSync(path.join(nun, 'only-nunchiro.txt'), 'needle-in-nunchiro\n');
  openQuiet(core, 'nunchiro', 'lumen', '');
  return { nun, kuv };
}
const open = async (app: Page, core: Core) => {
  const p = seed(core);
  await openWindow(app);
  await expect(heads(app)).toHaveCount(2);
  return p;
};

test('layout_b01_project_row_drop_target', async ({ app, core }) => {
  await open(app, core);
  // Outside edit mode: no highlight.
  await expect(head(app, 'nunchiro')).not.toHaveAttribute('data-hot', /.*/);
  await startEdit(app);
  const row = head(app, 'nunchiro');
  await drag(app, await lc(app, 'agents'), row, { release: false });
  await expect(row).toHaveAttribute('data-hot', '');
  expect(await pill(row)).toContain('Add as sub-view');
  await app.mouse.up();
  await expect(row).not.toHaveAttribute('data-hot', /.*/);
  await expect(view(app, 'nunchiro', 'agents').locator('.vh')).toContainText('Agents');
  await expect(toggle(app, 'nunchiro', 'agents')).toHaveAttribute('aria-expanded', 'true');
  await expect(toast(app)).toContainText('Agents');
  await expect(toast(app).getByRole('button', { name: 'Undo' })).toBeVisible();
  // The Tree card over a row: no highlight, the drop is refused with a notice.
  const before = JSON.stringify(await stored(app));
  await drag(app, await lc(app, 'tree'), head(app, 'lumen'), { release: false });
  await expect(head(app, 'lumen')).not.toHaveAttribute('data-hot', /.*/);
  await app.mouse.up();
  expect(JSON.stringify(await stored(app))).toBe(before);
  await expect(toast(app)).toContainText(/Tree/);
  await expect(toast(app).getByRole('button', { name: 'Undo' })).toHaveCount(0);
});

test('layout_b02_tree_icon_picker', async ({ app, core }) => {
  const { kuv } = await open(app, core);
  await icon(app, 'left', 'Tree').click(); // collapse the tree sidebar: the pick must reopen it
  await expect(app.locator('aside.sbar[data-side="left"]')).toHaveCount(0);
  await startEdit(app);
  await drag(app, await lc(app, 'board'), icon(app, 'left', 'Tree'), { release: false });
  await expect(app.locator('nav[data-bar="left"] [data-hot]')).toHaveCount(1);
  await app.mouse.up();
  const dlg = picker(app);
  await expect(dlg).toContainText('Projects for Board view');
  await expect(dlg.getByRole('button')).toHaveText(['nunchiro', 'lumen', 'Cancel']);
  // Cancel and Esc change nothing: bars, nest and history.
  const before = JSON.stringify(await stored(app));
  await dlg.getByRole('button', { name: 'Cancel' }).click();
  await expect(dlg).toBeHidden();
  expect(JSON.stringify(await stored(app))).toBe(before);
  await drag(app, await lc(app, 'board'), icon(app, 'left', 'Tree'));
  await app.keyboard.press('Escape');
  await expect(dlg).toBeHidden();
  expect(JSON.stringify(await stored(app))).toBe(before);
  await expect(editBar(app)).toBeVisible(); // Esc closed the picker only
  await drag(app, await lc(app, 'board'), icon(app, 'left', 'Tree'));
  await dlg.getByRole('button', { name: 'lumen' }).click();
  await expect(view(app, 'lumen', 'board')).toBeVisible();
  await expect(app.locator('aside.sbar[data-side="left"] .tree')).toBeVisible();
  expect((await nestOf(app))[kuv]).toEqual(['board']);
  // Board keeps its bar slot after nesting.
  expect(await names(app, 'right')).toContain('Board');
  // The Tree dropped on its own icon behaves as in lane A: no picker.
  await drag(app, icon(app, 'left', 'Tree'), icon(app, 'left', 'Tree'));
  await expect(picker(app)).toHaveCount(0);
});

test('layout_b03_subview_toggle_remove_undo', async ({ app, core }) => {
  await open(app, core);
  await startEdit(app);
  await drag(app, await lc(app, 'agents'), head(app, 'nunchiro'));
  const t = toggle(app, 'nunchiro', 'agents');
  await t.click();
  await expect(t).toHaveAttribute('aria-expanded', 'false');
  await t.click();
  await expect(t).toHaveAttribute('aria-expanded', 'true');
  await t.focus();
  await app.keyboard.press('Enter');
  await expect(t).toHaveAttribute('aria-expanded', 'false');
  await app.keyboard.press('Space');
  await expect(t).toHaveAttribute('aria-expanded', 'true');
  // ✕ shows in edit mode only.
  const x = view(app, 'nunchiro', 'agents').getByRole('button', { name: /^Remove Agents view/ });
  await expect(x).toBeVisible();
  await x.click();
  await expect(view(app, 'nunchiro', 'agents')).toHaveCount(0);
  await toast(app).getByRole('button', { name: 'Undo' }).click();
  await expect(view(app, 'nunchiro', 'agents')).toBeVisible();
  await app.locator('body').click({ position: { x: 5, y: 5 } });
  await app.keyboard.press('Meta+z'); // nest then ⌘Z removes it
  await expect(view(app, 'nunchiro', 'agents')).toHaveCount(0);
  await drag(app, await lc(app, 'files'), head(app, 'nunchiro'));
  await expect(view(app, 'nunchiro', 'files')).toBeVisible();
  await app.keyboard.press('Meta+z');
  await expect(view(app, 'nunchiro', 'files')).toHaveCount(0);
  const trail = JSON.stringify(await stored(app));
  await app.keyboard.press('Meta+z'); // beyond the trail: nothing more to undo
  expect(JSON.stringify(await stored(app))).toBe(trail);
  await endEditAndCheckNoX(app);
});
async function endEditAndCheckNoX(app: Page) {
  await drag(app, await lc(app, 'agents'), head(app, 'nunchiro'));
  await editBar(app).getByRole('button', { name: 'Done', exact: true }).click();
  await expect(view(app, 'nunchiro', 'agents')).toBeVisible();
  await expect(view(app, 'nunchiro', 'agents').getByRole('button', { name: /^Remove/ })).toBeHidden();
}

test('layout_b04_subview_scoped_to_project', async ({ app, core }) => {
  const { nun, kuv } = await open(app, core);
  await startEdit(app);
  for (const [name, k] of [['lumen', 'files'], ['lumen', 'search'], ['lumen', 'board'], ['lumen', 'agents'], ['nunchiro', 'files'], ['nunchiro', 'agents'], ['nunchiro', 'board']]) await drag(app, await lc(app, k), head(app, name));
  await expect(view(app, 'lumen', 'files').locator('.files .r[title]')).toHaveAttribute('title', new RegExp(`${kuv}$`));
  await expect(view(app, 'nunchiro', 'files').locator('.files .r[title]')).toHaveAttribute('title', new RegExp(`${nun}$`));
  const q = view(app, 'lumen', 'search').getByRole('searchbox');
  await q.fill('needle');
  await q.press('Enter');
  await expect(view(app, 'lumen', 'search').locator('.sfile')).toHaveText([/only-lumen\.txt/]);
  const own = async (n: string, sel: string) => (await view(app, n, sel.split(' ')[0]).locator(sel.split(' ').slice(1).join(' ')).allInnerTexts()).join('|');
  await expect(view(app, 'lumen', 'board').locator('.bcard')).toHaveCount(1);
  await expect(view(app, 'lumen', 'board').locator('.bcard .btt')).toHaveText(['backtest']);
  await expect(view(app, 'nunchiro', 'board').locator('.bcard')).toHaveCount(2);
  await expect(view(app, 'lumen', 'agents').locator('.arow')).toHaveCount(1);
  await expect(view(app, 'nunchiro', 'agents').locator('.arow')).toHaveCount(2);
  expect(await own('lumen', 'agents .arow')).not.toBe(await own('nunchiro', 'agents .arow'));
});

test('layout_b05_subviews_below_sessions', async ({ app, core }) => {
  const p = core.project('lumen');
  const git = (...args: string[]) => execFileSync('git', ['-C', p, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args]);
  git('init', '-q');
  git('commit', '-q', '--allow-empty', '-m', 'init');
  core.agent(p, 'ui-02', 'go');
  core.cli('session', 'start', '--kind', 'shell', '--project', p, '--label', 'wt', '--worktree', '--', '/bin/cat'); // a worktree row
  openQuiet(core, 'lumen');
  await openWindow(app);
  await startEdit(app);
  await drag(app, await lc(app, 'agents'), head(app, 'lumen'));
  fs.writeFileSync(path.join(p, 'go'), ''); // the agent asks: a your-turn row
  const g = grp(app, 'lumen');
  await expect(g.locator('.q')).toHaveCount(1, { timeout: 15_000 });
  const rows = await g.locator('.row.wt2').last().boundingBox();
  const ask = await g.locator('.q').first().boundingBox();
  const v = await view(app, 'lumen', 'agents').boundingBox();
  expect(v!.y).toBeGreaterThanOrEqual(rows!.y + rows!.height - 1);
  expect(ask!.y + ask!.height).toBeLessThanOrEqual(v!.y + 1); // the your-turn row stays above the sub-views
  // Collapsing the project hides its sub-views; the your-turn row stays.
  await app.mouse.move(900, 400);
  await g.getByRole('button', { name: 'Collapse lumen' }).click();
  await expect(view(app, 'lumen', 'agents')).toHaveCount(0);
  await expect(g.locator('.q')).toHaveCount(1);
  expect(await nestOf(app)).toEqual({ [p]: ['agents'] }); // hidden, not removed
  await g.getByRole('button', { name: 'Expand lumen' }).click();
  await expect(view(app, 'lumen', 'agents')).toBeVisible();
});

test('layout_b05_subview_stays_in_sight_after_reload: no quiet line folds it away, the nest is kept', async ({ app, core }) => {
  const nun = core.project('nunchiro');
  core.shell(nun, 'one');
  core.shell(core.project('lumen'), 'two');
  openQuiet(core, 'nunchiro', 'lumen', '');
  await openWindow(app);
  await startEdit(app);
  await drag(app, await lc(app, 'agents'), head(app, 'nunchiro'));
  await expect(view(app, 'nunchiro', 'agents')).toBeVisible();
  await endEditAndReload(app, core);
  // Since f6568f12 (ticket 370 item 361) no project folds under an Other projects line, so the quiet keys fold nothing:
  // after the reload the project and its one sub-view are in sight again, and the nest is kept.
  await expect(head(app, 'nunchiro')).toBeVisible();
  await expect(app.locator('.sbar .tree .view')).toHaveCount(1);
  await expect(view(app, 'nunchiro', 'agents')).toBeVisible();
  expect(await nestOf(app)).toEqual({ [nun]: ['agents'] });
});
async function endEditAndReload(app: Page, core: Core) {
  await editBar(app).getByRole('button', { name: 'Done', exact: true }).click();
  treeEdit(core, { op: 'fold', key: 'quiet:', folded: false }, { op: 'fold', key: 'quiet:nunchiro', folded: false });
  await app.reload();
  await expect(app.locator('.sbar nav.tree')).toBeVisible();
}

test('layout_b06_subview_height_cap', async ({ app, core }) => {
  const nun = core.project('nunchiro');
  for (let i = 0; i < 12; i++) core.shell(nun, `card-${i}`);
  openQuiet(core, 'nunchiro');
  await openWindow(app);
  await startEdit(app);
  await drag(app, await lc(app, 'board'), head(app, 'nunchiro'));
  const body = view(app, 'nunchiro', 'board').locator('.vb');
  await expect(body.locator('.bcard')).toHaveCount(12);
  const css = await body.evaluate((e) => ({ max: parseFloat(getComputedStyle(e).maxHeight), oy: getComputedStyle(e).overflowY, h: e.getBoundingClientRect().height }));
  expect(css.max).toBeLessThanOrEqual(130);
  expect(css.oy).toBe('auto');
  expect(css.h).toBeLessThanOrEqual(130);
  const tree = app.locator('.sbar .tree').first();
  expect(await tree.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
});

test('layout_b07_nest_persistence_presets', async ({ app, core }) => {
  const { kuv } = await open(app, core);
  const errors = pageErrors(app);
  expect(builtIn('Default')!.bars.nest).toEqual({});
  await startEdit(app);
  await drag(app, await lc(app, 'agents'), head(app, 'lumen'));
  await toggle(app, 'lumen', 'agents').click(); // closed
  await expect(editBar(app).getByRole('button', { name: /^Presets/ })).toContainText('Default ●'); // dirty mark after a nest
  await editBar(app).getByRole('button', { name: 'Done', exact: true }).click();
  await app.reload();
  await expect(view(app, 'lumen', 'agents')).toBeVisible();
  await expect(toggle(app, 'lumen', 'agents')).toHaveAttribute('aria-expanded', 'false');
  expect((await stored(app)).bars.open).toEqual({ [`${kuv}::agents`]: false });
  // Presets carry the nest.
  await startEdit(app);
  const presets = editBar(app).getByRole('button', { name: /^Presets/ });
  await presets.click();
  await app.getByRole('menuitem', { name: /Save as/ }).click();
  await app.getByRole('textbox', { name: /name/i }).fill('Nested');
  await app.keyboard.press('Enter');
  await presets.click();
  await app.getByRole('menuitemradio', { name: /^Default/ }).click();
  await expect(view(app, 'lumen', 'agents')).toHaveCount(0);
  await presets.click();
  await app.getByRole('menuitemradio', { name: /^Nested/ }).click();
  await expect(view(app, 'lumen', 'agents')).toBeVisible();
  expect(errors).toEqual([]);
});

test('layout_b07_garbage_nest_falls_back', async ({ app, core }) => {
  seed(core);
  const errors = pageErrors(app);
  const bars = { ...defaultBars(), nest: { '/x': 'agents', '/y': [3] }, open: [1] };
  await app.addInitScript(([k, v]) => localStorage.setItem(k as string, JSON.stringify(v)), [KEY, { bars }] as const);
  await openWindow(app);
  expect((await stored(app)).bars.nest).toEqual({});
  expect(await names(app, 'left')).toEqual(['Tree', 'Files', 'Search', 'Settings']); // the bars stay
  expect(errors).toEqual([]);
  // Pure: an old store without the fields reads as empty.
  const old = { left: defaultBars().left, right: defaultBars().right, active: defaultBars().active };
  expect(cleanBars(old)).toMatchObject({ nest: {}, open: {} });
  expect(cleanBars({ ...defaultBars(), nest: { '/p': ['preview'] } })!.nest).toEqual({}); // a stored Preview nest is dropped
  expect(members({ ...defaultBars(), nest: { '/p': ['files'] } })).not.toBe(members(defaultBars()));
  expect(members({ ...defaultBars(), open: { '/p::files': true } })).toBe(members(defaultBars()));
});

test('nest_refusals', async ({ app, core }) => {
  await open(app, core);
  const reasons = ['tree', 'settings', 'layout', 'terminal', 'composer', 'waiting', 'decisions', 'preview', 'widget:mine'].map((w) => refuses(w, 'nest', makeT('en', 'en')));
  expect(reasons.every((r) => typeof r === 'string' && r.length > 0)).toBe(true);
  expect(refuses('files', 'nest', makeT('en', 'en'))).toBeNull();
  await startEdit(app);
  const before = JSON.stringify(await stored(app));
  for (const [kind, text] of [['terminal', /Terminal/], ['composer', /Composer/], ['waiting', /Answer strip/], ['preview', /Preview/]] as const) {
    await drag(app, await lc(app, kind), head(app, 'nunchiro'));
    await expect(toast(app)).toContainText(text);
    await expect(toast(app).getByRole('button', { name: 'Undo' })).toHaveCount(0);
  }
  expect(JSON.stringify(await stored(app))).toBe(before);
  // The same widget twice under one project is a notice, not a step.
  await drag(app, await lc(app, 'files'), head(app, 'nunchiro'));
  const once = JSON.stringify(await stored(app));
  await drag(app, await lc(app, 'files'), head(app, 'nunchiro'));
  await expect(toast(app)).toContainText(/already/i);
  expect(JSON.stringify(await stored(app))).toBe(once);
});

test('terminal_card_refuses_nest_with_toast', async ({ app, core }) => {
  await open(app, core);
  expect(refuses('terminal', 'nest', makeT('en', 'en'))).toMatch(/Terminal/);
  await startEdit(app);
  const before = JSON.stringify(await stored(app));
  await drag(app, await lc(app, 'terminal'), head(app, 'nunchiro'));
  await expect(toast(app)).toContainText(/Terminal/);
  await expect(toast(app).getByRole('button', { name: 'Undo' })).toHaveCount(0);
  expect(JSON.stringify(await stored(app))).toBe(before);
  await expect(view(app, 'nunchiro', 'terminal')).toHaveCount(0);
});

test('layout_b08_axe_keyboard_nest', async ({ app, core }) => {
  const { nun } = await open(app, core);
  await startEdit(app);
  const c = card(app, 'files');
  await c.focus();
  await app.keyboard.press('Alt+Enter');
  await expect(c).toHaveAttribute('data-armed', '');
  expect((await new AxeBuilder({ page: app }).include('.lib').analyze()).violations.map((v) => v.id)).toEqual([]); // the armed card is valid ARIA
  await expect(app.getByRole('status').filter({ hasText: 'Choose a project. Enter puts the widget inside it. Esc cancels.' })).toHaveCount(1);
  await app.keyboard.press('Escape'); // disarms; the edit stays
  await expect(c).not.toHaveAttribute('data-armed', '');
  await expect(editBar(app)).toBeVisible();
  await c.focus();
  await app.keyboard.press('Alt+Enter');
  await app.keyboard.press('ArrowDown'); // first project row
  await app.keyboard.press('ArrowDown'); // second
  await app.keyboard.press('ArrowUp');
  await app.keyboard.press('Enter');
  await expect(view(app, 'nunchiro', 'files').or(view(app, 'lumen', 'files'))).toHaveCount(1);
  expect(Object.values(await nestOf(app)).flat()).toEqual(['files']);
  // Plain Enter on a card keeps its lane A meaning: add to the Left bar.
  // Artifacts, not Preview: Preview is never bar-placeable (layout_a14), so Enter on its card only toasts the refusal.
  await card(app, 'artifacts').focus();
  await app.keyboard.press('Enter');
  await expect.poll(() => names(app, 'left')).toContain('Artifacts');
  expect(await names(app, 'right')).not.toContain('Artifacts'); // a widget lives in one slot: it moved, not copied
  expect(Object.values(await nestOf(app)).flat()).toEqual(['files']);
  // axe with sub-views and the picker open, light and dark (adding Artifacts opened it over the Tree: bring the Tree back).
  await icon(app, 'left', 'Tree').click();
  await drag(app, await lc(app, 'board'), head(app, 'nunchiro'));
  await expect(view(app, 'nunchiro', 'board')).toBeVisible();
  await drag(app, await lc(app, 'agents'), icon(app, 'left', 'Tree'));
  await expect(picker(app)).toBeVisible();
  for (const scheme of ['light', 'dark'] as const) {
    await app.emulateMedia({ colorScheme: scheme });
    const r = await new AxeBuilder({ page: app }).include('.sbar .tree').include('[role="dialog"]').analyze();
    expect(r.violations.map((v) => v.id)).toEqual([]);
  }
  void nun;
});

test('layout_b09_owner_path: two views under one project and one under another (picker), both open with content, ✕, reload', async ({ app, core }) => {
  const { nun, kuv } = await open(app, core);
  const errors = pageErrors(app);
  await startEdit(app);
  await drag(app, await lc(app, 'files'), head(app, 'nunchiro'));
  await drag(app, await lc(app, 'agents'), head(app, 'nunchiro'));
  await drag(app, await lc(app, 'board'), icon(app, 'left', 'Tree'));
  await picker(app).getByRole('button', { name: 'lumen' }).click();
  expect(await nestOf(app)).toEqual({ [nun]: ['files', 'agents'], [kuv]: ['board'] });
  // Both nunchiro views are open at once, each drawing its own content; folding one leaves the other.
  const both = async () => {
    await expect(toggle(app, 'nunchiro', 'files')).toHaveAttribute('aria-expanded', 'true');
    await expect(toggle(app, 'nunchiro', 'agents')).toHaveAttribute('aria-expanded', 'true');
    await expect(view(app, 'nunchiro', 'files').locator('.files .r[title]').first()).toHaveAttribute('title', new RegExp(`${nun}$`));
    await expect(view(app, 'nunchiro', 'files')).toContainText('only-nunchiro.txt');
    await expect(view(app, 'nunchiro', 'agents').locator('.arow')).toHaveCount(2);
    await expect(view(app, 'lumen', 'board').locator('.bcard .btt')).toHaveText(['backtest']);
  };
  await both();
  await toggle(app, 'nunchiro', 'files').click();
  await expect(view(app, 'nunchiro', 'files').locator('.vb')).toHaveCount(0);
  await expect(view(app, 'nunchiro', 'agents').locator('.arow')).toHaveCount(2);
  await toggle(app, 'nunchiro', 'files').click();
  await endEditAndReload(app, core);
  await both();
  // ✕ (edit mode only) removes one view; the removal survives a reload too.
  await startEdit(app);
  await view(app, 'nunchiro', 'agents').getByRole('button', { name: /^Remove Agents view/ }).click();
  await expect(view(app, 'nunchiro', 'agents')).toHaveCount(0);
  await endEditAndReload(app, core);
  await expect(view(app, 'nunchiro', 'files').locator('.files .r[title]').first()).toBeVisible();
  await expect(view(app, 'nunchiro', 'agents')).toHaveCount(0);
  await expect(view(app, 'lumen', 'board')).toBeVisible();
  expect(await nestOf(app)).toEqual({ [nun]: ['files'], [kuv]: ['board'] });
  expect(errors).toEqual([]);
});
