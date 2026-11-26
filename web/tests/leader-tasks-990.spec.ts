// Ticket 990 slice g (mockup docs/design/leader-room/team-j.html ②; owner 11-17 team-widget-1117.html): the Team view's Tasks part
// lists the core's tasks by state. The
// socket is proxied so the ledger's reply and two seats' states are the spec's own; the seats are real sessions.
import fs from 'node:fs';
import type { Page } from '@playwright/test';
import { test as plain } from '@playwright/test';
import { nowState, type TaskView } from '../src/lead/tasks';
import { withoutFront } from '../src/tree/decisions';
import { status, type Session } from '../src/types';
import { type Core, expect, openWindow, test } from './fixtures';
import { mates, openSeat, openTeam, repo, tokenClaude } from './leader-990';

const min = (n: number) => Date.now() - n * 60_000;
// A task closed n minutes ago, but never before today's midnight: the "closed today" fold was empty for runs between
// 00:00 and 00:55 (later n stays earlier).
const closedAt = (n: number) => Math.max(min(n), new Date().setHours(0, 0, 0, 0) + (60 - n) * 1000);
type Ids = Record<'tax' | 'disc' | 'rev' | 'search' | 'probe', string>;
const tasksOf = (project: string, s: Ids) => {
  const seat = (session: string, name: string, role = 'builder') => ({ session, name, role, writes: role === 'builder', at: min(30) });
  const base = (id: string, title: string, updated: number) => ({ id, place: project, title, created: min(60), updated });
  return [
    { ...base('t1', 'tax', min(1)), worktrees: [`${project}-tax`], seats: [seat(s.tax, 'tax')], live: [s.tax], state: 'needs' },
    { ...base('t2', 'discount', min(6)), worktrees: [`${project}-discount`], seats: [seat(s.disc, 'discount'), seat(s.rev, 'Reviewer · discount', 'reviewer')], live: [s.disc, s.rev], review: { revision: 'a', pass: true, by: s.rev, name: 'Reviewer · discount', at: min(8) }, stale: true, state: 'review' },
    { ...base('t3', 'login', min(9)), seats: [seat(s.disc, 'login')], review: { revision: 'b', pass: false, note: 'Add a test for the empty code.', by: s.rev, name: 'review-login', at: min(9) }, state: 'changes' },
    { ...base('t4', 'search', min(3)), seats: [seat(s.search, 'search')], live: [s.search], state: 'working' },
    { ...base('t5', 'docs', min(20)), review: { revision: 'c', pass: true, by: 'user', name: 'review-docs', at: min(20) }, state: 'approved' },
    { ...base('t6', 'why is checkout slow?', min(40)), seats: [seat(s.probe, 'probe')], live: [s.probe], told: [{ at: min(41), session: s.probe, name: 'probe', text: 'Look at the cart first.' }], state: 'idle' },
    { ...base('t7', 'palette', min(50)), closed: { at: closedAt(50), how: 'merged' }, state: 'merged' },
    { ...base('t8', 'old', min(55)), closed: { at: closedAt(55), how: 'done' }, state: 'done' },
  ];
};

