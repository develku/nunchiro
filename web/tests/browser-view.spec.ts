// V2.5-19 (WP1): the side pane's Browser tab. The native WKWebView needs the app, so the app's bridge is faked here and
// every call it receives is recorded; the view itself (cookies, IPC, forget, back, reload) is checked by scripts/browser-selftest.py.
import type { Page } from '@playwright/test';
import { expect, openWindow, test } from './fixtures';
import { showPreview } from './agent-pane';
import { icon } from './d5b';

type Call = [string, Record<string, unknown>];
type Nav = { url: string; back: boolean; forward: boolean; loading: boolean; progress: number; popup?: { url: string | null } };
type Fake = { __calls: Call[]; __nav: Nav | null; __emit: (event: string, payload: unknown) => void };
const fakeApp = (page: Page) =>
  page.addInitScript(() => {
    const w = window as unknown as Fake & { __TAURI_INTERNALS__: unknown };
    const cbs = new Map<number, (e: unknown) => void>();
    const subs: [string, number][] = [];
    let next = 1;
    w.__calls = [];
    w.__nav = null;
    w.__TAURI_INTERNALS__ = {
      transformCallback: (cb: (e: unknown) => void) => (cbs.set(next, cb), next++),
      invoke: (cmd: string, args: Record<string, unknown>) => {
        if (cmd === 'browser_nav') return Promise.resolve(w.__nav);
        w.__calls.push([cmd, args]);
        if (cmd === 'browser_forget') w.__nav = null; // as the app: a forgotten space has no view, so its poll answers none
        if (cmd === 'plugin:event|listen') subs.push([args.event as string, args.handler as number]);
        return Promise.resolve(null);
      },
      metadata: {},
    };
    w.__emit = (event, payload) => subs.filter(([e]) => e === event).forEach(([, h]) => cbs.get(h)?.({ event, id: 1, payload }));
  });
/** What the app answers for this space's native view from now on (`null`: it has none). */
const setNav = (page: Page, nav: Partial<Nav> | null) => page.evaluate((n) => void ((window as unknown as Fake).__nav = n && { url: '', back: false, forward: false, loading: false, progress: 1, ...n }), nav);
const emit = (page: Page, event: string, payload: unknown) => page.evaluate(([e, p]) => (window as unknown as Fake).__emit(e as string, p), [event, payload] as const);
const calls = (page: Page, cmd: string) => page.evaluate((c) => (window as unknown as { __calls: Call[] }).__calls.filter((x) => x[0] === c), cmd);
const pane = (page: Page) => page.locator('[data-side-pane]:not([hidden])');
/** Ticket 997 L7: Forget page is in ⋯ at every width; this opens the menu (if shut) and gives its item. */
async function forgetItem(p: ReturnType<typeof pane>) {
  const more = p.getByRole('button', { name: 'More actions' });
  if ((await more.getAttribute('aria-expanded')) !== 'true') await more.click();
  return p.getByRole('menuitem', { name: /^Forget page/ });
}

test('browser_tab_reachable', async ({ app, core }) => {
  const a = core.agent(core.project('a'), 'a', 'never-created', false);
  await openWindow(app, {}, core);
  await app.locator(`.tab[data-tab="${a.id}"]`).click();
  await icon(app, 'right', 'Terminal').click(); // click 1: the side pane
  await icon(app, 'right', 'Browser').click(); // click 2: the labelled Browser tab
  await expect(pane(app).getByLabel('Address')).toBeVisible();
  await expect(pane(app).getByRole('button', { name: 'Back' })).toBeVisible();
  await expect(pane(app).getByRole('button', { name: 'Reload' })).toBeVisible();
});

