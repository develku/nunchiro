// Ticket 1115 step 2 (owner 11-24, mockup docs/design/workers-1115/mockup.html panel 2): the Team tab shows one card per task
// with its stage; a card that waits for the person has Answer; a press on a card peeks at that seat's terminal in the drawer
// and opens no tab; a reviewer is the Review stage of its task's card, not a card. The socket answers `task list` with the
// spec's tasks (as leader-tasks-990); the seats are real shell sessions.
import type { Page } from '@playwright/test';
import { type Core, expect, openWindow, test } from './fixtures';
import { mates, openSeat, openTeam, repo, tokenClaude } from './leader-990';

const min = (n: number) => Date.now() - n * 60_000;
const today = (n: number) => Math.max(min(n), new Date().setHours(0, 0, 0, 0) + 1000);

async function boardScene(app: Page, core: Core) {
  tokenClaude(core);
  const project = repo(core, 'demo-shop');
  mates(core, [{ id: 'lead-main', name: 'Lead', project, lead: true }]);
  const ids = Object.fromEntries((['tax', 'disc', 'rev'] as const).map((k) => [k, core.shell(project, k).id])) as Record<'tax' | 'disc' | 'rev' | 'search', string>;
  // The peeked seat prints a line, so the drawer shows its own terminal's output.
  ids.search = core.shell(project, 'search', '/bin/sh', '-c', 'printf "running 14 tests\\ntest result: ok. 14 passed\\n"; exec cat').id;
  const seat = (session: string, name: string, role = 'builder') => ({ session, name, role, writes: role === 'builder', at: min(30) });
  const base = (id: string, title: string, updated: number) => ({ id, place: project, title, created: min(60), updated });
  const tasks = [
    { ...base('t1', 'tax', min(1)), seats: [seat(ids.tax, 'Builder · tax')], live: [ids.tax], state: 'needs' },
    { ...base('t2', 'discount', min(6)), seats: [seat(ids.disc, 'Builder · discount'), seat(ids.rev, 'Reviewer · discount', 'reviewer')], live: [ids.disc, ids.rev], state: 'review' },
    { ...base('t3', 'search', min(3)), seats: [seat(ids.search, 'Builder · search')], live: [ids.search], state: 'working' },
    { ...base('t4', 'docs', min(20)), review: { revision: 'c', pass: true, by: 'user', name: 'review-docs', at: min(20) }, state: 'approved' },
    { ...base('t5', 'flaky tests', min(25)), state: 'idle' },
    { ...base('t6', 'palette', min(50)), closed: { at: today(50), how: 'merged' }, state: 'merged' },
  ];
  const resized: string[] = []; // the sessions the window asked to resize (round 2: a peek must never)
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => {
      const msg = typeof m === 'string' ? JSON.parse(m) : null;
      if (msg?.request?.op === 'resize') resized.push(msg.request.id);
      if (msg?.request?.op !== 'task') return server.send(m);
      ws.send(JSON.stringify({ id: msg.id, response: { Ok: { tasks: msg.request.operation === 'list' ? tasks : [], place: { way: 'team', seats: 'ask' } } } }));
    });
    server.onMessage((m) => {
      if (typeof m !== 'string' || JSON.parse(m).event !== 'snapshot') return ws.send(m);
      const msg = JSON.parse(m);
      for (const s of msg.sessions ?? []) {
        if (s.id === ids.tax) {
          Object.assign(s.attention, { working: false, waiting: true });
          s.pending = [{ id: 'd-tax', session_id: s.id, scope: s.project, kind: 'question', text: 'Round to 2 decimals?', choices: [], observed_at: min(1), actionable: true }];
        }
        if (s.id === ids.search || s.id === ids.disc || s.id === ids.rev) Object.assign(s.attention, { working: true });
      }
      ws.send(JSON.stringify(msg));
    });
  });
  await openWindow(app, {}, core);
  await openSeat(app, core, 'Lead');
  const side = await openTeam(app);
  await side.locator('.teamv-move[data-move="tab"]').click();
  const view = app.locator('.pane .teamv[data-where="tab"]');
  await expect(view).toBeVisible();
  await expect(view.locator('.tcard[data-task], .lead-row[data-task]').first()).toBeVisible();
  return { ids, view, resized };
}

