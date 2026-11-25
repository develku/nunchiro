// Ticket 1115 step 1 (mockup docs/design/workers-1115/mockup.html, panel 2): the tree shows the lead, not its workers.
// A running lead's worker seats fold under its row with a "N working" tag; one that needs the owner comes up on its own
// row; an ended one and a Reviewer have no row; a session the owner closed leaves at once; the owner's own sessions stay.
import path from 'node:path';
import type { Locator } from '@playwright/test';
import { expect, openWindow, REPO, test } from './fixtures';
import { isReviewer, leadWorkers } from '../src/tree';
import type { Team } from '../src/lead/lead';
import type { Session } from '../src/types';
import { mates, openSeat, repo, tokenClaude, tokenOf, worker } from './leader-990';
import { patchSnapshots } from './tree-mock-states';

const SHOTS = path.join(REPO, '.scratch/shots');

const P = '/p';
const TEAM: Team = { home: '/home', teammates: [{ id: 'm-lead', name: 'Lead', job: '', kind: 'claude', project: P, lead: true }] };
let n = 0;
const session = (over: Partial<Session> = {}): Session =>
  ({ id: `s${++n}`, kind: 'claude', project: P, cwd: P, label: '', state: 'running', agent_version: null, untested: false, pid: 1, pending: [], attention: { working: false, waiting: false, stale: false, failed: false, last_activity: 0 }, ...over }) as Session;

test('lead_workers_pure: seats of a running lead are workers; the owner\'s own sessions and a lead that is not running have none', () => {
  const lead = session({ teammate: 'm-lead' });
  const builder = session({ parent: lead.id, label: 'Builder · one' });
  const grandchild = session({ parent: builder.id });
  const mine = session({ label: 'mine' });
  const elsewhere = session({ parent: lead.id, project: '/q', cwd: '/q' });
  expect([...leadWorkers([lead, builder, grandchild, mine, elsewhere], TEAM)]).toEqual([builder.id, grandchild.id]);
  expect(leadWorkers([{ ...lead, state: 'resumable' }, builder], TEAM).size, 'no running lead: nothing folds').toBe(0);
  expect(isReviewer(session({ label: 'Reviewer · ticket 1108' }))).toBe(true);
  expect(isReviewer(session({ label: 'Builder · review the docs' }))).toBe(false);
});

