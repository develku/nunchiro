// Ticket 1022 (mockup docs/design/tree-done-1121, 4b): finished main-folder sessions leave the tree. A "just finished"
// row for 10 minutes (a hollow rail that fades), then hollow bars on the project head left of the colour strip (the
// strip itself unchanged), a popover of the latest five, and one History widget.
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, openWindow, REPO, test } from './fixtures';
import { append, rec, test as chatTest } from './fixtures/chat/harness';
import { patchSnapshots } from './tree-mock-states';
import { mockup } from './visual/mockups';
import { seed } from './tree-seed';
import { repo, worktree } from './visual/compare';

const SHOTS = path.join(REPO, '.scratch/shots');
const MOCK = mockup('tree-done.html');
const head = (app: Page, name: string) => app.locator(`.grp[data-project="${name}"] > .row.head`);
type Snap = { id: string; label: string; state: string; agent_ended?: boolean };
const snap = (core: { cli: (...a: string[]) => { sessions?: unknown } }) => core.cli('snapshot', '--json').sessions as Snap[];
/** Shells that end at once; returns when the core has seen them end, so the window counts them as finished before it opened. */
async function ended(core: { shell: (p: string, l: string, prog?: string) => { id: string }; cli: (...a: string[]) => { sessions?: unknown } }, dir: string, ...labels: string[]) {
  const ids = labels.map((l) => core.shell(dir, l, '/usr/bin/true').id);
  await expect.poll(() => snap(core).filter((s) => ids.includes(s.id) && s.state === 'exited').length).toBe(ids.length);
}
const narrow = (app: Page) => app.locator('.sbar.l').evaluate((e) => void ((e as HTMLElement).style.width = '300px'));

/** Runs in the page: the strip's box, and per colour its tone, its number and each bar's box. */
const stripOf = (h: Element) => {
  const s = h.querySelector('.cstrip')!;
  const box = (e: Element) => Object.values(e.getBoundingClientRect().toJSON()).map((v) => Math.round((v as number) * 100) / 100);
  return {
    box: box(s),
    bars: [...s.querySelectorAll<HTMLElement>('.sg')].map((g) => ({ tone: g.dataset.tone, text: g.textContent, i: [...g.querySelectorAll('i')].map(box) })),
    done: h.querySelector('.dbar') ? { right: h.querySelector('.dbar')!.getBoundingClientRect().right, n: (h.querySelector('.dbar') as HTMLElement).dataset.doneBars } : null,
  };
};

test('strip_unchanged_by_hollow_bars: the colour strip keeps its box and bars with the hollow bars beside it, dark and light', async ({ app, core }) => {
  const dir = core.project('demo');
  for (const l of ['ask-1', 'failed-1', 'cl1', 'rest-1']) core.shell(dir, l);
  await ended(core, dir, 'fix-login', 'docs-cli', 'bench-1');
  const set = await patchSnapshots(app);
  set({ 'ask-1': { waiting: true }, 'failed-1': { failed: true } });
  for (const scheme of ['dark', 'light'] as const) {
    await app.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await openWindow(app);
    await narrow(app);
    await app.mouse.move(900, 600);
    const h = head(app, 'demo');
    // Rule 3: three or more are one hollow bar and the number.
    await expect(h.locator('.dbar')).toHaveAttribute('data-done-bars', '3');
    await expect(h.locator('.dbar i')).toHaveCount(1);
    await expect(h.locator('.dbar .num')).toHaveText('3');
    await expect(app.locator('.tree .row.wt2', { hasText: 'fix-login' })).toHaveCount(0);
    await expect(app.locator('.tree .row.done:not(.wt2)')).toHaveCount(0); // no "N done" fold
    const withBars = await h.evaluate(stripOf);
    await app.locator('.sbar.l').screenshot({ path: path.join(SHOTS, `1022-tree-${scheme}.png`) });
    // The same head without the bars (taken out of the page, so no rule about them applies): the strip as before 1022.
    const without = await h.evaluate((e, src) => (e.querySelector('.dbar')!.remove(), (new Function(`return ${src}`)() as typeof stripOf)(e)), stripOf.toString());
    expect(withBars.box, scheme).toEqual(without.box);
    expect(withBars.bars, scheme).toEqual(without.bars);
    expect(withBars.box[2]).toBe(64); // the strip's fixed column
    expect(withBars.bars.map((b) => b.tone)).toEqual(['r', 'o', 'g']); // finished sessions add no bar
    // The bars' distance to the strip is the mockup's (its `.dbar` 6px margin in a 6px-gap row).
    const m = await app.context().newPage();
    await m.goto(`file://${MOCK}`);
    const gap = await m.locator('.tree.dark:not(.old) .r .dbar').first().evaluate((d) => d.nextElementSibling!.getBoundingClientRect().left - d.getBoundingClientRect().right);
    await m.close();
    expect(withBars.box[0] - withBars.done!.right).toBeCloseTo(gap, 0);
  }
});

