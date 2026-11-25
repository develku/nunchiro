// Ticket 1094: the core sees every turn end. The owner's words (2026-11-24): the lead's row said "Working for 590m" and
// his messages piled up in the queue; finished workers took no message. A real core and the fake Claude of
// composer-queue.spec.ts (claude-mode logs every stdin read); hooks stand in for Claude's own. A turn whose Stop names a
// background agent still running is the night's shape: the agent's end never reached the core.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { type Core, expect, openWindow, REPO, test } from './fixtures';

const HELD = { background_tasks: [{ id: 'a1', status: 'running' }] };
const working = (core: Core, id: string) => (core.cli('snapshot', '--json').sessions as { id: string; attention: { working: boolean } }[]).find((x) => x.id === id)?.attention.working;
/** What the fake agent read on its stdin, as text. */
const typed = (core: Core, id: string) => {
  const log = path.join(core.home, `stdin-${id}.log`);
  if (!fs.existsSync(log)) return '';
  const hex = fs.readFileSync(log, 'utf8').split('\n').filter((l) => l.startsWith('READ ')).map((l) => l.slice(5)).join('');
  return Buffer.from(hex, 'hex').toString('utf8');
};
const times = (text: string, part: string) => text.split(part).length - 1;
const shot = (app: Page, name: string) => app.screenshot({ path: `../.scratch/shots/turn-ends-1094-${name}-${test.info().project.name}.png` });
function fake(core: Core) {
  fs.writeFileSync(path.join(core.home, 'bin', 'claude'), fs.readFileSync(path.join(REPO, 'crates/nunchiro-core/tests/fixtures/claude-mode')), { mode: 0o700 });
}
const wline = (app: Page) => app.locator('.wline .wtime');

test('working_for_counts_each_turn: the row says Working for only while a turn runs, from that turn\'s start', async ({ app, core }) => {
  fake(core);
  const s = core.agent(core.project('p'), 'lead', 'x');
  await openWindow(app);
  await app.locator(`.tab[data-tab="${s.id}"]`).click();
  core.hook(s.id, 'UserPromptSubmit');
  await expect(wline(app)).toBeVisible();
  // The turn ends with a background agent still running; its end is never heard.
  core.hook(s.id, 'Stop', HELD);
  await expect(wline(app)).toHaveText(/Working for [3-9]\s?s/, { timeout: 10_000 });
  // The next turn (a scheduled prompt, a wake line): the held turn ended, the timer starts again from 0.
  core.hook(s.id, 'UserPromptSubmit');
  await expect(wline(app)).toHaveText(/^Working( for [0-2]\s?s)?$/);
  await shot(app, 'second-turn');
  core.hook(s.id, 'Stop');
  await expect(wline(app)).toHaveCount(0);
  expect(working(core, s.id)).toBe(false);
  await shot(app, 'idle');
});

test('a_finished_agent_takes_the_next_message_once: the owner\'s message and the lead\'s message to a finished worker', async ({ app, core }) => {
  test.setTimeout(180_000);
  fake(core);
  const project = core.project('p');
  const lead = core.agent(project, 'lead', 'x');
  const worker = core.agent(project, 'worker', 'x');
  await openWindow(app);
  await app.locator(`.tab[data-tab="${lead.id}"]`).click();
  for (const s of [lead, worker]) {
    core.hook(s.id, 'UserPromptSubmit');
    core.hook(s.id, 'Stop', HELD);
    expect(working(core, s.id)).toBe(true);
  }
  // The core settles a turn held for a background end it never hears (HELD_STOP_MS, 60 s).
  await expect.poll(() => working(core, lead.id) || working(core, worker.id), { timeout: 90_000, intervals: [1000] }).toBe(false);
  await expect(wline(app)).toHaveCount(0);
  const box = app.locator('.composer textarea');
  await box.fill('give me the morning report');
  await box.press('Enter');
  await expect.poll(() => times(typed(core, lead.id), 'give me the morning report'), { timeout: 15_000 }).toBe(1);
  await expect(app.locator('.composer .qrow')).toHaveCount(0);
  // A worker that finished takes the lead's next message (send-text, as `nunchiro session send-text`).
  core.cli('session', 'send-text', worker.id, 'next step\r');
  await expect.poll(() => times(typed(core, worker.id), 'next step'), { timeout: 15_000 }).toBe(1);
  await app.waitForTimeout(3000);
  expect(times(typed(core, lead.id), 'give me the morning report')).toBe(1);
  expect(times(typed(core, worker.id), 'next step')).toBe(1);
  await shot(app, 'delivered');
});

