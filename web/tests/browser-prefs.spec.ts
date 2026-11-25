// Ticket 255 (needs 197, G04): Settings › In-app browser and its defaults. The native view needs the app, so the app's bridge
// is faked where a test needs it (as browser-annotate.spec.ts); what the app does with the stored values (search URL, home
// page, zoom, viewport, user agent, site permissions) is pinned by the Rust tests in app/src-tauri/src/browser/.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { stripOnTop, expect, openWindow, REPO, test } from './fixtures';

type W = { __calls: [string, Record<string, unknown>][]; __cb: Record<number, (e: unknown) => void>; __on: Record<string, number[]>; __TAURI_INTERNALS__: unknown };
const fakeApp = (page: Page) =>
  page.addInitScript(() => {
    const w = window as unknown as W;
    w.__calls = [];
    w.__cb = {};
    w.__on = {};
    let n = 0;
    w.__TAURI_INTERNALS__ = {
      invoke: (cmd: string, args: Record<string, unknown>) => {
        w.__calls.push([cmd, args]);
        if (cmd === 'plugin:event|listen') (w.__on[args.event as string] ??= []).push(args.handler as number);
        return Promise.resolve(cmd === 'plugin:event|listen' ? 1 : null);
      },
      transformCallback: (cb: (e: unknown) => void) => ((w.__cb[++n] = cb), n),
      metadata: {},
    };
  });
/** The app reporting a page load in `space` (view.rs / agent.rs emit `browser-moved` per page). */
const moved = (page: Page, space: string, url: string) =>
  page.evaluate(
    ([space, url]) => {
      const w = window as unknown as W;
      for (const h of w.__on['browser-moved'] ?? []) w.__cb[h]?.({ event: 'browser-moved', id: 1, payload: { space, url } });
    },
    [space, url],
  );

test.beforeEach(({ core }) => stripOnTop(core));

const nav = (app: Page) => app.locator('.settings > nav');
const openPage = async (app: Page) => {
  await app.getByRole('navigation', { name: 'Left bar' }).getByRole('button', { name: 'Settings' }).click(); // click 1
  await nav(app).locator('button[data-page="inapp-browser"]').click(); // click 2
  await expect(app.locator('.settings header.phd h1')).toHaveText('In-app browser');
};
const features = (home: string) => JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8')).features ?? {};