/** A lead with five seats; the socket answers `task` with the scene's tasks and shows tax waiting, search working. */
const ROLE = { id: 'o-role', session_id: '', scope: '', kind: 'owner', text: 'add the role Frontend reviewer', choices: [], observed_at: min(2), actionable: true, owner: { type: 'role', role: { name: 'Frontend reviewer', job: 'Reviews web/ changes for style and accessibility.', kind: 'claude', model: 'sonnet', writes: false }, why: '3 of the last 5 reviews on web/ failed for style and accessibility.', place: '' } };
async function taskScene(app: Page, core: Core, home = false, opts: { none?: boolean; role?: boolean; merge?: boolean; leadAsks?: boolean; leadPerm?: boolean; yes?: boolean; busy?: boolean } = {}) {
  tokenClaude(core);
  const project = repo(core, 'demo-shop');
  mates(core, home ? [{ id: 'lead-main', name: 'Lead', lead: true }, { id: 'mate-inbox', name: 'Inbox' }] : [{ id: 'lead-main', name: 'Lead', project, lead: true }]);
  const ids = Object.fromEntries((['tax', 'disc', 'rev', 'search', 'probe'] as const).map((k) => [k, core.shell(project, k).id])) as Ids;
  const asked: { operation?: string; op?: string; text?: string; [k: string]: unknown }[] = [];
  const place = { way: 'team', seats: 'ask' };
  let roleOpen = !!opts.role;
  let listed = ''; // the place the window asks the ledger about: a merge card names the same place
  let busyUntil = 0; // opts.busy: list reads before this time are refused as the core refuses one past MAX_JOBS
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => {
      const msg = typeof m === 'string' ? JSON.parse(m) : null;
      const r = msg?.request;
      if (r?.op === 'answer' && r.item === ROLE.id) {
        asked.push(r);
        roleOpen = false;
        return ws.send(JSON.stringify({ id: msg.id, response: { Ok: { type: 'ack' } } }));
      }
      if (r?.op === 'role' && opts.none) return ws.send(JSON.stringify({ id: msg.id, response: { Ok: { roles: [{ name: 'Builder', job: 'Build the task in its worktree. Then report.', kind: 'claude', writes: true }, { name: 'Reviewer', job: 'Review the change. Edit nothing.', kind: 'codex', writes: false }] } } }));
      if (r?.op !== 'task') return server.send(m);
      if (r.operation === 'list' && Date.now() < busyUntil) return ws.send(JSON.stringify({ id: msg.id, response: { Err: 'too many requests in flight; try again' } }));
      asked.push(r);
      if (r.operation === 'list') listed = r.project;
      if (r.operation === 'way') place.way = r.text;
      if (r.operation === 'grant') place.seats = r.text;
      const listedTasks = r.operation === 'list' && !opts.none ? tasksOf(r.project, ids) : [];
      // Look 1117 v13 B N13-S3-2: the person said yes to two merges; t5's lead runs, t6's lead has no running seat.
      const yes: Record<string, object> = opts.yes ? { t5: { state: 'merge', lead: 'lead-main' }, t6: { state: 'merge', lead: 'lead-old' } } : {};
      const tasks = listedTasks.map((x) => ({ ...x, ...yes[x.id] }));
      ws.send(JSON.stringify({ id: msg.id, response: { Ok: { tasks, place: { ...place } } } }));
    });
    server.onMessage((m) => {
      if (typeof m !== 'string' || JSON.parse(m).event !== 'snapshot') return ws.send(m);
      const msg = JSON.parse(m);
      for (const s of msg.sessions ?? []) {
        if (s.id === ids.tax) {
          Object.assign(s.attention, { working: false, waiting: true });
          s.pending = [{ id: 'd-tax', session_id: s.id, scope: s.project, kind: 'question', text: 'Round to 2 decimals, or keep the full value?\nmore', choices: [], observed_at: min(1), actionable: true }];
        }
        if (s.id === ids.search || s.id === ids.disc || s.id === ids.rev) Object.assign(s.attention, { working: true });
        // The lead's own question: no task's ask.
        if (opts.leadAsks && s.teammate === 'lead-main') {
          Object.assign(s.attention, { working: false, waiting: true });
          s.pending = [{ id: 'd-lead', session_id: s.id, scope: s.project, kind: 'question', text: 'Which name should the greeting use?\n1. Alpha\n2. Beta', choices: [], observed_at: min(1), actionable: true }];
        }
        // Inventory N012: the lead's ordinary permission request (the core marked it safe), answered above its composer.
        if (opts.leadPerm && s.teammate === 'lead-main') {
          Object.assign(s.attention, { working: false, waiting: true });
          s.pending = [{ id: 'd-perm', session_id: s.id, scope: s.project, kind: 'permission', risky: false, text: 'Bash command\n\n  touch out', tool: 'Bash', choices: [], observed_at: min(1), actionable: true }];
        }
      }
      // The core files a proposal under its lead's place (roles.rs `propose`): a project lead's is the project, Home's ''.
      if (roleOpen) msg.owner_decisions = [...(msg.owner_decisions ?? []), { ...ROLE, owner: { ...ROLE.owner, place: home ? '' : project } }];
      if (opts.merge && listed) msg.owner_decisions = [...(msg.owner_decisions ?? []), { id: 'o-merge', session_id: '', scope: '', kind: 'owner', text: 'merge docs', choices: [], observed_at: min(1), actionable: true, owner: { type: 'merge', task: 't5', title: 'docs', place: listed, revision: 'c' } }];
      ws.send(JSON.stringify(msg));
    });
  });
  await openWindow(app, {}, core);
  const lead = await openSeat(app, core, 'Lead');
  if (opts.busy) busyUntil = Date.now() + 1000;
  const team = await openTeam(app);
  // Home view: a Home lead's own tasks sit in its Assistants part (Projects comes first).
  if (home) await team.getByRole('tab', { name: 'Assistants' }).click();
  // Q4 lead-row-team (v9-Home-S3-7): a list refused as busy is read again at once, not at the 15 s tick.
  await expect(team.locator(opts.none ? '[data-way-card]' : '.lead-row[data-task]').first()).toBeVisible(opts.busy ? { timeout: 4000 } : undefined);
  return { project, ids, lead, asked, team };
}

