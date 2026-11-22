// Ticket 992: screenshots of every level surface for the look before the owner sees it (not part of the gate: run with
// LEVEL_SHOTS=1). English at 1440 and 1100 px, light and dark; Korean and Japanese at 1100 px for clipping.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { type Core, REPO, expect, openWindow, test } from './fixtures';
import { asSeat, mates, openSeat, tokenClaude, tokenOf } from './leader-990';
// Any language: the chord opens Settings, `.settings` is the modal (settings-modal.ts names it in English).
const openSettings = async (app: Page) => {
  if (!(await app.locator('.settings').count())) await app.keyboard.press('Meta+Comma');
  await expect(app.locator('.settings')).toBeVisible();
};

test.skip(!process.env.LEVEL_SHOTS, 'screenshots for the look: LEVEL_SHOTS=1');
const SHOTS = process.env.LEVEL_SHOTS_DIR ?? path.join(REPO, '.scratch/level-shots');

const RUNS: { lang: 'en' | 'ko' | 'ja'; width: number; schemes: ('light' | 'dark')[] }[] = [
  { lang: 'en', width: 1440, schemes: ['light', 'dark'] },
  { lang: 'en', width: 1100, schemes: ['light', 'dark'] },
  { lang: 'ko', width: 1100, schemes: ['light'] },
  { lang: 'ja', width: 1100, schemes: ['light'] },
];

async function scene(app: Page, core: Core) {
  tokenClaude(core);
  core.shell(core.project('lumen'), 'main');
  mates(core, [
    { id: 'mate-chief', name: 'Chief', lead: true },
    { id: 'mate-inbox', name: 'Inbox', job: 'Sorts the morning mail and drafts short replies.' },
    { id: 'mate-plan', name: 'Planner', job: 'Plans the week.', level_max: 'standard' } as never,
    { id: 'mate-res', name: 'Researcher', job: 'Reads papers and writes summaries.' },
    { id: 'mate-pin', name: 'Contracts', job: 'Reviews contracts.', level: 'deep' } as never,
    { id: 'mate-own', name: 'Writer', job: 'Writes long posts.', model: 'opus' } as never,
  ]);
  await openWindow(app, {}, core);
  const chief = await openSeat(app, core, 'Chief');
  const token = await tokenOf(core, chief);
  const inbox = asSeat(core, token, 'team', 'open', 'Inbox', '--level', 'light').session.id as string;
  asSeat(core, token, 'team', 'open', 'Planner', '--level', 'standard');
  asSeat(core, token, 'team', 'open', 'Researcher', '--level', 'deep');
  asSeat(core, token, 'team', 'open', 'Contracts');
  asSeat(core, token, 'team', 'open', 'Writer');
  // A room line for the Team view's assistant rows.
  return { chief, inbox };
}

async function language(app: Page, lang: string) {
  await openSettings(app);
  await app.locator('.settings > nav button[data-page="general"]').click();
  await app.locator('[data-setting="language"]').selectOption(lang);
  for (let i = 0; i < 3 && (await app.locator('.settings').count()); i++) await app.keyboard.press('Escape');
  await expect(app.locator('.settings')).toHaveCount(0);
}

