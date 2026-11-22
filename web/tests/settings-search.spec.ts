// Settings search and palette reach (V1A-57; needs 69): one search box across every page, every setting opens from the
// palette focused on its field, and every icon button's tooltip shows its binding.
import { FIELDS, PAGES } from '../src/settings';
// The node runner has no import.meta.glob (features/index.ts), so the feature files' fields come from their values; a
// registering import would leak them into the next spec in this worker (the registry is module state).
import { SMALL_ROWS_FIELDS } from '../src/features/small-rows-values';
const DIFF_OPTION_KEYS = ['diffHideWhitespace', 'diffWrap', 'diffCollapse', 'diffHideList', 'diffColours']; // ticket 261, pinned by name for the same reason
// v25-fix-settings: 9 pages; the kept ids alerts and keys show as Notifications and Keyboard.
// needs 192 (ticket 250): the final draft's pages; ticket 391 moved Advanced and Orchestration into Skills & hooks.
const TITLES: Record<string, string> = { general: 'General', providers: 'Providers', alerts: 'Notifications', keys: 'Keyboard', git: 'Git & worktrees', extensions: 'Skills & hooks', machines: 'SSH machines', browser: 'Browser access', libraries: 'Artifact libraries', history: 'Terminal history' };
const title = (page: string) => TITLES[page] ?? page;

import { expect, openWindow, test } from './fixtures';

// Ticket 259: the Setup scripts section registers its own fields (features/setup-scripts.tsx), outside FIELDS here.
const SETUP_KEYS = ['setupScript', 'cleanupScript', 'setupPolicy', 'setupWait'];
import { harness } from './theme-harness';

test('settings-search-and-palette: "font" finds the Appearance fields; the palette opens every setting on its field', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  // V1A-62: the Theme page asks for the online index when it opens; answered by the test, never the network.
  await harness(app, [], () => {
    throw new Error('no theme file in this spec');
  });
  await openWindow(app);
  await app.getByRole('navigation', { name: 'Left bar' }).getByRole('button', { name: 'Settings' }).click(); // the visible control: an early chord can be dropped (ticket 106)
  await app.getByRole('searchbox', { name: 'Search settings' }).fill('font');
  const found = app.getByRole('list', { name: 'Matching settings' }).getByRole('button');
  // needs 192 (ticket 250): tab font on Appearance, the terminal font and size on Terminal; the Symbols toggle is gone (needs 192 (7)). Ticket 258: UI, chat, code and composer font on Appearance.
  // Ticket 516: plus Chat text size and Text weight, whose search words say "font size" and "font weight".
  await expect(found.filter({ hasText: /· (Appearance|Terminal)$/ })).toHaveCount(9);
  await found.filter({ hasText: 'Terminal font size' }).click();
  await expect(app.getByRole('spinbutton', { name: 'Terminal font size' })).toBeFocused();
  // Every listed setting has a palette command, and each one opens its page focused on the field.
  for (const f of FIELDS) {
    await app.keyboard.press('Meta+KeyK');
    const palette = app.getByRole('dialog', { name: 'Command palette' });
    const row = palette.locator(`[data-command="settings.${f.page}.${f.key}"]`);
    await expect(row, f.key).toHaveCount(1);
    await row.click();
    await expect(app.locator('[aria-current="page"]')).toHaveText(new RegExp(title(f.page), 'i'));
    await expect.poll(() => app.evaluate((sel) => !!document.activeElement?.matches(sel), f.at), f.key).toBe(true);
  }
});

