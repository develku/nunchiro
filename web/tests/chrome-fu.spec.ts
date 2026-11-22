// v25-chrome-fu (V2.5-82; ticket 297 item 12; shell-chrome review SHOULDs 2, 5, 8): an empty snapshot does not wipe the restored
// tabs, Restart session on an agent resumes its conversation, the Board icon's waiting dot follows a board decision.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, openWindow, stripOnTop, test, type Core } from './fixtures';
import { bar } from './d5b';

type Snap = { id: string; [k: string]: unknown };
// The set of tabs, not their order: the order follows the sessions' spawn order, which is not what these tests are about.
const tabIds = async (p: Page) => (await p.locator('.tab[data-tab]').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.tab as string))).sort();
const ids = (...x: string[]) => x.sort();

/** Proxies the window's socket. `view` rewrites the session list of every snapshot the window gets (the core's own ones too,
 *  so a real snapshot cannot undo it); `show()` re-sends the last snapshot through it. Window requests are recorded; `hold` ops
 *  are recorded and not forwarded. */
async function proxy(page: Page, hold: string[] = []) {
  const st = {
    view: ((l) => l) as (list: Snap[]) => Snap[],
    sent: [] as { op: string; [k: string]: unknown }[],
    last: null as string | null,
    socks: new Set<(raw: string) => void>(),
    links: new Set<{ close: () => Promise<void> }>(),
  };
  const patch = (raw: string) => {
    const msg = JSON.parse(raw);
    msg.sessions = st.view(msg.sessions ?? []);
    return JSON.stringify(msg);
  };
  await page.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    st.links.add(ws);
    let sock: ((raw: string) => void) | null = null;
    ws.onClose(() => (sock && st.socks.delete(sock), st.links.delete(ws)));
    ws.onMessage((msg) => {
      const m = typeof msg === 'string' ? JSON.parse(msg) : null;
      if (m?.request) st.sent.push(m.request);
      if (!hold.includes(m?.request?.op)) server.send(msg);
    });
    server.onMessage((raw) => {
      if (typeof raw !== 'string' || JSON.parse(raw).event !== 'snapshot') return ws.send(raw);
      st.last = raw;
      if (!sock) st.socks.add((sock = (r: string) => ws.send(patch(r))));
      ws.send(patch(raw));
    });
  });
  // drop: the link closes as it does when the core restarts; the window connects again.
  return { st, show: () => st.last && st.socks.forEach((send) => send(st.last!)), drop: () => Promise.all([...st.links].map((ws) => ws.close())) };
}

const three = (core: Core) => {
  const p = core.project('demo');
  return ['one', 'two', 'three'].map((l) => core.shell(p, l).id);
};

test('empty_snapshot_keeps_restored_tabs: a snapshot with no sessions after one with sessions prunes nothing; the next one prunes only the gone', async ({ app, core }) => {
  const [a, b, c] = three(core);
  const link = await proxy(app);
  await openWindow(app);
  expect(await tabIds(app)).toEqual(ids(a, b, c));
  link.st.view = () => []; // the core restarting: the link drops and the new core answers with no sessions
  await link.drop();
  await expect.poll(() => link.st.links.size).toBeGreaterThan(0);
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  await expect(app.locator('.tab[data-tab]')).toHaveCount(3);
  link.show(); // a second empty one changes nothing either
  expect(await tabIds(app)).toEqual(ids(a, b, c));
  link.st.view = (l) => l; // the core is back with every session
  await app.reload(); // the saved window state still holds the tabs (their sessions are already in `seen`, so none reopens)
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  await expect.poll(() => tabIds(app)).toEqual(ids(a, b, c));
  link.st.view = (l) => l.filter((s) => s.id !== c); // the sessions are back, one of them is not
  link.show();
  await expect.poll(() => tabIds(app)).toEqual(ids(a, b));
});

