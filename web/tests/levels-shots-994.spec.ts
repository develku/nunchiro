// Ticket 994: screenshots of every place that shows or offers a level, for the look before the owner sees it (not part
// of the gate: run with LEVELS994_SHOTS=1). 1440x900, light and dark; the Team page and the Schedules widget also in
// Korean. Saved to .scratch/shots-994/. The pointer is moved away before each shot.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { type Core, REPO, expect, nunchiro, openWindow, test } from './fixtures';
import { asSeat, mateMenu, mates, openSeat, openTeam, tokenClaude, tokenOf } from './leader-990';
import { acpAgent, fakeCodex } from './levels-seed';
import { add, openWidget } from './schedules-seed';

test.skip(!process.env.LEVELS994_SHOTS, 'screenshots for the look: LEVELS994_SHOTS=1');
const SHOTS = process.env.LEVELS994_SHOTS_DIR ?? path.join(REPO, '.scratch/shots-994');
const SCHEMES = ['light', 'dark'] as const;

const openSettings = async (app: Page) => {
  if (!(await app.locator('.settings').count())) await app.keyboard.press('Meta+Comma');
  await expect(app.locator('.settings')).toBeVisible();
};
const closeSettings = async (app: Page) => {
  for (let i = 0; i < 3 && (await app.locator('.settings').count()); i++) await app.keyboard.press('Escape');
  await expect(app.locator('.settings')).toHaveCount(0);
};
async function language(app: Page, lang: string) {
  await openSettings(app);
  await app.locator('.settings > nav button[data-page="general"]').click();
  await app.locator('[data-setting="language"]').selectOption(lang);
  await closeSettings(app);
}
async function shot(app: Page, name: string, schemes: readonly ('light' | 'dark')[] = SCHEMES) {
  for (const b of await app.locator('.toast > button:last-of-type').all()) await b.click().catch(() => {});
  const { width, height } = app.viewportSize()!;
  // The pointer rests where nothing has a tooltip or a hover look: the open Settings page's title, else the centre.
  const h1 = app.locator('.settings .spage h1').first();
  const title = (await h1.count()) ? await h1.boundingBox() : null;
  await app.mouse.move(title ? title.x + 4 : width * 0.45, title ? title.y + 4 : height * 0.55);
  for (const scheme of schemes) {
    await app.emulateMedia({ colorScheme: scheme });
    await app.waitForTimeout(250);
    await app.screenshot({ path: path.join(SHOTS, `${name}-${width}x${height}-${scheme}.png`) });
  }
}

async function scene(app: Page, core: Core) {
  tokenClaude(core);
  fakeCodex(core);
  await acpAgent(core, 'acme'); // approved, and ran once: its models and thinking levels are on record; its levels not filled
  core.shell(core.project('lumen'), 'main');
  mates(core, [
    { id: 'mate-chief', name: 'Chief', lead: true },
    { id: 'mate-inbox', name: 'Inbox', job: 'Sorts the morning mail and drafts short replies.' },
    { id: 'mate-plan', name: 'Planner', job: 'Plans the week.', level_max: 'standard' } as never,
    { id: 'mate-res', name: 'Researcher', job: 'Reads papers and writes summaries.' },
    { id: 'mate-code', name: 'Builder', job: 'Builds small tools.', kind: 'codex' },
    { id: 'mate-pin', name: 'Contracts', job: 'Reviews contracts.', level: 'deep' } as never,
    { id: 'mate-own', name: 'Writer', job: 'Writes long posts.', model: 'fable' } as never,
    { id: 'mate-scout', name: 'Scout', job: 'Looks things up on the web.', kind: 'acp', agent: 'acme' } as never,
  ]);
  add(core, { teammate: 'mate-inbox', task: 'Sort the morning mail and list what you left for me.', level: 'light' }, '21:00');
  add(core, { teammate: 'mate-res', task: 'Read the new papers and write a five-line summary of each.', level: 'deep' }, '09:00', true, [1, 2, 3, 4, 5]);
  add(core, { teammate: 'mate-code', task: 'Run the test suite and report what failed.', level: 'standard' }, '07:30', true, [1]);
  add(core, { teammate: 'mate-chief', task: 'Write the morning report.' }, '08:00');
  await app.setViewportSize({ width: 1440, height: 900 });
  await openWindow(app, {}, core);
  const chief = await openSeat(app, core, 'Chief');
  const token = await tokenOf(core, chief);
  const inbox = asSeat(core, token, 'team', 'open', 'Inbox', '--level', 'light').session.id as string;
  asSeat(core, token, 'team', 'open', 'Planner', '--level', 'standard');
  asSeat(core, token, 'team', 'open', 'Researcher', '--level', 'deep');
  asSeat(core, token, 'team', 'open', 'Builder', '--level', 'light');
  return { chief, token, inbox };
}

