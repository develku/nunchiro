// V2-CF4 (needs 127): a session's sub-agents fold under its own row as option A drew them. A real core, a fake
// Claude whose transcript the test writes, and the tree's own rows: the count is `↳ N` at the right end of the session
// row, opening it draws the children under that session only, and neither opening nor hovering ever sends anything.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { append, ChatCore, expect, rec, test } from './fixtures/chat/harness';
import type { Page } from '@playwright/test';
import { openQuiet, seed } from './tree-seed';
import { patchSnapshots } from './visual/compare';

/** A launch record as a real transcript writes it, optionally dated (`msAgo` before now) and otherwise undated. */
const launch = (id: string, name: string, label: string, msAgo?: number) => ({
  ...rec.use(id, name, { description: label, prompt: 'look' }),
  ...(msAgo === undefined ? {} : { timestamp: new Date(Date.now() - msAgo).toISOString() }),
});
const sideEnd = (id: string) => ({ type: 'assistant', isSidechain: true, parentToolUseID: id, message: { stop_reason: 'end_turn', content: [] }, uuid: `side-${id}` });

/** Two children under `a` and one under `b`, in their own projects' main folders. */
function seedChildren(core: ChatCore) {
  const a = core.chat('alpha');
  openQuiet(core); // idle projects sit in the quiet line until it is opened
  const b = core.chat('beta');
  append(a.file, launch('t1', 'Task', 'Explore: find ssh -G callers', 90_000), launch('t2', 'Agent', 'Plan: page layout', 90_000), sideEnd('t2'));
  append(b.file, launch('t3', 'Task', 'Review: delivery keys', 90_000));
  return { a: { ...a, project: core.project('alpha') }, b: { ...b, project: core.project('beta') } };
}

/** A token's computed colour, for comparing a painted background to it in this scheme. */
const probe = (app: Page, c: string) => app.evaluate((v) => { const d = document.createElement('i'); d.style.color = v; document.body.append(d); const r = getComputedStyle(d).color; d.remove(); return r; }, c);

const kidsOf = (app: Page, id: string) => app.locator(`.kids[data-session="${id}"]`);
const rowsOf = (app: Page, id: string) => kidsOf(app, id).locator('.row.kid');
const count = (app: Page, id: string) => app.locator(`.kidcount[data-kids~="${id}"]`);

test('count_on_session_row (worktree): a worktree session keeps its own row and the count on it', async ({ app, chatCore }) => {
  // A worktree row is a button, so its count sits beside it rather than inside: still on the row's line, never a row below.
  const p = chatCore.project('wt');
  const git = (...a: string[]) => execFileSync('git', ['-C', p, '-c', 'user.name=t', '-c', 'user.email=[EMAIL]', ...a]);
  git('init', '-q');
  git('commit', '-q', '--allow-empty', '-m', 'init');
  openQuiet(chatCore);
  const a = chatCore.chat('wt', true, true);
  append(a.file, launch('t1', 'Task', 'Explore: find ssh -G callers'));
  await app.goto('/');
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  const row = app.locator('.grp[data-project="wt"] .row.wt2');
  await expect(row).toHaveCount(1);
  await expect(row.locator('.kidcount')).toHaveCount(0); // not inside: a button cannot hold one
  const control = count(app, a.id);
  await expect(control).toHaveText('↳ 1');
  await expect(rowsOf(app, a.id)).toHaveCount(0); // folded: no extra row
  const [rowBox, countBox] = [(await row.boundingBox())!, (await control.boundingBox())!];
  expect(countBox.y + countBox.height).toBeGreaterThan(rowBox.y);
  expect(countBox.y).toBeLessThan(rowBox.y + rowBox.height);
  await control.click();
  await expect(rowsOf(app, a.id)).toHaveCount(1);
});

