// Ticket 370 item 1 (mock docs/design/m2-1109/370.html #remove #removeblocked #menu): Remove from tree closes the
// sessions (stopping running ones, look 1117 v10), refuses while a worktree remains, and never touches the folder.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import type { Page } from '@playwright/test';
import { expect, openWindow, test, type Core } from './fixtures';
import { openQuiet, seed } from './tree-seed';

type Row = { id: string; state: string; project: string };
const grp = (app: Page, name: string) => app.locator(`.grp[data-project="${name}"]`);
const menu = (app: Page) => app.getByRole('menu', { name: 'Actions' });
const dialog = (app: Page) => app.getByRole('alertdialog');
const rows = (core: Core) => core.cli('snapshot', '--json').sessions as Row[];
const stateOf = (core: Core, id: string) => rows(core).find((s) => s.id === id)?.state;

/** A shell whose program ends at once. */
async function ended(core: Core, project: string, label: string, program: string, state: string) {
  const { id } = core.shell(project, label, program);
  await expect.poll(() => stateOf(core, id)).toBe(state);
  return id;
}
/** The requests the window sends. */
function sent(app: Page) {
  const out: { op: string; id?: string; edit?: { op: string } }[] = [];
  app.on('websocket', (ws) =>
    ws.on('framesent', (f) => {
      if (typeof f.payload !== 'string') return;
      const r = JSON.parse(f.payload).request;
      if (r) out.push(r);
    }),
  );
  return out;
}
const closes = (log: ReturnType<typeof sent>) => log.filter((r) => r.op === 'close').map((r) => r.id);
async function openRemove(app: Page, name: string) {
  await grp(app, name).locator('.head .n').click({ button: 'right' });
  await menu(app).locator('[data-command="project.remove"]').click();
  await expect(dialog(app)).toBeVisible();
}
const confirm = (app: Page) => dialog(app).getByRole('button', { name: 'Remove from Nunchiro' }).click();
/** A core restart; the new core has its own port and token, so the next page load must be told. */
async function restart(core: Core, app: Page) {
  core.run(['serve', 'stop', '--yes']);
  await core.restart();
  await app.addInitScript((boot) => (window.__NUNCHIRO__ = boot), core.boot());
}
/** A project with one Resumable, one Exited and one Failed session: an agent the restart leaves resumable, then two shells that end. */
async function mixed(core: Core, app: Page) {
  const project = core.project('alpha');
  core.agent(project, 'agent', `${project}/never`);
  await restart(core, app);
  await ended(core, project, 'done', '/usr/bin/true', 'exited');
  fs.rmSync(`${core.home}/bin/claude`); // an agent that is not installed starts as failed
  expect(core.cli('session', 'start', '--kind', 'claude', '--project', project, '--label', 'broke').session.state).toBe('failed');
  openQuiet(core);
  await openWindow(app, {}, core);
  return project;
}
const sideChat = (core: Core, project: string, parent: string, label: string) =>
  core.cli('session', 'start', '--kind', 'claude', '--project', project, '--label', label, '--', '--permission-mode', 'plan', '--nunchiro-side-chat', parent, 'split').session as { id: string };

test('remove_shows_the_loss_first: counts and callout before any close, then the head goes, the folder stays and no Undo is offered', async ({ app, core }) => {
  const log = sent(app);
  const project = await mixed(core, app);
  await grp(app, 'alpha').locator('.head .n').click({ button: 'right' });
  const item = menu(app).locator('[data-command="project.remove"]');
  await expect(menu(app).locator('.msep + [data-command="project.remove"]')).toHaveCount(1);
  await item.click();
  const d = dialog(app);
  await expect(d).toContainText(project);
  await expect(d).toContainText('Closes 3 sessions.');
  await expect(d).toContainText('1 resumable · 1 exited · 1 failed');
  await expect(d).toContainText('1 resumable session cannot be resumed after this.');
  await expect(d).toContainText('Deletes the session history');
  await expect(d).toContainText('This cannot be undone.');
  await expect(d).toContainText('The folder and its files stay on disk.');
  await expect(d.getByRole('button', { name: 'Cancel' })).toBeFocused();
  expect(closes(log)).toEqual([]);

  await confirm(app);
  await expect(d).toHaveCount(0);
  await expect(grp(app, 'alpha')).toHaveCount(0);
  expect(closes(log)).toHaveLength(3);
  expect(log.filter((r) => r.op === 'tree_edit').map((r) => r.edit?.op).slice(-2)).toEqual(['add', 'project_name']);
  await expect(app.getByText('Undo', { exact: true })).toHaveCount(0);
  expect(fs.existsSync(project)).toBe(true);
});

