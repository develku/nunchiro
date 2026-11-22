// Ticket 370 items 2 and 10: every project row has a working menu, also with no session, and a project can be renamed,
// copied and revealed. Reveal itself needs the Tauri shell: here it is only listed; the real RC proves it opens Finder.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, openWindow, test, type Core } from './fixtures';
import { openQuiet, seed } from './tree-seed';

const grp = (app: Page, name: string) => app.locator(`.grp[data-project="${name}"]`);
const head = (app: Page, name: string) => grp(app, name).locator('.head .n');
const menu = (app: Page) => app.getByRole('menu', { name: 'Actions' });
const pick = (app: Page, id: string) => menu(app).locator(`[data-command="${id}"]`).click();
const ids = (app: Page) => menu(app).locator('[data-command]').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.command));
const toml = (core: Core) => fs.readFileSync(path.join(core.home, 'tree.toml'), 'utf8');
/** Pins and groups hold still while the pointer or focus rests in the tree (needs 49): on a row with no session focus stays there until the idle bound. */
const HELD = { timeout: 10_000 };
const pins = (core: Core) => /pins = (\[[^\]]*\])/.exec(toml(core))?.[1] ?? '';

/** alpha holds the active session; beta was added from its folder and started nothing. */
function added(core: Core) {
  const alpha = core.project('alpha');
  const beta = core.project('beta');
  core.shell(alpha, 'notes');
  seed(core, { op: 'add', project: beta, added: true });
  openQuiet(core);
  return { alpha, beta };
}

test('project_menu_no_session_targets_its_row: Pin, New group and Remove from group act on the session-less row, with another session active', async ({ app, core }) => {
  const { alpha, beta } = added(core);
  await openWindow(app);
  await head(app, 'beta').click({ button: 'right' });
  // Nothing that would act on the active session's project is offered. Ticket 990: lead.add reads the row's project
  // (TAKES_PROJECT), so the session-less row offers Add a leader… too.
  expect(await ids(app)).toEqual(['lead.add', 'group.move', 'group.create', 'project.pin', 'path.copy', 'path.reveal', 'project.rename']);
  await pick(app, 'project.pin');
  await expect.poll(() => pins(core)).toContain(beta);
  expect(pins(core)).not.toContain(alpha);
  await expect(grp(app, 'beta').locator('.pin-mark')).toBeVisible(HELD);

  await head(app, 'beta').click({ button: 'right' });
  await pick(app, 'group.create');
  const dialog = app.getByRole('dialog', { name: 'New group' });
  await dialog.getByRole('textbox').fill('Web');
  await app.keyboard.press('Enter');
  const web = app.locator('.pgrp[data-group="Web"]');
  await expect(web.locator('.grp[data-project="beta"]')).toHaveCount(1, HELD);
  await expect(web.locator('.grp[data-project="alpha"]')).toHaveCount(0);

  await head(app, 'beta').click({ button: 'right' });
  await pick(app, 'group.remove');
  await expect(app.locator('.pgrp[data-group="Web"]')).toHaveCount(0, HELD);
  await expect(head(app, 'beta')).toBeVisible();
});

test('project_no_session_opens_new_session: clicking the name and choosing it in the project picker open New session on that folder', async ({ app, core }) => {
  const { beta } = added(core);
  await openWindow(app);
  const popover = app.getByRole('dialog', { name: 'New tab' }).locator('.nt-in');
  await head(app, 'beta').click();
  await expect(popover).toHaveAttribute('title', beta);
  await app.keyboard.press('Escape');
  await expect(popover).toHaveCount(0);

  await app.keyboard.press('Meta+KeyK');
  const palette = app.getByRole('dialog', { name: 'Command palette' });
  await palette.getByRole('combobox').fill('Projects by status');
  await app.keyboard.press('Enter');
  await expect(palette).toHaveCount(0);
  await app.locator(`.tpick [data-key="${beta}"]`).click(); // listed only because the picker now has added projects
  await expect(popover).toHaveAttribute('title', beta);
});

