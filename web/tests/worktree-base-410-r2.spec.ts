// Ticket 410 round 2 (review v37-wt-base F1, F2). F1: what the preview names is what Create uses: a press on Create and
// start, or a Tab out of the base field, takes the highlighted branch, not the half-typed text. F2: a Cancel while Create
// waits for the branch read means no create. The window's core requests are watched on its socket.
import { execFileSync } from 'node:child_process';
import type { Page } from '@playwright/test';
import { expect, openWindow, test, type Core } from './fixtures';
import { openQuiet } from './tree-seed';

const git = (dir: string, ...a: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { encoding: 'utf8' }).trim();
type Frame = { op?: string; operation?: string; base?: string; branch?: string | null };
const listed = (core: Core) => core.cli('worktree', 'list').worktrees as { path: string; branch: string }[];

/** Every request frame the window sends; with `holdBranches`, the `branches` read waits until `release()`. */
async function watch(app: Page, holdBranches = false) {
  const sent: Frame[] = [];
  const held: (() => void)[] = [];
  let hold = holdBranches;
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => {
      const f = typeof m === 'string' ? ((JSON.parse(m) as { request?: Frame }).request ?? {}) : {}; // `{ id, request }`
      sent.push(f);
      if (hold && f.op === 'worktree' && f.operation === 'branches') held.push(() => server.send(m));
      else server.send(m);
    });
    server.onMessage((m) => ws.send(m));
  });
  return {
    creates: () => sent.filter((f) => f.op === 'worktree' && f.operation === 'create'),
    held: () => held.length,
    release() {
      hold = false;
      for (const go of held.splice(0)) go();
    },
  };
}
const repo = (core: Core) => {
  const p = core.project('repo');
  git(p, 'init', '-q', '-b', 'main');
  git(p, 'commit', '-q', '--allow-empty', '-m', 'init');
  git(p, 'switch', '-q', '-c', 'feature');
  git(p, 'commit', '-q', '--allow-empty', '-m', 'on feature');
  return p;
};
const open = async (app: Page, core: Core, p: string) => {
  core.shell(p, 'main-shell');
  openQuiet(core);
  await openWindow(app);
  await app.locator('.grp[data-project="repo"] .row.head').hover();
  await app.getByRole('button', { name: 'New worktree in repo', exact: true }).click();
  const d = app.getByRole('dialog', { name: 'New worktree', exact: true });
  await d.getByRole('textbox').first().fill('fix-login');
  await app.keyboard.press('Alt+Enter');
  await expect(d.getByRole('textbox', { name: 'Base branch' })).toBeFocused();
  return d;
};

test('worktree_base_create_uses_previewed_branch: "ma" previews main; Create and start (no Esc) creates from main, and Tab fills the field', async ({ app, core }) => {
  const p = repo(core);
  const socket = await watch(app);
  const d = await open(app, core, p);
  const base = d.getByRole('textbox', { name: 'Base branch' });
  // Tab out of the field with a branch highlighted: the field takes it.
  await base.fill('ma');
  await expect(d.getByRole('status')).toHaveText('Creates fix-login from main');
  await app.keyboard.press('Tab');
  await expect(base).toHaveValue('main');
  // The start-agent part first, then type again and press Create and start straight from the field.
  await d.getByRole('checkbox').check();
  await base.fill('ma');
  await expect(d.getByRole('option', { name: 'main' })).toHaveAttribute('aria-selected', 'true');
  await expect(d.getByRole('status')).toHaveText('Creates fix-login from main');
  await d.getByRole('button', { name: 'Create and start' }).click();
  await expect(d.getByRole('alert').filter({ hasText: 'is not a branch' })).toHaveCount(0);
  await expect.poll(() => socket.creates().map((f) => f.base)).toEqual(['main']);
  await expect.poll(() => listed(core).some((w) => w.branch === 'fix-login')).toBe(true);
  const w = listed(core).find((w) => w.branch === 'fix-login')!;
  expect(git(w.path, 'rev-parse', 'HEAD')).toBe(git(p, 'rev-parse', 'main'));
});

test('worktree_base_cancel_during_branch_read_creates_nothing: Create waits for the held branch read, Cancel, then the read answers: no create', async ({ app, core }) => {
  const p = repo(core);
  const socket = await watch(app, true);
  const d = await open(app, core, p);
  await expect.poll(() => socket.held()).toBe(1);
  await d.getByRole('textbox', { name: 'Base branch' }).fill('main');
  await app.keyboard.press('Enter'); // waits for the read: the list it judges by has not come
  await expect(d).toBeVisible();
  await d.getByRole('button', { name: 'Cancel' }).click();
  await expect(d).toHaveCount(0);
  socket.release();
  // The read answers; give the resumed submit time to (wrongly) send a create.
  await app.waitForTimeout(1500);
  expect(socket.creates()).toEqual([]);
  expect(listed(core)).toEqual([]);
});