test('nav_controls', async ({ app, core }) => {
  await fakeApp(app);
  const a = core.agent(core.project('a'), 'a', 'never-created', false);
  await openWindow(app, {}, core);
  await app.locator(`.tab[data-tab="${a.id}"]`).click();
  await icon(app, 'right', 'Terminal').click();
  await icon(app, 'right', 'Browser').click();
  const bar = pane(app).getByLabel('Address');
  await expect(pane(app).getByRole('button', { name: 'Back' })).toBeDisabled();
  await bar.fill('http://127.0.0.1:5731/a');
  await bar.press('Enter');
  await expect.poll(async () => (await calls(app, 'browser_show')).length).toBeGreaterThan(0);
  expect((await calls(app, 'browser_show'))[0][1]).toMatchObject({ space: a.id, url: 'http://127.0.0.1:5731/a' });
  await bar.fill('http://127.0.0.1:5731/b');
  await bar.press('Enter');
  await expect.poll(async () => calls(app, 'browser_go')).toEqual([['browser_go', { space: a.id, url: 'http://127.0.0.1:5731/b' }]]);
  // Eighth look (C): the field read "ttp://…": an entered address longer than the field shows from its start.
  await bar.pressSequentially(`${'/long'.repeat(30)}`);
  expect(await bar.evaluate((e: HTMLInputElement) => e.scrollLeft)).toBeGreaterThan(0); // typing keeps the caret in view
  await bar.press('Enter');
  expect(await bar.evaluate((e: HTMLInputElement) => e.scrollLeft)).toBe(0);
  await bar.fill('http://127.0.0.1:5731/b');
  await bar.press('Enter');
  await setNav(app, { url: 'http://127.0.0.1:5731/b', back: true });
  await pane(app).getByRole('button', { name: 'Back' }).click();
  await pane(app).getByRole('button', { name: 'Reload' }).click();
  await expect.poll(async () => (await calls(app, 'browser_back')).length).toBe(1);
  await expect.poll(async () => (await calls(app, 'browser_reload')).length).toBe(1);
  // Leaving the tab hides the native view; Forget closes it and disables the controls again.
  await showPreview(app);
  await expect.poll(async () => (await calls(app, 'browser_hide')).length).toBeGreaterThan(0);
  await icon(app, 'right', 'Browser').click();
  await (await forgetItem(pane(app))).click();
  await expect.poll(async () => (await calls(app, 'browser_forget')).length).toBe(1);
  await expect(pane(app).getByRole('button', { name: 'Back' })).toBeDisabled();
});

// Ticket 288: the agent opened the space's first page; the app has the view, parked off screen, and nobody typed anything here.
test('agent_opened_page_shows_without_enter', async ({ app, core }) => {
  await fakeApp(app);
  const a = core.agent(core.project('a'), 'a', 'never-created', false);
  await openWindow(app, {}, core);
  await app.locator(`.tab[data-tab="${a.id}"]`).click();
  await icon(app, 'right', 'Terminal').click();
  await icon(app, 'right', 'Browser').click();
  await expect(pane(app).getByText('No page yet. The agent opens pages here, or type an address to open one.')).toBeVisible(); // ticket 991 C12: an agent's space
  expect(await calls(app, 'browser_show')).toEqual([]);
  await setNav(app, { url: 'http://127.0.0.1:5731/agent' });
  await expect.poll(async () => (await calls(app, 'browser_show')).map((c) => c[1].space)).toContain(a.id);
  await expect(pane(app).getByLabel('Address')).toHaveValue('http://127.0.0.1:5731/agent');
  await expect(pane(app).getByText('No page yet. The agent opens pages here, or type an address to open one.')).toHaveCount(0);
  await expect(await forgetItem(pane(app))).toBeEnabled();
  await pane(app).getByRole('button', { name: 'More actions' }).click(); // shut it again
  expect(await calls(app, 'browser_go')).toEqual([]); // placed, not loaded again
});

