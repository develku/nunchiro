// ux-fix-1 (owner feedback 2026-10-28): the prefix shown as its symbol, the project "+" explained, New worktree in the
// project menu, Choose folder… in New session, the footer prefix button, the shorter tree title.
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, openWindow, test, type Core } from './fixtures';
import { openQuiet } from './tree-seed';

const start = async (app: Page, core: Core) => {
  core.shell(core.project('demo'), 'alpha');
  openQuiet(core);
  await openWindow(app);
};
const bodyText = (app: Page) => app.evaluate(() => document.body.innerText);
const axe = async (app: Page, selector: string) => expect((await new AxeBuilder({ page: app }).include(selector).analyze()).violations).toEqual([]);

test('prefix_chip_everywhere: no "prefix +" or "After the prefix" in the UI; chips follow a changed prefix', async ({ app, core }) => {
  await start(app, core);
  // Palette rows: the chip, spelled out for a screen reader.
  await app.keyboard.press('Meta+KeyK');
  const row = app.locator('[data-command="hints.show"]');
  await expect(row).toContainText('◆ f');
  await expect(row.getByRole('img', { name: 'Control period, then F' })).toBeVisible();
  expect(await bodyText(app)).not.toMatch(/prefix \+/);
  await app.keyboard.press('Escape');
  // Settings > Keys: the headings and the Edit chooser name the prefix by its symbol.
  await app.keyboard.press('Meta+Comma');
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Keyboard' }).click();
  await expect(app.locator('tr[data-command="session.next"] .kcaps').nth(1)).toContainText('◆'); // needs 166: the chip then the key, in the row
  const text = await bodyText(app);
  expect(text).not.toMatch(/prefix \+|After the prefix/i);
  await axe(app, '[role="region"][aria-label="Settings"]');
  // Change the prefix: every chip follows.
  const top = app.locator('[data-command="prefix"]');
  await top.getByRole('button', { name: /^Change / }).click();
  await app.keyboard.press('Control+KeyB');
  await app.keyboard.press('Enter');
  await expect(app.locator('tr[data-command="session.next"] .kcaps').nth(1)).toContainText('◆');
  await app.keyboard.press('Meta+KeyK');
  await expect(app.getByRole('dialog', { name: 'Command palette' }).locator('[data-command="hints.show"]')).toContainText('◆ f');
  await app.keyboard.press('Escape');
  await app.keyboard.press('Control+KeyB');
  await expect(app.locator('.prefix-armed')).toHaveText('⌃B …');
});

test('plus_explained: the project "+" says what it does and shows on keyboard focus', async ({ app, core }) => {
  await start(app, core);
  const plus = app.locator('.tree .padd').first();
  await expect(plus).toHaveAttribute('aria-label', 'New session in demo');
  await expect(plus).toHaveAttribute('title', /^New session in .*demo$/);
  await expect(plus).toBeHidden();
  await app.locator('.tree .grp[data-project] .row.head .n').first().focus(); // the project's head, not the Assistants group's (ticket 1032)
  await expect(plus).toBeVisible(); // focus inside the row shows it, with no hover
  await plus.focus(); // WebKit's Tab skips buttons unless full keyboard access is on
  await expect(plus).toBeVisible();
  await app.keyboard.press('Enter');
  await expect(app.getByRole('dialog', { name: 'New tab' })).toBeVisible(); // v25-new-tab: the popover (needs 209)
});

test('new_worktree_menu: the project context menu has New worktree… and it opens the create flow', async ({ app, core }) => {
  await start(app, core);
  await app.locator('.tree .grp[data-project] .row.head .n').first().click({ button: 'right' });
  const menu = app.getByRole('menu');
  await axe(app, '[role="menu"]');
  await menu.getByRole('menuitem', { name: /New worktree…/ }).click();
  await expect(app.getByRole('dialog', { name: 'New worktree' })).toBeVisible();
});

test('choose_folder: "+ Project" opens the folder picker at once and the popover starts in the picked folder; without one the search takes focus', async ({ app, core }) => {
  await start(app, core);
  const ask = () => app.evaluate(() => window.dispatchEvent(new CustomEvent('nunchiro:session.new', { detail: { project: '' } })));
  const dialog = app.getByRole('dialog', { name: 'New tab' });
  await ask();
  await expect(dialog.getByRole('combobox')).toBeFocused(); // no native picker here: the search stays to type a folder in
  await axe(app, '.newtab');
  await app.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  // The app's dialog plugin answers with a path (mocked: this is Chromium or WebKit, not the Tauri webview). A real folder:
  // the core refuses adding a missing one (ticket 702).
  const picked = core.project('picked');
  await app.evaluate((p) => {
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = { invoke: async (cmd: string) => (cmd === 'plugin:dialog|open' ? p : null) };
  }, picked);
  await ask();
  await expect(dialog.locator('.nt-in')).toHaveAttribute('title', picked);
});

test('footer_help: the status bar has no keys chip (ticket 1031); ⌘/ opens the keys overview', async ({ app, core }) => {
  await start(app, core);
  await expect(app.locator('.status .keyhelp')).toHaveCount(0);
  await expect(app.locator('.status')).not.toContainText('keys');
  await app.keyboard.press('Meta+Slash');
  await expect(app.locator('.prefix-help')).toBeVisible();
  await expect(app.locator('.prefix-armed')).toBeVisible();
  await app.keyboard.press('Escape');
  await expect(app.locator('.prefix-help')).toHaveCount(0);
  await axe(app, '.status');
});

test('tree_title_short: the tree header reads Projects', async ({ app, core }) => {
  await start(app, core);
  await expect(app.locator('.dock.l .ph')).toContainText('Projects');
  expect(await bodyText(app)).not.toMatch(/where work runs/i);
});
