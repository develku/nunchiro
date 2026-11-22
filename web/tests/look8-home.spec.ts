// Eighth real-app look (2026-11-18), Home: a failed scheduled run is an owner card (S2-B, against the real core), a
// Once schedule that fired reads "ran" (S2-C: the list is the spec's own, in the core's shape, since a spec cannot wait
// for a clock time), the Team icon is on the bar with no session in front (S3), and the window reads the schedule list
// when the core says it changed. schedule/schedules.ts `failedRunCard` and `ranOnce` are the one place the window reads
// the two shapes.
import { expect, openWindow, test } from './fixtures';
import { mates, openSeat, owner, tokenClaude } from './leader-990';
import { add, openWidget, row } from './schedules-seed';

test('failed_run_card (v8 Home S2-B): a failed scheduled run is a card with Run again and Dismiss; the icon, the chip, Decisions and Home say one number, and Home lists the failure once', async ({ app, core }) => {
  tokenClaude(core);
  const demo = core.project('demo');
  core.shell(demo, 'main');
  const team = [{ id: 'mate-chief', name: 'Chief', lead: true }];
  mates(core, [...team, { id: 'mate-lister', name: 'Lister' }]);
  const lister = add(core, { teammate: 'mate-lister', task: 'List the files.', level: 'light' }, '21:00');
  // The run cannot start (its teammate is gone): the core keeps the failure on the entry and raises its card.
  mates(core, team);
  expect(owner(core, { op: 'schedule_run_now', id: lister.id }).Err).toContain('Lister is no longer a teammate');
  // Every answer the window sends, as sent.
  const answers: { item: string; answer: { type: string }; confirmed: boolean }[] = [];
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => {
      const r = typeof m === 'string' ? JSON.parse(m).request : null;
      if (r?.op === 'answer') answers.push(r);
      server.send(m);
    });
    server.onMessage((m) => ws.send(m));
  });
  await openWindow(app, {}, core);
  await openSeat(app, core, 'Chief');

  // One number everywhere: the lead's chip, the Team icon's badge and name, Decisions.
  const chip = app.locator('.shead [data-team-chip]');
  await expect(chip).toHaveAccessibleName('1 project · 1 needs you');
  const icon = app.locator('nav[data-bar="right"] [data-icon="team"] .ai');
  await expect(icon.locator('.rcount')).toHaveText('1');
  await expect(icon).toHaveAccessibleName('Team · 1 needs you');
  // Home lists the failure once: the digest's row and the card are one row, with Answer.
  await chip.click();
  const needs = app.locator('.sbar[data-widget="team"] .teamv [data-part="projects"] .lead-grp[data-group="needs"]');
  await expect(needs).toHaveAccessibleName('Needs you · 1');
  const failed = needs.locator(`[data-failed-run="${lister.id}"]`);
  await expect(failed).toHaveCount(1);
  await expect(failed.locator('.lead-who')).toHaveText('Scheduled run failed: Lister is no longer a teammate');
  // Answer opens the card in Decisions. The card's `session_id` is the schedule's id: no tab opens for it.
  await failed.getByRole('button', { name: 'Answer', exact: true }).click();
  await expect(app.locator('.dw .dw-count')).toHaveText('1 waiting');
  const card = app.locator('.dw [data-schedule-card="failed"]');
  await expect(card).toHaveAccessibleName(/^Scheduled run failed: Lister · Every day 9:00\sPM/);
  await expect(card.locator('.mc-head b')).toHaveText('Scheduled run failed');
  await expect(card.locator('.sched-line')).toHaveText('Lister · Every day 9:00 PM');
  await expect(card.locator('.sched-ctask')).toHaveText('Lister is no longer a teammate');
  await expect(card.locator('.sched-by')).toHaveCount(0);
  await expect(card.getByRole('button')).toHaveText(['Lister', 'Run again', 'Dismiss']);
  await expect(app.locator(`.tab[data-tab="${lister.id}"]`)).toHaveCount(0);
  // Look 1117 v12/v13 Home S3-4: Run again is the row's Run now. With its cause still there the run fails again: the same
  // card stays and says so (it said nothing).
  const first = await card.getAttribute('data-item');
  await card.getByRole('button', { name: 'Run again', exact: true }).click();
  // Ticket 1002 lane 4 (mockup frame 3): that is its second failure in a row, so the card says so (a new card in its
  // place, which is the word the S3-4 alert was) and offers Pause schedule and Keep it on, with the run's own reason
  // and its next run.
  await expect(card.locator('.mc-head b')).toHaveText('Failed twice in a row');
  await expect(card.locator('.sched-ctask')).toHaveText('Lister is no longer a teammate');
  await expect(card.locator('.sched-by')).toHaveText(/^It runs again /);
  await expect(card.getByRole('button')).toHaveText(['Lister', 'Pause schedule', 'Keep it on']);
  // Its text changed (the core's reason names the streak), so it is a new item in place of the first.
  await expect(card).not.toHaveAttribute('data-item', first!);
  const twice = await card.getAttribute('data-item');
  await expect(app.locator('.dw .dw-count')).toHaveText('1 waiting');
  // The card's name opens the Schedules widget on that row.
  await card.getByRole('button', { name: 'Show Lister in Schedules', exact: true }).click();
  await expect(app.locator('.sbar[data-widget="schedules"] .schedv')).toBeVisible();
  await expect(row(app, lister.id).locator('.sched-go')).toHaveAttribute('aria-expanded', 'true');
  // Keep it on (the deny) drops only the card, and every number with it. The row keeps its failed run; Home lists it no more (look v9
  // home S2-1: the digest lists a failed run only while its card waits).
  await app.locator('#icon-decisions').click();
  await card.getByRole('button', { name: 'Keep it on', exact: true }).click();
  await expect.poll(() => answers[0]).toMatchObject({ op: 'answer', item: twice, answer: { type: 'deny' }, confirmed: true });
  await expect(card).toHaveCount(0);
  await expect(chip).toHaveAccessibleName('1 project');
  await expect(icon.locator('.rcount')).toHaveCount(0);
  await expect(icon).toHaveAccessibleName('Team');
  await expect(app.locator('#icon-schedules .wdot[data-failed]')).toBeVisible();
  await icon.click();
  await expect(app.locator('.sbar[data-widget="team"] .teamv [data-part="projects"]')).toBeVisible();
  await expect(failed).toHaveCount(0);
});

