// Ticket 411 (388 colour bars, mock docs/design/m3-1110/388.html approved 11-10) and ticket 419's tree items. The strip
// sits on the session icons' column on every head, ungrouped or in a group; a project whose sessions all finished in the
// main folder draws no bars; 419: the head count labels with a limited session. Ticket 462 (owner 11-12) replaced two
// 11-11 coordinator calls: the tree's failed red is the mockup's, not the theme's, and the strip's pixel test is
// tree-bars-462.spec.ts, against the unmodified mockup.
import type { Page } from '@playwright/test';
import { expect, openWindow, test, type Core } from './fixtures';
import { seed } from './tree-seed';

test.use({ deviceScaleFactor: 2 });

// The tree is a pure view of the snapshot: patch each session's attention by label (as tree-strip.spec does).
type Patch = { failed?: boolean; waiting?: boolean; stale?: boolean; working?: boolean; limited?: boolean; state?: string; at?: number };
async function patchSnapshots(app: Page) {
  const patches = new Map<string, Patch>();
  let last = '';
  const sockets: { send(m: string): void }[] = [];
  const apply = (raw: string) => {
    const msg = JSON.parse(raw);
    for (const s of msg.sessions ?? []) {
      const p = patches.get(s.label);
      if (!p) continue;
      Object.assign(s.attention, { working: !!p.working, stale: !!p.stale, failed: !!p.failed, waiting: !!p.waiting, last_activity: p.at ?? Date.now() - 600_000 });
      if (p.state) s.state = p.state;
      if (p.limited) s.limit = { resets: '15:00', until: Math.floor(Date.now() / 1000) + 3600 };
      if (p.waiting) s.pending = [{ id: `d-${s.label}`, session_id: s.id, scope: s.project, kind: 'question', text: `Run ${s.label}?`, choices: ['1. red', '2. blue'].map((label, i) => ({ label, keys: [String(i + 1)], changes_settings: false })), observed_at: p.at ?? Date.now() - 180_000, actionable: true }];
    }
    return JSON.stringify(msg);
  };
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    sockets.push(ws);
    ws.onMessage((m) => server.send(m));
    server.onMessage((m) => ws.send(typeof m === 'string' && JSON.parse(m).event === 'snapshot' ? apply((last = m)) : m));
  });
  return {
    set(label: string, p: Patch) {
      patches.set(label, p);
      if (last) for (const ws of sockets) ws.send(apply(last));
    },
  };
}
const shells = (core: Core, project: string, ...labels: string[]) => Object.fromEntries(labels.map((l) => [l, core.shell(project, l).id as string]));
const head = (app: Page, name: string) => app.locator(`.grp[data-project="${name}"] > .row.head`);

test('strip_on_icon_column: every head strip, ungrouped or in a group, ends on the session icons\' right edge', async ({ app, core }) => {
  // Real app 11-10 (ticket 411): the bars sat right of the icon column. A group kept a 4px right gutter, so its strips and
  // rows ended 4px left of an ungrouped project's: two columns where the mock has one.
  shells(core, core.project('solo'), 'a', 'b');
  const inner = core.project('inner');
  shells(core, inner, 'c', 'd');
  const other = core.project('other');
  shells(core, other, 'e');
  seed(core, { op: 'group_create', name: 'G', project: inner }, { op: 'project_move', project: other, group: 'G' });
  await openWindow(app);
  await expect(head(app, 'inner').locator('.cstrip .sg')).toHaveCount(1);
  await expect(app.locator('.pgrp[data-group="G"] > .row.ghead .cstrip .sg')).toHaveCount(1);
  const edges = await app.evaluate(() => {
    const seen = (e: Element) => e.getClientRects().length > 0;
    const right = (s: string) => [...document.querySelectorAll(s)].filter(seen).map((e) => e.getBoundingClientRect().right);
    // Ticket 1041: an idle row is bare, so the icon column is each row's content edge (its right padding in), where a glyph ends.
    const icons = [...document.querySelectorAll('.tree button.row.wt2')].filter(seen).map((e) => e.getBoundingClientRect().right - parseFloat(getComputedStyle(e).paddingRight));
    return { strips: right('.tree .cstrip'), icons, bars: right('.tree .cstrip .sg > :last-child') };
  });
  expect(edges.strips.length).toBe(4); // solo, the group head, inner, other
  expect(edges.icons.length).toBe(6); // with the Assistants group's set-up row (ticket 1032), on the same column
  const column = edges.icons[0];
  for (const x of [...edges.strips, ...edges.icons]) expect(Math.abs(x - column)).toBeLessThanOrEqual(0.5);
  // The last bar ends 1px inside the column (its colour's 1px padding), as the mock's does.
  for (const x of edges.bars) expect(column - x).toBeGreaterThanOrEqual(0), expect(column - x).toBeLessThanOrEqual(1.5);
});