test('inapp_browser_page_in_interface_group_with_fixed_section_ids', async ({ app, core }) => {
  // The section ids later tickets add to (256, 264, 274, 275) are fixed in the feature file.
  const src = fs.readFileSync(path.join(REPO, 'web/src/features/browser-prefs.tsx'), 'utf8');
  for (const id of ['inapp-browser.defaults', 'inapp-browser.links', 'inapp-browser.profiles', 'inapp-browser.recordings', 'inapp-browser.remote']) expect(src).toContain(`'${id}'`);
  expect(src).toMatch(/registerSettingsSection\(\{\s*page: PAGE,\s*id: SECTIONS\.defaults,\s*order: 10,/);
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await openPage(app);
  // In the Interface group, after its built-in pages.
  const group = await nav(app).locator('[data-group="interface"] button[data-page]').evaluateAll((els) => els.map((e) => e.getAttribute('data-page')));
  expect(group).toEqual(['appearance', 'terminal', 'layout', 'alerts', 'keys', 'inapp-browser']);
  await expect(nav(app).locator('button[data-page="inapp-browser"]')).toHaveAttribute('aria-current', 'page');
  // Its nav icon is the browser glyph (the Phone and web access page's), not the gear a registered page gets by default.
  const icon = (id: string) => nav(app).locator(`button[data-page="${id}"] svg`).evaluate((e) => e.innerHTML);
  expect(await icon('inapp-browser')).toBe(await icon('browser'));
  expect(await icon('inapp-browser')).not.toBe(await icon('general'));
  await expect(app.getByRole('region', { name: 'Browser defaults' })).toBeVisible();
  for (const name of ['Search engine', 'Home page', 'Default zoom', 'Agent page size', 'User agent', 'Show the browser when an agent opens a page']) await expect(app.locator('.sbody').getByLabel(name, { exact: true }).first()).toBeVisible();
  // Korean: the nav button and title follow the window's language.
  await nav(app).locator('[data-page="general"]').click();
  await app.locator('[data-setting="language"]').selectOption('ko');
  await nav(app).locator('[data-page="inapp-browser"]').click();
  await expect(app.locator('.settings header.phd h1')).toHaveText('앱 안 브라우저');
  await expect(nav(app).locator('[data-page="inapp-browser"]')).toContainText('앱 안 브라우저');
});

test('settings_search_finds_inapp_browser_page', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await app.getByRole('navigation', { name: 'Left bar' }).getByRole('button', { name: 'Settings' }).click();
  await app.getByRole('searchbox', { name: 'Search settings' }).fill('search engine');
  await app.getByRole('list', { name: 'Matching settings' }).getByRole('button', { name: /Search engine/ }).click();
  await expect(app.locator('.settings header.phd h1')).toHaveText('In-app browser');
  await expect(app.locator('.sbody').getByLabel('Search engine', { exact: true })).toBeFocused();
});

test('zoom_viewport_appearance_and_user_agent_apply_to_new_pages', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await openPage(app);
  const body = app.locator('.sbody');
  await body.getByLabel('Search engine', { exact: true }).selectOption('kagi');
  await body.getByRole('button', { name: /Default zoom/ }).last().click(); // + : 100 → 110
  await body.getByLabel('Agent page size', { exact: true }).selectOption('1440x900');
  await body.getByRole('radiogroup', { name: 'Page appearance' }).getByRole('radio', { name: 'Dark' }).click(); // the radio covers its text
  await body.getByLabel('User agent', { exact: true }).selectOption('safari');
  // Home page: a bad address is refused in place and nothing is stored; a bare host is stored as https.
  const home = body.getByLabel('Home page', { exact: true });
  await home.fill('javascript:alert(1)');
  await home.press('Enter');
  await expect(body.getByRole('alert')).toHaveText('Type an http or https address');
  await home.fill('mail.example');
  await home.press('Enter');
  // Site permissions: a row for the user's own browser. Camera and microphone only: macOS never routes location or
  // notification requests to the app's handler (review round 2).
  // Owner 2026-11-16: a site is added once with both on, one line per site with a button for each kind.
  await body.getByLabel('Site', { exact: true }).fill('Meet.Example.com');
  await body.getByRole('button', { name: 'Add', exact: true }).click(); // "Add profile" is on this page too (ticket 264)
  const line = body.getByRole('list', { name: 'Site permissions' }).getByRole('listitem');
  await expect(line).toHaveCount(1);
  await expect(line.getByRole('button', { pressed: true })).toHaveText(['✓ Camera', '✓ Microphone']); // eighth look (C): on has a check mark
  // The core holds the values under browser.* for the app's next new view (view.rs Prefs::read on each one).
  await expect
    .poll(() => features(core.home))
    .toMatchObject({
      'browser.search_engine': 'kagi',
      'browser.zoom': 110,
      'browser.viewport': '1440x900',
      'browser.appearance': 'dark',
      'browser.user_agent': 'safari',
      'browser.home_page': 'https://mail.example/',
      'browser.site_permissions': [{ host: 'meet.example.com', kind: 'camera', decision: 'allow' }, { host: 'meet.example.com', kind: 'microphone', decision: 'allow' }],
    });
  // A reopened page reads them back from the core.
  await app.getByRole('button', { name: 'Close Settings' }).click(); // Settings is a modal: the left bar behind it cannot be clicked
  await app.reload();
  await openWindow(app);
  await openPage(app);
  await expect(body.getByLabel('Search engine', { exact: true })).toHaveValue('kagi');
  await expect(body.getByLabel('Default zoom', { exact: true })).toHaveValue('110');
  await expect(body.getByLabel('Agent page size', { exact: true })).toHaveValue('1440x900');
  await expect(body.getByRole('radio', { name: 'Dark' })).toBeChecked();
  await expect(body.getByLabel('User agent', { exact: true })).toHaveValue('safari');
  // Removing the last site removes the key.
  await body.getByRole('button', { name: 'Remove meet.example.com', exact: true }).click();
  await expect.poll(() => 'browser.site_permissions' in features(core.home)).toBe(false);
});

