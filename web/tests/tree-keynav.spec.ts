// V2.5-61 (ticket 220 B9, ticket 194, needs 178 lane L11): arrows, Home, End, Enter, Left and Right in the tree, on a
// roving tabindex (one row in the Tab order). Hint labels (needs 118) stay; this adds arrows beside them.
import { execFileSync } from 'node:child_process';
import type { Locator, Page } from '@playwright/test';
import { expect, openWindow, test, type Core } from './fixtures';

const repo = (core: Core, name: string) => {
  const p = core.project(name);
  const git = (...a: string[]) => execFileSync('git', ['-C', p, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a]);
  git('init', '-q', '-b', 'main');
  git('commit', '-q', '--allow-empty', '-m', 'init');
  return p;
};
const create = (core: Core, p: string, branch: string) => (core.cli('worktree', 'create', '--project', p, '--branch', branch, '--no-focus').worktrees as { path: string; branch: string }[]).find((w) => w.branch === branch)!;
const grp = (app: Page, name: string) => app.locator(`.grp[data-project="${name}"]`);
const head = (app: Page, name: string) => grp(app, name).locator('.row.head > button.n');
const chev = (app: Page, name: string) => grp(app, name).locator('.row.head > button.chev');
const wtRow = (app: Page, name: string) => app.locator('.row.wt2').filter({ hasText: name }).first();
// v25-new-tab (needs 213): alpha's idle main-folder shell has a row of its own, first under the head (a `treerow`).
const mainRow = (app: Page) => grp(app, 'alpha').locator('button.row.wt2[data-menu="treerow"]');
const focused = (l: Locator) => expect(l).toBeFocused();

/** alpha: a main shell and two worktrees (a-one has a session, a-two none); beta: a main shell and one worktree. */
async function setup(app: Page, core: Core) {
  const a = repo(core, 'alpha');
  const b = repo(core, 'beta');
  core.shell(a, 'alpha-main');
  core.shell(b, 'beta-main');
  const one = create(core, a, 'a-one');
  core.cli('worktree', 'open', '--path', one.path, '--label', 'a-one', '--no-focus');
  create(core, a, 'a-two');
  create(core, b, 'b-one');
  await openWindow(app);
  await expect(wtRow(app, 'a-one')).toBeVisible();
  await expect(wtRow(app, 'a-two')).toBeVisible();
  await expect(wtRow(app, 'b-one')).toBeVisible();
}

/** The two alpha rows in the order the tree draws them. */
const alphaRows = async (app: Page) => {
  const names = await grp(app, 'alpha').locator('button.row.wt2:not([data-menu="treerow"])').evaluateAll((els) => els.map((e) => e.textContent ?? ''));
  return names.map((n) => wtRow(app, n.includes('a-one') ? 'a-one' : 'a-two'));
};

test('tree_arrow_keys_move_focus_between_rows', async ({ app, core }) => {
  await setup(app, core);
  await head(app, 'alpha').focus();
  const [first, second] = await alphaRows(app);
  await app.keyboard.press('ArrowDown');
  await focused(mainRow(app));
  await app.keyboard.press('ArrowDown');
  await focused(first);
  await app.keyboard.press('ArrowDown');
  await focused(second);
  await app.keyboard.press('ArrowDown');
  await focused(head(app, 'beta'));
  await app.keyboard.press('ArrowUp');
  await focused(second);
  // Home and End jump to the first and last visible row; wrapping is off.
  await app.keyboard.press('Home');
  const assistants = app.locator('.home-grp .row.head > button.n'); // ticket 1032: the Assistants group is the tree's first row
  await focused(assistants);
  await app.keyboard.press('ArrowUp');
  await focused(assistants);
  await app.keyboard.press('End');
  await focused(wtRow(app, 'b-one'));
  await app.keyboard.press('ArrowDown');
  await focused(wtRow(app, 'b-one'));
  // Roving tabindex: the focused row alone is in the Tab order.
  const tabbable = await app.locator('.tree').evaluate((nav) => [...nav.querySelectorAll('.row.head > button.n, button.row.wt2, button.row.quiet')].filter((e) => e.getAttribute('tabindex') === '0').map((e) => e.textContent));
  expect(tabbable).toHaveLength(1);
  expect(tabbable[0]).toContain('b-one');
  // The shared token ring shows on the focused row.
  const ring = await wtRow(app, 'b-one').evaluate((e) => {
    const s = getComputedStyle(e);
    const probe = document.createElement('i');
    probe.style.color = 'var(--focus-ring)';
    e.closest('.tree')!.append(probe); // ticket 1041: the tree's own ring (--ring-focus), not the window's blue
    const ringColour = getComputedStyle(probe).color;
    probe.remove();
    return { shadow: s.boxShadow, outline: `${s.outlineStyle} ${s.outlineColor}`, ringColour };
  });
  expect(`${ring.shadow} ${ring.outline}`).toContain(ring.ringColour);
  // Typing is not captured: a letter is not prevented and moves nothing.
  await app.evaluate(() => window.addEventListener('keydown', (e) => setTimeout(() => ((window as unknown as { __typed: boolean }).__typed = e.defaultPrevented)), { once: true }));
  await app.keyboard.press('KeyX');
  await expect.poll(() => app.evaluate(() => (window as unknown as { __typed?: boolean }).__typed)).toBe(false);
  await focused(wtRow(app, 'b-one'));
});

