// ux-fix-2 (UXFIX a-e, owner decision 2026-10-28): "+ Project" at the tree head, the Keys page as area cards with one big
// keyboard, the board as a centre tab, text labels under the rail icons, "Lifetime" renamed. One named test per promise.
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, openWindow, test, type Core, agentsZone } from './fixtures';
import { openQuiet } from './tree-seed';
import { closeModal } from './settings-modal';

test.beforeEach(({ core }) => agentsZone(core)); // D5b: the default window has no AGENTS rows

const start = async (app: Page, core: Core) => {
  core.shell(core.project('demo'), 'alpha');
  openQuiet(core);
  await openWindow(app);
};
const settingsNav = (app: Page) => app.getByRole('navigation', { name: 'Settings pages' });
const openKeys = async (app: Page) => {
  await app.getByRole('button', { name: 'Settings', exact: true }).click();
  await settingsNav(app).getByRole('button', { name: 'Keyboard' }).click();
};
const axe = async (app: Page, selector: string) => expect((await new AxeBuilder({ page: app }).include(selector).analyze()).violations).toEqual([]);

test('a1: a labelled "+ Project" button heads the tree, visible without hover, and opens the New tab popover on the folder picker', async ({ app, core }) => {
  await start(app, core);
  const add = app.locator('.agents ~ .tree, aside').getByRole('button', { name: '+ Project' }).first();
  await expect(add).toBeVisible();
  await axe(app, 'aside[aria-label="Tree"]');
  await add.click();
  await app.getByRole('dialog', { name: 'Add project' }).getByRole('button', { name: /^Browse folder/ }).click(); // ticket 370: "+ Project" opens the chooser
  // v25-new-tab (needs 209): the popover asks for the folder at once (no native picker here: the search takes focus); no folder is named yet.
  const dialog = app.getByRole('dialog', { name: 'New tab' });
  await expect(dialog.getByRole('combobox')).toBeFocused();
  await expect(dialog.locator('.nt-in')).not.toHaveAttribute('title', /./); // a new project, not the last one
});

test('b1: Keys groups bindings into area sections; a command without a key shows a dash and the No key chip lists them', async ({ app, core }) => {
  // needs 166 (page A) replaced the per-card fold "N commands without a key" with the No key chip; the dash row stays visible.
  await start(app, core);
  await openKeys(app);
  expect(await app.locator('[data-keys-list] section.karea:not(.kmode)').count()).toBeGreaterThanOrEqual(3);
  await expect(app.getByRole('button', { name: /Show unbound/ })).toHaveCount(0); // no page-wide toggle
  const none = app.locator('[data-keys-list] tr[data-command] td.kcell .knokey');
  expect(await none.count()).toBeGreaterThan(0);
  await expect(none.first()).toHaveText('none');
  const chip = app.getByRole('group', { name: 'Filter actions' }).getByRole('button', { name: /^No key \d+$/ });
  await chip.click();
  await expect(chip).toHaveAttribute('aria-pressed', 'true');
  const rows = await app.locator('[data-keys-list] tr[data-command]').count();
  expect(rows).toBe(await none.count()); // every listed row is an unbound one
  await axe(app, '[role="region"][aria-label="Settings"]');
});

test('b2: the prefix is the configured key chip everywhere on the page; a changed binding is marked', async ({ app, core }) => {
  await start(app, core);
  await openKeys(app);
  const page = app.locator('.sbody');
  await expect(page.locator('tr[data-command="session.next"] .kcaps').nth(1)).toContainText('◆'); // the prefix shows as its symbol ◆ since 50239d412
  // A changed binding carries a mark; the untouched rows carry none.
  await expect(page.locator('.ov')).toHaveCount(0);
  const row = page.locator('[data-command="font.bigger"]');
  await row.getByRole('button', { name: /Change/ }).click(); // needs 166: press the chord, Enter saves
  await app.keyboard.press('Control+Alt+KeyU');
  await app.keyboard.press('Enter');
  await expect(row.locator('.ov')).toHaveText('Changed by you');
  await expect(page.locator('.ov')).toHaveCount(1);
  // Change the prefix: every chip on the page follows, none says "prefix +" or "After the prefix".
  const top = page.locator('[data-command="prefix"]');
  await top.getByRole('button', { name: /Change/ }).click();
  await app.keyboard.press('Control+KeyB');
  await app.keyboard.press('Enter');
  await expect(page.locator('[data-keys-list] section:not([data-area="prefix"]) tr[data-command="session.next"] .kcaps').nth(1).locator('[data-tip]').first()).toHaveAttribute('data-tip', /⌃B/); // the chip shows ◆, its tip spells the new prefix (50239d412)
  const text = await page.locator('[data-keys-list] section[data-area]:not([data-area="prefix"]):not(.kmode)').evaluateAll((els) => els.map((e) => (e as HTMLElement).innerText).join('\n'));
  expect(text).not.toMatch(/prefix \+|After the prefix|⌃\. /);
});

