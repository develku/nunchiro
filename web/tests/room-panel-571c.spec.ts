// Ticket 571 (room panel): a Room tab per project. Two fake agents (shell sessions that act through the CLI with their own token)
// talk in the room; the panel shows their thread; the person writes to the lead, and the lead's `agent check` gets it as the person's.
import fs from 'node:fs';
import path from 'node:path';
import { expect, nunchiro, openWindow, test, type Core } from './fixtures';
import { seatNames, seatsOf } from '../src/room/room';
import type { Session } from '../src/types';
import type { TaskView } from '../src/lead/tasks';

/** A shell session that prints its token, started by the session with `token` (its parent), or by the owner. */
async function seat(core: Core, project: string, label: string, token?: string) {
  const env = token ? { ...core.env, NUNCHIRO_TOKEN: token } : core.env;
  const args = ['session', 'start', '--kind', 'shell', '--project', project, '--label', label, '--', '/bin/sh', '-c', 'printf "TOKEN:%s\\n" "$NUNCHIRO_TOKEN"; exec cat'];
  const id = (JSON.parse(nunchiro(env, args)).session as { id: string }).id;
  let own = '';
  await expect.poll(() => (own = /TOKEN:(\S+)/.exec(core.read(id))?.[1] ?? '')).not.toBe('');
  return { id, token: own };
}
const as = (core: Core, who: { token: string }, ...args: string[]) => nunchiro({ ...core.env, NUNCHIRO_TOKEN: who.token }, ['agent', ...args]);
const lines = (out: string) => out.split('\n').filter(Boolean).map((l) => JSON.parse(l) as { id: string; from: string; to: string; thread: string; body: string; created_by: string });

async function room(core: Core) {
  const project = core.project('room');
  const lead = await seat(core, project, 'lead');
  const worker = await seat(core, project, 'worker', lead.token);
  const rev = await seat(core, project, 'rev', lead.token);
  return { project, lead, worker, rev };
}

test('room: two agents talk in a thread, the person writes to the lead, the lead checks it as the person\'s', async ({ app, core }) => {
  const { lead, worker, rev } = await room(core);
  as(core, worker, 'send', '--to', rev.id, '--thread', 'review', 'please check the storage path');
  as(core, rev, 'send', '--to', worker.id, '--thread', 'review', 'links are followed, add a test');
  await openWindow(app, {}, core);
  await app.locator('[data-room-tab]').click();
  const thread = app.locator('.room-thread[data-thread="review"]');
  await expect(thread.locator('.room-msg')).toHaveCount(2);
  await expect(thread.locator('.room-msg').first()).toContainText('worker');
  await expect(thread.locator('.room-msg').first()).toContainText('→ rev');
  await expect(thread.locator('.room-msg blockquote').first()).toHaveText('please check the storage path');
  // The seats column lists the three sessions; the composer defaults to the lead.
  await expect(app.locator('.room-seat')).toHaveCount(3);
  await expect(app.getByRole('combobox', { name: 'To' })).toHaveValue(lead.id);
  await app.getByRole('textbox', { name: 'Message', exact: true }).fill('go ahead, keep the test small');
  await app.getByRole('button', { name: 'Send' }).click();
  await expect(app.locator('.room-msg[data-created-by="person"] blockquote')).toHaveText('go ahead, keep the test small');
  const got = lines(as(core, lead, 'check'));
  expect(got).toHaveLength(1);
  expect(got[0]).toMatchObject({ from: 'person', to: lead.id, body: 'go ahead, keep the test small', created_by: 'person' });
});

test('room: a message for the person shows a badge until the Room is open; a body is quoted text, never markup', async ({ app, core }) => {
  const { worker } = await room(core);
  const body = '<img src=x onerror="window.pwned=1"> [go](javascript:window.pwned=2)';
  as(core, worker, 'ask', '--to', 'person', '--thread', 'q1', body);
  await openWindow(app, {}, core);
  const tab = app.locator('[data-room-tab]');
  await expect(tab.locator('.room-badge')).toHaveText('1');
  await expect(tab).toHaveAccessibleName('Room, 1 unread');
  await tab.click();
  await expect(tab.locator('.room-badge')).toHaveCount(0);
  await expect(app.locator('.room-thread[data-thread="q1"] .room-state')).toHaveText('Needs you');
  await expect(app.locator('.room-msg blockquote')).toHaveText(body);
  expect(await app.locator('.room-log img, .room-log a').count()).toBe(0);
  expect(await app.evaluate(() => (window as unknown as { pwned?: number }).pwned)).toBeUndefined();
});

