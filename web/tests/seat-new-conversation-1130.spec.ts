// Ticket 1130 B-L3 (C5, owner 11-25 option A; mockup docs/design/first-use-b-1130/mockup.html, panels "Shared by A and B"
// and "Option A"): "New conversation" in the header of every teammate's seat. One press stops a running turn and opens a
// new conversation for the same teammate at once; the old one is in History and a toast offers Undo for 10 s. A real core
// with real seats (team.json as the core keeps it, seats opened through the window's own team_open); the window's team_open
// requests are recorded on their way. The core's side (handover between turns, the kept or dropped new seat) is in
// crates/nunchiro-core/src/team.rs. Shots go to .scratch/shots (SHOT_TAG=before on the old code).
import type { Page } from '@playwright/test';
import { expect, openWindow, test } from './fixtures';
import fs from 'node:fs';
import { agentsToml, fakeAcp, ownerOk, tomlEntry } from './acp-fakes';
import { mates, openSeat, sessions, tokenClaude } from './leader-990';

type Asked = { id: string; fresh?: string; undo?: string; seat?: string };
const tag = process.env.SHOT_TAG ?? 'after';
const shot = (app: Page, name: string) => app.screenshot({ path: `../.scratch/shots/1130-bl3-${name}-${tag}.png` });
const button = (app: Page) => app.locator('.shead').getByRole('button', { name: 'New conversation', exact: true });
const toast = (app: Page) => app.locator('.fresh-toast');
/** The window's fresh and undo team_open requests, as they went to the core. */
async function record(app: Page) {
  const asked: Asked[] = [];
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => {
      const r = typeof m === 'string' ? JSON.parse(m).request : null;
      if (r?.op === 'team_open' && (r.fresh || r.undo)) asked.push({ id: r.id, fresh: r.fresh, undo: r.undo, seat: r.seat });
      server.send(m);
    });
    server.onMessage((raw) => ws.send(raw));
  });
  return asked;
}
type Row = ReturnType<typeof sessions>[number] & { model?: string; effort?: string; level?: string; resumed_from?: string[]; agent_session_id?: string };
const rows = (core: Parameters<typeof sessions>[0]) => sessions(core) as Row[];
/** What "the same teammate" keeps: name, folder, agent, model, effort and level. */
const same = (s: Row) => ({ label: s.label, project: s.project, cwd: s.cwd, kind: s.kind, model: s.model, effort: s.effort, level: s.level, teammate: s.teammate });
const seatOf = (core: Parameters<typeof sessions>[0], mate: string, not: string[] = []) => rows(core).find((s) => s.teammate === mate && s.state === 'running' && !not.includes(s.id));

test('seat_new_conversation_one_press (1130 B-L3, T12 in 1 step): on a stuck Lead one press stops the turn and opens a new conversation for the same teammate; the old one is in History and Undo opens it again', async ({ app, core }) => {
  tokenClaude(core);
  const project = core.project('my-app');
  mates(core, [{ id: 'lead-1', name: 'Lead', project, lead: true }]);
  core.shell(project, 'alpha');
  const asked = await record(app);
  await openWindow(app, {}, core);
  await expect(button(app)).toHaveCount(0); // a session that is no teammate's seat has no such button
  const old = await openSeat(app, core, 'Lead');
  // One finished turn (a conversation that can be continued), then a turn that never ends: the stuck Lead.
  core.hook(old, 'UserPromptSubmit');
  core.hook(old, 'Stop');
  core.hook(old, 'UserPromptSubmit');
  await app.locator('.toast').getByRole('button', { name: 'Dismiss' }).click(); // Settings > Team's "Lead started" line
  await button(app).hover();
  await expect(app.getByRole('tooltip')).toHaveText('Stops this turn · opens a new conversation with Lead');
  await shot(app, 'stuck');
  const before = rows(core).find((s) => s.id === old)!;

  await button(app).click(); // the one step of T12
  await expect.poll(() => seatOf(core, 'lead-1', [old])?.id ?? '').not.toBe('');
  const next = seatOf(core, 'lead-1', [old])!;
  expect(asked).toEqual([{ id: 'lead-1', fresh: 'now' }]);
  expect(same(next)).toEqual(same(before));
  // The new conversation shows in the old one's tab, ready to type in.
  await expect(app.locator(`.tab[data-tab="${next.id}"]`)).toHaveAttribute('aria-selected', 'true');
  await expect(app.locator(`.tab[data-tab="${old}"]`)).toHaveCount(0);
  await expect(app.locator('.cbox textarea')).toBeFocused();
  await expect(app.locator('.cscroll .empty')).toContainText('New conversation with Lead. Same role, folder, model, effort and mode.');
  await expect(app.getByRole('dialog')).toHaveCount(0); // no sheet, nothing to wait for
  // The old conversation: stopped, its row and conversation kept (History lists it, with Continue).
  expect(rows(core).find((s) => s.id === old)).toMatchObject({ state: 'closed', agent_session_id: before.agent_session_id });
  await expect(toast(app)).toHaveText(/^The old conversation is in History\.\s*Undo\s*10 s$/);
  await expect(toast(app)).toHaveAttribute('role', 'status');
  await expect(app.locator('.undoline')).toHaveCount(0); // one offer, not a second one in the status line
  await shot(app, 'new');

  // Undo: the old conversation is the seat again; the new one stays in History, closed (an Undo deletes nothing).
  await toast(app).getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(() => seatOf(core, 'lead-1', [next.id])?.resumed_from ?? []).toContain(old);
  const back = seatOf(core, 'lead-1', [next.id])!;
  expect(asked[1]).toEqual({ id: 'lead-1', undo: old, seat: next.id });
  expect(back.agent_session_id).toBe(before.agent_session_id);
  expect(rows(core).find((s) => s.id === next.id)).toMatchObject({ state: 'closed' });
  await expect(app.locator(`.tab[data-tab="${back.id}"]`)).toHaveAttribute('aria-selected', 'true');
  await expect(toast(app)).toHaveCount(0);
  expect(asked).toHaveLength(2);
});

