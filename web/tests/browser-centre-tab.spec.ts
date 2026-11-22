// Ticket 997 L1 (rule A6, owner 11-19): "+" -> Browser, ⇧⌘B and ⇧⌘T of a My browser page open the owner's own browser as a
// full centre tab; the right-side widget stays the quick look. One place at a time per space: the app keeps one native view per
// space, so the tab and the widget never show "you" together. The native view needs the app, so its bridge is faked and the
// calls recorded (as browser-view.spec.ts).
import type { Page } from '@playwright/test';
import { expect, openWindow, test } from './fixtures';
import { icon, sidebar } from './d5b';

type Call = [string, Record<string, unknown>];
const fakeApp = (page: Page) =>
  page.addInitScript(() => {
    const w = window as unknown as { __calls: Call[]; __TAURI_INTERNALS__: unknown };
    w.__calls = [];
    w.__TAURI_INTERNALS__ = { invoke: (cmd: string, args: Record<string, unknown>) => (w.__calls.push([cmd, args]), Promise.resolve(null)), transformCallback: () => 1, metadata: {} };
  });
const calls = (page: Page, cmd: string) => page.evaluate((c) => (window as unknown as { __calls: Call[] }).__calls.filter((x) => x[0] === c).map((x) => x[1]), cmd);
const centre = (app: Page) => app.locator('.centre .pane');
const browserTab = (app: Page) => app.locator('.tabs [role="tab"][data-browser-tab]');
const plus = (app: Page) => app.getByRole('button', { name: 'New session', exact: true });
const pop = (app: Page) => app.getByRole('dialog', { name: 'New tab' });

test('browser_centre_tab_from_plus: "+" -> New browser tab opens My browser as a centre tab beside an agent session, not its side pane', async ({ app, core }) => {
  await fakeApp(app);
  const s = core.agent(core.project('alpha'), 'a', 'never-created', false);
  await openWindow(app);
  await plus(app).click();
  await pop(app).getByRole('option', { name: 'New browser tab' }).click();
  await expect(browserTab(app)).toHaveAttribute('aria-selected', 'true');
  await expect(browserTab(app)).toHaveText('My browser');
  await expect(centre(app).getByLabel('Browser space')).toHaveValue('you');
  await expect(app.locator('[data-side-pane]:not([hidden])').getByLabel('Address')).toHaveCount(0);
  await centre(app).getByLabel('Address').fill('http://127.0.0.1:5731/mine');
  await centre(app).getByLabel('Address').press('Enter');
  await expect.poll(async () => (await calls(app, 'browser_show')).at(-1)).toMatchObject({ space: 'you', url: 'http://127.0.0.1:5731/mine' });
  // No composer under a view tab, and the agent's tab is one click away.
  await expect(app.locator('.composer textarea:visible')).toHaveCount(0);
  await app.locator(`.tab[data-tab="${s.id}"]`).click();
  await expect(browserTab(app)).toHaveAttribute('aria-selected', 'false');
  // ⇧⌘B (the palette's command) brings the same tab back, never a second one; ⌘W closes it.
  await app.keyboard.press('Shift+Meta+KeyB');
  await expect(browserTab(app)).toHaveCount(1);
  await expect(browserTab(app)).toHaveAttribute('aria-selected', 'true');
  await expect(centre(app).getByLabel('Address')).toHaveValue('http://127.0.0.1:5731/mine'); // the address outlives the unmount
  await browserTab(app).focus();
  await app.keyboard.press('Meta+KeyW');
  await expect(browserTab(app)).toHaveCount(0);
  await expect(app.locator(`.tab[data-tab="${s.id}"]`)).toHaveAttribute('aria-selected', 'true');
});

test('browser_centre_tab_one_place: opening the tab closes the widget, and while the tab exists the Browser icon brings it', async ({ app, core }) => {
  await fakeApp(app);
  core.shell(core.project('alpha'), 'build'); // a shell has no side pane: the icon is the owner's own browser
  await openWindow(app);
  await icon(app, 'right', 'Browser').click();
  await expect(sidebar(app, 'right').getByLabel('Browser space')).toHaveValue('you');
  await app.keyboard.press('Shift+Meta+KeyB');
  await expect(browserTab(app)).toHaveAttribute('aria-selected', 'true');
  await expect(sidebar(app, 'right')).toHaveCount(0);
  await expect(app.getByLabel('Browser space')).toHaveCount(1); // "you" is shown in one place
  await app.locator('.tab[data-tab]').first().click();
  await icon(app, 'right', 'Browser').click();
  await expect(browserTab(app)).toHaveAttribute('aria-selected', 'true');
  await expect(sidebar(app, 'right')).toHaveCount(0);
});

test('browser_centre_tab_covered_hides: a popover over the centre tab hides the native view (ticket 346), and closing it shows it again', async ({ app, core }) => {
  await fakeApp(app);
  core.shell(core.project('alpha'), 'build');
  await openWindow(app);
  await app.keyboard.press('Shift+Meta+KeyB');
  await centre(app).getByLabel('Address').fill('http://127.0.0.1:5731/mine');
  await centre(app).getByLabel('Address').press('Enter');
  await expect.poll(async () => (await calls(app, 'browser_show')).length).toBeGreaterThan(0);
  const hides = (await calls(app, 'browser_hide')).length;
  await plus(app).click(); // the New tab popover hangs over the page
  await expect(pop(app)).toBeVisible();
  await expect.poll(async () => (await calls(app, 'browser_hide')).length).toBeGreaterThan(hides);
  const shows = (await calls(app, 'browser_show')).length;
  await app.keyboard.press('Escape');
  await expect(pop(app)).toHaveCount(0);
  await expect.poll(async () => (await calls(app, 'browser_show')).length).toBeGreaterThan(shows);
});

test('browser_centre_tab_reopen: ⇧⌘T after Forget page brings the centre tab back at the page\'s address', async ({ app, core }) => {
  await fakeApp(app);
  core.shell(core.project('alpha'), 'build');
  await openWindow(app);
  await app.keyboard.press('Shift+Meta+KeyB');
  await centre(app).getByLabel('Address').fill('http://example.com/docs');
  await centre(app).getByLabel('Address').press('Enter');
  await expect.poll(async () => (await calls(app, 'browser_show')).map((c) => c.url)).toContain('http://example.com/docs');
  // Ticket 997 L7: Forget page is in ⋯.
  await centre(app).getByRole('button', { name: 'More actions' }).click();
  await centre(app).getByRole('menuitem', { name: /^Forget page/ }).click();
  await expect(centre(app).getByLabel('Address')).toHaveValue('');
  await browserTab(app).focus();
  await app.keyboard.press('Meta+KeyW');
  await expect(browserTab(app)).toHaveCount(0);
  await app.keyboard.press('Shift+Meta+KeyT');
  await expect(browserTab(app)).toHaveAttribute('aria-selected', 'true');
  await expect(centre(app).getByLabel('Address')).toHaveValue('http://example.com/docs');
});

test('browser_centre_tab_shot', async ({ app, core }) => {
  core.shell(core.project('alpha'), 'build');
  await openWindow(app);
  await app.keyboard.press('Shift+Meta+KeyB');
  await expect(browserTab(app)).toHaveAttribute('aria-selected', 'true');
  await app.screenshot({ path: test.info().outputPath('browser-centre-tab.png') });
});
