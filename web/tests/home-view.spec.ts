// Home view (2026-11-17, docs/design/leader-room/home-view-1117.html): the Home lead's Team view is Projects | Assistants |
// Room from the core's digest; its chip reads "N projects · M waiting" (Decisions' own number); Answer opens the project's oldest decision in
// Decisions; a goal goes through the user's card. The tree's Home group shows the lead, active assistants, and folds the
// resting ones. No Home lead: nothing new.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { expect, nunchiro, openWindow, test } from './fixtures';
import { asSeat, mates, openSeat, openTeam, owner, sessions, tokenClaude, tokenOf } from './leader-990';

test('home_view (Home change 1, 2, 4): three parts, the chip and the rows come from the digest; Answer opens the goal card; Send writes the room line from Home and wakes the lead', async ({ app, core }) => {
  tokenClaude(core);
  const alpha = core.project('alpha');
  const beta = core.project('beta');
  core.shell(alpha, 'a1');
  core.shell(beta, 'b1');
  mates(core, [
    { id: 'mate-chief', name: 'Chief', lead: true },
    { id: 'mate-inbox', name: 'Inbox', job: 'Sorts the mail.\nMore.' },
    { id: 'lead-main', name: 'Main', project: alpha, lead: true },
  ]);
  await openWindow(app, {}, core);
  const chief = await openSeat(app, core, 'Chief');
  const token = await tokenOf(core, chief);
  // A project with no leader takes no goal; a project with one gets the user's card.
  expect(() => asSeat(core, token, 'task', 'goal', 'Ship it', '--project', beta, '--json')).toThrow(/has no leader/);
  asSeat(core, token, 'task', 'goal', 'Ship the login page', '--project', alpha, '--json');

  const chip = app.locator('.shead [data-team-chip]');
  await expect(chip).toContainText('2 projects · 1 needs you');
  await expect(chip).toHaveAttribute('data-needs', 'true');
  const view = await openTeam(app);
  await expect(view.locator('[role="tab"]')).toHaveText(['Projects', 'Assistants', 'Room']);
  const projects = view.locator('[data-part="projects"]');
  // Needs you first; the project with no leader is quiet, never counted, with a quiet way to add one.
  await expect(projects.locator('.lead-grp').first()).toHaveAttribute('data-group', 'needs');
  const a = projects.locator(`.lead-row[data-project="${alpha}"]`);
  const b = projects.locator(`.lead-row[data-project="${beta}"]`);
  await expect(a).toHaveAttribute('data-word', 'needs');
  await expect(a.locator('.lead-who')).toContainText('0 tasks · 1 needs you');
  await expect(b).toHaveAttribute('data-word', 'quiet');
  await expect(b.locator('.lead-who')).toContainText('no leader');
  await expect(b.locator('.lead-answer')).toHaveCount(0);
  await expect(b.locator('.home-add')).toHaveText('Add a leader');

  // Assistants: one row per Home assistant with its job's first line, and the way to add one.
  await view.getByRole('tab', { name: 'Assistants' }).click();
  const inbox = view.locator('[data-part="assistants"] .lead-row[data-mate="mate-inbox"]');
  await expect(inbox.locator('b')).toHaveText('Inbox');
  await expect(inbox.locator('.lead-who')).toHaveText('Sorts the mail.');
  await expect(view.locator('[data-part="assistants"] [data-add-mate]')).toHaveText('Add an assistant…');
  await view.getByRole('tab', { name: 'Projects' }).click();

  // Answer: the oldest decision of that project, the card it has everywhere.
  await a.locator('.lead-answer').click();
  const card = app.locator('.dw [data-goal]');
  await expect(card).toBeFocused();
  await expect(card).toContainText("Chief wants to give alpha's lead this goal:");
  await expect(card.locator('blockquote')).toHaveText('Ship the login page');
  // Seventh look (Home S3): two buttons were named "Send" (this one and the composer's arrow); this one says what it sends.
  await expect(card.locator('[data-act="send-goal"]')).toHaveAccessibleName('Send · A goal for alpha');
  await expect(card.locator('[data-act="send-goal"]')).toHaveText('Send');
  await card.locator('[data-act="send-goal"]').click();
  await expect(card).toHaveCount(0);

  // Send: the line in alpha's room says where it came from, and the lead's seat opens with the goal.
  let lead = '';
  await expect.poll(() => (lead = sessions(core).find((s) => s.teammate === 'lead-main' && s.state === 'running')?.id ?? '')).not.toBe('');
  const line = (owner(core, { op: 'room_read', project: alpha }).Ok.messages as { team?: { what: string }; body: string; to: string }[]).find((m) => m.team?.what === 'goal');
  expect(line?.body).toBe('Goal from Chief (the Home lead), approved by the user: Ship the login page');
  expect(line?.to).toBe('person'); // the lead was not running when it was written; its seat opened after, with the goal
  // The goal is the seat's next prompt after its brief (queued until the agent takes input).
  const sent = () => {
    const row = (core.cli('snapshot', '--json').sessions as { id: string; send_log?: { content: string }[]; send_queue?: { content: string }[] }[]).find((x) => x.id === lead);
    return [...(row?.send_log ?? []), ...(row?.send_queue ?? [])].map((x) => x.content).join('\n');
  };
  await expect.poll(sent).toContain('Goal from Chief (the Home lead), approved by the user: Ship the login page');
  await expect(chip).toContainText('2 projects');
  await expect(chip).not.toContainText(/needs? you/);

  // The lead's room shows the line with its origin.
  await app.locator(`.tree .row.wt2[data-menu-session="${lead}"]`).click();
  const leadView = await openTeam(app);
  await leadView.getByRole('tab', { name: /Room/ }).click();
  const note = leadView.locator('.room-chat .room-tnote[data-team="goal"]');
  await expect(note.locator('[data-origin="core"]')).toHaveText('Nunchiro app ·');
  await expect(note).toContainText('Goal from your assistant Chief, approved by you: Ship the login page');
});