test('remove_is_gone_after_restart: pin and name are dropped, the head does not come back', async ({ app, core }) => {
  const project = core.project('alpha');
  await ended(core, project, 'done', '/usr/bin/true', 'exited');
  seed(core, { op: 'pin', project, pinned: true }, { op: 'project_name', project, name: 'Renamed' });
  openQuiet(core);
  await openWindow(app, {}, core);
  await openRemove(app, 'Renamed');
  await confirm(app);
  await expect(grp(app, 'Renamed')).toHaveCount(0);
  await restart(core, app);
  await app.reload();
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  await expect(grp(app, 'Renamed')).toHaveCount(0);
  await expect(grp(app, 'alpha')).toHaveCount(0);
  const toml = fs.readFileSync(`${core.home}/tree.toml`, 'utf8');
  expect(toml).not.toContain(project);
  expect(fs.existsSync(project)).toBe(true);
});

test('remove_stops_running_sessions_and_removes: names the running session, Cancel closes nothing, "Stop 1 session and remove" stops it, its row and the head go, and an ended session\'s row and tab too (look 1117 v10, v11, v12)', async ({ app, core }) => {
  const log = sent(app);
  const project = core.project('alpha');
  const live = core.shell(project, 'live').id;
  const shut = core.shell(project, 'shut').id;
  const done = await ended(core, project, 'done', '/usr/bin/true', 'exited');
  core.shell(core.project('beta'), 'other'); // another project's session: the window prunes tabs from a non-empty list
  openQuiet(core);
  await openWindow(app, {}, core);
  // Look 1117 v12 (A S2-C): a session closed earlier keeps a Closed row and its tab, with Restart.
  const shutTab = app.locator(`.tab[data-tab="${shut}"]`);
  await expect(shutTab).toHaveCount(1);
  core.windowClose(shut); // ticket 1013 F6: the window's own Close keeps the done tab
  await expect.poll(() => stateOf(core, shut)).toBe('closed');
  await expect(shutTab).toHaveCount(1);
  await openRemove(app, 'alpha');
  const d = dialog(app);
  await expect(d.getByRole('region', { name: 'Stopped if removed' })).toContainText('live');
  await expect(d.getByRole('button')).toHaveText(['Cancel', 'Stop 1 session and remove']);
  await d.getByRole('button', { name: 'Cancel' }).click();
  expect(closes(log)).toEqual([]);
  await openRemove(app, 'alpha');
  await dialog(app).getByRole('button', { name: 'Stop 1 session and remove' }).click();
  await expect(dialog(app)).toHaveCount(0);
  await expect(grp(app, 'alpha')).toHaveCount(0);
  expect(closes(log).sort()).toEqual([live, live, done, shut].sort());
  // Look 1117 v11 (C NC1), v12 (A S2-C): the stopped and the ended sessions leave no row behind, so no tab, Restart or
  // Resume brings the project back.
  expect(stateOf(core, live)).toBeUndefined();
  expect(stateOf(core, shut)).toBeUndefined();
  await expect(shutTab).toHaveCount(0);
  expect(fs.existsSync(project)).toBe(true);
});

