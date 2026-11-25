import type { Page } from '@playwright/test';
import { DEFAULTS, load, parse } from '../src/settings';
import { expect, openWindow, test, stripOnTop } from './fixtures';
import { openQuiet } from './tree-seed';
import { harness } from './theme-harness';
import { BUILTIN_BUTTONS, BUILTIN_TITLES, groupsOf } from './settings-nav';
import { openSettings } from './settings-modal';

test.beforeEach(({ core }) => stripOnTop(core));

const page = (app: Page, name: string) => app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name, exact: true }); // needs 192 (ticket 250): Terminal / Terminal History
// needs 192 (ticket 250): the final draft's pages in 7 groups; the built-in list lives in tests/settings-nav.ts.

const heights = (page: Page) =>
  page.evaluate(() => ({
    tree: document.querySelector('.grp .head')!.getBoundingClientRect().height,
    tabs: document.querySelector('.tabs')!.getBoundingClientRect().height,
    tabFont: getComputedStyle(document.querySelector('.tab')!).fontSize,
  }));

test('density defaults to comfortable (head 25 / 24 / 36 px, tab text 13 px; ticket 1041, owner 15.1 item 7)', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  openQuiet(core); // V2-9a: quiet projects start folded
  await openWindow(app);
  expect(await heights(app)).toEqual({ tree: 25, tabs: 36, tabFont: '13px' }); // the project head is the ko/ 25 px .proj; session rows are 32 (A+B+C)
});

test('density, tab font, waiting strip and theme persist across a reload', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  // V1A-62: the Theme page asks for the online index when it opens; answered by the test, never the network.
  await harness(app, [], () => {
    throw new Error('no theme file in this spec');
  });
  openQuiet(core); // V2-9a: quiet projects start folded
  await openWindow(app);
  await app.getByRole('navigation', { name: 'Left bar' }).getByRole('button', { name: 'Settings' }).click(); // the visible control: an early chord can be dropped (ticket 106)
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Appearance' }).click(); // v25-fix-settings: Settings opens on General
  await app.getByRole('spinbutton', { name: 'Row height' }).fill('22'); // D-20261108-07: the Density presets are gone; 22 px is compact's height // comfortable is the default (STYLE 2026-10-28)
  await app.getByRole('spinbutton', { name: 'Tab font size' }).fill('13'); // ticket 162: a number field with steppers
  await page(app, 'Notifications').click();
  await app.getByRole('radio', { name: /No answer strip/ }).check();
  await page(app, 'Appearance').click();
  await app.getByRole('radio', { name: 'One theme' }).check();
  await app.getByRole('button', { name: 'Nunchiro Dark', exact: true }).press('Enter'); // ticket 162: a click previews, Enter keeps
  await app.reload();
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  await app.keyboard.press('Escape'); // v25f: the reload keeps the Settings modal open; Esc closes it
  await app.locator('.tab').first().click();
  expect(await heights(app)).toEqual({ tree: 22, tabs: 26, tabFont: '13px' });
  await expect(app.locator('#waiting-strip')).toHaveAttribute('data-mode', 'off');
  await expect(app.locator('html')).toHaveAttribute('data-theme', 'dark');
});

test('a broken settings store falls back to defaults field by field', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await app.addInitScript(() => {
    if (!sessionStorage.getItem('seeded')) {
      sessionStorage.setItem('seeded', '1');
      localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ density: 'huge', tabFont: '13', strip: 'off', bindings: { prefix: 'Control+KeyB' }, order: [1, 2] }));
    }
  });
  openQuiet(core); // V2-9a: quiet projects start folded
  await openWindow(app);
  // Wrong values (density, tabFont as a string, bindings not a list) are dropped; the valid strip stays.
  expect(await heights(app)).toMatchObject({ tree: 25, tabFont: '13px' }); // the comfortable default's 25 px project head (STYLE 2026-10-28)
  await expect(app.locator('#waiting-strip')).toHaveAttribute('data-mode', 'off');
  // The malformed prefix (a string, not a list) is dropped: Settings > Keys shows the default pair again.
  await app.keyboard.press('Meta+Comma');
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Keyboard' }).click();
  await expect(app.locator('[data-command="prefix"] .kcell')).toHaveText(/^⌃\.\s*or\s*⌃␣$/); // ticket 318: the prefix has its own card above the list
  // The rejected original is kept, byte for byte, before defaults are written over it.
  expect(JSON.parse((await app.evaluate(() => localStorage.getItem('nunchiro.settings.v1.bak')))!)).toMatchObject({ density: 'huge', tabFont: '13' });
  await app.evaluate(() => localStorage.setItem('nunchiro.settings.v1', '{not json'));
  await app.reload();
  await expect(app.locator('#waiting-strip')).toHaveAttribute('data-mode', 'on');
  expect(await app.evaluate(() => localStorage.getItem('nunchiro.settings.v1.bak'))).toBe('{not json');
});