test('room: filter by thread, pin a message, and the pin stays after a reload', async ({ app, core }) => {
  const { worker, rev } = await room(core);
  as(core, worker, 'send', '--to', rev.id, '--thread', 'alpha', 'first thread');
  as(core, worker, 'send', '--to', rev.id, '--thread', 'beta', 'second thread');
  await openWindow(app, {}, core);
  await app.locator('[data-room-tab]').click();
  await expect(app.locator('.room-thread')).toHaveCount(2);
  await app.locator('.room-filters').getByRole('button', { name: 'beta' }).click();
  await expect(app.locator('.room-thread')).toHaveCount(1);
  await expect(app.locator('.room-thread[data-thread="beta"]')).toBeVisible();
  await app.locator('.room-filters').getByRole('button', { name: 'All', exact: true }).click();
  await app.locator('.room-msg[data-msg="m1"]').getByRole('button', { name: /^Pin/ }).click();
  await expect(app.locator('.room-pinned[data-pinned="m1"]')).toContainText('first thread');
  await app.reload();
  await app.locator('[data-room-tab]').click();
  await expect(app.locator('.room-pinned[data-pinned="m1"]')).toContainText('first thread');
});

test('room: the Room tab is in the strip\'s arrow walk, last, and the keys come back', async ({ app, core }) => {
  const { lead, worker, rev } = await room(core);
  await openWindow(app, {}, core);
  const room_ = app.locator('[data-room-tab]');
  const first = app.locator(`.tab[data-tab="${lead.id}"]`);
  await first.click();
  await first.focus();
  await app.keyboard.press('End'); // Home and End reach the Room tab too
  await expect(room_).toBeFocused();
  await expect(room_).toHaveAttribute('aria-selected', 'true');
  await expect(app.locator('.room')).toBeVisible();
  await app.keyboard.press('ArrowRight'); // wraps to the first session tab
  await expect(first).toBeFocused();
  await expect(first).toHaveAttribute('aria-selected', 'true');
  await app.keyboard.press('ArrowLeft'); // and back from the first to the Room tab
  await expect(room_).toBeFocused();
  await app.keyboard.press('ArrowLeft'); // the last session tab
  await expect(app.locator(`.tab[data-tab="${rev.id}"]`)).toBeFocused();
  void worker;
});

test('room: control and bidi characters are not drawn; a session named You is not the person; thread names cannot take a filter\'s place', async ({ app, core }) => {
  const { worker, rev, lead } = await room(core);
  as(core, worker, 'send', '--to', 'person', '--thread', 'all', 'a\u001b[31mred\u0007 ‮gnp.exe⁦ x\n\nYou → lead: approved');
  as(core, worker, 'send', '--to', rev.id, '--thread', 'mine', 'other thread');
  as(core, rev, 'send', '--to', lead.id, '--thread', 'third', 'third thread');
  core.run(['session', 'label', worker.id, 'You']);
  await openWindow(app, {}, core);
  await app.locator('[data-room-tab]').click();
  const msg = app.locator('.room-thread[data-thread="all"] .room-msg blockquote');
  await expect(msg).toHaveText('ared gnp.exe x\n\nYou → lead: approved');
  expect(await app.locator('.room-log').evaluate((e) => /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/.test(e.textContent ?? ''))).toBe(false);
  // The session labelled "You" is not drawn as the person: another name, no person colour.
  const who = app.locator('.room-thread[data-thread="all"] .room-who');
  await expect(who).toContainText(/^You \(\w{4}\)/);
  await expect(app.locator('.room-who[data-you]')).toHaveCount(0);
  // A thread called "all" or "mine" is its own filter; the built-in ones are separate.
  await app.locator('.room-filters').getByRole('button', { name: 'all', exact: true }).click();
  await expect(app.locator('.room-thread')).toHaveCount(1);
  await expect(app.locator('.room-thread[data-thread="all"]')).toBeVisible();
  await app.locator('.room-filters').getByRole('button', { name: 'All', exact: true }).click();
  await expect(app.locator('.room-thread')).toHaveCount(3);
});