test('empty_snapshot_on_a_live_link_prunes: the last sessions gone (Remove project) close their tabs, none left as a bare id', async ({ app, core }) => {
  three(core);
  const link = await proxy(app);
  await openWindow(app);
  link.st.view = () => [];
  link.show();
  await expect.poll(() => tabIds(app)).toEqual([]);
});

test('resumed_session_keeps_its_tab_shown: a session resumed under a new id (resumed_from) takes its tab in place, still shown', async ({ app, core }) => {
  const [a, b, c] = three(core);
  const link = await proxy(app);
  await openWindow(app);
  await app.locator(`.tab[data-tab="${a}"]`).click();
  const n = `${a}-resumed`;
  link.st.view = (l) => l.map((s) => (s.id === a ? { ...s, id: n, resumed_from: [a] } : s));
  link.show();
  await expect.poll(() => tabIds(app)).toEqual(ids(n, b, c));
  await expect(app.locator(`.tab[data-tab="${n}"]`)).toHaveAttribute('aria-selected', 'true');
});

test('snapshot_forget_still_prunes_one_tab: one session missing from a non-empty snapshot closes just that tab', async ({ app, core }) => {
  const [a, b, c] = three(core);
  const link = await proxy(app);
  await openWindow(app);
  link.st.view = (l) => l.filter((s) => s.id !== b);
  link.show();
  await expect.poll(() => tabIds(app)).toEqual(ids(a, c));
});

test('restart_agent_session_sends_resume_id: Restart session on an ended Claude tab starts again with its agent_session_id, same project', async ({ app, core }) => {
  const p = core.project('demo');
  const s = core.agent(p, 'x', 'alpha');
  const link = await proxy(app, ['start']); // the request is recorded, not run: the id below is not a real conversation
  await openWindow(app);
  core.windowClose(s.id); // ticket 1013 F6: the window's own Close keeps the done tab
  // No finished turn yet: restartStart alone would start fresh, so only restartRequest's agent branch carries the id.
  link.st.view = (l) => l.map((x) => (x.id === s.id ? { ...x, agent_session_id: 'conv-from-snapshot', completion_seq: 0 } : x));
  const tab = app.locator(`.tab[data-tab="${s.id}"]`);
  await expect(tab.locator('.tdot')).toHaveAttribute('data-s', 'done');
  link.show();
  await tab.click({ button: 'right' });
  await app.getByRole('menu', { name: 'Actions' }).getByRole('menuitem', { name: 'Resume session' }).click();
  await expect.poll(() => link.st.sent.filter((r) => r.op === 'start').length).toBe(1);
  expect(link.st.sent.find((r) => r.op === 'start')).toMatchObject({ op: 'start', session: { kind: 'claude', project: p, label: 'x', resume: 'conv-from-snapshot' } });
});

test('board_waiting_dot_follows_decision: a board decision dots the Board icon; answering it removes the dot', async ({ app, core }) => {
  stripOnTop(core, { below: true });
  const file = path.join(core.home, 'cards.json');
  fs.writeFileSync(path.join(core.home, 'board.toml'), `version = 1
[[columns]]
id = 'working'
title = 'Working'
states = ['working']
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
path = ${JSON.stringify(file)}
`);
  const cards = (list: object[]) => (fs.writeFileSync(file + '.tmp', JSON.stringify({ cards: list })), fs.renameSync(file + '.tmp', file));
  cards([]);
  core.shell(core.project('demo'), 'one');
  await openWindow(app);
  const dot = bar(app, 'right').getByRole('button', { name: /^Board( · |$)/ }).locator('.wdot');
  await expect(dot).toHaveCount(0);
  cards([{ id: 'q', title: 'Card q', updated_at: 1, needs_decision: { question: 'Ship it?' } }]);
  await expect(dot).toBeVisible({ timeout: 8000 });
  const card = app.locator('.qcard[data-kind="board"][data-item="integration:roadmap:q@1"]');
  await card.click();
  await card.getByRole('button', { name: 'Resolved' }).click();
  await expect(card).toHaveCount(0);
  await expect(dot).toHaveCount(0);
});
