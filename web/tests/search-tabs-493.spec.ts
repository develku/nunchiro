// Ticket 493 (검색에서 파일→세션으로 바꾸면 검색어가 지워짐): Search's words survive a Files/Sessions switch, and a Files
// "No matches" offers the Sessions search for the same words (as the Sessions empty state offers Files).
import path from 'node:path';
import type { Page } from '@playwright/test';
import { REPO } from './fixtures';
import { append, expect, rec, test } from './fixtures/chat/harness';

const panel = (page: Page) => page.locator('.sbar .spanel');
const field = (page: Page) => panel(page).locator('.sscope:not([hidden])').getByRole('searchbox');
const stat = (page: Page) => panel(page).locator('.sscope:not([hidden]) .sstat');
const shot = (name: string) => path.join(REPO, '.scratch/shots', `493-${name}-${test.info().project.name}.png`);

async function openFiles(page: Page, id: string) {
  await page.goto('/');
  await expect(page.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  await page.locator(`.tab[data-tab="${id}"]`).click();
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(panel(page).getByRole('radio', { name: 'Files' })).toHaveAttribute('aria-checked', 'true');
  await expect(field(page)).toBeEnabled();
}

test('search_query_survives_scope_switch: the words typed in Files are in Sessions after the switch, and back', async ({ page, chatCore: core }) => {
  const s = core.chat('alpha');
  append(s.file, rec.user('Fix the purple login button'));
  await openFiles(page, s.id);
  await field(page).fill('purple login');
  await expect(stat(page)).toHaveText('No matches');
  await panel(page).getByRole('radio', { name: 'Sessions' }).click();
  await expect(field(page)).toHaveAccessibleName('Search sessions');
  await expect(field(page)).toHaveValue('purple login');
  await expect(stat(page)).toHaveText('1 match in 1 session');
  // Changed in Sessions, the new words go back to Files.
  await field(page).fill('purple');
  await panel(page).getByRole('radio', { name: 'Files' }).click();
  await expect(field(page)).toHaveValue('purple');
});

test('files_empty_offers_sessions: a Files "No matches" offers Search sessions, which searches the same words there', async ({ page, chatCore: core }) => {
  const s = core.chat('beta');
  append(s.file, rec.user('Fix the purple login button'), rec.assistant('The login button is purple now.'));
  await openFiles(page, s.id);
  await field(page).fill('purple login');
  await expect(stat(page)).toHaveText('No matches');
  const offer = panel(page).getByRole('button', { name: 'Search sessions' });
  await expect(offer).toBeVisible();
  await panel(page).screenshot({ path: shot('files-empty') });
  await offer.click();
  await expect(panel(page).getByRole('radio', { name: 'Sessions' })).toHaveAttribute('aria-checked', 'true');
  await expect(field(page)).toHaveValue('purple login');
  await expect(stat(page)).toHaveText('1 match in 1 session');
  await panel(page).screenshot({ path: shot('sessions-from-files') });
  // A cleared field offers nothing.
  await panel(page).getByRole('radio', { name: 'Files' }).click();
  await field(page).fill('');
  await expect(offer).toHaveCount(0);
});