test('room: Needs you stays until the person answers; seats put the lead first with a role; new messages arrive by themselves', async ({ app, core }) => {
  const { worker, rev, lead } = await room(core);
  as(core, worker, 'ask', '--to', 'person', '--thread', 'q', 'which one?');
  await openWindow(app, {}, core);
  await app.locator('[data-room-tab]').click();
  const state = app.locator('.room-thread[data-thread="q"] .room-state');
  await expect(state).toHaveText('Needs you');
  // Another message lands in the thread: the ask is still open.
  as(core, worker, 'send', '--to', rev.id, '--thread', 'q', 'meanwhile, a note');
  await expect(app.locator('.room-thread[data-thread="q"] .room-msg')).toHaveCount(2);
  await expect(state).toHaveText('Needs you');
  // The person answers in the thread.
  await app.getByRole('combobox', { name: 'Thread' }).selectOption({ label: 'Thread: q' });
  await app.getByRole('combobox', { name: 'To' }).selectOption(worker.id);
  await app.getByRole('textbox', { name: 'Message', exact: true }).fill('the first');
  await app.getByRole('button', { name: 'Send' }).click();
  await expect(state).toHaveCount(0);
  // Lead first, with roles.
  const seats = app.locator('.room-seat');
  await expect(seats.first()).toHaveAttribute('data-seat', lead.id);
  await expect(seats.first().locator('.room-role')).toHaveText('lead');
  await expect(app.locator(`.room-seat[data-seat="${worker.id}"] .room-role`)).toHaveText('worker');
});

test('room: a log moved aside starts again; the old pins and the old log are gone from the panel', async ({ app, core }) => {
  const { worker, rev } = await room(core);
  as(core, worker, 'send', '--to', rev.id, '--thread', 'old', 'in the old log');
  await openWindow(app, {}, core);
  await app.locator('[data-room-tab]').click();
  await app.locator('.room-msg[data-msg="m1"]').getByRole('button', { name: /^Pin/ }).click();
  await expect(app.locator('.room-pinned')).toHaveCount(1);
  const dir = path.join(core.home, 'room', fs.readdirSync(path.join(core.home, 'room'))[0]);
  fs.renameSync(path.join(dir, 'log.jsonl'), path.join(dir, 'log.old'));
  as(core, worker, 'send', '--to', rev.id, '--thread', 'fresh', 'in the new log');
  await expect(app.locator('.room-thread[data-thread="fresh"]')).toBeVisible();
  await expect(app.locator('.room-thread[data-thread="old"]')).toHaveCount(0);
  await expect(app.locator('.room-pinned')).toHaveCount(0); // m1 of the new log is not the pinned message
});

test('room: a seat that ends with an ask open leaves a lost event in the thread', async ({ app, core }) => {
  const { worker } = await room(core);
  as(core, worker, 'ask', '--to', 'person', '--thread', 'q1', 'ship it as is?');
  const pid = (core.cli('snapshot', '--json').sessions as { id: string; pid: number }[]).find((s) => s.id === worker.id)!.pid;
  process.kill(pid, 'SIGKILL'); // the recorded pid of this test's own session only
  await openWindow(app, {}, core);
  await app.locator('[data-room-tab]').click();
  const kind = app.locator('.room-thread[data-thread="q1"] .room-kind[data-kind="lost"]');
  await expect(kind).toHaveText('No answer');
  await expect(app.locator('.room-thread[data-thread="q1"] .room-msg')).toHaveCount(2);
  // The ask can no longer be answered: the thread does not say "Needs you", and the ended seat stays in the column.
  await expect(app.locator('.room-thread[data-thread="q1"] .room-state')).toHaveCount(0);
  await expect(app.locator(`.room-seat[data-seat="${worker.id}"]`)).toHaveCount(1);
  await expect(app.getByRole('combobox', { name: 'To' }).locator(`option[value="${worker.id}"]`)).toHaveCount(0); // not a recipient
  // Ticket 594: the ask went to the person, so the card's one action opens the ended seat, whose Restart starts it again.
  // Ticket 640: this worker has no conversation to resume, so its Restart is a fresh start with no parent: the card says so.
  const card = app.locator('.room-thread[data-thread="q1"] .room-lost');
  await expect(card).toContainText('worker ended before it answered this question');
  await expect(card.getByRole('button')).toHaveCount(1);
  await card.getByRole('button', { name: 'Open worker to start a new run, without its lead' }).click();
  await expect(app.locator(`.tab[data-tab="${worker.id}"]`)).toHaveAttribute('aria-selected', 'true');
});