test('subagents_fold_under_session: two children start collapsed with no extra rows and open under their own session', async ({ app, chatCore }) => {
  const { a, b } = seedChildren(chatCore);
  await app.goto('/');
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  const control = count(app, a.id);
  await expect(control).toContainText('↳ 2');
  await expect(rowsOf(app, a.id)).toHaveCount(0); // collapsed: nothing extra
  await expect(count(app, b.id)).toContainText('↳ 1');
  await expect(rowsOf(app, b.id)).toHaveCount(0);
  // One click opens alpha's two; beta's stay its own and stay closed.
  await control.click();
  await expect(rowsOf(app, a.id)).toHaveCount(2);
  await expect(rowsOf(app, a.id).first()).toContainText('Explore: find ssh -G callers');
  await expect(rowsOf(app, b.id)).toHaveCount(0);
  await expect(kidsOf(app, a.id)).toHaveAttribute('data-open', 'true');
  // Both children belong to alpha's row, not to beta's.
  await expect(kidsOf(app, a.id).locator('.row.kid[data-label="Plan: page layout"]')).toHaveCount(1);
  await expect(kidsOf(app, b.id).locator('.row.kid[data-label="Plan: page layout"]')).toHaveCount(0);
  // A second click folds them again, closing the loop inside two clicks.
  await control.click();
  await expect(rowsOf(app, a.id)).toHaveCount(0);
});

test('count_on_session_row: the count sits inside the session row and folded adds no row', async ({ app, chatCore }) => {
  const { a } = seedChildren(chatCore);
  await app.goto('/');
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  // v25-new-tab (ticket 294 item 4, needs 213): an expanded project draws its idle main-folder session as a row of its own
  // (before, the project head was that row), so the count rides on that row's right end, as it does on a working row.
  const wrap = app.locator('.grp[data-project="alpha"] .wtwrap', { has: app.locator(`.kidcount[data-kids~="${a.id}"]`) });
  await expect(wrap).toHaveCount(1);
  await expect(app.locator('.grp[data-project="alpha"] .row.head .kidcount')).toHaveCount(0);
  // ...and there is no separate count row anywhere under the session.
  await expect(kidsOf(app, a.id).locator('.button, .row')).toHaveCount(0);
  const [rowBox, nameBox, countBox] = [(await wrap.boundingBox())!, (await wrap.locator('.row.wt2 .n').boundingBox())!, (await count(app, a.id).boundingBox())!];
  // At the row's own right end: inside the row's box both ways, and right of the name.
  expect(countBox.y).toBeGreaterThanOrEqual(rowBox.y);
  expect(countBox.y + countBox.height).toBeLessThanOrEqual(rowBox.y + rowBox.height);
  expect(countBox.x + countBox.width).toBeLessThanOrEqual(rowBox.x + rowBox.width);
  expect(countBox.x).toBeGreaterThan(nameBox.x);
  // Hovering the row moves nothing: the count stays where it was.
  await wrap.hover();
  expect(await count(app, a.id).boundingBox()).toEqual(countBox);
});

test('count_words_in_tooltip_only: the words are the label and tooltip; the number appears once', async ({ app, chatCore }) => {
  const { a } = seedChildren(chatCore);
  await app.goto('/');
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  const control = count(app, a.id);
  await expect(control).toHaveText('↳ 2');
  await expect(app.locator('.row', { hasText: 'sub-agents' })).toHaveCount(0);
  await expect(app.locator('.row.kidtop')).toHaveCount(0);
  // A launched child that has not ended is working (see `shown`): one of alpha's two, so the words say so.
  await expect(control).toHaveAttribute('title', '2 sub-agents, 1 working');
  await expect(control).toHaveAttribute('aria-label', "Show alpha's 2 sub-agents, 1 working");
});

test('subagent_rows_dimmed: expanded children are indented one step past the session row, dimmed, with a label and a state word', async ({ app, chatCore }) => {
  const { a } = seedChildren(chatCore);
  await app.goto('/');
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  await count(app, a.id).click();
  const rows = rowsOf(app, a.id);
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toHaveAttribute('data-state', 'running');
  await expect(rows.nth(1)).toHaveAttribute('data-state', 'done');
  // Labels and the state word in words, so colour is never the only carrier; a child never reads "unknown", and a
  // running one carries its age ("working 1m", the mockup's own wording).
  await expect(rows.first().locator('.s')).toHaveText(/^working \d+[smh]$/);
  await expect(rows.first().locator('.s')).toHaveText('working 1m');
  await expect(rows.nth(1).locator('.s')).toHaveText('done');
  await expect(app.locator('.row.kid .s', { hasText: 'unknown' })).toHaveCount(0);
  // Ticket 1041 lane 4 (08150d02e): rows lose the rail and the working arc; the state is a light (light-glass.css). A working child has the blue working light, a done one none (kids.tsx).
  await expect(rows.first()).toHaveClass(/\blight-run\b/);
  await expect(rows.nth(1)).not.toHaveClass(/\blight-/);
  // Dimmed and indented one step past the session row: option A's proportions, shared tokens (no rail since ticket 1041).
  expect(await rows.first().evaluate((e) => getComputedStyle(e).color)).toBe(await probe(app, await tok(app, '--muted')));
  // One step in from the row they hang under (a main-folder session has no row of its own: its project head is the row),
  // and smaller type than it.
  const head = app.locator('.grp[data-project="alpha"] .row.head .n').first();
  const size = (l: import('@playwright/test').Locator) => l.evaluate((e) => parseFloat(getComputedStyle(e).fontSize));
  expect((await rows.first().boundingBox())!.x).toBeGreaterThan((await head.boundingBox())!.x);
  expect(await size(rows.first())).toBeLessThan(await size(head));
});

