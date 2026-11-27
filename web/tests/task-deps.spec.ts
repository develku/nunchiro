// Task dependencies on the Team board (mockup docs/design/task-deps-m5/index.html, panel 3): a card that waits for another
// task says so in its stage row, dimmed; a card others wait for says how many; a freed card waits for a seat; a card whose
// blocker was dropped asks, with its two buttons; a card whose writer started before it waited says so and shows no waits
// pill. A press on a waiting card opens what it waits for in the drawer; the card's menu sets what it waits for. The socket
// answers `task list` with the spec's tasks and records every other task request.
import type { Page } from '@playwright/test';
import { type Core, expect, nunchiro, openWindow, test } from './fixtures';
import { mates, openSeat, openTeam, repo, tokenClaude } from './leader-990';

const min = (n: number) => Date.now() - n * 60_000;
type Sent = { operation: string; id?: string; after?: string[] };

async function scene(app: Page, core: Core, plain = false) {
  tokenClaude(core);
  const project = repo(core, 'lexer');
  mates(core, [{ id: 'lead-main', name: 'Ada', project, lead: true }]);
  const ids = { lexer: core.shell(project, 'lexer').id, early: core.shell(project, 'early').id };
  const seat = (session: string, name: string) => ({ session, name, role: 'builder', writes: true, at: min(30) });
  const base = (id: string, title: string, updated: number) => ({ id, place: project, title, created: min(60), updated });
  const blocker = (id: string, title: string, stage: string, dropped = false) => ({ id, title, stage, ...(dropped ? { dropped } : {}) });
  const tasks = plain
    ? [{ ...base('t1', 'Fix lexer panic', min(2)), seats: [seat(ids.lexer, 'Builder · Fix lexer panic')], live: [ids.lexer], state: 'working' }]
    : [
        { ...base('t1', 'Fix lexer panic', min(2)), seats: [seat(ids.lexer, 'Builder · Fix lexer panic')], live: [ids.lexer], state: 'working', waiters: 2 },
        { ...base('t2', 'Error spans in the CLI output', min(8)), after: ['t1'], blockers: [blocker('t1', 'Fix lexer panic', 'build')], waiters: 1, state: 'idle' },
        { ...base('t3', 'Docs: lexer states', min(12)), after: ['t1', 't2'], blockers: [blocker('t1', 'Fix lexer panic', 'build'), blocker('t2', 'Error spans in the CLI output', 'plan')], state: 'idle' },
        { ...base('t4', 'Tabs shrink to share the strip', min(1)), after: ['t0'], state: 'idle' },
        { ...base('t5', 'Highlight the error span', min(4)), after: ['t6'], blockers: [blocker('t6', 'Old parser', 'dropped', true)], stuck: '"Old parser" was dropped, so this cannot start. Stop waiting for it, or drop this too?', state: 'needs' },
        { ...base('t7', 'Token positions', min(3)), after: ['t1'], blockers: [blocker('t1', 'Fix lexer panic', 'build')], early: 'started before "Fix lexer panic" landed', seats: [seat(ids.early, 'Builder · Token positions')], live: [ids.early], state: 'working' },
        { ...base('t0', 'Split the token table', min(1)), closed: { at: min(1), how: 'merged' }, state: 'merged' },
        { ...base('t6', 'Old parser', min(5)), closed: { at: min(5), how: 'dropped' }, state: 'dropped' },
      ];
  const sent: Sent[] = [];
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => {
      const msg = typeof m === 'string' ? JSON.parse(m) : null;
      if (msg?.request?.op !== 'task') return server.send(m);
      const r = msg.request as Sent;
      if (r.operation !== 'list') sent.push({ operation: r.operation, id: r.id, after: r.after ?? [] });
      if (r.operation === 'drop' && r.id === 't5') return ws.send(JSON.stringify({ id: msg.id, response: { Err: 'the ledger is full: close or drop tasks first' } }));
      // The core's refusal of an order that goes round, as the CLI says it.
      if (r.operation === 'after' && r.id === 't2' && r.after?.includes('t3'))
        return ws.send(JSON.stringify({ id: msg.id, response: { Err: 'Refused: "Error spans in the CLI output" would wait for "Docs: lexer states", which already waits for it.' } }));
      ws.send(JSON.stringify({ id: msg.id, response: { Ok: { tasks: r.operation === 'list' ? tasks : [], place: { way: 'team', seats: 'ask' } } } }));
    });
    server.onMessage((m) => {
      if (typeof m !== 'string' || JSON.parse(m).event !== 'snapshot') return ws.send(m);
      const msg = JSON.parse(m);
      for (const s of msg.sessions ?? []) if (s.id === ids.lexer || s.id === ids.early) Object.assign(s.attention, { working: true });
      ws.send(JSON.stringify(msg));
    });
  });
  await openWindow(app, {}, core);
  await openSeat(app, core, 'Ada');
  const side = await openTeam(app);
  await side.locator('.teamv-move[data-move="tab"]').click();
  const view = app.locator('.pane .teamv[data-where="tab"]');
  await expect(view.locator('.tcard[data-task]').first()).toBeVisible();
  return { view, sent, card: (id: string) => view.locator(`.tcard[data-task="${id}"]`) };
}