test('level shots 994', async ({ app, core }) => {
  test.setTimeout(600_000);
  fs.mkdirSync(SHOTS, { recursive: true });
  const { chief, token, inbox } = await scene(app, core);
  const row = (id: string) => app.locator(`.row.wt2[data-hint-session="${id}"]`);
  // 1. Tree rows: Claude seats at three levels, one Codex seat.
  const resting = app.getByRole('button', { name: /resting$/ });
  if (await resting.count()) await resting.first().click();
  await expect(row(inbox)).toBeVisible();
  await shot(app, '01-tree');
  // 2. The chat header's chip, and its menu.
  await row(inbox).click();
  await expect(app.locator('.shead .lvl-chip')).toBeVisible();
  await shot(app, '02-header');
  await app.locator('.shead button.lvl-chip').click();
  await expect(app.locator('.shead').getByRole('menu')).toBeVisible();
  await app.mouse.move(700, 700);
  for (const scheme of SCHEMES) {
    await app.emulateMedia({ colorScheme: scheme });
    await app.waitForTimeout(250);
    await app.screenshot({ path: path.join(SHOTS, `03-header-menu-1440x900-${scheme}.png`) });
  }
  await app.keyboard.press('Escape');
  // 3. Home's assistants rows (the Home lead's Team view).
  await app.locator(`.tab[data-tab="${chief}"]`).click();
  const view = await openTeam(app);
  await view.getByRole('tab', { name: 'Assistants' }).click();
  await expect(view.locator('.lead-row[data-mate="mate-inbox"] .lvl-chip')).toBeVisible();
  await shot(app, '04-home-assistants');
  // 4. The Schedules widget: rows, the form for a teammate and for a lead, a proposal card.
  const widget = await openWidget(app);
  await expect(widget.locator('.sched-item')).toHaveCount(4);
  await shot(app, '05-schedules');
  await widget.locator('.schedv-add').click();
  await expect(widget.locator('.sched-form')).toBeVisible();
  await widget.locator('.sched-form textarea').fill('Sort the morning mail and list what is left.');
  await shot(app, '06-schedule-form');
  await widget.getByRole('combobox', { name: 'Who' }).selectOption({ label: 'Builder' });
  await shot(app, '06b-schedule-form-codex', ['light']);
  await widget.getByRole('combobox', { name: 'Who' }).selectOption({ label: 'Chief' });
  await shot(app, '06c-schedule-form-lead', ['light']);
  await widget.getByRole('combobox', { name: 'Who' }).selectOption({ label: 'Scout' });
  await shot(app, '06d-schedule-form-acp', ['light']);
  await widget.locator('.sched-form .sched-acts .btn').nth(1).click();
  await widget.locator('.teamv-move[data-move="tab"]').click();
  await expect(app.locator('.schedv[data-where="tab"]')).toBeVisible();
  await shot(app, '05b-schedules-tab');
  await app.locator('.schedv[data-where="tab"] .teamv-move[data-move="side"]').click();
  await language(app, 'ko');
  await openWidget(app);
  await shot(app, '05-schedules-ko', ['light']);
  await language(app, 'en');
  nunchiro({ ...core.env, NUNCHIRO_TOKEN: token }, ['schedule', 'propose', '--who', 'Researcher', '--when', 'weekly fri 16:00', '--level', 'deep', '--task', 'Read every paper that came in this week and write what changed our mind.']);
  nunchiro({ ...core.env, NUNCHIRO_TOKEN: token }, ['schedule', 'propose', '--who', 'Builder', '--when', 'daily 07:00', '--task', 'Run the tests.']);
  await app.locator('#icon-decisions').click();
  await expect(app.locator('.dw [data-schedule-card]')).toHaveCount(2);
  await shot(app, '07-schedule-cards');
  // 5. Settings > Team: at rest, a teammate's form, a lead's form, the Levels table with Claude, Codex and one ACP agent.
  await openSettings(app);
  await app.locator('.settings > nav button[data-page="team"]').click();
  const body = app.locator('.sbody');
  await expect(body.locator('[data-row^="team:"]')).toHaveCount(8);
  await shot(app, '08-team');
  await mateMenu(body, 'Inbox', 'Edit');
  await expect(body.locator('.team-form')).toBeVisible();
  await shot(app, '09-team-form');
  await body.locator('.team-form details.team-adv > summary').click();
  await shot(app, '09b-team-form-advanced', ['light']);
  await body.locator('.team-form').getByRole('button', { name: 'Cancel', exact: true }).click();
  await mateMenu(body, 'Chief', 'Edit');
  await shot(app, '09c-team-form-lead', ['light']);
  await body.locator('.team-form').getByRole('button', { name: 'Cancel', exact: true }).click();
  await mateMenu(body, 'Scout', 'Edit');
  await shot(app, '09d-team-form-acp', ['light']);
  await body.locator('.team-form').getByRole('button', { name: 'Cancel', exact: true }).click();
  // The Level choices of a Codex teammate with one picked (light and dark), and as a column in a narrow window.
  await mateMenu(body, 'Builder', 'Edit');
  await body.locator('.team-form .team-level input[value="standard"]').check();
  await shot(app, '09e-team-form-codex');
  await app.setViewportSize({ width: 700, height: 800 });
  await body.locator('.team-form .team-acts').scrollIntoViewIfNeeded();
  await shot(app, '09f-team-form-codex-narrow');
  await app.setViewportSize({ width: 1440, height: 900 });
  await body.locator('.team-form').getByRole('button', { name: 'Cancel', exact: true }).click();
  const levels = body.getByRole('region', { name: 'Levels', exact: true });
  await levels.getByRole('button', { name: 'Edit Levels', exact: true }).click();
  await levels.scrollIntoViewIfNeeded();
  await body.evaluate((e) => (e.scrollTop = e.scrollHeight));
  await shot(app, '10-levels');
  await levels.getByRole('button', { name: 'Done', exact: true }).click();
  await closeSettings(app);
  await language(app, 'ko');
  await openSettings(app);
  await app.locator('.settings > nav button[data-page="team"]').click();
  await shot(app, '08-team-ko', ['light']);
  await app.locator('.sbody section').last().locator('.sctl button').click();
  await app.locator('.sbody').evaluate((e) => (e.scrollTop = e.scrollHeight));
  await shot(app, '10-levels-ko', ['light']);
  await closeSettings(app);
  await language(app, 'en');
  // The ACP agent's levels filled: the Level choices of its teammate, one picked.
  await openSettings(app);
  await app.locator('.settings > nav button[data-page="team"]').click();
  const table = app.locator('.sbody').getByRole('region', { name: 'Levels', exact: true });
  await table.getByRole('button', { name: 'Edit Levels', exact: true }).click();
  await table.getByRole('combobox', { name: 'Light, acme Effort' }).selectOption('low');
  await table.getByRole('combobox', { name: 'Standard, acme Model' }).selectOption('smart');
  await table.getByRole('combobox', { name: 'Deep, acme Model' }).selectOption('smart');
  await table.getByRole('combobox', { name: 'Deep, acme Effort' }).selectOption('high');
  await table.getByRole('button', { name: 'Done', exact: true }).click();
  await mateMenu(app.locator('.sbody'), 'Scout', 'Edit');
  await app.locator('.sbody .team-form .team-level input[value="deep"]').check();
  await shot(app, '09g-team-form-acp-filled');
  await app.locator('.sbody .team-form').getByRole('button', { name: 'Cancel', exact: true }).click();
  await closeSettings(app);
});

// The Team page with no teammate: the empty state and the Levels line.
test('level shots 994: empty team page', async ({ app, core }) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  core.shell(core.project('lumen'), 'main');
  await app.setViewportSize({ width: 1440, height: 900 });
  await openWindow(app, {}, core);
  await openSettings(app);
  await app.locator('.settings > nav button[data-page="team"]').click();
  await expect(app.locator('.sbody .team-none')).toBeVisible();
  await shot(app, '08-team-empty');
});
