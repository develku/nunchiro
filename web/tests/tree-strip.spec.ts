// Ticket 388 (mock final/388.html, approved 11-10): one colour bar per session on project and group heads, no count pills,
// a colour opens its longest-waiting session, "]" / "[" walk the urgent queue.
import type { Locator, Page } from '@playwright/test';
import { expect, openWindow, test, type Core } from './fixtures';
import { seed } from './tree-seed';

// The tree is a pure view of the snapshot: patch each session's attention by label (as tree-rows.spec does).
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
      if (p.limited) s.limit = { resets: '15:00', until: Math.floor(Date.now() / 1000) + 3600 }; // ticket 372's field
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

/** Each colour of a strip: its tone, how many bars it draws and the number beside them. */
const strip = (head: Locator) =>
  head.locator('.cstrip .sg').evaluateAll((els) => els.map((e) => ({ tone: (e as HTMLElement).dataset.tone, bars: e.querySelectorAll('i').length, n: e.querySelector('.num')?.textContent ?? '' })));
const shells = (core: Core, project: string, ...labels: string[]) => Object.fromEntries(labels.map((l) => [l, core.shell(project, l).id as string]));
const ago = (ms: number) => Date.now() - ms;

test('strip_one_bar_per_session: three idle sessions on main are one grey bar and 3; two failed are two red bars', async ({ app, core }) => {
  const p = core.project('quiet');
  shells(core, p, 'a', 'b', 'c');
  const q = core.project('broke');
  shells(core, q, 'x', 'y');
  const patch = await patchSnapshots(app);
  await openWindow(app);
  patch.set('x', { failed: true });
  patch.set('y', { failed: true });
  const quiet = app.locator('.grp[data-project="quiet"] > .row.head');
  await expect.poll(() => strip(quiet)).toEqual([{ tone: 'g', bars: 1, n: '3' }]);
  const broke = app.locator('.grp[data-project="broke"] > .row.head');
  await expect.poll(() => strip(broke)).toEqual([{ tone: 'r', bars: 2, n: '' }]);
  // The hover summary names each colour with its count, and the "]" line the first urgent session.
  await expect(broke.locator('.stip')).toContainText('2 failed');
  await expect(broke.locator('.stip .key')).toContainText('Most urgent x');
  // No round count badge anywhere in the tree (rule 1).
  await expect(app.locator('.tree .pill')).toHaveCount(0);
});

test('strip_group_head_counts_sessions: a group head draws every session of its projects, same colours together in order', async ({ app, core }) => {
  const p = core.project('one');
  const o = core.project('two');
  shells(core, p, 'w1', 'f1', 'i1');
  shells(core, o, 'w2', 'i2', 'i3');
  seed(core, { op: 'group_create', name: 'Web', project: p }, { op: 'project_move', project: o, group: 'Web' });
  const patch = await patchSnapshots(app);
  await openWindow(app);
  patch.set('w1', { waiting: true });
  patch.set('w2', { waiting: true });
  patch.set('f1', { failed: true });
  const head = app.locator('.pgrp[data-group="Web"] > .row.ghead');
  await expect.poll(() => strip(head)).toEqual([
    { tone: 'r', bars: 1, n: '' },
    { tone: 'o', bars: 2, n: '' },
    { tone: 'g', bars: 1, n: '3' },
  ]);
  await expect(head.locator('.pill')).toHaveCount(0);
});

test('strip_click_opens_longest_waiting: the orange chunk opens the your-turn session that waited longest, then the next', async ({ app, core }) => {
  const p = core.project('repo');
  const ids = shells(core, p, 'newer', 'older', 'idle');
  const patch = await patchSnapshots(app);
  await openWindow(app);
  patch.set('newer', { waiting: true, at: ago(60_000) });
  patch.set('older', { waiting: true, at: ago(900_000) });
  const head = app.locator('.grp[data-project="repo"] > .row.head');
  const orange = head.locator('.sg[data-tone="o"]');
  await expect(orange.locator('i')).toHaveCount(2);
  await orange.click();
  await expect(app.locator(`.tab[data-tab="${ids.older}"]`)).toHaveAttribute('aria-selected', 'true');
  await orange.click();
  await expect(app.locator(`.tab[data-tab="${ids.newer}"]`)).toHaveAttribute('aria-selected', 'true');
});

