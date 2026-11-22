// V2.5-30 (ticket 160, needs 145): workers fold under the session that started them, to any depth, through the row's
// existing `↳ N` control. The links come from a real core: each child is started with its parent session's own token.
import fs from 'node:fs';
import path from 'node:path';
import { Core, expect, nunchiro, test } from './fixtures';
import { openQuiet } from './tree-seed';
import { sessionKids, type Linked } from '../src/tree/state';
import type { Page } from '@playwright/test';

/** A shell session that prints its token, started by `token`'s session (or the owner); returns its id and token. */
async function start(core: Core, project: string, label: string, token?: string) {
  const env = token ? { ...core.env, NUNCHIRO_TOKEN: token } : core.env;
  const args = ['session', 'start', '--kind', 'shell', '--project', project, '--label', label, '--', '/bin/sh', '-c', 'printf "TOKEN:%s\\n" "$NUNCHIRO_TOKEN"; exec cat'];
  const id = (JSON.parse(nunchiro(env, args)).session as { id: string }).id;
  let own = '';
  await expect.poll(() => (own = /TOKEN:(\S+)/.exec(core.read(id))?.[1] ?? '')).not.toBe('');
  return { id, token: own };
}

const count = (app: Page, id: string) => app.locator(`.kidcount[data-kids~="${id}"]`);
const kidRows = (app: Page, id: string) => app.locator(`.kids[data-session="${id}"] .row.kid`);

test('tree_nests_workers_under_coordinator: three levels open under the coordinator row from its fold', async ({ app, core }) => {
  // Each in its own folder, as workers in their own worktrees are: one row per session.
  openQuiet(core);
  const coordinator = await start(core, core.project('orch'), 'coordinator');
  const worker = await start(core, core.project('w1'), 'worker', coordinator.token);
  const sub = await start(core, core.project('w2'), 'sub-worker', worker.token);
  await app.goto('/');
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  // Click 1 of at most 2: the coordinator row's visible, labelled fold.
  const control = count(app, coordinator.id);
  await expect(control).toHaveText('↳ 1');
  await expect(control).toHaveAttribute('aria-label', /.+/);
  await expect(kidRows(app, coordinator.id)).toHaveCount(0); // folded: nothing extra
  await control.click();
  const rows = kidRows(app, coordinator.id);
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toHaveAttribute('data-kid', worker.id);
  await expect(rows.nth(0)).toHaveAttribute('data-depth', '0');
  await expect(rows.nth(1)).toHaveAttribute('data-kid', sub.id);
  await expect(rows.nth(1)).toHaveAttribute('data-depth', '1');
  await expect(rows.nth(1)).toContainText('sub-worker');
  // Each level sits further in than the one above it.
  const [w, s] = [(await rows.nth(0).boundingBox())!, (await rows.nth(1).boundingBox())!];
  expect(s.x).toBeGreaterThan(w.x);
  // Folding again closes the whole subtree.
  await control.click();
  await expect(kidRows(app, coordinator.id)).toHaveCount(0);
});

test('closed coordinator: its workers keep their own rows and nest under nothing', async ({ app, core }) => {
  openQuiet(core);
  const coordinator = await start(core, core.project('orch'), 'coordinator');
  const worker = await start(core, core.project('w1'), 'worker', coordinator.token);
  core.cli('session', 'close', coordinator.id);
  await app.goto('/');
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  await expect(app.locator('.grp[data-project="w1"]')).toBeVisible();
  await expect(count(app, coordinator.id)).toHaveCount(0);
  await expect(app.locator(`.row.kid[data-kid="${worker.id}"]`)).toHaveCount(0);
});

// A fake Claude that fails once `<folder>/end` exists.
const ENDING = `#!/bin/sh
if [ "$1" = --version ]; then echo '2.1.310 (Claude Code)'; exit; fi
printf 'fake worker\\r\\n'
while [ ! -f end ]; do sleep 0.05; done
exit 3
`;

// Ticket 286 r5: a worker whose agent ended reads done under its coordinator. Only a failed worker keeps its shell
// (a clean end closes it: agent_exit_shell.rs), so the fake agent fails.
test('ended_worker_reads_done: an ended worker with its shell kept reads done, not working, under its coordinator', async ({ app, core }) => {
  openQuiet(core);
  fs.writeFileSync(path.join(core.home, 'bin/claude'), ENDING, { mode: 0o700 });
  const coordinator = await start(core, core.project('orch'), 'coordinator');
  const folder = core.project('w1');
  const worker = (JSON.parse(nunchiro({ ...core.env, NUNCHIRO_TOKEN: coordinator.token }, ['session', 'start', '--kind', 'claude', '--project', folder, '--label', 'worker'])).session as { id: string }).id;
  await app.goto('/');
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  await count(app, coordinator.id).click();
  const row = app.locator(`.row.kid[data-kid="${worker}"]`);
  await expect(row).toBeVisible();
  await expect(row).not.toHaveAttribute('data-state', 'done');
  fs.writeFileSync(path.join(folder, 'end'), '');
  await expect(row).toHaveAttribute('data-state', 'done', { timeout: 15_000 });
  const now = (core.cli('snapshot', '--json').sessions as { id: string; state: string; agent_ended?: boolean }[]).find((x) => x.id === worker);
  expect(now).toMatchObject({ state: 'running', agent_ended: true });
});

let n = 0;
const s = (id: string, parent?: string): Linked =>
  ({ id, parent, kind: 'shell', project: '/p', cwd: '/p', label: id, state: 'running', agent_version: null, untested: false, pid: ++n, attention: { working: false, waiting: false, stale: false, failed: false, last_activity: 0 }, pending: [] }) as Linked;
const ids = (m: Map<string, Linked[]>) => Object.fromEntries([...m].map(([k, v]) => [k, v.map((x) => x.id)]));

test('tree_parent_cycle_and_orphan: a cycle is cut, a dangling parent leaves the row at top level', () => {
  // a <-> b is a cycle; c hangs off a; d's parent is gone; e is its own parent; f -> g -> h is a plain chain.
  const tree = sessionKids([s('a', 'b'), s('b', 'a'), s('c', 'a'), s('d', 'gone'), s('e', 'e'), s('f'), s('g', 'f'), s('h', 'g')]);
  expect(ids(tree)).toEqual({ a: ['c'], f: ['g'], g: ['h'] });
  // A closed coordinator (kept in the list for undo) is a dangling parent too; a closed worker nests nowhere.
  const closed = (x: Linked): Linked => ({ ...x, state: 'closed' });
  expect(ids(sessionKids([closed(s('k')), s('l', 'k'), s('m'), closed(s('o', 'm'))]))).toEqual({});
  expect(sessionKids([])).toEqual(new Map());
});
