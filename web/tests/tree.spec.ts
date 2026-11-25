import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { boxes, expect, openWindow, test, unmoved, type Core, stripOnTop } from './fixtures';
import { openQuiet } from './tree-seed';

test.beforeEach(({ core }) => stripOnTop(core, { below: true })); // D5b: the default window has no AGENTS rows; ticket 180: strip under the composer (needs 107)

const arrive = (dir: string, trigger: string) => fs.writeFileSync(path.join(dir, trigger), '');
/** The default fake leaves its dialog on screen after an answer; this one clears it, so the item really resolves. */
const clearing = (core: Core) => {
  const file = path.join(core.home, 'bin/claude');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace("printf 'answered %s", "printf '\\033[2J\\033[Hanswered %s"), { mode: 0o700 });
};
/** Answers the fake agent's dialog: option 1, then Enter. */
const answerAgent = (core: Core, id: string) => core.cli('session', 'send-keys', id, '1', 'enter') // lane w102: send-text waits out a start question;
const grpOf = (app: import('@playwright/test').Page, name: string) => app.locator(`.grp[data-project="${name}"]`);
/** The head row's your-turn count (ticket 388: the orange strip colour's `data-n`), or 0 when it shows none. One read: an
 *  element counted and then read separately can vanish in between, and textContent() then waits forever (V1A-46). */
const headWaiting = (grp: import('@playwright/test').Locator) =>
  grp.locator('.head').first().evaluate((h) => Number(h.querySelector(':scope > .cstrip > .sg[data-tone="o"]')?.getAttribute('data-n') ?? 0));
/** needs-decision board.toml with one file source, as in board-queue.spec. */
function boardCard(core: Core, project: string) {
  const toml = `version = 1
[[columns]]
id = 'ask'
title = 'Needs decision'
needs_decision = true
states = ['needs_decision']
[sources]
version = 1
[[sources.entries]]
name = 'roadmap'
kind = 'file'
path = ${JSON.stringify(path.join(core.home, 'cards.json'))}
`;
  fs.writeFileSync(path.join(core.home, 'board.toml'), toml);
  const write = (cards: object[]) => {
    const tmp = path.join(core.home, 'cards.tmp');
    fs.writeFileSync(tmp, JSON.stringify({ cards }));
    fs.renameSync(tmp, path.join(core.home, 'cards.json'));
  };
  write([]);
  return () => write([{ id: 'c1', title: 'Card c1', updated_at: 1, project, needs_decision: { question: 'Ship it?' } }]);
}
// v25-new-tab (ticket 294 item 4, needs 213): an expanded project draws its idle main-folder sessions as rows of their own
// (before, the head was their row). Specs below that counted rows follow that.
test('tree C: a project with one idle session shows its head row and that session\'s row', async ({ app, core }) => {
  core.shell(core.project('nunchiro'), 'shell');
  openQuiet(core); // V2-9a: quiet projects start folded
  await openWindow(app);
  const grp = grpOf(app, 'nunchiro');
  await expect(grp.locator('.head')).toBeVisible();
  await expect(grp.locator('.q')).toHaveCount(0);
  await expect(grp.locator('.more')).toHaveCount(0);
  await expect(grp.locator('.row')).toHaveCount(2);
  await expect(grp.locator('.row.wt2')).toHaveText(/shell/);
  await expect(grp).not.toContainText('+N');
});

test('tree C: one waiting item shows one row and no +N', async ({ app, core }) => {
  const p = core.project('nunchiro');
  core.agent(p, 'agent-a', 'go-a');
  await openWindow(app);
  const grp = grpOf(app, 'nunchiro');
  await expect(grp.locator('.q')).toHaveCount(0);
  arrive(p, 'go-a');
  await expect(grp.locator('.q')).toHaveCount(1, { timeout: 5000 });
  await expect(grp.locator('.q')).toHaveCount(1);
  await expect(grp.locator('.more')).toHaveCount(0);
  await expect(app.locator('.tree')).not.toContainText('+');
});