test('lead_tasks_busy (Q4 v9-Home-S3-7): a task list the core refuses as busy shows its rows within 4 s, not at the 15 s poll', async ({ app, core }) => {
  await taskScene(app, core, false, { busy: true });
});

test('lead_tasks (990 g): the Team view lists the ledger\'s tasks by state, needs you first; Answer opens the waiting seat; a stale review reads as in review; a task without a worktree is a row; the closed ones fold', async ({ app, core }) => {
  const { project, ids, lead, asked } = await taskScene(app, core);
  const band = app.locator('.teamv-tasks');
  const row = (id: string) => band.locator(`.lead-row[data-task="${id}"]`);
  expect(asked[0]).toMatchObject({ op: 'task', operation: 'list', all: true });
  expect(fs.realpathSync(String((asked[0] as { project: string }).project))).toBe(fs.realpathSync(project));

  // Groups in order, each with its count.
  expect(await band.locator('.lead-grp').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.group))).toEqual(['needs', 'review', 'working', 'approved', 'idle']);
  await expect(band.locator('.lead-grp[data-group="needs"] .lead-gh')).toHaveText('Needs you · 1');
  await expect(band.locator('.lead-grp[data-group="review"] .lead-gh')).toHaveText('In review · 2');
  // Needs you: the pending card's first line, and the Answer button in place of the state word.
  await expect(row('t1').locator('.lead-who')).toHaveText('Builder asks: Round to 2 decimals, or keep the full value?');
  await expect(row('t1').locator('.lead-st')).toHaveCount(0);
  await expect(row('t1').getByRole('img', { name: 'Builder · tax: waiting for you' })).toBeVisible();
  // The stale review reads as in review, with its words; the asked changes say the review's note.
  await expect(row('t2').locator('.lead-who')).toHaveText('changed after the review');
  await expect(row('t2').locator('.lead-st')).toHaveText('in review');
  await expect(row('t2').locator('.lead-av')).toHaveCount(2);
  await expect(row('t2').getByRole('img', { name: 'Reviewer · discount: working' })).toBeVisible();
  await expect(row('t3').locator('.lead-who')).toHaveText('Add a test for the empty code.');
  await expect(row('t3').locator('.lead-st')).toHaveText('changes asked');
  await expect(row('t4').locator('.lead-who')).toHaveText('Builder · search');
  await expect(row('t5').locator('.lead-who')).toHaveText('reviewed by review-docs');
  await expect(row('t5').locator('.lead-st')).toHaveText('ready to merge');
  // A task with no worktree is a row like any other; what the user told its seat is in its tooltip; no ⋯ (nothing to take back).
  await expect(row('t6')).toContainText('why is checkout slow?');
  await expect(row('t6')).toHaveAttribute('title', 'You told probe: Look at the cart first.');
  await expect(row('t6').locator('.lead-more')).toHaveCount(0);
  // Closed today: one folded line that opens.
  await expect(band.locator('.lead-closed')).toContainText('1 done');
  await expect(band.locator('.lead-closed')).toContainText('1 merged today');
  await expect(row('t7')).toHaveCount(0);
  await band.locator('.lead-closed .lead-go').click();
  await expect(row('t7')).toContainText('merged');
  // The header's one chip: the lead's face and the running seats', the open tasks and the ones that need the person, in the
  // your-turn colour (owner 11-17); the band above the chat is gone.
  const chip = app.locator('.shead [data-team-chip]');
  await expect(chip).toHaveAccessibleName('6 tasks · 1 needs you');
  await expect(chip).toHaveAttribute('data-needs', 'true');
  // Ticket 1168 (mockup bots-1166 panel 4): the lead's own face left the chip for the header's left, drawn once.
  await expect(chip.locator('.lead-av')).toHaveCount(3);
  await expect(app.locator('.shead .face')).toHaveCount(1);
  await expect(app.locator('.lead-band')).toHaveCount(0);
  await expect(app.getByRole('switch', { name: 'Show room' })).toHaveCount(0);
  // Answer opens the seat that waits, and the Team view stays at the side (the same place); a press on a row opens its most urgent seat.
  await row('t1').getByRole('button', { name: 'Answer' }).click();
  await expect(app.locator(`.tab[data-tab="${ids.tax}"]`)).toHaveAttribute('aria-selected', 'true');
  await expect(band).toBeVisible();
  await app.locator(`.tab[data-tab="${lead}"]`).click();
  await row('t4').locator('.lead-go').click();
  await expect(app.locator(`.tab[data-tab="${ids.search}"]`)).toHaveAttribute('aria-selected', 'true');
  // Faces never go into the tree's rows.
  await expect(app.locator('.tree .lead-av')).toHaveCount(0);
});