test('team_board (1115 step 2): one card per task with its stage; a waiting card has Answer; a card opens its seat in the drawer and no tab; the reviewer has no card', async ({ app, core }) => {
  const { ids, view, resized } = await boardScene(app, core);
  const card = (id: string) => view.locator(`.tcard[data-task="${id}"]`);
  // One card per task, needs you first; the reviewer of t2 is its Review stage, never a card or a row.
  expect(await view.locator('.tcard[data-task]').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.task))).toEqual(['t1', 't2', 't3', 't4', 't5', 't6']);
  await expect(view.locator('.lead-row')).toHaveCount(0);
  // The board's counts beside its title (mockup panel 2), from the same tasks.
  await expect(view.locator('.tboard-head .lead-gh')).toHaveText('Tasks');
  await expect(view.locator('[data-board-meta]')).toHaveText('1 working · 1 asks you · 1 waits for a seat · landed today 1');
  await expect(view.locator('.tcard', { hasText: 'Reviewer' })).toHaveCount(0);
  const stages = { t1: 'build', t2: 'review', t3: 'build', t4: 'gate', t5: 'plan', t6: 'landed' };
  for (const [id, stage] of Object.entries(stages)) await expect(card(id)).toHaveAttribute('data-stage', stage);
  await expect(card('t2').locator('[data-at="now"]')).toHaveText('Review');
  await expect(card('t2').locator('.tcard-go')).toHaveAccessibleName(/^discount Stage: Review /);
  await expect(card('t2').locator('[data-at="done"]')).toHaveText(['Plan ✓', 'Build ✓']);
  await expect(card('t6').locator('[data-at="done"]')).toHaveCount(5);
  // The waiting card: orange, its stage the person's, its ask, and Answer; no other card has Answer.
  await expect(card('t1')).toHaveAttribute('data-you', 'true');
  await expect(card('t1').locator('[data-at="you"]')).toHaveText('Build ✋');
  await expect(card('t1').locator('.tcard-now')).toContainText('Round to 2 decimals?');
  await expect(card('t1').getByRole('button', { name: 'Answer', exact: true })).toBeVisible();
  await expect(view.getByRole('button', { name: 'Answer', exact: true })).toHaveCount(1);
  // A task with no seat yet waits for one, dimmed.
  await expect(card('t5')).toHaveAttribute('data-waits-seat', 'true');
  await expect(card('t5')).toContainText('Waits for a seat');
  await expect(card('t5').locator('.tcard-now')).toHaveCount(0);
  expect(await card('t5').evaluate((e) => getComputedStyle(e).opacity)).toBe('0.7');

  // A press peeks: the drawer shows that seat's terminal beside the board; the tab strip keeps its tabs.
  const tabs = await app.locator('.tab[data-tab]').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.tab));
  await card('t3').locator('.tcard-go').click();
  const drawer = view.locator(`.tdrawer[data-drawer="${ids.search}"]`);
  await expect(drawer).toBeVisible();
  await expect(drawer.locator('.tdrawer-h > b')).toHaveText('search · Builder');
  await expect(drawer.locator(`.term[data-session="${ids.search}"]`)).toContainText('14 passed');
  await expect(card('t3')).toHaveAttribute('data-selected', 'true');
  await expect(view.locator('.teamv-room')).toBeHidden(); // the drawer takes the room's column
  expect(await app.locator('.tab[data-tab]').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.tab))).toEqual(tabs);
  // Another card swaps the drawer's seat (the review's most urgent seat runs); still no tab.
  await card('t2').locator('.tcard-go').click();
  await expect(view.locator('.tdrawer')).toHaveCount(1);
  await expect(view.locator('.tdrawer .term[data-session]')).toBeVisible();
  expect(await app.locator('.tab[data-tab]').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.tab))).toEqual(tabs);
  await view.getByRole('button', { name: 'Close the terminal', exact: true }).click();
  await expect(view.locator('.tdrawer')).toHaveCount(0);
  await expect(view.locator('.teamv-room')).toBeVisible();
  // Esc closes it too, also from inside the terminal, and the focus goes back to the card.
  await card('t3').locator('.tcard-go').click();
  await drawer.locator('.term').click();
  await app.keyboard.press('Escape');
  await expect(view.locator('.tdrawer')).toHaveCount(0);
  await expect(card('t3').locator('.tcard-go')).toBeFocused();
  // A peek never sizes the PTY: opening and closing the drawer sent no resize for the peeked seats (the agent's screen
  // is never redrawn by a look).
  await app.waitForTimeout(500);
  expect(resized.filter((id) => id === ids.search || id === ids.disc || id === ids.rev)).toEqual([]);
  // Keys typed there go nowhere: the peek is read-only.
  await card('t3').locator('.tcard-go').click();
  await drawer.locator('.term').click();
  await app.keyboard.type('zz-typed');
  await app.waitForTimeout(300);
  expect(core.read(ids.search)).not.toContain('zz-typed');

  // "Open as tab" is the one way to a tab (the drawer is still open from above): it opens that seat's tab and the drawer closes.
  await drawer.getByRole('button', { name: /Open as tab/ }).click();
  await expect(app.locator(`.tab[data-tab="${ids.search}"]`)).toHaveAttribute('aria-selected', 'true');
  // Review round 1: a peek at a seat that is also a tab leaves that tab's PTY size as it was (no resize request at all
  // while the drawer is open or after it closes).
  await app.waitForTimeout(500);
  const tabSized = resized.filter((id) => id === ids.search).length;
  expect(tabSized).toBeGreaterThan(0); // the tab, which owns the size, did size it
  await app.locator('[data-team-tab]').click();
  await card('t3').locator('.tcard-go').click();
  await expect(drawer.locator('.term')).toContainText('14 passed');
  await app.keyboard.press('Escape');
  await expect(view.locator('.tdrawer')).toHaveCount(0);
  await app.locator(`.tab[data-tab="${ids.search}"]`).click();
  await app.waitForTimeout(500);
  expect(resized.filter((id) => id === ids.search).length).toBe(tabSized);
});

