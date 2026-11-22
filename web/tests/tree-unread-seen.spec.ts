// needs 170 (1): turn-based Done and the seen rule. A turn that ends (or an exit) on a session the user is not looking at
// leaves it unread: a second tip line, a project that never folds, the picker's word `unread`. No new colour or icon.
// Turn ends and focus are dispatched through the window's own socket and events, never timed.
import { execFileSync } from 'node:child_process';
import type { Page } from '@playwright/test';
import { expect, openWindow, test, type Core } from './fixtures';

const KEY = 'nunchiro.tree.unread.v1';
const LINE = 'Finished · not seen yet';
const gitRepo = (core: Core, name: string) => {
  const p = core.project(name);
  const git = (...a: string[]) => execFileSync('git', ['-C', p, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a]);
  git('init', '-q');
  git('commit', '-q', '--allow-empty', '-m', 'init');
  return p;
};
/** A fake agent in a worktree of `project`: its row is a worktree row, which carries the tip. */
const agent = (core: Core, project: string, label: string) => core.agent(project, label, 'never-created', true);
const tab = (p: Page, id: string) => p.locator(`.tab[data-tab="${id}"]`);
const row = (p: Page, id: string) => p.locator(`.row.wt2[data-menu-session="${id}"]`);
const stored = (p: Page) => p.evaluate((k) => localStorage.getItem(k), KEY);
const ids = async (p: Page): Promise<string[]> => JSON.parse((await stored(p)) ?? '[]');