test('home_tree (Home change 3): the Home lead first; an assistant only while it works, waits or failed (or is open); the resting ones fold into one line that unfolds', async ({ app, core }) => {
  tokenClaude(core);
  const alpha = core.project('alpha');
  const a1 = core.shell(alpha, 'a1');
  mates(core, [
    { id: 'mate-inbox', name: 'Inbox' },
    { id: 'mate-chief', name: 'Chief', lead: true },
    { id: 'mate-res', name: 'Researcher' },
  ]);
  await openWindow(app, {}, core);
  const group = app.locator('.tree .home-grp');
  await expect(group.locator('.home-mate')).toHaveCount(1);
  await expect(group.locator('.home-mate').first()).toHaveAttribute('data-mate', 'mate-chief');
  await expect(group.locator('.home-rest')).toContainText('2 resting');

  // An open seat shows while it is the one in front; resting again behind another tab; working, it shows by itself.
  const inbox = await openSeat(app, core, 'Inbox');
  await expect(group.locator('.home-mate[data-mate="mate-inbox"]')).toHaveCount(1);
  await expect(group.locator('.home-rest')).toContainText('1 resting');
  await app.locator(`.tree .row.wt2[data-menu-session="${a1.id}"]`).click();
  await expect(group.locator('.home-mate[data-mate="mate-inbox"]')).toHaveCount(0);
  core.hook(inbox, 'UserPromptSubmit');
  await expect(group.locator('.home-mate[data-mate="mate-inbox"]')).toHaveCount(1);
  await expect(group.locator('.home-mate').first()).toHaveAttribute('data-mate', 'mate-chief');

  // A press on the folded line shows every assistant.
  await group.locator('.home-rest .row').click();
  await expect(group.locator('.home-mate')).toHaveCount(3);
  await expect(group.locator('.home-rest')).toHaveCount(0);
});

test('home_none (Home): no Home lead, nothing new: Home teammates all show with no resting line, and a project lead\'s chip counts its tasks, not projects', async ({ app, core }) => {
  tokenClaude(core);
  const alpha = core.project('alpha');
  core.shell(alpha, 'a1');
  mates(core, [
    { id: 'mate-inbox', name: 'Inbox' },
    { id: 'mate-res', name: 'Researcher' },
    { id: 'lead-main', name: 'Main', project: alpha, lead: true },
  ]);
  await openWindow(app, {}, core);
  const group = app.locator('.tree .home-grp');
  await expect(group.locator('.home-mate')).toHaveCount(2);
  await expect(group.locator('.home-rest')).toHaveCount(0);
  await openSeat(app, core, 'Main');
  await expect(app.locator('.shead [data-team-chip]')).toContainText('0 tasks');
  await expect(app.locator('.shead [data-team-chip]')).not.toContainText('project');
  const view = await openTeam(app);
  await expect(view.locator('[role="tab"]')).toHaveText(['Tasks', 'Room']);
  await expect(view.locator('[data-part]')).toHaveCount(0);
});

const nunchiroAs = (core: { env: NodeJS.ProcessEnv }, token: string, ...args: string[]) => nunchiro({ ...core.env, NUNCHIRO_TOKEN: token }, args);
/** A PermissionRequest hook on the owner socket, left open (the core answers it only when the card is answered). */
// With a third argument the hook is a real question (Claude's AskUserQuestion), not a Bash permission request.
const ASK = `const net = require('net'), fs = require('fs'), path = require('path'); const [h, id, q] = process.argv.slice(1);
const hook = q ? { event: 'PreToolUse', payload: { tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Which one?', options: [{ label: 'A' }, { label: 'B' }] }] } } } : { event: 'PermissionRequest', payload: { tool_name: 'Bash', tool_input: { command: "printf 'hello'" }, nunchiro_event_id: 'ev-1' } };
const s = net.connect(path.join(h, 'core.sock'));
s.on('connect', () => s.write(JSON.stringify({ token: fs.readFileSync(path.join(h, 'core.token'), 'utf8').trim(), request: { op: 'hook', id, ...hook } }) + '\\n'));
setTimeout(() => process.exit(0), 20000);`;
const ask = (home: string, id: string, question = false) => spawn(process.execPath, ['-e', ASK, home, id, ...(question ? ['question'] : [])], { stdio: 'ignore' }).unref();