test('room: a worker that ends with its lead\'s ask open leaves a card; the person answers the lead instead', async ({ app, core }) => {
  const { lead, worker } = await room(core);
  as(core, lead, 'ask', '--to', worker.id, '--thread', 'task', 'which file holds the token?');
  const pid = (core.cli('snapshot', '--json').sessions as { id: string; pid: number }[]).find((s) => s.id === worker.id)!.pid;
  process.kill(pid, 'SIGKILL'); // the recorded pid of this test's own session only
  await openWindow(app, {}, core);
  await app.locator('[data-room-tab]').click();
  const card = app.locator('.room-thread[data-thread="task"] .room-lost');
  await expect(card).toContainText('worker ended before it answered this question');
  await expect(card.getByRole('button')).toHaveCount(1);
  await card.getByRole('button', { name: 'Answer lead instead' }).click();
  await expect(app.getByRole('combobox', { name: 'To' })).toHaveValue(lead.id);
  await expect(app.getByRole('combobox', { name: 'Thread' })).toHaveValue('task');
  await expect(app.getByRole('textbox', { name: 'Message', exact: true })).toBeFocused();
  await app.keyboard.type('store.rs, the keychain one');
  await app.keyboard.press('Enter');
  await expect(app.locator('.room-thread[data-thread="task"] .room-msg[data-created-by="person"]')).toHaveCount(1);
  await expect(card).toHaveCount(0); // answered: the card is done
  const got = lines(as(core, lead, 'check')).filter((m) => m.thread === 'task');
  expect(got.map((m) => m.from)).toEqual([worker.id, 'person']); // the lost event, then the person's answer
});

test('room: an ask nobody answered in time times out to the person, who sees it under Needs you and answers it', async ({ app, core }) => {
  const { worker, lead } = await room(core);
  // `--wait` ends by its own timeout (exit 2) and leaves the timeout event for the person, as a plain ask's deadline does.
  expect(() => as(core, worker, 'ask', '--to', lead.id, '--thread', 'late', '--wait', '--timeout', '1', 'still there?')).toThrow();
  await openWindow(app, {}, core);
  await app.locator('[data-room-tab]').click();
  const thread = app.locator('.room-thread[data-thread="late"]');
  await expect(thread.locator('.room-kind[data-kind="timeout"]')).toHaveCount(1);
  await expect(thread.locator('.room-state')).toHaveText('Needs you');
  await app.getByRole('combobox', { name: 'Thread' }).selectOption({ label: 'Thread: late' });
  await app.getByRole('combobox', { name: 'To' }).selectOption(worker.id);
  await app.getByRole('textbox', { name: 'Message', exact: true }).fill('go on without it');
  await app.getByRole('button', { name: 'Send' }).click();
  await expect(thread.locator('.room-state')).toHaveCount(0);
  // A timed-out ask that its seat answers late needs the person no more.
  expect(() => as(core, worker, 'ask', '--to', lead.id, '--thread', 'late2', '--wait', '--timeout', '1', 'and now?')).toThrow();
  const late = app.locator('.room-thread[data-thread="late2"]');
  await expect(late.locator('.room-state')).toHaveText('Needs you');
  const ask = lines(as(core, lead, 'check')).find((m) => m.thread === 'late2')!;
  as(core, lead, 'reply', ask.id, 'sorry, yes');
  await expect(late.locator('.room-state')).toHaveCount(0);
  // The core wrote the timeout; the asker did not.
  await expect(late.locator('.room-msg[data-created-by="core"]')).toHaveCount(1);
});