test('seat_new_conversation_every_seat (1130 B-L3): a Lead, an assistant and a teammate each have the button; a teammate between turns gets its new conversation with no sheet', async ({ app, core }) => {
  tokenClaude(core);
  const project = core.project('my-app');
  mates(core, [
    { id: 'lead-1', name: 'Lead', project, lead: true },
    { id: 'chief-1', name: 'Chief' }, // an assistant: no project, it works in Home
    { id: 'rev-1', name: 'Reviewer', project },
  ]);
  core.shell(project, 'alpha');
  const asked = await record(app);
  await openWindow(app, {}, core);
  for (const name of ['Lead', 'Chief', 'Reviewer']) {
    await openSeat(app, core, name);
    await expect(app.locator('.shead > b')).toHaveText(name);
    await expect(button(app)).toHaveCount(1);
    await app.locator('.shead').screenshot({ path: `../.scratch/shots/1130-bl3-head-${name.toLowerCase()}-${tag}.png` });
  }
  // The Reviewer's seat is shown and between turns: no handover (it leads nothing), no sheet.
  const old = seatOf(core, 'rev-1')!;
  await expect(button(app)).toHaveAttribute('data-tip', 'Opens a new conversation with Reviewer');
  await button(app).click();
  await expect.poll(() => seatOf(core, 'rev-1', [old.id])?.id ?? '').not.toBe('');
  expect(asked).toEqual([{ id: 'rev-1', fresh: 'now' }]);
  expect(same(seatOf(core, 'rev-1', [old.id])!)).toEqual(same(old));
  await expect(app.getByRole('dialog')).toHaveCount(0);
  await expect(toast(app)).toContainText('The old conversation is in History.');
  // The other seats are untouched.
  expect(seatOf(core, 'lead-1')).toBeTruthy();
  expect(seatOf(core, 'chief-1')).toBeTruthy();
});

test('seat_new_conversation_undo_brings_the_draft_back (1130 B-L3 round 3): words left unsent in the old conversation are in its composer again after Undo', async ({ app, core }) => {
  tokenClaude(core);
  const project = core.project('my-app');
  mates(core, [{ id: 'lead-1', name: 'Lead', project, lead: true }]);
  core.shell(project, 'alpha');
  await record(app);
  await openWindow(app, {}, core);
  const old = await openSeat(app, core, 'Lead');
  core.hook(old, 'UserPromptSubmit');
  core.hook(old, 'Stop');
  core.hook(old, 'UserPromptSubmit');
  const box = app.locator('.cbox textarea');
  await box.fill('unsent words for the old conversation');
  await button(app).click();
  await expect.poll(() => seatOf(core, 'lead-1', [old])?.id ?? '').not.toBe('');
  const next = seatOf(core, 'lead-1', [old])!;
  await expect(box).toHaveAttribute('data-draft-for', next.id);
  await expect(box).toHaveValue(''); // the new conversation starts with an empty box
  await toast(app).getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(() => seatOf(core, 'lead-1', [next.id])?.resumed_from ?? []).toContain(old);
  const back = seatOf(core, 'lead-1', [next.id])!;
  await expect(box).toHaveAttribute('data-draft-for', back.id);
  await expect(box).toHaveValue('unsent words for the old conversation');
});