test('project_rename_keeps_path_and_survives_restart: Copy path, then a name that shows, keeps the path tooltip, survives a restart and clears when empty', async ({ app, core }) => {
  const { beta } = added(core);
  await app.addInitScript(() => {
    const w = window as unknown as { __clip: string[] };
    w.__clip = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t: string) => void w.__clip.push(t) } });
  });
  await openWindow(app);
  await head(app, 'beta').click({ button: 'right' });
  await pick(app, 'path.copy');
  await expect.poll(() => app.evaluate(() => (window as unknown as { __clip: string[] }).__clip)).toEqual([beta]);

  await head(app, 'beta').click({ button: 'right' });
  await pick(app, 'project.rename');
  const dialog = app.getByRole('dialog', { name: 'Rename project' });
  const field = dialog.getByRole('textbox', { name: 'Project name' });
  await expect(field).toHaveValue('beta');
  await field.fill('api-staging');
  await app.keyboard.press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect(head(app, 'api-staging')).toHaveAttribute('title', new RegExp(beta));
  expect(toml(core)).toContain('api-staging');

  core.run(['serve', 'stop', '--yes']);
  await core.restart();
  // A fresh core writes a fresh window token: the window opens again with it.
  await app.addInitScript((boot) => void (window.__NUNCHIRO__ = boot), core.boot());
  await app.goto('/');
  await expect(head(app, 'api-staging')).toBeVisible();

  // Esc cancels.
  await head(app, 'api-staging').click({ button: 'right' });
  await pick(app, 'project.rename');
  await expect(field).toHaveValue('api-staging');
  await field.fill('nope');
  await app.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(head(app, 'api-staging')).toBeVisible();

  // Empty goes back to the folder name and takes the key out of the file.
  await head(app, 'api-staging').click({ button: 'right' });
  await pick(app, 'project.rename');
  await field.fill('');
  await app.keyboard.press('Enter');
  await expect(head(app, 'beta')).toBeVisible();
  await expect.poll(() => toml(core)).not.toContain('names');
});

test('project_rows_with_a_session_offer_the_folder_items: the mock\'s order, the name in the picker follows a rename', async ({ app, core }) => {
  const { alpha } = added(core);
  await openWindow(app);
  await grp(app, 'alpha').locator('.head .n').click({ button: 'right' });
  const got = await ids(app);
  expect(got.slice(-4)).toEqual(['path.copy', 'path.reveal', 'project.rename', 'project.remove']);
  expect(got).toContain('session.new');
  await expect(menu(app).locator('.msep')).toHaveCount(2);
  await expect(menu(app).locator('.msep + [data-command="project.remove"]')).toHaveCount(1);
  await expect(menu(app).locator('.msep + [data-command="path.copy"]')).toHaveCount(1);
  await pick(app, 'project.rename');
  const field = app.getByRole('dialog', { name: 'Rename project' }).getByRole('textbox');
  await field.fill('renamed');
  await app.keyboard.press('Enter');
  await expect(head(app, 'renamed')).toBeVisible();
  await expect(head(app, 'renamed')).toHaveAttribute('title', new RegExp(alpha));

  // The row's folder is not a file: Open Diff opens the list with nothing selected.
  await app.evaluate(() => {
    const w = window as unknown as { __diff: (string | null)[] };
    w.__diff = [];
    window.addEventListener('nunchiro:diff.open', (e) => w.__diff.push((e as CustomEvent<{ path?: string }>).detail.path ?? null));
  });
  await head(app, 'renamed').click({ button: 'right' });
  await pick(app, 'diff.open');
  const diff = app.getByRole('complementary', { name: 'Diff' });
  await expect(diff).toBeVisible();
  expect(await app.evaluate(() => (window as unknown as { __diff: (string | null)[] }).__diff)).toEqual([null]);
  await expect(diff.locator('.dfiles [aria-pressed="true"]')).toHaveCount(0);
});

// Ticket 990 lead.add shows only for a project without a lead, read from the right-clicked row. The press on an item must
// not clear that row (it did: lead.add vanished between pointerdown and click, the items moved up a row and the click
// missed it (Remove from tree in errors-plain.spec.ts:304 and project-remove.spec.ts:293, with no active session).
test('project_menu_items_hold_under_the_press: with no active session the items stay put from pointerdown to click', async ({ app, core }) => {
  const beta = core.project('beta');
  seed(core, { op: 'add', project: beta, added: true });
  openQuiet(core);
  await openWindow(app);
  await head(app, 'beta').click({ button: 'right' });
  const before = await ids(app);
  expect(before).toContain('lead.add');
  const box = (await menu(app).locator('[data-command="project.rename"]').boundingBox())!;
  await app.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await app.mouse.down();
  await app.waitForTimeout(200);
  expect(await ids(app)).toEqual(before);
  await app.mouse.up();
  await expect(app.getByRole('dialog')).toBeVisible(); // Rename…, the item pressed
});