test('strip_failed_uses_mock_red: a theme whose failed colour is tan keeps the mockup\'s red on the tree\'s bar and row icon', async ({ app, core }) => {
  const ids = shells(core, core.project('broke'), 'x', 'y');
  const patch = await patchSnapshots(app);
  await openWindow(app);
  patch.set('x', { failed: true });
  const red = head(app, 'broke').locator('.sg[data-tone="r"] i');
  await expect(red).toHaveCount(1);
  // A theme sets the failed token (themes/derive.ts: palette 1 -> --bad); the real app's theme has #d59a71. Ticket 462
  // (owner 11-12): the tree keeps the mockup's red (light #cf222e here); the tan stays for tabs and status dots.
  await app.evaluate(() => document.documentElement.style.setProperty('--bad', '#d59a71'));
  const mock = 'rgb(207, 34, 46)';
  await expect(app.locator('.tab .tdot[data-s="failed"]').first()).toHaveCSS('color', 'rgb(213, 154, 113)');
  await expect(red).toHaveCSS('background-color', mock);
  await expect(app.locator(`button.row.wt2[data-menu-session="${ids.x}"] .ic`)).toHaveCSS('color', mock);
});

test('strip_finished_only_draws_nothing: a project whose sessions all finished keeps the empty column and draws no bar', async ({ app, core }) => {
  const p = core.project('finished');
  shells(core, p, 'd1', 'd2');
  const q = core.project('mixed');
  shells(core, q, 'm1', 'm2');
  seed(core, { op: 'group_create', name: 'Done', project: p });
  const patch = await patchSnapshots(app);
  await openWindow(app);
  for (const l of ['d1', 'd2', 'm1']) patch.set(l, { state: 'exited' });
  const grp = app.locator('.grp[data-project="finished"]');
  await expect(grp.locator('.row.wt2.just')).toHaveCount(2); // ticket 1022: they just finished (no "N done" fold)
  const strip = head(app, 'finished').locator('.cstrip');
  await expect(strip).toHaveCount(1);
  await expect(strip).toHaveAttribute('aria-hidden', 'true');
  await expect(strip.locator('.sg')).toHaveCount(0);
  expect((await strip.boundingBox())!.width).toBe(64); // the column stays, so names end where every head's do
  // Its group head, which counts only that project, draws none either; a finished session beside a live one adds nothing.
  await expect(app.locator('.pgrp[data-group="Done"] > .row.ghead .cstrip .sg')).toHaveCount(0);
  await expect(head(app, 'mixed').locator('.cstrip .sg')).toHaveCount(1);
  await expect(head(app, 'mixed').locator('.sg[data-tone="g"] i')).toHaveCount(1);
});

test('strip_counts_limited_like_its_group: a limited session counts with waiting on its project head and its group head alike', async ({ app, core }) => {
  // Ticket 419: the limit lane (372 round 2) counted a limited session with waiting on the group head's label only.
  const p = core.project('repo');
  shells(core, p, 'ask', 'lim', 'calm');
  seed(core, { op: 'group_create', name: 'G', project: p });
  const patch = await patchSnapshots(app);
  await openWindow(app);
  const projectCounts = head(app, 'repo').locator('> .r[role="group"]');
  const groupCounts = app.locator('.pgrp[data-group="G"] > .row.ghead > .r[role="group"]');
  patch.set('lim', { limited: true });
  await expect(head(app, 'repo').locator('.sg[data-tone="w"]')).toHaveCount(1);
  await expect(groupCounts).toHaveAttribute('aria-label', '0 working, 1 waiting, 0 need attention');
  await expect(projectCounts).toHaveAttribute('aria-label', /, 0 working, 1 waiting, 0 need attention$/);
  patch.set('ask', { waiting: true });
  await expect(groupCounts).toHaveAttribute('aria-label', '0 working, 2 waiting, 0 need attention');
  await expect(projectCounts).toHaveAttribute('aria-label', /, 0 working, 2 waiting, 0 need attention$/);
  // A limited session that also asks is one waiting, not two.
  patch.set('lim', { limited: true, waiting: true });
  await expect(groupCounts).toHaveAttribute('aria-label', '0 working, 2 waiting, 0 need attention');
  await expect(projectCounts).toHaveAttribute('aria-label', /, 0 working, 2 waiting, 0 need attention$/);
});