/** The contrast of a pill's words with what is behind them, through the card's dimming (WCAG ratio). */
async function contrast(pill: import('@playwright/test').Locator) {
  return pill.evaluate((el) => {
    const rgba = (c: string) => (c.match(/[\d.]+/g) ?? []).map(Number);
    const over = (top: number[], under: number[]) => { const a = top[3] ?? 1; return [0, 1, 2].map((i) => top[i] * a + under[i] * (1 - a)); };
    const card = el.closest('.tcard')!;
    const chain: Element[] = [];
    for (let e: Element | null = el; e; e = e.parentElement) chain.unshift(e);
    let page = rgba(getComputedStyle(document.body).backgroundColor);
    let behind = page;
    for (const e of chain) {
      const c = rgba(getComputedStyle(e).backgroundColor);
      if (!c.length || (c[3] ?? 1) === 0) continue;
      if (e === card || card.contains(e)) behind = over(c, behind);
      else page = behind = over(c, behind);
    }
    const op = Number(getComputedStyle(card).opacity);
    const text = over([...over(rgba(getComputedStyle(el).color), behind), op], page);
    const bg = over([...behind, op], page);
    const L = (c: number[]) => { const f = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * f[0] + 0.7152 * f[1] + 0.0722 * f[2]; };
    const [a, b] = [L(text), L(bg)].sort((x, y) => y - x);
    return (a + 0.05) / (b + 0.05);
  });
}

