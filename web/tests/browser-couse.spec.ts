// V2.5-21 (WP3): the Browser tab's control chip. The app's bridge is faked (commands recorded, events delivered by the test);
// the flip itself, the refusal and the no-interleave guarantee are checked live by tests/scenario/browser_couse.py.
import type { Page } from '@playwright/test';
import { expect, openWindow, test } from './fixtures';
import { icon } from './d5b';

type Call = [string, Record<string, unknown>];
type Fake = { __calls: Call[]; __emit: (event: string, payload: unknown) => void; __TAURI_INTERNALS__: unknown };
const fakeApp = (page: Page) =>
  page.addInitScript(() => {
    const w = window as unknown as Fake & { __cbs: Map<number, (e: unknown) => void>; __subs: [string, number][]; __TAURI_EVENT_PLUGIN_INTERNALS__: unknown };
    w.__calls = [];
    w.__cbs = new Map();
    w.__subs = [];
    let next = 1;
    w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
    w.__TAURI_INTERNALS__ = {
      transformCallback: (cb: (e: unknown) => void) => (w.__cbs.set(next, cb), next++),
      invoke: (cmd: string, args: Record<string, unknown>) => {
        w.__calls.push([cmd, args]);
        if (cmd === 'plugin:event|listen') w.__subs.push([args.event as string, args.handler as number]);
        if (cmd === 'browser_control') return Promise.resolve({ space: args.space, user: false, reason: null });
        if (cmd === 'browser_profiles') return Promise.resolve(null); // ticket 264: no profile picker; `1` would crash the view
        if (cmd === 'browser_hand_back') w.__emit('browser-control', { space: args.space, user: false, reason: null });
        return Promise.resolve(1);
      },
      metadata: {},
    };
    // As the app does: `browser-control` to every listener of the window.
    w.__emit = (event, payload) => w.__subs.filter(([e]) => e === event).forEach(([, h]) => w.__cbs.get(h)?.({ event, id: 1, payload }));
  });
const calls = (page: Page, cmd: string) => page.evaluate((c) => (window as unknown as Fake).__calls.filter((x) => x[0] === c), cmd);
const emit = (page: Page, payload: unknown) => page.evaluate((p) => (window as unknown as Fake).__emit('browser-control', p), payload);
const pane = (page: Page) => page.locator('[data-side-pane]:not([hidden])');

async function browserTab(app: Page, id: string) {
  await app.locator(`.tab[data-tab="${id}"]`).click();
  await icon(app, 'right', 'Terminal').click(); // click 1: the side pane
  await icon(app, 'right', 'Browser').click(); // click 2: the Browser tab
  if (await app.evaluate(() => '__calls' in window)) await expect.poll(async () => (await calls(app, 'browser_control')).length).toBeGreaterThan(0); // subscribed
}

// Ticket 997 L7: no driver chip; while the owner has the space, Hand back is one orange button in the toolbar row (the agent's
// side, badge and dot, is browser-widget-l7.spec.ts).
test('couse_chip_reachable', async ({ app, core }) => {
  await fakeApp(app);
  const a = core.agent(core.project('a'), 'a', 'never-created', false);
  await openWindow(app, {}, core);
  await browserTab(app, a.id);
  await expect.poll(async () => calls(app, 'browser_control')).toEqual([['browser_control', { space: a.id }]]);
  const handBack = pane(app).getByRole('button', { name: 'You have control · Hand back' });
  await expect(handBack).toHaveCount(0);

  // The owner clicked in the page: the app flips the space and tells the window.
  await emit(app, { space: a.id, user: true, reason: null });
  await expect(handBack).toBeVisible();
  await expect(handBack).toHaveCSS('color', await app.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--you').trim()).then(hexToRgb));

  await handBack.click();
  await expect.poll(async () => calls(app, 'browser_hand_back')).toEqual([['browser_hand_back', { space: a.id }]]);
  await expect(handBack).toHaveCount(0);
});

test('couse_chip_shows_handoff_reason_and_ignores_other_spaces', async ({ app, core }) => {
  await fakeApp(app);
  const a = core.agent(core.project('a'), 'a', 'never-created', false);
  await openWindow(app, {}, core);
  await browserTab(app, a.id);
  await expect.poll(async () => (await calls(app, 'browser_control')).length).toBeGreaterThan(0);
  await emit(app, { space: 'another-session', user: true, reason: null });
  await expect(pane(app).getByRole('button', { name: /Hand back/ })).toHaveCount(0);
  await emit(app, { space: a.id, user: true, reason: 'sign in needs the password' });
  await expect(pane(app).getByRole('button', { name: 'You have control: sign in needs the password · Hand back' })).toBeVisible();
});

test('couse_chip_needs_the_app', async ({ app, core }) => {
  const a = core.agent(core.project('a'), 'a', 'never-created', false);
  await openWindow(app, {}, core);
  await browserTab(app, a.id);
  await expect(pane(app).getByText('The browser needs the Nunchiro app')).toBeVisible();
  await expect(pane(app).getByRole('button', { name: /Hand back/ })).toHaveCount(0);
});

function hexToRgb(hex: string) {
  const n = parseInt(hex.replace('#', ''), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}
