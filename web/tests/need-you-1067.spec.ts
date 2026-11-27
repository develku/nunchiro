// Ticket 1067 (mockup 1): with a lead, a seat's asks are one "N need you" pill on the lead's row; the seat's own row and
// the project head leave them out, a failed seat shows red, and a project without a lead is as before. Pure, node side.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { buildTree, rowState, summary, withoutSeatAsks } from '../src/tree';
import { urgentQueue } from '../src/tree/strip';
import { NeedYou, needTip, teamOpen } from '../src/tree/RowIcon';
import { teamWaiting, waitingItems } from '../src/tree/decisions';
import { onShowTeamTab, type TeamAt } from '../src/lead/team';
import type { Team } from '../src/lead/lead';
import type { Decision, Session } from '../src/types';
import { makeT } from './i18n-tables';

const t = makeT('en', 'en');
const P = '/p';
const TEAM: Team = { home: '/home', teammates: [{ id: 'm-lead', name: 'Lead', job: '', kind: 'claude', project: P, lead: true }] };
let n = 0;
const session = (over: Omit<Partial<Session>, 'attention'> & { attention?: Partial<Session['attention']> } = {}): Session =>
  ({ id: `s${++n}`, kind: 'claude', project: P, cwd: `${P}/wt${n}`, label: '', state: 'running', agent_version: null, untested: false, pid: 1, pending: [], ...over, attention: { working: false, waiting: false, stale: false, failed: false, last_activity: 0, ...over.attention } }) as Session;
const ask = (s: Session, at = 1): Decision => ({ id: `d${s.id}`, session_id: s.id, kind: 'permission', text: JSON.stringify({ command: 'npm test' }), observed_at: at, choices: [] }) as unknown as Decision;
const asking = (over: Parameters<typeof session>[0] = {}) => {
  const s = session(over);
  s.pending = [ask(s)];
  return s;
};
const row = (s: Session) => rowState({ path: s.cwd, name: 'x', sessions: [s] } as never, [s], undefined, 0, undefined, t);
const head = (sessions: Session[]) => buildTree(sessions, sessions.map((s) => s.id))[0].groups[0].counts;

test('seat_ask_moves_to_lead_pill: under a live lead a seat with a permission draws no hand; the pill says the Team view count', () => {
  const lead = session({ teammate: 'm-lead', cwd: P });
  const seat = asking({ label: 'Builder · ticket 1059', parent: lead.id });
  const all = [lead, seat];
  const { sessions: shown, hushed } = withoutSeatAsks(all, TEAM);
  expect(row(seat).kind, 'without the lead rule the seat is a hand (red on main for the pill)').toBe('hand');
  expect(row(shown[1]).kind).not.toBe('hand');
  expect(row(shown[1]).tone).not.toBe('you');
  // The head counts the item once: through the pill's count, not through the seat's row.
  expect(head(shown).waiting).toBe(0);
  expect(buildTree(shown, [], [], [], hushed)[0].groups[0].counts.waiting).toBe(1);
  const n = teamWaiting(all, [], P, false);
  expect(n).toBe(1);
  const html = renderToStaticMarkup(createElement(NeedYou, { t, n, tip: needTip(t, waitingItems(all, [])), onOpen: () => {} }));
  expect(html).toContain('1 need you');
  expect(html).toContain('Builder · ticket 1059: ');
  expect(renderToStaticMarkup(createElement(NeedYou, { t, n: 0, tip: '', onOpen: () => {} })), 'no pill at zero').toBe('');
});

test('pill_title_lists_five: the title names at most five items, oldest first', () => {
  const seats = Array.from({ length: 7 }, (_, i) => {
    const s = session({ label: `Builder ${i}`, teammate: `m${i}` });
    s.pending = [ask(s, 10 - i)];
    return s;
  });
  const lines = needTip(t, waitingItems(seats, [])).split('\n');
  expect(lines).toHaveLength(5);
  expect(lines[0]).toMatch(/^Builder 6: /);
});

test('pill_press_opens_team_view: the side view opens (then takes focus), or the tab of the place shows', () => {
  let put: TeamAt | null = null;
  expect(teamOpen({}, (x) => (put = x), P)).toBe(true);
  expect(put).toEqual({ open: true });
  const shownTabs: string[] = [];
  const off = onShowTeamTab((f) => shownTabs.push(f));
  put = null;
  expect(teamOpen({ tab: true }, (x) => (put = x), P)).toBe(false);
  off();
  expect(shownTabs).toEqual([P]);
  expect(put).toBeNull();
});

test('failed_seat_with_ask_is_red: a failed seat that also asks shows red under a lead, and the head counts it', () => {
  const lead = session({ teammate: 'm-lead', cwd: P });
  const seat = asking({ parent: lead.id, state: 'failed' });
  expect(row(seat).tone, 'before: orange hid red').toBe('you');
  const shown = withoutSeatAsks([lead, seat], TEAM).sessions;
  expect(row(shown[1]).tone).toBe('bad');
  expect(head(shown).attention).toBe(1);
});

