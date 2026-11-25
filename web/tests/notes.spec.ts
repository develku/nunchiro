// Ticket 990 slice h (scorecard L12; team-j.html views ③ and ④): the merge card keeps the lessons the user chose as
// notes, each in its scope, before the yes; Settings > Notes lists, edits, removes and adds notes. A real core behind a
// proxied socket: the merge item and the note and task replies are the proxy's (the core's shapes from notes.rs,
// ledger.rs and queue/mod.rs `OwnerAsk::Merge`), and every request the window sends is recorded.
import type { Page } from '@playwright/test';
import { expect, openWindow, test, type Core } from './fixtures';
import { icon, sidebar } from './d5b';
import { openSettings } from './settings-modal';

type Req = { op: string; [k: string]: unknown };
const MERGE = (place: string) => ({
  id: 'own-merge-1',
  session_id: 'lead-seat',
  scope: 'owner',
  kind: 'owner',
  text: 'merge task t1 (discount), reviewed at 9c1e04a',
  choices: [],
  observed_at: Date.now(),
  actionable: true,
  owner: {
    type: 'merge',
    task: 't1',
    title: 'discount',
    place,
    revision: '9c1e04abcdef',
    learned: [
      { text: 'A test must fail without the fix before it counts as proof.', name: 'Reviewer · discount', role: 'reviewer', at: 1 },
      { text: 'Discount codes are stored lower-case: compare lower-case.', name: 'Builder · discount', role: 'builder', cites: 'shop/codes.py', at: 2 },
    ],
  },
});

async function mock(app: Page, reply: (r: Req) => unknown, owner: () => unknown[] = () => []) {
  const sent: Req[] = [];
  const patch = (raw: string) => JSON.stringify({ ...JSON.parse(raw), owner_decisions: owner() });
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => {
      const f = typeof m === 'string' ? JSON.parse(m) : null;
      const r = f?.request as Req | undefined;
      if (r && ['note', 'answer', 'task'].includes(r.op)) {
        sent.push(r);
        const got = reply(r);
        return ws.send(JSON.stringify({ id: f.id, response: got instanceof Error ? { Err: got.message } : { Ok: got } }));
      }
      server.send(m);
    });
    server.onMessage((m) => ws.send(typeof m === 'string' && m.includes('"event":"snapshot"') ? patch(m) : m));
  });
  return { sent };
}

const card = (app: Page) => sidebar(app, 'right').locator('.mcard');
async function openCard(app: Page) {
  await openWindow(app);
  await icon(app, 'right', 'Decisions').click();
  await expect(card(app)).toBeVisible();
  return card(app);
}

function mergeMock(app: Page, core: Core) {
  const place = core.project('demo-shop');
  let items = [MERGE(place)];
  return mock(
    app,
    (r) => {
      if (r.op === 'task') return { type: 'tasks', tasks: [{ id: 't1', review: { revision: '9c1e04abcdef', pass: true, name: 'Reviewer · discount' }, seats: [] }] };
      if (r.op === 'answer') return (items = []), 'Ack';
      return { type: 'notes', notes: [] };
    },
    () => items,
  );
}

test('notes_merge_keep_one: change one scope, drop one, "Merge and keep 1 note" keeps exactly that one, then the yes', async ({ app, core }) => {
  const { sent } = await mergeMock(app, core);
  const c = await openCard(app);
  await expect(c).toContainText('Merge discount into the project?');
  await expect(c).toContainText('reviewed at 9c1e04a by Reviewer · discount');
  await expect(c).toContainText('Learned in this task · 2');
  await expect(c).toContainText('cites shop/codes.py');
  const lessons = c.locator('.mc-lesson');
  // The default is This project; the second lesson's cited folder narrows it.
  const scope = (n: number) => lessons.nth(n).getByRole('combobox', { name: 'Where the note applies' }); // look 1117 v11 B N11-S3-4: a closed choice
  await expect(scope(0).locator('option:checked')).toHaveText('This project');
  await expect(scope(1).locator('option:checked')).toHaveText('This project · shop/');
  await expect(c.getByRole('button', { name: 'Merge and keep 2 notes' })).toBeVisible();
  await scope(0).selectOption({ label: 'Reviewer everywhere' });
  await lessons.nth(1).getByRole('button', { name: /^Do not keep: Discount codes/ }).click();
  await c.getByRole('button', { name: 'Merge and keep 1 note' }).click();
  await expect.poll(() => sent.filter((r) => r.op !== 'task')).toEqual([
    { op: 'note', operation: 'keep', task: 't1', lesson: 0, scope: { kind: 'role', role: 'reviewer' } },
    { op: 'answer', item: 'own-merge-1', answer: { type: 'allow_once' }, confirmed: true },
  ]);
});

