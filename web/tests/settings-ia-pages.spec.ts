// v25-fix-settings (designer panel Lane C; needs 149, 150): 9 Settings pages, every old field still found by the search,
// the store version migration with one Undo toast, the Keys page drawing its rows, and the rewritten controls.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { FIELDS, parse, ROW_TITLE, STORE_VERSION } from '../src/settings';
import { en as common } from '../src/i18n/areas/common';
import { en as settingsArea } from '../src/i18n/areas/settings';
import { en as gitArea } from '../src/i18n/areas/settings-git';
import { en as closeAsk } from '../src/i18n/areas/close-ask';
import { en as boardWords } from '../src/i18n/areas/board-words'; // ticket 872's field
import { en as settingsBase } from '../src/i18n/areas/settings-base'; // ticket 991 C14: the rows' own titles
import { en as settingsRows } from '../src/i18n/areas/settings-rows';

// The node runner loads no area files by glob: the field labels come from the areas that hold them (autoPull: settings-git,
// confirmCloseRunning: close-ask).
const LABELS: Record<string, string> = { ...settingsBase, ...settingsRows, ...common, ...settingsArea, ...gitArea, ...closeAsk, ...boardWords };
import { expect, openWindow, test, agentsZone } from './fixtures';
import { BUILTIN_BUTTONS, BUILTIN_TITLES, groupsOf } from './settings-nav';

test.beforeEach(({ core }) => agentsZone(core));

// needs 192 (ticket 250): the final draft's pages replace the nine; the built-in list lives in tests/settings-nav.ts.
const nav = (app: Page) => app.getByRole('navigation', { name: 'Settings pages' });
const openSettings = async (app: Page) => {
  await app.getByRole('navigation', { name: 'Left bar' }).getByRole('button', { name: 'Settings' }).click();
  await expect(nav(app)).toBeVisible();
};
const stored = (app: Page) => app.evaluate(() => JSON.parse(localStorage.getItem('nunchiro.settings.v1') ?? '{}'));