test('strip_click_unfolds_only_the_path: a grey colour on a folded group opens its group and project, and they fold back after', async ({ app, core }) => {
  const p = core.project('inner');
  const ids = shells(core, p, 'i1');
  seed(core, { op: 'group_create', name: 'G', project: p }, { op: 'fold', key: 'group:G', folded: true });
  await openWindow(app);
  const group = app.locator('.pgrp[data-group="G"]');
  await expect(group.getByRole('button', { name: 'Expand group G' })).toBeVisible();
  await group.locator('.row.ghead .sg[data-tone="g"]').click();
  await expect(group.getByRole('button', { name: 'Collapse group G' })).toBeVisible();
  await expect(app.locator(`.tab[data-tab="${ids.i1}"]`)).toHaveAttribute('aria-selected', 'true');
  // A click on the chevron the app opened folds it back; the stored fold never changed.
  await group.getByRole('button', { name: 'Collapse group G' }).click();
  await expect(group.getByRole('button', { name: 'Expand group G' })).toBeVisible();
});

test('strip_bracket_walks_queue: "]" walks your turn (longest first) then failed, wraps; "[" goes back', async ({ app, core }) => {
  const p = core.project('repo');
  const ids = shells(core, p, 'ask-new', 'ask-old', 'broke', 'calm');
  const patch = await patchSnapshots(app);
  await openWindow(app);
  patch.set('ask-new', { waiting: true, at: ago(60_000) });
  patch.set('ask-old', { waiting: true, at: ago(900_000) });
  patch.set('broke', { failed: true });
  const head = app.locator('.grp[data-project="repo"] > .row.head');
  await expect(head.locator('.sg[data-tone="r"] i')).toHaveCount(1);
  await head.locator('button.n').focus();
  const focused = () => app.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.menuSession ?? '');
  await app.keyboard.press(']');
  await expect.poll(focused).toBe(ids['ask-old']);
  await app.keyboard.press(']');
  await expect.poll(focused).toBe(ids['ask-new']);
  await app.keyboard.press(']');
  await expect.poll(focused).toBe(ids.broke);
  await app.keyboard.press(']');
  await expect.poll(focused).toBe(ids['ask-old']);
  await app.keyboard.press('[');
  await expect.poll(focused).toBe(ids.broke);
  // The keys are not the tree's inside a menu or dialog drawn in the tree (a row's "choose" menu: its keydown bubbles to the tree).
  await app.locator(`.q[data-line="${ids['ask-new']}"] [data-act="choose"]`).click();
  await app.getByRole('menuitem').first().focus();
  await app.keyboard.press(']');
  expect(await app.evaluate(() => !!document.activeElement?.closest('[role="menu"]'))).toBe(true);
});

test('strip_limited_tone: a usage-limited session is one yellow-clock bar after orange and before stale, and not in the "]" queue', async ({ app, core }) => {
  const p = core.project('repo');
  const ids = shells(core, p, 'ask', 'lim', 'old', 'calm');
  const patch = await patchSnapshots(app);
  await openWindow(app);
  patch.set('ask', { waiting: true });
  patch.set('lim', { limited: true });
  patch.set('old', { stale: true });
  const head = app.locator('.grp[data-project="repo"] > .row.head');
  await expect.poll(() => strip(head)).toEqual([{ tone: 'o', bars: 1, n: '' }, { tone: 'w', bars: 1, n: '' }, { tone: 'y', bars: 1, n: '' }, { tone: 'g', bars: 1, n: '' }]);
  await expect(head.locator('.sg[data-tone="w"]')).toHaveAccessibleName('1 limited · open the longest waiting');
  // The colour buttons carry the "]" hint as their description (the tip itself is aria-hidden).
  await expect(head.locator('.sg[data-tone="w"]')).toHaveAccessibleDescription('] Most urgent ask');
  await head.locator('button.n').focus();
  const focused = () => app.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.menuSession ?? '');
  await app.keyboard.press(']');
  await expect.poll(focused).toBe(ids.ask);
  await app.keyboard.press(']'); // the queue is only "ask": the limited session is never a step
  await expect.poll(focused).toBe(ids.ask);
});

