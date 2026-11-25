// Settings > Keyboard grouped by area (V1A-56; needs 64, reworked by needs 166 page A): area headers in a fixed order, one jump
// row, one Change per row, titles in the conflict line.
import type { Page } from '@playwright/test';
import { AREAS } from '../src/keys';
import { expect, openWindow, test } from './fixtures';

const activeTab = (page: Page) => page.locator('.tab[aria-selected="true"]').getAttribute('data-tab');
async function keysPage(app: Page) {
  await app.keyboard.press('Meta+Comma');
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Keyboard' }).click();
  return app.locator('[data-keys-list]');
}

test('keys-sections: area headers in a fixed order, tab rename and move rows under the tabs area, ids in the tooltip', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  const keys = await keysPage(app);
  // Every command the window has today lands in a named area, so Other stays empty (tab.close has its area, needs 166).
  await expect(keys.locator('section[data-area="sessions-and-tabs"]')).toBeVisible();
  const other = await keys.locator('section[data-area="other"] [data-command]').evaluateAll((rows) => rows.map((r) => r.getAttribute('data-command')));
  expect(other, 'commands with no area: add them to AREA in web/src/keys.ts').toEqual([]);
  await expect(keys.locator('> section.karea:not(.kmode) > h3')).toHaveText(AREAS.filter((a) => a !== 'Other'));
  const tabs = keys.locator('section[data-area="sessions-and-tabs"]');
  for (const id of ['tab.rename', 'tab.move.left', 'tab.move.right', 'session.next', 'tab.close']) await expect(tabs.locator(`[data-command="${id}"]`)).toHaveCount(1);
  await expect(keys.locator('section[data-area="palette-and-window"] [data-command="zoom.in"]')).toContainText('⌘+'); // ticket 1071
  await expect(tabs.locator('[data-command="tab.move.left"] td').nth(1)).toHaveText(/<$/);
  // The id is a tooltip, not a second visible line.
  const next = tabs.locator('[data-command="session.next"] td').first();
  await expect(next.locator('.ktitle')).toHaveText('Go to the next tab'); // needs 192 (ticket 250 r3): the description follows the name
  await expect(next).toHaveAttribute('title', 'session.next');
  // A search hides the areas with no match.
  await app.getByRole('searchbox', { name: 'Search actions or keys' }).fill('font');
  await expect(keys.locator('h3')).toHaveText(['Font']);
});

test('keys-jump-one-row: one row for jump 1-9; one Change moves the nine together', async ({ app, core }) => {
  const p = core.project('demo');
  const ids = ['one', 'two', 'three'].map((l) => core.shell(p, l).id);
  await openWindow(app);
  const keys = await keysPage(app);
  for (let n = 1; n <= 9; n++) await expect(keys.locator(`[data-command="session.jump.${n}"]`)).toHaveCount(0);
  const row = keys.locator('tr[data-command="session.jump"]');
  await expect(row).toHaveCount(1);
  await expect(row.locator('td').first().locator('.ktitle')).toHaveText('Go to tab 1-9'); // needs 192 (ticket 250 r3): the description follows the name
  await expect(row.locator('td').nth(1)).toHaveText(/^⌘1-9\s*or\s*◆\s*1-9$/);
  await row.getByRole('button', { name: 'Change Go to tab 1-9' }).click();
  await app.keyboard.press('Alt+KeyJ'); // not a digit: refused, still recording
  await expect(row.getByRole('alert')).toContainText('digit');
  await app.keyboard.press('Alt+Digit4');
  await app.keyboard.press('Enter');
  await expect(row.locator('td').nth(1)).toHaveText(/^⌥1-9\s*or\s*◆\s*1-9$/);
  await app.keyboard.press('Escape'); // v25f: close the modal before the tabs behind it
  await app.locator(`.tab[data-tab="${ids[0]}"]`).click();
  await app.keyboard.press('Alt+Digit3');
  expect(await activeTab(app)).toBe(ids[2]);
  await app.keyboard.press('Meta+Comma');
  await row.getByRole('button', { name: 'Reset Go to tab 1-9' }).click();
  await expect(row.locator('td').nth(1)).toHaveText(/^⌘1-9\s*or\s*◆\s*1-9$/);
});