test('tree C: three items show two rows and +1, a click opens the panel card', async ({ app, core }) => {
  const p = core.project('nunchiro');
  const ids = ['a', 'b', 'c'].map((t) => core.agent(p, `agent-${t}`, `go-${t}`).id);
  await openWindow(app);
  const grp = grpOf(app, 'nunchiro');
  for (const t of ['a', 'b', 'c']) arrive(p, `go-${t}`);
  await expect(grp.locator('.q')).toHaveCount(2, { timeout: 5000 });
  await expect(grp.locator('.q')).toHaveCount(2);
  await expect(grp.locator('.more')).toHaveText('+1');
  await expect(grp).toHaveAttribute('data-urgency', 'waiting');
  await expect(grp.locator('.sess .row.wt2').first()).toHaveAttribute('aria-label', /Needs permission/); // RC gap 3: the session row carries the label, in the TREEROWS tip's words
  await app.evaluate(() => {
    (window as unknown as { focused: unknown[] }).focused = [];
    window.addEventListener('nunchiro:queue.focus', (e) => (window as unknown as { focused: unknown[] }).focused.push((e as CustomEvent).detail));
  });
  const first = grp.locator('.q').first();
  const session = await first.getAttribute('data-line');
  await first.click();
  // V2-8e (HIDEROWS): a click on a decision opens its session's panel card instead of focusing the strip card.
  const focused = await app.evaluate(() => (window as unknown as { focused: { id: string; session: string }[] }).focused);
  expect(focused).toHaveLength(0);
  expect(ids).toContain(session);
  // DECISIONW: the Decisions widget (right sidebar) shows it; the tab does not change.
  await expect(app.locator(`aside.sbar[data-side="right"] .deccard[data-session="${session}"]`)).toBeVisible();
  // Tab dots show waiting too.
  for (const id of ids) await expect(app.locator(`.tab[data-tab="${id}"] .tdot`)).toHaveAttribute('data-s', 'waiting');
});

test('tree C: a collapsed project hides its worktree rows, keeps its decision rows, and shows waiting in its counts and group bar', async ({ app, core }) => {
  const p = core.project('lumen');
  const git = (...args: string[]) => execFileSync('git', ['-C', p, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args]);
  git('init', '-q');
  git('commit', '-q', '--allow-empty', '-m', 'init');
  const ui = core.agent(p, 'ui-02', 'go');
  core.cli('session', 'start', '--kind', 'shell', '--project', p, '--label', 'wt', '--worktree', '--', '/bin/cat'); // a worktree row to hide
  openQuiet(core); // V2-9a: quiet projects start folded
  await openWindow(app);
  const grp = app.locator('.grp[data-project="lumen"]');
  await expect(grp.locator(`.row.wt2:not([data-menu-session="${ui.id}"])`)).toHaveCount(1);
  await grp.getByRole('button', { name: 'Collapse lumen' }).click();
  await expect(grp.locator('.q')).toHaveCount(0);
  arrive(p, 'go');
  await expect(grp).toHaveAttribute('data-urgency', 'waiting');
  await expect(grp.locator('.head .r')).toHaveAttribute('aria-label', /1 waiting/);
  await expect(grp.locator('.q')).toHaveCount(0); // the pointer is in the tree: the arrival waits (needs 49)
  await expect(grp.locator('.head .chip')).toHaveText('new 1');
  await app.mouse.move(900, 400);
  await app.locator('.cbox textarea').focus(); // the chevron kept focus in the tree (Chromium)
  await expect(grp.locator('.q')).toHaveCount(1); // TREEROWS / V2-9: decision rows stay under a folded header
  await expect(grp.locator(`.row.wt2:not([data-menu-session="${ui.id}"])`)).toHaveCount(0);
  // Collapse is remembered by the window.
  await app.reload();
  await expect(app.locator('.grp[data-project="lumen"] .head .chev')).toHaveAttribute('aria-expanded', 'false');
  await expect(app.locator(`.grp[data-project="lumen"] .row.wt2:not([data-menu-session="${ui.id}"])`)).toHaveCount(0);
});