// Ticket 309: the toolbar shows what the page's own history and load say.
test('toolbar_follows_the_page', async ({ app, core }) => {
  await fakeApp(app);
  const a = core.agent(core.project('a'), 'a', 'never-created', false);
  await openWindow(app, {}, core);
  await app.locator(`.tab[data-tab="${a.id}"]`).click();
  await icon(app, 'right', 'Terminal').click();
  await icon(app, 'right', 'Browser').click();
  const button = (name: string) => pane(app).getByRole('button', { name, exact: true });
  await setNav(app, { url: 'http://127.0.0.1:5731/a' });
  await expect(button('Reload')).toBeEnabled();
  await expect(button('Back')).toBeDisabled();
  await expect(button('Forward')).toBeDisabled();
  await setNav(app, { url: 'http://127.0.0.1:5731/a', back: true, forward: true });
  await expect(button('Back')).toBeEnabled();
  await button('Forward').click();
  await expect.poll(async () => (await calls(app, 'browser_forward')).length).toBe(1);
  // While it loads Reload becomes Stop, and the line under the toolbar reports the load.
  await expect(pane(app).getByRole('progressbar')).toHaveCount(0);
  await setNav(app, { url: 'http://127.0.0.1:5731/a', loading: true, progress: 0.5 });
  await expect(pane(app).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '50');
  await expect(button('Reload')).toHaveCount(0);
  await button('Stop').click();
  await expect.poll(async () => (await calls(app, 'browser_stop')).length).toBe(1);
  expect(await calls(app, 'browser_reload')).toEqual([]);
  await setNav(app, { url: 'http://127.0.0.1:5731/a' });
  await expect(button('Reload')).toBeVisible();
  await expect(pane(app).getByRole('progressbar')).toHaveCount(0);
});

// Ticket 307: a page's new window opens nothing by itself; the pane says what it asked for, and only the owner's click goes there.
test('popup_notice_offers_the_page_here', async ({ app, core }) => {
  await fakeApp(app);
  const a = core.agent(core.project('a'), 'a', 'never-created', false);
  await openWindow(app, {}, core);
  await app.locator(`.tab[data-tab="${a.id}"]`).click();
  await icon(app, 'right', 'Terminal').click();
  await icon(app, 'right', 'Browser').click();
  await setNav(app, { url: 'http://127.0.0.1:5731/a' });
  await expect(await forgetItem(pane(app))).toBeEnabled();
  await pane(app).getByRole('button', { name: 'More actions' }).click(); // shut it again
  await expect.poll(async () => (await calls(app, 'plugin:event|listen')).map((c) => c[1].event)).toContain('browser-popup');
  await expect(pane(app).locator('.bview [aria-live="polite"]')).toHaveCount(1); // there before it has anything to say
  await emit(app, 'browser-popup', { space: 'another', url: 'https://other.example/' });
  await emit(app, 'browser-popup', { space: a.id, url: 'https://docs.example/guide?x=1' });
  const notice = pane(app).locator('.bnotice');
  await expect(notice).toContainText('docs.example');
  const [box, slot] = [(await notice.boundingBox())!, (await pane(app).locator('.bslot').boundingBox())!];
  expect(box.y + box.height).toBeLessThanOrEqual(slot.y); // a row above the page: the native view covers anything over it
  expect(await calls(app, 'browser_go')).toEqual([]);
  await notice.getByRole('button', { name: 'Open here' }).click();
  await expect.poll(async () => calls(app, 'browser_go')).toEqual([['browser_go', { space: a.id, url: 'https://docs.example/guide?x=1' }]]);
  await expect(notice).toHaveCount(0);
  // A window the view could not load has nothing to offer.
  await emit(app, 'browser-popup', { space: a.id, url: null });
  await expect(notice).toContainText('refused');
  await expect(notice.getByRole('button', { name: 'Open here' })).toHaveCount(0);
  await notice.getByRole('button', { name: 'Dismiss' }).click();
  await expect(notice).toHaveCount(0);
  await expect(pane(app).getByLabel('Address')).toBeFocused();
  await expect.poll(async () => (await calls(app, 'browser_popup_clear')).length).toBeGreaterThan(0); // the same link works again
  // The finishing half of a load is the same page; a page that lands ends the offer, which came from the one before it.
  await emit(app, 'browser-popup', { space: a.id, url: 'https://x.example/' });
  await expect(notice).toContainText('x.example');
  await emit(app, 'browser-moved', { space: a.id, url: 'http://127.0.0.1:5731/a', finished: true });
  await app.waitForTimeout(100);
  await expect(notice).toContainText('x.example');
  await emit(app, 'browser-moved', { space: a.id, url: 'http://127.0.0.1:5731/b', finished: false });
  await expect(notice).toHaveCount(0);
  // Asked while no pane showed the space: the next pane finds it.
  await showPreview(app);
  await setNav(app, { url: 'http://127.0.0.1:5731/b', popup: { url: 'https://kept.example/' } });
  await icon(app, 'right', 'Browser').click();
  await expect(notice).toContainText('kept.example');
});