test('team_places (990, owner 11-17): the Team view lives in one place at a time, the side (closed until opened; narrow, its parts are tabs) or a centre tab (wide, side by side); the chip and the icon open it where it lives; the choice survives a reload; a place with no lead has neither', async ({ app, core }) => {
  const { lead, team } = await taskScene(app, core);
  const icon = app.locator('nav[data-bar="right"] [data-icon="team"] .ai');
  await expect(icon).toHaveAttribute('aria-pressed', 'true');
  await expect(icon).toHaveAccessibleName('Team · 1 needs you');
  await expect(icon.locator('.rcount')).toHaveText('1');
  await expect(icon).toHaveAttribute('data-tip', 'Open Team · 1 needs you'); // eighth look B S2-2: the tooltip, the name and the badge say one count
  // Narrow: two tabs, Tasks first; the Room tab shows the room as a chat.
  await expect(team.getByRole('tab')).toHaveText(['Tasks', 'Room']);
  await expect(team.getByRole('tab', { name: 'Tasks' })).toHaveAttribute('aria-selected', 'true');
  await expect(team.locator('.teamv-room')).toBeHidden();
  await team.getByRole('tab', { name: 'Room' }).click();
  await expect(team.locator('.teamv-room .room-chat')).toBeVisible();
  await expect(team.locator('.teamv-tasks')).toBeHidden();
  // The icon closes it, and closed stays closed across a reload; the chip opens it again.
  await icon.click();
  await expect(app.locator('.teamv')).toHaveCount(0);
  await app.reload();
  await expect(app.locator(`.tab[data-tab="${lead}"]`)).toHaveAttribute('aria-selected', 'true');
  await expect(app.locator('nav[data-bar="right"] [data-icon="team"]')).toBeVisible();
  await expect(app.locator('.teamv')).toHaveCount(0);
  const side = await openTeam(app);
  // Open as a tab: the side lets it go and a centre tab named Team (with the needs-you count) shows it wide, both parts side by side.
  await side.getByRole('button', { name: 'Open as a tab' }).click();
  await expect(app.locator('.sbar .teamv')).toHaveCount(0);
  const tab = app.locator('[data-team-tab]');
  await expect(tab).toHaveAttribute('aria-selected', 'true');
  await expect(tab).toHaveAccessibleName('Team · 1 needs you');
  const wide = app.locator('.pane > .teamv');
  await expect(wide).toHaveAttribute('data-wide');
  await expect(wide.getByRole('tablist')).toHaveCount(0);
  // Ticket 1115 step 2: the tab shows one card per task, the two closed today too (the side keeps its rows).
  await expect(wide.locator('.teamv-tasks .tcard[data-task]')).toHaveCount(8);
  await expect(wide.locator('.teamv-room .room-log')).toBeVisible();
  await expect(wide.locator('.teamv-room .room-side')).toBeHidden(); // its seats column repeats the Tasks part
  // The room's composer fits its row: the text box takes the free width, Send stays whole.
  const box = await wide.locator('.room-composer input').boundingBox();
  expect(box!.width).toBeGreaterThan(200);
  const send = wide.locator('.room-composer button').last();
  expect(await send.evaluate((b) => b.scrollWidth <= b.clientWidth)).toBe(true);
  await expect(app.locator('.teamv')).toHaveCount(1);
  await expect(app.locator('nav[data-bar="right"] [data-icon="team"] .ai')).toHaveAttribute('aria-pressed', 'false');
  // From the lead's chat the chip goes to the tab, and the tab survives a reload.
  await app.locator(`.tab[data-tab="${lead}"]`).click();
  await expect(app.locator('.teamv')).toHaveCount(0);
  await app.locator('.shead [data-team-chip]').click();
  await expect(tab).toHaveAttribute('aria-selected', 'true');
  await app.reload();
  await expect(app.locator('[data-team-tab]')).toBeVisible();
  // Back to the side: the tab goes, the lead's chat shows and the side holds the view, across a reload too.
  await app.locator('[data-team-tab]').click();
  await app.locator('.pane > .teamv').getByRole('button', { name: 'Back to the side' }).click();
  await expect(app.locator('[data-team-tab]')).toHaveCount(0);
  await expect(app.locator(`.tab[data-tab="${lead}"]`)).toHaveAttribute('aria-selected', 'true');
  await expect(app.locator('.sbar[data-widget="team"] .teamv')).toBeVisible();
  await app.reload();
  await expect(app.locator('.sbar[data-widget="team"] .teamv')).toBeVisible();
  // A place with no lead: no Team icon or view, and its Room tab as before.
  const plain = core.shell(core.project('plain'), 'plain');
  await app.keyboard.press('Meta+KeyK');
  await app.locator('.palette input').fill('plain');
  await app.locator(`#palette-list [data-command="session.open.${plain.id}"]`).click();
  await expect(app.locator(`.tab[data-tab="${plain.id}"]`)).toHaveAttribute('aria-selected', 'true');
  await expect(app.locator('nav[data-bar] [data-icon="team"]')).toHaveCount(0);
  await expect(app.locator('.teamv, [data-team-chip], [data-team-tab]')).toHaveCount(0);
  await expect(app.locator('[data-room-tab]')).toBeVisible();
});