test('agent_navigation_shows_browser_pane_without_stealing_focus', async ({ app, core }) => {
  await fakeApp(app);
  const p = core.project('a');
  const a = core.agent(p, 'a', 'never-created', false);
  const b = core.agent(p, 'b', 'never-created', false);
  await openWindow(app, {}, core);
  await app.locator(`.tab[data-tab="${a.id}"]`).click();
  const composer = app.locator('.cbox:visible textarea').first();
  await composer.click();
  await composer.fill('half a thought');
  const pane = app.locator('[data-side-pane]:not([hidden])');
  await expect(pane).toHaveCount(0);
  await expect.poll(() => app.evaluate(() => ((window as unknown as W).__on['browser-moved'] ?? []).length)).toBeGreaterThan(0);
  // The owner's own space loading a page opens nothing; the agent's first page opens its Browser tab.
  await moved(app, 'you', 'https://example.com/');
  await expect(pane).toHaveCount(0);
  await moved(app, a.id, 'https://example.com/a');
  await expect(pane.getByLabel('Address')).toBeVisible();
  await expect(composer).toBeFocused();
  await expect(composer).toHaveValue('half a thought');
  // Off: another agent's first page leaves its pane closed.
  await app.getByRole('navigation', { name: 'Left bar' }).getByRole('button', { name: 'Settings' }).click();
  await nav(app).locator('button[data-page="inapp-browser"]').click();
  await app.locator('.sbody').getByLabel('Show the browser when an agent opens a page').uncheck();
  await app.getByRole('button', { name: 'Close Settings' }).click(); // Settings is a modal: the tab behind it cannot be clicked
  await app.locator(`.tab[data-tab="${b.id}"]`).click();
  await moved(app, b.id, 'https://example.com/b');
  await expect(app.locator('[data-side-pane]:not([hidden])').getByLabel('Address')).toHaveCount(0);
});

// Ticket 351: camera and microphone are off by default (no row: the app's handler denies, browser/mod.rs
// `media_decision_table`); a row stores per site and kind, and changing or removing it stores that.
test('media_rows_default_off_and_store_each_change', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await openPage(app);
  const body = app.locator('.sbody');
  await expect(body.locator('[data-row="browserSites"]')).toContainText('No sites yet');
  await expect(body.locator('[data-row="browserSites"]')).toContainText('When off, the site is refused without a question. When on, Nunchiro does not refuse, but macOS (WebKit) still asks you once per page');
  expect('browser.site_permissions' in features(core.home)).toBe(false);
  // One site, added once: both kinds on.
  await body.getByLabel('Site', { exact: true }).fill('https://call.example/room');
  await body.getByRole('button', { name: 'Add', exact: true }).click();
  const row = (kind: string, decision: string) => ({ host: 'call.example', kind, decision });
  await expect.poll(() => features(core.home)['browser.site_permissions']).toEqual([row('camera', 'allow'), row('microphone', 'allow')]);
  // The camera button turns it off for that site: Deny is stored (it refuses with no prompt in the app), the line stays.
  const camera = body.getByRole('button', { name: 'Camera · call.example', exact: true });
  await camera.click();
  await expect(camera).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(() => features(core.home)['browser.site_permissions']).toEqual(expect.arrayContaining([row('camera', 'deny'), row('microphone', 'allow')]));
  await camera.click();
  await expect.poll(() => features(core.home)['browser.site_permissions']).toEqual(expect.arrayContaining([row('camera', 'allow'), row('microphone', 'allow')]));
  await body.getByRole('button', { name: 'Remove call.example', exact: true }).click();
  await expect.poll(() => 'browser.site_permissions' in features(core.home)).toBe(false);
  // No app: no macOS status to read, so no why line.
  await expect(body.locator('[data-why^="why-media-"]')).toHaveCount(0);
});