test('remove_rechecks_on_confirm: a session started by the time of the confirm is shown before any close', async ({ app, core }) => {
  const log = sent(app);
  const project = core.project('alpha');
  await ended(core, project, 'done', '/usr/bin/true', 'exited');
  openQuiet(core);
  await openWindow(app, {}, core);
  await openRemove(app, 'alpha');
  core.shell(project, 'late');
  await confirm(app);
  await expect(dialog(app)).toContainText('late');
  await expect(dialog(app)).toContainText('The sessions changed.');
  await expect(dialog(app).getByRole('button', { name: 'Stop 1 session and remove' })).toBeVisible();
  expect(closes(log)).toEqual([]);
  expect(log.filter((r) => r.op === 'tree_edit' && r.edit?.op === 'add')).toEqual([]);
});

test('remove_recounts_a_changed_list: another ended session is shown before it can be closed', async ({ app, core }) => {
  const log = sent(app);
  const project = core.project('alpha');
  await ended(core, project, 'one', '/usr/bin/true', 'exited');
  openQuiet(core);
  await openWindow(app, {}, core);
  await openRemove(app, 'alpha');
  await expect(dialog(app)).toContainText('Closes 1 session.');
  await ended(core, project, 'two', '/usr/bin/true', 'exited');
  await confirm(app);
  await expect(dialog(app)).toContainText('Closes 2 sessions.');
  await expect(dialog(app)).toContainText('The sessions changed.');
  expect(closes(log)).toEqual([]);
});

test('remove_refuses_a_worktree: the listed worktree would bring the head back, so nothing closes; the dialog stops the running sessions and reaches the worktree\'s own remove (look 1117 v13 A NEW-S2-A1)', async ({ app, core }) => {
  const log = sent(app);
  const project = core.project('alpha');
  fs.writeFileSync(`${project}/f`, 'x');
  for (const a of [['init', '-q'], ['add', '.'], ['-c', 'user.name=t', '-c', 'user.email=t@t.invalid', 'commit', '-qm', 'x']]) execFileSync('git', a, { cwd: project });
  const inWt = core.agent(project, 'wt', `${project}/never`, true).id;
  const shell = core.shell(project, 'live').id;
  await ended(core, project, 'done', '/usr/bin/true', 'exited');
  openQuiet(core);
  await openWindow(app, {}, core);
  await openRemove(app, 'alpha');
  const d = dialog(app);
  await expect(d).toContainText('1 worktree');
  await expect(d).toContainText('shows the project again while worktrees remain');
  await expect(d).toContainText('2 running sessions');
  await expect(d.getByRole('button')).toHaveText(['Remove worktree…', 'Close', 'Stop 2 sessions']);
  await expect(d.getByRole('button', { name: 'Close' })).toBeFocused();
  expect(closes(log)).toEqual([]);
  // The stop step stops them and nothing else; the dialog then names only the worktree.
  await d.getByRole('button', { name: 'Stop 2 sessions' }).click();
  await expect(d).not.toContainText('running');
  await expect(d.getByRole('button')).toHaveText(['Remove worktree…', 'Close']);
  await expect(d).toContainText('1 worktree');
  expect(closes(log).sort()).toEqual([inWt, shell].sort());
  expect([stateOf(core, inWt), stateOf(core, shell)]).toEqual(['closed', 'closed']);
  await expect(grp(app, 'alpha')).toHaveCount(1);
  expect(log.filter((r) => r.op === 'tree_edit' && r.edit?.op === 'add')).toEqual([]);
  // The worktree's row hands over to its own remove.
  await d.getByRole('button', { name: 'Remove worktree…' }).click();
  await expect(d).toHaveCount(0);
  await expect.poll(() => log.some((r) => r.op === 'worktree' && (r as { operation?: string }).operation === 'remove')).toBe(true);
});