test('tree_enter_opens_row_left_right_fold_unfold', async ({ app, core }) => {
  await setup(app, core);
  await head(app, 'alpha').focus();
  // Left folds an open project; a top-level head has no parent, so Left again stays.
  await app.keyboard.press('ArrowLeft');
  await expect(chev(app, 'alpha')).toHaveAttribute('aria-expanded', 'false');
  await expect(grp(app, 'alpha').locator('button.row.wt2')).toHaveCount(0);
  await focused(head(app, 'alpha'));
  await app.keyboard.press('ArrowLeft');
  await focused(head(app, 'alpha'));
  // Right on an open row moves to its first child; Right on a folded one unfolds it, then moves in.
  await app.keyboard.press('ArrowRight');
  await expect(chev(app, 'alpha')).toHaveAttribute('aria-expanded', 'true');
  await focused(head(app, 'alpha'));
  await app.keyboard.press('ArrowRight');
  await focused(mainRow(app)); // the first child is the main folder's own row
  // Left on a leaf moves to its parent.
  await app.keyboard.press('ArrowLeft');
  await focused(head(app, 'alpha'));
  // Enter on a project toggles its fold.
  await app.keyboard.press('Enter');
  await expect(chev(app, 'alpha')).toHaveAttribute('aria-expanded', 'false');
  await app.keyboard.press('Enter');
  await expect(chev(app, 'alpha')).toHaveAttribute('aria-expanded', 'true');
  // Enter on a session row opens it as a click does (it becomes the current session).
  await app.keyboard.press('ArrowDown');
  const target = wtRow(app, 'a-one');
  while (!(await target.evaluate((e) => e === document.activeElement))) await app.keyboard.press('ArrowDown');
  await app.keyboard.press('Enter');
  await expect(target).toHaveAttribute('aria-current', 'true');
});

test('tree_keynav_ignored_while_rename_or_menu_has_focus', async ({ app, core }) => {
  await setup(app, core);
  const row = wtRow(app, 'a-two');
  await row.focus();
  await app.keyboard.press('F2');
  const field = app.locator('.wtrename input');
  await expect(field).toBeFocused();
  for (const k of ['ArrowDown', 'ArrowUp', 'Home', 'End', 'ArrowLeft', 'ArrowRight']) await app.keyboard.press(k);
  await expect(field).toBeFocused();
  await expect(chev(app, 'alpha')).toHaveAttribute('aria-expanded', 'true');
  await app.keyboard.press('Escape');
  await focused(row);
  // The row's menu has the focus (opened by key): its arrows move its own items, no row.
  await app.keyboard.press('Shift+F10');
  const menu = app.getByRole('menu', { name: 'Actions' });
  await expect(menu).toBeFocused();
  const at = await menu.getAttribute('aria-activedescendant');
  await app.keyboard.press('ArrowDown');
  await expect(menu).not.toHaveAttribute('aria-activedescendant', at ?? '');
  await expect(menu).toBeFocused();
  await app.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await focused(row);
  // Back on the row, the arrows move between rows again.
  const [first, second] = await alphaRows(app);
  const other = (await first.evaluate((e) => e.textContent?.includes('a-two'))) ? second : first;
  await app.keyboard.press((await first.evaluate((e) => e.textContent?.includes('a-two'))) ? 'ArrowDown' : 'ArrowUp');
  await focused(other);
});

test('tree_keynav_pure_next_index_skips_folded_children', async () => {
  const { navMove } = await import('../src/tree/keynav');
  // Visible rows only: a folded project's children are not in the list.
  const rows = [
    { level: 0, open: true }, // 0 group
    { level: 1, open: false }, // 1 folded project
    { level: 1, open: true }, // 2 open project
    { level: 2 }, // 3 its worktree
    { level: 2, open: false }, // 4 a session with folded children
    { level: 1, open: true }, // 5 open project with no visible child
  ];
  expect(navMove(rows, 1, 'ArrowDown')).toEqual({ focus: 2 }); // past the folded project, not into it
  expect(navMove(rows, 1, 'ArrowRight')).toEqual({ toggle: 1 }); // unfolds, never jumps to the sibling
  expect(navMove(rows, 2, 'ArrowRight')).toEqual({ focus: 3 }); // open: its first child
  expect(navMove(rows, 5, 'ArrowRight')).toBeNull(); // open, nothing under it
  expect(navMove(rows, 4, 'ArrowLeft')).toEqual({ focus: 2 }); // folded: to its parent
  expect(navMove(rows, 3, 'ArrowLeft')).toEqual({ focus: 2 }); // leaf: to its parent
  expect(navMove(rows, 2, 'ArrowLeft')).toEqual({ toggle: 2 }); // open: folds
  expect(navMove(rows, 0, 'ArrowLeft')).toEqual({ toggle: 0 });
  expect(navMove([{ level: 0, open: false }], 0, 'ArrowLeft')).toBeNull(); // top level: no parent
  expect(navMove(rows, 0, 'ArrowUp')).toBeNull(); // wrapping is off
  expect(navMove(rows, 5, 'ArrowDown')).toBeNull();
  expect(navMove(rows, 3, 'Home')).toEqual({ focus: 0 });
  expect(navMove(rows, 3, 'End')).toEqual({ focus: 5 });
  expect(navMove(rows, 3, 'KeyX')).toBeNull(); // typing is not captured
});

// V2.5-61: the key names live in keynav.ts (Sidebar.tsx holds no key-name string); each key keeps the action it had.
test('keynav_key_mapping', async () => {
  const { navKey } = await import('../src/tree/keynav');
  for (const k of ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End']) expect(navKey(k), k).toBe('move');
  expect(navKey('Enter')).toBe('enter');
  for (const k of ['a', ' ', 'Tab', 'Escape', 'PageDown', 'F2', 'Delete']) expect(navKey(k), k).toBeNull();
});