// F21 on the path ticket 288 added: a view the poll finds while something is over the slot is hidden, never shown under it.
test('view_found_under_an_overlay_stays_hidden', async ({ app, core }) => {
  await fakeApp(app);
  const a = core.agent(core.project('a'), 'a', 'never-created', false);
  await openWindow(app, {}, core);
  await app.locator(`.tab[data-tab="${a.id}"]`).click();
  await icon(app, 'right', 'Terminal').click();
  await icon(app, 'right', 'Browser').click();
  await app.getByRole('navigation', { name: 'Left bar' }).getByRole('button', { name: 'Settings' }).click();
  await app.locator('.ovl').waitFor({ state: 'attached' });
  await setNav(app, { url: 'http://127.0.0.1:5731/agent' });
  await expect.poll(async () => (await calls(app, 'browser_hide')).map((c) => c[1].space)).toContain(a.id);
  await app.waitForTimeout(700); // past the next poll: nothing brings it up while the overlay stays
  expect(await calls(app, 'browser_show')).toEqual([]);
  await app.keyboard.press('Escape');
  await expect(app.locator('.ovl')).toHaveCount(0);
  await expect.poll(async () => (await calls(app, 'browser_show')).map((c) => c[1].space)).toContain(a.id);
});

// Ticket 308: the pane's fixed text comes from the catalogue, so it follows the window's language.
test('pane_text_follows_language', async ({ app, core }) => {
  await fakeApp(app);
  const a = core.agent(core.project('a'), 'a', 'never-created', false);
  await openWindow(app, {}, core);
  await app.locator(`.tab[data-tab="${a.id}"]`).click();
  await icon(app, 'right', 'Terminal').click();
  await icon(app, 'right', 'Browser').click();
  await app.getByRole('navigation', { name: 'Left bar' }).getByRole('button', { name: 'Settings' }).click();
  await app.locator('button[data-page="general"]').click();
  await app.locator('[data-setting="language"]').selectOption('ko');
  await app.keyboard.press('Escape');
  await expect(app.locator('.ovl')).toHaveCount(0);
  for (const name of ['뒤로', '앞으로', '새로고침', '주석', '추가 동작']) await expect(pane(app).getByRole('button', { name, exact: true })).toBeVisible();
  await pane(app).getByRole('button', { name: '추가 동작' }).click();
  await expect(pane(app).getByRole('menuitem', { name: /^페이지 잊기/ })).toBeVisible();
  await expect(pane(app).getByText('아직 페이지가 없습니다', { exact: false })).toBeVisible(); // ticket 991 C12: no driver named before a page
  await expect(pane(app).getByPlaceholder('검색어 또는 URL')).toBeVisible();
});