test('remove_stops_at_a_failed_close: no tree edit, the error says how many closed, the project stays', async ({ app, core }) => {
  const project = core.project('alpha');
  await ended(core, project, 'one', '/usr/bin/true', 'exited');
  await ended(core, project, 'two', '/usr/bin/true', 'exited');
  openQuiet(core);
  let seen = 0;
  const edits: string[] = [];
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((msg) => {
      const r = typeof msg === 'string' ? JSON.parse(msg) : null;
      if (r?.request?.op === 'close' && ++seen === 2) return ws.send(JSON.stringify({ id: r.id, response: { Err: 'holder did not answer' } }));
      if (r?.request?.op === 'tree_edit') edits.push(r.request.edit.op);
      server.send(msg);
    });
    server.onMessage((msg) => ws.send(msg));
  });
  await openWindow(app, {}, core);
  await openRemove(app, 'alpha');
  await confirm(app);
  await expect(dialog(app).getByRole('alert')).toContainText('Closed 1 of 2 sessions');
  await expect(dialog(app).getByRole('alert')).toContainText('holder did not answer');
  expect(edits.filter((e) => e === 'add' || e === 'project_name')).toEqual([]);
  await expect(grp(app, 'alpha')).toHaveCount(1);
});

test('remove_uses_the_right_clicked_row: another session is active, only the row project goes', async ({ app, core }) => {
  const [alpha, beta] = [core.project('alpha'), core.project('beta')];
  const kept = core.shell(alpha, 'active');
  await ended(core, beta, 'done', '/usr/bin/true', 'exited');
  openQuiet(core);
  await openWindow(app, {}, core);
  await openRemove(app, 'beta');
  await expect(dialog(app)).toContainText(beta);
  await confirm(app);
  await expect(grp(app, 'beta')).toHaveCount(0);
  await expect(grp(app, 'alpha')).toHaveCount(1);
  expect(stateOf(core, kept.id)).toBe('running');
});

test('remove_is_not_offered: a session-less row keeps its own remove, a head from another machine has none', async ({ app, core }) => {
  const [alpha, beta] = [core.project('alpha'), core.project('beta')];
  core.shell(alpha, 'there');
  seed(core, { op: 'add', project: beta, added: true });
  openQuiet(core);
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((msg) => server.send(msg));
    server.onMessage((msg) => {
      const m = typeof msg === 'string' ? JSON.parse(msg) : null;
      if (m?.event === 'snapshot') for (const s of m.sessions) s.machine = 'mini';
      ws.send(m ? JSON.stringify(m) : msg);
    });
  });
  await openWindow(app, {}, core);
  await grp(app, 'alpha').locator('.head .n').click({ button: 'right' });
  await expect(menu(app).locator('[data-command="path.copy"]')).toBeVisible();
  await expect(menu(app).locator('[data-command="project.remove"]')).toHaveCount(0);
  await app.keyboard.press('Escape');
  await grp(app, 'beta').locator('.head .n').click({ button: 'right' });
  await expect(menu(app).locator('[data-command="path.copy"]')).toBeVisible();
  await expect(menu(app).locator('[data-command="project.remove"]')).toHaveCount(0);
});

for (const [filing, edits] of [
  ['pinned', (project: string) => [{ op: 'pin', project, pinned: true }]],
  ['grouped', (project: string) => [{ op: 'group_create', name: 'Web', project }]],
  ['added', (project: string) => [{ op: 'add', project, added: true }]],
] as const) {
  // Look 1117 v10 N5: a project stays in the tree until it is removed; an unfiled one too (the core files it as added).
  test(`closing_the_last_live_session_keeps_the_head: ${filing} stays, an unfiled project stays too`, async ({ app, core }) => {
    const [alpha, beta] = [core.project('alpha'), core.project('beta')];
    const [filed, loose] = [core.shell(alpha, 'filed'), core.shell(beta, 'loose')];
    seed(core, ...edits(alpha));
    openQuiet(core, 'Web');
    await openWindow(app, {}, core);
    await expect(grp(app, 'alpha')).toHaveCount(1);
    await expect(grp(app, 'beta')).toHaveCount(1);
    core.windowClose(filed.id); // ticket 1013 F6: the window's own Close keeps the done tab
    core.windowClose(loose.id); // ticket 1013 F6: the window's own Close keeps the done tab
    await expect.poll(() => [stateOf(core, filed.id), stateOf(core, loose.id)]).toEqual(['closed', 'closed']);
    await expect.poll(() => fs.readFileSync(`${core.home}/tree.toml`, 'utf8')).toContain(beta); // filed as added: it stays after a restart too
    await expect(grp(app, 'beta')).toHaveCount(1);
    await expect(grp(app, 'alpha')).toHaveCount(1);
  });
}

