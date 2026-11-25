// Ticket 371 item 15: messages sent while the agent works wait in a list above the box. A real core and a fake agent
// (crates/nunchiro-core/tests/fixtures/claude-mode, which logs every stdin read as hex); "working" and "turn ended" are
// the real hook events. A filter on the window's socket stands in only for what the fake cannot do: refuse a write, hold
// a snapshot back, or draw a question that can later be answered.
import AxeBuilder from '@axe-core/playwright';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { type Core, expect, openWindow, REPO, test } from './fixtures';
import { ko } from '../src/i18n/areas/composer';

const QUEUE_KEY = 'nunchiro.composer.queue.v1';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

function fake(core: Core, bin = 'claude') {
  const src = path.join(REPO, 'crates/nunchiro-core/tests/fixtures/claude-mode');
  fs.writeFileSync(path.join(core.home, 'bin', bin), fs.readFileSync(src), { mode: 0o700 });
}
const reads = (core: Core, id: string) =>
  fs.existsSync(path.join(core.home, `stdin-${id}.log`))
    ? fs.readFileSync(path.join(core.home, `stdin-${id}.log`), 'utf8').split('\n').filter((l) => l.startsWith('READ ')).map((l) => l.slice(5))
    : [];
const hex = (s: string) => Buffer.from(s).toString('hex');
/** How many times this text reached the agent. */
const landed = (core: Core, id: string, text: string) => reads(core, id).filter((r) => r.includes(hex(text))).length;
const HOOK = `const net = require('net'), fs = require('fs'), path = require('path'); const [h, id, event] = process.argv.slice(1);
const s = net.connect(path.join(h, 'core.sock')); let b = '';
s.on('connect', () => s.write(JSON.stringify({ token: fs.readFileSync(path.join(h, 'core.token'), 'utf8').trim(), request: { op: 'hook', id, event, payload: {} } }) + '\\n'));
s.on('data', (d) => { b += d; if (b.includes('\\n')) { process.stdout.write(b); s.destroy(); } });`;
function hook(core: Core, id: string, event: 'UserPromptSubmit' | 'Stop') {
  const reply = JSON.parse(execFileSync(process.execPath, ['-e', HOOK, core.home, id, event], { encoding: 'utf8', timeout: 10_000 }));
  if (!reply.Ok) throw new Error(`hook refused: ${JSON.stringify(reply)}`);
}
const tab = (app: Page, id: string) => app.locator(`.tab[data-tab="${id}"]`);
const box = (app: Page) => app.locator('.composer textarea');
const list = (app: Page) => app.locator('.composer .qlist');
const rows = (app: Page) => app.locator('.composer .qrow');
const row = (app: Page, n: number) => rows(app).nth(n);
const texts = (app: Page) => app.locator('.composer .qt');
const action = (app: Page, n: number, name: string) => row(app, n).getByRole('button', { name: `${n + 1} ${name}`, exact: true });
const hint = (app: Page) => app.locator('.composer .chint[aria-label]');
const isWorking = (core: Core, id: string) => (core.cli('snapshot', '--json').sessions as { id: string; attention: { working: boolean } }[]).find((x) => x.id === id)?.attention.working;
async function working(app: Page, core: Core, id: string) {
  hook(core, id, 'UserPromptSubmit');
  await expect.poll(() => isWorking(core, id)).toBe(true);
  await expect(app.locator('.composer .send')).toHaveAccessibleName('Stop');
}
async function queue(app: Page, ...lines: string[]) {
  for (const [i, line] of lines.entries()) {
    await box(app).fill(line);
    await box(app).press('Enter');
    await expect(box(app)).toHaveValue('');
    await expect(texts(app).last()).toHaveText(line);
    await expect(rows(app).nth(i)).toBeVisible();
  }
}
async function start(app: Page, core: Core, label = 'alpha') {
  fake(core);
  const s = core.agent(core.project('p'), label, 'x');
  await openWindow(app);
  await tab(app, s.id).click();
  await working(app, core, s.id);
  return s;
}

