// Ticket 997 L7: the browser chrome of the approved mockup (docs/design/browser-widget-1119.html, round 2). The app's bridge is
// faked as in browser-agent-tabs.spec.ts; the outline over the page is the app's own layer (agent.rs `drives`, unit-tested there)
// and is checked live in the RC run.
import type { Page } from '@playwright/test';
import { expect, openWindow, test, type Core } from './fixtures';
import { icon } from './d5b';

type Call = [string, Record<string, unknown>];
type Tabs = { tabs: { tab: number; url: string; title: string }[]; current: number; agent?: boolean };
type Fake = { __calls: Call[]; __tabs: Tabs; __emit: (event: string, payload: unknown) => void };
const fakeApp = (page: Page) =>
  page.addInitScript(() => {
    const w = window as unknown as Fake & { __TAURI_INTERNALS__: unknown };
    const cbs = new Map<number, (e: unknown) => void>();
    const subs: [string, number][] = [];
    let next = 1;
    w.__calls = [];
    w.__tabs = { tabs: [{ tab: 1, url: 'http://127.0.0.1:5731/billing', title: 'Billing · Lumen' }], current: 1, agent: false };
    w.__emit = (event, payload) => subs.filter(([e]) => e === event).forEach(([, h]) => cbs.get(h)?.({ event, id: 1, payload }));
    w.__TAURI_INTERNALS__ = {
      transformCallback: (cb: (e: unknown) => void) => (cbs.set(next, cb), next++),
      invoke: (cmd: string, args: Record<string, unknown>) => {
        if (cmd === 'browser_tabs') return Promise.resolve(w.__tabs);
        if (cmd === 'browser_nav') return Promise.resolve({ url: w.__tabs.tabs[0].url, title: '', back: true, forward: false, loading: false, progress: 1 });
        w.__calls.push([cmd, args]);
        if (cmd === 'plugin:event|listen') subs.push([args.event as string, args.handler as number]);
        if (cmd === 'browser_control') return Promise.resolve({ space: args.space, user: false, reason: null });
        // As the app does: the owner's take and Hand back flip the space and tell the window.
        if (cmd === 'browser_take') w.__emit('browser-control', { space: args.space, user: true, reason: null });
        if (cmd === 'browser_hand_back') w.__emit('browser-control', { space: args.space, user: false, reason: null });
        return Promise.resolve(null);
      },
      metadata: {},
    };
  });
const setTabs = (page: Page, tabs: Tabs) => page.evaluate((t) => void ((window as unknown as Fake).__tabs = t), tabs);
const calls = (page: Page, cmd: string) => page.evaluate((c) => (window as unknown as Fake).__calls.filter((x) => x[0] === c).map((x) => x[1]), cmd);
const emit = (page: Page, payload: unknown) => page.evaluate((p) => (window as unknown as Fake).__emit('browser-control', p), payload);
const pane = (page: Page) => page.locator('[data-side-pane]:not([hidden])');

async function agentBrowser(app: Page, core: Core) {
  await fakeApp(app);
  const a = core.agent(core.project('a'), 'fix-login', 'never-created', false);
  await openWindow(app, {}, core);
  await app.locator(`.tab[data-tab="${a.id}"]`).click();
  await icon(app, 'right', 'Terminal').click();
  await icon(app, 'right', 'Browser').click();
  await expect(pane(app).getByLabel('Address')).toHaveValue('http://127.0.0.1:5731/billing');
  return a;
}