test('team_merge_card (990, owner 11-17): a task whose merge the lead asked for reads "needs you" with Answer; Answer opens its card in Decisions', async ({ app, core }) => {
  const { team } = await taskScene(app, core, false, { merge: true });
  const needs = team.locator('.lead-grp[data-group="needs"]');
  await expect(needs.locator('.lead-gh')).toHaveText('Needs you · 2');
  const row = needs.locator('.lead-row[data-task="t5"]');
  await expect(row.locator('.lead-who')).toHaveText('asks you to merge');
  // Real app 11-17: narrow, the waiting seat's question beside Answer takes a second line before it is cut.
  const ask = needs.locator('.lead-row[data-task="t1"] .lead-who');
  expect(await ask.evaluate((e) => e.getBoundingClientRect().height / parseFloat(getComputedStyle(e).lineHeight))).toBeGreaterThan(1.5);
  await expect(row.locator('.lead-st')).toHaveCount(0);
  await expect(team.locator('.lead-grp[data-group="approved"]')).toHaveCount(0);
  await expect(app.locator('.shead [data-team-chip]')).toHaveAccessibleName('6 tasks · 2 needs you');
  await row.getByRole('button', { name: 'Answer' }).click();
  const card = app.locator('.dw .mcard[data-item="o-merge"]');
  await expect(card).toBeVisible();
  await expect(card).toBeFocused();
});

test('team_merge_yes (look 1117 v13 B N13-S3-2): a merge the person said yes to stays under Ready to merge and says whether it waits for the lead\'s Resume', async ({ app, core }) => {
  const { team } = await taskScene(app, core, false, { yes: true });
  const row = (id: string) => team.locator(`.lead-grp[data-group="approved"] .lead-row[data-task="${id}"]`);
  await expect(row('t5').locator('.lead-who')).toHaveText('You said yes. The lead merges it next.');
  await expect(row('t5').locator('.lead-st')).toHaveText('merge approved');
  await expect(row('t6').locator('.lead-who')).toHaveText('You said yes. It merges when the lead is resumed.');
  await expect(team.locator('.lead-grp[data-group="approved"] .lead-answer')).toHaveCount(0); // look v15 B: nothing left to answer
});

