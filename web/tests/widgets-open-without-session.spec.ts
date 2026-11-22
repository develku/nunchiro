// v25-exit-widgets (ticket 288, needs 213): the Browser and Terminal widgets open with no agent session focused, from
// their labelled right-bar icons (one click). Browser: the user's own space ("My browser"), a switcher over the view; Terminal:
// a shell in the project the window shows. The native browser needs the app, so its bridge is faked and the calls recorded
// (as browser-view.spec.ts); the page itself is the real-app check in REPORT (`browser_loads_url_in_agent_session`).
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, openWindow, test, type Core } from './fixtures';
import { icon, sidebar, toast } from './d5b';

type Call = [string, Record<string, unknown>];
const fakeApp = (page: Page) =>
  page.addInitScript(() => {
    const w = window as unknown as { __calls: Call[]; __TAURI_INTERNALS__: unknown };
    w.__calls = [];
    w.__TAURI_INTERNALS__ = { invoke: (cmd: string, args: Record<string, unknown>) => (w.__calls.push([cmd, args]), Promise.resolve(null)), transformCallback: () => 1, metadata: {} };
  });
const calls = (page: Page, cmd: string) => page.evaluate((c) => (window as unknown as { __calls: Call[] }).__calls.filter((x) => x[0] === c), cmd);
type Snap = { id: string; kind: string; label: string; state: string; project: string };
const snap = (core: Core) => core.cli('snapshot', '--json').sessions as Snap[];
const refusal = (p: Page) => p.getByText(/Open an agent session to (use its browser|see its terminal)/);

test('browser_opens_without_session: the Browser icon shows the user\'s own space, no refusal', async ({ app, core }) => {
  await fakeApp(app);
  await openWindow(app, {}, core);
  await expect(app.locator('.tab[data-tab]')).toHaveCount(0); // no session at all
  await icon(app, 'right', 'Browser').click(); // the one click
  const side = sidebar(app, 'right');
  await expect(side.getByLabel('Browser space')).toHaveValue('you');
  await expect(side.getByLabel('Browser space').locator('option:checked')).toHaveText('My browser');
  await expect(side.getByLabel('Address')).toBeVisible();
  await expect(refusal(app)).toHaveCount(0);
  await expect(toast(app)).toHaveCount(0);
  // It is a real view: an address opens in the user's store, which no agent verb ever runs in.
  await side.getByLabel('Address').fill('http://127.0.0.1:5731/mine');
  await side.getByLabel('Address').press('Enter');
  await expect.poll(async () => (await calls(app, 'browser_show')).length).toBeGreaterThan(0);
  expect((await calls(app, 'browser_show'))[0][1]).toMatchObject({ space: 'you', url: 'http://127.0.0.1:5731/mine' });
  // The icon toggles it closed.
  await icon(app, 'right', 'Browser').click();
  await expect(side).toHaveCount(0);
});

// The bridge above plus Tauri's event channel, so a spec can play the native view's events.
const fakeEvents = (page: Page) =>
  page.addInitScript(() => {
    const w = window as unknown as { __TAURI_INTERNALS__: Record<string, unknown>; __emit: (event: string, payload: unknown) => void };
    const invoke = w.__TAURI_INTERNALS__.invoke as (cmd: string, args: Record<string, unknown>) => Promise<unknown>;
    const callbacks: ((e: unknown) => void)[] = [];
    const listeners: Record<string, number[]> = {};
    w.__TAURI_INTERNALS__.transformCallback = (cb: (e: unknown) => void) => callbacks.push(cb) - 1;
    w.__TAURI_INTERNALS__.invoke = (cmd: string, args: Record<string, unknown>) => {
      if (cmd === 'plugin:event|listen') (listeners[args.event as string] ??= []).push(args.handler as number);
      return invoke(cmd, args);
    };
    w.__emit = (event, payload) => (listeners[event] ?? []).forEach((id) => callbacks[id]({ event, id, payload }));
  });