test('team_board_peek_leaves_tab (1115 step 2, review 2): with GPU rendering on, a peek at a seat that is also a tab leaves the tab\'s xterm and its WebGL renderer as they were', async ({ app, core }) => {
  const { ids, view } = await boardScene(app, core);
  await app.keyboard.press('Meta+Comma');
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Terminal', exact: true }).click();
  const closed = app.locator('details.term-more:not([open]) > summary');
  while (await closed.count()) await closed.first().click();
  await app.getByRole('switch', { name: 'GPU rendering' }).check();
  await app.keyboard.press('Escape');
  // The seat opens as a tab through the drawer, the one way to a tab; its terminal draws with WebGL.
  await view.locator('.tcard[data-task="t3"] .tcard-go').click();
  await view.locator('.tdrawer').getByRole('button', { name: /Open as tab/ }).click();
  const tabTerm = app.locator(`.pane > .term[data-session="${ids.search}"]:not([data-peek])`);
  await expect(tabTerm).toHaveAttribute('data-renderer', 'webgl');
  const canvases = () => tabTerm.locator('.xterm-screen canvas').count();
  const before = await canvases();
  expect(before).toBeGreaterThan(0);
  // A peek opens and closes. Before the fix it loaded a second WebGL addon into the tab's xterm and, closing, disposed it:
  // the tab drew with the DOM renderer while it still said webgl.
  await app.locator('[data-team-tab]').click();
  await view.locator('.tcard[data-task="t3"] .tcard-go').click();
  const peek = view.locator('.tdrawer .term[data-peek]');
  await expect(peek.locator('.xterm-screen')).toBeVisible();
  await expect(peek).toHaveAttribute('data-renderer', 'webgl'); // the peek's own addon, in its own xterm (canvas: no DOM text)
  await app.keyboard.press('Escape');
  await expect(view.locator('.tdrawer')).toHaveCount(0);
  await app.locator(`.tab[data-tab="${ids.search}"]`).click();
  await expect(tabTerm).toHaveAttribute('data-renderer', 'webgl');
  await app.waitForTimeout(300);
  expect(await canvases()).toBe(before);
  await expect(tabTerm.locator('.xterm-rows')).toHaveCount(0); // no DOM renderer took over in the tab
});
