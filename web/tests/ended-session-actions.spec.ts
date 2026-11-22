// v25-exit-widgets (ticket 286 item 2, needs 207): an ended session (Exited) restarts and closes from the tab menu, the
// palette and the tree row. 11-04 cause: Stop, the only way to end a session, was off for anything not running, and the
// tree row's menu had no Restart, so a session whose agent had quit could be neither restarted nor closed.
import type { Page } from '@playwright/test';
import { expect, openWindow, test, type Core } from './fixtures';
import { makeT } from './i18n-tables';
import { openQuiet } from './tree-seed';

type Snap = { id: string; kind: string; label: string; state: string };
const snap = (core: Core) => core.cli('snapshot', '--json').sessions as Snap[];
const stateOf = (core: Core, id: string) => snap(core).find((s) => s.id === id)?.state;
const menu = (p: Page) => p.getByRole('menu', { name: 'Actions' });
const palette = async (p: Page, command: string) => {
  await p.keyboard.press('Meta+KeyK');
  await p.getByRole('dialog', { name: 'Command palette' }).locator(`[data-command="${command}"]`).click();
};
/** A shell the window shows, then quits on its own: state `exited`, not closed (an exited session has no tab until the window has seen it run). */
async function ended(app: Page, core: Core, project: string, label: string) {
  const s = core.shell(project, label, '/bin/sh', '-c', 'read x; exit 0');
  await expect(app.locator(`.tab[data-tab="${s.id}"]`)).toBeVisible();
  core.cli('session', 'send-text', s.id, 'x\r');
  await expect.poll(() => stateOf(core, s.id)).toBe('exited');
  return s.id;
}
const tab = (p: Page, id: string) => p.locator(`.tab[data-tab="${id}"]`);
const row = (p: Page, id: string) => p.locator(`button.row.wt2[data-menu-session="${id}"]`);

test('ended_session_restart_and_close: tab menu', async ({ app, core }) => {
  const p = core.project('demo');
  await openWindow(app);
  const first = await ended(app, core, p, 'job');
  await tab(app, first).click({ button: 'right' });
  await expect(menu(app).getByRole('menuitem', { name: 'Restart session' })).toBeVisible();
  await expect(menu(app).locator('[data-command="session.stop"]')).toHaveCount(0); // Stop is for a running session: an ended one offers none (744eaefbf)
  await expect(menu(app).getByRole('menuitem', { name: 'Close session' })).not.toHaveAttribute('aria-disabled', 'true');
  await menu(app).getByRole('menuitem', { name: 'Restart session' }).click();
  await expect.poll(() => snap(core).filter((s) => s.state === 'running').length).toBe(1);
  // Ended again, the same tab's menu closes it: the core forgets the row and Undo is offered.
  const second = snap(core).find((s) => s.state === 'running')!.id;
  await app.locator(`.tab[data-tab="${second}"]`).click();
  core.cli('session', 'send-text', second, 'exit\r');
  await expect.poll(() => stateOf(core, second)).toBe('exited');
  await tab(app, second).click({ button: 'right' });
  await menu(app).getByRole('menuitem', { name: 'Close session' }).click();
  await expect.poll(() => stateOf(core, second)).toBeUndefined();
  await expect(app.getByRole('button', { name: /Undo/ })).toBeVisible();
});

test('ended_session_restart_and_close: palette', async ({ app, core }) => {
  const p = core.project('demo');
  await openWindow(app);
  const first = await ended(app, core, p, 'job');
  await tab(app, first).click();
  await palette(app, 'session.close');
  await expect.poll(() => stateOf(core, first)).toBeUndefined();
  const second = await ended(app, core, p, 'again');
  await tab(app, second).click();
  await palette(app, 'session.restart');
  await expect.poll(() => snap(core).filter((s) => s.state === 'running').length).toBe(1);
});

test('ended_session_restart_and_close: tree row', async ({ app, core }) => {
  const p = core.project('demo');
  openQuiet(core); // V2-9a: quiet projects start folded
  await openWindow(app);
  const first = await ended(app, core, p, 'job');
  await expect(row(app, first)).toBeVisible(); // ticket 1022: a session the window saw end keeps its row for 10 minutes
  await row(app, first).click({ button: 'right' });
  await expect(menu(app).getByRole('menuitem', { name: 'Restart session' })).not.toHaveAttribute('aria-disabled', 'true');
  await menu(app).getByRole('menuitem', { name: 'Close session' }).click();
  await expect.poll(() => stateOf(core, first)).toBeUndefined();
  await expect(app.getByRole('button', { name: /Undo/ })).toBeVisible(); // "Closed job", the core's 10 s window
  await expect(row(app, first)).toHaveCount(0); // the closed row goes at once, not when the pointer leaves the tree
  const second = await ended(app, core, p, 'second');
  await expect(row(app, second)).toBeVisible();
  await row(app, second).click({ button: 'right' });
  await menu(app).getByRole('menuitem', { name: 'Restart session' }).click();
  await expect.poll(() => snap(core).filter((s) => s.state === 'running').length).toBe(1);
});