test('remove_palette_refuses_rows_on_another_machine: the active session is local, another row of its project is not', async ({ app, core }) => {
  const project = core.project('alpha');
  const here = core.shell(project, 'here');
  core.shell(project, 'there');
  openQuiet(core);
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((msg) => server.send(msg));
    server.onMessage((msg) => {
      const m = typeof msg === 'string' ? JSON.parse(msg) : null;
      if (m?.event === 'snapshot') for (const s of m.sessions) if (s.label === 'there') s.machine = 'mini';
      ws.send(m ? JSON.stringify(m) : msg);
    });
  });
  await openWindow(app, {}, core);
  await app.locator(`.tab[data-tab="${here.id}"]`).click();
  await app.keyboard.press('Meta+KeyK');
  await expect(app.locator('.palette [data-command="project.remove"]')).toHaveAttribute('aria-disabled', 'true');
});

test('remove_names_a_running_side_chat: names it as a side chat among the sessions it stops', async ({ app, core }) => {
  const log = sent(app);
  const project = core.project('alpha');
  const parent = core.agent(project, 'main', `${project}/never`);
  const side = sideChat(core, project, parent.id, 'notes');
  await expect.poll(() => stateOf(core, side.id)).toBe('running');
  openQuiet(core);
  // Not openWindow: it counts a tab per running session, and a side chat has none.
  await app.goto('/');
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  await openRemove(app, 'alpha');
  await expect(dialog(app).getByRole('button', { name: 'Stop 2 sessions and remove' })).toBeVisible();
  // Look 1117 v11 C-NC4: each reads its state word as its tree row does, not "running".
  await expect(dialog(app)).toContainText('Side chat · waiting');
  await expect(dialog(app)).toContainText('Claude · idle');
  expect(closes(log)).toEqual([]);
});

test('remove_closes_an_ended_side_chat: no error and the head leaves the tree', async ({ app, core }) => {
  const project = core.project('alpha');
  const parent = core.agent(project, 'main', `${project}/never`);
  const side = sideChat(core, project, parent.id, 'notes');
  await expect.poll(() => stateOf(core, side.id)).toBe('running');
  seed(core, { op: 'group_create', name: 'Web', project }, { op: 'pin', project, pinned: true });
  await restart(core, app);
  await expect.poll(() => stateOf(core, side.id)).not.toBe('running');
  openQuiet(core, 'Web');
  await openWindow(app, {}, core);
  await openRemove(app, 'alpha');
  await confirm(app);
  await expect(dialog(app)).toHaveCount(0);
  await expect(grp(app, 'alpha')).toHaveCount(0);
  // The closed side chat row keeps the project known to the core, so its pin and group must go by their own edits.
  expect(fs.readFileSync(`${core.home}/tree.toml`, 'utf8')).not.toContain(project);
});

/** The core's worktree list as it is when a start's record was refused: no worktree at all. */
async function unlisted(app: Page) {
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => server.send(m));
    server.onMessage((m) => {
      if (typeof m !== 'string') return ws.send(m);
      const f = JSON.parse(m) as { response?: { Ok?: { type?: string; worktrees?: unknown[] } } };
      if (f.response?.Ok?.type === 'worktrees') f.response.Ok.worktrees = [];
      ws.send(JSON.stringify(f));
    });
  });
}
const gitRepo = (project: string) => {
  fs.writeFileSync(`${project}/f`, 'x');
  for (const a of [['init', '-q'], ['add', '.'], ['-c', 'user.name=t', '-c', 'user.email=t@t.invalid', 'commit', '-qm', 'x']]) execFileSync('git', a, { cwd: project });
};

