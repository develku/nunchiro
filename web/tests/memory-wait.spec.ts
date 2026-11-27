// Starts that wait for memory (mockup docs/design/memory-hold-m8/index.html, panel 3): the status bar's one line with Start
// anyway and Cancel, the count and its list for several, and the note and background tab of a start that went by itself.
// The core's list is faked here (its `memory_wait` events); crates/nunchiro/tests/sessions.rs and
// crates/nunchiro-core/tests/schedule.rs check the core's waiting list at a faked reading.
import fs from 'node:fs';
import path from 'node:path';
import type { Page, WebSocketRoute } from '@playwright/test';
import { expect, openWindow, REPO, test, type Core } from './fixtures';
import { openQuiet } from './tree-seed';

const SHOTS = process.env.HELD_WAIT_SHOTS ?? path.join(REPO, '.scratch/shots');
type Entry = { id: string; agent: string; project: string; asker: string; by?: string; at: number };

/** The window's socket with the core's waiting list replaced by `say`; `sent` gets every request the window sends. */
async function fakeWaiting(app: Page, answers: Record<string, unknown> = {}) {
  const sent: { op: string; id?: string }[] = [];
  let page: WebSocketRoute | null = null;
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    page = ws;
    ws.onMessage((m) => {
      const frame = typeof m === 'string' ? JSON.parse(m) : null;
      const r = frame?.request;
      if (r?.op) sent.push(r);
      if (r?.op && r.op in answers) return ws.send(JSON.stringify({ id: frame.id, response: { Ok: answers[r.op] } }));
      server.send(m);
    });
    // The core's own list stays out: the test says what waits.
    server.onMessage((m) => typeof m === 'string' && m.startsWith('{"event":"memory_wait"') ? undefined : ws.send(m));
  });
  const say = (entries: Entry[], notes: unknown[] = []) => page!.send(JSON.stringify({ event: 'memory_wait', entries, notes }));
  return { sent, say };
}

const setup = async (app: Page, core: Core, answers?: Record<string, unknown>) => {
  const p = core.project('nunchiro');
  core.shell(p, 'main-shell');
  openQuiet(core);
  await app.addInitScript(() => localStorage.getItem('nunchiro.settings.v1') === null && localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ features: { 'onboarding.default_agent': 'claude' } })));
  const fake = await fakeWaiting(app, answers);
  await openWindow(app);
  await fake.say([]);
  return { p, ...fake };
};
const one: Entry = { id: 'w1', agent: 'Claude', project: 'nunchiro', asker: 'you', at: Date.now() - 2 * 60_000 };
const three: Entry[] = [
  one,
  { id: 'w2', agent: 'Bo (Codex)', project: 'nunchiro', asker: 'session', by: 'Ada', at: Date.now() - 60_000 },
  { id: 'w3', agent: 'Morning brief', project: 'Chief', asker: 'schedule', at: Date.now() },
];

test('memory_wait_one_entry: one waiting start is one line with Start anyway and Cancel, no ×; Cancel sends its id', async ({ app, core }) => {
  const { sent, say } = await setup(app, core, { memory_wait_cancel: { type: 'ack' } });
  const item = app.locator('.status .memwait');
  await expect(item).toHaveCount(0);
  await say([one]);
  await expect(item).toContainText('Claude is waiting for memory.');
  await expect(item).toHaveAttribute('data-tip', 'Your Mac is low on memory. Claude starts by itself when memory is free.');
  await expect(item.getByRole('button', { name: 'Start anyway' })).toBeVisible();
  await expect(item.getByRole('button', { name: 'Dismiss' })).toHaveCount(0);
  await item.getByRole('button', { name: 'Cancel' }).click();
  await expect.poll(() => sent.filter((r) => r.op === 'memory_wait_cancel')).toEqual([{ op: 'memory_wait_cancel', id: 'w1' }]);
  await say([]);
  await expect(item).toHaveCount(0);
});

