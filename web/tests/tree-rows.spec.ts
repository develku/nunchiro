// TREEROWS: rows with a rail and one icon. Icons render node side; the live tree is driven through the real core.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import type { Locator, Page } from '@playwright/test';
import { expect, test as plain } from '@playwright/test';
import { boxes, openWindow, test, unmoved, type Core } from './fixtures';
import { seed } from './tree-seed';
import { ICONS, RowIcon } from '../src/tree/RowIcon';
const test0 = plain;

test0('row_icon_per_state: eight states plus stale give distinct svg, each on currentColor; the spinner has the .arc', () => {
  const html = ICONS.map((k) => renderToStaticMarkup(createElement(RowIcon, { kind: k })));
  expect(ICONS).toEqual(['hand', 'ask', 'fail', 'work', 'pr', 'merge', 'new', 'gone', 'stale', 'idle', 'limit', 'done', 'rest']); // ticket 372: the limit clock; look 1117 v11 A-S3-6: a finished row's check; ticket 1022: the just-finished ring
  expect(new Set(html).size).toBe(ICONS.length);
  for (const h of html) {
    expect(h).toMatch(/^<svg /);
    expect(h).toContain('stroke="currentColor"');
  }
  expect(html[ICONS.indexOf('work')]).toContain('class="arc"');
  expect(html.filter((h) => h.includes('class="arc"'))).toHaveLength(1);
});

// ---- the live tree. The core cannot make a session "working" or leave one idle on demand, so the window's socket is
// proxied and each session's attention and pending items are patched by label (the tree is a pure view of the snapshot).
type Patch = { working?: boolean; stale?: boolean; failed?: boolean; waiting?: 'permission' | 'question' | 'dialog'; at?: number; state?: string };
const ago = (ms: number) => Date.now() - ms;
/** Ticket 388: a head's colour strip as "tone+count" per colour (one bar per session; red, orange, yellow, blue, grey). */
const strip = (head: Locator) => head.locator(':scope > .cstrip > .sg').evaluateAll((es) => es.map((e) => `${(e as HTMLElement).dataset.tone}${(e as HTMLElement).dataset.n}`).join(' '));

async function patchSnapshots(app: Page) {
  const patches = new Map<string, Patch>();
  let last = '';
  const sockets: { send(m: string): void }[] = [];
  const apply = (raw: string) => {
    const msg = JSON.parse(raw);
    for (const s of msg.sessions ?? []) {
      const p = patches.get(s.label);
      if (!p) continue;
      Object.assign(s.attention, { working: !!p.working, stale: !!p.stale, failed: !!p.failed, waiting: !!p.waiting, last_activity: ago(10 * 60_000) });
      if (p.state) s.state = p.state;
      if (p.waiting)
        s.pending = [{ id: `d-${s.label}`, session_id: s.id, scope: s.project, kind: p.waiting, text: `Run ${s.label}?\nsecond line`, choices: [], observed_at: p.at ?? ago(180_000), actionable: true }];
    }
    return JSON.stringify(msg);
  };
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    sockets.push(ws);
    ws.onMessage((m) => server.send(m));
    server.onMessage((m) => {
      if (typeof m === 'string' && JSON.parse(m).event === 'snapshot') ws.send(apply((last = m)));
      else ws.send(m);
    });
  });
  return {
    set(label: string, p: Patch) {
      patches.set(label, p);
      if (last) for (const ws of sockets) ws.send(apply(last));
    },
  };
}

const gitRepo = (core: Core, name: string) => {
  const p = core.project(name);
  const git = (...a: string[]) => execFileSync('git', ['-C', p, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a]);
  git('init', '-q');
  git('commit', '-q', '--allow-empty', '-m', 'init');
  return p;
};
/** A shell session in its own worktree; its row is named after that worktree. */
const wtSession = (core: Core, project: string, label: string) =>
  core.cli('session', 'start', '--kind', 'shell', '--project', project, '--label', label, '--worktree', '--', '/bin/cat').session as { id: string; cwd: string };