test('tree C: two projects, pointer on one while the other receives items: neither moves, arrivals wait as "new N"', async ({ app, core }) => {
  const a = core.project('alpha');
  const b = core.project('beta');
  core.agent(a, 'a1', 'go-1');
  core.agent(a, 'a2', 'go-2');
  core.agent(a, 'a3', 'go-3');
  core.shell(b, 'b1');
  openQuiet(core); // V2-9a: quiet projects start folded
  await openWindow(app);
  await expect(app.locator('.grp[data-project]')).toHaveCount(2);
  // Pointer rests on beta's head row, below alpha's slots.
  await app.locator('.grp[data-project="beta"] .head .n').hover();
  const before = await boxes(app);
  for (const t of ['go-1', 'go-2', 'go-3']) arrive(a, t);
  const alpha = app.locator('.grp[data-project="alpha"]');
  await expect(alpha).toHaveAttribute('data-urgency', 'waiting', { timeout: 5000 });
  await expect(alpha.locator('.head .chip')).toHaveText('new 3');
  await expect(alpha.locator('.q')).toHaveCount(0);
  // A brand-new project does not push rows in either.
  core.shell(core.project('gamma'), 'g1');
  await app.waitForTimeout(400);
  await expect(app.locator('.grp[data-project]')).toHaveCount(2);
  // V1A-60b (needs 77): the answer strip appears or goes; no tree row moves.
  // v25-empty (needs 140): an idle session's composer sits inside its centred empty block, so the block re-centres by
  // the strip's height and the composer moves with it. That is the block, not a tree row.
  await expect.poll(async () => unmoved(before, await boxes(app)).sort(), { timeout: 3000 }).toEqual(['cbox', 'strip']); // ticket 600: the strip may draw a frame before the composer re-centres; a tree row that moves still fails
  // Leaving the sidebar releases the freeze.
  await app.mouse.move(900, 400);
  await expect(alpha.locator('.q')).toHaveCount(2);
  await expect(alpha.locator('.more')).toHaveText('+1');
  await expect(app.locator('.grp[data-project]')).toHaveCount(3);
});

test('tree C: keyboard focus freezes rows, chip and answered row the same way', async ({ app, core }) => {
  const a = core.project('alpha');
  core.agent(a, 'a1', 'go-1');
  openQuiet(core); // V2-9a: quiet projects start folded
  await openWindow(app);
  await app.locator('.grp[data-project="alpha"] .head .n').focus();
  await app.mouse.move(900, 400);
  arrive(a, 'go-1');
  const alpha = app.locator('.grp[data-project="alpha"]');
  await expect(alpha.locator('.head .chip')).toHaveText('new 1', { timeout: 5000 });
  await expect(alpha.locator('.q')).toHaveCount(0);
  await app.locator('.cbox textarea').focus();
  await expect(alpha.locator('.q')).toHaveCount(1);
});

test('tree C: a worktree shows as its own row (rail and icon) whenever the project is open; the old fold row is gone', async ({ app, core }) => {
  const p = core.project('repo');
  const git = (...args: string[]) => execFileSync('git', ['-C', p, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args]);
  git('init', '-q');
  git('commit', '-q', '--allow-empty', '-m', 'init');
  core.shell(p, 'main-shell');
  core.agent(p, 'wt-agent', 'go', true);
  openQuiet(core); // V2-9a: quiet projects start folded
  await openWindow(app);
  const grp = app.locator('.grp[data-project="repo"]');
  await expect(grp.getByRole('button', { name: /worktree 1/ })).toHaveCount(0);
  await expect(grp.locator('.row.wt2:not([data-menu="treerow"])')).toHaveCount(1); // the main folder's idle session has its own `treerow`
  await expect(grp.locator('.row.wt2:not([data-menu="treerow"]) .ic svg')).toHaveCount(0); // ticket 1041: an idle row is bare (owner 11-22)
  await grp.getByRole('button', { name: 'Collapse repo' }).click(); // a user-folded project hides its rows
  await expect(grp.locator('.row.wt2')).toHaveCount(0);
});

test('tree C: an item arriving while hovered changes no row and shows the new chip, then applies after leave', async ({ app, core }) => {
  const p = core.project('alpha');
  core.agent(p, 'a1', 'go-1');
  core.agent(p, 'a2', 'go-2');
  core.shell(core.project('beta'), 'b1');
  openQuiet(core); // V2-9a: quiet projects start folded
  await openWindow(app);
  const alpha = grpOf(app, 'alpha');
  await alpha.locator('.head .n').hover();
  const before = await boxes(app);
  arrive(p, 'go-1');
  await expect(alpha).toHaveAttribute('data-urgency', 'waiting', { timeout: 5000 });
  await expect(alpha.locator('.head .chip')).toHaveText('new 1');
  arrive(p, 'go-2');
  await expect(alpha.locator('.head .chip')).toHaveText('new 2');
  expect(await alpha.locator('.q').count()).toBe(0);
  // V1A-60b (needs 77): the answer strip appears or goes; no tree row moves.
  // v25-empty (needs 140): the idle session's composer rides in the centred empty block, so it re-centres with the strip.
  await expect.poll(async () => unmoved(before, await boxes(app)).sort(), { timeout: 3000 }).toEqual(['cbox', 'strip']); // ticket 600: the strip may draw a frame before the composer re-centres; a tree row that moves still fails
  await app.mouse.move(900, 400);
  await expect(alpha.locator('.q')).toHaveCount(2);
  await expect(alpha.locator('.head .chip')).toHaveText('');
});