// Look 1117 v7 (S2-1, S3-2): Restart starts an ended session again (chrome/restart.ts). One rule in every place: on a
// running session the row menu, the tab menu and the palette list it off and say why (the menus greyed it with no reason
// and a press said nothing, so it read as a dead item: now its tooltip has the reason and a press says it in the status
// line); an ended shell (exited, not only closed) offers it in both menus, the palette and its own tab.
const WHY = 'Still running: Restart is for a session that has ended. Use Close session first';
test('restart_one_rule: off with its reason while the session runs, offered everywhere once it has ended', async ({ app, core }) => {
  const p = core.project('demo');
  openQuiet(core); // V2-9a: quiet projects start folded
  await openWindow(app);
  const s = core.shell(p, 'job', '/bin/sh', '-c', 'read x; exit 0');
  const agent = core.agent(p, 'helper', 'go');
  await expect(tab(app, s.id)).toBeVisible();
  const restart = () => menu(app).locator('[data-command="session.restart"]');
  const before = snap(core).map((x) => x.id).sort();
  for (const id of [s.id, agent.id]) {
    for (const where of [tab(app, id), row(app, id)]) {
      await where.click({ button: 'right' });
      await expect(restart()).toHaveAttribute('aria-disabled', 'true');
      await expect(restart()).toHaveText('Restart session'); // drawn as the mockup draws it: the reason is not in the item
      await expect(restart()).toHaveAttribute('title', WHY);
      await expect(menu(app).getByRole('menuitem', { name: 'Restart session', exact: true })).toHaveAccessibleDescription(WHY);
      await restart().click({ force: true }); // a disabled item takes the click: the menu closes and the status line says why
      await expect(menu(app)).toHaveCount(0);
      await expect(app.locator('footer.status')).toContainText(WHY);
      await tab(app, agent.id === id ? s.id : agent.id).click(); // another tab: the note of this press is gone before the next one
      await expect(app.locator('footer.status')).not.toContainText(WHY);
    }
  }
  expect(snap(core).map((x) => [x.id, x.state]).sort()).toEqual(before.map((id) => [id, 'running'])); // nothing restarted, nothing stopped
  await tab(app, s.id).click();
  await app.keyboard.press('Meta+KeyK');
  const entry = app.getByRole('dialog', { name: 'Command palette' }).locator('[data-command="session.restart"]');
  await expect(entry.locator('.why')).toHaveText(WHY);
  await expect(entry).toHaveAttribute('aria-disabled', 'true');
  await app.keyboard.press('Escape');
  await expect(app.getByRole('dialog', { name: 'Command palette' })).toHaveCount(0);
  // No composer line under a running shell: its terminal takes the keys.
  await expect(app.locator('.whyline')).toHaveCount(0);

  core.cli('session', 'send-text', s.id, 'x\r');
  await expect.poll(() => stateOf(core, s.id)).toBe('exited');
  await tab(app, s.id).click({ button: 'right' });
  await expect(restart()).not.toHaveAttribute('aria-disabled', 'true');
  await expect(restart()).not.toHaveAttribute('title', /./);
  await app.keyboard.press('Escape');
  await row(app, s.id).click({ button: 'right' }); // ticket 1022: its row stays 10 minutes after it ended
  await expect(restart()).not.toHaveAttribute('aria-disabled', 'true');
  await app.keyboard.press('Escape');
  await tab(app, s.id).click();
  await app.keyboard.press('Meta+KeyK');
  await expect(entry).not.toHaveAttribute('aria-disabled', 'true');
  await expect(entry.locator('.why')).toHaveCount(0);
  await app.keyboard.press('Escape');
  // The ended shell's own tab says it is read-only and has the button (it showed neither unless the session was closed).
  const line = app.locator('.whyline');
  await expect(line).toContainText('job has exited: read only');
  await line.getByRole('button', { name: 'Restart' }).click();
  await expect.poll(() => snap(core).filter((x) => x.kind === 'shell' && x.state === 'running').map((x) => x.label)).toEqual(['job']);
  const next = snap(core).find((x) => x.kind === 'shell' && x.state === 'running')!.id;
  await expect(tab(app, next)).toBeVisible();
  await expect(tab(app, s.id)).toHaveCount(0); // the tab follows the new session
  await expect(app.locator('.whyline')).toHaveCount(0);
  // Every language has the reason.
  for (const lang of ['ko', 'ja', 'zh-Hans', 'zh-Hant', 'es', 'fr', 'pt'] as const) expect(makeT(lang, lang)('exitWidgets.restartWhy'), lang).not.toBe(WHY);
});

test('ended_shell_tab_has_restart (seventh look, A S3-2): a shell that exited shows the strip a closed one has, with Restart; it starts the shell again in the same tab', async ({ app, core }) => {
  const p = core.project('demo');
  await openWindow(app);
  const first = await ended(app, core, p, 'job');
  await tab(app, first).click();
  // It had no control of its own: the composer strip showed only for a closed shell.
  const strip = app.locator('.composer .whyline');
  await expect(strip).toContainText('job');
  await strip.getByRole('button', { name: 'Restart' }).click();
  await expect.poll(() => snap(core).filter((s) => s.state === 'running').length).toBe(1);
  const next = snap(core).find((s) => s.state === 'running')!.id;
  await expect(tab(app, next)).toHaveAttribute('aria-selected', 'true');
  await expect(tab(app, first)).toHaveCount(0);
  await expect(strip).toHaveCount(0); // a running shell shows its terminal alone
});