type Snap = { id: string; pending: unknown[]; send_log?: unknown[]; send_queue?: unknown[]; stopped_sends?: string[] };
/** The window's socket: `edit` rewrites each session of a snapshot (queued rows the fake agent cannot make). */
async function wire(app: Page) {
  const w = { edit: null as ((s: Snap) => void) | null, again: () => {} };
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => server.send(m));
    server.onMessage((m) => {
      if (typeof m !== 'string') return ws.send(m);
      const f = JSON.parse(m) as { event?: string; sessions?: Snap[] };
      if (f.event !== 'snapshot') return ws.send(m);
      w.again = () => {
        const copy = JSON.parse(m) as { sessions?: Snap[] };
        if (w.edit) for (const s of copy.sessions ?? []) w.edit(s);
        ws.send(JSON.stringify(copy));
      };
      w.again();
    });
  });
  return w;
}

test('a_dropped_message_waits_and_says_so: for every drop reason the owner sees his message waiting, and why', async ({ app, core }) => {
  const w = await wire(app);
  fake(core);
  const s = core.agent(core.project('p'), 'lead', 'x');
  await openWindow(app);
  await app.locator(`.tab[data-tab="${s.id}"]`).click();
  // A turn runs (as when his message went in), so the core sends snapshots the filter rewrites.
  core.hook(s.id, 'UserPromptSubmit');
  await expect.poll(() => working(core, s.id)).toBe(true);
  const held = app.locator('.composer .queued.held');
  // As the core keeps it after a dropped Enter (sessions.rs flush_enters): the user's row queued again, `settle` naming the drop.
  const show = (settle: string, ask: boolean, stopped = false) =>
    (w.edit = (x) => {
      if (x.id !== s.id) return;
      if (stopped) x.stopped_sends = ['m1'];
      const row = { id: 'm1', sender: 'user', content: 'give me the morning report', status: 'queued', at: 1, completion_seq: 0, last_activity: 0, keys: [], submit: true, settle };
      x.send_queue = [row];
      x.send_log = [row];
      if (ask) x.pending = [{ id: 'q1', session_id: s.id, scope: 'main', kind: 'permission', text: 'Bash ls', choices: [], observed_at: 1, actionable: true }];
    }, w.again());
  for (const reason of ['enter_dropped_composer', 'enter_dropped_switch', 'enter_dropped_picker', 'enter_dropped_behind']) {
    show(reason, false);
    await expect(held.locator('b')).toHaveText('The agent did not take it yet. It goes again when the agent is ready:');
    await expect(held.locator('.queued-text')).toHaveText('give me the morning report');
    if (reason === 'enter_dropped_composer') await shot(app, 'dropped-waits');
  }
  // Ticket 1121: past the re-paste bound the core will not paste it again; the card says so and offers Cancel send.
  show('enter_dropped_composer', false, true);
  await expect(held.locator('b')).toHaveText('The agent did not take it and it will not be pasted again. Cancel send puts it back in the box:');
  await expect(held.getByRole('button', { name: 'Cancel send' })).toBeVisible();
  await shot(app, 'dropped-stopped');
  // A dialog came up between the paste and its Enter: it waits for the answer, and says so.
  show('enter_dropped_blocked', true);
  await expect(held.locator('b')).toHaveText('Held until you answer:');
  await expect(held.getByRole('button', { name: 'Cancel send' })).toBeVisible();
});