test('b3: the Keyboard page has Shortcuts and Hints tabs; the one large keyboard is on Hints with the alphabet and Advanced', async ({ app, core }) => {
  // needs 118 (hints2) replaced the 'Set index keys' button with the alphabet field; needs 166 (page A) took the key map off the page.
  await start(app, core);
  await openKeys(app);
  // needs 192 (ticket 250): one page, no tabs; the keyboard drawing is in the hints part at its end.
  await expect(app.locator('.settings').getByRole('tablist')).toHaveCount(0);
  await expect(app.locator('.settings').getByRole('tab', { name: 'Key map' })).toHaveCount(0);
  await expect(app.locator('.sbody [data-keys-list] .hk-board')).toHaveCount(0); // the list itself holds no keyboard
  await app.getByRole('button', { name: 'Options ↓' }).click();
  await app.locator('details.hk-adv > summary').click(); // final.html: the drawing is in the closed Advanced fold
  const board = app.locator('.sbody').getByRole('group', { name: 'Keyboard' });
  await expect(board).toHaveCount(1);
  await expect(app.locator('.sbody .hk-board')).toHaveCount(1);
  await board.scrollIntoViewIfNeeded();
  expect((await app.locator('.sbody [data-code="KeyG"]').boundingBox())!.width).toBeGreaterThanOrEqual(56);
  const hints = app.getByRole('region', { name: 'Hints', exact: true });
  await expect(hints.getByRole('textbox', { name: 'Hint alphabet' })).toBeVisible();
  await expect(hints.getByRole('group', { name: 'Advanced' })).toBeVisible();
  expect((await board.boundingBox())!.y).toBeGreaterThan((await hints.boundingBox())!.y);
  await axe(app, '[role="region"][aria-label="Settings"]');
});

test('reveal_only_on_open: a chosen widget tab stays through a session tab switch; opening from the tree returns to the terminal', async ({ app, core }) => {
  const p = core.project('demo');
  for (const l of ['alpha', 'beta']) core.shell(p, l);
  openQuiet(core);
  await openWindow(app);
  core.cli('layout', 'stack', 'preview');
  const zone = app.locator('[data-zone-id="terminal"]');
  const tab = (name: string) => zone.getByRole('tab', { name, exact: true });
  await tab('Preview').click();
  await expect(tab('Preview')).toHaveAttribute('aria-selected', 'true');
  // The session changes from the keyboard (prefix n, then prefix p): the Preview the user chose stays.
  for (const k of ['KeyN', 'KeyP']) {
    await app.keyboard.press('Control+Space');
    await app.keyboard.press(k);
    await expect(tab('Preview')).toHaveAttribute('aria-selected', 'true');
  }
  await app.getByRole('region', { name: 'Agents' }).getByRole('button', { name: /^beta/ }).click(); // opening a session shows it
  await expect(tab('Terminal')).toHaveAttribute('aria-selected', 'true');
});

test('c1: the board opens as a large modal with all 5 columns visible at 1440x900', async ({ app, core }) => {
  await start(app, core);
  await app.getByRole('button', { name: /^Board( · |$)/ }).click();
  // v25f (D-20261108-10): the Board is a modal over the workspace, no longer a centre tab in the terminal zone.
  const panel = app.getByRole('dialog', { name: 'Board' });
  const board = panel.locator('.board');
  await expect(board).toBeVisible();
  const cols = app.locator('.board .bcol[data-column]'); // column heads: each column's lane cells carry data-column too
  await expect(cols).toHaveCount(5); // needs 154 (6): To do, Working, Needs decision, Review, Done
  const zone = (await panel.boundingBox())!;
  expect(zone.width).toBeGreaterThan(264 * 2); // not the 264 px edge widget
  for (const c of await cols.all()) {
    const b = (await c.boundingBox())!;
    expect(b.x).toBeGreaterThanOrEqual(zone.x - 1);
    expect(b.x + b.width).toBeLessThanOrEqual(zone.x + zone.width + 1);
  }
  await axe(app, '[role="dialog"][aria-label="Board"]');
  await app.getByRole('button', { name: 'Close Board' }).click(); // the modal covers the rail's Board button: its own close button
  await expect(app.locator('.board')).toHaveCount(0);
});