test('task_deps_board: waiting, blocking, freed, stuck and early cards, as the mockup', async ({ app, core }) => {
  const { view, sent, card } = await scene(app, core);
  // A waiting card says what it waits for in its stage row, dimmed, and in words for assistive tech.
  await expect(card('t2')).toHaveAttribute('data-waits-task', 'true');
  await expect(card('t2').locator('.tcard-stages')).toHaveText('Waits for "Fix lexer panic"');
  await expect(card('t2').locator('.tcard-go')).toHaveAccessibleName(/^Error spans in the CLI output Waits for "Fix lexer panic"/);
  expect(await card('t2').evaluate((e) => getComputedStyle(e).opacity)).toBe('0.7');
  await expect(card('t3').locator('.tcard-stages')).toHaveText('Waits for 2 tasks');
  // A card others wait for says how many.
  await expect(card('t1').locator('.tcard-facts')).toContainText('2 tasks wait for this');
  await expect(card('t2').locator('.tcard-facts')).toContainText('1 task waits for this');
  // Freed: it waits for a seat, ready since its blocker landed.
  await expect(card('t4')).toHaveAttribute('data-waits-seat', 'true');
  await expect(card('t4')).not.toHaveAttribute('data-waits-task');
  await expect(card('t4').locator('.tcard-stages')).toHaveText('Waits for a seat');
  await expect(card('t4').locator('.tcard-facts')).toContainText('ready since 1m');
  // Stuck: an asking card with its two buttons.
  await expect(card('t5')).toHaveAttribute('data-you', 'true');
  await expect(card('t5').locator('.tcard-now')).toHaveText('"Old parser" was dropped, so this cannot start. Stop waiting for it, or drop this too?');
  await card('t5').getByRole('button', { name: 'Stop waiting', exact: true }).click();
  await expect.poll(() => sent.at(-1)).toEqual({ operation: 'after', id: 't5', after: [] });
  await card('t5').getByRole('button', { name: 'Drop this task', exact: true }).click();
  await expect.poll(() => sent.at(-1)).toEqual({ operation: 'drop', id: 't5', after: [] });
  // A refusal is said on the card, never swallowed.
  await expect(card('t5').getByRole('alert')).toHaveText('the ledger is full: close or drop tasks first');
  // Truth row: a card whose writer runs shows no waits pill; it says it started early.
  await expect(card('t7')).not.toHaveAttribute('data-waits-task');
  await expect(card('t7').locator('.tcard-stages')).not.toContainText('Waits for');
  await expect(card('t7').locator('.tcard-facts')).toContainText('started before "Fix lexer panic" landed');
  // The board's head counts them; waiting cards sort after the ones waiting for a seat, before the closed ones.
  await expect(view.locator('[data-board-meta]')).toContainText('2 wait for a task');
  const order = await view.locator('.tcard[data-task]').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.task));
  expect(order.indexOf('t4')).toBeLessThan(order.indexOf('t2'));
  expect(order.indexOf('t3')).toBeLessThan(order.indexOf('t0'));
});

test('task_deps_drawer_menu: a waiting card opens what it waits for; the menu sets it, refuses a round order and clears it', async ({ app, core }) => {
  const { view, sent, card } = await scene(app, core);
  await card('t3').locator('.tcard-go').click();
  const drawer = view.locator('.tdrawer[data-drawer-task="t3"]');
  await expect(drawer).toBeVisible();
  await expect(drawer.locator('.tdrawer-h > b')).toHaveText('Docs: lexer states');
  await expect(drawer.locator('.twaits li')).toHaveText(['Fix lexer panic Build', 'Error spans in the CLI output waits']);
  await expect(drawer).toContainText('Starts when all 2 have landed. Ada is told then.');
  await drawer.getByRole('button', { name: 'Start anyway', exact: true }).click();
  await expect.poll(() => sent.at(-1)).toEqual({ operation: 'after', id: 't3', after: [] });
  await expect(drawer).toHaveCount(0); // it no longer waits: the drawer closes

  // The menu: the place's open tasks, this one greyed; a tick sends the whole new list.
  await card('t2').getByRole('button', { name: /^Actions for / }).click();
  await view.getByRole('menuitem', { name: 'Wait for…' }).click();
  const menu = view.locator('.lead-menu[data-wait-menu="t2"]');
  // The focus moves into the checklist, and Esc closes it back to the card's ⋯.
  await expect(menu.getByRole('menuitemcheckbox').first()).toBeFocused();
  await app.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(card('t2').getByRole('button', { name: /^Actions for / })).toBeFocused();
  await app.keyboard.press('Enter');
  await view.getByRole('menuitem', { name: 'Wait for…' }).click();
  await expect(menu.getByRole('menuitemcheckbox', { name: 'Fix lexer panic' })).toHaveAttribute('aria-checked', 'true');
  await expect(menu.getByRole('menuitemcheckbox', { name: /Error spans in the CLI output/ })).toBeDisabled();
  await expect(menu).toContainText('this task');
  await menu.getByRole('menuitemcheckbox', { name: 'Tabs shrink to share the strip' }).click();
  await expect.poll(() => sent.at(-1)).toEqual({ operation: 'after', id: 't2', after: ['t1', 't4'] });
  // A choice that would go round: the core's sentence in the menu, and nothing else changes.
  await menu.getByRole('menuitemcheckbox', { name: 'Docs: lexer states' }).click();
  await expect(menu.getByRole('alert')).toHaveText('Refused: "Error spans in the CLI output" would wait for "Docs: lexer states", which already waits for it.');
  await expect(menu.getByRole('menuitemcheckbox', { name: 'Docs: lexer states' })).toHaveAttribute('aria-checked', 'false');
  // Keyboard: the menu's rows are reachable and named.
  await menu.getByRole('menuitem', { name: 'Wait for nothing' }).focus();
  await app.keyboard.press('Enter');
  await expect.poll(() => sent.at(-1)).toEqual({ operation: 'after', id: 't2', after: [] });
});

