// Ticket 990 (leader and room, slice c; mockup docs/design/leader-room/index.html H2, screens ① and ②; owner 11-17
// team-widget-1117.html): the lead of a room, the leader's header chip and its Team view (tasks and room), and the one line a
// session of its team shows. A real core; teammates are written to team.json as the core keeps them, and their seats open through the
// window's own team_open (Settings > Team's Open).
import type { Locator } from '@playwright/test';
import { expect, openWindow, test } from './fixtures';
import { asSeat, leaderScene, made, mates, openSeat, openTeam, owner, repo, sessions, tokenClaude, tokenOf } from './leader-990';

test('room_lead (990 c2): a lone shell is no lead and the composer says so; the lead teammate\'s seat is the lead over an earlier root agent', async ({ app, core }) => {
  const project = core.project('demo');
  core.shell(project, 'alpha');
  await openWindow(app, {}, core);
  await app.locator('[data-room-tab]').click();
  await expect(app.getByRole('combobox', { name: 'To' })).toHaveValue('');
  await expect(app.getByRole('combobox', { name: 'To' }).locator('option:checked')).toHaveText('No lead');
  await expect(app.getByRole('textbox', { name: 'Message', exact: true })).toBeDisabled();
  await expect(app.getByRole('textbox', { name: 'Message', exact: true })).toHaveAttribute('placeholder', /no lead to message/);
  await expect(app.locator('.room-role')).toHaveCount(0);

  // An agent the user started first, then the place's lead teammate: the lead is the teammate's seat.
  const helper = core.agent(project, 'helper', 'none');
  mates(core, [{ id: 'lead-main', name: 'Main', project, lead: true }]);
  const seat = await openSeat(app, core, 'Main');
  // A place with a lead has the Team view in place of its Room tab; as a wide tab its room is the same room, with its To.
  const team = await openTeam(app); // the chip shows once the window knows the lead
  await expect(app.locator('[data-room-tab]:not([data-team-tab])')).toHaveCount(0);
  await team.getByRole('button', { name: 'Open as a tab' }).click();
  await expect(app.locator('.pane .teamv-room').getByRole('combobox', { name: 'To' })).toHaveValue(seat);
  await expect(app.locator(`.room-seat[data-seat="${seat}"] .room-role`)).toHaveText('lead');
  await expect(app.locator(`.room-seat[data-seat="${helper.id}"] .room-role`)).toHaveCount(0);
  // Look v9 B N-S3-6: a seat started at a level shows its bars and what it runs, as its tree row does; another session its agent.
  await expect(app.locator(`.room-seat[data-seat="${seat}"] .lvl`)).toHaveAttribute('data-level', 'standard');
  await expect(app.locator(`.room-seat[data-seat="${helper.id}"] .lvl`)).toHaveCount(0);
});

test('room_pane_narrow_chat (990 c4): the room widget beside a session reads as a chat in time order, with colour bars and team notes; the wide Team tab\'s room gains the notes', async ({ app, core }) => {
  const { project, lead, sshWorker, ssh } = await leaderScene(app, core);
  asSeat(core, sshWorker.token, 'agent', 'send', '--to', lead, '--thread', 'plan', 'retry three times, doubling from 2 s');
  asSeat(core, sshWorker.token, 'agent', 'send', '--to', lead, 'done, PR next');
  // Placed only by a user: a narrow zone right of the terminal (no default layout or rail has it).
  expect(core.cli('layout', 'split', 'right', 'room', '--zone', 'terminal', '--size', '420').type).toBe('text');
  const pane = app.locator(`.roompane[data-room-pane="${project}"]`);
  await expect(pane).toBeVisible();
  await expect(pane.locator('.roompane-head')).toContainText('The colour bar shows the worktree');
  // Narrow: no seats column and no thread groups; one log in time order.
  await expect(pane.locator('.room-side')).toBeHidden();
  await expect(pane.locator('.room-log')).toBeHidden();
  const chat = pane.locator('.room-chat');
  await expect(chat).toBeVisible();
  await expect(chat.locator('[data-msg]')).toHaveCount(4);
  await expect(chat.locator('.room-tnote').nth(0)).toHaveText(/^Nunchiro app · Worktree ssh-retry made for the team/);
  await expect(chat.locator('.room-tnote').nth(1)).toHaveText(/^Nunchiro app · Worktree palette made for the team/);
  const lines = chat.locator('.room-line');
  await expect(lines.nth(0)).toContainText('ssh-retry');
  await expect(lines.nth(0)).toContainText('shell');
  await expect(lines.nth(0).locator('.room-ttag')).toHaveText('plan'); // a named thread shows as a tag
  await expect(lines.nth(1).locator('.room-ttag')).toHaveCount(0); // a message that is its own thread has none
  await expect(lines.nth(0).locator('.room-rail')).toHaveAttribute('data-tone', /^(run|idle)$/); // the ssh-retry row's tone
  // The person's line has the quiet bar; a team line is translated, not the core's English body.
  await expect(pane.locator('.room-chat .room-tnote').first()).not.toContainText(ssh.path);

  // The Team view as a tab (the room zone out of the way): its room is wide, keeps its layout and gains the notes.
  core.cli('layout', 'remove', 'room');
  await expect(pane).toHaveCount(0);
  await app.locator(`.tab[data-tab="${lead}"]`).click();
  await (await openTeam(app)).getByRole('button', { name: 'Open as a tab' }).click();
  const wide = app.locator('.pane .teamv-room .room');
  // Inside the Team view the room drops its seats column (the Tasks part says who sits where).
  await expect(wide.locator('.room-seat').first()).toBeHidden();
  await expect(wide.locator('.room-log')).toBeVisible();
  await expect(wide.locator('.room-log .room-tnote')).toHaveCount(2);
  await expect(wide.locator('.room-thread[data-thread="plan"] .room-msg')).toHaveCount(1);
});