test('forget_after_restart', async ({ app, core }) => {
  await fakeApp(app);
  const a = core.agent(core.project('a'), 'a', 'never-created', false);
  // A previous run stored a data store for this space (and a garbage entry beside it).
  await app.addInitScript((id) => localStorage.setItem('nunchiro.browser.spaces.v1', JSON.stringify([id, 7])), a.id);
  await openWindow(app, {}, core);
  await app.locator(`.tab[data-tab="${a.id}"]`).click();
  await icon(app, 'right', 'Terminal').click();
  await icon(app, 'right', 'Browser').click();
  const forget = await forgetItem(pane(app));
  await expect(forget).toBeEnabled(); // no page opened this run
  await expect(pane(app).getByRole('button', { name: 'Back' })).toBeDisabled();
  await forget.click();
  await expect.poll(async () => (await calls(app, 'browser_forget')).length).toBe(1);
  await expect(await forgetItem(pane(app))).toBeDisabled();
});

test('address_follows_page_listener_failure_is_quiet', async ({ app, core }) => {
  await fakeApp(app);
  await app.addInitScript(() => {
    const w = window as unknown as { __TAURI_INTERNALS__: { invoke: (c: string) => Promise<unknown> } };
    const ok = w.__TAURI_INTERNALS__.invoke;
    w.__TAURI_INTERNALS__.invoke = (c: string, ...r: unknown[]) => (c.startsWith('plugin:event|') ? Promise.reject(new Error('event.listen not allowed')) : (ok as (...a: unknown[]) => Promise<unknown>)(c, ...r));
  });
  const errors: string[] = [];
  app.on('pageerror', (e) => errors.push(e.message));
  const a = core.agent(core.project('a'), 'a', 'never-created', false);
  await openWindow(app, {}, core);
  await app.locator(`.tab[data-tab="${a.id}"]`).click();
  await icon(app, 'right', 'Terminal').click();
  await icon(app, 'right', 'Browser').click();
  await expect(pane(app).getByLabel('Address')).toBeVisible();
  await app.waitForTimeout(300);
  expect(errors.filter((m) => /not allowed/.test(m))).toEqual([]);
});

