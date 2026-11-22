// Ticket 993: screenshots of every Schedules surface and of Settings > Team for the look before the owner sees it (not
// part of the gate: run with SCHEDULE_SHOTS=1). English at 1440x900, light and dark; the narrow widget and the Team
// page at rest also at 1100x700 and in Korean and Japanese for clipping. Saved to .scratch/shots-993/.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { type Core, REPO, expect, nunchiro, openWindow, test } from './fixtures';
import { mates, openSeat, openTeam, owner, tokenClaude, tokenOf } from './leader-990';
import { add, listed, openWidget, row, stored } from './schedules-seed';

test.skip(!process.env.SCHEDULE_SHOTS, 'screenshots for the look: SCHEDULE_SHOTS=1');
const SHOTS = process.env.SCHEDULE_SHOTS_DIR ?? path.join(REPO, '.scratch/shots-993');
const SCHEMES = ['light', 'dark'] as const;

const openSettings = async (app: Page) => {
  if (!(await app.locator('.settings').count())) await app.keyboard.press('Meta+Comma');
  await expect(app.locator('.settings')).toBeVisible();
};
async function language(app: Page, lang: string) {
  await openSettings(app);
  await app.locator('.settings > nav button[data-page="general"]').click();
  await app.locator('[data-setting="language"]').selectOption(lang);
  for (let i = 0; i < 3 && (await app.locator('.settings').count()); i++) await app.keyboard.press('Escape');
  await expect(app.locator('.settings')).toHaveCount(0);
}
async function shot(app: Page, name: string, schemes: readonly ('light' | 'dark')[] = SCHEMES) {
  for (const b of await app.locator('.toast > button:last-of-type').all()) await b.click().catch(() => {});
  const { width, height } = app.viewportSize()!;
  // The pointer rests where nothing has a tooltip or a hover look (the last click left it on a bar icon or a row): the
  // open Settings page's title, else the middle of the centre.
  const h1 = app.locator('.settings .spage h1').first();
  const title = (await h1.count()) ? await h1.boundingBox() : null; // not waited for: Settings is open or it is not
  await app.mouse.move(title ? title.x + 4 : width * 0.45, title ? title.y + 4 : height * 0.55);
  for (const scheme of schemes) {
    await app.emulateMedia({ colorScheme: scheme });
    await app.waitForTimeout(250);
    await app.screenshot({ path: path.join(SHOTS, `${name}-${width}x${height}-${scheme}.png`) });
  }
}

/** Five schedules, one for each last-run state (never ran and switched off, running, finished, needs you, failed). */
async function scene(app: Page, core: Core) {
  tokenClaude(core);
  const lumen = core.project('lumen');
  const main = core.shell(lumen, 'main');
  const team = [
    { id: 'mate-chief', name: 'Chief', lead: true },
    { id: 'mate-inbox', name: 'Inbox', job: 'Sorts the morning mail and drafts short replies.' },
    { id: 'mate-res', name: 'Researcher', job: 'Reads papers and writes summaries.' },
    { id: 'mate-plan', name: 'Planner', job: 'Plans the week.' },
  ];
  mates(core, [...team, { id: 'mate-lister', name: 'Lister', job: 'Lists the files.' }]);
  const inbox = add(core, { teammate: 'mate-inbox', task: 'Sort the morning mail, draft short replies to anything that needs one, and list what you left for me.', level: 'light' }, '21:00');
  const res = add(core, { teammate: 'mate-res', task: 'Read the new papers on the reading list and write a five-line summary of each.', level: 'deep' }, '09:00', true, [1, 2, 3, 4, 5]);
  const plan = add(core, { teammate: 'mate-plan', task: 'Plan the week from the open tasks.', level: 'standard' }, '09:00', true, [1]);
  const lister = add(core, { teammate: 'mate-lister', task: 'List the file names in the Home folder.' }, '07:30', true, [1, 3, 5]);
  const tests = add(core, { project: lumen, label: 'nightly tests', task: 'Run the test suite and report what failed.' }, `${new Date().getFullYear() + 1}-12-31 23:59`, false);
  // Lister leaves the team, and its run cannot start: a real failed run with the core's own reason.
  mates(core, team);
  owner(core, { op: 'schedule_run_now', id: lister.id });
  const now = Date.now();
  await stored(app, core, {
    [inbox.id]: { last: { session: main.id, at: now - 3 * 3600_000, result: 'finished' } },
    [res.id]: { last: { session: main.id, at: now - 60_000 } },
    [plan.id]: { last: { session: main.id, at: now - 26 * 3600_000, result: 'needs_you' } },
    [tests.id]: { paused: true },
  });
  return { inbox, lister };
}

