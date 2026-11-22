// Ticket 370 items 4 and 0: the Add project chooser from every door (the Sidebar can be hidden), and the Choose folder row
// in New session. The native panel is the only stand-in: `plugin:dialog|open` answers from a list and counts its calls.
import fs from 'node:fs';
import path from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, openWindow, test } from './fixtures';

const panel = (app: Page, ...answers: (string | null)[]) =>
  app.addInitScript((list) => {
    const w = window as unknown as { __panels: number; __TAURI_INTERNALS__: unknown };
    w.__panels = 0;
    w.__TAURI_INTERNALS__ = { invoke: async (cmd: string) => (cmd === 'plugin:dialog|open' ? (list[w.__panels++] ?? null) : null) };
  }, answers);
const panels = (app: Page) => app.evaluate(() => (window as unknown as { __panels: number }).__panels);
const chooser = (app: Page) => app.getByRole('dialog', { name: 'Add project', exact: true });
const browse = (app: Page) => chooser(app).getByRole('button', { name: /^Browse folder/ });
const popover = (app: Page) => app.getByRole('dialog', { name: 'New tab' });
const folderRow = (app: Page) => popover(app).getByRole('option', { name: /^Choose folder…/ });

async function runAddProject(app: Page) {
  await app.keyboard.press('Meta+KeyK');
  await app.getByRole('dialog', { name: 'Command palette' }).getByRole('combobox').fill('Add project');
  await app.keyboard.press('Enter');
}

test('chooser_from_palette_with_sidebar_hidden: Browse folder has the focus and Enter reaches the folder panel', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await panel(app, null);
  await openWindow(app);
  await app.keyboard.press('Meta+KeyB');
  await expect(app.getByRole('button', { name: '+ Project' })).toHaveCount(0);
  await runAddProject(app);
  await expect(browse(app)).toBeFocused();
  await app.keyboard.press('Enter');
  await expect(popover(app)).toBeVisible();
  await expect.poll(() => panels(app)).toBe(1);
  await expect(chooser(app)).toHaveCount(0);
});

test('chooser_steps: three options in order, Esc closes, Create new and Clone come back with the arrow', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  const add = app.getByRole('button', { name: '+ Project' });
  await add.press('Enter'); // by key: WebKit does not focus a clicked button, so a click leaves no focus to give back
  await expect(browse(app)).toBeFocused();
  await expect(chooser(app).locator('button')).toHaveText([/^Browse folder/, /^Create new/, /^Clone/, 'Cancel']);
  expect((await new AxeBuilder({ page: app }).include('dialog').analyze()).violations).toEqual([]);
  await app.screenshot({ path: `../.scratch/shots-v28-proj-add/chooser-${test.info().project.name}.png` });

  await chooser(app).getByRole('button', { name: /^Create new/ }).click();
  const form = app.getByRole('dialog', { name: 'New project' });
  await expect(form.getByLabel('Name')).toBeFocused();
  await form.getByRole('button', { name: 'Back' }).click();
  await expect(browse(app)).toBeVisible();

  await chooser(app).getByRole('button', { name: /^Clone/ }).click();
  const clone = app.getByRole('dialog', { name: 'Clone a repository' });
  await expect(clone.getByLabel('Git URL')).toBeFocused();
  await clone.getByRole('button', { name: 'Back' }).click();
  await expect(browse(app)).toBeFocused();

  await app.keyboard.press('Escape');
  await expect(chooser(app)).toHaveCount(0);
  await expect(add).toBeFocused();
});

test('fresh_install_add_project: the centre button opens the chooser; a cancelled panel leaves a Choose folder row that works', async ({ app, core }) => {
  const picked = core.project('picked');
  await panel(app, null, picked);
  await openWindow(app);
  await app.locator('.landing').getByRole('button', { name: 'Add project' }).click();
  await browse(app).press('Enter');
  await expect.poll(() => panels(app)).toBe(1);

  // Cancelled: nothing was chosen for the user, and the popover still works.
  await expect(folderRow(app)).toHaveAttribute('aria-selected', 'true');
  await expect(popover(app).locator('.nt-in')).toHaveText('No folder yet. Choose one to start an agent.');
  await expect(popover(app).getByRole('alert')).toHaveCount(0);
  await expect(popover(app).getByRole('combobox')).toBeFocused();
  await app.screenshot({ path: `../.scratch/shots-v28-proj-add/newfolder-${test.info().project.name}.png` });

  await app.keyboard.press('Enter');
  await expect.poll(() => panels(app)).toBe(2);
  await expect(popover(app).locator('.nt-in')).toHaveAttribute('title', picked);
  await expect(folderRow(app)).toHaveCount(0);
  // The core writes tree.toml just after the window shows the pick; a throwing read would end the poll, so missing is ''.
  const tree = path.join(core.home, 'tree.toml');
  await expect.poll(() => (fs.existsSync(tree) ? fs.readFileSync(tree, 'utf8') : '')).toContain(picked);
});

