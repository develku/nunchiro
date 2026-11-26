// An own MCP server for one project (Settings > Skills & hooks): the For select beside the name sends the project folder
// to the core; the row says which project; the same name for all projects is refused in one plain line.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, openWindow, test } from './fixtures';

async function openExtensions(app: Page) {
  await app.getByRole('button', { name: 'Settings', exact: true }).click();
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Skills & hooks' }).click();
  await expect(app.getByRole('heading', { level: 1, name: 'Skills & hooks', exact: true })).toBeVisible();
}

test('mcp_for_one_project: the For select sends the project, the row names it, and the same name for all projects is refused', async ({ app, core }) => {
  const demo = core.project('demo');
  core.shell(demo, 'one');
  await openWindow(app);
  await openExtensions(app);
  const own = app.locator('[data-mcp="own"]');
  const pick = own.getByRole('combobox', { name: 'Sessions that get the server' });
  await expect(pick).toHaveValue('');
  await expect(pick.locator('option')).toHaveText(['All projects', 'demo']);
  const add = async (name: string, project: string) => {
    await own.getByRole('textbox', { name: 'Command' }).fill(`${name}-mcp --stdio`);
    await own.getByRole('textbox', { name: 'Server name' }).fill(name);
    await pick.selectOption(project);
    await own.getByRole('button', { name: 'Add for Nunchiro sessions' }).click();
  };
  await add('mine', demo);
  await expect(own).toContainText('nunchiro: mine-mcp --stdio · only demo');
  const file = () => JSON.parse(fs.readFileSync(path.join(core.home, 'extensions', 'mcp.json'), 'utf8')).mcpServers;
  expect(file().mine.project).toBe(demo);
  // All projects (the default) sends no project: the entry is written as before.
  await add('every', '');
  await expect(own).toContainText('nunchiro: every-mcp --stdio');
  expect(file().every).not.toHaveProperty('project');
  await expect(own.getByText('only demo')).toHaveCount(1);
  // The same name for all projects: one plain line, nothing changed.
  await add('mine', '');
  await expect(app.getByText(`a server named mine is already added for ${demo}; remove it first or pick another name`)).toBeVisible();
  expect(file().mine.project).toBe(demo);
});