/** Five worktrees: asks (question, newer), perm (permission, older), broke, busy, quiet; plus the main folder. */
async function five(app: Page, core: Core, project = 'repo') {
  const p = gitRepo(core, project);
  const ids = Object.fromEntries(['quiet', 'busy', 'broke', 'asks', 'perm'].map((l) => [l, wtSession(core, p, l)]));
  core.shell(p, 'main-shell');
  const patch = await patchSnapshots(app);
  await openWindow(app);
  patch.set('perm', { waiting: 'permission', at: ago(300_000) });
  patch.set('asks', { waiting: 'question', at: ago(60_000) });
  patch.set('broke', { failed: true });
  patch.set('busy', { working: true });
  await expect(rowsOf(app, project)).toHaveCount(5);
  await app.waitForTimeout(400); // the waiting rows slide in over 150 ms
  return { p, ids, patch };
}
// Worktree rows only: an idle main-folder session has a `treerow` row of its own since v25-new-tab (needs 213).
const rowsOf = (app: Page, project = 'repo') => app.locator(`.grp[data-project="${project}"] .row.wt2:not([data-menu="treerow"])`);
const kinds = (rows: Locator) => rows.evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.kind));
const css = (l: Locator, prop: string) => l.evaluate((e, p) => getComputedStyle(e).getPropertyValue(p), prop);

test('rows_in_urgency_order: your turn (oldest first), broken, then the rest as first seen; a row does not move when its session starts or stops working (991 A12); the order holds while the pointer is over the project', async ({ app, core }) => {
  const { ids, patch } = await five(app, core);
  const rows = rowsOf(app);
  await expect(rows).toHaveCount(5);
  await expect.poll(() => kinds(rows)).toEqual(['hand', 'ask', 'fail', 'idle', 'work']);
  // The oldest decision (perm, 5 min) leads the newer one (asks, 1 min); the idle and the working row stay as first seen.
  await expect(rows.first()).toContainText('perm');
  // 991 A12: the working row rests, the resting row works: neither moves.
  const first = await rows.evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.menuSession));
  patch.set('busy', {});
  patch.set('quiet', { working: true });
  await expect.poll(() => kinds(rows)).toEqual(['hand', 'ask', 'fail', 'work', 'idle']);
  expect(await rows.evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.menuSession))).toEqual(first);
  patch.set('busy', { working: true });
  patch.set('quiet', {});
  await expect.poll(() => kinds(rows)).toEqual(['hand', 'ask', 'fail', 'idle', 'work']);
  // needs 49: with the pointer in the tree nothing moves, even when the idle row turns into the oldest your-turn row.
  await app.locator('.grp[data-project="repo"] .head .n').hover();
  const before = await boxes(app);
  const order = () => rows.evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.menuSession));
  const held = await order();
  patch.set('quiet', { waiting: 'permission', at: ago(600_000) });
  await app.waitForTimeout(800);
  expect(await order()).toEqual(held);
  expect(unmoved(before, await boxes(app))).toEqual([]);
  // Out of the tree the new order applies: the quiet row is first (oldest decision).
  await app.mouse.move(900, 600);
  await expect.poll(order).toEqual([ids.quiet.id, ...held.slice(0, 3), held[4]]);
  await expect.poll(() => kinds(rows)).toEqual(['hand', 'hand', 'ask', 'fail', 'work']);
});