test('team_needs_you_is_the_shared_count (q67 look, new 2): with the lead\'s own question and a merge waiting, the Team view, its bar icon, the header chip and Decisions say one number, and the question has a row', async ({ app, core }) => {
  const { team, lead, ids } = await taskScene(app, core, false, { merge: true, leadAsks: true });
  const needs = team.locator('.lead-grp[data-group="needs"]');
  // A seat's question (tax), the merge (docs) and the lead's own question: it read "Needs you · 2" beside Decisions' 3.
  await expect(needs.locator('.lead-gh')).toHaveText('Needs you · 3');
  await expect(needs.locator('.lead-row')).toHaveCount(3);
  const own = needs.locator(`.lead-row[data-ask="${lead}"]`);
  await expect(own.locator('.lead-title')).toHaveText('Lead');
  await expect(own.locator('.lead-who')).toHaveText('Which name should the greeting use?');
  await expect(app.locator('.shead [data-team-chip]')).toHaveAccessibleName('6 tasks · 3 needs you');
  const bar = app.getByRole('navigation', { name: 'Right bar' });
  await expect(bar.getByRole('button', { name: /Team/ })).toContainText('3');
  // Answer on the lead's row opens the lead's seat and its card in Decisions, over the side Team view (look v10 N10-S2-1:
  // with the lead already in front the side's Answer did nothing).
  await team.locator('.lead-row[data-task="t4"] .lead-go').click();
  await expect(app.locator(`.tab[data-tab="${ids.search}"]`)).toHaveAttribute('aria-selected', 'true');
  await own.getByRole('button', { name: 'Answer' }).click();
  await expect(app.locator(`.tab[data-tab="${lead}"]`)).toHaveAttribute('aria-selected', 'true');
  await expect(app.locator('.dw')).toContainText('3 waiting');
  await expect(app.locator('.dw [data-item="d-lead"]')).toBeFocused();
  await bar.getByRole('button', { name: 'Team' }).click();
  await team.locator(`.lead-row[data-ask="${lead}"]`).getByRole('button', { name: 'Answer' }).click();
  await expect(app.locator('.dw [data-item="d-lead"]')).toBeFocused();
});

test('team_needs_you_drops_the_front_card (inventory N012, ticket 1030): the front session\'s ordinary permission request is on its card above the composer, so Decisions, the Team view, its bar icon and the header chip all leave it out; behind, all count it', async ({ app, core }) => {
  const { team, lead, ids } = await taskScene(app, core, false, { leadPerm: true });
  await expect(app.locator('.composer .deccard.docked')).toHaveAttribute('data-session', lead);
  const needs = team.locator('.lead-grp[data-group="needs"]');
  const bar = app.getByRole('navigation', { name: 'Right bar' });
  // In front: only the tax seat's question waits anywhere but on the card. It read "2 needs you" beside Decisions' 1.
  await expect(needs.locator('.lead-gh')).toHaveText('Needs you · 1');
  await expect(needs.locator(`.lead-row[data-ask="${lead}"]`)).toHaveCount(0);
  await expect(app.locator('.shead [data-team-chip]')).toHaveAccessibleName('6 tasks · 1 needs you');
  await expect(bar.getByRole('button', { name: /Team/ })).toHaveAccessibleName('Team · 1 needs you');
  // Behind (another seat in front): the request is in Decisions again, and the Team view and its icon count it.
  await team.locator('.lead-row[data-task="t4"] .lead-go').click();
  await expect(app.locator(`.tab[data-tab="${ids.search}"]`)).toHaveAttribute('aria-selected', 'true');
  await expect(needs.locator('.lead-gh')).toHaveText('Needs you · 2');
  await expect(needs.locator(`.lead-row[data-ask="${lead}"]`)).toHaveCount(1);
  await expect(bar.getByRole('button', { name: /Team/ })).toHaveAccessibleName('Team · 2 needs you');
  await bar.getByRole('button', { name: 'Decisions' }).click();
  await expect(app.locator('.dw')).toContainText('2 waiting');
});

plain('without_front_keeps_the_state (inventory N012): the list Decisions and the Team view count drops the front session\'s ordinary request and still reads it as waiting', () => {
  const ask = { id: 'd', session_id: 'a', scope: '/p', kind: 'permission', risky: false, text: 'Bash', choices: [], observed_at: 1, actionable: true };
  const s = (id: string) => ({ id, state: 'running', pending: [{ ...ask, session_id: id }], attention: { working: false, waiting: false, stale: false, failed: false, last_activity: 0 } }) as unknown as Session;
  const [a, b] = withoutFront([s('a'), s('b')], 'a');
  expect([a.pending.length, status(a)]).toEqual([0, 'waiting']);
  expect([b.pending.length, status(b)]).toEqual([1, 'waiting']);
});