// Ticket 1041 (owner 2026-11-22): icons only; each name is the icon's accessible name and its tooltip.
test('d1: every rail icon is named in its tooltip', async ({ app, core }) => {
  await start(app, core);
  const icons = app.locator('.ib .ai');
  expect(await icons.count()).toBeGreaterThanOrEqual(7);
  for (const i of await icons.all()) {
    await expect(i.locator('.al')).toHaveCount(0);
    expect((await i.getAttribute('aria-label'))?.trim().length).toBeGreaterThan(0);
    expect((await i.getAttribute('data-tip'))?.trim().length).toBeGreaterThan(0);
  }
  await axe(app, '.ib');
});

test('e1: the old Lifetime / Sessions and startup words still find General (v25-fix-settings folded it into General and Advanced)', async ({ app, core }) => {
  await start(app, core);
  await app.getByRole('button', { name: 'Settings', exact: true }).click();
  const nav = settingsNav(app);
  await expect(nav.getByRole('button', { name: 'Lifetime' })).toHaveCount(0);
  await nav.getByRole('button', { name: 'General' }).click();
  await expect(app.getByRole('heading', { level: 1, name: /^General/ })).toBeVisible(); // needs 192 (ticket 250): the page title is the h1
  await expect(app.locator('.settings .phd h1')).not.toContainText('Lifetime');
  for (const q of ['lifetime', 'sessions and startup']) {
    await app.getByRole('searchbox', { name: 'Search settings' }).fill(q);
    await expect(app.getByRole('list', { name: 'Matching settings' }).getByRole('button').first()).toContainText('General');
  }
  await app.getByRole('searchbox', { name: 'Search settings' }).fill('');
  // The Git settings have their own page, apart from the session settings.
  await expect(app.locator('#s-lifetime [data-setting="autoCleanWorktrees"]')).toHaveCount(0);
  await expect(app.locator('#s-lifetime [data-setting="startAtLogin"]')).toBeVisible();
  await nav.getByRole('button', { name: 'Git & worktrees' }).click();
  const git = app.locator('.settings'); // needs 192 (ticket 250): the page title is the h1; its sections are Repository and Worktrees
  await expect(git.getByRole('heading', { level: 1, name: 'Git & worktrees' })).toBeVisible();
  await expect(git.locator('[data-setting="autoCleanWorktrees"]')).toBeVisible();
  await axe(app, '[role="region"][aria-label="Settings"]');
});

test('r1: every item is reachable by a visible labelled control within 2 clicks of the main window', async ({ app, core }) => {
  await start(app, core);
  // 0 clicks: "+ Project" and the rail icons (named in their tooltips) are on screen already.
  await expect(app.getByRole('button', { name: '+ Project' }).first()).toBeVisible();
  await expect(app.locator('.ib .ai').first()).toBeVisible();
  // 1 click: the board.
  await app.getByRole('button', { name: /^Board( · |$)/ }).click();
  await expect(app.locator('.board')).toBeVisible();
  await closeModal(app); // v25f: the Board modal covers the rail; closing it is not a step to the Settings gear
  // 2 clicks: Keyboard page, then General (Settings is the rail's labelled gear).
  await app.getByRole('button', { name: 'Settings', exact: true }).click();
  await settingsNav(app).getByRole('button', { name: 'Keyboard' }).click();
  await expect(app.locator('[data-keys-list]')).toBeAttached(); // needs 166: the list is the page, the keyboard drawing is on Hints
  await settingsNav(app).getByRole('button', { name: 'General' }).click();
  await expect(app.getByRole('heading', { level: 1, name: /^General/ })).toBeVisible(); // needs 192 (ticket 250): the page title is the h1
});