test('home_counts (look 1117 v3 N1, N2): no leader is never counted; a pending decision is, leader or not, and the row says what waits; a session at a permission card is not working', async ({ app, core }) => {
  const shop = core.project('demo-shop');
  const tool = core.project('tool-box');
  const perm = core.agent(shop, 'perm-1', 'go');
  core.shell(tool, 'tb-shell');
  mates(core, [{ id: 'mate-chief', name: 'Chief', lead: true }]);
  await openWindow(app, {}, core);
  await openSeat(app, core, 'Chief');
  const chip = app.locator('.shead [data-team-chip]');
  const view = await openTeam(app);
  const shopRow = view.locator(`[data-part="projects"] .lead-row[data-project="${shop}"]`);
  const toolRow = view.locator(`[data-part="projects"] .lead-row[data-project="${tool}"]`);
  // N1: two projects with no leader and nothing to answer: quiet, uncounted, each with its quiet way to add one.
  await expect(chip).toContainText('2 projects');
  await expect(chip).not.toContainText(/needs? you/);
  for (const row of [shopRow, toolRow]) {
    await expect(row).toHaveAttribute('data-word', 'quiet');
    await expect(row.locator('.lead-who')).toContainText('no leader');
    await expect(row.locator('.home-add')).toHaveText('Add a leader');
  }
  // A turn starts: working.
  core.hook(perm.id, 'UserPromptSubmit');
  await expect(shopRow).toHaveAttribute('data-word', 'working');
  await expect(shopRow.locator('.lead-who')).toContainText('1 working');
  // N2: the same session stops at a permission card: it waits for the user, so it is no longer working; the row is under
  // Needs you for that decision and says what waits, not "no leader".
  // As a real Claude asks mid-turn: the PermissionRequest hook, which the core holds until the card is answered.
  ask(core.home, perm.id);
  await expect(shopRow).toHaveAttribute('data-word', 'needs');
  await expect(shopRow.locator('.lead-who')).toContainText('perm-1: ');
  await expect(shopRow.locator('.lead-who')).not.toContainText('{'); // v4 N2: the ask's words, never the hook's raw JSON
  await expect(shopRow.locator('.lead-who')).not.toContainText('working');
  await expect(shopRow.locator('.lead-who')).not.toContainText('no leader');
  await expect(shopRow.locator('.lead-answer')).toHaveText('Answer');
  await expect(toolRow).toHaveAttribute('data-word', 'quiet');
  await expect(chip).toContainText('2 projects · 1 needs you');
});

// Seventh look, Home S2: with the Home lead's own question and one merge card waiting, Decisions said "2 waiting" and the
// chip "1 project · 1 need you", which read as a wrong count. The chip says Decisions' number (eighth look: in the Team
// icon's and the Team view's words, "needs you").
test('home_chip_is_decisions_count (seventh look, Home S2): the lead\'s own question and a merge card are 2 in the chip and in Decisions', async ({ app, core }) => {
  tokenClaude(core);
  const alpha = core.project('alpha');
  const a1 = core.shell(alpha, 'a1');
  mates(core, [{ id: 'mate-chief', name: 'Chief', lead: true }]);
  // The merge card is the proxy's, in the core's shape (queue/mod.rs `OwnerAsk::Merge`), as leader-tasks-990.spec.ts makes it.
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    server.onMessage((m) => {
      if (typeof m !== 'string' || JSON.parse(m).event !== 'snapshot') return ws.send(m);
      const msg = JSON.parse(m);
      msg.owner_decisions = [...(msg.owner_decisions ?? []), { id: 'o-merge', session_id: '', scope: '', kind: 'owner', text: 'merge docs', choices: [], observed_at: Date.now() - 60_000, actionable: true, owner: { type: 'merge', task: 't5', title: 'docs', place: alpha, revision: 'c' } }];
      ws.send(JSON.stringify(msg));
    });
  });
  await openWindow(app, {}, core);
  const chief = await openSeat(app, core, 'Chief');
  const chip = app.locator('.shead [data-team-chip]');
  await expect(chip).toContainText('1 project · 1 needs you'); // the merge card alone
  await expect(chip).toHaveAttribute('data-needs', 'true');
  ask(core.home, chief); // the lead's own permission request, as a real Claude asks mid-turn
  // Ticket 1030: Chief is in front, so its ordinary request is on the card above its composer and Decisions leaves it
  // out. The chip says Decisions' number (inventory N012: it said 2 beside Decisions' 1).
  await expect(app.locator('.composer .deccard.docked')).toHaveAttribute('data-session', chief);
  await expect(chip).toHaveAccessibleName('1 project · 1 needs you');
  await app.locator('#icon-decisions').click();
  await expect(app.locator('.dw .dw-count')).toHaveText('1 waiting');
  // Behind another tab the request is in Decisions again: 2 there and on the Team icon.
  await app.locator(`button.row.wt2[data-menu-session="${a1.id}"]`).click(); // its tree row: the tab strip is the shown project's
  await expect(app.locator('.dw .dw-count')).toHaveText('2 waiting');
  await expect(app.getByRole('navigation', { name: 'Right bar' }).getByRole('button', { name: /^Team/ })).toHaveAccessibleName('Team · 2 needs you');
});