test('workers_fold_under_lead: tag, a waiting worker comes up, ended and Reviewer rows are gone, a closed session leaves, the owner\'s rows stay', async ({ app, core }) => {
  tokenClaude(core);
  const project = repo(core, 'nunchiro');
  mates(core, [{ id: 'lead-main', name: 'Main', project, lead: true }]);
  const mine = core.shell(project, 'my own shell');
  const closing = core.shell(project, 'close me');
  const set = await patchSnapshots(app);
  await openWindow(app, {}, core);
  const lead = await openSeat(app, core, 'Main');
  const token = await tokenOf(core, lead);
  const ids: Record<string, string> = {};
  for (const label of ['Builder · asks', 'Builder · one', 'Builder · two', 'Builder · done', 'Reviewer · one']) ids[label] = (await worker(core, token, project, label)).id;
  const base = { 'Builder · one': { working: true }, 'Builder · two': { working: true }, 'Builder · done': { exited: true }, 'Reviewer · one': { working: true }, 'my own shell': { working: true } };
  set({ ...base, 'Builder · asks': { waiting: true } });
  const width = (px: number) => app.locator('.sbar.l').evaluate((e, w) => void ((e as HTMLElement).style.width = `${w}px`), px);
  const shot = (name: string) => app.locator('.sbar.l').screenshot({ path: path.join(SHOTS, `1115-step1-${name}.png`) });
  /** Shown whole: not cut by the row's width (a word clamp or an ellipsis cuts by narrowing the box below its text). */
  const whole = (l: Locator) =>
    l.evaluate((e) => {
      // The text's own width against its box, and the box inside its parent's (the name's clamp breaks inside a word and
      // its parent clips, so scrollWidth alone reads "whole" for "M…").
      const c = document.createElement('canvas').getContext('2d')!;
      const cs = getComputedStyle(e);
      c.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      const box = e.getBoundingClientRect();
      const up = e.parentElement!.getBoundingClientRect();
      return box.width > 0 && c.measureText(e.textContent ?? '').width <= e.clientWidth + 0.5 && box.right <= up.right + 0.5;
    });
  /** The tree takes snapshots only while neither the pointer nor focus is in it. */
  const away = async () => (await app.mouse.move(900, 600), await app.evaluate(() => (document.activeElement as HTMLElement | null)?.blur()));
  await width(300);
  await away();
  const grp = app.locator('.tree .grp[data-project="nunchiro"]');
  const row = (id: string) => grp.locator(`button.row.wt2[data-menu-session="${id}"]`);
  const leadRow = row(lead);
  const crew = grp.locator('.crew');
  await expect(leadRow).toBeVisible();
  // Mockup panel 2 (review r2): the worker that asks has its own orange row under the lead and keeps its ask there; the
  // lead's row stays in its own state with no "need you" pill, and its "N working" tag; the rest fold.
  await expect(crew.locator(`[data-menu-session="${ids['Builder · asks']}"]`)).toBeVisible();
  await expect(row(ids['Builder · asks'])).toHaveClass(/\bwt2 you\b/);
  await expect(leadRow.locator('xpath=..').locator('.needyou')).toHaveCount(0);
  await expect(leadRow).not.toHaveClass(/\bwt2 you\b/);
  await expect(leadRow.locator('.lead-tag')).toHaveText('2 working'); // the two Builders whose turn runs; not the one that asks
  await expect(crew.locator('.crewn')).toHaveCount(0);
  for (const l of ['Builder · one', 'Builder · two']) await expect(row(ids[l])).toHaveCount(0);
  // The head counts the one ask once.
  await expect(grp.locator('.row.head .r')).toHaveAttribute('aria-label', /\b1 waiting\b/);
  const more = crew.getByRole('button', { name: '▸ 2 more working' });
  await expect(more).toBeVisible();
  await shot('after');
  // At the default width (250 px) the lead's name, its tag and the fold are whole.
  await width(250);
  expect(await whole(leadRow.locator('.nm')), 'lead name at 250 px').toBe(true);
  expect(await whole(leadRow.locator('.lead-tag')), 'tag at 250 px').toBe(true);
  expect(await whole(more), 'fold at 250 px').toBe(true);
  await shot('after-250');
  await width(300);
  // Folded, the project shows no worker row: the ask is the 1067 pill on the lead's row, as before.
  await grp.getByRole('button', { name: 'Collapse nunchiro' }).click();
  await away();
  await expect(row(ids['Builder · asks'])).toHaveCount(0);
  await expect(leadRow.locator('xpath=..').locator('.needyou')).toHaveText('1 need you');
  await expect(grp.locator('.row.head .r')).toHaveAttribute('aria-label', /\b1 waiting\b/);
  await grp.getByRole('button', { name: 'Expand nunchiro' }).click();
  await away();
  await expect(row(ids['Builder · asks'])).toBeVisible();
  await more.click();
  for (const l of ['Builder · one', 'Builder · two']) await expect(crew.locator(`[data-menu-session="${ids[l]}"]`)).toBeVisible();
  await crew.getByRole('button', { name: 'Show fewer' }).click();
  await expect(crew.locator(`[data-menu-session="${ids['Builder · one']}"]`)).toHaveCount(0);
  await more.click();
  await shot('after-open');
  await crew.getByRole('button', { name: 'Show fewer' }).click();
  // An ended worker and a working Reviewer have no row anywhere in the tree, and no "just finished" row either.
  await expect(row(ids['Builder · done'])).toHaveCount(0);
  await expect(grp.locator('.row.wt2.just')).toHaveCount(0);
  await expect(row(ids['Reviewer · one'])).toHaveCount(0);
  // The lead's `↳` count does not list its workers a second time.
  await expect(leadRow.locator('xpath=..').locator('.kidcount')).toHaveCount(0);
  // The owner's own session keeps its row, outside the fold.
  await expect(row(mine.id)).toBeVisible();
  await expect(crew.locator(`[data-menu-session="${mine.id}"]`)).toHaveCount(0);

  // Nothing waits now (no pill), the asking Builder is idle and the Reviewer failed: the tag is on the lead's row and whole
  // beside the whole name at 250 px; it still counts only the two at work; the fold says "more", not "more working"; the
  // failed Reviewer comes up.
  set({ ...base, 'Reviewer · one': { failed: true } });
  await away();
  await expect(leadRow.locator('xpath=..').locator('.needyou')).toHaveCount(0);
  await expect(leadRow.locator('.lead-tag')).toHaveText('2 working');
  await expect(crew.locator('.crewn')).toHaveCount(0);
  await expect(crew.getByRole('button', { name: '▸ 3 more' })).toBeVisible();
  await expect(crew.locator(`[data-menu-session="${ids['Reviewer · one']}"]`)).toBeVisible();
  await expect(row(ids['Reviewer · one'])).toHaveClass(/\bwt2 bad\b/);
  await width(250);
  expect(await whole(leadRow.locator('.nm')), 'lead name at 250 px, no pill').toBe(true);
  expect(await whole(leadRow.locator('.lead-tag')), 'tag at 250 px, no pill').toBe(true);
  await shot('after-250-nopill');
  await width(300);

  // A session the owner closes from its own row's menu leaves the tree at once: focus stays in the tree, which holds its
  // rows still meanwhile, and no dimmed "just finished" row stays for 10 minutes.
  await expect(row(closing.id)).toBeVisible();
  await row(closing.id).click({ button: 'right' });
  await app.getByRole('menu', { name: 'Actions' }).getByRole('menuitem', { name: 'Close session' }).click();
  await expect.poll(() => (core.cli('snapshot', '--json').sessions as Session[]).find((s) => s.id === closing.id)?.state).toBe('closed');
  await expect(row(closing.id)).toHaveCount(0);
  await expect(grp.locator('.row.wt2.just')).toHaveCount(0);
});