test('level shots', async ({ app, core }) => {
  test.setTimeout(600_000);
  fs.mkdirSync(SHOTS, { recursive: true });
  const { chief, inbox } = await scene(app, core);
  for (const run of RUNS.filter((r) => !process.env.LEVEL_SHOTS_LANGS || process.env.LEVEL_SHOTS_LANGS.split(',').includes(r.lang))) {
    await app.setViewportSize({ width: run.width, height: 860 });
    await language(app, run.lang);
    const shot = async (name: string) => {
      // A toast left from opening the seats would cover the composer.
      for (const b of await app.locator('.toast > button:last-of-type').all()) await b.click().catch(() => {});
      for (const scheme of run.schemes) {
        await app.emulateMedia({ colorScheme: scheme });
        await app.waitForTimeout(250);
        await app.screenshot({ path: path.join(SHOTS, `${name}-${run.lang}-${run.width}-${scheme}.png`) });
      }
    };
    // Tree rows (every level, a pinned one, a custom model) and the seat's chat header.
    const rest = app.locator('.home-rest button');
    if (await rest.count()) await rest.click();
    await app.locator(`.row.wt2[data-hint-session="${inbox}"]`).click();
    await expect(app.locator('.shead button.lvl-chip')).toBeVisible();
    await shot('tree-and-header');
    // The open level menu.
    await app.locator('.shead button.lvl-chip').click();
    await expect(app.locator('.lvl-list[role="menu"]')).toBeVisible();
    await shot('level-menu');
    // The note offer after a pick (taken back after the shot).
    await app.locator('.lvl-list [role="menuitemradio"]').nth(2).click();
    await expect(app.locator('.lvl-offer')).toBeVisible();
    await shot('level-note-offer');
    await app.keyboard.press('Escape');
    // Back to the seat's own level: the pick is taken back for the next run.
    await app.locator('.shead button.lvl-chip').click();
    await app.locator('.lvl-list [role="menuitemradio"]').nth(0).click();
    await expect(app.locator('.lvl-list')).toHaveCount(0);
    // The Team view of the Home lead: Assistants with their levels.
    await app.locator(`.tab[data-tab="${chief}"]`).click();
    const view = app.locator('.teamv[data-team-view]').first();
    if (!(await view.isVisible())) await app.locator('.shead [data-team-chip]').click();
    await expect(view).toBeVisible();
    const tabs = view.locator('[role="tab"]');
    if (await tabs.nth(1).isVisible()) await tabs.nth(1).click({ timeout: 5000, force: true }).catch(() => {});
    await shot('team-view');
    // The same view in its other place (side or tab), then back.
    await app.locator('.teamv-move').first().click();
    await app.waitForTimeout(300);
    if (await view.isVisible()) {
      const moved = view.locator('[role="tab"]');
      if (await moved.nth(1).isVisible()) await moved.nth(1).click({ timeout: 5000, force: true }).catch(() => {});
      await shot('team-view-moved');
    }
    // Settings > Team: the list, the form in each rule state, the Levels table.
    await openSettings(app);
    await app.locator('.settings > nav button[data-page="team"]').click();
    const body = app.locator('.sbody');
    await shot('team-list');
    const edit = async (id: string) => {
      await body.locator(`[data-row="team:${id}"] .lead-more`).click();
      await body.locator(`[data-row="team:${id}"] [role="menuitem"]`).first().click();
      await expect(body.locator('.team-form')).toBeVisible();
      await body.locator('.team-form').scrollIntoViewIfNeeded();
    };
    for (const [id, name] of [
      ['mate-inbox', 'form-auto'],
      ['mate-plan', 'form-auto-upto'],
      ['mate-pin', 'form-pinned'],
      ['mate-own', 'form-custom'],
    ]) {
      await edit(id);
      await shot(name);
      await body.locator('.team-form .team-acts .btn').nth(1).click();
    }
    await body.locator('[data-setting="levels"]').click(); // ticket 993: the table opens from its one line
    await body.locator('[data-row="level:deep"]').scrollIntoViewIfNeeded();
    await shot('levels-table');
    for (let i = 0; i < 3 && (await app.locator('.settings').count()); i++) await app.keyboard.press('Escape');
    await expect(app.locator('.settings')).toHaveCount(0);
    // Schedules (ticket 993: its own widget): a teammate's schedule with its level.
    await app.locator('#icon-schedules').click();
    await app.locator('.schedv .schedv-add').click();
    await app.locator('.schedv .sched-form select').first().selectOption('team:mate-inbox');
    await app.locator('.schedv .sched-form textarea').fill('Sort the morning mail');
    await shot('schedule-form');
    await app.locator('#icon-schedules').click();
  }
});