// Look 1117 v11 S3-7: in a project lead's tab its chip and Team view said 1 while the Decisions pane said "2 waiting": it
// counted a card filed in another place (Home's failed run). A lead's pane is about its own place, as its chip is.
test('lead_decisions_own_place (v11 S3-7): in a project lead\'s tab the Decisions pane counts and shows only the cards filed in its place', async ({ app, core }) => {
  const harbor = core.project('harbor');
  const quay = core.project('quay');
  core.shell(harbor, 'h1');
  core.shell(quay, 'q1');
  mates(core, [
    { id: 'mate-chief', name: 'Chief', lead: true },
    { id: 'lead-main', name: 'Main', project: harbor, lead: true },
  ]);
  const card = (id: string, place: string) => ({ id, session_id: '', scope: '', kind: 'owner', text: `merge ${id}`, choices: [], observed_at: Date.now() - 60_000, actionable: true, owner: { type: 'merge', task: id, title: id, place, revision: 'c' } });
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    server.onMessage((m) => {
      if (typeof m !== 'string' || JSON.parse(m).event !== 'snapshot') return ws.send(m);
      const msg = JSON.parse(m);
      msg.owner_decisions = [...(msg.owner_decisions ?? []), card('o-harbor', harbor), card('o-quay', quay)];
      ws.send(JSON.stringify(msg));
    });
  });
  await openWindow(app, {}, core);
  await openSeat(app, core, 'Main');
  await app.locator('#icon-decisions').click();
  await expect(app.locator('.dw .dw-count')).toHaveText('1 waiting');
  await expect(app.locator('.dw .mcard')).toHaveCount(1);
  await expect(app.locator('.dw .mcard[data-item="o-harbor"]')).toBeVisible();
});

test('home_widths (look 1117 v3 N3): a project row keeps its name whole on one line, the counts on a second line and nothing past the row, at 250, 384 and 564 px and in the wide tab', async ({ app, core }) => {
  const shop = core.project('demo-shop');
  const long = core.project('a-rather-long-project-name-for-one-row');
  const perm = core.agent(shop, 'perm-1', 'never');
  core.shell(long, 'sh');
  mates(core, [
    { id: 'mate-chief', name: 'Chief', lead: true },
    { id: 'lead-long', name: 'Main', project: long, lead: true },
  ]);
  await openWindow(app, {}, core);
  await openSeat(app, core, 'Chief');
  ask(core.home, perm.id);
  const view = await openTeam(app);
  const rows = view.locator('[data-part="projects"] .home-prow');
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toHaveAttribute('data-word', 'needs');
  const check = async (where: string) => {
    for (const row of await rows.all()) {
      const m = await row.evaluate((r) => {
        const box = r.getBoundingClientRect();
        const name = r.querySelector<HTMLElement>('.home-pname')!;
        const who = r.querySelector<HTMLElement>('.lead-who')!;
        const nb = name.getBoundingClientRect();
        const wb = who.getBoundingClientRect();
        const line = parseFloat(getComputedStyle(name).lineHeight) || 18;
        return {
          text: name.textContent,
          oneLine: nb.height <= line * 1.3,
          whole: name.scrollWidth <= name.clientWidth,
          below: wb.top >= nb.bottom - 1,
          whoWide: wb.width,
          inside: [...r.querySelectorAll<HTMLElement>('*')].every((e) => !e.getClientRects().length || e.getBoundingClientRect().right <= box.right + 0.5),
        };
      });
      expect(m.oneLine, `${where}: ${m.text} on one line`).toBe(true);
      if (m.text === 'demo-shop') expect(m.whole, `${where}: demo-shop is not cut`).toBe(true);
      expect(m.below, `${where}: the counts are on the second line`).toBe(true);
      expect(m.whoWide, `${where}: the counts have room`).toBeGreaterThan(60);
      expect(m.inside, `${where}: nothing past the row`).toBe(true);
    }
  };
  for (const w of [250, 384, 564]) {
    await view.evaluate((e: HTMLElement, px) => (e.style.width = `${px}px`), w);
    await check(`${w} px`);
  }
  await view.evaluate((e: HTMLElement) => (e.style.width = ''));
  await view.getByRole('button', { name: 'Open as a tab' }).click();
  const tab = app.locator('.teamv[data-where="tab"]');
  await expect(tab).toHaveAttribute('data-wide', 'true');
  const part = tab.locator('[data-part="projects"]');
  expect((await part.boundingBox())!.width).toBeGreaterThanOrEqual(340);
  const wide = part.locator('.home-prow');
  await expect(wide).toHaveCount(2);
  for (const row of await wide.all()) {
    const name = row.locator('.home-pname');
    expect(await name.evaluate((n) => n.getBoundingClientRect().height <= (parseFloat(getComputedStyle(n).lineHeight) || 18) * 1.3)).toBe(true);
  }
  expect(await wide.first().locator('.home-pname').evaluate((n) => n.scrollWidth <= n.clientWidth)).toBe(true);
});