test('new_session_no_folder_does_not_open_the_panel: only Browse folder asks at once; here the row is listed and no panel opened', async ({ app }) => {
  await panel(app, null);
  await openWindow(app);
  const ask = () => app.evaluate(() => window.dispatchEvent(new CustomEvent('nunchiro:session.new', { detail: {} })));
  await ask();
  await expect(folderRow(app)).toBeVisible();
  expect(await panels(app)).toBe(0);
  await app.keyboard.press('Escape');
  await expect(popover(app)).toHaveCount(0);
});

test('tree_empty_button_opens_the_chooser', async ({ app }) => {
  await openWindow(app);
  await app.locator('.tree .empty').getByRole('button').click();
  await expect(browse(app)).toBeFocused();
});

test('chooser_over_an_open_popover: Browse folder still reaches the panel (asking again would have closed the popover)', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await panel(app, null);
  await openWindow(app);
  await app.evaluate(() => window.dispatchEvent(new CustomEvent('nunchiro:session.new', { detail: {} })));
  await expect(popover(app)).toBeVisible();
  await expect(folderRow(app)).toHaveCount(0); // this window has a project, so the popover has its folder
  await runAddProject(app);
  await expect(browse(app)).toBeFocused();
  await app.keyboard.press('Enter');
  await expect(popover(app)).toBeVisible();
  await expect.poll(() => panels(app)).toBe(1);
});

test('typed_folder_is_added_like_a_pick: with no folder panel, a typed path adds the project although the popover is dismissed', async ({ app, core }) => {
  // Walk 8 (ticket 700): the panel failed, the hint said to type the path, and Esc after Start in folder added nothing.
  const typed = core.project('typed');
  await openWindow(app);
  await app.locator('.landing').getByRole('button', { name: 'Add project' }).click();
  await browse(app).press('Enter');
  await expect(popover(app).getByRole('alert')).toHaveText("Could not open the folder picker. Type the folder path in the search instead.");
  await popover(app).getByRole('combobox').fill(typed);
  await popover(app).getByRole('option', { name: new RegExp(`^${typed}`) }).click();
  await expect(popover(app).locator('.nt-in')).toHaveAttribute('title', typed);
  await app.keyboard.press('Escape');
  await expect(popover(app)).toHaveCount(0);
  await expect(app.locator('.tree').getByText('typed', { exact: true })).toBeVisible();
});

test('typed_missing_folder_is_not_added: the core refuses a typed path that is not a folder and the popover says why', async ({ app, core }) => {
  // Ticket 702: a typo such as <home>/p/no-such-folder became a project row whose sessions failed with "not there".
  const demo = core.project('demo');
  core.shell(demo, 'alpha');
  const missing = path.join(path.dirname(demo), 'no-such-folder');
  await openWindow(app);
  await app.evaluate(() => window.dispatchEvent(new CustomEvent('nunchiro:session.new', { detail: {} })));
  await popover(app).getByRole('combobox').fill(missing);
  await popover(app).getByRole('option', { name: new RegExp(`^${missing}`) }).click();
  await expect(popover(app).getByRole('alert')).toContainText('Not added to the tree: That file or folder is not there. Check the path, then try again.');
  await app.keyboard.press('Escape');
  await expect(popover(app)).toHaveCount(0);
  await expect(app.locator('.tree').getByText('no-such-folder', { exact: true })).toHaveCount(0);
  const tree = path.join(core.home, 'tree.toml');
  expect(fs.existsSync(tree) ? fs.readFileSync(tree, 'utf8') : '').not.toContain('no-such-folder');
});