test('tree C: a worktree line that appears while hovered shows only after leave', async ({ app, core }) => {
  const p = core.project('repo');
  const git = (...args: string[]) => execFileSync('git', ['-C', p, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args]);
  git('init', '-q');
  git('commit', '-q', '--allow-empty', '-m', 'init');
  core.shell(p, 'main-shell');
  openQuiet(core); // V2-9a: quiet projects start folded
  await openWindow(app);
  const grp = grpOf(app, 'repo');
  await grp.locator('.head .n').hover();
  core.agent(p, 'wt-agent', 'go', true);
  await app.waitForTimeout(500);
  await expect(grp.locator('.row.wt2:not([data-menu="treerow"])')).toHaveCount(0);
  await app.mouse.move(900, 400);
  await expect(grp.locator('.row.wt2:not([data-menu="treerow"])')).toHaveCount(1);
});

test('tree C: collapsed during a freeze, the head counts follow and the rows come back expanded after leave', async ({ app, core }) => {
  const p = core.project('alpha');
  core.agent(p, 'a1', 'go-1');
  openQuiet(core); // V2-9a: quiet projects start folded
  await openWindow(app);
  const alpha = grpOf(app, 'alpha');
  await alpha.getByRole('button', { name: 'Collapse alpha' }).click();
  arrive(p, 'go-1');
  await expect(alpha.locator('.head .r')).toHaveAttribute('aria-label', /1 waiting/, { timeout: 5000 });
  await expect(alpha.locator('.q')).toHaveCount(0);
  await expect(alpha).toHaveAttribute('data-urgency', 'waiting');
});

test('tree C: answering while hovered keeps the row dimmed with a check until the pointer leaves', async ({ app, core }) => {
  clearing(core);
  const p = core.project('alpha');
  const a = core.agent(p, 'a1', 'go-1');
  core.shell(core.project('beta'), 'b1');
  // V1A-46: the hover hold also ends after 5 s idle (Sidebar IDLE_MS), and the answer's Enter alone may wait 3 s (core
  // SETTLE): on a loaded host the real clock released the row before the checks below.
  await app.clock.install();
  openQuiet(core); // V2-9a: quiet projects start folded
  await openWindow(app);
  const alpha = grpOf(app, 'alpha');
  arrive(p, 'go-1');
  await expect(alpha.locator('.q')).toHaveCount(1, { timeout: 5000 });
  await alpha.locator('.q').evaluate((e) => Promise.all(e.getAnimations().map((x) => x.finished))); // the arrival fade-in
  // Paused before the hover arms the idle bound, 1 s ahead so a host stall cannot put the target in the past.
  await app.clock.pauseAt((await app.evaluate(() => Date.now())) + 1000);
  await alpha.locator('.head .n').hover();
  const before = await boxes(app);
  answerAgent(core, a.id);
  await expect(alpha.locator('.q.answered')).toContainText('✓', { timeout: 5000 });
  await expect(alpha.locator('.q')).toHaveCount(1);
  // TREEHEAD-FREEZE (tree4 r3, owner 2026-11-02): the live label has the new count at once, but the hovered head still draws the pill it drew
  // when the hover began, and the pill goes when the pointer leaves (below).
  await expect(alpha.locator('.head .r')).not.toHaveAttribute('aria-label', /1 waiting/, { timeout: 5000 });
  expect(await headWaiting(alpha)).toBe(1);
  // V1A-60b (needs 77): the answer strip appears or goes; no tree row moves.
  // v25-empty (needs 140): the idle session's composer rides in the centred empty block, so it re-centres with the strip.
  await expect.poll(async () => unmoved(before, await boxes(app)).sort(), { timeout: 3000 }).toEqual(['cbox', 'strip']); // ticket 600: the strip may draw a frame before the composer re-centres; a tree row that moves still fails
  // V1A-50: with the clock paused nothing can end the hold but the pointer, so no leave has started yet.
  await expect(app.locator('aside.dock.l')).not.toHaveAttribute('data-leaving', 'true');
  await app.mouse.move(900, 400);
  await app.clock.resume(); // the 150 ms leave
  await expect(alpha.locator('.q')).toHaveCount(0);
  await expect(alpha.locator('.row')).toHaveCount(2); // the head, and the answered session's row (idle now, it stays: needs 213)
  expect(await headWaiting(alpha)).toBe(0);
});