// Q9 zh-hant-J13-1: a full storage that refuses the backup of a rejected field keeps every field that parsed.
test('a rejected field whose backup cannot be written keeps the rest of the store', () => {
  const store = new Map([['nunchiro.settings.v1', JSON.stringify({ density: 'huge', strip: 'off', tabFont: 13 })]]);
  const was = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (k.endsWith('.bak')) throw new DOMException('full', 'QuotaExceededError');
      store.set(k, v);
    },
  } as Storage;
  try {
    expect(load()).toMatchObject({ density: DEFAULTS.density, strip: 'off', tabFont: 13 });
  } finally {
    globalThis.localStorage = was;
  }
});

test('nine pages: the nav shows one page at a time, is keyboard-operable and marks the current page', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await app.keyboard.press('Meta+Comma');
  const nav = app.getByRole('navigation', { name: 'Settings pages' });
  // The built-in pages in final order; a registered feature page may only follow its group's built-in pages.
  await expect(nav.locator(BUILTIN_BUTTONS)).toHaveText(BUILTIN_TITLES);
  expect((await groupsOf(nav)).filter((g) => !g.after)).toEqual([]);
  // needs 192 (ticket 250): every nav button is a page (no Hints entry; hints end the Keyboard page).
  await expect(nav.getByRole('button')).toHaveCount(await nav.locator('button[data-page]').count());
  await expect(page(app, 'General')).toHaveAttribute('aria-current', 'page');
  const region = app.getByRole('region', { name: 'Settings' });
  await expect(region.getByRole('heading', { level: 1 })).toHaveText(/^General/); // needs 192 (ticket 250): the page title is the h1
  await expect(region.locator('.sbody > section')).toHaveCount(3); // Language, Window and agents, then ticket 375's Editor
  // Arrow keys move along the nav; Enter opens the page and focus lands on its heading.
  await page(app, 'General').focus();
  for (let i = 0; i < 5; i++) await app.keyboard.press('ArrowDown'); // General, Onboarding (ticket 305, the general group's registered page), Appearance, Terminal, Layout, Notifications
  await expect(page(app, 'Notifications')).toBeFocused();
  await app.keyboard.press('Enter');
  await expect(page(app, 'Notifications')).toHaveAttribute('aria-current', 'page');
  await expect(page(app, 'General')).not.toHaveAttribute('aria-current', 'page');
  await expect(region.getByRole('heading', { level: 1 })).toHaveText(/^Notifications/);
  await expect(region.getByRole('heading', { level: 1 })).toBeFocused();
  await expect(region.getByRole('heading', { level: 2 }).first()).toHaveText(/^When an answer is needed/); // needs 192 (ticket 250 r3): the draft's three cards
  await expect(region.locator('.sbody > section')).toHaveCount(4); // the three cards, then ticket 270's Alerts per machine
  await expect(region.locator('.sbody > section').last()).toHaveAttribute('aria-labelledby', 'h-alert-machines');
  await expect(region.locator('#h-alert-machines')).toHaveText('Machines');
  await page(app, 'Skills & hooks').click(); // ticket 391: Advanced is gone; its hook switch heads Skills & hooks
  await expect(region.getByRole('heading', { level: 2 }).first()).toHaveText(/^Nunchiro defaults/);
  // The last page is remembered in this window.
  await app.reload();
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  await expect(app.getByRole('dialog', { name: 'Settings' })).toBeVisible(); // v25f: the reload keeps the modal open
  await expect(page(app, 'Skills & hooks')).toHaveAttribute('aria-current', 'page');
});