type Req = { op: string; text?: string; [k: string]: unknown };
type Frame = { event?: string; sessions?: { id: string; pending: unknown[]; attention: { working: boolean } }[]; id?: number; request?: Req };
/** Sits on the window's socket. Records requests, answers `refuse` ops itself, and can hold or rewrite snapshots. */
async function wire(app: Page) {
  const w = {
    sent: [] as Req[],
    refuse: {} as Record<string, string>,
    holdReply: new Set<string>(),
    release: [] as (() => void)[],
    holdSnapshots: false,
    dropWorking: false,
    question: null as string | null,
    replays: [] as (() => void)[], // the window opens more than one socket
    replay: () => w.replays.forEach((go) => go()),
    ops: (...ops: string[]) => w.sent.filter((r) => ops.includes(r.op)),
  };
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    let last = '';
    const held: string[] = [];
    const out = (raw: string) => {
      const f = JSON.parse(raw) as Frame;
      if (w.question) for (const s of f.sessions ?? []) if (s.id === w.question) s.pending = [{ id: 'q1', session_id: s.id, scope: 'session', kind: 'permission', text: 'Allow?', choices: [], observed_at: 1, actionable: true }];
      ws.send(JSON.stringify(f));
    };
    w.replays.push(() => {
      for (const raw of held.splice(0)) out(raw);
      if (last) out(last);
    });
    ws.onMessage((m) => {
      const msg = (typeof m === 'string' ? JSON.parse(m) : null) as Frame | null;
      const op = msg?.request?.op;
      if (msg?.request) w.sent.push(msg.request);
      if (op && w.refuse[op]) return ws.send(JSON.stringify({ id: msg!.id, response: { Err: w.refuse[op] } }));
      if (op && w.holdReply.has(op)) return void w.release.push(() => server.send(m));
      server.send(m);
    });
    server.onMessage((m) => {
      if (typeof m !== 'string') return ws.send(m);
      const f = JSON.parse(m) as Frame;
      if (f.event !== 'snapshot') return ws.send(m);
      if (w.holdSnapshots) return void held.push(m);
      if (w.dropWorking && f.sessions?.some((s) => s.attention.working)) return;
      last = m;
      out(m);
    });
  });
  return w;
}
const stored = (app: Page) => app.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? '{}'), QUEUE_KEY) as Promise<Record<string, { rows: { text: string }[]; paused?: boolean }>>;
const draft = (app: Page, id: string) => app.evaluate((i) => JSON.parse(localStorage.getItem('nunchiro.composer.drafts.v1') ?? '{}')[i] as string | undefined, id);

test('queue_flow_codex: two rows, edit gives the text back, remove drops it, send now steers, a row left alone goes in once and survives a reload', async ({ app, core }) => {
  fake(core);
  fake(core, 'codex');
  const s = core.cli('session', 'start', '--kind', 'codex', '--project', core.project('p'), '--label', 'beta').session as { id: string };
  const w = await wire(app);
  await openWindow(app);
  await tab(app, s.id).click();
  await working(app, core, s.id);
  await queue(app, 'first', 'second');
  expect(reads(core, s.id)).toEqual([]);
  await expect(app.locator('.composer .qhead')).toHaveText('⏳ 2 queuedWhen the turn ends, the messages are sent one at a time, from the top.');
  await expect(hint(app)).toBeVisible();
  await action(app, 0, 'Edit').click();
  await expect(box(app)).toHaveValue('first');
  await expect(texts(app)).toHaveText(['second']);
  await box(app).fill('');
  await action(app, 0, 'Discard').click();
  await expect(rows(app)).toHaveCount(0);
  await queue(app, 'third');
  await action(app, 0, 'Send now').click();
  await expect.poll(() => w.ops('steer_now').map((r) => r.text)).toEqual(['third']);
  await expect(rows(app)).toHaveCount(0);
  hook(core, s.id, 'Stop');
  await expect.poll(() => landed(core, s.id, 'third'), { timeout: 15_000 }).toBe(1);
  await working(app, core, s.id);
  await queue(app, 'left alone');
  await app.reload();
  await expect(texts(app)).toHaveText(['left alone']);
  hook(core, s.id, 'Stop');
  await expect.poll(() => landed(core, s.id, 'left alone'), { timeout: 15_000 }).toBe(1);
  await expect(rows(app)).toHaveCount(0);
  await app.waitForTimeout(500);
  expect(landed(core, s.id, 'left alone')).toBe(1);
});

