// needs 170 (2), turn_end_cue_and_notification: a turn that ends on a session the user is not looking at cues `done` once and
// raises one OS notification whose click opens that session. The viewed session, a side chat and a muted session never do.
// The app shell is stood in for by a recording `__TAURI_INTERNALS__` (`play_sound` is the cue, `notify` the OS notification).
import type { Page } from '@playwright/test';
import { expect, openWindow, test, type Core } from './fixtures';

type Call = { cmd: string; args: { session?: string; title?: string; body?: string; name?: string; alerts?: boolean } };
const agent = (core: Core, label: string) => core.agent(core.project(label), label, 'never-created');
const tab = (p: Page, id: string) => p.locator(`.tab[data-tab="${id}"]`);

/** Records the shell calls and lets a test set `attention.working` (and `side_chat`) on the snapshot frames the window gets. */
async function drive(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __calls: Call[]; __TAURI_INTERNALS__: unknown };
    w.__calls = [];
    w.__TAURI_INTERNALS__ = { invoke: (cmd: string, args: Call['args']) => (w.__calls.push({ cmd, args }), Promise.resolve(null)), transformCallback: () => 0, metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main', windowLabel: 'main' } } };
  });
  const state: { working: Record<string, boolean>; child: Set<string>; exited: Set<string>; failed: Set<string>; last: unknown; push: () => void } = { working: {}, child: new Set(), exited: new Set(), failed: new Set(), last: null, push: () => {} };
  const sockets: { send(m: string): void }[] = [];
  const patch = (msg: { sessions: { id: string; state: string; side_chat?: boolean; problem?: unknown; attention: { working: boolean } }[] }) => {
    for (const s of msg.sessions) {
      if (s.id in state.working) s.attention.working = state.working[s.id];
      if (state.child.has(s.id)) s.side_chat = true;
      if (state.exited.has(s.id)) s.state = 'exited';
      // A crashed agent whose card quotes its own output: the cause must never reach a notification.
      if (state.failed.has(s.id)) (s.state = 'failed'), (s.problem = { case: 'unexpected', cause: 'Error: sk-ant-SECRET token rejected' });
    }
    return JSON.stringify(msg);
  };
  await page.routeWebSocket(/\/ws$/, (ws) => {
    sockets.push(ws);
    const server = ws.connectToServer();
    ws.onMessage((m) => server.send(m));
    server.onMessage((m) => {
      const msg = typeof m === 'string' ? JSON.parse(m) : null;
      if (msg?.event !== 'snapshot') return ws.send(m);
      state.last = structuredClone(msg);
      ws.send(patch(msg));
    });
  });
  state.push = () => {
    if (!state.last) return;
    for (const ws of sockets) ws.send(patch(structuredClone(state.last) as never));
  };
  return state;
}
const calls = (page: Page, cmd: string) => page.evaluate((c) => (window as unknown as { __calls: Call[] }).__calls.filter((x) => x.cmd === c), cmd);
const NOTE = 'notify';
const SOUND = 'play_sound';

/** One working turn: working true, then false, each pushed as a snapshot. */
async function turn(page: Page, d: Awaited<ReturnType<typeof drive>>, id: string) {
  d.working[id] = true;
  d.push();
  await page.waitForTimeout(300);
  d.working[id] = false;
  d.push();
  await page.waitForTimeout(500);
}