test('schedule shots', async ({ app, core }) => {
  test.setTimeout(600_000);
  fs.mkdirSync(SHOTS, { recursive: true });
  const { inbox, lister } = await scene(app, core);
  await app.setViewportSize({ width: 1440, height: 900 });
  await openWindow(app, {}, core);
  const widget = await openWidget(app);
  await expect(widget.locator('.sched-item')).toHaveCount(5);
  await shot(app, 'widget');
  await app.setViewportSize({ width: 1100, height: 700 });
  await shot(app, 'widget');
  await app.setViewportSize({ width: 1440, height: 900 });
  // The open detail (a failed run, with its reason), then the form for a teammate and for a new session.
  await row(app, lister.id).locator('.sched-go').click();
  await expect(widget.locator('.sched-detail')).toBeVisible();
  await shot(app, 'detail');
  await row(app, lister.id).locator('.sched-go').click();
  await row(app, inbox.id).locator('.sched-go').click();
  await shot(app, 'detail-finished');
  await row(app, inbox.id).locator('.sched-go').click();
  // "+": the form for a teammate (it starts at Light), then for a new session; Edit: the same form, filled.
  await widget.locator('.schedv-add').click();
  await expect(widget.locator('.sched-form')).toBeVisible();
  await widget.locator('.sched-form textarea').fill('Sort the morning mail and list what is left.');
  await shot(app, 'form-teammate');
  await widget.locator('.sched-form select').first().selectOption('new');
  await widget.locator('.sched-form input[name="sched-mode"][value="weekly"]').check();
  await shot(app, 'form-new-session');
  await widget.locator('.sched-form input[name="sched-mode"][value="once"]').check();
  await shot(app, 'form-once', ['light']);
  await widget.locator('.sched-form .sched-acts .btn').nth(1).click();
  await row(app, inbox.id).locator('.sched-go').click();
  await widget.locator('.sched-detail .btn').nth(1).click();
  await shot(app, 'form-edit', ['light']);
  await widget.locator('.sched-form .sched-acts .btn').nth(1).click();
  await row(app, inbox.id).locator('.sched-go').click();
  // The wide tab, with a row's menu open in the second shot.
  await widget.locator('.teamv-move[data-move="tab"]').click();
  const tab = app.locator('.schedv[data-where="tab"]');
  await expect(tab).toBeVisible();
  await shot(app, 'tab');
  await tab.locator('.lead-more').first().click();
  await shot(app, 'tab-menu', ['light']);
  await app.keyboard.press('Escape');
  await tab.locator('.teamv-move[data-move="side"]').click();
  await expect(app.locator('.sbar[data-widget="schedules"] .schedv')).toBeVisible();
  // Korean and Japanese, the narrow widget with one detail open.
  for (const lang of ['ko', 'ja']) {
    await language(app, lang);
    await shot(app, `widget-${lang}`, ['light']);
    await app.locator('.schedv .schedv-add').click();
    await shot(app, `form-${lang}`, ['light']);
    await app.locator('.schedv .sched-form .sched-acts .btn').nth(1).click();
  }
  await language(app, 'en');
  // A lead's proposal as a card in Decisions: the task on three lines, then all of it.
  const chief = await openSeat(app, core, 'Chief');
  const token = await tokenOf(core, chief);
  nunchiro({ ...core.env, NUNCHIRO_TOKEN: token }, ['schedule', 'propose', '--who', 'Researcher', '--when', 'weekly fri 16:00', '--level', 'deep', '--task', 'Read every paper that came in this week, check each one against the notes we keep on the reading list, and write a summary of what changed our mind, what did not, and what we should read next week.\nKeep it under one page.']);
  await app.locator('#icon-decisions').click();
  const card = app.locator('.dw [data-schedule-card]');
  await expect(card).toBeVisible();
  await shot(app, 'card');
  await card.locator('.sched-more').click();
  await shot(app, 'card-all', ['light']);
  // Home: the failed run under "Needs you" in the Home lead's Team view, and in its chip.
  await app.locator(`.tab[data-tab="${chief}"]`).click();
  const view = await openTeam(app);
  await expect(view.locator('[data-failed-run]')).toBeVisible();
  await shot(app, 'home-failed');
  expect(listed(core)).toHaveLength(5);
});