test('settings_nine_pages: the nav lists the 9 pages in order and the search finds every old field on its new page', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await openSettings(app);
  // The built-in pages in final order; a registered feature page may only follow its group's built-in pages.
  await expect(nav(app).locator(BUILTIN_BUTTONS)).toHaveText(BUILTIN_TITLES);
  expect((await groupsOf(nav(app))).filter((g) => !g.after)).toEqual([]);
  await expect(nav(app).locator('.snav-sub')).toHaveCount(0); // needs 192 (ticket 250): no Hints nav entry; hints are the Keyboard page's last part
  await expect(app.getByText('Stored in this window')).toHaveCount(0);
  const search = nav(app).getByRole('searchbox', { name: 'Search settings' });
  const results = app.getByRole('list', { name: 'Matching settings' });
  // Every listed field (built-in and registered) is named in the results with its new page.
  for (const f of FIELDS) {
    const label = LABELS[`field.${f.key}`];
    expect(label, f.key).toBeTruthy();
    await search.fill(label);
    // Ticket 991 C14: found by its field name, shown as its row's own title.
    const shown = ROW_TITLE[f.key] ? LABELS[ROW_TITLE[f.key]] : label;
    await expect(results.getByRole('button').filter({ hasText: shown }).first(), `${f.key} on ${f.page}`).toBeVisible();
  }
  // One field of each folded page opens its new home, focused.
  for (const [label, page, at] of [
    ['Start at login', 'General', '[data-setting="startAtLogin"]'],
    ['Language', 'General', '[data-setting="language"]'],
    ['Browse themes online', 'Appearance', '[data-setting="themeBrowse"]'],
    ['Allow browser access', 'Browser access', '[data-setting="browserAccess"]'],
    ['Auto-clean merged worktrees', 'Git & worktrees', '[data-setting="autoCleanWorktrees"]'],
    ['Keep terminal history', 'Terminal history', '[data-setting="history"]'],
  ] as const) {
    await search.fill(label);
    await results.getByRole('button').filter({ hasText: page }).first().click();
    await expect(nav(app).getByRole('button', { name: page, exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(app.locator(at).first()).toBeFocused();
  }
});

test('an old stored page id opens its new home (theme -> Appearance, lifetime -> General)', async () => {
  expect(parse(JSON.stringify({ settingsPage: 'theme' })).settings.settingsPage).toBe('appearance');
  expect(parse(JSON.stringify({ settingsPage: 'lifetime' })).settings.settingsPage).toBe('general');
  // Ticket 391: Advanced (the hook switch) and Orchestration are in Skills & hooks (`extensions`) now.
  expect(parse(JSON.stringify({ settingsPage: 'orchestration' })).settings.settingsPage).toBe('extensions');
  expect(parse(JSON.stringify({ settingsPage: 'advanced' })).settings.settingsPage).toBe('extensions');
  expect(parse(JSON.stringify({ settingsPage: 'usage' })).settings.settingsPage).toBe('usage'); // F18: Usage is its own page
});

// Ticket 391: a window last left on a removed page opens its new home, and the old page's name still finds the switch.
for (const old of ['advanced', 'orchestration']) {
  test(`old_page_opens_skills_hooks: a window stored on ${old} opens Skills & hooks; Hooks + Enter focuses the hook switch`, async ({ app, core }) => {
    core.shell(core.project('demo'), 'alpha');
    await app.addInitScript(
      ([page, version]) => {
        if (!sessionStorage.getItem('seeded')) {
          localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ settingsPage: page, version }));
          sessionStorage.setItem('seeded', '1');
        }
      },
      [old, STORE_VERSION] as const,
    );
    await openWindow(app);
    await openSettings(app);
    await expect(nav(app).locator('button[data-page="extensions"]')).toHaveAttribute('aria-current', 'page');
    await expect(app.getByRole('heading', { level: 1, name: 'Skills & hooks', exact: true })).toBeVisible();
    await expect(nav(app).locator(`button[data-page="${old}"]`)).toHaveCount(0);
    const search = app.getByRole('searchbox', { name: 'Search settings' });
    await search.fill('Hooks');
    await search.press('Enter');
    await expect(app.getByRole('switch', { name: 'Add Nunchiro hooks to new sessions' })).toBeFocused();
  });
}

test('store_version_migrates: an old store gets copy on select at start, one Undo toast, and Undo restores false', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  // A copy of a version-1 store (no version field) whose copyOnSelect still holds the old default.
  const old = { density: 'comfortable', densityPicked: true, copyOnSelect: false, osc52: 'ask', settingsPage: 'appearance', language: 'system' };
  await app.addInitScript((s) => {
    if (!sessionStorage.getItem('seeded')) {
      localStorage.setItem('nunchiro.settings.v1', JSON.stringify(s));
      sessionStorage.setItem('seeded', '1');
    }
  }, old);
  await openWindow(app);
  const toast = app.getByRole('status').filter({ hasText: 'Copy on select is now on' });
  await expect(toast).toHaveCount(1);
  await expect.poll(async () => (await stored(app)).copyOnSelect).toBe(true);
  expect((await stored(app)).version).toBe(STORE_VERSION);
  await toast.getByRole('button', { name: 'Undo' }).click();
  await expect(toast).toHaveCount(0);
  await expect.poll(async () => (await stored(app)).copyOnSelect).toBe(false);
  // The store is now version 2: a restart keeps the restored value and shows no toast.
  await app.reload();
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  await expect(toast).toHaveCount(0);
  expect((await stored(app)).copyOnSelect).toBe(false);
  await openSettings(app);
  await nav(app).getByRole('button', { name: 'Terminal', exact: true }).click(); // needs 192 (ticket 250): Copy on select lives on Terminal
  await expect(app.locator('[data-setting="copyOnSelect"]')).not.toBeChecked();
});