test('l7_toolbar_icons_and_tooltips', async ({ app, core }) => {
  await agentBrowser(app, core);
  const p = pane(app);
  const tool = p.locator('.btool');
  // One 36 px row each, a 28 px field, ghost icon buttons with their tooltips; no text buttons left in the row.
  for (const row of [tool, p.locator('.btabs')]) expect((await row.boundingBox())!.height).toBe(36); // its 1 px border inside, as the mockup's .p-row
  expect((await p.locator('.baddr').boundingBox())!.height).toBe(28);
  for (const [name, tip] of [
    ['Back', 'Back'],
    ['Forward', 'Forward'],
    ['Reload', 'Reload'],
    ['Annotate', 'Annotate: click an element to add a note'],
    ['Take over and open full size', 'Take over and open full size'],
    ['More actions', 'More actions'],
  ]) {
    const b = tool.getByRole('button', { name, exact: true });
    await expect(b).toHaveAttribute('data-tip', tip);
    await expect(b.locator('svg')).toHaveCount(1);
    expect((await b.boundingBox())!.width).toBe(28);
  }
  await expect(tool.getByRole('button', { name: 'Forget page' })).toHaveCount(0);
  // Annotate shows pressed while picking.
  const annotate = tool.getByRole('button', { name: 'Annotate' });
  await annotate.click();
  await expect(annotate).toHaveAttribute('aria-pressed', 'true');
  await annotate.click();
  await expect(annotate).toHaveAttribute('aria-pressed', 'false');
  // Forget page is in ⋯, with what it does.
  await tool.getByRole('button', { name: 'More actions' }).click();
  await expect(p.getByRole('menuitem', { name: /^Forget page/ })).toContainText('Logins stay in the profile');
  // The space switcher is a chip on the tab row, the session's name, its native select still labelled.
  const chip = p.locator('.btabs .bchip');
  await expect(chip).toContainText('fix-login');
  await expect(chip.getByLabel('Browser space')).toHaveCount(1);
  expect((await chip.boundingBox())!.height).toBe(26);
});

test('l7_tab_badge_and_dot_follow_who_drives', async ({ app, core }) => {
  const a = await agentBrowser(app, core);
  const p = pane(app);
  const tab = p.getByRole('tab', { name: 'Billing · Lumen' });
  const dot = p.locator('.bchip .bsdot');
  await expect(tab).toBeVisible(); // one tab still shows: the row holds the chip
  await expect(p.locator('[data-agent-badge]')).toHaveCount(0);
  await expect(dot).toHaveClass('bsdot');

  // The agent acted (the app's `agent`: a verb in the last 20 s): its tab carries the pointer and the dot turns blue.
  await setTabs(app, { tabs: [{ tab: 1, url: 'http://127.0.0.1:5731/billing', title: 'Billing · Lumen' }], current: 1, agent: true });
  await expect(tab.locator('[data-agent-badge]')).toBeVisible();
  await expect(tab).toHaveAttribute('data-tip', 'The agent is using this page. A click or key in it takes over.');
  await expect(dot).toHaveClass('bsdot run');

  // A click in the page hands it to the owner: no badge, the dot is orange, Hand back is in the toolbar row.
  await emit(app, { space: a.id, user: true, reason: null });
  await expect(p.locator('[data-agent-badge]')).toHaveCount(0);
  await expect(dot).toHaveClass('bsdot you');
  const back = p.locator('.btool').getByRole('button', { name: 'You have control · Hand back' });
  await expect(back).toHaveAttribute('data-tip', 'You have control. Hand back to the agent');
  // At widget width (under 560 px) "You have control" gives way and "Hand back" keeps its word while it fits (ticket 1041
  // lane 7b); the tooltip says both. Under 380 px only the icon stays (browser-view.css).
  await expect(back.getByText('You have control')).toBeHidden();
  await expect(back.getByText('Hand back', { exact: true })).toBeVisible();
  expect((await back.boundingBox())!.width).toBeGreaterThan(28);

  // 20 s on with no verb, the app says so: badge and blue dot off.
  await back.click();
  await setTabs(app, { tabs: [{ tab: 1, url: 'http://127.0.0.1:5731/billing', title: 'Billing · Lumen' }], current: 1, agent: false });
  await expect(dot).toHaveClass('bsdot');
  await expect(p.locator('[data-agent-badge]')).toHaveCount(0);
});

