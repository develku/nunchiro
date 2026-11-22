// Ticket 391 follow-up E and F (real-app check 11-10): Settings search on Skills & hooks. The page's alias names hooks and
// orchestration, so every row of the page matched either word and Enter took the first listed (the hook switch). A hit
// whose own label matches comes first; each hit is titled with its switch's own label.
import type { Page } from '@playwright/test';
import { expect, openWindow, test } from './fixtures';
import { openSettings } from './settings-modal';

const HOOKS = 'Add Nunchiro hooks to new sessions';
const ORCH = 'Orchestration skill for new sessions';
const found = (app: Page) => app.getByRole('list', { name: 'Matching settings' }).getByRole('button');

for (const [query, label] of [
  ['orchestration', ORCH],
  ['hooks', HOOKS],
] as const) {
  test(`extensions search: "${query}" and Enter focuses the switch "${label}", and its hit is titled with that label`, async ({ app, core }) => {
    core.shell(core.project('demo'), 'alpha');
    await openWindow(app);
    await openSettings(app);
    const search = app.getByRole('searchbox', { name: 'Search settings' });
    await search.fill(query);
    await expect(found(app).first()).toHaveText(`${label} · Skills & hooks`);
    // Every hit on the page is titled with the label its switch shows (the hook hit read the opposite: "Do not add").
    await expect(found(app).filter({ hasText: 'Do not add' })).toHaveCount(0);
    await search.press('Enter');
    const control = app.getByRole('switch', { name: label, exact: true });
    await expect(control).toBeFocused();
  });
}