plain('team_task_state_follows_the_seats (q67 look L10-2): a task read "idle" a moment ago says "in review" while its Reviewer works', () => {
  const seat = (session: string, writes: boolean) => ({ session, name: session, role: writes ? 'builder' : 'reviewer', writes, at: 0 });
  const task = (over: Partial<TaskView> = {}): TaskView => ({ id: 't', place: '/p', title: 'farewell', created: 0, updated: 0, state: 'idle', seats: [seat('b', true), seat('r', false)], live: ['b', 'r'], ...over });
  const s = (id: string, working: boolean) => ({ id, state: 'running', pending: [], attention: { working, waiting: false, stale: false, failed: false, last_activity: 0 } }) as unknown as Session;
  const seen = (b: boolean, r: boolean) => new Map([s('b', b), s('r', r)].map((x) => [x.id, x]));
  expect(nowState(task(), seen(false, true)).state).toBe('review'); // the Reviewer works: the core's "review"
  expect(nowState(task(), seen(true, false)).state).toBe('working');
  expect(nowState(task(), seen(true, true)).state).toBe('review'); // the core's order: a review outranks work
  expect(nowState(task(), seen(false, false)).state).toBe('idle');
  expect(nowState(task({ state: 'approved' }), seen(false, false)).state).toBe('approved');
  // The core's word stays for a task that needs the person, a closed one, and a seat the core did not list as running.
  expect(nowState(task({ state: 'needs' }), seen(false, true)).state).toBe('needs');
  expect(nowState(task({ state: 'merged', closed: { at: 1, how: 'merged' } }), seen(false, true)).state).toBe('merged');
  expect(nowState(task({ live: ['b'] }), seen(false, true)).state).toBe('idle');
  // Look 1117 v11 (B N11-S2-3): a Builder blocked in `agent ask --wait` runs a command but waits: the core's "asked" stays.
  expect(nowState(task({ state: 'asked', asking: ['b'] }), seen(true, false)).state).toBe('asked');
  expect(nowState(task({ state: 'asked', asking: ['b'] }), seen(true, true)).state).toBe('review'); // another seat's work still reads
});

test('lead_way (990 i, 1053, 1099): the day-one card says the way in one sentence and Change opens Settings > Team > How this place works, which sets the way and what seats may do, shows the stored value and says who grants permissions; the lead\'s composer has no way chip', async ({ app, core }) => {
  const { ids, asked } = await taskScene(app, core, false, { none: true });
  const card = (await openTeam(app)).locator('[data-way-card]');
  await expect(card.locator('[data-way-line]')).toHaveText('Reviewers check each task automatically · Change');
  await expect(card.locator('.way-pill')).toHaveCount(0);
  await card.getByRole('button', { name: 'Change' }).click();
  const sec = app.locator('.settings .place-sec');
  await expect(sec.getByRole('heading')).toContainText('How this place works');
  const way = sec.getByRole('radiogroup', { name: 'Way of working' });
  await expect(way.getByRole('radio')).toHaveCount(3);
  await expect(way.getByRole('radio', { name: 'Build + review' })).toBeChecked();
  await expect(sec.getByRole('radiogroup', { name: 'What seats may do' }).getByRole('radio', { name: 'Ask first' })).toBeChecked();
  await expect(sec).toContainText('Seats ask you before each edit and command.'); // 1099: the mockup's sentence; who grants: "Only you change these."
  await expect(sec).toContainText('Only you change these.');
  await way.getByRole('radio', { name: 'Build only' }).click();
  await sec.getByRole('radiogroup', { name: 'What seats may do' }).getByRole('radio', { name: 'Edit files' }).click();
  await expect.poll(() => asked.filter((r) => r.operation === 'way' || r.operation === 'grant').map((r) => [r.operation, r.text])).toEqual([['way', 'solo'], ['grant', 'edits']]);
  await app.keyboard.press('Escape');
  await expect(sec).toHaveCount(0);
  // 1053: no way chip in the lead's composer row, nor in another seat's.
  await expect(app.locator('.composer, .cbox').first()).toBeVisible();
  await expect(app.locator('.composer .way-chip, .cbox .way-chip')).toHaveCount(0);
  await app.locator(`.tab[data-tab="${ids.search}"]`).click();
  await expect(app.locator('.way-chip')).toHaveCount(0);
});

