// Ticket 328 part 2: an agent space's tabs in the side pane. The native views need the app, so its bridge is faked (as
// browser-view.spec.ts): `browser_tabs` answers the agent's list, `browser_nav` each tab's page; every call is recorded.
// The app half (tab lookup per space, refusals, takeover per tab) is unit-tested in app/src-tauri/src/browser/agent.rs.
import type { Page } from '@playwright/test';
import { expect, openWindow, test } from './fixtures';
import { icon } from './d5b';

type Call = [string, Record<string, unknown>];
type Tabs = { tabs: { tab: number; url: string; title: string }[]; current: number };
type Fake = { __calls: Call[]; __tabs: Tabs | null; __emit: (event: string, payload: unknown) => void };
const fakeApp = (page: Page) =>
  page.addInitScript(() => {
    const w = window as unknown as Fake & { __TAURI_INTERNALS__: unknown };
    const cbs = new Map<number, (e: unknown) => void>();
    const subs: [string, number][] = [];
    let next = 1;
    w.__calls = [];
    w.__tabs = null;
    w.__TAURI_INTERNALS__ = {
      transformCallback: (cb: (e: unknown) => void) => (cbs.set(next, cb), next++),
      invoke: (cmd: string, args: Record<string, unknown>) => {
        if (cmd === 'browser_tabs') return Promise.resolve(w.__tabs);
        if (cmd === 'browser_nav') {
          const tab = w.__tabs?.tabs.find((x) => x.tab === ((args.tab as number | undefined) ?? 1));
          return Promise.resolve(tab ? { url: tab.url, title: tab.title, back: false, forward: false, loading: false, progress: 1 } : null);
        }
        w.__calls.push([cmd, args]);
        if (cmd === 'plugin:event|listen') subs.push([args.event as string, args.handler as number]);
        return Promise.resolve(null);
      },
      metadata: {},
    };
    w.__emit = (event, payload) => subs.filter(([e]) => e === event).forEach(([, h]) => cbs.get(h)?.({ event, id: 1, payload }));
  });
const setTabs = (page: Page, tabs: Tabs | null) => page.evaluate((t) => void ((window as unknown as Fake).__tabs = t), tabs);
const emit = (page: Page, event: string, payload: unknown) => page.evaluate(([e, p]) => (window as unknown as Fake).__emit(e as string, p), [event, payload] as const);
const calls = (page: Page, cmd: string) => page.evaluate((c) => (window as unknown as Fake).__calls.filter((x) => x[0] === c).map((x) => x[1]), cmd);
const pane = (page: Page) => page.locator('[data-side-pane]:not([hidden])');

const page = (tab: number, title: string) => ({ tab, url: `http://127.0.0.1:5731/p${tab}`, title });

test('browser_agent_tabs_switch_close_and_take_over', async ({ app, core }) => {
  await fakeApp(app);
  const a = core.agent(core.project('a'), 'a', 'never-created', false);
  await openWindow(app, {}, core);
  // The agent opened two tabs and works in tab 2.
  await setTabs(app, { tabs: [page(1, 'Inbox'), page(2, 'Docs')], current: 2 });
  await app.locator(`.tab[data-tab="${a.id}"]`).click();
  await icon(app, 'right', 'Terminal').click();
  await icon(app, 'right', 'Browser').click();
  const side = pane(app);
  const tabs = side.getByRole('tablist', { name: 'Browser tabs' }).getByRole('tab');
  const bar = side.getByLabel('Address');

  // The same strip as My browser, with page titles; the owner's view stays on tab 1 (the agent's switch does not move it).
  await expect(tabs).toHaveText(['Inbox', 'Docs']);
  await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true');
  await expect(tabs.nth(1)).toHaveAttribute('data-tip', 'Docs · http://127.0.0.1:5731/p2 · The agent works in this tab');
  await expect(bar).toHaveValue('http://127.0.0.1:5731/p1');
  // The owner cannot create or close the agent's tabs.
  await expect(side.getByRole('button', { name: 'New browser tab' })).toHaveCount(0);
  await expect(side.getByRole('button', { name: /^Close / })).toHaveCount(0);

  // Show tab 2: its parked view goes in the slot, tab 1's view hides; the address bar is tab 2's.
  await tabs.nth(1).click();
  await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
  await expect(bar).toHaveValue('http://127.0.0.1:5731/p2');
  await expect.poll(async () => (await calls(app, 'browser_show')).some((c) => c.space === a.id && c.tab === 2)).toBe(true);
  await expect.poll(async () => (await calls(app, 'browser_hide')).some((c) => c.space === a.id && c.tab === undefined)).toBe(true);
  // A page load in tab 1 does not move tab 2's address bar; one in tab 2 does.
  await emit(app, 'browser-moved', { space: a.id, url: 'http://127.0.0.1:5731/other', finished: false });
  await emit(app, 'browser-moved', { space: a.id, tab: 2, url: 'http://127.0.0.1:5731/p2b', finished: false });
  await expect(bar).toHaveValue('http://127.0.0.1:5731/p2b');

  // Take over tab 2: the toolbar acts on tab 2, never tab 1 (the app then holds the space and moves the agent to tab 2).
  await side.getByRole('button', { name: 'Reload' }).click();
  await expect.poll(async () => (await calls(app, 'browser_reload')).map((c) => c.tab)).toEqual([2]);
  await emit(app, 'browser-control', { space: a.id, user: true, reason: null });
  await expect(side.getByRole('button', { name: 'You have control · Hand back' })).toBeVisible();

  // The agent opens tab 3; the owner shows it; then tab 3 is gone and the agent works in tab 2: the slot falls back to it.
  await setTabs(app, { tabs: [page(1, 'Inbox'), page(2, 'Docs'), page(3, 'Cart')], current: 3 });
  await expect(tabs).toHaveText(['Inbox', 'Docs', 'Cart']);
  await tabs.nth(2).click();
  await expect.poll(async () => (await calls(app, 'browser_show')).some((c) => c.tab === 3)).toBe(true);
  await setTabs(app, { tabs: [page(1, 'Inbox'), page(2, 'Docs')], current: 2 });
  await expect(tabs).toHaveText(['Inbox', 'Docs']);
  await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
  await expect.poll(async () => (await calls(app, 'browser_hide')).some((c) => c.tab === 3)).toBe(true);

  // One tab left: ticket 997 L7, the row stays (it holds the space chip) with that one tab; none: no tab list.
  await setTabs(app, { tabs: [page(1, 'Inbox')], current: 1 });
  await expect(tabs).toHaveText(['Inbox']);
  await setTabs(app, { tabs: [], current: 1 });
  await expect(side.getByRole('tablist', { name: 'Browser tabs' })).toHaveCount(0);
  await expect(bar).toHaveValue('http://127.0.0.1:5731/p1');
  // Nothing of the agent's tabs is stored.
  expect(await app.evaluate(() => JSON.stringify(localStorage))).not.toContain(':5731/p2'); // the URL, not "/p2": the run's own folder can be named .scratch/p2…
});