test('no_lead_unchanged: without a lead, or for a session that is no seat, the hand stays on its own row', () => {
  const noLead: Team = { home: '/home', teammates: [] };
  const seat = asking({ parent: 'someone' });
  expect(withoutSeatAsks([seat], noLead).sessions[0]).toBe(seat);
  const plain = asking();
  const lead = session({ teammate: 'm-lead', cwd: P });
  const kept = withoutSeatAsks([lead, plain], TEAM).sessions;
  expect(kept[1]).toBe(plain);
  expect(row(kept[1]).kind).toBe('hand');
  // The lead's own ask stays on the lead's row.
  const leadAsks = asking({ teammate: 'm-lead', cwd: P });
  expect(row(withoutSeatAsks([leadAsks], TEAM).sessions[0]).kind).toBe('hand');
});

test('folded_project_and_group_keep_the_signal: the lead row is your turn, the project and group heads count the seat asks, "]" stops on the lead', () => {
  const lead = session({ teammate: 'm-lead', cwd: P });
  const seats = [asking({ parent: lead.id }), asking({ teammate: 'm-b' })];
  const { sessions: shown, hushed } = withoutSeatAsks([lead, ...seats], TEAM);
  // Folded, a project shows only your-turn rows (Sidebar foldedRows / atHead): the lead's row is one.
  expect(row(shown[0]).tone).toBe('you');
  const g = buildTree(shown, shown.map((s) => s.id), [], [], hushed)[0].groups[0];
  expect(g.counts.waiting, 'folded project head').toBe(2);
  expect(g.urgency).toBe('waiting');
  const other = buildTree([asking({ project: '/q', cwd: '/q/wt' })], [])[0].groups[0];
  expect(summary([g, other]).counts.waiting, 'group head sums its projects').toBe(3);
  expect(urgentQueue(shown).map((s) => s.id), '"]" walk').toEqual([lead.id]);
  // Nothing waits: the lead is not marked.
  expect(row(withoutSeatAsks([lead, session({ parent: lead.id })], TEAM).sessions[0]).tone).not.toBe('you');
});

test('kept_worker_keeps_its_ask (1115 review r2): a worker whose own row shows under the lead keeps its ask; the lead is not marked; the head counts it once', () => {
  const lead = session({ teammate: 'm-lead', cwd: P });
  const seat = asking({ parent: lead.id, label: 'Builder · 1109' });
  const other = asking({ parent: lead.id });
  const { sessions: shown, hushed } = withoutSeatAsks([lead, seat, other], TEAM, new Set([seat.id]));
  expect(shown[1]).toBe(seat);
  expect(row(shown[1]).kind).toBe('hand');
  expect(hushed.get(P), 'only the seat that is not kept goes to the pill').toBe(1);
  const alone = withoutSeatAsks([lead, seat], TEAM, new Set([seat.id]));
  expect(row(alone.sessions[0]).tone, 'nothing hushed: the lead keeps its own state').not.toBe('you');
  expect(buildTree(alone.sessions, [], [], [], alone.hushed)[0].groups[0].counts.waiting, 'the head counts the ask once').toBe(1);
});

test('no_lead_row_fallback: a lead whose seat is not running here leaves the seats their own marks', () => {
  const ended = session({ teammate: 'm-lead', cwd: P, state: 'closed' });
  const seat = asking({ parent: ended.id });
  for (const all of [[seat], [ended, seat], [session({ teammate: 'm-lead', project: '/elsewhere', cwd: '/elsewhere' }), seat]]) {
    const { sessions: shown, hushed } = withoutSeatAsks(all, TEAM);
    expect(shown.at(-1)).toBe(seat);
    expect(row(shown.at(-1)!).kind).toBe('hand');
    expect(hushed.size).toBe(0);
  }
});

const CSS = ['tokens.css', 'styles.css', 'layout.css', 'keys.css', 'chrome.css', 'tree/tree.css', 'lead/lead.css'].map((f) => fs.readFileSync(path.join(import.meta.dirname, '../src', f), 'utf8')).join('\n');
test('pill_fits_270: on a 270 px tree the pill stays whole and the lead name gives way first', async ({ page }) => {
  const s = session({ teammate: 'm-lead', cwd: P, label: 'Lead of the release notes and changelog' });
  const html = renderToStaticMarkup(
    createElement('div', { className: 'sess' }, createElement('span', { className: 'wtwrap' }, createElement((await import('../src/tree/RowIcon')).WtRow, { name: s.label, state: row(s), sessionId: s.id, t }), createElement(NeedYou, { t, n: 3, tip: 'x', onOpen: () => {} }))),
  );
  await page.setContent(`<style>${CSS}</style><aside class="dock l" style="width:270px"><nav class="tree">${html}</nav></aside>`);
  const pill = page.locator('.needyou');
  await expect(pill).toHaveText('3 need you');
  const box = await pill.boundingBox();
  const aside = await page.locator('aside').boundingBox();
  expect(box!.x + box!.width).toBeLessThanOrEqual(aside!.x + aside!.width);
  expect(await pill.evaluate((e) => e.scrollWidth > e.clientWidth)).toBe(false);
  const nm = page.locator('.row.wt2 .nm');
  expect(await nm.evaluate((e) => e.scrollWidth > e.clientWidth || e.scrollHeight > e.clientHeight + 1), 'the long name gives way').toBe(true);
});