test('home_s3 (look 1117 v3 item 4): the wide Home tab has no worktree legend and a Room heading; the empty Home room says it is Home\'s; the placeholder is short; the resting line has no branch icon; Home offers no worktree', async ({ app, core }) => {
  mates(core, [
    { id: 'mate-chief', name: 'Chief', lead: true },
    { id: 'mate-inbox', name: 'Inbox' },
  ]);
  await openWindow(app, {}, core);
  const rest = app.locator('.tree .home-grp .home-rest .row');
  await expect(rest).toHaveAccessibleName('1 resting');
  await expect(rest.locator('svg[data-icon="new"]')).toHaveCount(0); // the tree's branch icon
  await openSeat(app, core, 'Chief');
  // The New session popover in Home: no "Current checkout / New worktree" choice.
  await expect(app.locator('.shead')).toContainText('Chief'); // the Home lead's tab is in front
  await app.getByRole('button', { name: 'New session' }).first().click();
  await expect(app.locator('.nt-in').first()).toContainText('Assistants');
  await expect(app.locator('.nt-place')).toHaveCount(0);
  await app.keyboard.press('Escape');
  const view = await openTeam(app);
  await view.getByRole('tab', { name: /Room/ }).click();
  await expect(view.locator('.room-chatempty')).toContainText('The Assistants room');
  const input = view.getByRole('textbox', { name: /./ }).last();
  await expect(input).toHaveAttribute('placeholder', 'Message to Chief');
  await expect(input).toHaveAttribute('title', 'Message (goes to the lead unless you pick another agent)');
  await view.getByRole('button', { name: 'Open as a tab' }).click();
  const tab = app.locator('.teamv[data-where="tab"]');
  await expect(tab).toHaveAttribute('data-wide', 'true');
  await expect(tab.locator('.teamv-head')).not.toContainText('Colour bar');
  await expect(tab.locator('.teamv-room .lead-gh')).toHaveText('Room');
  // Look 1117 v4 (home S3): the heading is drawn, not covered by the room under it.
  const gh = tab.locator('.teamv-room .lead-gh');
  const ghBox = (await gh.boundingBox())!;
  expect(await app.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest('.lead-gh') !== null, [ghBox.x + 4, ghBox.y + ghBox.height / 2])).toBe(true);
  // N3 (look 1117 v4 home): with a right panel open the Room column keeps its width: nothing of it is cut, Send included.
  await app.getByRole('navigation', { name: 'Right bar' }).getByRole('button', { name: 'Decisions' }).click();
  for (const vw of [1440, 1280, 1100]) {
    await app.setViewportSize({ width: vw, height: 900 });
    // Narrower than the wide layout, the parts are tabs: the Room is one press away.
    await app.waitForTimeout(300);
    if (!(await tab.getAttribute('data-wide'))) await tab.getByRole('tab', { name: /Room/ }).click();
    const roomCol = tab.locator('.teamv-room');
    const send = tab.locator('.room-composer button').last();
    await expect(send).toBeVisible();
    const [r, b] = [(await roomCol.boundingBox())!, (await send.boundingBox())!];
    const body = (await tab.locator('.teamv-body').boundingBox())!;
    expect(r.x + r.width, `${vw}: room inside the tab`).toBeLessThanOrEqual(body.x + body.width + 1);
    expect(b.x + b.width, `${vw}: Send inside the room`).toBeLessThanOrEqual(r.x + r.width + 1);
    expect(await send.evaluate((e) => e.scrollWidth <= e.clientWidth + 1), `${vw}: Send's word whole`).toBe(true);
  }
});