test('store version: a fresh store and a version-2 store are never migrated', async () => {
  expect(parse(null).undo).toBeNull();
  expect(parse(JSON.stringify({ version: 2, copyOnSelect: false })).settings.copyOnSelect).toBe(false);
  expect(parse(JSON.stringify({ version: 2, copyOnSelect: false })).undo).toBeNull();
  // A store from a newer build keeps its version number (and is not migrated back).
  expect(parse(JSON.stringify({ version: 7, copyOnSelect: false })).settings).toMatchObject({ version: 7, copyOnSelect: false });
  expect(parse(JSON.stringify({ copyOnSelect: false })).undo).toEqual({ copyOnSelect: false });
  // A broken version field counts as version 1; a broken copyOnSelect falls back to the default (true), nothing to undo.
  expect(parse(JSON.stringify({ version: 'x', copyOnSelect: false })).undo).toEqual({ copyOnSelect: false });
  expect(parse(JSON.stringify({ copyOnSelect: 'no' })).undo).toBeNull();
});

test('keys_page_ten_rows: at 1440x900 each Keyboard area section is whole (no inner scroller cuts rows) and the page scrolls to the last one', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await openSettings(app);
  await nav(app).getByRole('button', { name: 'Keyboard', exact: true }).click();
  await expect(app.locator('.keys-page section.karea').first()).toBeVisible();
  const cards = await app.locator('.keys-page section.karea').evaluateAll((els) =>
    els.map((card) => {
      const rows = [...card.querySelectorAll('tbody tr, .hk-row')].filter((r) => (r as HTMLElement).offsetParent !== null);
      // An inner scroller (anything between the section and the settings body) would cut rows off.
      let cut = false;
      for (let e = card as HTMLElement | null; e && !e.classList.contains('sbody'); e = e.parentElement) if (e.scrollHeight > e.clientHeight + 1 && getComputedStyle(e).overflowY !== 'visible') cut = true;
      return { name: card.querySelector('h3')?.textContent, rows: rows.length, cut };
    }),
  );
  expect(cards.length).toBeGreaterThan(8); // the prefix section, the areas and the two mode groups (needs 166: one list, no cards)
  for (const c of cards) expect(c.cut, `${c.name} is cut by an inner scroller`).toBe(false);
  // The body scrolls to the last row.
  const body = app.locator('.sbody');
  await body.evaluate((b) => b.scrollTo(0, b.scrollHeight));
  await expect(app.locator('.keys-page > :last-child')).toBeInViewport(); // needs 192 (ticket 250): the hints part ends the page
});

test('General: Language is one collapsed picker, System by default; hooks read as the positive choice in Skills & hooks', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await openSettings(app);
  await nav(app).getByRole('button', { name: 'General', exact: true }).click();
  const lang = app.getByRole('combobox', { name: /Language/ });
  await expect(lang).toHaveValue('system');
  await expect(app.locator('input[name="language"]')).toHaveCount(0);
  await nav(app).getByRole('button', { name: 'Skills & hooks', exact: true }).click();
  const hooks = app.getByRole('switch', { name: 'Add Nunchiro hooks to new sessions' });
  await expect(hooks).toBeChecked(); // disable_hook_injection is false by default
  await hooks.uncheck();
  await expect.poll(() => JSON.parse(fs.readFileSync(path.join(core.home, 'settings.json'), 'utf8')).disable_hook_injection).toBe(true);
  await expect(app.getByText('Do not add Nunchiro hooks')).toHaveCount(0);
});

test('Advanced > Browser access: the toggle comes first with its status chip, the port is its own row, an empty state that names no address', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await openSettings(app);
  await nav(app).getByRole('button', { name: 'Browser access', exact: true }).click(); // needs 192 (ticket 250): its own page again
  const section = app.locator('section[aria-labelledby="h-browser"]');
  await expect(section.getByRole('switch', { name: 'Allow browser access' })).not.toBeChecked();
  await expect(section.locator('.snm .chip')).toHaveText('Off');
  await expect(section.getByRole('textbox', { name: /Port/ })).toBeVisible();
  await expect(section.getByRole('heading', { name: 'Paired browsers' })).toHaveCount(0);
  await expect(app.getByRole('region', { name: 'Paired browsers' }).getByText('None yet. Turn on access to get a pairing code.')).toBeVisible(); // needs 192 (ticket 250 r3): its own card; ticket 317: off, so no address to point at
});