// Ticket 462 (owner 11-12): icons take the approved 388 mockup's palette (--tree-*). Ticket 1041 (C): the rail and the
// --you-bg tint are gone; the state is a light in the --light-* colours (your turn: a warm edge and wash on its block).
test('your_turn_orange_tinted_broken_red_untinted: the state lights and icon colours come from the tokens in both themes', async ({ app, core }) => {
  await five(app, core);
  for (const theme of ['light', 'dark']) {
    await app.emulateMedia({ colorScheme: theme as 'light' | 'dark' }); // the app's theme engine follows the OS scheme
    await expect(app.locator('html')).toHaveAttribute('data-theme', theme);
    const probe = (c: string) => app.evaluate((v) => { const d = document.createElement('i'); d.style.color = v; document.querySelector('.tree')!.append(d); const r = getComputedStyle(d).color; d.remove(); return r; }, c);
    const row = (k: string) => app.locator(`.grp[data-project="repo"] .row.wt2[data-kind="${k}"]`).first();
    expect(await css(row('fail'), 'background-color')).toBe('rgba(0, 0, 0, 0)');
    for (const k of ['hand', 'fail', 'work']) expect(await row(k).evaluate((e) => getComputedStyle(e, '::before').content), `${k}: no rail`).toBe('none');
    // Design book: your turn is the warm dot and the warm wash on its block (the row, or the row and its decision line);
    // failed and working are their dots, no edge and no line.
    const block = row('hand').locator('xpath=ancestor-or-self::*[contains(concat(" ", normalize-space(@class), " "), " sess ")][1]');
    const own = (await block.count()) ? block : row('hand');
    const dot = (k: string) => row(k).locator('.sdot').evaluate((e) => getComputedStyle(e).backgroundColor);
    expect(await dot('hand')).toBe(await probe('var(--light-you)'));
    expect(await css(own, 'background-image')).toContain('linear-gradient');
    expect(await dot('fail')).toBe(await probe('var(--light-bad)'));
    expect(await dot('work')).toBe(await probe('var(--light-run)'));
    expect(await css(row('hand').locator('.sw'), 'color')).toBe(await probe('var(--you-text)')); // its word, no glyph
  }
});

test('tooltip_on_hover_focus_and_tap: first line bold, second normal; no row moves; Escape hides it', async ({ app, core, browserName }) => {
  await five(app, core);
  const row = app.locator('.grp[data-project="repo"] .row.wt2[data-kind="hand"]');
  const tip = row.locator('.tip');
  await expect(tip).toBeHidden();
  const before = await boxes(app);
  await row.hover();
  await expect(tip).toBeVisible();
  await expect(tip.locator('b')).toHaveText('Needs permission · Run perm?');
  await expect(tip).toContainText('Shell · asked 5 min ago');
  await expect(row).toHaveAttribute('aria-label', /^perm, Needs permission · Run perm\?\. Shell · asked 5 min ago$/);
  expect(unmoved(before, await boxes(app))).toEqual([]);
  await app.keyboard.press('Escape');
  await expect(tip).toBeHidden();
  await app.mouse.move(900, 600);
  await expect(tip).toBeHidden();
  // Keyboard focus.
  await row.focus();
  // V2-8e: the decision line's buttons follow the row (the old decision rows came before it).
  await app.keyboard.press('Tab');
  await app.keyboard.press('Shift+Tab');
  // WebKit's Tab skips buttons (no "Tab to links"): a key press then programmatic focus counts as focus-visible there.
  if (browserName === 'webkit') (await app.keyboard.press('Shift'), await row.blur(), await row.focus());
  await expect(tip).toBeVisible();
  expect(unmoved(before, await boxes(app))).toEqual([]);  // Look 1117 v3 (item 14): the pointer that passes over the row and goes on (to a menu, the right bar) takes the tip with it,
  // even while the row keeps the focus.
  await row.hover();
  await app.mouse.move(1400, 300);
  await expect(tip).toBeHidden();
});

// An agent's own terminal dialog (queue kind `dialog`, e.g. Claude's folder-trust prompt) is not a permission ask: its row title says
// what its decision card says, a prompt to answer in the session's terminal. A real permission item still reads "Needs permission".
test('dialog_row_title_is_terminal_prompt: a dialog item\'s row says "Prompt in the terminal", a permission item "Needs permission"', async ({ app, core }) => {
  const { ids, patch } = await five(app, core);
  patch.set('asks', { waiting: 'dialog', at: ago(60_000) });
  const row = (id: string) => app.locator(`.grp[data-project="repo"] .row.wt2[data-menu-session="${id}"]`);
  await expect(row(ids.asks.id)).toHaveAttribute('aria-label', /^asks, Prompt in the terminal · Run asks\?\. Shell · asked 1 min ago$/);
  await expect(row(ids.asks.id).locator('.tip b')).toHaveText('Prompt in the terminal · Run asks?');
  await expect(row(ids.perm.id)).toHaveAttribute('aria-label', /^perm, Needs permission · Run perm\?\. /);
});