// Ticket 592: the core pushes a `room` frame; the panel reads at once (the poll is a 15 s fallback only).
test('room: a message from an agent shows in the open panel in under 500 ms', async ({ app, core }) => {
  const { worker, rev } = await room(core);
  await openWindow(app, {}, core);
  await app.locator('[data-room-tab]').click();
  await expect(app.locator('.room-empty')).toBeVisible();
  for (const n of [1, 2]) {
    as(core, worker, 'send', '--to', rev.id, '--thread', `push${n}`, `pushed ${n}`);
    await expect(app.locator(`.room-thread[data-thread="push${n}"]`)).toBeVisible({ timeout: 500 });
  }
});

/** A second window: its own browser context, so nothing is shared through browser storage. */
async function secondWindow(app: import('@playwright/test').Page, core: Core) {
  const context = await app.context().browser()!.newContext({ baseURL: new URL(app.url()).origin });
  const page = await context.newPage();
  await page.addInitScript((boot) => {
    window.__NUNCHIRO__ = boot;
    localStorage.setItem('nunchiro.firstrun.started', '1');
  }, core.boot());
  await openWindow(page, {}, core);
  return { page, close: () => context.close() };
}

// Ticket 593: pins are kept by the core with the room log; every window shows the same list.
test('room: a pin made in one window shows in another, and a pin this window kept before is carried over once', async ({ app, core }) => {
  const { project, worker, rev } = await room(core);
  as(core, worker, 'send', '--to', rev.id, '--thread', 'alpha', 'first decision');
  as(core, worker, 'send', '--to', rev.id, '--thread', 'beta', 'second decision');
  // A pin of m2 kept the old way (ticket 571c: browser storage, keyed by project and the log's first message time).
  const dir = path.join(core.home, 'room', fs.readdirSync(path.join(core.home, 'room'))[0]);
  const log = (JSON.parse(fs.readFileSync(path.join(dir, 'log.jsonl'), 'utf8').split('\n')[0]) as { ts: number }).ts;
  await app.addInitScript(([key]) => localStorage.setItem(key, '["m2"]'), [`nunchiro.room.pins:${project}#${log}`]);
  await openWindow(app, {}, core);
  await app.locator('[data-room-tab]').click();
  await expect(app.locator('.room-pinned[data-pinned="m2"]')).toContainText('second decision'); // carried over to the core
  expect(JSON.parse(fs.readFileSync(path.join(dir, 'pins.json'), 'utf8')).ids).toEqual(['m2']);
  const other = await secondWindow(app, core);
  try {
    const b = other.page;
    await b.locator('[data-room-tab]').click();
    await expect(b.locator('.room-pinned[data-pinned="m2"]')).toBeVisible(); // a window that never had it
    await app.locator('.room-msg[data-msg="m1"]').getByRole('button', { name: /^Pin/ }).click();
    await expect(b.locator('.room-pinned[data-pinned="m1"]')).toContainText('first decision'); // pushed, no reload
    await b.locator('.room-msg[data-msg="m2"]').getByRole('button', { name: /^Unpin/ }).click();
    await expect(app.locator('.room-pinned[data-pinned="m2"]')).toHaveCount(0);
    await expect(app.locator('.room-pinned')).toHaveCount(1);
  } finally {
    await other.close();
  }
  // Carried over once: the old key is gone, so the unpin above was not undone by it.
  expect(await app.evaluate((key) => localStorage.getItem(key), `nunchiro.room.pins:${project}#${log}`)).toBeNull();
});