test('lead_header_team_chip (990 c5, owner 11-17): a lead\'s seat wears a Lead tag and one chip with its task count; the chip opens the Team view at the side, closed by default and kept per place across a restart of the seat', async ({ app, core }) => {
  tokenClaude(core);
  const project = repo(core, 'nunchiro');
  mates(core, [{ id: 'lead-main', name: 'Main', project, lead: true }]);
  const alpha = core.shell(project, 'alpha');
  await openWindow(app, {}, core);
  const seat = await openSeat(app, core, 'Main');
  const head = app.locator('.shead');
  await expect(head.locator('.lead-tag')).toHaveText('Lead');
  const chip = head.locator('[data-team-chip]');
  await expect(chip).toHaveAccessibleName('0 tasks');
  // Closed by default: no band above the chat, no room beside it, nothing at the side.
  await expect(app.locator('.teamv, .lead-band, .roompane')).toHaveCount(0);
  const team = await openTeam(app);
  // Day one (mockup J ①): no task yet, so the Tasks part is the way card: what to do, the way of working, the user's roles.
  const card = team.locator('[data-way-card]');
  await expect(card).toContainText('Tell Main what you want. It creates a task, assigns your roles to it and asks you before a merge.');
  await expect(card.locator('[data-way-line]')).toContainText('Reviewers check each task automatically');
  await expect(card.locator('.way-roles li')).toHaveText([/^BBuilderBuild the task in its worktree.*Claude$/, /^RReviewer.*$/]);
  // The way is the user's to set (ticket 1099: in Settings > Team, from the card's Change); the card shows the stored value.
  await card.getByRole('button', { name: 'Change' }).click();
  await app.locator('.settings .place-sec').getByRole('radio', { name: 'Strict' }).click();
  await app.keyboard.press('Escape');
  await expect(card.locator('[data-way-line]')).toContainText('Reviewers and a security review check each task');
  expect(owner(core, { op: 'task', operation: 'list', project }).Ok.place).toEqual({ way: 'strict', seats: 'ask' });
  made(core, await tokenOf(core, seat), project, 'ssh-retry');
  await expect(chip).toHaveAccessibleName('1 task');
  await expect(team.locator('[data-way-card]')).toHaveCount(0);
  // Faces only in the Team view and its chip, never in the tree's rows.
  await expect(app.locator('.tree .lead-av')).toHaveCount(0);

  // Another session of the place has no tag and no chip; the Team view is the place's, so it stays at the side.
  await app.locator(`.tab[data-tab="${alpha.id}"]`).click();
  await expect(head.locator('.lead-tag')).toHaveCount(0);
  await expect(head.locator('[data-team-chip]')).toHaveCount(0);
  await expect(app.locator('.sbar[data-widget="team"] .teamv')).toBeVisible();

  // The seat restarts as a new session: the choice is the place's, so the view is still open beside the new seat.
  core.cli('session', 'close', seat);
  await expect.poll(() => sessions(core).find((s) => s.id === seat)?.state).not.toBe('running');
  const next = await openSeat(app, core, 'Main');
  expect(next).not.toBe(seat);
  await expect(app.locator(`.tab[data-tab="${next}"]`)).toHaveAttribute('aria-selected', 'true');
  await expect(app.locator('.sbar[data-widget="team"] .teamv')).toBeVisible();
  // The right bar's hide button closes it.
  await app.locator('nav[data-bar="right"] .sidebtn').click();
  await expect(app.locator('.teamv')).toHaveCount(0);
});