test.describe('tap', () => {
  test.use({ hasTouch: true });
  test('tooltip_on_hover_focus_and_tap (touch): a tap shows it, a tap elsewhere hides it, nothing moves', async ({ app, core }) => {
    await five(app, core);
    const row = app.locator('.grp[data-project="repo"] .row.wt2[data-kind="fail"]');
    const before = await boxes(app);
    await row.tap();
    await expect(row.locator('.tip')).toBeVisible();
    await expect(row.locator('.tip b')).toHaveText('Agent failed');
    expect(unmoved(before, await boxes(app))).toEqual([]);
    await expect(row).not.toHaveAttribute('aria-current', 'true'); // the first tap only shows the tooltip
    await app.locator('.cbox, .term, body').first().tap({ position: { x: 700, y: 300 } });
    await expect(row.locator('.tip')).toBeHidden();
    // A tap while it shows opens the session.
    await row.tap();
    await expect(row.locator('.tip')).toBeVisible();
    await row.tap();
    await expect(row).toHaveAttribute('aria-current', 'true');
  });

  test('enter_after_a_touch_tap_opens_the_session: after a tap (tooltip hidden again), Enter on the same row opens', async ({ app, core }) => {
    await five(app, core);
    const row = app.locator('.grp[data-project="repo"] .row.wt2[data-kind="fail"]');
    await row.tap();
    await expect(row.locator('.tip')).toBeVisible();
    await expect(row).not.toHaveAttribute('aria-current', 'true');
    await app.keyboard.press('Escape'); // clears the tooltip; the stale touched ref made the next Enter show it again
    await expect(row.locator('.tip')).toBeHidden();
    await app.keyboard.press('Enter');
    await expect(row).toHaveAttribute('aria-current', 'true');
  });
});

// Design book: the working light is the row's breathing dot; reduced motion holds it still and it stays drawn.
test('spinner_static_under_reduced_motion: the working dot breathes normally and stands still when motion is reduced', async ({ app, core }) => {
  await five(app, core);
  const work = app.locator('.row.wt2[data-kind="work"]').first();
  await expect(work.locator('.arc')).toHaveCount(0);
  const light = () => work.locator('.sdot').evaluate((e) => ({ anim: getComputedStyle(e).animationName, opacity: getComputedStyle(e).opacity }));
  await expect.poll(async () => (await light()).anim).toBe('breathe');
  await app.emulateMedia({ reducedMotion: 'reduce' });
  await expect.poll(light).toEqual({ anim: 'none', opacity: '1' });
});

test('head_counts_split_orange_red: 2 waiting and 1 failed give an orange 2 and a red 1; stale is not in red; the label keeps every count', async ({ app, core }) => {
  const { p } = await five(app, core);
  const grp = app.locator(`.grp[data-project="repo"]`);
  await expect(grp.locator('.head .cstrip > .sg[data-tone="o"]')).toHaveAttribute('data-n', '2');
  await expect(grp.locator('.head .cstrip > .sg[data-tone="r"]')).toHaveAttribute('data-n', '1');
  await expect(grp.locator('.head .r')).toHaveAttribute('aria-label', /0 running|\d running, 1 working, 2 waiting, \d need attention/);
  await expect(grp.locator('.head .st')).toHaveCount(0);
  void p;
});

test('strip_on_every_head: an open project shows the strip too (needs 196); folded it shows one bar per session, red, orange, blue, grey', async ({ app, core }) => {
  await five(app, core);
  const grp = app.locator('.grp[data-project="repo"]');
  const head = grp.locator('> .row.head');
  // needs 196, ticket 388: every project head carries the strip, open (dimmed) or folded.
  await expect.poll(() => strip(head)).toBe('r1 o2 b1 g2');
  await expect(head.locator('.cstrip')).toHaveAttribute('data-dim', 'true');
  await grp.getByRole('button', { name: 'Collapse repo' }).click();
  // V2-8e (HIDEROWS, needs 95): folding hides only quiet rows; the two your-turn rows (perm, asks) stay.
  await expect(rowsOf(app)).toHaveCount(2);
  // 5 worktree sessions and the main folder's idle shell.
  expect(await strip(head)).toBe('r1 o2 b1 g2');
  await expect(head.locator('.cstrip')).not.toHaveAttribute('data-dim', /.*/);
});

