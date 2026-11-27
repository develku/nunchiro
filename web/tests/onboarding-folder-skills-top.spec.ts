// Onboarding's "Add a project without starting" adds the folder picked above it (it opened the generic Add project
// dialog instead), and Settings > Skills & hooks opens at its top with the MCP command field focused but not scrolled to.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, openWindow, test, type Core } from './fixtures';

/** Claude's own history: one conversation per folder, the file's time as its last use. */
function history(core: Core, folders: [string, number][]) {
  for (const [folder, at] of folders) {
    const dir = path.join(core.home, 'claude-home/projects', folder.replaceAll('/', '-'));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${path.basename(folder)}.jsonl`);
    fs.writeFileSync(file, JSON.stringify({ type: 'user', cwd: folder, message: { role: 'user', content: 'hello' } }) + '\n');
    fs.utimesSync(file, at / 1000, at / 1000);
  }
}
const quick = (app: Page) => app.locator('.ob-quick:not(.ob-preflight)');

test.describe('first run', () => {
  test.use({ firstRun: true });

  test('add_only_uses_the_picked_folder: the project picked in the Folder row is added, no Add project dialog', async ({ app, core }) => {
    const [older, newer] = [core.project('api-server'), core.project('my-app')];
    history(core, [
      [older, Date.now() - 5 * 86_400_000],
      [newer, Date.now() - 2 * 86_400_000],
    ]);
    await app.goto('/');
    const folder = quick(app).getByRole('combobox', { name: 'Folder' });
    await expect(folder).toHaveValue(newer, { timeout: 15_000 });
    await folder.selectOption(older);
    await quick(app).getByRole('button', { name: 'Add a project without starting' }).click();
    await expect(app.getByRole('dialog', { name: 'Add project', exact: true })).toHaveCount(0);
    await expect(app.locator('.settings')).toHaveCount(0);
    await expect(app.locator('[data-project="api-server"]').first()).toBeVisible();
    expect((core.cli('snapshot', '--json').sessions as unknown[]).length).toBe(0); // added, nothing started
  });
});

test('skills_page_opens_at_top: with no MCP server of your own, the command field is focused and the page stays at its top', async ({ app, core }) => {
  await openWindow(app, {}, core);
  await app.keyboard.press('Meta+Comma');
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Skills & hooks' }).click();
  const command = app.locator('[data-mcp="own"]').getByRole('textbox', { name: 'Command' });
  await expect(command).toBeFocused();
  await app.waitForTimeout(200);
  await expect(app.locator('#h-ext-skills')).toBeInViewport();
  // The scrolling box that holds the page is at its top.
  const top = await command.evaluate((el) => {
    for (let p = el.parentElement; p; p = p.parentElement) if (p.scrollHeight > p.clientHeight && getComputedStyle(p).overflowY !== 'visible') return p.scrollTop;
    return 0;
  });
  expect(top).toBe(0);
});