// The mock's data shape (final/388.html section 1, This Mac only: a second machine needs a remote core). SHOTS_DIR=<dir> saves
// each scene for the side-by-side with the mock's render; without it the test still checks every strip against its sessions.
test('strip_mock_shape: every strip counts its sessions per colour, as the mock draws them', { tag: '@chromium' }, async ({ app, core }) => {
  const add = (name: string, ...labels: string[]) => shells(core, core.project(name), ...labels);
  add('mini-01', 'claude 3a964f', 'shell 747cf3', 'st-1', 'st-2', 'more-1', 'done-1', 'done-2');
  add('nunchiro', 'claude a5b463', 'acp 452d64', 'done-3', 'done-4', 'done-5');
  add('lumen', 'rehfix', 'feed-retry', 'bt-sweep', 'notes');
  add('tide', 'sealed-read', 'w-1', 'w-2');
  add('blog', 'b-1', 'b-2', 'b-3');
  const at = (n: string) => core.project(n);
  seed(core, { op: 'group_create', name: 'Trading', project: at('lumen') }, { op: 'project_move', project: at('tide'), group: 'Trading' }, { op: 'project_move', project: at('blog'), group: 'Trading' }, { op: 'fold', key: 'group:Trading', folded: true });
  const patch = await patchSnapshots(app);
  for (const scheme of ['dark', 'light'] as const) {
    await app.setViewportSize({ width: 1440, height: 900 });
    await app.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await openWindow(app);
    for (const l of ['claude 3a964f', 'feed-retry']) patch.set(l, { failed: true });
    for (const l of ['st-1', 'st-2']) patch.set(l, { stale: true });
    for (const l of ['bt-sweep', 'w-1', 'w-2']) patch.set(l, { working: true });
    for (const l of ['done-1', 'done-2', 'done-3', 'done-4', 'done-5']) patch.set(l, { state: 'closed' });
    patch.set('rehfix', { waiting: true, at: ago(1_200_000) });
    patch.set('sealed-read', { waiting: true, at: ago(300_000) });
    const head = (n: string) => app.locator(`.grp[data-project="${n}"] > .row.head`);
    const trading = app.locator('.pgrp[data-group="Trading"] > .row.ghead');
    await expect.poll(() => strip(head('mini-01'))).toEqual([{ tone: 'r', bars: 1, n: '' }, { tone: 'y', bars: 2, n: '' }, { tone: 'g', bars: 2, n: '' }]);
    expect(await strip(head('nunchiro'))).toEqual([{ tone: 'g', bars: 2, n: '' }]);
    expect(await strip(trading)).toEqual([{ tone: 'r', bars: 1, n: '' }, { tone: 'o', bars: 2, n: '' }, { tone: 'b', bars: 1, n: '3' }, { tone: 'g', bars: 1, n: '4' }]);
    await expect(app.locator('.tree .pill, .mach .cstrip')).toHaveCount(0);
    const dir = process.env.SHOTS_DIR;
    if (!dir) continue;
    const side = app.locator('aside.dock.l');
    await app.mouse.move(900, 600);
    await side.screenshot({ path: `${dir}/1-${scheme}.png` });
    await trading.locator('.sg[data-tone="o"]').hover();
    await app.waitForTimeout(600);
    await side.screenshot({ path: `${dir}/2a-hover-${scheme}.png` });
    await trading.locator('.sg[data-tone="o"]').click();
    await expect(head('lumen')).toBeVisible();
    await app.waitForTimeout(200);
    await side.screenshot({ path: `${dir}/2b-click-${scheme}.png` });
    // A short sidebar: Trading's failed and your-turn sessions sit below the edge and gather there.
    await app.mouse.move(900, 600);
    await trading.locator('.chev').click();
    await app.setViewportSize({ width: 1440, height: 360 });
    await app.mouse.move(900, 300);
    await expect(app.locator('.gat.bottom .gbox')).toBeVisible();
    await side.screenshot({ path: `${dir}/3-gather-${scheme}.png` });
  }
});

