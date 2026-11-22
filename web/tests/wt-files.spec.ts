// Ticket 253 (G22), ticket 1040: Settings › Projects › a project › Worktrees (features/wt-files.tsx) saves per project to
// the core's `worktree.shared`; a path outside the project is refused by the core and never stored.
import fs from 'node:fs';
import path from 'node:path';
import { expect, openWindow, test, type Core } from './fixtures';

const stored = (core: Core) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(core.home, 'settings.json'), 'utf8')).features?.['worktree.shared'];
  } catch {
    return undefined;
  }
};

test('git_page_shared_files_rows_per_project_scope', async ({ app, core }) => {
  const one = core.project('one');
  const two = core.project('two');
  core.shell(one, 'alpha');
  core.shell(two, 'beta');
  await openWindow(app);
  await app.getByRole('navigation', { name: 'Left bar' }).getByRole('button', { name: 'Settings' }).click();
  // Ticket 1040: the settings search finds the rows and opens Projects (the list: the field needs a project); the
  // project's own page holds them, with no project select.
  await app.getByRole('searchbox', { name: 'Search settings' }).fill('sparse checkout');
  await app.getByRole('list', { name: 'Matching settings' }).getByRole('button', { name: /Sparse checkout/ }).click();
  await expect(app.locator('.settings header.phd h1')).toHaveText('Projects');
  const openProject = async (name: string) => {
    const back = app.locator('.pj-one').getByRole('button', { name: 'Projects', exact: true });
    if (await back.count()) await back.click();
    await app.locator('.pj-row').filter({ hasText: name }).locator('.pj-open').click();
    await expect(app.locator('.pj-one').getByRole('heading', { level: 2, name })).toBeVisible();
  };
  await app.waitForTimeout(3100); // a search hit keeps looking for its field for 3 s (SettingsView `want`) and would take the focus from the typing below
  await openProject('two');
  const sec = app.locator('.sbody').getByRole('region', { name: 'Worktrees' });
  await expect(sec.locator('.srow .snm').filter({ hasText: /Shared files|Sparse checkout/ })).toHaveText(['Shared files', 'Sparse checkout']);
  await expect(sec.locator('select')).toHaveCount(0);
  // A path is added as Link, the default, for the chosen project only.
  const add = sec.getByLabel('Path to share', { exact: true });
  await add.fill('.env');
  await add.press('Enter');
  await expect.poll(() => stored(core)?.[two]?.files).toEqual([{ path: '.env', mode: 'link' }]);
  expect(stored(core)?.[one]).toBeUndefined();
  await expect(add).toHaveValue('');
  await sec.getByRole('radiogroup', { name: 'How .env is shared' }).getByRole('radio', { name: 'Copy' }).click();
  await expect.poll(() => stored(core)?.[two]?.files).toEqual([{ path: '.env', mode: 'copy' }]);
  // The core refuses a path outside the project; the row says why and nothing is stored.
  await add.fill('../secret');
  await add.press('Enter');
  await expect(sec.locator('.err')).toContainText('outside the project');
  expect(stored(core)?.[two]?.files).toHaveLength(1);
  // Sparse folders, one per line, save when the box loses focus.
  await sec.getByLabel('Sparse checkout', { exact: true }).fill('web\n\n docs \n');
  await add.focus();
  await expect.poll(() => stored(core)?.[two]?.sparse).toEqual(['web', 'docs']);
  // The other project has none of it.
  await openProject('one');
  await expect(sec.getByText('No shared files yet.')).toBeVisible();
  await expect(sec.getByLabel('Sparse checkout', { exact: true })).toHaveValue('');
  // Removing the last path and resetting the folders drops the project's entry.
  await openProject('two');
  await sec.getByRole('button', { name: 'Remove .env' }).click();
  await sec.getByRole('button', { name: /Reset Sparse checkout/ }).click();
  await expect.poll(() => stored(core)).toBeUndefined();
});
