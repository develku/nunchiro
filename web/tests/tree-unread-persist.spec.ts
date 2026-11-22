// needs 170 (1): unread survives a restart. The flags live in this window's localStorage (`nunchiro.tree.unread.v1`, a
// JSON array of session ids): written on every change, read at mount, pruned to the first snapshot's ids, and a blocked
// or corrupt store leaves the page working with what it holds in memory.
import { execFileSync } from 'node:child_process';
import type { Page } from '@playwright/test';
import { expect, openWindow, test as pw, type Core } from './fixtures';
import { test as plain } from '@playwright/test';
import { parseUnread } from '../src/tree/state';

const KEY = 'nunchiro.tree.unread.v1';
const LINE = 'Finished · not seen yet';
const gitRepo = (core: Core, name: string) => {
  const p = core.project(name);
  const git = (...a: string[]) => execFileSync('git', ['-C', p, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a]);
  git('init', '-q');
  git('commit', '-q', '--allow-empty', '-m', 'init');
  return p;
};
const agent = (core: Core, project: string, label: string) => core.agent(project, label, 'never-created', true);
const tab = (p: Page, id: string) => p.locator(`.tab[data-tab="${id}"]`);
const row = (p: Page, id: string) => p.locator(`.row.wt2[data-menu-session="${id}"]`);
const stored = (p: Page) => p.evaluate((k) => localStorage.getItem(k), KEY);
const ids = async (p: Page): Promise<string[]> => JSON.parse((await stored(p)) ?? '[]');

async function drive(page: Page) {
  const state: { working: Record<string, boolean>; last: unknown; push: () => void } = { working: {}, last: null, push: () => {} };
  const sockets: { send(m: string): void }[] = [];
  const patch = (msg: { sessions: { id: string; attention: { working: boolean } }[] }) => {
    for (const s of msg.sessions) if (s.id in state.working) s.attention.working = state.working[s.id];
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
async function turn(page: Page, d: Awaited<ReturnType<typeof drive>>, id: string) {
  d.working[id] = true;
  d.push();
  await page.waitForTimeout(250);
  d.working[id] = false;
  d.push();
  await page.waitForTimeout(350);
}
const setup = async (app: Page, core: Core) => {
  const v = agent(core, gitRepo(core, 'repoV'), 'viewed');
  const b = agent(core, gitRepo(core, 'repoB'), 'background');
  const d = await drive(app);
  return { v, b, d };
};

plain('parse_unread_is_defensive: strings only, capped at 500, newest kept, anything else is empty', () => {
  expect(parseUnread('["a","b"]')).toEqual(['a', 'b']);
  expect(parseUnread('["a",1,null,{},"b"]')).toEqual(['a', 'b']);
  expect(parseUnread('{"a":1}')).toEqual([]);
  expect(parseUnread('not json')).toEqual([]);
  expect(parseUnread(null)).toEqual([]);
  const many = Array.from({ length: 600 }, (_, i) => `s${i}`);
  const got = parseUnread(JSON.stringify(many));
  expect(got).toHaveLength(500);
  expect(got.at(-1)).toBe('s599');
});

pw('unread_survives_restart: the key holds the id, a reload shows the row unread, an id the first snapshot lacks is pruned', async ({ app, core }) => {
  const { v, b, d } = await setup(app, core);
  await openWindow(app, {}, core);
  await tab(app, v.id).click();
  await turn(app, d, b.id);
  await expect.poll(() => ids(app)).toEqual([b.id]);
  await app.reload();
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  await expect(row(app, b.id).locator('.tip')).toContainText(LINE);
  expect(await ids(app)).toEqual([b.id]);
  // A flag for a session the core no longer lists is dropped at the first snapshot.
  await app.evaluate(([k, id]) => localStorage.setItem(k, JSON.stringify([id, 'ghost-session'])), [KEY, b.id]);
  await app.reload();
  await expect(row(app, b.id).locator('.tip')).toContainText(LINE);
  await expect.poll(() => ids(app)).toEqual([b.id]);
});

pw('unread_store_corrupt_or_blocked: a bad value is ignored; a store that throws leaves the page working on memory', async ({ app, core }) => {
  const { v, b, d } = await setup(app, core);
  await openWindow(app, {}, core);
  await tab(app, v.id).click();
  for (const bad of ['{"a":1}', 'not json', '[1,2,3]']) {
    await app.evaluate(([k, x]) => localStorage.setItem(k, x), [KEY, bad]);
    await app.reload();
    await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
    await expect(app.locator('.row.wt2 .tip', { hasText: LINE })).toHaveCount(0);
  }
  await app.evaluate((k) => localStorage.removeItem(k), KEY);

  // A throwing accessor, as a private window or blocked site data gives.
  await app.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('blocked', 'SecurityError'); } });
  });
  await app.reload();
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  await expect(tab(app, v.id)).toBeVisible();
  await tab(app, v.id).click();
  await turn(app, d, b.id);
  await expect(row(app, b.id).locator('.tip')).toContainText(LINE);
});