// Review of the worktree start fix: a worktree that is not in the core's list (its record refused: a project that is a
// linked worktree or a subfolder, or the registry lock held) still blocks Remove, through the session that runs in it.
test('remove_refuses_a_session_in_a_folder_of_its_own: a session outside the project folder that no listed worktree holds blocks Remove; nothing closes', async ({ app, core }) => {
  const log = sent(app);
  const project = core.project('alpha');
  fs.writeFileSync(`${project}/f`, 'x');
  for (const a of [['init', '-q'], ['add', '.'], ['-c', 'user.name=t', '-c', 'user.email=t@t.invalid', 'commit', '-qm', 'x']]) execFileSync('git', a, { cwd: project });
  const inWt = core.agent(project, 'wt', 'never', true).id;
  await unlisted(app);
  openQuiet(core);
  await openWindow(app, {}, core);
  await openRemove(app, 'alpha');
  const d = dialog(app);
  await expect(d.locator('[data-elsewhere]')).toContainText('Sessions in a folder of their own');
  await expect(d.locator('[data-elsewhere]')).toContainText('wt');
  await expect(d.getByRole('button', { name: 'Remove from Nunchiro' })).toHaveCount(0);
  await expect(d.getByRole('button', { name: /^Stop .* and remove$/ })).toHaveCount(0);
  expect(closes(log)).toEqual([]);
  expect(stateOf(core, inWt)).toBe('running');
});

// Follow-up: a session in a folder of its own stays a blocker once stopped; its row is still there with its history.
test('remove_elsewhere_stays_blocked_after_stop: Stop ends the session in an unlisted folder, and Remove is still refused until its row is closed', async ({ app, core }) => {
  const project = core.project('alpha');
  gitRepo(project);
  // A shell: its stop leaves a closed row (an agent's leaves a resumable one), which the old read no longer counted.
  const inWt = (core.cli('session', 'start', '--kind', 'shell', '--project', project, '--worktree', '--label', 'wt', '--', '/bin/cat').session as { id: string }).id;
  await unlisted(app);
  openQuiet(core);
  await openWindow(app, {}, core);
  await openRemove(app, 'alpha');
  const d = dialog(app);
  await expect(d.locator('[data-elsewhere]')).toContainText('wt');
  await d.getByRole('button', { name: 'Stop 1 session' }).click();
  await expect.poll(() => stateOf(core, inWt)).toBe('closed');
  // Read again as the owner would: the sheet closed and Remove pressed once more.
  await d.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(d).toHaveCount(0);
  await openRemove(app, 'alpha');
  await expect(d.locator('[data-elsewhere]')).toContainText('wt');
  await expect(d.getByRole('button', { name: 'Remove from Nunchiro' })).toHaveCount(0);
});

// Follow-up: an ended row in a folder of its own blocks Remove, and the sheet itself closes it.
test('remove_elsewhere_closes_ended_rows: an ended row in an unlisted folder is closed from the sheet, which then offers Remove', async ({ app, core }) => {
  const project = core.project('alpha');
  gitRepo(project);
  const ended = core.cli('session', 'start', '--kind', 'shell', '--project', project, '--worktree', '--label', 'gone', '--', '/usr/bin/true').session as { id: string };
  await expect.poll(() => stateOf(core, ended.id)).toBe('exited');
  await unlisted(app);
  openQuiet(core);
  await openWindow(app, {}, core);
  await openRemove(app, 'alpha');
  const d = dialog(app);
  await expect(d.locator('[data-elsewhere]')).toContainText('gone');
  await expect(d.locator('[data-elsewhere]')).not.toContainText(/\brun/i);
  await d.getByRole('button', { name: 'Close the ended rows' }).click();
  await expect.poll(() => rows(core).some((r) => r.id === ended.id)).toBe(false);
  await expect(d.locator('[data-elsewhere]')).toHaveCount(0);
  await expect(d.getByRole('button', { name: 'Remove from Nunchiro' })).toBeVisible();
});