test('tooltip-shows-binding: each icon button names its key, nothing when unbound, and follows a rebind', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  const icons = app.locator('.ib .ai');
  const labels = await icons.evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
  const unbound = [labels.indexOf('Decisions'), labels.indexOf('Browser'), labels.indexOf('Schedules'), labels.indexOf('History')];
  await expect(icons).toHaveCount(13); // the Decisions (DECISIONW), Terminal (AGENTVIEW), Browser (v25 placement), Schedules (ticket 993) and History (ticket 1022) icons joined the right bar
  // V1A-65: the binding text moved from `title` into the app tooltip unchanged; it is read from the shown tooltip.
  const tip = app.getByRole('tooltip');
  // DECISIONW: the Decisions icon has no key bound yet (follow-up: a `decisions.show` binding), so it names no key.
  // v25 placement: the Browser icon has no command binding either; nor has Schedules (ticket 993), nor History (ticket 1022), which follows it.
  for (const b of (await icons.all()).filter((_, i) => !unbound.includes(i))) {
    await b.hover();
    await expect(tip).toHaveText(/\((⌘|⇧⌘|◆ )[^)]+\)$/); // needs 166: a ⌘ chord is the first key, ⇧⌘ for Files and Search
  }
  const files = app.locator('.ai[data-hint-icon="files.show"]');
  const tipOf = async () => (await files.hover(), tip);
  await expect(await tipOf()).toHaveText('Files (⇧⌘E)');
  await app.keyboard.press('Meta+Comma');
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Keyboard' }).click();
  const row = app.locator('tr[data-command="files.show"]');
  await row.getByRole('button', { name: 'Change Show or hide Files' }).click(); // needs 166: press the shortcut, Enter saves
  await app.keyboard.press('Alt+KeyX');
  await app.keyboard.press('Enter');
  await app.getByRole('button', { name: 'Close Settings' }).click(); // Settings is a modal: what sits behind it cannot be clicked
  await expect(await tipOf()).toHaveText('Files (⌥X)');
  // Unbound: the name alone, no empty brackets.
  await app.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('nunchiro.settings.v1')!);
    s.bindings['files.show'] = [];
    localStorage.setItem('nunchiro.settings.v1', JSON.stringify(s));
  });
  await app.reload();
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  await expect(await tipOf()).toHaveText('Files');
});

test('settings-search-from-page: every data-setting a page renders is listed; one not listed yet is still found on its page', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await harness(app, [], () => {
    throw new Error('no theme file in this spec');
  });
  await openWindow(app);
  const nav = app.getByRole('navigation', { name: 'Settings pages' });
  await app.keyboard.press('Meta+Comma');
  await expect(nav).toBeVisible();
  for (const page of PAGES) {
    await nav.getByRole('button', { name: new RegExp(`^${title(page)}$`, 'i') }).click();
    await expect(app.locator('[aria-current="page"]')).toHaveText(new RegExp(title(page), 'i'));
    // The core-backed pages read the core first; every other page renders at once.
    if (page === 'general') await expect(app.locator('[data-setting="startAtLogin"]')).toBeAttached();
    if (page === 'git') await expect(app.locator('[data-setting="autoCleanWorktrees"]')).toBeAttached();
    const rendered = await app.locator('.settings .sbody [data-setting]').evaluateAll((els) => [...new Set(els.map((e) => (e as HTMLElement).dataset.setting!))]);
    const listed = [...FIELDS.filter((f) => f.page === page).map((f) => f.key), ...Object.entries(SMALL_ROWS_FIELDS).filter(([p]) => p === page).map(([, f]) => f.key), ...(page === 'appearance' ? DIFF_OPTION_KEYS : []), ...(page === 'git' ? SETUP_KEYS : []), ...(page === 'providers' ? ['envInheritShell', 'envStripSecrets', 'envKeepSecrets'] : [])]; // tickets 260, 1008 (features/user-env.tsx)
    for (const key of rendered) expect(listed, `${page}: data-setting="${key}" is not in FIELDS`).toContain(key);
  }
  // A field added with data-setting and no FIELDS entry: the search finds it by its label and focuses it.
  await nav.getByRole('button', { name: 'Appearance' }).click();
  await app.locator('.settings .sbody section').first().evaluate((s) => {
    const label = document.createElement('label');
    label.innerHTML = '<input type="checkbox" data-setting="probeNew"> Probe setting from the page';
    s.append(label);
  });
  await app.getByRole('searchbox', { name: 'Search settings' }).fill('probe');
  const found = app.getByRole('list', { name: 'Matching settings' }).getByRole('button');
  await expect(found).toHaveText(['Probe setting from the page · Appearance']);
  await found.click();
  await expect(app.locator('[data-setting="probeNew"]')).toBeFocused();
});