test('notes_merge_only: "Merge only" keeps nothing and sends the yes', async ({ app, core }) => {
  const m = await mergeMock(app, core);
  const c = await openCard(app);
  await c.getByRole('button', { name: 'Merge only' }).click();
  await expect.poll(() => m.sent.filter((r) => r.op !== 'task')).toEqual([{ op: 'answer', item: 'own-merge-1', answer: { type: 'allow_once' }, confirmed: true }]);
});

test('notes_merge_not_yet: "Not yet" asks for an optional reason and sends a deny with it', async ({ app, core }) => {
  const n = await mergeMock(app, core);
  const c = await openCard(app);
  await c.getByRole('button', { name: 'Not yet' }).click();
  await c.getByRole('textbox', { name: 'Why not yet (optional)' }).fill('tests first');
  await c.getByRole('textbox', { name: 'Why not yet (optional)' }).press('Enter');
  await expect.poll(() => n.sent.filter((r) => r.op !== 'task')).toEqual([{ op: 'answer', item: 'own-merge-1', answer: { type: 'deny_with', text: 'tests first' }, confirmed: false }]);
});

test('notes_merge_keep_fails: a refused keep shows the error and sends no yes', async ({ app, core }) => {
  const place = core.project('demo-shop');
  const { sent } = await mock(app, (r) => (r.op === 'note' ? new Error('no such lesson on this task') : r.op === 'task' ? new Error('no task t1') : 'Ack'), () => [MERGE(place)]);
  const c = await openCard(app);
  await expect(c).toContainText('reviewed at 9c1e04a');
  await c.getByRole('button', { name: 'Merge and keep 2 notes' }).click();
  await expect(c).toContainText('no such lesson on this task');
  expect(sent.filter((r) => r.op === 'answer')).toEqual([]);
});

test('notes_list: rows with scope and the missing-file warning; edit, remove and add send their operations', async ({ app, core }) => {
  const place = core.project('demo-shop');
  let notes = [
    { id: 'n3', text: 'Discount codes are stored lower-case.', scope: { kind: 'project', project: place, area: 'shop' }, source: 'Builder · discount, task t1: discount', cites: 'shop/codes.py', at: Date.now() },
    { id: 'n2', text: 'Use the legacy tax table.', scope: { kind: 'project', project: place }, source: 'Builder · tax, task t0: tax', cites: 'tax/old.py', at: Date.now(), missing: true },
    { id: 'n1', text: 'Reports are short; ask before a push.', scope: { kind: 'me' }, source: 'the user', at: Date.now() },
  ];
  const { sent } = await mock(app, (r) => {
    if (r.operation === 'remove') notes = notes.filter((n) => n.id !== r.id);
    if (r.operation === 'edit') notes = notes.map((n) => (n.id === r.id ? { ...n, text: r.text as string, scope: r.scope as never } : n));
    if (r.operation === 'keep') notes = [{ id: 'n4', text: r.text as string, scope: r.scope as never, source: 'the user', at: Date.now() }, ...notes];
    return { type: 'notes', notes };
  });
  await openWindow(app);
  await openSettings(app);
  await app.locator('.settings > nav button[data-page="notes"]').click();
  const body = app.locator('.sbody');
  const row = (id: string) => body.locator(`[data-row="note:${id}"]`);
  await expect(row('n3')).toContainText('demo-shop · shop/ · from Builder · discount, task t1: discount');
  await expect(row('n3')).toContainText('cites shop/codes.py');
  await expect(row('n3')).toContainText('Project');
  await expect(row('n2')).toContainText('The file named in this note is missing. Is the note still true?');
  await expect(row('n3')).not.toContainText('still true?');
  await expect(row('n1')).toContainText('About me · you wrote this');

  await row('n1').getByRole('button', { name: 'Edit note: Reports are short; ask before a push.' }).click();
  const form = body.getByRole('group', { name: 'Note', exact: true });
  await form.getByRole('textbox', { name: 'Note text' }).fill('Reports are short.');
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(row('n1')).toContainText('Reports are short.');

  await row('n2').getByRole('button', { name: 'Remove note: Use the legacy tax table.' }).click();
  await row('n2').getByRole('group', { name: 'Remove this note?' }).getByRole('button', { name: 'Remove' }).click();
  await expect(row('n2')).toHaveCount(0);

  await body.getByRole('button', { name: 'Add a note' }).click();
  await form.getByRole('textbox', { name: 'Note text' }).fill('Ask before touching the payments folder.');
  await form.getByRole('radio', { name: 'role' }).check();
  await form.getByRole('textbox', { name: 'Role' }).fill('builder');
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(row('n4')).toContainText('Builder everywhere · you wrote this');

  expect(sent.filter((r) => r.operation !== 'list')).toEqual([
    { op: 'note', operation: 'edit', id: 'n1', text: 'Reports are short.', scope: { kind: 'me' } },
    { op: 'note', operation: 'remove', id: 'n2' },
    { op: 'note', operation: 'keep', text: 'Ask before touching the payments folder.', scope: { kind: 'role', role: 'builder' } },
  ]);
});