test('turn_end_cue_and_notification: a background session rings once and its click opens it; the viewed one does not', async ({ app, core }) => {
  const a = agent(core, 'viewed');
  const b = agent(core, 'background');
  const d = await drive(app);
  await openWindow(app, {}, core);
  await tab(app, a.id).click();
  await expect(tab(app, a.id)).toHaveAttribute('aria-selected', 'true');
  expect(await calls(app, SOUND)).toHaveLength(0);
  // The same event on the viewed session: neither cue nor notification.
  await turn(app, d, a.id);
  expect(await calls(app, SOUND)).toHaveLength(0);
  expect(await calls(app, NOTE)).toHaveLength(0);
  // A background session: one cue, one OS notification with the name and the word only.
  await turn(app, d, b.id);
  await expect.poll(async () => (await calls(app, SOUND)).length).toBe(1);
  const notes = await calls(app, NOTE);
  expect(notes).toHaveLength(1);
  expect(notes[0].args.session).toBe(b.id);
  expect(notes[0].args.body).toBe('background finished');
  // Clicking it is the same event a decision notification sends: it opens that session.
  await app.evaluate((id) => window.dispatchEvent(new CustomEvent('nunchiro:notify.click', { detail: { session: id } })), b.id);
  await expect(tab(app, b.id)).toHaveAttribute('aria-selected', 'true');
});

test('turn_end_unfocused_window_rings_even_for_the_current_session', async ({ app, core }) => {
  const a = agent(core, 'viewed');
  const d = await drive(app);
  await openWindow(app, {}, core);
  await tab(app, a.id).click();
  await app.evaluate(() => (document.hasFocus = () => false));
  await turn(app, d, a.id);
  await expect.poll(async () => (await calls(app, NOTE)).length).toBe(1);
});

test('turn_end_notify_focused_off_rings_for_the_session_in_front', async ({ app, core }) => {
  await app.addInitScript(() => localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ notifyFocused: false })));
  const a = agent(core, 'viewed');
  const d = await drive(app);
  await openWindow(app, {}, core);
  await tab(app, a.id).click();
  await app.evaluate(() => (document.hasFocus = () => true));
  await turn(app, d, a.id);
  await expect.poll(async () => (await calls(app, NOTE)).length).toBe(1);
});

test('turn_end_side_chat_and_muted_never_ring', async ({ app, core }) => {
  const a = agent(core, 'viewed');
  const kid = agent(core, 'kid');
  const quiet = agent(core, 'quiet');
  const d = await drive(app);
  await openWindow(app, {}, core);
  d.child.add(kid.id); // marked after the window has its tabs (a side chat has none)
  d.push();
  await tab(app, a.id).click();
  await app.evaluate((id) => localStorage.setItem('nunchiro.notify.v1', JSON.stringify({ [id]: 'muted' })), quiet.id);
  await app.reload();
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  await tab(app, a.id).click();
  await turn(app, d, kid.id);
  await turn(app, d, quiet.id);
  expect(await calls(app, SOUND)).toHaveLength(0);
  expect(await calls(app, NOTE)).toHaveLength(0);
});

test('exit_cue_skips_the_viewed_session', async ({ app, core }) => {
  const a = agent(core, 'viewed');
  const b = agent(core, 'background');
  const d = await drive(app);
  await openWindow(app, {}, core);
  await tab(app, a.id).click();
  await expect(tab(app, a.id)).toHaveAttribute('aria-selected', 'true');
  // The process of a background session exits: one cue.
  d.exited.add(b.id);
  d.push();
  await expect.poll(async () => (await calls(app, SOUND)).length).toBe(1);
  // The same exit on the viewed session (window focused): no further cue, like a turn end.
  d.exited.add(a.id);
  d.push();
  await app.waitForTimeout(800);
  expect(await calls(app, SOUND)).toHaveLength(1);
  expect(await calls(app, NOTE)).toHaveLength(0);
});

const sounds = async (page: Page) => (await calls(page, SOUND)).map((c) => c.args.name);

test('ticket 372 failed_session_alerts: a background crash raises only "<name> · failed" and the waiting sound, never done', async ({ app, core }) => {
  const a = agent(core, 'viewed');
  const b = agent(core, 'calm');
  const d = await drive(app);
  await openWindow(app, {}, core);
  await tab(app, a.id).click();
  await app.waitForTimeout(300); // b is seen before it fails: a first sight is not a transition
  d.failed.add(b.id);
  d.push();
  await expect.poll(() => sounds(app)).toEqual(['Ping']);
  const notes = await calls(app, NOTE);
  expect(notes).toHaveLength(1);
  expect(notes[0].args).toEqual({ session: b.id, title: 'calm · failed', body: 'calm failed' });
  expect(JSON.stringify(notes)).not.toContain('SECRET');
});