test('copy_is_the_mock: the Korean strings are the mock\'s words', () => {
  expect(ko['composer.queue.head']).toBe('대기 {n}개');
  expect(ko['composer.queue.note']).toBe('턴이 끝나면 위에서부터 하나씩 보냅니다');
  expect(ko['composer.queue.stopped']).toBe('중지됨');
  expect(ko['composer.queue.stoppedNote']).toBe('자동으로 보내지 않습니다. 보낼 메시지를 직접 누르세요.');
  expect([ko['composer.queue.edit'], ko['composer.queue.remove'], ko['composer.queue.send'], ko['composer.steerNow']]).toEqual(['편집', '버리기', '보내기', '지금 보내기']);
  expect(ko['composer.queue.sendTitle']).toBe('이 메시지를 지금 보냅니다');
});

test('edit_keeps_box_text: the box already holds text, so the row\'s text comes first and nothing is lost', async ({ app, core }) => {
  const s = await start(app, core);
  await queue(app, 'queued words');
  await box(app).fill('half typed');
  await action(app, 0, 'Edit').click();
  await expect(box(app)).toHaveValue('queued words\nhalf typed');
  await expect(rows(app)).toHaveCount(0);
  expect(reads(core, s.id)).toEqual([]);
});

test('row_title_carries_the_full_text', async ({ app, core }) => {
  await start(app, core);
  const long = 'x'.repeat(400);
  await box(app).fill(long);
  await box(app).press('Enter');
  await expect(row(app, 0).locator('.qt')).toHaveAttribute('title', long);
  await expect(row(app, 0).locator('.qn')).toHaveText('1');
});

test('reload_before_snapshot: rows stay while the sessions list is still empty', async ({ app, core }) => {
  const w = await wire(app);
  const s = await start(app, core);
  await queue(app, 'keep me', 'and me');
  w.holdSnapshots = true;
  await app.reload();
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  await app.waitForTimeout(700);
  expect((await stored(app))[s.id]?.rows.map((r) => r.text)).toEqual(['keep me', 'and me']);
  expect(await draft(app, s.id)).toBeUndefined();
  w.holdSnapshots = false;
  w.replay();
  await tab(app, s.id).click();
  await expect(texts(app)).toHaveText(['keep me', 'and me']);
});

test('failed_write: storage refuses the row, so the text stays in the box and nothing is queued or sent', async ({ app, core }) => {
  const s = await start(app, core);
  await app.evaluate((k) => {
    const real = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string) {
      if (key === k) throw new DOMException('full', 'QuotaExceededError');
      real.call(this, key, value);
    };
  }, QUEUE_KEY);
  await box(app).fill('do not lose me');
  await box(app).press('Enter');
  await expect(app.getByText('Not queued: the browser storage refused it. Your text is still in the box.')).toBeVisible();
  await expect(box(app)).toHaveValue('do not lose me');
  await expect(rows(app)).toHaveCount(0);
  expect(reads(core, s.id)).toEqual([]);
});

test('refused_release: the row returns to the list, the draft is untouched, and it does not retry by itself', async ({ app, core }) => {
  const w = await wire(app);
  const s = await start(app, core);
  await queue(app, 'refused one', 'behind it');
  await box(app).fill('my draft');
  w.refuse.send_text = 'model switch in progress';
  hook(core, s.id, 'Stop');
  await expect.poll(() => w.ops('send_text').length).toBe(1);
  await expect(texts(app)).toHaveText(['refused one', 'behind it']);
  await expect(box(app)).toHaveValue('my draft');
  await app.waitForTimeout(500);
  expect(w.ops('send_text')).toHaveLength(1);
  await expect(app.locator('.composer .qhead')).toContainText('Stopped');
});