test('home_core_lines (look 1117 v3 item 6): a line the core writes in the Home room, a worker\'s "done", carries the app as its origin, not the assistant', async ({ app, core }) => {
  tokenClaude(core);
  mates(core, [
    { id: 'mate-chief', name: 'Chief', lead: true },
    { id: 'mate-inbox', name: 'Inbox' },
  ]);
  await openWindow(app, {}, core);
  const chief = await openSeat(app, core, 'Chief');
  const token = await tokenOf(core, chief);
  nunchiroAs(core, token, 'team', 'open', 'Inbox');
  let inbox = '';
  await expect.poll(() => (inbox = sessions(core).find((s) => s.teammate === 'mate-inbox' && s.state === 'running')?.id ?? '')).not.toBe('');
  // v4 N7: the first turn answers the brief and wakes nobody; the job's turn is the one the core tells the lead about.
  for (const event of ['UserPromptSubmit', 'Stop', 'UserPromptSubmit', 'Stop'] as const) core.hook(inbox, event);
  const view = await openTeam(app);
  await view.getByRole('tab', { name: /Room/ }).click();
  // Ticket 1054: a turn end with no new REPORT.md is "ended a turn (no report yet)", never the bare "done".
  const line = view.locator('.room-chat .room-line', { hasText: 'worker Inbox ended a turn (no report yet)' });
  await expect(line.locator('.room-line-head b')).toHaveText('Nunchiro app');
  await expect(line.locator('.room-line-head [data-origin]')).toHaveCount(1); // the name only, no "Assistant" role
});

test('home_room_end (look 1117 home S3): the Home room opens at its newest line when its tab is first shown, and each line\'s head is one line', async ({ app, core }) => {
  mates(core, [{ id: 'mate-chief', name: 'Chief', lead: true }]);
  await openWindow(app, {}, core);
  const chief = await openSeat(app, core, 'Chief');
  const home = fs.realpathSync(path.join(core.home, 'team', 'home'));
  for (let i = 1; i <= 30; i++) {
    const r = owner(core, { op: 'room_send', project: home, to: chief, body: `line ${i}: what the user asked the Home lead to do next` });
    expect(r.Err, JSON.stringify(r)).toBeUndefined();
  }
  const view = await openTeam(app); // opens on Projects: the room is drawn hidden
  await view.getByRole('tab', { name: /Room/ }).click();
  const chat = view.locator('.room-chat');
  await expect(chat.locator('.room-line', { hasText: 'line 30:' })).toBeVisible();
  await expect.poll(() => chat.evaluate((e) => e.scrollHeight - e.scrollTop - e.clientHeight)).toBeLessThan(40);
  const heads = await chat.locator('.room-line-head').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height / (parseFloat(getComputedStyle(e).lineHeight) || 18)));
  expect(Math.max(...heads)).toBeLessThan(1.5);
});

// N6 (look 1117 v4 home): after a relaunch with the Team tab in front, the right bar had no Team icon.
test('team_icon_after_reload_with_team_tab (N6)', async ({ app, core }) => {
  mates(core, [
    { id: 'mate-chief', name: 'Chief', lead: true },
    { id: 'mate-inbox', name: 'Inbox' },
  ]);
  await openWindow(app, {}, core);
  await openSeat(app, core, 'Chief');
  const view = await openTeam(app);
  await view.getByRole('button', { name: 'Open as a tab' }).click();
  await expect(app.locator('.teamv[data-where="tab"]')).toBeVisible();
  const teamIcon = app.getByRole('navigation', { name: 'Right bar' }).getByRole('button', { name: 'Team' });
  await expect(teamIcon).toBeVisible();
  await app.reload();
  await expect(app.locator('.teamv[data-where="tab"]')).toBeVisible();
  await expect(teamIcon).toBeVisible();
});

// Look 1117 v12 (Home S2-2): after a quit and reopen with the Team widget open on Projects, the part stayed blank (2 min)
// until a click on Assistants and back. Its first digest read was lost to a dropped connection, and only a tick read it
// again: none comes in a window behind others (hidden). The socket opening reads it again.
test('home_projects_after_reopen (v12 Home S2-2): the Team widget reopened on Projects shows its rows though its first read was lost', async ({ app, core }) => {
  mates(core, [
    { id: 'mate-chief', name: 'Chief', lead: true },
    { id: 'mate-inbox', name: 'Inbox' },
  ]);
  const harbor = core.project('harbor');
  core.shell(harbor, 'sh');
  await openWindow(app, {}, core);
  await openSeat(app, core, 'Chief');
  const view = await openTeam(app);
  const row = view.locator(`[data-part="projects"] .home-prow[data-project="${harbor}"]`);
  await expect(row).toBeVisible();
  let dropped = false;
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => {
      const f = typeof m === 'string' ? JSON.parse(m) : null;
      if (!dropped && f?.request?.op === 'task' && f.request.operation === 'digest') return void ((dropped = true), ws.close(), server.close());
      server.send(m);
    });
    server.onMessage((m) => ws.send(m));
  });
  await app.addInitScript(() => Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }));
  await app.reload();
  await expect(view.getByRole('tab', { name: 'Projects' })).toHaveAttribute('aria-selected', 'true');
  await expect.poll(() => dropped).toBe(true);
  await expect(row).toBeVisible();
});