// Ticket 993: a core value that is a list or an object is written whole, built from the value the page holds. That
// value arrived only with the core's reply, so of two changes made before the first reply the second wrote the list
// without the first (here: Camera off, then Microphone off, and Camera came back on). useCoreFeature now holds the
// last set value until its reply. The core's replies to the two writes are held back here until both were sent.
test('media_two_quick_changes_both_stored: a change made before the core answered the one before keeps it', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  let holding = false;
  const waiting = new Set<number>();
  const held: (string | Buffer)[] = [];
  let release = () => {};
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => {
      const f = typeof m === 'string' ? JSON.parse(m) : null;
      if (holding && f?.request?.patch?.features?.['browser.site_permissions']) waiting.add(f.id);
      server.send(m);
    });
    server.onMessage((m) => {
      const f = typeof m === 'string' ? JSON.parse(m) : null;
      if (f && waiting.has(f.id)) return void held.push(m);
      ws.send(m);
    });
    release = () => held.splice(0).forEach((m) => ws.send(m));
  });
  await openWindow(app);
  await openPage(app);
  const body = app.locator('.sbody');
  await body.getByLabel('Site', { exact: true }).fill('https://call.example/room');
  await body.getByRole('button', { name: 'Add', exact: true }).click();
  const row = (kind: string, decision: string) => ({ host: 'call.example', kind, decision });
  await expect.poll(() => features(core.home)['browser.site_permissions']).toEqual([row('camera', 'allow'), row('microphone', 'allow')]);
  const camera = body.getByRole('button', { name: 'Camera · call.example', exact: true });
  const mic = body.getByRole('button', { name: 'Microphone · call.example', exact: true });
  holding = true;
  await camera.click();
  await expect(camera).toHaveAttribute('aria-pressed', 'false'); // shown at once, before the core's reply
  await expect(camera).toHaveText('Camera'); // eighth look (C): on has a check mark, so the fill is not the only cue
  await expect(mic).toHaveText('✓ Microphone');
  await mic.click();
  await expect.poll(() => waiting.size).toBe(2);
  await expect.poll(() => held.length).toBe(2);
  holding = false;
  release();
  await expect.poll(() => features(core.home)['browser.site_permissions']).toEqual(expect.arrayContaining([row('camera', 'deny'), row('microphone', 'deny')]));
  await expect(camera).toHaveAttribute('aria-pressed', 'false');
  await expect(mic).toHaveAttribute('aria-pressed', 'false');
});

// Ticket 351 with ticket 475's kit: macOS refuses the app the camera, so the row says why an Allow row cannot work and
// opens the Camera pane; the microphone is granted and gets no line. The app's `media_status` is faked here.
test('media_why_line_when_macos_refuses_the_camera', async ({ app, core }) => {
  await app.addInitScript(() => {
    const w = window as unknown as W;
    w.__calls = [];
    w.__TAURI_INTERNALS__ = {
      invoke: (cmd: string, args: Record<string, unknown>) => {
        w.__calls.push([cmd, args]);
        if (cmd === 'media_status') return Promise.resolve({ camera: 'not_granted', microphone: 'granted' });
        return Promise.resolve(cmd === 'plugin:event|listen' ? 1 : null);
      },
      transformCallback: () => 0,
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main', windowLabel: 'main' } },
    };
  });
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await openPage(app);
  const row = app.locator('.sbody [data-row="browserSites"]');
  const why = row.locator('[data-why="why-media-camera"]');
  await expect(why).toHaveText(/^macOS has not given Nunchiro the camera, so an Allow row cannot work\./);
  await expect(row.locator('[data-why="why-media-microphone"]')).toHaveCount(0);
  await why.getByRole('button', { name: 'Open System Settings' }).click();
  await expect
    .poll(() => app.evaluate(() => (window as unknown as W).__calls.filter(([c]) => c === 'plugin:opener|open_url').map(([, a]) => a.url)))
    .toEqual(['x-apple.systempreferences:com.apple.preference.security?Privacy_Camera']);
  // Korean: the reason follows the window's language.
  await app.locator('.settings > nav [data-page="general"]').click();
  await app.locator('[data-setting="language"]').selectOption('ko');
  await app.locator('.settings > nav [data-page="inapp-browser"]').click();
  await expect(app.locator('[data-why="why-media-camera"]')).toContainText('macOS가 Nunchiro에 카메라를 허용하지 않아');
});