test('strip_failed_row_outside_done: a failed main-folder session keeps its own row while the finished ones leave, and its red bar reveals and marks it', async ({ app, core }) => {
  // Real-app 11-10 defect 4: "Login: gh" (agent failed) sat inside "3 done", so its bar opened the tab but showed no row.
  const p = core.project('login');
  const ids = shells(core, p, 'gh', 'd1', 'd2', 'd3');
  const patch = await patchSnapshots(app);
  await openWindow(app);
  patch.set('gh', { state: 'exited', failed: true });
  for (const l of ['d1', 'd2', 'd3']) patch.set(l, { state: 'exited' });
  const grp = app.locator('.grp[data-project="login"]');
  const row = grp.locator(`button.row.wt2[data-menu-session="${ids.gh}"]`);
  // Ticket 1022: the three finished ones are "just finished" rows (the failed one is not one of them).
  await expect(grp.locator('.row.wt2.just')).toHaveCount(3);
  await expect(grp.locator(`.row.wt2.just[data-just="${ids.gh}"]`)).toHaveCount(0);
  await expect(row).toBeVisible();
  // Folded, the red bar opens the path to the row and marks it.
  await grp.locator('> .row.head .chev').click();
  await expect(row).toBeHidden();
  await grp.locator('> .row.head .sg[data-tone="r"]').click();
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute('data-pulse', 'r');
  await expect(app.locator(`.tab[data-tab="${ids.gh}"]`)).toHaveAttribute('aria-selected', 'true');
});

// Ticket 991 A7: grey counts live idle sessions and (ticket 462) finished ones whose row still shows; the words say which.
test('strip_grey_words_split_idle_and_finished_A7', async () => {
  const { word } = await import('../src/tree/strip');
  const { makeT } = await import('./i18n-tables');
  const s = (id: string, rest?: true) => ({ id, rest }) as unknown as Parameters<typeof word>[2][number];
  for (const lang of ['en', 'ko'] as const) {
    const t = makeT(lang, lang) as Parameters<typeof word>[0];
    expect(word(t, 'g', [s('a'), s('b'), s('c', true)])).toBe(lang === 'en' ? '2 idle, 1 finished' : '쉬는 중 2, 끝남 1');
    expect(word(t, 'g', [s('c', true)])).toBe(lang === 'en' ? '1 finished' : '끝남 1');
    expect(word(t, 'g', [s('a')])).toBe(lang === 'en' ? '1 idle' : '쉬는 중 1');
  }
  // Eighth look (C): Spanish read "1 inactivas"; one session takes the word's form for one, in es, fr and pt.
  for (const [lang, one, two] of [['es', '1 inactiva, 1 terminada', '2 inactivas, 2 terminadas'], ['fr', '1 inactive, 1 terminée', 'inactives : 2, terminées : 2'], ['pt', '1 inativa, 1 encerrada', 'inativas: 2, encerradas: 2']] as const) {
    const t = makeT(lang, lang) as Parameters<typeof word>[0];
    expect(word(t, 'g', [s('a'), s('c', true)])).toBe(one);
    expect(word(t, 'g', [s('a'), s('b'), s('c', true), s('d', true)])).toBe(two);
  }
});