// Ticket 772: the ask went to the person and the ended seat's record is gone (its tab was closed), so nothing can start it
// again. The card still gives one action: write in the thread to a live seat.
test('room: a lost card whose ended seat was closed offers to write in the thread', async ({ app, core }) => {
  const { lead, worker } = await room(core);
  as(core, worker, 'ask', '--to', 'person', '--thread', 'q2', 'keep the old flag?');
  const pid = (core.cli('snapshot', '--json').sessions as { id: string; pid: number }[]).find((s) => s.id === worker.id)!.pid;
  process.kill(pid, 'SIGKILL'); // the recorded pid of this test's own session only
  const dir = path.join(core.home, 'room', fs.readdirSync(path.join(core.home, 'room'))[0]);
  await expect.poll(() => fs.readFileSync(path.join(dir, 'log.jsonl'), 'utf8').includes('"kind":"lost"')).toBe(true);
  core.cli('session', 'close', worker.id); // an ended row leaves the record at once
  await openWindow(app, {}, core);
  await app.locator('[data-room-tab]').click();
  const card = app.locator('.room-thread[data-thread="q2"] .room-lost');
  await expect(card).toContainText('ended before it answered this question');
  await expect(card.getByRole('button')).toHaveCount(1);
  await card.getByRole('button', { name: 'Write to lead in this thread' }).click();
  await expect(app.getByRole('combobox', { name: 'To' })).toHaveValue(lead.id);
  await expect(app.getByRole('combobox', { name: 'Thread' })).toHaveValue('q2');
  await expect(app.getByRole('textbox', { name: 'Message', exact: true })).toBeFocused();
  await app.keyboard.type('yes, keep it');
  await app.keyboard.press('Enter');
  await expect(card).toHaveCount(0);
});

// Look 1117 v11 B N11-S3-1: a Builder seat that ended and whose row is gone (merged, cleaned up) is named on the room's lines
// by the name the lead's ledger keeps for it, never by its id.
test('room: an ended seat with no row left is named by the ledger', () => {
  const seat = { session: 'd2f5eb0a', name: 'Builder · q.txt', role: 'builder', writes: true, at: 1 };
  const tasks = [{ id: 't1', place: '/p', title: 'q.txt', created: 1, updated: 2, state: 'merged', seats: [seat] }] as TaskView[];
  expect(seatNames(tasks).get('d2f5eb0a')).toBe('Builder · q.txt');
  expect(seatNames(tasks).has('e68abd00')).toBe(false); // a seat nobody kept still reads its short id
});

// Look 1117 v11 A S3-11: with the place's lead resumable, an unrelated Codex chat of the project was offered as its lead.
test('room: a lead teammate that is not running leaves no lead; no other session stands in for it', () => {
  const s = (id: string, more: Partial<Session> = {}) => ({ id, state: 'running', project: '/p', kind: 'claude', ...more }) as Session;
  const codex = s('cx', { kind: 'codex' });
  const lead = s('ld', { teammate: 'lead-1' });
  const list = (...l: Session[]) => [l, new Map(l.map((x) => [x.id, x]))] as const;
  expect(seatsOf('/p', ...list(codex, s('old', { teammate: 'lead-1', state: 'resumable' })), 'lead-1').lead).toBeNull();
  expect(seatsOf('/p', ...list(codex, lead), 'lead-1').lead?.id).toBe('ld');
  expect(seatsOf('/p', ...list(codex)).lead?.id).toBe('cx'); // a place with no lead teammate keeps its first agent
});

// Ticket 830: as 772, and no seat of the room is live either, so there is nobody to write to: the card offers a new session
// in the project instead of no button.
test('room: a lost card with no live seat offers a new session in the project', async ({ app, core }) => {
  const { lead, worker, rev } = await room(core);
  as(core, worker, 'ask', '--to', 'person', '--thread', 'q3', 'keep the old flag?');
  const pids = core.cli('snapshot', '--json').sessions as { id: string; pid: number }[];
  const pid = (id: string) => pids.find((s) => s.id === id)!.pid;
  process.kill(pid(worker.id), 'SIGKILL'); // the recorded pids of this test's own sessions only
  const dir = path.join(core.home, 'room', fs.readdirSync(path.join(core.home, 'room'))[0]);
  await expect.poll(() => fs.readFileSync(path.join(dir, 'log.jsonl'), 'utf8').includes('"kind":"lost"')).toBe(true);
  core.cli('session', 'close', worker.id);
  process.kill(pid(lead.id), 'SIGKILL');
  process.kill(pid(rev.id), 'SIGKILL');
  await expect.poll(() => (core.cli('snapshot', '--json').sessions as { id: string; state: string }[]).filter((s) => s.state === 'running').length).toBe(0);
  await openWindow(app, {}, core);
  await app.locator('[data-room-tab]').click();
  const card = app.locator('.room-thread[data-thread="q3"] .room-lost');
  await expect(card).toContainText('ended before it answered this question');
  await expect(card.getByRole('button')).toHaveCount(1);
  await card.getByRole('button', { name: 'Start a new session in this project' }).click();
  await expect(app.getByRole('dialog', { name: 'New tab' })).toBeVisible();
});