test('schedule shots: the empty state', async ({ app, core }) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  core.shell(core.project('lumen'), 'main');
  await app.setViewportSize({ width: 1440, height: 900 });
  await openWindow(app, {}, core);
  const widget = await openWidget(app);
  await expect(widget.locator('.schedv-empty')).toBeVisible();
  await shot(app, 'empty');
});

const JOBS = {
  chief: 'Plans the day with me and hands work to the others. Keeps a short list of what is open and tells me what needs my answer first.',
  inbox: 'Sorts the morning mail and drafts short replies. Anything about money or a contract is left for me, with one line on why.',
  res: 'Reads the papers on the reading list and writes a five-line summary of each.\nKeeps the notes file current and says what changed our mind.',
  review: 'Reviews diffs before a merge: tests first, then names, then anything risky.',
};
/** Four teammates: the Home lead (Auto), one pinned to Light, one in a project on Codex (Auto, up to Standard), one with a model of its own. */
function teamScene(core: Core) {
  const lumen = core.project('lumen');
  core.shell(lumen, 'main');
  mates(core, [
    { id: 'mate-chief', name: 'Chief', lead: true, job: JOBS.chief },
    { id: 'mate-inbox', name: 'Inbox', job: JOBS.inbox, level: 'light' },
    { id: 'mate-res', name: 'Researcher', job: JOBS.res, project: lumen, kind: 'codex', level_max: 'standard' },
    { id: 'mate-review', name: 'Reviewer', job: JOBS.review, project: lumen, model: 'opus' },
  ] as never);
}
async function teamPage(app: Page) {
  await openSettings(app);
  await app.locator('.settings > nav button[data-page="team"]').click();
  await expect(app.locator('.spage h1').first()).toBeVisible();
  return app.locator('.sbody');
}

test('team shots', async ({ app, core }) => {
  test.setTimeout(600_000);
  fs.mkdirSync(SHOTS, { recursive: true });
  teamScene(core);
  await app.setViewportSize({ width: 1440, height: 900 });
  await openWindow(app, {}, core);
  const body = await teamPage(app);
  const row = (id: string) => body.locator(`[data-row="team:${id}"]`);
  await expect(row('mate-review')).toBeVisible();
  await shot(app, 'team-rest');
  await app.setViewportSize({ width: 1100, height: 700 });
  await shot(app, 'team-rest');
  await app.setViewportSize({ width: 1440, height: 900 });
  // A row opened in place: the whole job.
  await row('mate-res').locator('.team-go').click();
  await expect(row('mate-res').locator('.team-detail')).toBeVisible();
  await shot(app, 'team-row-open');
  await row('mate-res').locator('.team-go').click();
  // The row menu (Edit, Remove), on the last row: it opens past the card's edge.
  await row('mate-review').locator('.lead-more').click();
  await expect(row('mate-review').getByRole('menu')).toBeVisible();
  await shot(app, 'team-menu');
  // Edit: the form's five fields, then with Advanced open (a new teammate has none of the three set).
  await row('mate-review').getByRole('menuitem').first().click();
  const form = body.locator('.team-form');
  await expect(form).toBeVisible();
  await form.locator('.team-acts .btn').nth(1).click();
  await row('mate-inbox').locator('.lead-more').click();
  await row('mate-inbox').getByRole('menuitem').first().click();
  await expect(form).toBeVisible();
  await form.scrollIntoViewIfNeeded();
  await shot(app, 'team-form');
  await form.locator('details.team-adv > summary').click();
  await form.locator('.team-acts').scrollIntoViewIfNeeded();
  await shot(app, 'team-form-advanced');
  await form.locator('.team-acts .btn').nth(1).click();
  // Levels, opened in place.
  await body.locator('[data-setting="levels"]').click();
  await body.locator('[data-row="level:deep"]').scrollIntoViewIfNeeded();
  await shot(app, 'team-levels-open');
  await body.locator('[data-setting="levels"]').click();
  for (let i = 0; i < 3 && (await app.locator('.settings').count()); i++) await app.keyboard.press('Escape');
  await expect(app.locator('.settings')).toHaveCount(0); // Esc closes a moment later: language() must not find the closing one
  for (const lang of ['ko', 'ja']) {
    await language(app, lang);
    await teamPage(app);
    await shot(app, `team-rest-${lang}`, ['light']);
  }
});

test('team shots: the empty state', async ({ app, core }) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  core.shell(core.project('lumen'), 'main');
  await app.setViewportSize({ width: 1440, height: 900 });
  await openWindow(app, {}, core);
  const body = await teamPage(app);
  await expect(body.locator('.team-none')).toBeVisible();
  await shot(app, 'team-empty');
});