test('notes_empty: the palette opens Notes, and no notes says what a note is', async ({ app }) => {
  await mock(app, () => ({ type: 'notes', notes: [] }));
  await openWindow(app);
  await app.keyboard.press('Meta+KeyK');
  await app.locator('.palette input').fill('Notes');
  await app.locator('#palette-list [data-command="settings.notes.notes"]').click();
  await expect(app.locator('.settings > nav button[data-page="notes"]')).toHaveAttribute('aria-current', 'page');
  await expect(app.locator('.sbody')).toContainText('A note is a lesson you accepted on a merge card; agents never add one by themselves.');
});

// N25 (look 1117 v3 B): the tree's merge rows read "boa…" ("board: board decision…"): the lead's task card waits in the
// board's decision column while its merge card waits in Decisions. The row names what waits, as the card's title does, and a
// manual card is never called "board".
test('merge_row_in_tree_names_the_merge (N25)', async ({ app, core }) => {
  const place = core.project('demo-shop');
  core.shell(place, 'sh');
  const card = { identity: 'manual:c1', source: 'manual', id: 'c1', title: 'discount', question: 'discount', project: place, url: null, column: 'ask', updated_at: 1 };
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => server.send(m));
    server.onMessage((m) => ws.send(typeof m === 'string' && m.includes('"event":"snapshot"') ? JSON.stringify({ ...JSON.parse(m), owner_decisions: [MERGE(place)], board_decisions: [card] }) : m));
  });
  await openWindow(app);
  const line = app.locator('.tree .q').filter({ hasText: 'discount' }).first();
  await expect(line).toBeVisible();
  await expect(line.locator('.qt')).toHaveText('Merge discount into the project?');
  await expect(line.locator('.who')).toHaveCount(0);
  await expect(line).toHaveAttribute('aria-label', /Merge discount into the project\?/);
  await expect(line).not.toHaveAttribute('aria-label', /board/);
});

// N25 (look 1117 v4f B): with no Board card for the task, a merge that waits had no row in the tree at all. It shows in its
// project's rows, worded as its card is.
test('merge_without_board_card_shows_in_tree (N25)', async ({ app, core }) => {
  const place = core.project('demo-shop');
  core.shell(place, 'sh');
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => server.send(m));
    server.onMessage((m) => ws.send(typeof m === 'string' && m.includes('"event":"snapshot"') ? JSON.stringify({ ...JSON.parse(m), owner_decisions: [MERGE(place)] }) : m));
  });
  await openWindow(app);
  const line = app.locator('.tree .q').filter({ hasText: 'Merge discount into the project?' }).first();
  await expect(line).toBeVisible();
  await expect(line.locator('[data-act="allow"], [data-act="deny"]')).toHaveCount(0); // answered on its card only
});

// N25 (look 1117 v5 B): two merges of one lead waited and the tree showed one row (the lead's session held both items in
// one line). Each waiting merge has its own row.
test('each_waiting_merge_has_its_own_row (N25)', async ({ app, core }) => {
  const place = core.project('demo-shop');
  core.shell(place, 'sh');
  const second = { ...MERGE(place), id: 'own-merge-2', owner: { ...MERGE(place).owner, task: 't2', title: 'slug' } };
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => server.send(m));
    server.onMessage((m) => ws.send(typeof m === 'string' && m.includes('"event":"snapshot"') ? JSON.stringify({ ...JSON.parse(m), owner_decisions: [MERGE(place), second] }) : m));
  });
  await openWindow(app);
  await expect(app.locator('.tree .q').filter({ hasText: 'Merge discount into the project?' })).toHaveCount(1);
  await expect(app.locator('.tree .q').filter({ hasText: 'Merge slug into the project?' })).toHaveCount(1);
});