// F21: the native view is a child above all page content, so no z-index covers it: while anything is painted over its slot it hides.
test('browser_view_yields_to_overlays', async ({ app, core }) => {
  await fakeApp(app);
  await app.addInitScript(() => {
    const w = window as unknown as { __hits: number; __sweeps: number[] };
    w.__hits = 0;
    w.__sweeps = [];
    let inSweep = false; // a sweep is one synchronous run of hit tests
    const real = document.elementFromPoint.bind(document);
    document.elementFromPoint = (x, y) => {
      if (!inSweep) (w.__sweeps.push(performance.now()), (inSweep = true), queueMicrotask(() => (inSweep = false)));
      w.__hits++;
      return real(x, y);
    };
  });
  const a = core.agent(core.project('a'), 'a', 'never-created', false);
  await openWindow(app, {}, core);
  await app.locator(`.tab[data-tab="${a.id}"]`).click();
  await icon(app, 'right', 'Terminal').click();
  await icon(app, 'right', 'Browser').click();
  const bar = pane(app).getByLabel('Address');
  await bar.fill('http://127.0.0.1:5731/a');
  await bar.press('Enter');
  const onScreen = () => app.evaluate(() => (window as unknown as { __calls: Call[] }).__calls.filter((x) => x[0] === 'browser_show' || x[0] === 'browser_hide').at(-1)?.[0] === 'browser_show');
  await expect.poll(onScreen).toBe(true);
  const slot = (await pane(app).locator('.bslot').boundingBox())!;
  const held = async (open: string) => {
    await app.evaluate(open);
    await expect.poll(onScreen).toBe(false);
    await app.evaluate(`document.querySelector('[data-probe]').remove()`);
    await expect.poll(onScreen).toBe(true);
  };
  // No per-overlay call: a kind of element this code has never heard of counts, as does the top layer.
  await held(`document.body.insertAdjacentHTML('beforeend', '<div data-probe style="position:fixed;z-index:9999;left:${slot.x - 90}px;top:${slot.y + 40}px;width:100px;height:60px"></div>')`);
  await held(`document.body.insertAdjacentHTML('beforeend', '<dialog data-probe>x</dialog>'); document.querySelector('[data-probe]').showModal()`);
  await held(`document.body.insertAdjacentHTML('beforeend', '<div data-probe popover style="margin:0;position:fixed;inset:auto;left:${slot.x + 20}px;top:${slot.y + 20}px;width:80px;height:80px"></div>'); document.querySelector('[data-probe]').showPopover()`);
  // A live region is no toast: one that takes clicks hides the page like anything else. Hint labels take no clicks, but must be read.
  await held(`document.body.insertAdjacentHTML('beforeend', '<div data-probe role="status" style="position:fixed;z-index:9999;left:${slot.x + 20}px;top:${slot.y + 20}px;width:100px;height:100px"></div>')`);
  await held(`document.body.insertAdjacentHTML('beforeend', '<div data-probe class="hints-layer" role="status"><span class="hint" style="left:${slot.x + 20}px;top:${slot.y + 20}px;width:30px">ab</span></div>')`);
  // Sweeps are counted, so a detector that never ran cannot pass the cases where the page must stay.
  const hits = () => app.evaluate(() => (window as unknown as { __hits: number }).__hits);
  await app.evaluate(`document.body.insertAdjacentHTML('beforeend', '<i data-tick></i>')`);
  const swept = async (change: string) => {
    const from = await hits();
    await app.evaluate(change);
    await expect.poll(hits).toBeGreaterThan(from);
    return from;
  };
  const tick = `document.querySelector('[data-tick]').className = 't' + Math.random()`;
  // Painted but not over the pane, unable to take a click (a tooltip), or a toast passing over it: the page stays.
  const before = (await calls(app, 'browser_hide')).length;
  // Apart, so one probe on top of another cannot hide which of them the sweep reached.
  const over = (row: number) => `position:fixed;z-index:9999;left:${slot.x}px;top:${slot.y + row * 120}px;width:200px;height:100px`;
  await swept(`document.body.insertAdjacentHTML('beforeend', '<div data-probe style="position:fixed;z-index:9999;left:0;top:0;width:100px;height:60px"></div><div data-probe style="${over(3)};pointer-events:none"></div><div data-probe class="wtoast" style="${over(0)}"></div><div data-probe class="prefix-armed" style="${over(1)};right:auto;bottom:auto"></div><div data-probe class="toast" style="${over(2)};transform:none;padding:0;bottom:auto"></div>')`);
  await app.waitForTimeout(150); // past the throttle gap, so this sweep sees React's answer to the last one
  await swept(tick);
  expect((await calls(app, 'browser_hide')).length).toBe(before);
  expect(await onScreen()).toBe(true);
  await app.evaluate(`document.querySelectorAll('[data-probe]').forEach((e) => e.remove())`);
  // A stream of DOM changes beside the pane is spaced out, whatever the frame rate.
  await app.waitForTimeout(300);
  const sweeps = () => app.evaluate(() => (window as unknown as { __sweeps: number[] }).__sweeps);
  const start = (await sweeps()).length;
  await app.evaluate(`new Promise((done) => { let n = 0; const t = document.querySelector('[data-tick]'), at = performance.now(); const i = setInterval(() => { t.className = 'c' + n++; if (performance.now() - at >= 1000) (clearInterval(i), done()); }, 4); })`);
  const during = (await sweeps()).slice(start);
  expect(during.length).toBeGreaterThan(3);
  expect(Math.min(...during.slice(1).map((at, i) => at - during[i]))).toBeGreaterThanOrEqual(90);
  // A modal away from the pane still hides it: a press on the native page could never reach the window to dismiss the palette.
  await app.getByRole('button', { name: 'Open command palette' }).click();
  await expect(app.locator('.palette')).toBeVisible();
  await expect.poll(onScreen).toBe(false);
  await app.mouse.click(slot.x + slot.width / 2, slot.y + 200);
  await expect(app.locator('.palette')).toHaveCount(0);
  await expect.poll(onScreen).toBe(true);
  // The real modal: it takes clicks over the pane, and closing brings the same page back without navigating it.
  await app.getByRole('navigation', { name: 'Left bar' }).getByRole('button', { name: 'Settings' }).click();
  await expect.poll(onScreen).toBe(false);
  await app.mouse.click(slot.x + slot.width / 2, slot.y + 200);
  await app.locator('.ovl').waitFor({ state: 'attached' });
  await app.keyboard.press('Escape');
  await expect(app.locator('.ovl')).toHaveCount(0);
  await expect.poll(onScreen).toBe(true);
  expect(await calls(app, 'browser_go')).toEqual([]);
  expect(await calls(app, 'browser_reload')).toEqual([]);
  // Leaving the tab still hides it, and nothing brings it back.
  await showPreview(app);
  await expect.poll(onScreen).toBe(false);
  // The tab comes back under an overlay already up: the page is never shown, not even for one frame.
  await app.evaluate(`document.body.insertAdjacentHTML('beforeend', '<div data-probe style="position:fixed;z-index:9999;left:${slot.x}px;top:${slot.y}px;width:${slot.width}px;height:${slot.height}px"></div>')`);
  const [shows, hides] = [(await calls(app, 'browser_show')).length, (await calls(app, 'browser_hide')).length];
  await icon(app, 'right', 'Browser').click();
  await expect.poll(async () => (await calls(app, 'browser_hide')).length).toBeGreaterThan(hides);
  expect((await calls(app, 'browser_show')).length).toBe(shows);
  await app.evaluate(`document.querySelector('[data-probe]').remove()`);
  await expect.poll(onScreen).toBe(true);
});

