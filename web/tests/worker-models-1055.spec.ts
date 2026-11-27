// Ticket 1055: Settings > Team > Worker models. Two rows, "Workers open on" (default Lead picks) and "Upper limit"
// (default None); each option is a level slot drawn with its real model (ticket 994), from the user's own table. The
// choice is stored as the feature team.workers and survives a reload.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { type Core, expect, openWindow, test } from './fixtures';
import { setLevels } from './levels-seed';
import { openLevels } from './settings-modal';

const features = (core: Core) => (JSON.parse(fs.readFileSync(path.join(core.home, 'settings.json'), 'utf8')).features ?? {}) as Record<string, unknown>;
// Since the move to the Bots view: Settings > Team's Levels line opens Models and limits, which holds Worker models.
const teamPage = (app: Page) => openLevels(app);

test('workers1055_rows: the two rows show the slots with their real models, default to Lead picks and None, and keep a choice after a reload', async ({ app, core }) => {
  // The user's own slot: Standard runs Opus here, so the option says Opus, not a level word.
  setLevels(core, { claude: { standard: { model: 'opus' } } });
  await openWindow(app, {}, core);
  let page = await teamPage(app);
  const on = () => page.getByRole('combobox', { name: 'Workers open on' });
  const max = () => page.getByRole('combobox', { name: 'Upper limit' });
  await expect(on()).toHaveValue('');
  await expect(on().locator('option:checked')).toHaveText('Lead picks');
  await expect(max().locator('option:checked')).toHaveText('None');
  await expect(on().locator('option')).toHaveText(['Lead picks', '▂ Haiku', '▂▄ Opus', '▂▄▆ Opus']);
  await expect(max().locator('option')).toHaveText(['None', '▂ Haiku', '▂▄ Opus', '▂▄▆ Opus']);
  await on().selectOption('deep');
  await expect.poll(() => features(core)['team.workers']).toEqual({ level: 'deep' });
  await max().selectOption('standard');
  await expect.poll(() => features(core)['team.workers']).toEqual({ level: 'deep', level_max: 'standard' });

  await openWindow(app, {}, core);
  page = await teamPage(app);
  await expect(on()).toHaveValue('deep');
  await expect(max()).toHaveValue('standard');
  // Back to the defaults: nothing is stored.
  await on().selectOption('');
  await max().selectOption('');
  await expect.poll(() => features(core)['team.workers']).toBeUndefined();
});