test('strip_counts_from_three (eleven): a project with 11 idle sessions shows one grey bar and 11; the clean-up line has none', async ({ app, core }) => {
  const p = gitRepo(core, 'big');
  for (let i = 0; i < 11; i++) wtSession(core, p, `w${i}`);
  await openWindow(app);
  const grp = app.locator('.grp[data-project="big"]');
  await grp.getByRole('button', { name: 'Collapse big' }).click();
  expect(await strip(grp.locator('> .row.head'))).toBe('g11');
  await expect(grp.locator('.cstrip i')).toHaveCount(1);
  await expect(grp.locator('.cstrip .num')).toHaveText('11');
  await expect(app.locator('.cleanup .cstrip')).toHaveCount(0);
});

test('decision_rows_stay_under_folded_headers: a folded project keeps its answerable rows; 3 waiting show 2 rows and +1', async ({ app, core }) => {
  const p = gitRepo(core, 'repo');
  for (const l of ['a', 'b', 'c']) wtSession(core, p, l);
  const patch = await patchSnapshots(app);
  await openWindow(app);
  for (const l of ['a', 'b', 'c']) patch.set(l, { waiting: 'permission' });
  const grp = app.locator('.grp[data-project="repo"]');
  // V2-8e (HIDEROWS): open, each your-turn worktree row carries its own line; folded, two show and "+1 waiting".
  await expect(grp.locator('.q')).toHaveCount(3);
  await grp.getByRole('button', { name: 'Collapse repo' }).click();
  await expect(grp.locator('.q')).toHaveCount(2);
  await expect(grp.locator('.more')).toHaveText('+1 waiting');
  await app.evaluate(() => {
    (window as unknown as { focused: unknown[] }).focused = [];
    window.addEventListener('nunchiro:queue.focus', (e) => (window as unknown as { focused: unknown[] }).focused.push((e as CustomEvent).detail));
  });
  // DECISIONW: the row opens the Decisions widget (right sidebar; it lists every session's card) instead of the strip card.
  await grp.locator('.q').first().click();
  expect(await app.evaluate(() => (window as unknown as { focused: unknown[] }).focused)).toHaveLength(0);
  await expect(app.locator('aside.sbar[data-side="right"] .deccard').first()).toBeVisible();
});

test('group_fold_keeps_urgent_rows: a folded group keeps split counts, the merged bar and broken/waiting rows without project headers', async ({ app, core }) => {
  const p = gitRepo(core, 'repo');
  const o = core.project('other');
  for (const l of ['a', 'b']) wtSession(core, p, l);
  core.shell(o, 'o1');
  seed(core, { op: 'group_create', name: 'Web', project: p }, { op: 'project_move', project: o, group: 'Web' }, { op: 'fold', key: 'group:Web', folded: true }, { op: 'fold', key: 'quiet:Web', folded: true });
  const patch = await patchSnapshots(app);
  await openWindow(app);
  patch.set('a', { waiting: 'permission' });
  patch.set('b', { failed: true });
  const group = app.locator('.pgrp[data-group="Web"]');
  await expect(group.locator('.grp[data-project="repo"] .head')).toHaveCount(0);
  await expect(group.locator('.ghead .cstrip > .sg[data-tone="o"]')).toHaveAttribute('data-n', '1');
  await expect(group.locator('.ghead .cstrip > .sg[data-tone="r"]')).toHaveAttribute('data-n', '1');
  await expect.poll(() => strip(group.locator('> .ghead'))).toBe('r1 o1 g1');
  // Round 2: quiet rows fold, while broken b precedes waiting a across the group.
  await expect(group.locator('.row.wt2')).toHaveCount(2);
  await expect(group.locator('.row.wt2 .n')).toHaveText(['repo · b', 'repo · a']);
  // needs 130 (FIDELITY BAR, 2026-10-29), mockup ③, supersedes TREEROWS G2 here: the folded group head carries its
  // projects' strips merged.
  await expect(group.locator('.ghead .cstrip .sg')).not.toHaveCount(0);
  // The waiting row keeps its project context and decision line without a project header.
  await expect(group.locator('.grp[data-project="repo"] .q')).toHaveCount(1);
  await expect(group.locator(':scope > .sess')).toHaveCount(0);
});