test('memory_wait_several: several are a count; its list names each with who asked and when, and Start anyway sends that one', async ({ app, core }) => {
  const { sent, say } = await setup(app, core, { memory_wait_go: { type: 'memory_wait_started', session: 'nope', mine: false } });
  await say(three);
  const count = app.locator('.status').getByRole('button', { name: '3 sessions waiting for memory' });
  await count.click();
  const pop = app.getByRole('dialog', { name: 'Waiting for memory' });
  await expect(pop).toContainText('Your Mac is low on memory. These start by themselves, one at a time, when memory is free.');
  const rows = pop.locator('.memwait-row');
  await expect(rows).toHaveText([/Claude · nunchiro\s*you, 2 min ago/, /Bo \(Codex\) · nunchiro\s*asked by Ada, 1 min ago/, /Morning brief · Chief\s*schedule, just now/]);
  await rows.nth(1).getByRole('button', { name: 'Start anyway' }).click();
  await expect.poll(() => sent.filter((r) => r.op === 'memory_wait_go')).toEqual([{ op: 'memory_wait_go', id: 'w2' }]);
  await say([one]);
  await expect(pop).toHaveCount(0);
  await expect(app.locator('.status .memwait')).toContainText('Claude is waiting for memory.');
});

test('memory_wait_started_note: a start of yours that went by itself opens behind the view and says so once; a dropped one says why', async ({ app, core }) => {
  const { p, say } = await setup(app, core);
  const active = await app.locator('.tab[aria-selected="true"]').getAttribute('data-tab');
  await say([one]);
  const started = core.shell(p, 'started-later');
  await say([], [{ n: 1, agent: 'Claude', outcome: 'started', session: started.id, mine: true }]);
  const bar = app.locator('.pane-status');
  await expect(bar).toContainText('Memory is free again, so Claude was started.');
  await expect(app.locator(`.tab[data-tab="${started.id}"]`)).toHaveCount(1);
  await expect(app.locator('.tab[aria-selected="true"]')).toHaveAttribute('data-tab', active!);
  await say([], [{ n: 1, agent: 'Claude', outcome: 'started', session: started.id, mine: true }, { n: 2, agent: 'Codex', outcome: 'dropped', mine: true }]);
  await expect(bar).toContainText('Codex was not started: your Mac stayed low on memory for 30 minutes.');
});

test('memory_wait_tree_plus_waits: the tree\'s + held for low memory waits instead of saying it was not started', async ({ app, core }) => {
  const { sent } = await setup(app, core, { start_or_wait: { type: 'memory_waiting', text: 'held' } });
  const head = app.locator('.row.head', { hasText: 'nunchiro' });
  await head.hover();
  await head.getByRole('button', { name: 'New Claude session in nunchiro' }).click();
  await expect.poll(() => sent.map((r) => r.op).filter((op) => op.startsWith('start'))).toEqual(['start_or_wait']);
  await app.waitForTimeout(300);
  await expect(app.locator('.pane-status')).not.toContainText('not started');
});

// Pictures of the one-entry line and the several-waiting card, light and dark, on request:
// PW_OPT_IN=shots HELD_WAIT_SHOTS=<folder> ... --project shots -g memory_wait_shots
test('memory_wait_shots @shots: the waiting line and the several-waiting card, light and dark', async ({ app, core }) => {
  const { say } = await setup(app, core);
  fs.mkdirSync(SHOTS, { recursive: true });
  for (const scheme of ['light', 'dark'] as const) {
    await app.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await say([one]);
    await expect(app.locator('.status .memwait')).toBeVisible();
    await app.locator('.status').screenshot({ path: path.join(SHOTS, `held-wait-one-${scheme}.png`) });
    await app.screenshot({ path: path.join(SHOTS, `held-wait-one-window-${scheme}.png`) });
    await say(three);
    await app.locator('.status').getByRole('button', { name: '3 sessions waiting for memory' }).click();
    await expect(app.getByRole('dialog', { name: 'Waiting for memory' })).toBeVisible();
    await app.screenshot({ path: path.join(SHOTS, `held-wait-many-${scheme}.png`) });
    await app.keyboard.press('Escape');
    await say([]);
  }
});