test('tree C: reduced motion applies changes without animation', async ({ app, core }) => {
  const p = core.project('alpha');
  core.agent(p, 'a1', 'go-1');
  core.agent(p, 'a2', 'go-2');
  await openWindow(app);
  const alpha = grpOf(app, 'alpha');
  const duration = (id: string) => alpha.locator(`.q[data-item]`).nth(Number(id)).evaluate((e) => getComputedStyle(e).animationDuration);
  arrive(p, 'go-1');
  await expect(alpha.locator('.q')).toHaveCount(1, { timeout: 5000 });
  expect(await duration('0')).toBe('0.15s');
  await app.emulateMedia({ reducedMotion: 'reduce' });
  arrive(p, 'go-2');
  await expect(alpha.locator('.q')).toHaveCount(2, { timeout: 5000 });
  expect(await duration('1')).toBe('0s');
});

test('tree C: the head count matches visible rows plus overflow', async ({ app, core }) => {
  const p = core.project('alpha');
  for (const t of ['a', 'b', 'c']) core.agent(p, `agent-${t}`, `go-${t}`);
  const q = core.project('beta');
  core.shell(q, 'beta shell');
  const flag = boardCard(core, q);
  openQuiet(core); // V2-9a: quiet projects start folded
  await openWindow(app);
  const alpha = grpOf(app, 'alpha');
  const beta = grpOf(app, 'beta');
  expect(await headWaiting(alpha)).toBe(0);
  for (const t of ['a', 'b', 'c']) arrive(p, `go-${t}`);
  await expect(alpha.locator('.more')).toHaveText('+1', { timeout: 5000 });
  expect((await alpha.locator('.q').count()) + 1).toBe(await headWaiting(alpha));
  // A board item is a row but no waiting session: it shows as its row; the head's strip counts sessions only (ticket 388).
  flag();
  await expect(beta.locator('.q')).toHaveCount(1, { timeout: 5000 });
  expect(await headWaiting(beta)).toBe(0);
});

test('tree C: the chip and a dimmed row have accessible names, and focus survives the apply', async ({ app, core }) => {
  clearing(core);
  const p = core.project('alpha');
  const a = core.agent(p, 'a1', 'go-1');
  core.agent(p, 'a2', 'go-2');
  await openWindow(app);
  const alpha = grpOf(app, 'alpha');
  arrive(p, 'go-1');
  await expect(alpha.locator('.q')).toHaveCount(1, { timeout: 5000 });
  await alpha.locator('.sess .row.wt2').focus(); // RC gap 3: the session row is the focus stop
  arrive(p, 'go-2');
  await expect(alpha.getByRole('status', { name: '1 new waiting item' })).toHaveText('new 1');
  answerAgent(core, a.id);
  // RC gap 3: the focused stop is a1's session row; its block's line names the answered state.
  await expect(alpha.getByRole('button', { name: /^a1, / })).toBeFocused({ timeout: 5000 });
  await expect(alpha.locator('.sess').filter({ has: app.getByRole('button', { name: /^a1, / }) }).locator('.q.answered')).toContainText(/answered/i);
  // Focus leaves: rows apply and focus is where the user sent it, never lost to the body.
  await app.locator('.cbox textarea').focus();
  await expect(alpha.locator('.q')).toHaveCount(1);
  await expect(alpha.getByRole('button', { name: /^a2, / })).toBeVisible();
  expect(await app.evaluate(() => document.activeElement?.tagName)).toBe('TEXTAREA');
});