test('lead_band (990 c6, g): the Team view\'s Tasks part has one row per task of the lead (the core makes one for each team worktree) with who sits on it and one state word; a press opens it; hand over and take back; a removed one folds into the closed line', async ({ app, core }) => {
  const { project, lead, docs, palette, sshWorker } = await leaderScene(app, core);
  const team = await openTeam(app);
  const band = team.locator('.teamv-tasks');
  await expect(team.getByRole('tab', { name: 'Tasks' })).toHaveAttribute('aria-selected', 'true');
  const row = (title: string) => band.locator('.lead-row[data-task]', { has: app.locator('.lead-title', { hasText: new RegExp(`^${title}$`) }) });
  await expect(band.locator('.lead-grp .lead-row[data-task]')).toHaveCount(2);
  // The lead's shell worker is seated on no task: the row says who is in the worktree, as before.
  await expect(row('ssh-retry').locator('.lead-who')).toHaveText('ssh-retry · shell');
  await expect(row('ssh-retry').locator('.lead-st')).toHaveText('idle');
  await expect(row('palette').locator('.lead-who')).toHaveText('');

  // The independent worktree is counted under the rows; its menu hands it to the lead (the core's team operation).
  await expect(band.locator('.lead-free')).toContainText('Independent worktrees: 1');
  await band.getByRole('button', { name: 'Hand to the leader' }).click();
  await band.getByRole('menuitem', { name: 'Hand docs to the leader' }).click();
  await expect(row('docs')).toBeVisible();
  await expect(band.locator('.lead-free')).toHaveCount(0);
  await expect(app.locator('.shead [data-team-chip]')).toHaveAccessibleName('3 tasks');
  // Take back from the task's menu: it acts on the task's worktrees.
  await row('docs').getByRole('button', { name: 'Actions for docs' }).click();
  await row('docs').getByRole('menuitem', { name: 'Take back' }).click();
  await expect(band.locator('.lead-free')).toContainText('Independent worktrees: 1');
  await expect(band.locator('.lead-grp .lead-row[data-task]', { hasText: 'docs' })).toHaveCount(0);
  const notes = (owner(core, { op: 'room_read', project }).Ok.messages as { kind: string; team?: { what: string } }[]).filter((m) => m.kind === 'team').map((m) => m.team!.what);
  expect(notes).toEqual(['created', 'created', 'handed', 'taken']);

  // A removed team worktree closes its task: it leaves the groups for the folded line of today's closed tasks.
  core.cli('worktree', 'remove', '--path', palette.path);
  await expect(band.locator('.lead-grp .lead-row[data-task]', { hasText: 'palette' })).toHaveCount(0);
  await expect(band.locator('.lead-closed')).toContainText('1 merged');
  void docs;

  // A press opens the task's most urgent seat: the worker, whose header shows its lead. Until then the worker the lead
  // started has no tab of its own (the person talks to the lead; real-app run 11-16: five tabs for two tasks).
  await expect(app.locator(`.tab[data-tab="${sshWorker.id}"]`)).toHaveCount(0);
  await row('ssh-retry').locator('.lead-go').click();
  await expect(app.locator(`.tab[data-tab="${sshWorker.id}"]`)).toHaveAttribute('aria-selected', 'true');
  await expect(band).toBeVisible(); // the worker is in the lead's place: the Team view stays
  await expect(app.locator('.lead-crumb')).toContainText("In Main's team");
  await app.locator('.lead-crumb').getByRole('button', { name: '← Back to the lead' }).click();
  await expect(app.locator(`.tab[data-tab="${lead}"]`)).toHaveAttribute('aria-selected', 'true');
  await expect(app.locator('.lead-crumb')).toHaveCount(0);
});