test('keys-conflict-title: the conflict line names the other command by its title', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  const keys = await keysPage(app);
  const row = keys.locator('tr[data-command="session.next"]');
  await row.getByRole('button', { name: 'Change Go to the next tab' }).click();
  await app.keyboard.press('Control+Period');
  await app.keyboard.press('KeyP');
  await expect(row.getByRole('alert')).toContainText('is used by “Go to the previous tab”');
  await row.getByRole('button', { name: 'Cancel' }).click();
  // The jump row checks all nine keys: ⌥2 is Go to the next tab's now, so moving the nine to ⌥ names it.
  await row.getByRole('button', { name: 'Change Go to the next tab' }).click();
  await app.keyboard.press('Alt+Digit2');
  await app.keyboard.press('Enter');
  const jump = keys.locator('tr[data-command="session.jump"]');
  await jump.getByRole('button', { name: 'Change Go to tab 1-9' }).click();
  await app.keyboard.press('Alt+Digit7');
  await expect(jump.getByRole('alert')).toContainText('is used by “Go to the next tab”');
  await jump.getByRole('button', { name: 'Replace' }).click();
  // Go to the next tab lost ⌥2 and keeps its other key; the jump row holds ⌥1-9.
  await expect(row.locator('td').nth(1)).toHaveText(/^◆\s*n$/);
  await expect(jump.locator('td').nth(1)).toHaveText(/^⌥1-9\s*or\s*◆\s*1-9$/);
});

test('keys-default-conflict: Reset on a row whose default key another command took shows the conflict, not the key as free', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  const keys = await keysPage(app);
  const files = keys.locator('tr[data-command="files.show"]');
  const search = keys.locator('tr[data-command="search.open"]');
  // Files takes Search's old prefix key (prefix s); Search keeps its other key.
  await files.getByRole('button', { name: 'Change Show or hide Files' }).click();
  await app.keyboard.press('Control+Period');
  await app.keyboard.press('KeyS');
  await expect(files.getByRole('alert')).toContainText('is used by “Search the focused session’s folder”');
  await files.getByRole('button', { name: 'Replace' }).click();
  await expect(search.locator('td').nth(1)).toHaveText(/^⇧⌘F$/);
  // Reset on Search: its prefix s is Files' now, so it says so and asks, as a recording does.
  await search.getByRole('button', { name: 'Reset Search the focused session’s folder' }).click();
  await expect(search.getByRole('alert')).toContainText('is used by “Show or hide Files”');
  await search.getByRole('button', { name: 'Cancel' }).click();
  await expect(search.locator('td').nth(1)).toHaveText(/^⇧⌘F$/);
  await expect(files.locator('td').nth(1)).toHaveText(/◆\s*s/);
  await search.getByRole('button', { name: 'Reset Search the focused session’s folder' }).click();
  await search.getByRole('button', { name: 'Replace' }).click();
  await expect(search.locator('td').nth(1)).toHaveText(/^⇧⌘F\s*or\s*◆\s*s$/);
  await expect(files.locator('td').nth(1)).toHaveText(/◆\s*x/);
  // Search holds its defaults again, so it has no Reset left; a Reset with no clash applies at once.
  await expect(search.getByRole('button', { name: /^Reset / })).toHaveCount(0);
  await files.getByRole('button', { name: 'Reset Show or hide Files' }).click();
  await expect(files.locator('td').nth(1)).toHaveText(/^⇧⌘E\s*or\s*◆\s*x$/);
  await expect(files.getByRole('alert')).toHaveCount(0);
});
