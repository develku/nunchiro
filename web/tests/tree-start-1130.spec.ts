// Ticket 1130 B-L1 (plan .scratch/fable/plans-1125/B-first-use-usability.md, lane L1): C1, the project row's "+" starts the
// default agent in one step (T2: 2 steps to 1; mockup docs/design/first-use-1123/mockup.html, panel T2); C2, one chord
// starts the default agent in a new worktree (T6: 6 steps to 2).
import { execFileSync } from 'node:child_process';
import type { Page } from '@playwright/test';
import { expect, openWindow, test, type Core } from './fixtures';
import { openQuiet } from './tree-seed';

const repo = (core: Core, name = 'repo') => {
  const p = core.project(name);
  const git = (...a: string[]) => execFileSync('git', ['-C', p, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a]);
  git('init', '-q', '-b', 'main');
  git('commit', '-q', '--allow-empty', '-m', 'init');
  return p;
};
type Snap = { id: string; project: string; cwd: string; state: string; kind: string };
const sessions = (core: Core) => core.cli('snapshot', '--json').sessions as Snap[];
/** The default agent of Settings > Providers, as the window stores it. */
const defaultAgent = (app: Page, agent: string) =>
  app.addInitScript((a) => localStorage.getItem('nunchiro.settings.v1') === null && localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ features: { 'onboarding.default_agent': a } })), agent);
/** The requests the window sends, the socket passed through unchanged. */
async function record(app: Page) {
  const sent: { op: string; [k: string]: unknown }[] = [];
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => {
      const r = typeof m === 'string' ? JSON.parse(m).request : null;
      if (r) sent.push(r);
      server.send(m);
    });
    server.onMessage((m) => ws.send(m));
  });
  return sent;
}

test('t2_row_plus_one_step: one click on the project row\'s + starts the default agent there, no New tab', async ({ app, core }) => {
  const p = repo(core, 'api-server');
  core.shell(p, 'main-shell');
  openQuiet(core);
  await defaultAgent(app, 'claude');
  const sent = await record(app);
  await openWindow(app);
  const head = app.locator('.row.head', { hasText: 'api-server' });
  await head.hover();
  const plus = head.getByRole('button', { name: 'New Claude session in api-server' });
  await plus.click();
  await expect.poll(() => sessions(core).filter((s) => s.kind === 'claude' && s.state === 'running').map((s) => s.project), { timeout: 15_000 }).toEqual([p]);
  const starts = sent.filter((r) => r.op === 'start');
  expect(starts).toHaveLength(1);
  expect((starts[0].session as { project: string; kind: string })).toMatchObject({ project: p, kind: 'claude' });
  await expect(app.locator('.newtab')).toHaveCount(0);
  const id = sessions(core).find((s) => s.kind === 'claude')!.id;
  await expect(app.locator('.tab[aria-selected="true"]')).toHaveAttribute('data-tab', id);
});

test('two_worktree_agents_two_chords: Shift+Cmd+N twice gives two agents in two new worktrees; off where no worktree can be made', async ({ app, core }) => {
  const p = repo(core);
  const plain = core.project('notes'); // no git: no worktree here
  core.shell(p, 'main-shell');
  core.shell(plain, 'notes-shell');
  openQuiet(core);
  await defaultAgent(app, 'claude');
  await openWindow(app);
  await app.locator('.row.head', { hasText: 'repo' }).locator('b').first().click();
  for (const n of [1, 2]) {
    await app.keyboard.press('Shift+Meta+KeyN');
    await expect.poll(() => sessions(core).filter((s) => s.kind === 'claude' && s.state === 'running').length, { timeout: 20_000 }).toBe(n);
  }
  const agents = sessions(core).filter((s) => s.kind === 'claude');
  expect(agents.map((s) => s.project)).toEqual([p, p]);
  expect(new Set(agents.map((s) => s.cwd)).size).toBe(2);
  for (const a of agents) expect(a.cwd).not.toBe(p);
  // A folder under no repository: the command is off and says why; the chord makes nothing.
  await app.locator('.row.head', { hasText: 'notes' }).locator('b').first().click();
  await app.keyboard.press('Meta+KeyK');
  await app.keyboard.type('New agent in a new worktree');
  const row = app.locator('[data-command="session.new.worktree"]');
  await expect(row).toHaveAttribute('aria-disabled', 'true');
  await expect(row).toContainText('No worktree here');
  await app.keyboard.press('Escape');
  await app.keyboard.press('Shift+Meta+KeyN');
  await app.waitForTimeout(1500);
  expect(sessions(core).filter((s) => s.kind === 'claude')).toHaveLength(2);
});