// Look 1117 v7 (S3-2, the other half): after a relaunch, Restart of an ended shell showed a second tab at the strip's end
// beside the old one. The new session can reach the window in a snapshot before the start's own reply does; it was then
// opened as a session "started elsewhere". Both arrival orders: the old tab keeps its slot, no second tab is drawn, and
// the new session takes the slot when the reply comes.
for (const late of ['reply', 'snapshot'] as const) {
  test(`restart_after_relaunch_keeps_one_tab: the ${late} comes last`, async ({ app: first, core }) => {
    const p = core.project('demo');
    const ids = ['sh1', 'sh2', 'sh3'].map((l) => core.shell(p, l).id);
    await openWindow(first);
    await expect(first.locator('.tab[data-tab]')).toHaveCount(3);
    // The relaunch: the core stops (its shells end) and starts again; a new window restores the three tabs.
    core.run(['serve', 'stop', '--yes']);
    await core.restart();
    const app = await first.context().newPage();
    await first.close();
    const hold = { start: null as number | null, open: false, held: [] as (() => void)[] };
    await app.routeWebSocket(/\/ws$/, (ws) => {
      const server = ws.connectToServer();
      ws.onMessage((m) => {
        const f = typeof m === 'string' ? JSON.parse(m) : null;
        if (f?.request?.op === 'start') hold.start = f.id;
        server.send(m);
      });
      server.onMessage((m) => {
        const f = typeof m === 'string' ? JSON.parse(m) : null;
        const mine = hold.start !== null && (late === 'reply' ? f?.id === hold.start : f?.event === 'snapshot');
        if (mine && !hold.open) return void hold.held.push(() => ws.send(m));
        ws.send(m);
      });
    });
    await app.addInitScript((boot) => { window.__NUNCHIRO__ = boot; }, core.boot());
    await app.goto('/');
    await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
    const strip = () => app.locator('.tab[data-tab]').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.tab));
    await expect.poll(strip).toEqual(ids);
    await expect.poll(() => stateOf(core, ids[1])).toBe('exited');
    await tab(app, ids[1]).click({ button: 'right' });
    await menu(app).getByRole('menuitem', { name: 'Restart session' }).click();
    await expect.poll(() => snap(core).filter((x) => x.state === 'running').map((x) => x.label)).toEqual(['sh2']);
    const next = snap(core).find((x) => x.state === 'running')!.id;
    if (late === 'reply') {
      // The window has the new session (a snapshot showed it: its row is in the tree) and not yet the reply.
      await expect(row(app, next)).toBeVisible();
      expect(await strip()).toEqual(ids); // the old tab in its slot, and no tab at the end
    } else {
      await expect(tab(app, next)).toBeVisible(); // the reply came first
      expect(await strip()).toEqual([ids[0], next, ids[2]]);
    }
    hold.open = true;
    hold.held.splice(0).forEach((go) => go());
    await expect.poll(strip).toEqual([ids[0], next, ids[2]]); // one tab for it, in the old slot
    await expect(tab(app, next)).toHaveAttribute('aria-selected', 'true');
    await expect(app.locator('.tab[data-tab]', { hasText: 'sh2' })).toHaveCount(1);
    // A session that really starts elsewhere still gets its tab, at the end.
    const other = core.shell(p, 'sh4').id;
    await expect.poll(strip).toEqual([ids[0], next, ids[2], other]);
  });
}

// Look 1117 v10 Home S3-8: an ended session whose folder is gone (the core's `folder_gone`) says so in its tab and offers no
// Restart there or in the palette (a press only failed with "Not restarted: That file or folder is not there").
test('ended_folder_gone_says_so: the tab says the folder is gone, Restart is off with that reason', async ({ app, core }) => {
  const p = core.project('demo');
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    server.onMessage((m) => {
      if (typeof m !== 'string' || JSON.parse(m).event !== 'snapshot') return ws.send(m);
      const msg = JSON.parse(m);
      msg.sessions = msg.sessions.map((s: Snap) => (s.label === 'job' && s.state !== 'running' ? { ...s, folder_gone: true } : s));
      ws.send(JSON.stringify(msg));
    });
  });
  await openWindow(app);
  const id = await ended(app, core, p, 'job');
  await tab(app, id).click();
  const line = app.locator('.whyline');
  await expect(line).toContainText("job's folder is gone: read only");
  await expect(line.getByRole('button')).toHaveCount(0);
  await app.keyboard.press('Meta+KeyK');
  const entry = app.getByRole('dialog', { name: 'Command palette' }).locator('[data-command="session.restart"]');
  await expect(entry).toHaveAttribute('aria-disabled', 'true');
  await expect(entry.locator('.why')).toHaveText("job's folder is gone: read only");
});