test('hollow_bars_rule_and_group_sum: one or two are bars, a group head sums its projects', async ({ app, core }) => {
  const a = core.project('alpha');
  const b = core.project('beta');
  core.shell(a, 'a-live');
  core.shell(b, 'b-live');
  await ended(core, a, 'a-d1');
  await ended(core, b, 'b-d1', 'b-d2');
  seed(core, { op: 'group_create', name: 'Trading', project: a }, { op: 'project_move', project: b, group: 'Trading' });
  await openWindow(app);
  await expect(head(app, 'alpha').locator('.dbar i')).toHaveCount(1);
  await expect(head(app, 'beta').locator('.dbar i')).toHaveCount(2);
  await expect(head(app, 'beta').locator('.dbar .num')).toHaveCount(0);
  await expect(head(app, 'beta').locator('.dbar')).toHaveAttribute('data-tip', 'done 2 · today');
  await expect(app.locator('.pgrp[data-group="Trading"] > .row.ghead > .dbar')).toHaveAttribute('data-done-bars', '3');
});

test('today_only_in_bars_and_popover: a session that ended yesterday is in History, not in the count or the popover', async ({ app, core }) => {
  const dir = core.project('demo');
  core.shell(dir, 'keep');
  await ended(core, dir, 'today-1', 'old-1');
  const set = await patchSnapshots(app);
  const yesterday = new Date(new Date().setHours(0, 0, 0, 0) - 3 * 3600_000).getTime(); // 21:00 yesterday
  set({ 'old-1': { at: yesterday } });
  await openWindow(app);
  const bars = head(app, 'demo').locator('button.dbar');
  await expect(bars).toHaveAttribute('data-done-bars', '1');
  await bars.click();
  const pop = app.getByRole('dialog', { name: 'demo · 1 finished' });
  await expect(pop.locator('[data-done-item]')).toHaveCount(1);
  await expect(pop.locator('[data-done-item]')).toContainText('today-1');
  // The popover's item has its time, as its History row does.
  await expect(pop.locator('[data-done-item] .tm')).not.toHaveText('');
  // Ticket 1025: Esc closes the popover and focus goes back to the bars.
  await app.keyboard.press('Escape');
  await expect(pop).toHaveCount(0);
  await expect(bars).toBeFocused();
  await bars.click();
  await pop.getByRole('button', { name: /View all in History/ }).click();
  const hist = app.locator('[data-history-view]');
  const day = (label: string) => hist.locator('section', { has: app.locator('.histv-day b', { hasText: new RegExp(`^${label}$`) }) });
  await expect(day('Today').locator('[data-history]')).toHaveText([/today-1/]);
  // Ticket 1025: a row says when its run started and how long it ran (a shell that ended at once: under a minute).
  await expect(day('Today').locator('[data-history] .hr-st')).toHaveText(/^\d{1,2}:\d{2}( [AP]M)?$/);
  await expect(day('Today').locator('[data-history] .hr-len')).toHaveText('<1m'); // lane w59: History's short length
  await expect(day('Yesterday').locator('[data-history]')).toHaveText([/old-1/]);
  await expect(hist.getByText('Earlier', { exact: true })).toHaveCount(0);
});

test('settled_running_session_in_history: a session moved to done while it runs is in History, and the bars, popover and History agree', async ({ app, core }) => {
  const dir = core.project('demo');
  core.shell(dir, 'keep');
  const calm = core.shell(dir, 'calm');
  await ended(core, dir, 'gone-1');
  await openWindow(app);
  const row = app.locator(`.tree button.row.wt2[data-menu-session="${calm.id}"]`);
  await row.click({ button: 'right' });
  await app.getByRole('menu', { name: 'Actions' }).getByRole('menuitem', { name: 'Move to done' }).click();
  await expect(row).toHaveCount(0);
  expect(snap(core).find((s) => s.id === calm.id)?.state).toBe('running'); // still running: only the tree let go of it
  const bars = head(app, 'demo').locator('button.dbar');
  await expect(bars).toHaveAttribute('data-done-bars', '2');
  await bars.click();
  const pop = app.getByRole('dialog', { name: 'demo · 2 finished' });
  await expect(pop.locator('[data-done-item]')).toHaveCount(2);
  await pop.getByRole('button', { name: /View all in History/ }).click();
  const hist = app.locator('[data-history-view]');
  await expect(hist.locator('[data-history]')).toHaveCount(2);
  await expect(hist.locator(`[data-history="${calm.id}"]`)).toBeVisible();
});