test('cleanup_line_counts_only: absent in the live tree (no facts exist on main)', async ({ app, core }) => {
  await five(app, core);
  await expect(app.locator('.cleanup')).toHaveCount(0);
});

test0('cleanup_line_counts_only: the fold is a keyboard-operable details with the count, and the button needs onCleanUp', async () => {
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { CleanupLine } = await import('../src/tree/RowIcon');
  const items = [{ key: 'a', name: 'v1a-62', state: { kind: 'merge' as const, tone: 'done' as const, tip: ['Merged · PR #48 · 2d', 'Branch kept'] as [string, string] } }, { key: 'b', name: 'v1a-60', state: { kind: 'gone' as const, tone: 'idle' as const, tip: ['Folder gone'] as [string] } }];
  // Under the Playwright runner the product's own catalogue is empty (areas load through Vite): the node-side lookup, as i18n-tree-catalogue.spec uses.
  const { makeT } = await import('./i18n-tables');
  const t = makeT('en', 'en-US');
  const html = (extra = {}) => renderToStaticMarkup(createElement(CleanupLine, { items, open: false, onToggle: () => {}, t, ...extra }));
  expect(html()).toContain('<details');
  expect(html()).toContain('<summary');
  expect(html()).toContain('Ready to clean up (2)');
  expect(html()).not.toContain('Clean up…');
  expect(html({ onCleanUp: () => {} })).toContain('Clean up…');
  expect(renderToStaticMarkup(createElement(CleanupLine, { items: [], open: false, onToggle: () => {}, t }))).toBe('');
});

test('no_axe_violation_on_the_tree: light and dark, and the screenshots of every state main can produce', async ({ app, core, browserName }) => {
  await app.setViewportSize({ width: 1440, height: 900 });
  const { p, patch } = await five(app, core);
  const stale = wtSession(core, p, 'stale1');
  void stale;
  wtSession(core, p, 'idle1');
  // A folded project with a bar, a quiet line, and a folded group (G2) with a waiting row.
  core.agent(core.project('folded'), 'f1', 'never-go');
  core.shell(core.project('calm'), 'c1');
  const web = core.project('web1');
  core.shell(web, 'w1');
  core.shell(core.project('web2'), 'w2');
  seed(core, { op: 'group_create', name: 'Web', project: web }, { op: 'project_move', project: core.project('web2'), group: 'Web' }, { op: 'fold', key: 'group:Web', folded: true });
  await app.reload();
  patch.set('stale1', { stale: true });
  patch.set('w1', { waiting: 'question' });
  // Seven worktree rows plus Web's main-checkout waiting session (Round 2 keeps that row too), plus (v25-new-tab, needs 213)
  // the idle main-folder sessions of the open projects, 3 of them (counted live: 11).
  await expect(app.locator('.row.wt2:not([data-home-setup])')).toHaveCount(11); // not the Assistants group's set-up row (ticket 1032)
  await expect(app.locator('.pgrp[data-group="Web"] .row.wt2 .n')).toHaveText('web1 · w1');
  await app.waitForTimeout(400);
  await app.getByRole('button', { name: 'Collapse folded' }).click();
  for (const theme of ['light', 'dark']) {
    await app.emulateMedia({ colorScheme: theme as 'light' | 'dark' }); // the app's theme engine follows the OS scheme
    await expect(app.locator('html')).toHaveAttribute('data-theme', theme);
    await app.waitForTimeout(500); // colours transition on a theme switch
    await app.mouse.move(900, 600);
    for (const hover of [false, true]) {
      if (hover) await app.locator('.grp[data-project="repo"] .row.wt2[data-kind="ask"]').hover(); // its tooltip covers the working row below
      const r = await new AxeBuilder({ page: app }).include('.tree').analyze();
      expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ') + ' ' + JSON.stringify(n.any.map((a) => a.data))).join(' | ')}`)).toEqual([]);
    }
    await app.mouse.move(900, 600);
    if (browserName === 'chromium') {
      fs.mkdirSync(path.resolve(import.meta.dirname, '../../.scratch'), { recursive: true });
      await app.locator('aside[aria-label="Tree"]').screenshot({ path: path.resolve(import.meta.dirname, `../../.scratch/tree-rows-${theme}.png`) });
    }
  }
});