test('terminal font size and family change the open terminal at once and survive a reload', async ({ app, core }) => {
  const a = core.shell(core.project('demo'), 'alpha', '/bin/sh', '-c', "printf 'scrollback-kept\\n'; exec cat");
  await openWindow(app);
  const rows = app.locator(`.term[data-session="${a.id}"] .xterm-rows`);
  await expect(rows).toContainText('scrollback-kept');
  // WebKit serializes the computed family without quotes (`Courier New, monospace`), Chromium with them.
  const font = () => rows.evaluate((el) => ({ size: getComputedStyle(el).fontSize, family: getComputedStyle(el).fontFamily.replaceAll('"', '') }));
  expect(await font()).toMatchObject({ size: '12px' });
  await rows.evaluate(() => ((window as { __same?: number }).__same = 1));
  await app.locator(`.term[data-session="${a.id}"] .xterm`).evaluate((el) => el.setAttribute('data-mark', '1'));
  await app.keyboard.press('Meta+Comma');
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Terminal', exact: true }).click(); // needs 192 (ticket 250): the terminal font is on Terminal
  await app.getByRole('spinbutton', { name: 'Terminal font size' }).fill('16');
  await app.getByRole('button', { name: /^Terminal font/ }).click();
  await app.getByRole('option', { name: /^Custom…/ }).click();
  await app.getByRole('textbox', { name: 'Custom font list' }).fill('Courier New, monospace');
  await app.keyboard.press('Escape'); // v25f: Settings is a modal over the tabs
  await app.getByRole('tab', { name: /alpha/ }).click();
  await expect.poll(font).toEqual({ size: '16px', family: 'Courier New, monospace' });
  // Same xterm (marked element kept), same page (no navigation), scrollback kept.
  await expect(app.locator(`.term[data-session="${a.id}"] .xterm[data-mark="1"]`)).toHaveCount(1);
  expect(await app.evaluate(() => (window as { __same?: number }).__same)).toBe(1);
  await expect(rows).toContainText('scrollback-kept');
  // An unsafe value is refused with a message and never reaches the terminal.
  await app.keyboard.press('Meta+Comma');
  await app.getByRole('textbox', { name: 'Custom font list' }).fill('x; } body { display: none');
  await expect(app.getByRole('alert')).toContainText('Font names');
  await app.reload();
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  await app.keyboard.press('Escape'); // v25f: the reload keeps the Settings modal open
  await app.getByRole('tab', { name: /alpha/ }).click();
  await expect.poll(font).toEqual({ size: '16px', family: 'Courier New, monospace' });
});

// v1a-35: copy on select and the OSC 52 mode, on the Appearance page.
test('copy on select and OSC 52 mode parse field by field: defaults on and ask (ticket 162), a broken value falls back', () => {
  expect(parse(null).settings).toMatchObject({ copyOnSelect: true, osc52: 'ask' });
  expect(parse(JSON.stringify({ copyOnSelect: true, osc52: 'deny' }))).toMatchObject({ settings: { copyOnSelect: true, osc52: 'deny' }, clean: true });
  expect(parse(JSON.stringify({ osc52: 'allow' })).settings.osc52).toBe('allow');
  expect(parse(JSON.stringify({ copyOnSelect: 'yes', osc52: 'always', density: 'spacious' }))).toMatchObject({
    settings: { copyOnSelect: true, osc52: 'ask', density: 'spacious' },
    clean: false,
  });
});

test('copy on select and OSC 52 mode are set on Appearance and survive a reload', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await app.keyboard.press('Meta+Comma');
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Terminal', exact: true }).click(); // needs 192 (ticket 250): the clipboard rows are on Terminal
  const copy = app.getByRole('switch', { name: 'Copy on select' });
  await expect(copy).toBeChecked(); // ticket 162: on by default
  await expect(app.getByRole('radio', { name: /^Ask/ })).toBeChecked();
  await copy.uncheck();
  await app.getByRole('radio', { name: /^Never/ }).check();
  await app.reload();
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  await expect(app.getByRole('dialog', { name: 'Settings' })).toBeVisible(); // v25f: the reload keeps the modal open
  await expect(copy).not.toBeChecked();
  await expect(app.getByRole('radio', { name: /^Never/ })).toBeChecked();
  expect(JSON.parse((await app.evaluate(() => localStorage.getItem('nunchiro.settings.v1')))!)).toMatchObject({ copyOnSelect: false, osc52: 'deny' });
});

// v1a-38: sound fields are checked one by one; a broken one falls back alone and marks the store unclean.
test('sound settings default to Glass / Ping at full volume and fall back field by field', () => {
  expect(parse(null).settings).toMatchObject({ soundDone: 'Glass', soundWaiting: 'Ping', soundVolume: 1 });
  const ok = { ...DEFAULTS, soundDone: 'off', soundWaiting: 'Submarine', soundVolume: 0.25 };
  expect(parse(JSON.stringify(ok))).toEqual({ settings: ok, clean: true, undo: null });
  for (const patch of [{ soundDone: 'glass' }, { soundDone: '../../x' }, { soundWaiting: 3 }, { soundVolume: 1.5 }, { soundVolume: '0.5' }]) {
    const { settings, clean } = parse(JSON.stringify({ strip: 'off', soundDone: 'Hero', soundWaiting: 'Pop', soundVolume: 0.5, ...patch }));
    expect(clean).toBe(false);
    expect(settings.strip).toBe('off');
    const [k] = Object.keys(patch) as (keyof typeof DEFAULTS)[];
    expect(settings[k]).toBe(DEFAULTS[k]);
  }
});

