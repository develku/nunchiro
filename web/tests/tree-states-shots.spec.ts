// Pictures on request (PW_OPT_IN=shots ... --project shots): the tree with every state, compact rows and the tab strip
// with seven tabs, in Nunchiro light and dark and two catalog themes, to compare with the design book's tree, tabs and
// faces sections. SHOTS_OUT names the folder (default .scratch/shots-tree-states).
import path from 'node:path';
import type { Page } from '@playwright/test';
import { THEMES } from '../src/themes/catalog/catalog.gen';
import { parseGhostty } from '../src/themes/ghostty';
import { DARK_PICK, LIGHT_PICK } from '../src/themes/nunchiro';
import { expect, openWindow, test, type Core } from './fixtures';
import { patchSnapshots } from './tree-mock-states';

const OUT = process.env.SHOTS_OUT ?? path.resolve(import.meta.dirname, '../../.scratch/shots-tree-states');
const catalog = (name: string) => ({ id: `catalog:${name}`, name, colors: parseGhostty(THEMES[name]) });
const PICKS: [string, unknown][] = [
  ['nunchiro-light', LIGHT_PICK],
  ['nunchiro-dark', DARK_PICK],
  ['catppuccin-latte', catalog('Catppuccin Latte')],
  ['catppuccin-mocha', catalog('Catppuccin Mocha')],
];

async function seed(app: Page, core: Core) {
  const dir = core.project('demo');
  for (const l of ['Fix login test', 'Docs pass', 'Bump deps', 'Limit reached', 'Explore cache', 'Tidy imports', 'Quick look']) core.shell(dir, l);
  const set = await patchSnapshots(app);
  const states = {
    'Fix login test': { waiting: true, wt: true, ask: 'permission' as const },
    'Docs pass': { working: true, wt: true, at: Date.now() - 252_000 },
    'Bump deps': { failed: true, wt: true },
    'Limit reached': { limited: true, wt: true },
    'Explore cache': { wt: true },
  };
  set(states);
  await openWindow(app);
  await expect(app.locator('.tree .row.wt2', { hasText: 'Quick look' })).toBeVisible();
  set({ ...states, 'Tidy imports': { wt: true, exited: true }, 'Quick look': { exited: true } });
  await expect(app.locator('.tree .row.wt2.just', { hasText: 'Quick look' })).toBeVisible();
}

for (const [name, pick] of PICKS)
  for (const density of ['comfortable', 'compact'] as const)
    test(`tree_states_shot ${name} ${density} @shots`, async ({ app, core }) => {
      await app.emulateMedia({ reducedMotion: 'reduce' }); // a still picture: every light at full strength
      await app.addInitScript(([p, d]) => localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ themeMode: 'fixed', themeFixed: p, density: d, densityPicked: true })), [pick, density] as const);
      await app.setViewportSize({ width: 1100, height: 640 });
      await seed(app, core);
      await app.waitForTimeout(400);
      const suffix = density === 'compact' ? '-compact' : '';
      await app.screenshot({ path: path.join(OUT, `${name}${suffix}.png`) });
      await app.locator('.tree').screenshot({ path: path.join(OUT, `${name}${suffix}-tree.png`) });
      if (density === 'comfortable') await app.locator('.zh').first().screenshot({ path: path.join(OUT, `${name}-tabs.png`) });
    });