test('refused_release_session_ended: the core says the agent ended, so the row goes to the draft', async ({ app, core }) => {
  const w = await wire(app);
  const s = await start(app, core);
  await queue(app, 'only row');
  await box(app).fill('kept');
  w.refuse.send_text = 'agent_ended: the agent has ended; type in the terminal';
  hook(core, s.id, 'Stop');
  await expect(box(app)).toHaveValue('only row\nkept');
  await expect(rows(app)).toHaveCount(0);
});

test('uncertain_release: never retyped, the uncertain mark shows, and the rest stop going in', async ({ app, core }) => {
  const w = await wire(app);
  const s = await start(app, core);
  await queue(app, 'maybe landed', 'next one');
  w.refuse.send_text = 'uncertain: the write may have landed';
  hook(core, s.id, 'Stop');
  await expect(app.getByText('Message may have been sent. Check the conversation before sending again.')).toBeVisible();
  await expect(texts(app)).toHaveText(['next one']);
  await expect(box(app)).toHaveValue('');
  await expect(app.locator('.composer .qhead')).toContainText('Stopped');
  await app.waitForTimeout(500);
  expect(w.ops('send_text')).toHaveLength(1);
});

test('one_row_per_turn: a turn end delivers one row, and a turn too quick to be seen working still delivers the next', async ({ app, core }) => {
  const w = await wire(app);
  const s = await start(app, core);
  await queue(app, 'row one', 'row two');
  hook(core, s.id, 'Stop');
  await expect.poll(() => landed(core, s.id, 'row one'), { timeout: 15_000 }).toBe(1);
  await expect(texts(app)).toHaveText(['row two']);
  await app.waitForTimeout(700);
  expect(landed(core, s.id, 'row two')).toBe(0);
  expect(w.ops('send_text')).toHaveLength(1);
  w.dropWorking = true; // the window never gets a snapshot that shows this turn working
  hook(core, s.id, 'UserPromptSubmit');
  hook(core, s.id, 'Stop');
  await expect.poll(() => landed(core, s.id, 'row two'), { timeout: 15_000 }).toBe(1);
  await expect(rows(app)).toHaveCount(0);
});

test('two_windows_one_release: a second window on the same store does not send the row too', async ({ app, core, context }) => {
  const w = await wire(app);
  const s = await start(app, core);
  await queue(app, 'once only', 'not yet');
  const other = await context.newPage();
  await other.addInitScript((boot) => {
    window.__NUNCHIRO__ = boot;
    localStorage.setItem('nunchiro.firstrun.started', '1');
    localStorage.setItem('nunchiro.layout.strip-left-chat.v1', '1');
  }, core.boot());
  await openWindow(other);
  hook(core, s.id, 'Stop');
  await expect.poll(() => landed(core, s.id, 'once only'), { timeout: 15_000 }).toBe(1);
  await app.waitForTimeout(700);
  expect(landed(core, s.id, 'once only')).toBe(1);
  expect(landed(core, s.id, 'not yet')).toBe(0);
  expect(w.ops('send_text').length).toBeLessThanOrEqual(1);
  await other.close();
});

test('question_holds_rows: a turn ending on a pending permission releases nothing until it is answered', async ({ app, core }) => {
  const w = await wire(app);
  const s = await start(app, core);
  await queue(app, 'after the answer');
  w.question = s.id;
  w.replay();
  hook(core, s.id, 'Stop');
  await expect.poll(() => isWorking(core, s.id)).toBe(false);
  await app.waitForTimeout(700);
  expect(w.ops('send_text')).toEqual([]);
  await expect(action(app, 0, 'Send')).toBeDisabled(); // the same rule for the hand: its text would be the answer
  w.question = null;
  w.replay();
  await app.waitForTimeout(1500); console.log('DBG', JSON.stringify(w.sent.filter(r=>r.op!=='ack'&&r.op!=='watch').map(r=>r.op).slice(-12)), JSON.stringify(await stored(app)), await app.locator('.composer').innerText());
  await expect.poll(() => landed(core, s.id, 'after the answer'), { timeout: 15_000 }).toBe(1);
});