test('l7_take_over_maximises_and_hand_back_restores', async ({ app, core }) => {
  const a = await agentBrowser(app, core);
  const p = pane(app);
  const width = (await p.boundingBox())!.width;
  const side = (await p.locator('.bslot').boundingBox())!;
  await expect(app.locator('.shead')).toBeVisible();
  await expect(app.locator('.composer')).toBeVisible();
  await p.getByRole('button', { name: 'Take over and open full size' }).click();
  await expect.poll(async () => calls(app, 'browser_take')).toEqual([{ space: a.id }]);
  await expect(p).toHaveAttribute('data-max', '');
  // Maximised, the owner's control shows in words, and the full-size icon shows pressed as "Back to side width".
  const back = p.locator('.btool').getByRole('button', { name: 'You have control · Hand back' });
  await expect(back.getByText('You have control')).toBeVisible();
  await expect(p.getByRole('button', { name: 'Back to side width' })).toHaveClass('bib on');
  // Look v20: full size is the mockup's two rows over the page; the session header and the composer give way, the page gets the room.
  await expect(app.locator('.shead')).toBeHidden();
  await expect(app.locator('.composer')).toBeHidden();
  const full = (await p.locator('.bslot').boundingBox())!;
  expect(full.height).toBeGreaterThan(side.height + 60);
  expect(full.y).toBeLessThan(side.y);

  await back.click();
  await expect.poll(async () => calls(app, 'browser_hand_back')).toEqual([{ space: a.id }]);
  await expect(p).not.toHaveAttribute('data-max', '');
  expect((await p.boundingBox())!.width).toBeCloseTo(width, 0);
  await expect(back).toHaveCount(0);
  await expect(app.locator('.shead')).toBeVisible();
  await expect(app.locator('.composer')).toBeVisible();

  // Back to side width returns only the width; the owner keeps the page.
  await p.getByRole('button', { name: 'Take over and open full size' }).click();
  await expect(p).toHaveAttribute('data-max', '');
  await p.getByRole('button', { name: 'Back to side width' }).click();
  await expect(p).not.toHaveAttribute('data-max', '');
  await expect(p.locator('.btool').getByRole('button', { name: 'You have control · Hand back' })).toBeVisible();
  // The owner already has control: the full-size button no longer says take over.
  await expect(p.getByRole('button', { name: 'Open full size' })).toBeVisible();
  expect(await calls(app, 'browser_hand_back')).toHaveLength(1);
});

// Ticket 997 (look v22 e): full size shows the agent page at its real 1280x800 when the window has room, else only as small as
// needed; the scale is the app's fit rule A1 on the slot (mod.rs `fit`: min(1, W/1280, H/800), down to 1/160 steps).
const scale = (b: { width: number; height: number }) => Math.max(1 / 160, Math.floor(Math.min(1, b.width / 1280, b.height / 800) * 160) / 160);
test('l7_full_size_draws_the_page_at_real_size_when_it_fits', async ({ app, core }) => {
  await app.setViewportSize({ width: 1440, height: 940 });
  await agentBrowser(app, core);
  const p = pane(app);
  const slot = p.locator('.bslot');
  expect(scale((await slot.boundingBox())!)).toBeLessThan(0.5); // the widget keeps its fitted scale
  await p.getByRole('button', { name: 'Take over and open full size' }).click();
  await expect(p).toHaveAttribute('data-max', '');
  // The sidebars, the centre tab row and the status bar give way; the title row and the pane's two rows stay.
  for (const sel of ['.sbar.l', '.zh', '.status']) await expect(app.locator(sel).first()).toBeHidden();
  // The rows that stay (the title row and the pane's two rows) take the design book's heights: the window is sized from
  // what they take, so "when it fits" means exactly 800 px of slot, not a height that held for an older chrome.
  await expect.poll(async () => (await slot.boundingBox())!.width).toBeGreaterThan(1000);
  const full = (await slot.boundingBox())!;
  const [cols, rows] = [1440 - full.width, 940 - full.height];
  await app.setViewportSize({ width: 1440, height: Math.ceil(rows) + 800 });
  await expect.poll(async () => scale((await slot.boundingBox())!)).toBe(1);
  // The app was told the larger slot (the native view follows it).
  await expect.poll(async () => Math.round((await calls(app, 'browser_show')).at(-1)!.h as number)).toBeGreaterThanOrEqual(800);
  await app.setViewportSize({ width: 1440, height: Math.ceil(rows) + 780 });
  await expect.poll(async () => scale((await slot.boundingBox())!)).toBe(0.975); // 780 px of slot: 1248x780
  await app.setViewportSize({ width: 1000, height: Math.ceil(rows) + 800 }); // tall enough that only the width binds
  // A smaller window: fitted, its width binds (the icon bars and the pane's edges take `cols`).
  const small = { width: 1000 - cols, height: Math.ceil(rows) + 800 - rows };
  expect(small.width / 1280, 'the width binds').toBeLessThan(small.height / 800);
  await expect.poll(async () => scale((await slot.boundingBox())!)).toBe(scale(small));
  // Back to side width: everything returns.
  await p.getByRole('button', { name: 'Back to side width' }).click();
  for (const sel of ['.sbar.l', '.zh', '.status']) await expect(app.locator(sel).first()).toBeVisible();
});