// Nightly 11-19: the Team view opened during the window's burst of reads, its task list was refused past the core's in-flight
// cap (MAX_JOBS), and it showed the day-one way card until the 15 s tick. A refused read is read again in a second.
test('lead_band_busy_refusal: a task list refused as busy is read again, not left empty until the slow tick', async ({ app, core }) => {
  await leaderScene(app, core);
  const band = (await openTeam(app)).locator('.teamv-tasks');
  await expect(band.locator('.lead-grp .lead-row[data-task]')).toHaveCount(2);
  // Every task list read in the first 1.5 s after the reload is refused as the core refuses one past MAX_JOBS.
  let until = 0;
  let refused = 0;
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => {
      const f = typeof m === 'string' ? JSON.parse(m) : null;
      if (f?.request?.op === 'task' && f.request.operation === 'list' && Date.now() < (until ||= Date.now() + 1500)) return void (refused++, ws.send(JSON.stringify({ id: f.id, response: { Err: 'too many requests in flight; try again' } })));
      server.send(m);
    });
    server.onMessage((m) => ws.send(m));
  });
  // No focus, visibility or poll tick reads it again: only the retry can.
  await app.addInitScript(() => Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }));
  await app.reload();
  await expect.poll(() => refused).toBeGreaterThan(0);
  await expect(app.locator('.sbar[data-widget="team"] .teamv .teamv-tasks .lead-grp .lead-row[data-task]')).toHaveCount(2, { timeout: 6000 });
});

test('team_line (990 c7): a session the user opens in a team worktree and another teammate of the place show the team line; an independent worktree\'s session and the lead do not', async ({ app, core }) => {
  const { project, lead, ssh, docs } = await leaderScene(app, core);
  mates(core, [
    { id: 'lead-main', name: 'Main', project, lead: true },
    { id: 'mate-rev', name: 'Reviewer', project },
  ]);
  const mine = core.shell(ssh.path, 'by-hand');
  const free = core.shell(docs.path, 'free');
  await app.reload();
  await app.locator(`.tab[data-tab="${lead}"]`).waitFor();
  const check = async (id: string, line: boolean) => {
    await app.locator(`.tab[data-tab="${id}"]`).click();
    await expect(app.locator(`.tab[data-tab="${id}"]`)).toHaveAttribute('aria-selected', 'true');
    await expect(app.locator('.lead-crumb')).toHaveCount(line ? 1 : 0);
    if (line) await expect(app.locator('.lead-crumb')).toContainText("In Main's team");
  };
  const go = async (id: string, label: string) => {
    await app.keyboard.press('Meta+KeyK');
    await app.locator('.palette input').fill(label);
    await app.locator(`#palette-list [data-command="session.open.${id}"]`).click();
  };
  await go(mine.id, 'by-hand');
  await check(mine.id, true);
  await go(free.id, 'free');
  await check(free.id, false);
  await check(lead, false);
  const rev = await openSeat(app, core, 'Reviewer');
  await check(rev, true);
});

test('team_head_narrow (990, real app 11-17): in a narrow Team widget Open as a tab is its arrow alone, clear of the Room tab\'s count', async ({ app, core }) => {
  const project = core.project('demo');
  mates(core, [
    { id: 'lead-main', name: 'Main', project, lead: true },
    { id: 'mate-chief', name: 'Chief', lead: true },
  ]);
  await openWindow(app, {}, core);
  const clear = async (team: Locator) => {
    await team.evaluate((e: HTMLElement) => (e.style.width = '240px'));
    // The Room tab's unread count as the real app drew it (a room message to the person needs a seat token to send).
    await team.getByRole('tab', { name: /Room/ }).evaluate((b) => b.querySelector('.lead-n') || b.insertAdjacentHTML('beforeend', '<span class="lead-n">2</span>'));
    const move = team.getByRole('button', { name: 'Open as a tab' });
    // The tabs' drawn right end (a label or count may overflow its tab box) stays 4 px clear of the button.
    const tabsEnd = await team.getByRole('tablist').evaluate((e) => Math.max(...[...e.querySelectorAll('*')].map((x) => x.getBoundingClientRect().right), ...[...e.querySelectorAll('button')].map((b) => { const r = document.createRange(); r.selectNodeContents(b); return r.getBoundingClientRect().right; })));
    const [btn, view] = await Promise.all([move.boundingBox(), team.boundingBox()]);
    expect(tabsEnd + 4).toBeLessThanOrEqual(btn!.x);
    expect(btn!.x + btn!.width).toBeLessThanOrEqual(view!.x + view!.width);
    // Every tab's label is whole (look 1117 v12/v13 Home S3-2: three parts ran under the button).
    expect(await team.getByRole('tab').evaluateAll((els) => els.every((b) => b.scrollWidth <= b.clientWidth + 1))).toBe(true);
    return move;
  };
  await openSeat(app, core, 'Main');
  const team = await openTeam(app);
  const move = await clear(team);
  await team.evaluate((e: HTMLElement) => (e.style.width = '420px'));
  await expect(move).toContainText('Open as a tab'); // wide enough: the label shows
  await expect(move.locator('.teamv-move-l')).toHaveCSS('position', 'static');
  // The Home lead's view has three parts (Projects | Assistants | Room): a tab with no room goes to a second row.
  await openSeat(app, core, 'Chief');
  await clear(await openTeam(app));
});