test('stop_pauses_even_after_reload: Stop, reload, turn idle, zero writes; then Send goes in by hand', async ({ app, core }) => {
  const w = await wire(app);
  const s = await start(app, core);
  await queue(app, 'wait for me', 'me too');
  await app.locator('.composer .send').click();
  await expect.poll(() => reads(core, s.id)).toEqual(['1b']);
  await app.reload();
  await tab(app, s.id).click();
  await expect(texts(app)).toHaveText(['wait for me', 'me too']);
  hook(core, s.id, 'Stop');
  await expect(app.locator('.composer .send')).toHaveAccessibleName('Send');
  await expect(app.locator('.composer .qhead')).toHaveText('StoppedNothing is sent automatically. Press the message you want to send.');
  await expect(hint(app)).toHaveCount(0);
  await expect(action(app, 0, 'Send')).toBeEnabled();
  await app.waitForTimeout(700);
  expect(w.ops('send_text')).toEqual([]);
  // Pressing Send on one row starts a turn: the rest read Send now, and still hold.
  await action(app, 0, 'Send').click();
  await expect.poll(() => landed(core, s.id, 'wait for me'), { timeout: 15_000 }).toBe(1);
  await working(app, core, s.id);
  await expect(action(app, 0, 'Send now')).toBeVisible();
  await expect(app.locator('.composer .qhead')).toContainText('Stopped');
  hook(core, s.id, 'Stop');
  await app.waitForTimeout(700);
  expect(landed(core, s.id, 'me too')).toBe(0);
  await expect(texts(app)).toHaveText(['me too']);
});

test('esc_pauses_through_stop_agent: Esc in the box holds the list like the button', async ({ app, core }) => {
  const w = await wire(app);
  const s = await start(app, core);
  await queue(app, 'held by esc');
  await box(app).press('Escape');
  await expect.poll(() => reads(core, s.id)).toEqual(['1b']);
  hook(core, s.id, 'Stop');
  await expect(app.locator('.composer .qhead')).toContainText('Stopped');
  await app.waitForTimeout(500);
  expect(w.ops('send_text')).toEqual([]);
});

test('stop_with_no_rows_holds_the_next: a message sent while the stopped turn still reads working waits by hand; a later turn queues normally', async ({ app, core }) => {
  const w = await wire(app);
  const s = await start(app, core);
  // The gap is real but short: after Esc the core sees the agent back at its input box (sessions.rs
  // `interrupted_at_prompt`) and the turn stops reading "working" within a tick. On a loaded machine that came before
  // the test had typed, so the message was sent, not held (2 of 10 red at 4 workers). The window keeps the snapshot it
  // had ("working") until the message is in, which is the case this test is about.
  w.holdSnapshots = true;
  await app.locator('.composer .send').click();
  await expect.poll(() => reads(core, s.id)).toEqual(['1b']);
  await queue(app, 'typed in the gap');
  await expect(app.locator('.composer .qhead')).toContainText('Stopped');
  w.holdSnapshots = false;
  w.replay();
  hook(core, s.id, 'Stop');
  await expect(action(app, 0, 'Send')).toBeEnabled();
  await app.waitForTimeout(700);
  expect(w.ops('send_text')).toEqual([]);
  await action(app, 0, 'Discard').click();
  await expect(rows(app)).toHaveCount(0);
  await working(app, core, s.id);
  await queue(app, 'normal again');
  await expect(app.locator('.composer .qhead')).toContainText('1 queued');
});

test('ended_session: every row returns to the draft in order, any draft kept', async ({ app, core }) => {
  const s = await start(app, core);
  await queue(app, 'one', 'two');
  await box(app).fill('half');
  await box(app).blur();
  core.cli('session', 'close', s.id);
  await expect.poll(() => draft(app, s.id)).toBe('one\ntwo\nhalf');
  expect((await stored(app))[s.id]).toBeUndefined();
  expect(reads(core, s.id)).toEqual([]);
});