test('lead_day_one (990 i): a place with no task shows the way card: what to do, the way with its menu, the user\'s roles as faces with their first line', async ({ app, core }) => {
  await taskScene(app, core, false, { none: true });
  const card = app.locator('.teamv-tasks [data-way-card]');
  await expect(card).toContainText('Tell Lead what you want. It creates a task, assigns your roles to it and asks you before a merge.');
  await expect(card.locator('.way-roles li')).toHaveText(['BBuilderBuild the task in its worktree.Claude', 'RReviewerReview the change.Codex']);
  // q67 look (new 2): "needs you" is the place's shared count. The scene's tax shell asks a question here, so the chip
  // says so with no task yet, and the question has its row under the way card.
  await expect(app.locator('.shead [data-team-chip]')).toHaveAccessibleName('0 tasks · 1 needs you');
  await expect(app.locator('.teamv-tasks .lead-grp[data-group="needs"] .lead-gh')).toHaveText('Needs you · 1');
  await expect(app.locator('.teamv-tasks .lead-row[data-ask] .lead-who')).toHaveText('Round to 2 decimals, or keep the full value?');
  // Ticket 1099: no pill and no menu on the card; Change is the one way to the setting.
  await expect(card.getByRole('button')).toHaveText(['Change']);
});

test('lead_way_head (1060, 1099): with a task the Team view head has no way pill but a gear, which opens this project\'s section in Settings > Team; choosing another way changes the place', async ({ app, core }) => {
  const { asked } = await taskScene(app, core, false);
  await expect(app.locator('[data-way-card]')).toHaveCount(0);
  await expect(app.locator('.teamv-head .way-pill')).toHaveCount(0);
  const gear = app.locator('.teamv-head [data-place-gear]');
  await expect(gear).toHaveAccessibleName('How this place works');
  await gear.click();
  const sec = app.locator('.settings .place-sec');
  await expect(sec.getByRole('combobox', { name: 'Project' })).toBeVisible();
  await sec.getByRole('radiogroup', { name: 'Way of working' }).getByRole('radio', { name: 'Build only' }).click();
  await expect.poll(() => asked.find((r) => r.operation === 'way')?.text).toBe('solo');
});

test('lead_role_card (990 i): a lead\'s role proposal is a card in Decisions with the role\'s face, job, reason, program and model, and "reviews, never edits"; Add the role is the confirmed yes', async ({ app, core }) => {
  const { asked } = await taskScene(app, core, false, { role: true });
  await app.locator('nav[data-bar] [data-icon="decisions"]').first().click();
  const card = app.locator('.rcard[data-item="o-role"]');
  await expect(card).toBeVisible();
  await expect(card.locator('.mc-head')).toContainText('A new role is proposed');
  await expect(card.locator('.rc-words')).toContainText('Frontend reviewer');
  await expect(card.locator('.rc-words')).toContainText('3 of the last 5 reviews on web/ failed');
  await expect(card.locator('.rc-pill')).toHaveText(['Claude sonnet', 'reviews, never edits']);
  await expect(card).toContainText('A role has no memory of its own. What it learns is saved as notes (Settings > Notes).');
  await card.getByRole('button', { name: 'Add the role' }).click();
  await expect.poll(() => asked.find((r) => r.op === 'answer')).toMatchObject({ item: 'o-role', answer: { type: 'allow_once' }, confirmed: true });
  // The item leaves with the core's next snapshot; until then the card takes no second answer.
  await expect(card.getByRole('button', { name: 'Not now' })).toBeDisabled();
});

test('lead_tasks_home (990 g): a Home lead\'s Team view lists Home\'s tasks above its assistants, which stay as they were', async ({ app, core }) => {
  const { team } = await taskScene(app, core, true);
  const tasks = team.locator('[data-part="assistants"]');
  await expect(tasks).toHaveAttribute('aria-labelledby', /assistants-tab$/);
  await expect(tasks.locator('.lead-grp').first().locator('.lead-gh')).toHaveText('Needs you · 1');
  await expect(tasks.locator('.lead-grp[data-group="needs"] .lead-row')).toContainText('tax');
  await expect(tasks.locator('.lead-grp').last()).toHaveAttribute('aria-label', /^Assistants/);
  await expect(tasks.locator('.lead-row[data-mate="mate-inbox"]')).toBeVisible();
  // Home view change 1: the Home lead's chip counts projects from the digest (this stand-in core gives none). Ticket 993
  // (seventh look, Home S2): its second part is the Decisions pane's count, here the one question that waits.
  await expect(app.locator('.shead [data-team-chip]')).toHaveAccessibleName('0 projects · 1 needs you');
});