const tok = (app: Page, name: string) => app.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);

test('child_shows_age: a running child reads "working" and the age since its own launch record', async ({ app, chatCore }) => {
  // The projection dates a child from its launch record's timestamp, the only time a transcript states: 90s ago reads
  // "1m", as the mockup draws it, so the word and the age come from one read, not a stopwatch of the window's own.
  const { a } = seedChildren(chatCore);
  await app.goto('/');
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  await count(app, a.id).click();
  const row = rowsOf(app, a.id).first();
  await expect(row).toHaveAttribute('data-state', 'running');
  await expect(row.locator('.s')).toHaveText('working 1m');
  // A finished child has no age: it is done, not running for how long.
  await expect(rowsOf(app, a.id).nth(1).locator('.s')).toHaveText('done');
  // Coarse, as the mockup's "1m": seconds are dropped, and the value is a whole minute here rather than 90s.
  await expect(row.locator('.s')).not.toHaveText(/working \d+s$/);
});

test('unknown_child_not_working: a child nobody reported a state or a launch time for says nothing, stays grey and is not counted', async ({ app, chatCore }) => {
  // A launch record with no `timestamp` is a child the transcript does not date and never ended: truly unknown, which
  // the tree must not dress up as running.
  const c = chatCore.chat('gamma');
  openQuiet(chatCore);
  append(c.file, rec.use('t1', 'Task', { description: 'Explore: find ssh -G callers', prompt: 'look' }));
  await app.goto('/');
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  const control = count(app, c.id);
  // One child, none of them working: a child with no reported state is not a running one.
  await expect(control).toHaveText('↳ 1');
  await expect(control).toHaveAttribute('title', '1 sub-agents, 0 working');
  await control.click();
  const row = rowsOf(app, c.id);
  await expect(row).toHaveCount(1);
  await expect(row).toHaveAttribute('data-state', 'unknown');
  // No word at all rather than "unknown" or a guessed "working": nothing to say is not the same as running.
  await expect(row.locator('.s')).toHaveCount(0);
  // Ticket 1041 lane 4 (08150d02e): rows lose the rail and the working arc; the state is a light (light-glass.css). No light: only a working or failed child has one.
  await expect(row).not.toHaveClass(/\blight-/);
});