// Ticket 790: the finished and failed words were English literals in every language.
test('ticket 790 failed_note_korean: a Korean window says the failed word in Korean', async ({ app, core }) => {
  const a = agent(core, 'viewed');
  const b = agent(core, 'calm');
  const d = await drive(app);
  await openWindow(app, {}, core);
  await app.evaluate(() => localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ ...JSON.parse(localStorage.getItem('nunchiro.settings.v1') ?? '{}'), language: 'ko' })));
  await app.reload();
  await expect(app.locator('html')).toHaveAttribute('lang', 'ko');
  await tab(app, a.id).click();
  await app.waitForTimeout(300); // b is seen before it fails: a first sight is not a transition
  d.failed.add(b.id);
  d.push();
  await expect.poll(async () => (await calls(app, NOTE)).map((n) => n.args)).toEqual([{ session: b.id, title: 'calm · 실패', body: 'calm 실패' }]);
});

test('ticket 372 failed_session_levels: waiting level alerts, muted and the viewed session stay quiet', async ({ app, core }) => {
  const a = agent(core, 'viewed');
  const w = agent(core, 'waiter');
  const m = agent(core, 'quiet');
  await app.addInitScript(([w, m]) => localStorage.setItem('nunchiro.notify.v1', JSON.stringify({ [w]: 'waiting', [m]: 'muted' })), [w.id, m.id]);
  const d = await drive(app);
  await openWindow(app, {}, core);
  await tab(app, a.id).click();
  await app.waitForTimeout(300);
  d.failed.add(m.id);
  d.failed.add(a.id);
  d.push();
  await app.waitForTimeout(800);
  expect(await calls(app, NOTE)).toHaveLength(0);
  expect(await calls(app, SOUND)).toHaveLength(0);
  d.failed.add(w.id);
  d.push();
  await expect.poll(async () => (await calls(app, NOTE)).map((n) => n.args.title)).toEqual(['waiter · failed']);
});

test('ticket 372 burst: three sessions ending together play one sound; a second end of one session inside 5 s raises no new banner', async ({ app, core }) => {
  const a = agent(core, 'viewed');
  const ids = ['one', 'two', 'three'].map((l) => agent(core, l).id);
  const d = await drive(app);
  await openWindow(app, {}, core);
  // With four sessions the window may open on another one: the tree row opens this one's tab.
  await app.locator(`button.row.wt2[data-menu-session="${a.id}"]`).click();
  await tab(app, a.id).click();
  for (const id of ids) d.working[id] = true;
  d.push();
  await app.waitForTimeout(300);
  for (const id of ids) d.working[id] = false;
  d.push();
  await expect.poll(async () => (await calls(app, NOTE)).length).toBe(3);
  expect(await sounds(app)).toEqual(['Glass']);
  await turn(app, d, ids[0]);
  expect(await calls(app, NOTE)).toHaveLength(3);
});

test('ticket 372 close_bit_and_focus_clear: closing hands the shell alerts on unless muted; focus clears delivered notifications', async ({ app, core }) => {
  agent(core, 'viewed');
  await app.addInitScript(() => localStorage.setItem('nunchiro.closeNoticeSeen', '1'));
  await drive(app);
  await openWindow(app, {}, core);
  await app.evaluate(() => window.dispatchEvent(new Event('nunchiro:close-request')));
  await expect.poll(async () => (await calls(app, 'close_window')).map((c) => c.args.alerts)).toEqual([true]);
  await app.evaluate(() => localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ notifyDefault: 'muted' })));
  await app.reload();
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  await app.evaluate(() => window.dispatchEvent(new Event('nunchiro:close-request')));
  await expect.poll(async () => (await calls(app, 'close_window')).map((c) => c.args.alerts)).toEqual([false]);
  await app.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect.poll(async () => (await calls(app, 'clear_notifications')).length).toBeGreaterThan(0);
});