// N7 (look 1117 v3 C): at a ~440 px centre the header lost the session's name while the team chip kept its full width. The
// name is the last thing to go: the chip and the details give way first.
test('lead_header_name_stays_when_narrow (N7)', async ({ app, core }) => {
  tokenClaude(core);
  const project = repo(core, 'nunchiro');
  mates(core, [{ id: 'lead-main', name: 'Main', project, lead: true }]);
  core.shell(project, 'alpha');
  await openWindow(app, {}, core);
  await openSeat(app, core, 'Main');
  const head = app.locator('.shead').first();
  await expect(head.locator('[data-team-chip]')).toBeVisible();
  await head.evaluate((h) => (h.style.width = '440px'));
  const name = head.locator(':scope > b');
  const [w, full] = await name.evaluate((b) => [b.clientWidth, b.scrollWidth]);
  expect(w).toBeGreaterThanOrEqual(full - 1);
  expect(await head.evaluate((h) => h.scrollWidth <= h.clientWidth + 1)).toBe(true);
});

// Look 1117 v4 (home S3): a lead opened again after its first seat closed had two "claude · Lead" tabs; one seat, one tab.
test('lead_reopened_has_one_tab', async ({ app, core }) => {
  tokenClaude(core);
  const project = repo(core, 'nunchiro');
  mates(core, [{ id: 'lead-main', name: 'Main', project, lead: true }]);
  core.shell(project, 'alpha');
  await openWindow(app, {}, core);
  const first = await openSeat(app, core, 'Main');
  core.cli('session', 'close', first);
  await expect.poll(() => (core.cli('snapshot', '--json').sessions as { id: string; state: string }[]).find((s) => s.id === first)?.state).not.toBe('running');
  const second = await openSeat(app, core, 'Main');
  expect(second).not.toBe(first);
  await expect(app.locator(`.tab[data-tab="${second}"]`)).toHaveCount(1);
  await expect(app.locator(`.tab[data-tab="${first}"]`)).toHaveCount(0);
});

// Q9 es-J20-1: a line typed while the last one is still sending stays in the field when that send succeeds.
test('room_send_keeps_the_line_typed_while_sending', async ({ app, core }) => {
  const project = core.project('demo');
  core.shell(project, 'alpha');
  mates(core, [{ id: 'lead-main', name: 'Main', project, lead: true }]);
  // The core's answer to room_send is held until the next line is typed.
  let release: (() => void) | null = null;
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    let sent: unknown;
    ws.onMessage((m) => {
      const f = typeof m === 'string' ? JSON.parse(m) : null;
      if (f?.request?.op === 'room_send') sent = f.id;
      server.send(m);
    });
    server.onMessage((m) => {
      const f = typeof m === 'string' ? JSON.parse(m) : null;
      if (sent !== undefined && f?.id === sent) return void ((sent = undefined), (release = () => ws.send(m)));
      ws.send(m);
    });
  });
  await openWindow(app, {}, core);
  await openSeat(app, core, 'Main');
  await (await openTeam(app)).getByRole('button', { name: 'Open as a tab' }).click();
  const field = app.locator('.pane .teamv-room').getByRole('textbox', { name: 'Message', exact: true });
  await field.fill('first line');
  await field.press('Enter');
  await expect.poll(() => !!release).toBe(true);
  await field.fill('second line');
  release!();
  await expect(app.locator('.pane .teamv-room .room-msg', { hasText: 'first line' })).toBeVisible();
  await expect(field).toHaveValue('second line');
});