test('history_rows_keep_the_row_menu: an ended shell is closed from History; a popover item has the same menu', async ({ app, core }) => {
  const dir = core.project('demo');
  core.shell(dir, 'keep');
  await ended(core, dir, 'old-sh');
  const id = snap(core).find((s) => s.label === 'old-sh')!.id;
  await openWindow(app);
  const menu = app.getByRole('menu', { name: 'Actions' });
  await head(app, 'demo').locator('button.dbar').click();
  await app.locator(`[data-done-pop] [data-done-item="${id}"]`).click({ button: 'right' });
  await expect(menu.getByRole('menuitem', { name: 'Restart session' })).not.toHaveAttribute('aria-disabled', 'true');
  await app.keyboard.press('Escape');
  await app.getByRole('navigation', { name: 'Right bar' }).getByRole('button', { name: 'History', exact: true }).click();
  const row = app.locator(`[data-history-view] [data-history="${id}"]`);
  await row.click({ button: 'right' });
  await menu.getByRole('menuitem', { name: 'Close session' }).click();
  await expect.poll(() => snap(core).find((s) => s.id === id)?.state ?? 'gone').not.toBe('exited');
});

test('just_finished_row_for_ten_minutes: a session that ends stays as a fading row for 10 minutes, then counts in the bars', async ({ app, core }) => {
  const dir = core.project('demo');
  for (const l of ['keep', 'quick', 'boom', 'asks']) core.shell(dir, l);
  const set = await patchSnapshots(app);
  await app.clock.install();
  await openWindow(app);
  const grp = app.locator('.grp[data-project="demo"]');
  await expect(grp.locator('.row.wt2', { hasText: 'quick' })).toBeVisible();
  set({ quick: { exited: true }, boom: { failed: true, exited: true }, asks: { waiting: true } });
  const just = grp.locator('.row.wt2.just', { hasText: 'quick' });
  await expect(just).toBeVisible();
  await expect(just).toHaveAttribute('aria-label', /^quick, Just finished · /);
  const fade = () => just.locator('.sdot').evaluate((e) => Number(getComputedStyle(e).opacity)); // design book: the done ring fades
  expect(await fade()).toBeCloseTo(0.85, 1);
  await app.locator('.sbar.l').screenshot({ path: path.join(SHOTS, '1022-tree-just.png') });
  // A just-finished row is not counted until it leaves.
  await expect(head(app, 'demo').locator('.dbar')).toHaveCount(0);
  // Failed and your-turn sessions are not finished: they keep their rows.
  await expect(grp.locator('.row.wt2:not(.just)', { hasText: 'boom' })).toBeVisible();
  await expect(grp.locator('.row.wt2:not(.just)', { hasText: 'asks' })).toBeVisible();
  await app.clock.fastForward('09:00');
  await expect(just).toHaveAttribute('aria-label', 'quick, Just finished · 9 min');
  expect(await fade()).toBeLessThan(0.4);
  await app.clock.fastForward('01:01');
  await expect(just).toHaveCount(0);
  await expect(head(app, 'demo').locator('.dbar')).toHaveAttribute('data-done-bars', '1');
});