// Look 1117 v13 (Home S2): with something waiting, the reopened part stayed blank 14-18 s (1.5 s with nothing waiting): the
// bigger connect burst made the core refuse the digest read past its in-flight cap, and only the 15 s tick read again.
test('home_projects_after_reopen_needs_you (v13 Home S2): a digest read refused while the window connects is read again within seconds, and the waiting row shows', async ({ app, core }) => {
  tokenClaude(core);
  const harbor = core.project('harbor');
  core.shell(harbor, 'sh');
  mates(core, [
    { id: 'mate-chief', name: 'Chief', lead: true },
    { id: 'lead-main', name: 'Main', project: harbor, lead: true },
  ]);
  await openWindow(app, {}, core);
  const chief = await openSeat(app, core, 'Chief');
  asSeat(core, await tokenOf(core, chief), 'task', 'goal', 'Ship it', '--project', harbor, '--json');
  const view = await openTeam(app);
  const row = view.locator(`[data-part="projects"] .home-prow[data-project="${harbor}"]`);
  await expect(row).toHaveAttribute('data-word', 'needs');
  // Every digest read in the first 1.5 s after the reload is refused as the core refuses one past MAX_JOBS.
  let until = 0;
  let refused = 0;
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => {
      const f = typeof m === 'string' ? JSON.parse(m) : null;
      if (f?.request?.op === 'task' && f.request.operation === 'digest' && Date.now() < (until ||= Date.now() + 1500)) return void (refused++, ws.send(JSON.stringify({ id: f.id, response: { Err: 'too many requests in flight; try again' } })));
      server.send(m);
    });
    server.onMessage((m) => ws.send(m));
  });
  await app.addInitScript(() => Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }));
  await app.reload();
  await expect.poll(() => refused).toBeGreaterThan(0);
  await expect(row).toHaveAttribute('data-word', 'needs', { timeout: 6000 });
  await expect(row.locator('.lead-answer')).toHaveText('Answer');
});

// Home N-B (look 1117 v4f): after a core restart a needs-you row kept an Answer button for a decision that no longer
// existed, and pressing it did nothing. The button follows the decision's existence, not the count.
test('home_answer_only_for_a_decision_that_exists (N-B)', async ({ app, core }) => {
  mates(core, [
    { id: 'mate-chief', name: 'Chief', lead: true },
    { id: 'mate-inbox', name: 'Inbox' },
  ]);
  const harbor = core.project('harbor');
  core.shell(harbor, 'sh');
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => {
      const f = typeof m === 'string' ? JSON.parse(m) : null;
      if (f?.request?.op === 'task' && f.request.operation === 'digest')
        return ws.send(JSON.stringify({ id: f.id, response: { Ok: { type: 'digest', projects: [{ project: harbor, open: 0, needs: 1, oldest: 'gone-74010b2d', working: 0, at: Date.now(), line: '', merged: 0, decisions: 0 }] } } }));
      server.send(m);
    });
    server.onMessage((m) => ws.send(m));
  });
  await openWindow(app, {}, core);
  await openSeat(app, core, 'Chief');
  const view = await openTeam(app);
  await view.getByRole('tab', { name: /Projects/ }).click();
  const row = view.locator('.home-prow[data-project]').first();
  await expect(row).toBeVisible();
  await expect(row.getByRole('button', { name: 'Answer' })).toHaveCount(0);
});

