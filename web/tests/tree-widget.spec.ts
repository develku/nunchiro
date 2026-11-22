// needs 157 (2), ticket 174 finding 12, placement item 2: the Tree is a widget. It sits on either icon bar or in a main
// zone as its own column next to the session, moved by the same Layout drag as other widgets; it stays required (no ✕,
// the remove area refuses it) and there is never more than one. Tree rows, folds and colours do not change (TREEROWS).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import type { Page } from '@playwright/test';
import { cleanBars, defaultBars, withTree } from '../src/layout/bars';
import { apply, defaultLayout } from '../src/layout/model';
import { expect, openWindow, test, type Core } from './fixtures';
import { at, bar, barBefore, barEnd, card, drag, endEdit, icon, layoutFile, names, pageErrors, readLayout, startEdit, stored, toast, zone, zones } from './d5b';
import { openQuiet } from './tree-seed';
import * as SHELL from '../src/i18n/areas/shell';

const KEY = 'nunchiro.settings.v1';
/** A layout.toml with the Tree as a column left of the centre column. */
const TREE_ZONE = `version = 1
locked = false

[root]
id = "main"
split = "row"

[[root.children]]
id = "tree"
size = 264
widgets = ["tree"]

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
/** The same with two more Trees (a hand edit): a zone on the right and a tab in the terminal zone. */
const THREE_TREES = `${TREE_ZONE.replace('widgets = ["terminal"]', 'widgets = ["terminal", "tree"]')}
[[root.children]]
id = "tree-2"
size = 220
widgets = ["tree"]
`;

/** Trees on screen: bar icons, tree zones and rendered trees. */
const trees = async (app: Page) => ({
  icons: await app.locator('nav.ib [data-icon="tree"]').count(),
  zones: await app.locator('.lz:has(> .wg[data-widget="tree"])').count(),
  rendered: await app.locator('.tree').count(),
});
const treeLines = (core: Core) => (readLayout(core).match(/^widgets = \[.*"tree".*\]$/gm) ?? []).length;
/** The left edge of the terminal zone, inside the window-edge band: the Tree lands as its own column next to it. */
const terminalEdge = async (app: Page) => {
  const p = await at(app, 'terminal', 0, 0.5);
  return { x: p.x + 4, y: p.y };
};
const toZone = async (app: Page) => {
  await drag(app, icon(app, 'left', 'Tree'), await terminalEdge(app));
  await expect(zone(app, 'tree')).toBeVisible();
};

test('tree_widget_drag_to_main', async ({ app, core }) => {
  const errors = pageErrors(app);
  await openWindow(app);
  await startEdit(app); // the visible "Layout" button
  await drag(app, icon(app, 'left', 'Tree'), await terminalEdge(app), { release: false });
  // The compass names the drop; no refusal.
  await expect(app.locator('.dropprev')).toHaveAttribute('data-error', 'false');
  await expect(app.locator('.dropprev')).toContainText('Tree · new zone at the left edge');
  await app.mouse.up();
  await expect(zone(app, 'tree').locator('.tree')).toBeVisible();
  // Its own column next to the session: left of the terminal, as tall as the session's column (terminal, strip, composer).
  const [t, s, main] = [(await zone(app, 'tree').boundingBox())!, (await zone(app, 'terminal').boundingBox())!, (await app.locator('[data-node-id="centre"]').boundingBox())!];
  expect(t.x + t.width).toBeLessThanOrEqual(s.x + 1);
  expect(Math.abs(t.height - main.height)).toBeLessThan(2);
  expect(await names(app, 'left')).not.toContain('Tree');
  expect(await names(app, 'right')).not.toContain('Tree');
  await expect(toast(app)).toContainText('Tree moved to the main area');
  await expect(card(app, 'tree')).toContainText('In layout');
  await endEdit(app);
  await expect.poll(() => treeLines(core)).toBe(1);
  expect(await trees(app)).toEqual({ icons: 0, zones: 1, rendered: 1 });
  // A reload keeps it there (layout.toml and the stored bars agree).
  await app.reload();
  await expect(zone(app, 'tree').locator('.tree')).toBeVisible();
  expect(await trees(app)).toEqual({ icons: 0, zones: 1, rendered: 1 });
  expect(errors).toEqual([]);
});

test('tree_widget_back_to_bar', async ({ app, core }) => {
  await openWindow(app);
  await startEdit(app);
  await toZone(app);
  // By its zone's grip onto the Right bar: the zone goes, the icon opens its sidebar there.
  await drag(app, zone(app, 'tree').locator('.zl'), await barEnd(app, 'right'));
  expect(await names(app, 'right')).toContain('Tree');
  expect(await names(app, 'left')).not.toContain('Tree');
  expect(await zones(app)).toEqual(['terminal', 'composer']);
  expect(await trees(app)).toEqual({ icons: 1, zones: 0, rendered: 1 });
  await drag(app, icon(app, 'right', 'Tree'), await barBefore(app, 'left', 0));
  expect((await names(app, 'left'))[0]).toBe('Tree');
  expect(await names(app, 'right')).not.toContain('Tree');
  expect(await trees(app)).toEqual({ icons: 1, zones: 0, rendered: 1 });
  await endEdit(app);
  await expect.poll(() => readLayout(core)).not.toContain('"tree"');
});

test('tree_widget_required', async ({ app, core }) => {
  await openWindow(app);
  await startEdit(app);
  // On a bar: no ✕, no tag (needs 162), the remove area refuses it.
  await expect(bar(app, 'left').getByRole('button', { name: /Remove Tree/ })).toHaveCount(0);
  await expect(bar(app, 'left').locator('.req')).toHaveCount(0); // needs 162 replaces needs 100's tag
  await drag(app, icon(app, 'left', 'Tree'), app.locator('[data-remove-area]'));
  await expect(toast(app)).toContainText('Tree is required and cannot be removed');
  expect(await names(app, 'left')).toEqual(['Tree', 'Files', 'Search', 'Settings']);
  // In a zone: no ✕ on its header, and its grip dropped on the remove area is refused with the same text.
  await toZone(app);
  await expect(app.getByRole('button', { name: /^Remove Tree/ })).toHaveCount(0);
  const before = { bars: JSON.stringify((await stored(app)).bars), zones: await zones(app) };
  await drag(app, zone(app, 'tree').locator('.zl'), app.locator('[data-remove-area]'), { release: false });
  await expect(app.locator('.dropprev[data-error="true"]')).toContainText('Tree is required and cannot be removed');
  await app.mouse.up();
  await expect(toast(app)).toContainText('Tree is required and cannot be removed');
  expect({ bars: JSON.stringify((await stored(app)).bars), zones: await zones(app) }).toEqual(before);
  await endEdit(app);
  await expect.poll(() => treeLines(core)).toBe(1);
});

test('tree_widget_one_only', async ({ app, core }) => {
  // Pure: the layout model never places a second Tree (drag, library, `nunchiro layout`).
  const one = apply(defaultLayout(), { op: 'edge', dir: 'left', widget: 'tree' });
  for (const op of [{ op: 'stack', widget: 'tree', zone: 'terminal' }, { op: 'split', dir: 'right', widget: 'tree', zone: 'terminal' }, { op: 'edge', dir: 'right', widget: 'tree' }, { op: 'add', widget: 'tree' }] as const)
    expect(() => apply(one, op), op.op).toThrow('There is only one Tree: move it from where it is');
  // Drag: with the Tree in a zone, its library card over another zone is refused and the drop adds nothing.
  await openWindow(app);
  await startEdit(app);
  await toZone(app);
  await card(app, 'tree').scrollIntoViewIfNeeded();
  await drag(app, card(app, 'tree'), await at(app, 'terminal', 0.5, 0.5), { release: false });
  await expect(app.locator('.dropprev[data-error="true"]')).toContainText('There is only one Tree');
  await app.mouse.up();
  expect(await trees(app)).toEqual({ icons: 0, zones: 1, rendered: 1 });
  // Library: Enter on the card moves it (the zone goes), never copies it.
  await card(app, 'tree').focus();
  await app.keyboard.press('Enter');
  await expect(zone(app, 'tree')).toHaveCount(0);
  expect(await trees(app)).toEqual({ icons: 1, zones: 0, rendered: 1 });
  await endEdit(app);
  // Layout command: `nunchiro layout edge left tree` with the Tree on a bar moves it into the zone (the icon leaves).
  core.cli('layout', 'edge', 'left', 'tree');
  await expect(zone(app, 'tree')).toBeVisible();
  await expect.poll(() => trees(app)).toEqual({ icons: 0, zones: 1, rendered: 1 });
  // A second one is refused.
  const said = (() => {
    try {
      return JSON.stringify(core.cli('layout', 'stack', 'tree', '--zone', 'terminal'));
    } catch (e) {
      return String(e);
    }
  })();
  expect(said).toContain('There is only one Tree');
  expect(treeLines(core)).toBe(1);
});

test('tree_widget_one_only (hand-edited file with three)', async ({ app, core }) => {
  const errors = pageErrors(app);
  fs.writeFileSync(layoutFile(core), THREE_TREES);
  await openWindow(app);
  await expect(app.locator('.lnote', { hasText: 'layout.toml had 3 Trees: kept the first, removed 2' })).toBeVisible();
  await expect.poll(() => trees(app)).toEqual({ icons: 0, zones: 1, rendered: 1 });
  expect(await zones(app)).toEqual(['tree', 'terminal', 'waiting', 'composer']);
  await expect.poll(() => treeLines(core)).toBe(1);
  expect(errors).toEqual([]);
});

test('tree_zone_layout_kept_on_load', async ({ app, core }) => {
  const errors = pageErrors(app);
  fs.writeFileSync(layoutFile(core), TREE_ZONE);
  await openWindow(app);
  await expect(zone(app, 'tree').locator('.tree')).toBeVisible();
  expect(await zones(app)).toEqual(['tree', 'terminal', 'waiting', 'composer']);
  // The zone wins over the stored bar icon (the default bars have one): a move, never a copy; no removal notice.
  await expect.poll(() => trees(app)).toEqual({ icons: 0, zones: 1, rendered: 1 });
  await app.waitForTimeout(300);
  await expect(app.locator('.lnote')).toHaveCount(0);
  expect(treeLines(core)).toBe(1);
  expect(errors).toEqual([]);
});

test('tree_zone_never_folds_away', async ({ app, core }) => {
  // V1A-60 folds side panels while the session has under 80 columns, but only panels an icon can show again. A Tree in a
  // zone has no icon, so it stays on screen in a narrow window (the session gets narrower instead).
  fs.writeFileSync(layoutFile(core), TREE_ZONE);
  core.shell(core.project('demo'), 'narrow');
  await app.setViewportSize({ width: 900, height: 700 });
  await openWindow(app);
  await expect(app.locator('.term .xterm').first()).toBeVisible(); // a terminal to measure: folding counts its columns
  await expect(zone(app, 'tree').locator('.tree')).toBeVisible();
  // A sidebar opened after it is the newest panel, so the older Tree zone would be the one to fold.
  await icon(app, 'right', 'Diff').click();
  await expect(app.locator('aside.sbar[data-side="right"]')).toBeVisible();
  await app.waitForTimeout(600); // the fold check runs after layout settles
  await expect(zone(app, 'tree')).toBeVisible();
  await expect(app.locator('.foldnote')).not.toContainText('Tree');
});

test('tree_zone_boot_no_flicker', async ({ app, core }) => {
  // Round 2: the window's layout is the default until layout.toml arrives, so a reconcile run before that put the Tree
  // on the Left bar for a moment and, with both bars full, pushed an optional icon off for good.
  fs.writeFileSync(layoutFile(core), TREE_ZONE);
  const full = {
    ...defaultBars(),
    left: ['files', 'search', 'widget:a', 'widget:b', 'widget:c', 'widget:d', 'widget:e', 'widget:f', 'widget:g', 'settings'],
    right: ['board', 'decisions', 'terminal', 'browser', 'diff', 'artifacts', 'widget:h', 'widget:i', 'widget:j', 'layout'],
    active: { left: null, right: null },
  };
  await app.addInitScript(([k, v]) => {
    localStorage.setItem(k as string, JSON.stringify(v));
    // Watches the page from its first node: did a Tree icon ever appear on a bar?
    const w = window as unknown as { treeIcon: boolean };
    w.treeIcon = false;
    new MutationObserver(() => (w.treeIcon ||= !!document.querySelector('nav.ib [data-icon="tree"]'))).observe(document, { childList: true, subtree: true });
  }, [KEY, { bars: full }] as const);
  await openWindow(app);
  await expect(zone(app, 'tree').locator('.tree')).toBeVisible();
  await app.reload();
  await expect(zone(app, 'tree').locator('.tree')).toBeVisible();
  await app.waitForTimeout(500);
  expect(await app.evaluate(() => (window as unknown as { treeIcon: boolean }).treeIcon)).toBe(false);
  // Every icon is still in its slot, in the store and on screen.
  expect((await stored(app)).bars.left).toEqual(full.left);
  expect((await stored(app)).bars.right).toEqual(full.right);
  expect((await names(app, 'left')).length + (await names(app, 'right')).length).toBe(20);
});

test('tree_zone_title', async ({ app, core }) => {
  // Like Files or Diff in a zone, the Tree zone opens with a title row; Layout's zone header reads its display name.
  fs.writeFileSync(layoutFile(core), TREE_ZONE.replace('size = 264', 'size = 200'));
  await openWindow(app);
  await expect(zone(app, 'tree').locator('.ph').first()).toHaveText('Tree');
  // At the default 200 px the Tree's own "Projects" row holds its two buttons: neither spills onto the rows below.
  const row = (await zone(app, 'tree').locator('.dock > .ph').boundingBox())!;
  for (const sel of ['.addproj', '.xall']) {
    const b = (await zone(app, 'tree').locator(sel).boundingBox())!;
    expect(b.y + b.height, sel).toBeLessThanOrEqual(row.y + row.height + 1);
  }
  await startEdit(app);
  await expect(zone(app, 'tree').locator('.zl b')).toHaveText('Tree');
});

test('tree_card_wording', async ({ app }) => {
  // The approved placement design (item 2, mockup m2) words the card "In layout · movable · kept" (needs 162 replaced "agent list").
  for (const lang of ['en', 'ko', 'ja', 'zhHans', 'zhHant', 'es', 'fr', 'pt'] as const) expect((SHELL[lang] as Record<string, string>)['shell.tree.card'], lang).toBeTruthy();
  await openWindow(app);
  await startEdit(app);
  // Ticket 991 A19 (226fa16f) put the plain words in place of the dotted shorthand.
  await expect(card(app, 'tree')).toContainText('Always in the layout; you can move it');
  await expect(card(app, 'tree')).not.toContainText('waiting slots');
});

test('tree_card_wording (ko)', async ({ app }) => {
  // The card follows the window's language like the rest of Layout (the library sits outside the chat's provider).
  await openWindow(app); // connects in English (the fixture waits for its English status line)
  await app.evaluate((k) => localStorage.setItem(k, JSON.stringify({ ...JSON.parse(localStorage.getItem(k) ?? '{}'), language: 'ko' })), KEY);
  await app.reload();
  await expect(app.locator('html')).toHaveAttribute('lang', 'ko');
  await app.locator('nav[data-bar="right"] .lay').click(); // the visible Layout button (its label is Korean now)
  await expect(card(app, 'tree')).toContainText((SHELL.ko as Record<string, string>)['shell.tree.card']);
});

test('tree_width_default', async ({ app, core }) => {
  // The approved frame draws the Tree column 200 px wide; a width the user dragged stays (it is the zone's size).
  await openWindow(app);
  await startEdit(app);
  await toZone(app);
  expect(Math.abs((await zone(app, 'tree').boundingBox())!.width - 200)).toBeLessThanOrEqual(2);
  await endEdit(app);
  await expect.poll(() => readLayout(core)).toMatch(/id = "tree"\nsize = 200\n/);
  fs.writeFileSync(layoutFile(core), TREE_ZONE.replace('size = 264', 'size = 310'));
  await app.reload();
  await expect(zone(app, 'tree').locator('.tree')).toBeVisible();
  expect(Math.abs((await zone(app, 'tree').boundingBox())!.width - 310)).toBeLessThanOrEqual(2);
});

test('tree_missing_everywhere_restored', async ({ app, core }) => {
  // Pure: stored bars with no Tree are kept as stored (it may be in a zone); withTree puts it back on the Left bar, in its
  // first slot when free, else the first free one; with both bars full it takes the last optional left icon's slot.
  const none = { ...defaultBars(), left: defaultBars().left.map((x) => (x === 'tree' ? null : x)), active: { left: null, right: null } };
  expect(cleanBars(none)!.left).toEqual(none.left);
  expect(withTree(none)!.left.slice(0, 3)).toEqual(['tree', 'files', 'search']);
  const first = { ...none, left: none.left.map((x, i) => (i === 0 ? 'files' : x === 'files' ? null : x)) };
  expect(withTree(first)!.left.filter(Boolean)).toEqual(['files', 'tree', 'search', 'settings']);
  const full = { ...none, left: none.left.map((x) => x ?? 'widget:a'), right: none.right.map((x) => x ?? 'widget:b') };
  expect(withTree(full).left).toEqual([...full.left.slice(0, 8), 'tree', 'settings']);
  // A window whose settings have no Tree on a bar, and no tree zone: the Tree is on the Left bar.
  await app.addInitScript(([k, v]) => localStorage.setItem(k as string, JSON.stringify(v)), [KEY, { bars: none }] as const);
  await openWindow(app);
  expect((await names(app, 'left'))[0]).toBe('Tree');
  expect(await trees(app)).toMatchObject({ icons: 1, zones: 0 });
  // The tree zone taken away from outside (`nunchiro layout remove tree`) while the Tree is on no bar: back on the Left bar.
  core.cli('layout', 'edge', 'left', 'tree');
  await expect.poll(() => trees(app)).toEqual({ icons: 0, zones: 1, rendered: 1 });
  core.cli('layout', 'remove', 'tree');
  await expect.poll(() => trees(app)).toMatchObject({ icons: 1, zones: 0 });
  expect((await names(app, 'left'))[0]).toBe('Tree');
});

// ---- rows in a zone match the bar (tree-rows.spec.ts selectors; the socket is proxied to patch one session waiting).
const gitRepo = (core: Core, name: string) => {
  const p = core.project(name);
  const git = (...a: string[]) => execFileSync('git', ['-C', p, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a]);
  git('init', '-q');
  git('commit', '-q', '--allow-empty', '-m', 'init');
  return p;
};
const wtSession = (core: Core, project: string, label: string) => core.cli('session', 'start', '--kind', 'shell', '--project', project, '--label', label, '--worktree', '--', '/bin/cat');
async function waitingOn(app: Page, label: string) {
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => server.send(m));
    server.onMessage((m) => {
      if (typeof m !== 'string' || JSON.parse(m).event !== 'snapshot') return ws.send(m);
      const msg = JSON.parse(m);
      for (const s of msg.sessions ?? [])
        if (s.label === label) {
          Object.assign(s.attention, { working: false, waiting: true, last_activity: Date.now() - 600_000 });
          s.pending = [{ id: `d-${label}`, session_id: s.id, scope: s.project, kind: 'permission', text: `Run ${label}?\nsecond line`, choices: [], observed_at: Date.now() - 120_000, actionable: true }];
        }
      ws.send(JSON.stringify(msg));
    });
  });
}
/** What a row looks like, width aside (a zone and a sidebar differ in width only). */
const rowLook = (app: Page) =>
  app.locator('.tree .row').evaluateAll((els) =>
    els.map((e) => {
      const c = getComputedStyle(e);
      const ic = e.querySelector('.ic');
      return { cls: e.className, kind: (e as HTMLElement).dataset.kind ?? '', text: e.textContent, h: Math.round(e.getBoundingClientRect().height), bg: c.backgroundColor, font: c.font, pad: c.paddingLeft, rail: getComputedStyle(e, '::before').backgroundColor, ic: ic ? getComputedStyle(ic).color : '' };
    }),
  );

test('tree_in_zone_rows_unchanged', async ({ app, core }) => {
  const errors = pageErrors(app);
  const p = gitRepo(core, 'repo');
  for (const l of ['asks', 'idle']) wtSession(core, p, l);
  core.shell(core.project('other'), 'other-shell');
  openQuiet(core);
  await waitingOn(app, 'asks');
  await openWindow(app);
  const grp = app.locator('.grp[data-project="repo"]');
  await expect(grp.locator('.row.wt2')).toHaveCount(2);
  await expect(grp.locator('.q')).toHaveCount(1); // the waiting row's decision line
  await app.waitForTimeout(400); // waiting rows slide in over 150 ms
  const open = await rowLook(app);
  await grp.getByRole('button', { name: 'Collapse repo' }).click();
  const folded = await rowLook(app);
  await grp.getByRole('button', { name: /Expand repo/ }).click();
  await startEdit(app);
  await toZone(app);
  await endEdit(app);
  const z = zone(app, 'tree');
  await expect(z.locator('.grp[data-project="repo"] .row.wt2')).toHaveCount(2);
  await app.waitForTimeout(400);
  expect(await rowLook(app)).toEqual(open);
  await z.getByRole('button', { name: 'Collapse repo' }).click();
  expect(await rowLook(app)).toEqual(folded);
  await z.getByRole('button', { name: /Expand repo/ }).click();
  // The waiting row's peek opens in the zone as on the bar.
  await z.locator('.q [data-act="peek"]').first().click();
  await expect(app.locator('.peek')).toBeVisible();
  await app.keyboard.press('Escape');
  // A library card dropped on a project row in the zone nests under it.
  await startEdit(app);
  const head = z.locator('.row.head[data-project-path]').filter({ hasText: 'other' });
  await card(app, 'agents').scrollIntoViewIfNeeded();
  await drag(app, card(app, 'agents'), head, { release: false });
  await expect(head).toHaveAttribute('data-hot', '');
  await app.mouse.up();
  await expect(z.locator('.grp[data-project="other"] .view[data-view="agents"]')).toBeVisible();
  expect(errors).toEqual([]);
});