// Owner 11-21 (lane w43-tree): a resumable session (an agent whose run ended with the core at an app quit or a reboot) kept
// its row for ever. It is finished like the others; one with a question waiting keeps its row.
test('resumable_session_leaves_the_tree: a resumable session fades for 10 minutes, then is in the bars and History; one from before the window opened has no row', async ({ app, core }) => {
  const dir = core.project('demo');
  for (const l of ['keep', 'res-now', 'res-asks', 'res-old', 'res-yday']) core.shell(dir, l);
  const set = await patchSnapshots(app);
  await app.clock.install();
  await openWindow(app);
  const grp = app.locator('.grp[data-project="demo"]');
  const row = (name: string) => grp.locator('.row.wt2', { hasText: name });
  await expect(row('res-now')).toBeVisible();
  const today = Date.now();
  set({ 'res-now': { resumable: true, at: today }, 'res-asks': { resumable: true, waiting: true, at: today } });
  await expect(grp.locator('.row.wt2.just', { hasText: 'res-now' })).toBeVisible();
  await expect(grp.locator('.row.wt2:not(.just)', { hasText: 'res-asks' })).toBeVisible(); // your turn: stays as today
  await expect(grp.locator('.row.wt2:not(.just)', { hasText: 'res-old' })).toBeVisible(); // running: untouched
  await app.clock.fastForward('10:01');
  await expect(row('res-now')).toHaveCount(0);
  await expect(head(app, 'demo').locator('.dbar')).toHaveAttribute('data-done-bars', '1');
  // The window opens on sessions that were resumable already (the owner's case after a reboot): no row at all.
  const yesterday = new Date(new Date(today).setHours(0, 0, 0, 0) - 3 * 3600_000).getTime();
  set({ 'res-now': { resumable: true, at: today }, 'res-asks': { resumable: true, waiting: true, at: today }, 'res-old': { resumable: true, at: today }, 'res-yday': { resumable: true, at: yesterday } });
  await app.reload();
  await expect(row('keep')).toBeVisible();
  await expect(row('res-asks')).toBeVisible();
  for (const name of ['res-now', 'res-old', 'res-yday']) await expect(row(name)).toHaveCount(0);
  await expect(head(app, 'demo').locator('.dbar')).toHaveAttribute('data-done-bars', '2'); // yesterday's is not counted
  await app.getByRole('navigation', { name: 'Right bar' }).getByRole('button', { name: 'History', exact: true }).click();
  const hist = app.locator('[data-history-view]');
  const day = (label: string) => hist.locator('section', { has: app.locator('.histv-day b', { hasText: new RegExp(`^${label}$`) }) });
  await expect(day('Today').locator('[data-history]')).toHaveCount(2);
  await expect(day('Yesterday').locator('[data-history]')).toHaveText([/res-yday/]);
  await expect(hist.locator('[data-history]')).toHaveCount(3); // not the running one, not the one that asks
  await expect(day('Yesterday').locator('[data-history] .hr-acts button[aria-label="Continue"]')).toHaveCount(1); // shown on hover
});

// Ticket 1025 (look v26 a): the hollow bars and the strip keep their place under a hovered head, and a finished session's
// tab and header dot are its tree rail (the hollow bar), not the purple done dot.
test('polish_1025: the bars and the strip hold still when the tools of the head show; the tab and header dot of a finished session are the hollow bar', async ({ app, core }) => {
  const dir = core.project('demo');
  core.shell(dir, 'keep');
  await ended(core, dir, 'gone-1');
  const id = snap(core).find((s) => s.label === 'gone-1')!.id;
  await openWindow(app);
  await narrow(app);
  await app.mouse.move(900, 600);
  const h = head(app, 'demo');
  const boxes = () => h.evaluate((e) => ['.dbar', '.cstrip'].map((q) => [e.querySelector(q)!.getBoundingClientRect().left, e.querySelector(q)!.getBoundingClientRect().right]));
  const rest = await boxes();
  await h.hover();
  await expect(h.locator('.padd').first()).toBeVisible();
  expect(await boxes()).toEqual(rest);
  await h.locator('button.dbar').click();
  await app.locator(`[data-done-pop] [data-done-item="${id}"]`).click();
  const look = (q: string) => app.locator(q).evaluate((e) => [e.getAttribute('data-s'), getComputedStyle(e).width, getComputedStyle(e).height, getComputedStyle(e).boxShadow]);
  // Design book: one look for done, the 8 px ring in --light-done, on the tab, the header and the head's count.
  const ring = await app.evaluate(() => { const d = document.createElement('i'); d.style.boxShadow = 'inset 0 0 0 1.5px var(--light-done)'; document.body.append(d); const c = getComputedStyle(d).boxShadow; d.remove(); return c; });
  expect(await head(app, 'demo').locator('.dbar i').first().evaluate((e) => getComputedStyle(e).boxShadow)).toBe(ring); // the head's rings, the same look
  const bar = ['done', '8px', '8px', ring];
  await expect.poll(() => look(`.tab[data-tab="${id}"] .tdot`)).toEqual(bar);
  expect(await look('.shead > .st')).toEqual(bar);
});