// A parked pointer, a lost window or a cancelled pointer must never leave the tree frozen (review r1 MUST).
const RELEASES: [string, (app: import('@playwright/test').Page) => Promise<void>][] = [
  ['window blur', (app) => app.evaluate(() => void window.dispatchEvent(new Event('blur')))],
  [
    'the page turning hidden',
    (app) =>
      app.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
        document.dispatchEvent(new Event('visibilitychange'));
      }),
  ],
  ['pointercancel', (app) => app.evaluate(() => void document.querySelector('aside.dock.l')!.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true })))],
  ['the pointer leaving the window', (app) => app.evaluate(() => void document.body.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, relatedTarget: null })))],
];
for (const [name, release] of RELEASES) {
  test(`tree C: the freeze releases on ${name}`, async ({ app, core }) => {
    const p = core.project('alpha');
    core.agent(p, 'a1', 'go-1');
    core.shell(core.project('beta'), 'b1');
    openQuiet(core); // V2-9a: quiet projects start folded
    await openWindow(app);
    const alpha = grpOf(app, 'alpha');
    await grpOf(app, 'beta').locator('.head .n').hover();
    arrive(p, 'go-1');
    await expect(alpha.locator('.head .chip')).toHaveText('new 1', { timeout: 5000 });
    await release(app);
    await expect(alpha.locator('.q')).toHaveCount(1);
    await expect(app.locator('aside.dock.l')).toHaveAttribute('data-held', 'false');
  });
}

test('tree C: a parked pointer releases after 5 s idle and a pointer move freezes again', async ({ app, core }) => {
  const p = core.project('alpha');
  core.agent(p, 'a1', 'go-1');
  core.agent(p, 'a2', 'go-2');
  core.shell(core.project('beta'), 'b1');
  await app.clock.install();
  openQuiet(core); // V2-9a: quiet projects start folded
  await openWindow(app);
  const alpha = grpOf(app, 'alpha');
  const head = grpOf(app, 'beta').locator('.head .n');
  await head.hover();
  arrive(p, 'go-1');
  await expect(alpha.locator('.head .chip')).toHaveText('new 1', { timeout: 5000 });
  await app.clock.fastForward(4000);
  await expect(alpha.locator('.q')).toHaveCount(0);
  await app.clock.fastForward(1500);
  await expect(alpha.locator('.q')).toHaveCount(1);
  // The pointer moves again: frozen again, the next arrival waits.
  const at = (await head.boundingBox())!;
  await app.mouse.move(at.x + 5, at.y + 5);
  await app.mouse.move(at.x + 9, at.y + 6);
  arrive(p, 'go-2');
  await expect(alpha.locator('.head .chip')).toHaveText('new 1', { timeout: 5000 });
  await expect(alpha.locator('.q')).toHaveCount(1);
});

test('tree C: the chip is one persistent live region: empty first, then holding the text', async ({ app, core }) => {
  const p = core.project('alpha');
  core.agent(p, 'a1', 'go-1');
  core.shell(core.project('beta'), 'b1');
  openQuiet(core); // V2-9a: quiet projects start folded
  await openWindow(app);
  const alpha = grpOf(app, 'alpha');
  const region = alpha.locator('.head [role="status"]');
  await expect(region).toHaveCount(1);
  await expect(region).toHaveText('');
  await expect(region).toHaveAttribute('aria-live', 'polite');
  const node = await region.elementHandle();
  await grpOf(app, 'beta').locator('.head .n').hover();
  arrive(p, 'go-1');
  await expect(region).toHaveText('new 1', { timeout: 5000 });
  expect(await node!.evaluate((e) => e.isConnected)).toBe(true); // the same element, not a new one
});

// v1a-28: the 5 s idle release removes the answered row that holds focus; focus must land on a neighbor, never on body.
async function idleFocus(app: import('@playwright/test').Page, core: Core, focusOn: string, answer: string[], waiting: string[]) {
  clearing(core);
  const p = core.project('alpha');
  const agents = new Map(waiting.map((n, i) => [n, core.agent(p, n, `go-${i}`)] as const));
  await app.clock.install();
  openQuiet(core); // V2-9a: quiet projects start folded; alpha goes quiet when its only waiting row is answered
  await openWindow(app);
  const alpha = grpOf(app, 'alpha');
  for (const [i] of waiting.entries()) {
    arrive(p, `go-${i}`);
    await expect(alpha.locator('.q')).toHaveCount(i + 1, { timeout: 5000 });
  }
  await alpha.getByRole('button', { name: new RegExp(`^${focusOn}, `) }).focus();
  for (const n of answer) answerAgent(core, agents.get(n)!.id);
  await expect(alpha.locator('.q.answered')).toHaveCount(answer.length, { timeout: 5000 });
  await app.clock.fastForward(5500);
  await expect(alpha.locator('.q.answered')).toHaveCount(0);
  return alpha;
}
const activeName = (app: import('@playwright/test').Page) => app.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.tagName);