// The core says when the schedule list changed ({"event":"schedules"} on the window's socket), so the window reads then,
// not on a timer (it polled every 60 s with the widget open, every 3 s while a run went).
test('schedules_event: a schedule added outside the window shows in the open widget at once', async ({ app, core }) => {
  const demo = core.project('demo');
  core.shell(demo, 'main');
  await openWindow(app, {}, core);
  const widget = await openWidget(app);
  await expect(widget.locator('.sched-item')).toHaveCount(0);
  const s = add(core, { project: demo, label: 'nightly' }, '03:30'); // the owner socket, as the CLI: not this window's request
  await expect(row(app, s.id)).toBeVisible();
  owner(core, { op: 'schedule_pause', id: s.id, paused: true });
  await expect(row(app, s.id).locator('.sched-next')).toHaveText('paused');
  owner(core, { op: 'schedule_remove', id: s.id });
  await expect(widget.locator('.sched-item')).toHaveCount(0);
});

test('once_ran_row (v8 Home S2-C): a Once schedule that fired reads "ran" with its last result, switched off; one the user paused reads "paused"; a later time is armed again', async ({ app, core }) => {
  const demo = core.project('demo');
  const main = core.shell(demo, 'main');
  const day = (ms: number) => ((d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`)(new Date(ms));
  const now = Date.now();
  const run = (label: string) => ({ kind: 'shell', project: demo, label });
  const yesterday = new Date(`${day(now - 86_400_000)}T09:00`).getTime();
  const list = [
    // Fired yesterday at 9:00: kept by the core, switched off, with its run.
    { id: 'ran', run: run('fired'), at: `${day(now - 86_400_000)} 09:00`, daily: false, next_ms: yesterday, paused: true, last: { session: main.id, at: yesterday + 2000, result: 'finished' } },
    // Look v10 Home S2-2: the same with a bare time (the core's request takes one; the form always sends a date).
    { id: 'bare', run: run('bare'), at: '09:00', daily: false, next_ms: yesterday, paused: true, last: { session: main.id, at: yesterday + 2000, result: 'finished' } },
    // Switched off by the user before its time.
    { id: 'off', run: run('held'), at: `${day(now + 3 * 86_400_000)} 09:00`, daily: false, next_ms: now + 3 * 86_400_000, paused: true },
    // Ran once, then edited to a later time: armed again, with the old run's dot.
    { id: 'again', run: run('again'), at: `${day(now + 2 * 86_400_000)} 09:00`, daily: false, next_ms: now + 2 * 86_400_000, last: { session: main.id, at: yesterday, result: 'finished' } },
  ];
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => {
      const msg = typeof m === 'string' ? JSON.parse(m) : null;
      if (msg?.request?.op !== 'schedule_list') return server.send(m);
      ws.send(JSON.stringify({ id: msg.id, response: { Ok: { schedules: list } } }));
    });
    server.onMessage((m) => ws.send(m));
  });
  await openWindow(app, {}, core);
  const widget = await openWidget(app);
  await expect(widget.locator('.sched-item')).toHaveCount(4);
  const ran = row(app, 'ran');
  await expect(ran.locator('.sched-next')).toHaveText('ran');
  await expect(row(app, 'bare').locator('.sched-next')).toHaveText('ran');
  await expect(ran.getByRole('switch')).not.toBeChecked();
  await expect(ran).toHaveAttribute('data-last', 'done'); // the last result's dot, as for any run
  await expect(ran.locator('.sched-go')).toHaveAttribute('data-tip', /^Last run · yesterday 9:00\sAM$/);
  await expect(ran.locator('.sched-go')).toHaveAccessibleDescription(/Last run · yesterday 9:00\sAM$/);
  await expect(row(app, 'off').locator('.sched-next')).toHaveText('paused');
  await expect(row(app, 'again').locator('.sched-next')).toHaveText(/^in \d+ (hours?|days?)$/);
  await expect(row(app, 'again').getByRole('switch')).toBeChecked();
  // Armed ones first; the ones that are off (paused, ran) after them.
  expect((await widget.locator('.sched-item').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.schedule)))[0]).toBe('again');
  // Its switch cannot turn a passed time on: it opens Edit, where a later time arms it again.
  await ran.getByRole('switch').click();
  await expect(widget.getByRole('form')).toBeVisible();
});

// Home S3: after a relaunch with the Schedules tab in front no session was current, so the bar had no Team icon and
// Home's "Needs you" could not be reached while the lead was "resumable". The icon is there for a lead teammate,
// running or not, and with no session in front it is the shown project's lead, else the Home lead.
test('team_icon_without_a_session (v8 Home S3): with no session in front and the lead not running, the Team icon is on the bar and opens the Home lead\'s view', async ({ app, core }) => {
  core.project('demo');
  mates(core, [{ id: 'mate-chief', name: 'Chief', lead: true }]);
  await openWindow(app, {}, core);
  if (await app.locator('.ovl .ovl-x').isVisible()) await app.locator('.ovl .ovl-x').click(); // a first run opens Settings
  await expect(app.locator('.tab[data-tab]')).toHaveCount(0);
  const icon = app.getByRole('navigation', { name: 'Right bar' }).getByRole('button', { name: 'Team', exact: true });
  await expect(icon).toBeVisible();
  await icon.click();
  await expect(app.locator('.sbar[data-widget="team"] .teamv [data-part="projects"]')).toBeVisible();
});

// Look 1117 v13 (A NEW-S3-D, Home S3-3): the icon and the view follow one rule, the place's lead, else the Home lead. A
// tab of a project with no lead hid the icon; with no tab left, a project gone from the tree (still the selected one)
// showed its lead's "Tell … what you want" view.
test('team_icon_one_rule (v13 A NEW-S3-D, Home S3-3): a project with no lead shows the Home lead; a project gone from the tree is no place', async ({ app, core }) => {
  const demo = core.project('demo');
  const harbor = core.project('harbor');
  mates(core, [{ id: 'mate-chief', name: 'Chief', lead: true }, { id: 'mate-hal', name: 'Hal', lead: true, project: harbor }]);
  const plain = core.shell(demo, 'plain');
  await openWindow(app, {}, core);
  if (await app.locator('.ovl .ovl-x').isVisible()) await app.locator('.ovl .ovl-x').click(); // a first run opens Settings
  await expect(app.locator(`.tab[data-tab="${plain.id}"]`)).toHaveAttribute('aria-selected', 'true');
  const icon = app.getByRole('navigation', { name: 'Right bar' }).getByRole('button', { name: 'Team', exact: true });
  const view = app.locator('.sbar[data-widget="team"] .teamv');
  await icon.click();
  await expect(view.locator('[data-part="projects"]')).toBeVisible();
  // harbor's tab in front: its lead's view.
  const h = core.shell(harbor, 'h');
  await app.keyboard.press('Meta+KeyK');
  await app.locator('.palette input').fill('h');
  await app.locator(`#palette-list [data-command="session.open.${h.id}"]`).click();
  await expect(app.locator(`.tab[data-tab="${h.id}"]`)).toHaveAttribute('aria-selected', 'true');
  await icon.click();
  await expect(view).toContainText('Tell Hal what you want');
  // harbor removed from the tree as the look did: no tab is left in the strip, and harbor stays the selected project.
  await app.locator('.grp[data-project="harbor"] .head .n').click({ button: 'right' });
  await app.locator('[data-command="project.remove"]').click();
  await app.getByRole('alertdialog').getByRole('button', { name: 'Stop 1 session and remove' }).click();
  await expect(app.locator('.tab[data-tab]:not([data-tab="settings"]):visible')).toHaveCount(0);
  await expect(app.locator('.tree .grp[data-project="harbor"]')).toHaveCount(0);
  await expect(icon).toBeVisible();
  await expect(view.locator('[data-part="projects"]')).toBeVisible();
  await expect(view).not.toContainText('Tell Hal');
});