test('no_interrupt: the row stays and the existing line says why', async ({ app, core }) => {
  const w = await wire(app);
  await start(app, core);
  await queue(app, 'cannot interrupt');
  w.refuse.steer_now = 'no_interrupt: this agent has no interrupt';
  await action(app, 0, 'Send now').click();
  await expect(app.getByText('This agent cannot take a message while it works; it stays queued.')).toBeVisible();
  await expect(texts(app)).toHaveText(['cannot interrupt']);
  await expect(box(app)).toHaveValue(''); // unlike the box's own Ctrl+Enter, the text does not move
});

test('steer_once: the row stays until the core accepts, and the button cannot be pressed again meanwhile', async ({ app, core }) => {
  const w = await wire(app);
  await start(app, core);
  await queue(app, 'once please');
  w.holdReply.add('steer_now');
  const send = action(app, 0, 'Send now');
  await send.click();
  await expect(send).toBeDisabled();
  await expect(texts(app)).toHaveText(['once please']);
  await send.click({ force: true }).catch(() => {});
  await app.waitForTimeout(200);
  expect(w.ops('steer_now')).toHaveLength(1);
  w.holdReply.clear();
  w.release.splice(0).forEach((go) => go());
  // Ticket 1056: Claude takes it at its next step, so the row stays, marked as sent, until the transcript shows it.
  await expect(rows(app).first().getByRole('status')).toHaveText('Sent. Waiting for the agent to take it.');
  expect(w.ops('steer_now')).toHaveLength(1);
});

test('ctrl_enter_empty_box_steers_the_top_row', async ({ app, core }) => {
  const w = await wire(app);
  await start(app, core);
  await queue(app, 'top row', 'second row');
  await box(app).press('Control+Enter');
  await expect.poll(() => w.ops('steer_now').map((r) => r.text)).toEqual(['top row']);
  // The second row is not steered; it waits, then goes as the next turn once the Esc ended this one (look 11-17 N0).
  expect(w.ops('steer_now')).toHaveLength(1);
  // Q7 point 16: the steered text is recorded, so its chat bubble is labelled Steer.
  await expect.poll(() => app.evaluate(() => localStorage.getItem('nunchiro.composer.steers.v1'))).toContain('top row');
});

test('image_row: the chip clears and the released text carries the saved path', async ({ app, core }) => {
  const w = await wire(app);
  const s = await start(app, core);
  await app.locator('.composer input[type=file]').setInputFiles({ name: 'p.png', mimeType: 'image/png', buffer: PNG });
  await expect(app.locator('.composer img')).toHaveCount(1);
  await box(app).fill('look at this');
  await box(app).press('Enter');
  await expect(rows(app)).toHaveCount(1);
  await expect(app.locator('.composer img')).toHaveCount(0);
  hook(core, s.id, 'Stop');
  await expect.poll(() => w.ops('send_text').length).toBe(1);
  expect(w.ops('send_text')[0].text).toMatch(/look at this\n\/.*\.png/);
});

test('list_a11y: axe finds nothing serious in the list, and its buttons are named by row', async ({ app, core }) => {
  await start(app, core);
  await queue(app, 'check me');
  const found = await new AxeBuilder({ page: app }).include('.composer .qlist').analyze();
  expect(found.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id)).toEqual([]);
  await expect(app.getByRole('group', { name: 'Queued messages' })).toBeVisible();
});

test('idle_enter_is_unchanged: with no turn running, Enter still writes at once and shows no list', async ({ app, core }) => {
  fake(core);
  const s = core.agent(core.project('p'), 'alpha', 'x');
  await openWindow(app);
  await tab(app, s.id).click();
  await box(app).fill('straight in');
  await box(app).press('Enter');
  await expect.poll(() => landed(core, s.id, 'straight in'), { timeout: 15_000 }).toBe(1);
  await expect(list(app)).toHaveCount(0);
});