// vc-3 (look 1117) is gone with its guess: ticket 997 L7 reads who drives from the app's record of agent verbs (agent.rs
// `driven`, browser-widget-l7.spec.ts).
test('C12 agent_space_toolbar_reads_true_and_keeps_one_line', async ({ app, core }) => {
  await fakeApp(app);
  const a = core.agent(core.project('a'), 'a', 'never-created', false);
  await openWindow(app, {}, core);
  await app.locator(`.tab[data-tab="${a.id}"]`).click();
  await icon(app, 'right', 'Terminal').click();
  await icon(app, 'right', 'Browser').click();
  const p = pane(app);
  // (1) No page yet: the empty state says who opens one; no sign of a driver (ticket 997 L7: the agent's tab badge).
  await expect(p.getByText('No page yet. The agent opens pages here, or type an address to open one.')).toBeVisible();
  await expect(p.locator('[data-agent-badge]')).toHaveCount(0);
  await setNav(app, { url: 'https://en.wikipedia.org/wiki/Mac_(computer)' });
  // (2) One toolbar line at any pane width; Forget page is in ⋯.
  const oneLine = async () => {
    const tool = await p.locator('.btool').boundingBox();
    const field = await p.getByLabel('Address').boundingBox();
    expect(tool!.height).toBeLessThan(field!.height * 2);
  };
  for (const width of [1600, 1100, 800]) {
    await app.setViewportSize({ width, height: 800 });
    await oneLine();
  }
  await expect(await forgetItem(p)).toBeVisible();
  // (3) Annotate is a ghost icon button with its tooltip (ticket 997 L7).
  const annotate = p.getByRole('button', { name: 'Annotate' });
  if (await annotate.count()) await expect(annotate.locator('svg')).toHaveCount(1);
  // (5) The composer card stays out of the pane's column while that column is wide enough for its one line of chips. At
  // 1100 it is not: a squeezed card wraps, grows the composer and shrinks the terminal, which re-files a waiting prompt
  // (queue.spec.ts IME, answer-strip-modes), so there it spans under the pane (SidePane CARD_MIN).
  for (const width of [1600]) {
    await app.setViewportSize({ width, height: 800 });
    await expect.poll(async () => {
      const box = await app.locator('.composer:not([data-pinned]) .cbox').boundingBox();
      const side = await p.boundingBox();
      return box && side ? Math.round(box.x + box.width) <= Math.round(side.x) : null;
    }).toBe(true);
  }
});