// Ticket 773: a carried-over pin the core refuses (its message is not in the log) is said once, not dropped silently.
test('room: a carried-over pin the core refuses is reported once', async ({ app, core }) => {
  const { project, worker, rev } = await room(core);
  as(core, worker, 'send', '--to', rev.id, '--thread', 'alpha', 'first decision');
  as(core, worker, 'send', '--to', rev.id, '--thread', 'alpha', 'second decision');
  const dir = path.join(core.home, 'room', fs.readdirSync(path.join(core.home, 'room'))[0]);
  const log = (JSON.parse(fs.readFileSync(path.join(dir, 'log.jsonl'), 'utf8').split('\n')[0]) as { ts: number }).ts;
  const key = `nunchiro.room.pins:${project}#${log}`;
  await app.addInitScript(([k]) => sessionStorage.getItem('seeded') || (localStorage.setItem(k, '["m2","m9"]'), sessionStorage.setItem('seeded', '1')), [key]);
  await openWindow(app, {}, core);
  await app.locator('[data-room-tab]').click();
  await expect(app.locator('.room-pinned[data-pinned="m2"]')).toContainText('second decision');
  await expect(app.locator('[data-pins-dropped]')).toHaveText('Old pins that could not be kept: 1');
  expect(JSON.parse(fs.readFileSync(path.join(dir, 'pins.json'), 'utf8')).ids).toEqual(['m2']);
  await app.reload();
  await app.locator('[data-room-tab]').click();
  await expect(app.locator('.room-pinned[data-pinned="m2"]')).toBeVisible();
  await expect(app.locator('[data-pins-dropped]')).toHaveCount(0); // once: the old key is gone
});

test('room: a seat that waits on you shows its open question in place of its last line (Q7 point 9)', async ({ app, core }) => {
  const { worker, rev } = await room(core);
  as(core, worker, 'send', '--to', rev.id, '--thread', 'review', 'an older line');
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => server.send(m));
    server.onMessage((m) => {
      const msg = typeof m === 'string' ? JSON.parse(m) : null;
      if (msg?.event !== 'snapshot') return ws.send(m);
      for (const s of msg.sessions ?? [])
        if (s.id === worker.id) {
          Object.assign(s.attention, { working: false, waiting: true });
          s.pending = [{ id: 'd-q', session_id: s.id, scope: s.project, kind: 'question', text: 'Ship the fix now?', choices: [], observed_at: Date.now() - 60_000, actionable: true }];
        }
      ws.send(JSON.stringify(msg));
    });
  });
  await openWindow(app, {}, core);
  await app.locator('[data-room-tab]').click();
  const seatW = app.locator(`.room-seat[data-seat="${worker.id}"]`);
  await expect(seatW.locator('.room-ask')).toHaveText('Question · Ship the fix now?');
  await expect(seatW).not.toContainText('an older line');
  await expect(app.locator(`.room-seat[data-seat="${rev.id}"] .room-ask`)).toHaveCount(0);
});

// N29 (look 1117 v3): the Room opened at its oldest message; it opens at the newest, as a chat does.
test('room_opens_at_newest (N29)', async ({ app, core }) => {
  const { worker, rev } = await room(core);
  for (let i = 0; i < 10; i++) as(core, worker, 'send', '--to', rev.id, '--thread', `t${i}`, `line ${i} `.repeat(60));
  await openWindow(app, {}, core);
  await app.locator('[data-room-tab]').click();
  const log = app.locator('.room-log');
  await expect(app.locator('.room-thread[data-thread="t9"]')).toHaveCount(1);
  await expect.poll(() => log.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(40);
});