test('settings-search-new-fields: hint kinds, Import theme, the terminal font and the history settings are found and focused', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await harness(app, [], () => {
    throw new Error('no theme file in this spec');
  });
  await openWindow(app);
  await app.keyboard.press('Meta+Comma');
  const search = app.getByRole('searchbox', { name: 'Search settings' });
  const found = app.getByRole('list', { name: 'Matching settings' }).getByRole('button');
  const cases = [
    ['hint kind', 'Hint kind keys', '[data-setting="hintKinds"]'],
    ['import', 'Import a theme file', '[data-setting="themeImport"]'],
    ['terminal font', 'Terminal font', '[data-setting="termFont"]'],
    ['history', 'Keep terminal history for restarts', '[data-setting="history"]'],
    ['mask', 'Hide known secrets when saving', '[data-setting="maskHistory"]'], // ticket 991 C14: the row's title
  ];
  for (const [q, label, sel] of cases) {
    await search.fill(q);
    await found.filter({ hasText: new RegExp(`^${label.replace(/[()]/g, '\\$&')} ·`) }).click();
    await expect.poll(() => app.evaluate((s) => !!document.activeElement?.matches(s), sel), label).toBe(true);
  }
});

test('setting_in_settings_search: "auto-clean" and "merged worktrees" find the V2-8a setting, off by default', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  expect(FIELDS.find((f) => f.key === 'autoCleanWorktrees')?.page).toBe('git'); // v25-fix-settings: Git & Worktrees
  await app.keyboard.press('Meta+Comma');
  for (const q of ['auto-clean', 'merged worktrees']) {
    await app.getByRole('searchbox', { name: 'Search settings' }).fill(q);
    await expect(app.getByRole('list', { name: 'Matching settings' }).getByRole('button')).toHaveText([/Auto-clean merged worktrees/]);
  }
  await app.getByRole('list', { name: 'Matching settings' }).getByRole('button').click();
  const box = app.getByRole('switch', { name: 'Auto-clean merged worktrees' });
  await expect(box).toBeFocused();
  await expect(box).not.toBeChecked();
});

// Owner RC F2 (D-20261108-07): Row height is found by data-setting, so the palette and the search reach it in Korean too.
test('row_height_ko: with the UI in Korean the palette focuses Row height and "밀도" finds it', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app); // waits for the English status line, so the language changes after it
  await app.evaluate(() => localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ ...JSON.parse(localStorage.getItem('nunchiro.settings.v1') ?? '{}'), language: 'ko' })));
  await app.reload();
  await expect(app.locator('html')).toHaveAttribute('lang', 'ko');
  const focused = () => app.evaluate(() => !!document.activeElement?.matches('[data-setting="density"]'));
  await app.keyboard.press('Meta+KeyK');
  await app.getByRole('dialog').locator('[data-command="settings.appearance.density"]').click();
  await expect.poll(focused).toBe(true);
  await expect(app.getByRole('spinbutton', { name: '행 높이' })).toBeFocused();
  await app.getByRole('searchbox').first().fill('밀도');
  await app.locator('.settings').getByRole('list').getByRole('button').filter({ hasText: '행 높이' }).first().click(); // C14: the row's title
  await expect.poll(focused).toBe(true);
});