test('seat_new_conversation_undo_spares_newer_words (1130 B-L3 round 4): words typed into the restored conversation before the Undo reply came are not overwritten by the old draft', async ({ app, core }) => {
  tokenClaude(core);
  const project = core.project('my-app');
  mates(core, [{ id: 'lead-1', name: 'Lead', project, lead: true }]);
  core.shell(project, 'alpha');
  // The Undo's reply is held back, as on a slow link: the restored seat shows from the core's snapshot first.
  let undoId: unknown;
  let release = () => {};
  const held = new Promise<void>((r) => (release = r));
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => {
      const r = typeof m === 'string' ? JSON.parse(m) : null;
      if (r?.request?.op === 'team_open' && r.request.undo) undoId = r.id;
      server.send(m);
    });
    server.onMessage((raw) => {
      const r = typeof raw === 'string' ? JSON.parse(raw) : null;
      if (undoId !== undefined && r?.id === undoId && r.response) void held.then(() => ws.send(raw));
      else ws.send(raw);
    });
  });
  await openWindow(app, {}, core);
  const old = await openSeat(app, core, 'Lead');
  core.hook(old, 'UserPromptSubmit');
  core.hook(old, 'Stop');
  core.hook(old, 'UserPromptSubmit');
  const box = app.locator('.cbox textarea');
  await box.fill('old unsent words');
  await button(app).click();
  await expect.poll(() => seatOf(core, 'lead-1', [old])?.id ?? '').not.toBe('');
  const next = seatOf(core, 'lead-1', [old])!;
  await expect(box).toHaveAttribute('data-draft-for', next.id);
  await toast(app).getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(() => seatOf(core, 'lead-1', [next.id])?.resumed_from ?? []).toContain(old);
  const back = seatOf(core, 'lead-1', [next.id])!;
  await expect(box).toHaveAttribute('data-draft-for', back.id); // the tab followed the restored seat already
  await box.fill('newer words');
  release();
  const saved = () => app.evaluate((id) => (JSON.parse(localStorage.getItem('nunchiro.composer.drafts.v1') ?? '{}') as Record<string, string>)[id], back.id);
  await expect.poll(saved).toBe('newer words');
  await app.waitForTimeout(600); // past the draft store's debounced write: still the newer words
  expect(await saved()).toBe('newer words');
  await expect(box).toHaveValue('newer words');
});

test('seat_new_conversation_not_offered_without_a_conversation (1130 B-L3 round 6): a seat whose agent cannot continue a conversation shows the button unavailable, with the reason, and a press sends nothing', async ({ app, core }) => {
  // Two ACP agents: "plain" cannot load a conversation again (no loadSession, so no conversation id), "loader" can.
  for (const [name, modes] of [['plain', []], ['loader', ['load']]] as const) {
    fs.appendFileSync(agentsToml(core), tomlEntry(name, fakeAcp(core, name, `${name} 0.9.1`, [...modes])));
    ownerOk(core, { op: 'acp_agent_grant', name, hash: ownerOk(core, { op: 'acp_agent_status', name }).view.hash });
  }
  const project = core.project('my-app');
  mates(core, [
    { id: 'plain-1', name: 'Scout', kind: 'acp', agent: 'plain', project } as never,
    { id: 'loader-1', name: 'Keeper', kind: 'acp', agent: 'loader', project } as never,
  ]);
  core.shell(project, 'alpha');
  const asked = await record(app);
  await openWindow(app, {}, core);
  const scout = await openSeat(app, core, 'Scout');
  await expect(app.locator('.shead > b')).toHaveText('Scout');
  await expect(button(app)).toHaveAttribute('aria-disabled', 'true');
  await button(app).hover();
  await expect(app.getByRole('tooltip')).toHaveText('This agent cannot continue an old conversation, so a new one would lose this one.');
  await app.locator('.shead').screenshot({ path: `../.scratch/shots/1130-bl3-head-unavailable-${tag}.png` });
  await button(app).click({ force: true }); // Playwright waits on an aria-disabled control; a person can still press it
  await button(app).press('Enter');
  await app.waitForTimeout(500);
  expect(asked).toEqual([]);
  expect(seatOf(core, 'plain-1')?.id).toBe(scout);
  await expect(toast(app)).toHaveCount(0);
  // An agent that can load its conversation again is offered the press as before.
  const keeper = await openSeat(app, core, 'Keeper');
  await expect(app.locator('.shead > b')).toHaveText('Keeper');
  await expect.poll(() => rows(core).find((s) => s.id === keeper)?.agent_session_id ?? '').not.toBe('');
  await expect(button(app)).not.toHaveAttribute('aria-disabled', 'true');
  await button(app).click();
  await expect.poll(() => seatOf(core, 'loader-1', [keeper])?.id ?? '').not.toBe('');
  expect(asked).toEqual([{ id: 'loader-1', fresh: 'now' }]);
});