test('browser_failed_load_says_why: a page that cannot load names the reason, and the next page clears it', async ({ app, core }) => {
  await fakeApp(app);
  await fakeEvents(app);
  await openWindow(app, {}, core);
  await icon(app, 'right', 'Browser').click();
  const side = sidebar(app, 'right');
  const bar = side.getByLabel('Address');
  await bar.fill('https://nowhere.invalid');
  await bar.press('Enter');
  await expect.poll(async () => (await calls(app, 'browser_show')).length).toBeGreaterThan(0);
  const emit = (event: string, payload: unknown) => app.evaluate(([e, p]) => (window as unknown as { __emit: (e: unknown, p: unknown) => void }).__emit(e, p), [event, payload] as const);
  const why = 'A server with the specified hostname could not be found.';
  await emit('browser-failed', { space: 'other', error: 'not this view' });
  await expect(side.getByRole('alert')).toHaveCount(0);
  await emit('browser-failed', { space: 'you', error: why, code: -1200, url: 'https://nowhere.invalid/' });
  await expect(side.getByRole('alert')).toContainText(why);
  await expect(bar).toHaveValue('https://nowhere.invalid'); // what failed stays there to correct
  await emit('browser-moved', { space: 'you', url: 'https://www.example.org/' });
  await expect(side.getByRole('alert')).toHaveCount(0);
  await expect(bar).toHaveValue('https://www.example.org/');
});

test('browser_address_survives_widget_switch: closing the widget and opening it again keeps the typed address', async ({ app, core }) => {
  await fakeApp(app);
  await openWindow(app, {}, core);
  await icon(app, 'right', 'Browser').click();
  const bar = sidebar(app, 'right').getByLabel('Address');
  await bar.fill('https://example.com/typed');
  await icon(app, 'right', 'Browser').click(); // away
  await expect(bar).toHaveCount(0);
  await icon(app, 'right', 'Browser').click(); // and back
  await expect(bar).toHaveValue('https://example.com/typed');
});

test('browser_switches_space: the switcher lists My browser and each agent, and changes the view', async ({ app, core }) => {
  await fakeApp(app);
  const a = core.agent(core.project('a'), 'planner', 'never-created', false);
  await openWindow(app, {}, core);
  // An agent session focused: its pane's Browser tab shows that agent's space.
  await app.locator(`.tab[data-tab="${a.id}"]`).click();
  await icon(app, 'right', 'Terminal').click();
  await icon(app, 'right', 'Browser').click();
  const pane = app.locator('[data-side-pane]:not([hidden])');
  const switcher = pane.getByLabel('Browser space');
  await expect(switcher).toHaveValue(a.id);
  await expect(switcher.locator('option')).toHaveText(['My browser', 'planner (agent)']);
  await pane.getByLabel('Address').fill('http://127.0.0.1:5731/agent');
  await pane.getByLabel('Address').press('Enter');
  await expect.poll(async () => (await calls(app, 'browser_show')).map((c) => c[1].space)).toContain(a.id);
  // Switching to My browser hides the agent's view and shows the user's own: its address loads in the "you" store.
  await switcher.selectOption({ label: 'My browser' });
  await expect.poll(async () => (await calls(app, 'browser_hide')).map((c) => c[1].space)).toContain(a.id);
  await pane.getByLabel('Address').fill('http://127.0.0.1:5731/mine');
  await pane.getByLabel('Address').press('Enter');
  await expect.poll(async () => (await calls(app, 'browser_show')).map((c) => c[1].space)).toContain('you');
  // The agent's own controls (the control chip) are not offered on the user's space.
  await expect(pane.getByRole('button', { name: 'Hand back' })).toHaveCount(0);
  await switcher.selectOption({ label: 'planner (agent)' });
  await expect(switcher).toHaveValue(a.id);
});

test('terminal_widget_opens_without_session: the Terminal icon starts a shell in the project, no refusal', async ({ app, core }) => {
  const p = core.project('demo');
  const first = core.shell(p, 'first');
  await openWindow(app, {}, core);
  await app.locator(`.tab[data-tab="${first.id}"]`).hover();
  await app.getByRole('button', { name: 'Close tab first' }).click(); // close the tab: no session is focused, the session runs on
  await expect(app.locator('.tab[data-tab]')).toHaveCount(0);
  await icon(app, 'right', 'Terminal').click(); // the one click
  await expect.poll(() => snap(core).filter((s) => s.kind === 'shell' && s.state === 'running').length).toBe(2);
  const started = snap(core).find((s) => s.id !== first.id)!;
  expect(started.project).toBe(p);
  await expect(app.locator(`.tab[data-tab="${started.id}"]`)).toHaveAttribute('aria-selected', 'true');
  await expect(refusal(app)).toHaveCount(0);
  await expect(toast(app)).toHaveCount(0);
});