test('task_deps_plain: a board with no dependency draws as before (no waits pill, fact or count)', async ({ app, core }) => {
  const { view, card } = await scene(app, core, true);
  await expect(view.locator('[data-waits-task]')).toHaveCount(0);
  await expect(card('t1').locator('.tcard-facts')).not.toContainText('wait');
  await expect(view.locator('[data-board-meta]')).toHaveText('1 working');
});

test('task_deps_real_core: Stop waiting and Wait for… work after a blocker landed, against the real core', async ({ app, core }) => {
  tokenClaude(core);
  const project = repo(core, 'lexer');
  mates(core, [{ id: 'lead-main', name: 'Ada', project, lead: true }]);
  const task = (...a: string[]) => nunchiro(core.env, ['task', ...a, '--project', project]);
  // r waits for p and q; p lands, q is dropped: r asks.
  for (const [title, after] of [['p', []], ['q', []], ['r', ['t1', 't2']], ['x', []], ['y', ['t4']], ['z', []]] as const)
    task('new', title, ...after.flatMap((id) => ['--after', id]));
  task('done', 't1');
  task('drop', 't2');
  task('done', 't4'); // y waited for x, which landed: y is free, its list still names x
  await openWindow(app, {}, core);
  await openSeat(app, core, 'Ada');
  const side = await openTeam(app);
  await side.locator('.teamv-move[data-move="tab"]').click();
  const view = app.locator('.pane .teamv[data-where="tab"]');
  const card = (id: string) => view.locator(`.tcard[data-task="${id}"]`);
  await expect(card('t3')).toHaveAttribute('data-you', 'true');
  await card('t3').getByRole('button', { name: 'Stop waiting', exact: true }).click();
  await expect(card('t3')).not.toHaveAttribute('data-you');
  await expect(card('t3').getByRole('alert')).toHaveCount(0);
  expect(task('show', 't3')).not.toContain('  waits for t');
  // y: Wait for… z, though its list still names the landed x.
  await expect(card('t5')).toHaveAttribute('data-waits-seat', 'true');
  await card('t5').hover();
  await card('t5').getByRole('button', { name: /^Actions for / }).click();
  await view.getByRole('menuitem', { name: 'Wait for…' }).click();
  await view.locator('.lead-menu[data-wait-menu="t5"]').getByRole('menuitemcheckbox', { name: 'z' }).click();
  await expect(card('t5').locator('.tcard-stages')).toHaveText('Waits for "z"');
  expect(task('show', 't5')).toContain('  waits for t6 "z" (plan)');
});

for (const scheme of ['light', 'dark'] as const)
  test(`task_deps_pill_contrast_${scheme}: the waiting pills read 4.5:1 through the card's dimming`, async ({ app, core }) => {
    await app.emulateMedia({ colorScheme: scheme });
    const { card } = await scene(app, core);
    for (const id of ['t2', 't4']) expect(await contrast(card(id).locator('.tcard-stages > span')), id).toBeGreaterThanOrEqual(4.5);
  });