test('hint keys (V1A-48, needs 118, ticket 389) default to the kind letters p s t l r w f u h o and the alphabet asdfjklghewruiopqtyvcmnxzb1234567890; a malformed value falls back to the defaults', () => {
  const codes = (s: string) => [...s].map((c) => (c >= '0' && c <= '9' ? `Digit${c}` : `Key${c.toUpperCase()}`));
  // Owner 11-10: stored as the letters a person types.
  expect(DEFAULTS.hintKeys.alphabet).toEqual([...'asdfjklghewruiopqtyvcmnxzb1234567890']);
  expect(DEFAULTS.hintKeys.kinds).toEqual({ project: 'p', session: 's', tab: 't', left: 'l', right: 'r', pane: 'w', url: 'u', path: 'f', hash: 'h', other: 'o' });
  // A stored code value (any layout) migrates once to QWERTY letters; only the old default alphabet becomes the new default.
  const codeKinds = { project: 'KeyP', session: 'KeyS', tab: 'KeyT', left: 'KeyL', right: 'KeyR', pane: 'KeyW', url: 'KeyU', path: 'KeyF', hash: 'KeyH', other: 'KeyO' };
  expect(parse(JSON.stringify({ hintKeys: { kinds: codeKinds, alphabet: codes('123456qwertyasdfgzxcvb'), layout: 'qwerty' } })).settings.hintKeys).toEqual(DEFAULTS.hintKeys);
  expect(parse(JSON.stringify({ hintKeys: { kinds: codeKinds, alphabet: codes('qwertyasdfgzxcvb123456'), layout: 'colemak' } })).settings.hintKeys).toEqual({ kinds: DEFAULTS.hintKeys.kinds, alphabet: [...'qwertyasdfgzxcvb123456'] });
  const good = { ...DEFAULTS.hintKeys, alphabet: ['j', 'k', 'l'] };
  expect(parse(JSON.stringify({ hintKeys: good }))).toEqual({ settings: { ...DEFAULTS, hintKeys: good }, clean: true, undo: null });
  expect(Object.keys(parse(JSON.stringify({ hintKeys: good })).settings.hintKeys).sort()).toEqual(['alphabet', 'kinds']);
  for (const bad of [
    { ...good, alphabet: ['j'] }, // one label key cannot count
    { ...good, alphabet: ['j', 'j'] },
    { ...good, alphabet: ['j', 'Escape'] },
    { ...good, kinds: { ...good.kinds, session: 'p' } }, // two kinds on one letter
    { ...good, kinds: { ...good.kinds, other: undefined } },
    { ...good, layout: 'azerty' }, // a code shape whose values are no codes
    { ...good, alphabet: ['j', 'hello'] },
    { ...good, alphabet: ['j', 'é'] }, // not a key on the drawn keyboard
    { ...good, kinds: { ...good.kinds, url: 'F1' } },
    { ...good, extra: 1 }, // unknown field
    { ...good, kinds: { ...good.kinds, extra: 'q' } },
    'KeyJ',
  ])
    expect(parse(JSON.stringify({ hintKeys: bad }))).toEqual({ settings: DEFAULTS, clean: false, undo: null });
});

// Ticket 391: Agents and Accounts became one page, Providers; a window stored on either old page opens there.
test('a stored agents or accounts page parses to providers', () => {
  expect(parse(JSON.stringify({ settingsPage: 'agents' })).settings.settingsPage).toBe('providers');
  expect(parse(JSON.stringify({ settingsPage: 'accounts' })).settings.settingsPage).toBe('providers');
});

for (const old of ['accounts', 'agents']) {
  test(`a window stored on the ${old} page opens Settings on Providers`, async ({ app }) => {
    await openWindow(app);
    await app.evaluate((p) => {
      const key = 'nunchiro.settings.v1';
      localStorage.setItem(key, JSON.stringify({ ...JSON.parse(localStorage.getItem(key) ?? '{}'), settingsPage: p }));
    }, old);
    await app.reload();
    await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
    await openSettings(app);
    await expect(page(app, 'Providers')).toHaveAttribute('aria-current', 'page');
    await expect(app.locator('.settings header.phd h1')).toHaveText('Providers');
    await expect(app.locator('#s-accounts [data-row="newDefaultAgent"]')).toBeVisible();
  });
}