// Look 1117 v5 (Home H-2): a project whose lead's seat failed read "0 tasks · Lead" under Quiet while the tree showed the
// seat failed. The user must act, so the row is under Needs you and says the lead failed first.
test('home_failed_lead_needs_you (H-2, v11 S2-1): a failed lead is its own group, uncounted; Needs you lists exactly its counted items', async ({ app, core }) => {
  const harbor = core.project('harbor');
  mates(core, [
    { id: 'mate-chief', name: 'Chief', lead: true },
    { id: 'lead-harbor', name: 'Lead', project: harbor, lead: true },
  ]);
  const seat = core.shell(harbor, 'lead-seat');
  const free = core.shell(core.project('free'), 'free-1'); // a place with no lead: in front of it the side view is Home's
  let failed = false;
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => {
      const f = typeof m === 'string' ? JSON.parse(m) : null;
      if (f?.request?.op === 'task' && f.request.operation === 'digest')
        return ws.send(JSON.stringify({ id: f.id, response: { Ok: { type: 'digest', projects: [{ project: harbor, lead: 'lead-harbor', open: 0, needs: 0, working: 0, at: Date.now(), line: '', merged: 0, decisions: 0 }] } } }));
      // Look v11 Home S3-4: the lead's seat cannot open (as with its folder gone).
      if (f?.request?.op === 'team_open' && f.request.id === 'lead-harbor') return ws.send(JSON.stringify({ id: f.id, response: { Err: 'project is not a directory' } }));
      server.send(m);
    });
    // The lead's seat as the tree got it: failed.
    server.onMessage((m) => {
      if (!failed || typeof m !== 'string' || !m.includes('"event":"snapshot"')) return ws.send(m);
      const v = JSON.parse(m);
      for (const s of v.sessions ?? []) if (s.id === seat.id) Object.assign(s, { teammate: 'lead-harbor', state: 'failed' });
      ws.send(JSON.stringify(v));
    });
  });
  await openWindow(app, {}, core);
  const chief = await openSeat(app, core, 'Chief');
  failed = true;
  // The proxy rewrites snapshots from here on: a new session makes the core send one (under load the last snapshot of
  // Chief's start had passed before the flag, and the row stayed quiet).
  core.shell(harbor, 'nudge');
  const view = await openTeam(app);
  await view.getByRole('tab', { name: /Projects/ }).click();
  const row = view.locator(`.home-prow[data-project="${harbor}"]`);
  await expect(row).toHaveAttribute('data-word', 'broken');
  await expect(row.locator('.lead-who')).toHaveText(/^Lead failed · 0 tasks/);
  // Look v11 Home S2-1: the failed lead is no decision, so it is not counted (v10 S2-1) and not under Needs you: its own
  // group. Under "Needs you · N" are exactly the N counted items: here the Home lead's own question, with its Answer.
  const projects = view.locator('[data-part="projects"]');
  await expect(projects.locator('[data-group="broken"] .lead-gh')).toHaveText("Lead can't start · 1");
  await expect(projects.locator('[data-group="needs"]')).toHaveCount(0);
  ask(core.home, chief);
  const needs = projects.locator('[data-group="needs"]');
  // Ticket 1030: with Chief in front its ordinary request is on the card above its composer; the Home view and the chip
  // leave it out, as Decisions does (inventory N012).
  await expect(app.locator('.composer .deccard.docked')).toHaveAttribute('data-session', chief);
  await expect(needs).toHaveCount(0);
  await expect(app.locator('.shead [data-team-chip]')).not.toContainText('needs you');
  // Behind another tab it is counted, and listed with its Answer.
  await app.locator(`button.row.wt2[data-menu-session="${free.id}"]`).click(); // its tree row: the tab strip is the shown project's
  await expect(needs.locator('.lead-gh')).toHaveText('Needs you · 1');
  await expect(app.getByRole('navigation', { name: 'Right bar' }).getByRole('button', { name: /^Team/ })).toHaveAccessibleName('Team · 1 needs you');
  await expect(needs.locator('.lead-row')).toHaveCount(1);
  await expect(needs.locator('.lead-row .home-pname')).toHaveText('Chief');
  await expect(needs.locator('.lead-row .lead-answer')).toHaveText('Answer');
  await expect(projects.locator(`[data-group="broken"] .home-prow[data-project="${harbor}"]`)).toHaveCount(1);
  // Look v11 Home S3-4: a press opens the failed seat (which says why), not nothing.
  await row.locator('.lead-go').click();
  await expect(app.locator(`.tab[data-tab="${seat.id}"]`)).toHaveAttribute('aria-selected', 'true');
});

// Look 1117 v5 (Home H-3): with no Home seat open (after a restart) the Home room's box said "No agent is open in this
// project…"; Home is no project. It says Home's own sentence.
test('home_room_no_lead_is_homes (H-3)', async ({ app, core }) => {
  mates(core, [{ id: 'mate-chief', name: 'Chief', lead: true }]);
  await openWindow(app, {}, core);
  const seat = await openSeat(app, core, 'Chief');
  const view = await openTeam(app);
  await view.getByRole('tab', { name: /Room/ }).click();
  const input = view.getByRole('textbox', { name: /./ }).last();
  await expect(input).toHaveAttribute('placeholder', 'Message to Chief');
  core.cli('session', 'close', seat);
  await expect(input).toHaveAttribute('placeholder', 'No assistant is open, so there is no one to message.');
});

// Look v10 Home S3-11: an idle lead's avatar read as a red "L" (its identity hue was the syntax red, the colour of broken).
// No identity hue is a state's colour: red broken, orange your turn, blue working (ticket 995 S3: hue 1 was --run).
test('avatar_hues_no_state_colour (v10 Home S3-11): the six identity hues are never the broken red, the your-turn orange or the working blue', async ({ app }) => {
  await openWindow(app);
  const seen = await app.evaluate(() => {
    const read = (el: Element, v: string) => getComputedStyle(el).getPropertyValue(v).trim().toLowerCase();
    const out: { hue: string; c: string; bad: string; warn: string; run: string }[] = [];
    for (let n = 1; n <= 6; n++) {
      const el = document.createElement('i');
      el.className = 'lead-av';
      el.dataset.c = String(n);
      document.body.append(el);
      out.push({ hue: String(n), c: read(el, '--c'), bad: read(el, '--bad'), warn: read(el, '--warn'), run: read(el, '--run') });
      el.remove();
    }
    return out;
  });
  for (const h of seen) {
    expect(h.c, `hue ${h.hue}`).not.toBe('');
    expect([h.bad, h.warn, h.run], `hue ${h.hue}`).not.toContain(h.c);
  }
});
