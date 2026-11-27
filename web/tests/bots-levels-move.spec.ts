// The level table and Worker models moved from Settings > Team to the Bots view's Models and limits fold (with each
// bot's own model controls), which keeps Settings > Team inside its fixed-word budget (team.spec.ts team_words_at_rest).
// Settings > Team keeps one Levels line whose button opens the fold; both settings still write the same stored values.
import fs from 'node:fs';
import path from 'node:path';
import { type Core, expect, openWindow, REPO, test } from './fixtures';
import { mates } from './leader-990';
import { closeModal, openLevels, openSettings } from './settings-modal';

const features = (core: Core) => (JSON.parse(fs.readFileSync(path.join(core.home, 'settings.json'), 'utf8')).features ?? {}) as Record<string, unknown>;

test('levels_moved_to_bots: Settings > Team has a Levels line that opens Models and limits in the Bots view, where the level table and Worker models work', async ({ app, core }) => {
  core.shell(core.project('alpha'), 'a1');
  mates(core, [{ id: 'mate-inbox', name: 'Inbox', job: 'Sorts the mail.' }]);
  await openWindow(app, {}, core);
  await openSettings(app);
  await app.locator('.settings > nav button[data-page="team"]').click();
  const body = app.locator('.sbody');
  // The page has the line, not the table or the Worker models rows.
  await expect(body.locator('[data-row="levels"]')).toContainText('Levels');
  await expect(body.getByRole('region', { name: 'Levels', exact: true })).toHaveCount(0);
  await expect(body.getByRole('combobox', { name: 'Workers open on' })).toHaveCount(0);
  await expect(body.locator('[data-open-levels]')).toHaveAccessibleName('Levels and worker models are in Bots, under Models and limits.');

  // The line's button opens the Bots view with the fold open.
  const fold = await openLevels(app);
  await expect(fold.locator('summary')).toContainText('Models and limits');
  const table = fold.getByRole('region', { name: 'Levels', exact: true });
  await expect(table.locator('[data-row="levels"] .team-lvsum')).toHaveText('Haiku Sonnet Opus');
  await table.getByRole('button', { name: 'Edit Levels', exact: true }).click();
  await table.getByRole('combobox', { name: 'Light, Claude Model' }).selectOption('sonnet');
  await expect.poll(() => features(core)['team.levels']).toEqual({ claude: { light: { model: 'sonnet' } } });
  await fold.getByRole('combobox', { name: 'Workers open on' }).selectOption('deep');
  await expect.poll(() => features(core)['team.workers']).toEqual({ level: 'deep' });

  // Opened any other way, the view starts with the fold closed (model handles stay off the default screen).
  await closeModal(app);
  await openSettings(app);
  await app.locator('.settings > nav button[data-page="team"]').click();
  await app.locator('.sbody [data-open-bots]').click();
  const view = app.getByRole('dialog', { name: 'Bots' }).locator('[data-bots]');
  await expect(view.locator('[data-bots-levels]')).not.toHaveAttribute('open', '');
  await expect(view.locator('[data-bots-levels] summary')).toBeVisible();
});

// Pictures on request: PW_OPT_IN=shots ... --project shots -g levels_moved_shots (light and dark).
test('levels_moved_shots @shots: Settings > Team with its Levels line, and the Bots view with Models and limits open', async ({ app, core }) => {
  const shots = path.join(REPO, '.scratch/shots');
  fs.mkdirSync(shots, { recursive: true });
  core.shell(core.project('alpha'), 'a1');
  mates(core, [{ id: 'mate-inbox', name: 'Inbox', job: 'Sorts the mail.', lead: true }]);
  await openWindow(app, {}, core);
  for (const scheme of ['light', 'dark'] as const) {
    await app.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await openSettings(app);
    await app.locator('.settings > nav button[data-page="team"]').click();
    await expect(app.locator('.sbody [data-open-levels]')).toBeVisible();
    await app.screenshot({ path: path.join(shots, `levels-moved-team-${scheme}.png`) });
    const fold = await openLevels(app);
    await app.screenshot({ path: path.join(shots, `levels-moved-bots-${scheme}.png`) });
    await fold.getByRole('button', { name: 'Edit Levels', exact: true }).click();
    await app.screenshot({ path: path.join(shots, `levels-moved-bots-edit-${scheme}.png`) });
    await closeModal(app);
  }
});