/** Lets a test set `attention.working`, `side_chat` and `state: exited` on the snapshot frames the window gets. */
async function drive(page: Page) {
  const state: { working: Record<string, boolean>; child: Set<string>; exited: Set<string>; last: unknown; push: () => void } = { working: {}, child: new Set(), exited: new Set(), last: null, push: () => {} };
  const sockets: { send(m: string): void }[] = [];
  const patch = (msg: { sessions: { id: string; state: string; side_chat?: boolean; attention: { working: boolean } }[] }) => {
    for (const s of msg.sessions) {
      if (s.id in state.working) s.attention.working = state.working[s.id];
      if (state.child.has(s.id)) s.side_chat = true;
      if (state.exited.has(s.id)) s.state = 'exited';
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
type Drive = Awaited<ReturnType<typeof drive>>;
/** One working turn: working true, then false, each pushed as a snapshot. */
async function turn(page: Page, d: Drive, id: string) {
  d.working[id] = true;
  d.push();
  await expect(row(page, id).or(tab(page, id)).first()).toBeVisible();
  await page.waitForTimeout(250);
  d.working[id] = false;
  d.push();
  await page.waitForTimeout(350);
}

test('turn_end_marks_unread_when_not_viewed: a background turn end leaves the session unread; the viewed one and a side chat never are', async ({ app, core }) => {
  const v = agent(core, gitRepo(core, 'repoV'), 'viewed');
  const pb = gitRepo(core, 'repoB');
  const b = agent(core, pb, 'background');
  const c = agent(core, pb, 'sibling');
  const k = agent(core, gitRepo(core, 'repoK'), 'kid');
  const d = await drive(app);
  await openWindow(app, {}, core);
  d.child.add(k.id);
  d.push();
  await tab(app, v.id).click();
  await expect(tab(app, v.id)).toHaveAttribute('aria-selected', 'true');
  // All quiet: nothing unread. Ticket 370 (f6568f12): no folded quiet line any more, the background project is drawn.
  await expect(app.locator('.grp[data-project="repoB"]')).toHaveCount(1);
  expect(await ids(app)).toEqual([]);
  await expect(app.locator('.grp[data-project="repoB"] .head .chev')).toHaveAttribute('aria-expanded', 'true');
  await expect(row(app, b.id).locator('.tip')).not.toContainText(LINE);

  // The same event on the viewed session adds nothing.
  await turn(app, d, v.id);
  expect(await ids(app)).toEqual([]);
  // A side chat never becomes unread.
  await turn(app, d, k.id);
  expect(await ids(app)).toEqual([]);

  // A background session does: stored, a second tip line, its project drawn open.
  await turn(app, d, b.id);
  await expect.poll(() => ids(app)).toEqual([b.id]);
  const grp = app.locator('.grp[data-project="repoB"]');
  await expect(grp).toHaveCount(1);
  await expect(grp.locator('.head .chev')).toHaveAttribute('aria-expanded', 'true');
  await expect(row(app, b.id).locator('.tip')).toContainText(LINE);
  await expect(row(app, b.id)).toHaveAttribute('aria-label', new RegExp(LINE));
  await expect(row(app, b.id).locator('.tip')).toHaveAttribute('aria-hidden', 'true');
  // Not drawn for a session that never ended a turn.
  if (await row(app, c.id).count()) await expect(row(app, c.id).locator('.tip')).not.toContainText(LINE);
  // Ticket 370 (f6568f12): the viewed session's quiet project is drawn too; its row carries no unread line.
  await expect(row(app, v.id)).toHaveCount(1);
  await expect(row(app, v.id)).not.toHaveAttribute('aria-label', new RegExp(LINE));
});

test('seen_rule_window_and_drawn: a blurred window still leaves the current session unread and focus clears it; a click clears; a tab behind the active one is not viewed', async ({ app, core }) => {
  const repoV = gitRepo(core, 'repoV');
  const v = agent(core, repoV, 'viewed');
  const b = agent(core, repoV, 'background'); // ticket 570: the strip shows one project's tabs, so the tab behind is in v's project
  const d = await drive(app);
  await openWindow(app, {}, core);
  await tab(app, v.id).click();
  await expect(tab(app, v.id)).toHaveAttribute('aria-selected', 'true');

  // Blurred window: the current session is not being looked at.
  await app.evaluate(() => (document.hasFocus = () => false));
  await turn(app, d, v.id);
  await expect.poll(() => ids(app)).toEqual([v.id]);
  await expect(row(app, v.id).locator('.tip')).toContainText(LINE);
  // Focusing the window sees it.
  await app.evaluate(() => {
    document.hasFocus = () => true;
    window.dispatchEvent(new Event('focus'));
  });
  await expect.poll(() => ids(app)).toEqual([]);
  // The window blurring again, and visibility changing, only re-evaluate: the viewed session stays seen.
  await app.evaluate(() => {
    window.dispatchEvent(new Event('blur'));
    document.dispatchEvent(new Event('visibilitychange'));
  });
  expect(await ids(app)).toEqual([]);

  // A session with its own tab, behind the active one, is unread at its turn end; opening it by click clears it.
  await expect(tab(app, b.id)).toBeVisible();
  await turn(app, d, b.id);
  await expect.poll(() => ids(app)).toEqual([b.id]);
  await row(app, b.id).click();
  await expect(tab(app, b.id)).toHaveAttribute('aria-selected', 'true');
  await expect.poll(() => ids(app)).toEqual([]);
  await expect(row(app, b.id).locator('.tip')).not.toContainText(LINE);
});

test('exit_unread_per_session: an agent that exits by itself is unread; opening a sibling does not clear it, viewing it does', async ({ app, core }) => {
  const v = agent(core, gitRepo(core, 'repoV'), 'viewed');
  const p = gitRepo(core, 'repoE');
  const e1 = agent(core, p, 'first');
  const e2 = agent(core, p, 'second');
  const d = await drive(app);
  await openWindow(app, {}, core);
  await tab(app, v.id).click();
  d.exited.add(e1.id);
  d.push();
  await expect.poll(() => ids(app)).toEqual([e1.id]);
  await expect(row(app, e1.id).locator('.tip')).toContainText(LINE);
  // The old rule cleared the project's flag on opening any of its sessions; now only viewing that session does.
  await row(app, e2.id).click();
  await expect(tab(app, e2.id)).toHaveAttribute('aria-selected', 'true');
  await app.waitForTimeout(300);
  expect(await ids(app)).toEqual([e1.id]);
  await expect(row(app, e1.id).locator('.tip')).toContainText(LINE);
  await row(app, e1.id).click();
  await expect(tab(app, e1.id)).toHaveAttribute('aria-selected', 'true');
  await expect.poll(() => ids(app)).toEqual([]);
});

test('project_unread_derived: the picker words a project with an unread session `unread`, and stops when it is seen', async ({ app, core }) => {
  const v = agent(core, gitRepo(core, 'repoV'), 'viewed');
  const b = agent(core, gitRepo(core, 'repoB'), 'background');
  const d = await drive(app);
  await openWindow(app, {}, core);
  await tab(app, v.id).click();
  const picker = app.getByRole('dialog', { name: 'Projects by status' });
  const word = async () => {
    await app.mouse.move(900, 600);
    await app.locator('.cbox textarea').focus();
    await app.keyboard.press('Control+Space');
    await app.keyboard.press('KeyJ');
    await expect(picker).toBeVisible();
    const t = await picker.getByRole('option').filter({ hasText: 'repoB' }).innerText();
    await app.keyboard.press('Escape');
    await expect(picker).toHaveCount(0);
    return t;
  };
  expect(await word()).not.toContain('unread');
  await turn(app, d, b.id);
  await expect.poll(() => ids(app)).toEqual([b.id]);
  expect(await word()).toContain('unread');
  await row(app, b.id).click(); // ticket 570: repoB's tab is not in repoV's strip
  await expect.poll(() => ids(app)).toEqual([]);
  expect(await word()).not.toContain('unread');
});

test('no_new_colour_for_done: an unread row has the same colours and icon as the same state seen; only the tip differs', async ({ app, core }) => {
  const v = agent(core, gitRepo(core, 'repoV'), 'viewed');
  const p = gitRepo(core, 'repoB');
  const b = agent(core, p, 'background');
  const c = agent(core, p, 'sibling');
  const d = await drive(app);
  await openWindow(app, {}, core);
  await tab(app, v.id).click();
  await turn(app, d, b.id);
  await expect.poll(() => ids(app)).toEqual([b.id]);
  await expect(row(app, c.id)).toBeVisible();
  const look = (id: string) =>
    row(app, id).evaluate((e) => {
      const css = (el: Element, pseudo?: string) => {
        const s = getComputedStyle(el, pseudo);
        return [s.color, s.backgroundColor, s.borderColor, s.opacity, s.fontWeight].join('|');
      };
      const ic = e.querySelector('.ic'); // ticket 1041: an idle row is bare (no glyph)
      return { kind: (e as HTMLElement).dataset.kind, row: css(e), rail: css(e, '::before'), ic: ic ? css(ic) : '', svg: ic?.innerHTML ?? '', tone: [...e.classList].sort().join(' '), name: css(e.querySelector('.n')!) };
    });
  const [unread, seen] = [await look(b.id), await look(c.id)];
  expect(unread).toEqual(seen);
  await expect(row(app, b.id).locator('.tip')).toContainText(LINE);
  await expect(row(app, c.id).locator('.tip')).not.toContainText(LINE);
});