test('tree C: idle release moves focus from a removed answered row to the next row', async ({ app, core }) => {
  const alpha = await idleFocus(app, core, 'a1', ['a1'], ['a1', 'a2']);
  await expect(alpha.getByRole('button', { name: /^a2, / })).toBeFocused();
  // The move is no new arrival: the live region stays empty and the tree does not re-freeze by itself.
  await expect(alpha.locator('.head [role="status"]')).toHaveText('');
  await expect(app.locator('aside.dock.l')).toHaveAttribute('data-held', 'false');
  // A key after release freezes again as before.
  await app.keyboard.press('Shift');
  await expect(app.locator('aside.dock.l')).toHaveAttribute('data-held', 'true');
});

test('tree C: idle release moves focus to the previous row when the removed row was last', async ({ app, core }) => {
  const alpha = await idleFocus(app, core, 'a2', ['a2'], ['a1', 'a2']);
  await expect(alpha.getByRole('button', { name: /^a1, / })).toBeFocused();
  expect(await activeName(app)).toMatch(/^a1, /);
});

test('idle_release_focus_head: tree C: idle release moves focus to the project head when the removed row was the only one', async ({ app, core }) => {
  const alpha = await idleFocus(app, core, 'a1', ['a1'], ['a1']);
  await expect(alpha.locator('.head .n')).toBeFocused();
});

test('tree C: idle release keeps focus on a row that is not removed', async ({ app, core }) => {
  const alpha = await idleFocus(app, core, 'a2', ['a1'], ['a1', 'a2']);
  await expect(alpha.getByRole('button', { name: /^a2, / })).toBeFocused();
});

// v1a-30 (V1A-28 SHOULD): a re-freeze inside the 150 ms leave cancels the pending focus move, so a later release with
// focus on body does not pull focus back into the tree.
test('tree C: a re-freeze during the leave cancels the pending focus move', async ({ app, core }) => {
  clearing(core);
  const p = core.project('alpha');
  const agents = ['a1', 'a2'].map((n, i) => core.agent(p, n, `go-${i}`));
  await app.clock.install();
  openQuiet(core); // V2-9a: quiet projects start folded
  await openWindow(app);
  const alpha = grpOf(app, 'alpha');
  for (const i of [0, 1]) {
    arrive(p, `go-${i}`);
    await expect(alpha.locator('.q')).toHaveCount(i + 1, { timeout: 5000 });
  }
  await alpha.getByRole('button', { name: /^a1, / }).focus();
  answerAgent(core, agents[0].id);
  await expect(alpha.locator('.q.answered')).toHaveCount(1, { timeout: 5000 });
  await app.clock.fastForward(5050); // the idle release fires and starts the 150 ms leave
  await expect(app.locator('aside.dock.l')).toHaveAttribute('data-leaving', 'true');
  await app.keyboard.press('Shift'); // re-freeze inside the leave
  await expect(app.locator('aside.dock.l')).not.toHaveAttribute('data-leaving', 'true');
  await app.evaluate(() => (document.activeElement as HTMLElement).blur());
  await app.clock.fastForward(300);
  await expect(alpha.locator('.q.answered')).toHaveCount(0);
  expect(await activeName(app)).toBe('BODY');
});

test('tree C: a focused section of another zone keeps focus when the answered row leaves', async ({ app, core }) => {
  clearing(core);
  const p = core.project('alpha');
  const agents = ['a1', 'a2'].map((n, i) => core.agent(p, n, `go-${i}`));
  await app.clock.install();
  await openWindow(app);
  const alpha = grpOf(app, 'alpha');
  for (const i of [0, 1]) {
    arrive(p, `go-${i}`);
    await expect(alpha.locator('.q')).toHaveCount(i + 1, { timeout: 5000 });
  }
  await alpha.getByRole('button', { name: /^a1, / }).focus();
  answerAgent(core, agents[0].id);
  await expect(alpha.locator('.q.answered')).toHaveCount(1, { timeout: 5000 });
  await app.clock.fastForward(5050);
  await expect(app.locator('aside.dock.l')).toHaveAttribute('data-leaving', 'true');
  const other = app.locator('.lz:not(:has(aside.dock.l)):not([hidden])').first();
  await other.evaluate((e) => (e as HTMLElement).focus());
  await app.clock.fastForward(300);
  await expect(alpha.locator('.q.answered')).toHaveCount(0);
  await expect(other).toBeFocused();
});