// Ticket 991 C14: results read as the rows' own titles.
// Ticket 427: "theme" listed all 23 Appearance settings, because the page's keyword "Theme" (its old page name) tagged every
// setting on it. A setting's own label ranks first, then its page's title, then the page's keywords; a keyword names the page,
// never one setting on it. "font", "notifications" and "keyboard" keep the lists they had before.
test('settings_search_theme_427: "theme" lists the theme settings only; font, notifications and keyboard keep their lists', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await harness(app, [], () => {
    throw new Error('no theme file in this spec');
  });
  await openWindow(app);
  await app.keyboard.press('Meta+Comma');
  const search = app.getByRole('searchbox', { name: 'Search settings' });
  const found = app.getByRole('list', { name: 'Matching settings' }).getByRole('button');
  const pages = app.getByRole('navigation', { name: 'Settings pages' }).locator('button[data-page]');
  const cases: [string, string[], string[]][] = [
    ['theme', ['Appearance'], ['Theme mode · Appearance', 'Choose a theme · Appearance', 'Browse themes online · Appearance', 'Import a theme file · Appearance']],
    // Ticket 516: label hits first, then the rows whose search words say "font" (font size, font weight).
    ['font', ['Appearance', 'Terminal'], ['Tab font size · Appearance', 'Terminal font size · Terminal', 'Terminal font · Terminal', 'UI font · Appearance', 'Chat font · Appearance', 'Code font · Appearance', 'Composer font · Appearance', 'Chat text size · Appearance', 'Text weight · Terminal']],
    // Page-title hits: the whole Notifications and Keyboard pages, in their listed order; ticket 608's level row first, its
    // search words say "notifications" (search-word hits rank above page-title hits).
    ['notifications', ['Notifications'], ['Notification level for new sessions · Notifications', 'Where you answer · Notifications', 'When a session ends · Notifications', 'When a session is waiting · Notifications', 'Sound volume · Notifications', "Do not alert for the session you are viewing · Notifications", 'Alerts per machine · Notifications']],
    ['keyboard', ['Keyboard'], ['Prefix key · Keyboard', 'Show the next keys after a pause · Keyboard', 'Key bindings (find a command or key) · Keyboard', 'Hint alphabet · Keyboard', 'Hint kind keys · Keyboard', 'Follow-up · Keyboard', 'Next/previous session order · Keyboard']],
  ];
  for (const [q, nav, list] of cases) {
    await search.fill(q);
    await expect(found, q).toHaveText(list);
    await expect(pages, q).toHaveText(nav);
  }
  // "theme" no longer shows Appearance whole: only the theme rows stay drawn on it.
  await search.fill('theme');
  await expect(app.getByRole('spinbutton', { name: 'Tab font size' })).toBeHidden();
  await expect(app.locator('[data-setting="themeImport"]')).toBeVisible();
  // Ranking: an own-label hit comes before a hit on the page's keyword ("Sessions and startup", General's old page name).
  await search.fill('sessions');
  // Ticket 608: the notification level row's label says "new sessions" too, and Notifications is listed before Skills & hooks.
  await expect(found.first()).toHaveText('Notification level for new sessions · Notifications');
  await expect(found.nth(1)).toHaveText('Add Nunchiro hooks to new sessions · Skills & hooks');
  await expect(found.last()).toHaveText(/· General$/);
});

// Ticket 427 in Korean: the page title 화면과 테마 holds 테마, so the whole page is found, but the settings whose own label
// holds 테마 come first.
test('settings_search_theme_427_ko: "테마" lists the four theme settings before the rest of 화면과 테마', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await harness(app, [], () => {
    throw new Error('no theme file in this spec');
  });
  await openWindow(app);
  await app.evaluate(() => localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ ...JSON.parse(localStorage.getItem('nunchiro.settings.v1') ?? '{}'), language: 'ko' })));
  await app.reload();
  await expect(app.locator('html')).toHaveAttribute('lang', 'ko');
  await app.keyboard.press('Meta+Comma');
  await app.locator('.settings').getByRole('searchbox').first().fill('테마');
  const found = app.locator('.settings .smatches').getByRole('button');
  await expect(found.nth(4)).toBeVisible();
  const texts = await found.allTextContents();
  expect(texts.slice(0, 4).every((s) => s.split(' · ')[0].includes('테마')), texts.join('\n')).toBe(true);
  expect(texts.slice(4).every((s) => !s.split(' · ')[0].includes('테마')), texts.join('\n')).toBe(true);
});