chatTest('popover_and_history_widget: the bars list the latest finished with their last answer; History groups, filters and searches', async ({ page, chatCore }) => {
  const talker = chatCore.chat('talker', true, false, 'demo');
  append(talker.file, rec.user('fix the login'), rec.assistant('Login redirect fixed, 12 tests pass.\nSecond line stays out.'));
  const quiet = chatCore.chat('quiet', false, false, 'demo'); // no transcript: its label is its line
  const live = chatCore.chat('live', true, false, 'demo');
  // One closed (the core stamps closed_at), one whose agent quit (its shell stays running): both finished.
  chatCore.cli('session', 'close', talker.id);
  chatCore.cli('session', 'send-text', quiet.id, 'EXIT\r');
  await expect.poll(() => snap(chatCore).filter((x) => (x.id === talker.id && x.state === 'closed') || (x.id === quiet.id && x.agent_ended)).length).toBe(2);
  for (const [w, h] of [[1440, 900], [1000, 760]] as const)
    for (const scheme of ['dark', 'light'] as const) {
      await page.setViewportSize({ width: w, height: h });
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      await page.clock.install();
      await openWindow(page, {}, chatCore);
      await page.clock.fastForward('11:00'); // the closed one has its end time: past its 10 minutes in the tree
      await narrow(page);
      const bars = head(page, 'demo').locator('button.dbar');
      await expect(bars).toHaveAttribute('data-done-bars', '2');
      await bars.click();
      const pop = page.getByRole('dialog', { name: 'demo · 2 finished' });
      await expect(pop.locator(`[data-done-item="${talker.id}"] .dpop-sub`)).toHaveText('Login redirect fixed, 12 tests pass.');
      await expect(pop.locator(`[data-done-item="${quiet.id}"] .dpop-sub`)).toHaveText('quiet');
      // The popover stays inside the window.
      const box = (await pop.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(w);
      if (w === 1440) await page.screenshot({ path: path.join(SHOTS, `1022-popover-${scheme}.png`), clip: { x: 0, y: 0, width: 520, height: 360 } });
      await pop.getByRole('button', { name: /View all in History/ }).click();
      await expect(pop).toHaveCount(0);
      const hist = page.locator('[data-history-view]');
      await expect(hist).toBeVisible();
      await expect(hist.getByRole('combobox', { name: 'Project' }).locator('option:checked')).toHaveText('demo'); // lane w59: the project list, not a chip
      await expect(hist.locator('.histv-day b').first()).toHaveText('Today');
      await expect(hist.locator('[data-history]')).toHaveCount(2); // the live one is not in History
      await expect(hist.locator(`[data-history="${live.id}"]`)).toHaveCount(0);
      await expect(hist.locator(`[data-history="${talker.id}"] .hr-sum`)).toHaveText('Login redirect fixed, 12 tests pass.');
      // Search: a name matches at once, conversation text through the core's scan.
      const q = hist.getByRole('searchbox', { name: /^Search name, branch, conversation/ });
      await q.fill('quiet');
      await expect(hist.locator('[data-history]')).toHaveCount(1);
      await q.fill('redirect');
      await expect(hist.locator(`[data-history="${talker.id}"]`)).toBeVisible();
      await expect(hist.locator('[data-history]')).toHaveCount(1);
      await q.fill('');
      // Stopped or failed: the closed one (stopped, grey) stays; the one whose agent quit on its own goes.
      await hist.getByRole('button', { name: 'Stopped or failed' }).click();
      await expect(hist.locator('[data-history]')).toHaveCount(1);
      await expect(hist.locator(`[data-history="${talker.id}"]`)).toBeVisible();
      await expect(hist.locator(`[data-history="${talker.id}"]`)).toHaveAttribute('data-end', 'stop'); // stopped is grey, not red (ticket 1029: the stop mark)
      await hist.getByRole('button', { name: 'Stopped or failed' }).click();
      await hist.locator(`[data-history="${talker.id}"]`).hover();
      if (w === 1440) await page.locator('.sbar[data-widget="history"]').screenshot({ path: path.join(SHOTS, `1022-history-${scheme}.png`) });
      // View conversation opens its read-only tab, with Resume.
      await hist.locator(`[data-history="${talker.id}"]`).getByRole('button', { name: 'View conversation' }).click();
      await expect(page.locator(`.tab[data-tab="${talker.id}"]`)).toHaveAttribute('aria-selected', 'true');
      // Back to the side, closed, for the next round.
      await page.getByRole('navigation', { name: 'Right bar' }).getByRole('button', { name: 'History', exact: true }).click();
      await expect(hist).toHaveCount(0);
      await page.keyboard.press('Meta+KeyW'); // the read-only tab goes, so the next round opens as this one did
      await expect(page.locator(`.tab[data-tab="${talker.id}"]`)).toHaveCount(0);
    }
});

chatTest('history_wide_tab_and_continue: History opens as a wide tab; Continue resumes the conversation', async ({ page, chatCore }) => {
  const talker = chatCore.chat('talker', true, false, 'demo');
  append(talker.file, rec.user('go'), rec.assistant('Done here.'));
  chatCore.chat('live', true, false, 'demo');
  chatCore.cli('session', 'close', talker.id);
  await expect.poll(() => snap(chatCore).find((x) => x.id === talker.id)?.state).toBe('closed');
  await openWindow(page, {}, chatCore);
  await page.getByRole('navigation', { name: 'Right bar' }).getByRole('button', { name: 'History', exact: true }).click();
  const hist = page.locator('[data-history-view]');
  await hist.getByRole('button', { name: 'Open as a tab' }).click();
  await expect(page.getByRole('tab', { name: 'History', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('[data-history-view][data-where="tab"]')).toBeVisible();
  await page.locator(`[data-history="${talker.id}"] .hr-go`).focus();
  await page.locator(`[data-history="${talker.id}"]`).getByRole('button', { name: 'Continue' }).click();
  await expect.poll(() => snap(chatCore).some((x) => x.label === 'talker' && x.id !== talker.id && x.state === 'running')).toBe(true);
  await page.keyboard.press('Meta+KeyW');
});

test('expanded_project_order: the lead row first (here in a worktree), then main-folder rows, then worktree rows, then the clean-up fold', async ({ app, core }) => {
  const p = repo(core, 'demo');
  worktree(core, p, 'wt-lead');
  worktree(core, p, 'wt-live');
  worktree(core, p, 'shipped');
  core.shell(p, 'main-a');
  core.shell(p, 'main-b');
  const shipped = snap(core).find((s) => s.label === 'shipped')!.id;
  // The core's PR chip for "shipped" says merged, so its row goes to the clean-up fold (TREEROWS).
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    const asked = new Set<number>();
    ws.onMessage((m) => {
      const r = typeof m === 'string' ? JSON.parse(m) : null;
      if (r?.request?.op === 'pr_chip' && r.request.id === shipped) asked.add(r.id);
      // Owner 11-17: the project's lead (Settings > Team), whose seat is the worktree session "wt-lead".
      if (r?.request?.op === 'team_list') return ws.send(JSON.stringify({ id: r.id, response: { Ok: { teammates: [{ id: 'lead-demo', name: 'Lead', job: 'lead', kind: 'claude', project: p, lead: true }], home: '' } } }));
      server.send(m);
    });
    server.onMessage((raw) => {
      const r = typeof raw === 'string' ? JSON.parse(raw) : null;
      if (r && asked.has(r.id)) return ws.send(JSON.stringify({ id: r.id, response: { Ok: { type: 'pr_chip', chip: { state: 'merged', url: 'https://github.com/acme/app/pull/52', at: null } } } }));
      if (r?.event !== 'snapshot') return ws.send(raw);
      // A waiting worktree row is the most urgent, and still comes after the main-folder rows.
      for (const s of r.sessions) if (s.label === 'wt-live') Object.assign(s.attention, { waiting: true });
      for (const s of r.sessions) if (s.label === 'wt-lead') s.teammate = 'lead-demo';
      ws.send(JSON.stringify(r));
    });
  });
  await openWindow(app);
  const grp = app.locator('.grp[data-project="demo"]');
  await expect(grp.locator('.cleanup')).toBeVisible();
  const order = await grp.evaluate((g) =>
    [...g.querySelectorAll('.row.wt2, .cleanup')].filter((e) => e.matches('.cleanup') || !e.closest('.cleanup')).map((e) => (e.matches('.cleanup') ? 'cleanup' : e.textContent!.includes('wt-lead') ? 'lead' : e.closest('[data-wt]') ? 'wt' : 'main')),
  );
  expect(order).toEqual(['lead', 'main', 'main', 'wt', 'cleanup']);
});