test('subagents_reachable_within_two_clicks: the count is a labelled button that opens by pointer and by keyboard', async ({ app, chatCore }) => {
  const { a } = seedChildren(chatCore);
  await app.goto('/');
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  // A visible, labelled control rather than a shortcut: its accessible name says what it opens.
  const control = app.getByRole('button', { name: /Show alpha's 2 sub-agents, 1 working/ });
  await expect(control).toBeVisible();
  await expect(control).toHaveAttribute('aria-expanded', 'false');
  await expect(control).toHaveAttribute('title', '2 sub-agents, 1 working');
  // Keyboard: focus and Enter open it, exactly as a click does.
  await control.focus();
  await app.keyboard.press('Enter');
  await expect(rowsOf(app, a.id)).toHaveCount(2);
  await expect(app.getByRole('button', { name: /Hide alpha's 2 sub-agents, 1 working/ })).toHaveAttribute('aria-expanded', 'true');
});

test('subagent_fold_never_sends: mount, expand, collapse, hover and focus write nothing to the agent or the transcript', async ({ app, chatCore }) => {
  const { a } = seedChildren(chatCore);
  await app.goto('/');
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  const before = fs.readFileSync(a.file);
  const control = count(app, a.id);
  await control.hover();
  await control.focus();
  await app.keyboard.press('Enter');
  await expect(rowsOf(app, a.id)).toHaveCount(2);
  await rowsOf(app, a.id).first().hover();
  await rowsOf(app, a.id).first().focus();
  await control.click();
  await expect(rowsOf(app, a.id)).toHaveCount(0);
  await expect
    .poll(() => fs.readFileSync(a.file).equals(before), { timeout: 3000 })
    .toBe(true);
  // The session saw no keystroke: the fake agent echoes nothing after its banner, and its screen still ends at it.
  const screen = chatCore.screen(a.id);
  expect(screen).not.toMatch(/answered/);
  expect(screen).toContain('fake chat agent');
});

test('subagent_permission_once_on_parent: a child permission stays exactly one decision on the parent, collapsed or open', async ({ app, chatCore }) => {
  const { a } = seedChildren(chatCore);
  // The parent waits on a permission (a fake cannot raise a real one, so the snapshot carries it, as tree-rows does).
  await patchSnapshots(app, { alpha: { waiting: 'permission' } });
  await app.goto('/');
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  const decisions = () => chatCore.cli('snapshot', '--json').sessions.flatMap((s: { pending: unknown[] }) => s.pending).length;
  const control = count(app, a.id);
  await expect(control).toContainText('↳ 2');
  // The waiting row is the parent's own: one decision line under its head, and the head counts one waiting.
  const waiting = app.locator(`.grp[data-project="alpha"] .q[data-line="${a.id}"]`);
  await expect(waiting).toHaveCount(1);
  await expect(app.locator('.grp[data-project="alpha"] .row.head .cstrip > .sg[data-tone="o"]')).toHaveAttribute('data-n', '1'); // ticket 388: the orange strip colour
  await control.click();
  await expect(rowsOf(app, a.id)).toHaveCount(2);
  await control.click();
  await expect(rowsOf(app, a.id)).toHaveCount(0);
  // Opening and folding children created no queue item and offers no answer control of its own.
  expect(decisions()).toBe(0);
  await expect(app.locator(`.grp[data-project="alpha"] [data-answer], .grp[data-project="alpha"] .choices`)).toHaveCount(0);
});

test('subagent_tree_groups_preserved: groups, pins, quiet lines and Expand all draw the counts without moving or unfolding anything', async ({ app, chatCore }) => {
  const { a, b } = seedChildren(chatCore);
  seed(chatCore, { op: 'group_create', name: 'Web', project: a.project }, { op: 'pin', project: b.project, pinned: true }, { op: 'fold', key: 'group:Web', folded: true });
  await app.goto('/');
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  await app.mouse.move(900, 400);
  // The group stays folded over alpha's session, so its count is not drawn: folding is the group's, not the count's.
  await expect(app.locator('.pgrp[data-group="Web"] .kidcount')).toHaveCount(0);
  await expect(count(app, b.id)).toContainText('↳ 1');
  // Opening one session's children moves nothing else: no row is re-sorted, no project leaves its group or pin.
  // Indent and width are the rows' own: opening children adds rows below, so only these must stay put.
  const at = (l: import('@playwright/test').Locator) => l.evaluate((e) => { const r = e.getBoundingClientRect(); return [r.x, r.width].map(Math.round).join(','); });
  const heads = [app.locator('.grp[data-project="beta"] .row.head'), app.locator('.pgrp[data-group="Web"] .ghead')];
  const before = await Promise.all(heads.map(at));
  await count(app, b.id).click();
  await expect(rowsOf(app, b.id)).toHaveCount(1);
  expect(await Promise.all(heads.map(at))).toEqual(before);
  const order = await app.locator('.tree .grp[data-project]').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.project));
  expect(order).toEqual(['beta']);
  // Expand all opens the group too, and the counts arrive with their rows.
  await app.getByRole('button', { name: 'Expand all' }).click();
  await expect(count(app, a.id)).toContainText('↳ 2');
  const grouped = await app.locator('.pgrp[data-group="Web"] .grp').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.project));
  expect(grouped).toEqual(['alpha']);
});