// Real-app 11-10 defect M (v32-shell-2): a right-bar icon never restarts, replaces or removes the ended session; its tab stays
// and its Restart is the way to start it again. Ticket 1037 (owner 11-21): the press still opens a terminal, a new shell in that
// session's project (it used to say "has ended" and open nothing, as after every app restart, when sessions are resumable).
test('terminal_widget_opens_without_session: with an ended session focused it opens a new shell beside it', async ({ app, core }) => {
  const p = core.project('demo');
  const job = core.shell(p, 'job', '/bin/sh', '-c', 'read x; exit 0');
  await openWindow(app, {}, core);
  await app.locator(`.tab[data-tab="${job.id}"]`).click();
  core.cli('session', 'send-text', job.id, 'x\r');
  await expect.poll(() => snap(core).find((s) => s.id === job.id)?.state).toBe('exited');
  await expect(app.locator(`.tab[data-tab="${job.id}"] .tdot`)).toHaveAttribute('data-s', 'done'); // the window has learned it ended: the state the click reads
  await icon(app, 'right', 'Terminal').click();
  await expect.poll(() => snap(core).filter((s) => s.kind === 'shell' && s.state === 'running').length).toBe(1);
  const started = snap(core).find((s) => s.id !== job.id)!;
  expect(started.project).toBe(p);
  expect(snap(core).find((s) => s.id === job.id)?.state).toBe('exited'); // not restarted
  await expect(app.locator(`.tab[data-tab="${started.id}"]`)).toHaveAttribute('aria-selected', 'true');
  await expect(app.locator(`.tab[data-tab="${job.id}"]`)).toHaveCount(1); // its tab stays
  await expect(toast(app)).toHaveCount(0);
  await expect(refusal(app)).toHaveCount(0);
});

// v25f F14 (owner 11-08, amends ticket 288 item 2): no project anywhere still starts a shell, in $HOME; never the New tab popover.
test('terminal_widget_opens_without_session: an empty window starts a shell in home, no popover', async ({ app, core }) => {
  await openWindow(app, {}, core);
  await expect(app.locator('.tab[data-tab]')).toHaveCount(0);
  await icon(app, 'right', 'Terminal').click();
  await expect.poll(() => snap(core).filter((s) => s.kind === 'shell' && s.state === 'running').length).toBe(1);
  const started = snap(core)[0];
  expect(started.project).toBe(fs.realpathSync(path.join(core.home, 'sentinel-home'))); // the core's $HOME
  await expect(app.locator(`.tab[data-tab="${started.id}"]`)).toHaveAttribute('aria-selected', 'true');
  await expect(app.getByRole('dialog', { name: 'New tab' })).toHaveCount(0);
  await expect(refusal(app)).toHaveCount(0);
});

test('widgets_reachable_within_two_clicks: Browser and Terminal are one labelled click from the main view', async ({ app, core }) => {
  await fakeApp(app);
  const p = core.project('demo');
  core.shell(p, 'x');
  await openWindow(app, {}, core);
  await expect(icon(app, 'right', 'Browser')).toBeVisible();
  await expect(icon(app, 'right', 'Terminal')).toBeVisible();
  await icon(app, 'right', 'Browser').click();
  await expect(sidebar(app, 'right').getByLabel('Address')).toBeVisible();
});

test('browser_annotate_only_on_the_panes_own_space: another agent\'s page never annotates into this composer', async ({ app, core }) => {
  await fakeApp(app);
  const a = core.agent(core.project('a'), 'planner', 'never-created', false);
  core.agent(core.project('b'), 'builder', 'never-created', false);
  await openWindow(app, {}, core);
  await app.locator(`.tab[data-tab="${a.id}"]`).click();
  await icon(app, 'right', 'Terminal').click();
  await icon(app, 'right', 'Browser').click();
  const pane = app.locator('[data-side-pane]:not([hidden])');
  await expect(pane.getByRole('button', { name: 'Annotate' })).toBeVisible(); // its own space
  await pane.getByLabel('Browser space').selectOption({ label: 'builder (agent)' });
  await expect(pane.getByRole('button', { name: 'Annotate' })).toHaveCount(0);
  await pane.getByLabel('Browser space').selectOption({ label: 'My browser' });
  await expect(pane.getByRole('button', { name: 'Annotate' })).toBeVisible(); // ticket 1038: the owner's own pages annotate into this composer
  await pane.getByLabel('Browser space').selectOption({ label: 'planner (agent)' });
  await expect(pane.getByRole('button', { name: 'Annotate' })).toBeVisible();
});
