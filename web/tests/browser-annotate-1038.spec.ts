// Ticket 1038 (owner 11-21: "the browser has no annotate button"): Annotate shows on every My browser view, in the mockup's
// place (docs/design/browser-widget-1119.html: after the address, before Full size and ⋯), and its notes go to the session in
// front, else the window's last focused agent session. With no session it stays, inert, and says why. The app's bridge is
// faked as in browser-widget-l7.spec.ts; the picker itself is the app's (annotate.rs) and is checked in the RC.
import type { Page } from '@playwright/test';
import { expect, openWindow, test, type Core } from './fixtures';
import { icon, sidebar } from './d5b';

type Call = [string, Record<string, unknown>];
type Fake = { __calls: Call[]; __emit: (event: string, payload: unknown) => void };
const fakeApp = (page: Page) =>
  page.addInitScript(() => {
    const w = window as unknown as Fake & { __TAURI_INTERNALS__: unknown };
    const cbs = new Map<number, (e: unknown) => void>();
    const subs: [string, number][] = [];
    let next = 1;
    w.__calls = [];
    w.__emit = (event, payload) => subs.filter(([e]) => e === event).forEach(([, h]) => cbs.get(h)?.({ event, id: 1, payload }));
    w.__TAURI_INTERNALS__ = {
      transformCallback: (cb: (e: unknown) => void) => (cbs.set(next, cb), next++),
      invoke: (cmd: string, args: Record<string, unknown>) => {
        if (cmd === 'browser_nav') return Promise.resolve({ url: 'http://127.0.0.1:5731/billing', title: 'Billing', back: false, forward: false, loading: false, progress: 1 });
        w.__calls.push([cmd, args]);
        if (cmd === 'plugin:event|listen') subs.push([args.event as string, args.handler as number]);
        return Promise.resolve(null);
      },
      metadata: {},
    };
  });
const calls = (page: Page, cmd: string) => page.evaluate((c) => (window as unknown as Fake).__calls.filter((x) => x[0] === c).map((x) => x[1]), cmd);
const pick = (page: Page, space: string) =>
  page.evaluate(
    (space) =>
      (window as unknown as Fake).__emit('browser-picked', {
        space,
        element: { page: { sanitizedUrl: 'http://127.0.0.1:5731/billing' }, target: { selector: 'button.pay', tagName: 'button', rectViewport: { x: 1, y: 2, width: 3, height: 4 } }, nearbyText: ['Pay now'] },
      }),
    space,
  );
const centre = (app: Page) => app.locator('.centre .pane');
const pane = (app: Page) => app.locator('[data-side-pane]:not([hidden])');

/** The toolbar's buttons left to right, by name: Annotate sits after the address, before Full size and ⋯ (the mockup's order). */
async function order(tool: ReturnType<Page['locator']>) {
  await expect(tool.getByRole('button', { name: 'Annotate', exact: true })).toBeVisible();
  const names = await tool.locator(':scope > button, :scope > span > button').evaluateAll((bs) => bs.map((b) => b.getAttribute('aria-label')));
  const addr = (await tool.locator('.baddr').boundingBox())!;
  const ann = (await tool.getByRole('button', { name: 'Annotate', exact: true }).boundingBox())!;
  expect(ann.x).toBeGreaterThan(addr.x + addr.width);
  expect(names.indexOf('Annotate')).toBe(names.indexOf('More actions') - (names.includes('Take over and open full size') ? 2 : 1));
}

async function withAgent(app: Page, core: Core) {
  await fakeApp(app);
  const a = core.agent(core.project('a'), 'fix-login', 'never-created', false);
  await openWindow(app, {}, core);
  await app.locator(`.tab[data-tab="${a.id}"]`).click();
  return a;
}

test('1038_centre_my_browser_annotates_into_the_last_session', async ({ app, core }) => {
  const a = await withAgent(app, core);
  await app.keyboard.press('Shift+Meta+KeyB'); // My browser as a centre tab
  const tool = centre(app).locator('.btool');
  await order(tool);
  const ann = tool.getByRole('button', { name: 'Annotate', exact: true });
  await expect(ann).toHaveAttribute('data-tip', 'Annotate: click an element to add a note');
  // Keyboard: it is a button in the tab order, Enter turns picking on. It is inert until the page is open (the picker
  // needs one), so the press waits for that; a click waits by itself.
  await expect(ann).toBeEnabled();
  await ann.focus();
  await app.keyboard.press('Enter');
  await expect(ann).toHaveAttribute('aria-pressed', 'true');
  const on = (await calls(app, 'browser_annotate')).at(-1)!;
  expect(on.on).toBe(true);
  // The notes bar names where the notes land; a picked element becomes a note; Add to composer opens that session.
  const notes = centre(app).getByRole('region', { name: 'Annotations' });
  await expect(notes).toContainText('To fix-login');
  await pick(app, on.space as string);
  await notes.getByRole('textbox', { name: 'Note 1' }).fill('make this green');
  await notes.getByRole('button', { name: 'Add to composer' }).click();
  await expect(app.locator(`.tab[data-tab="${a.id}"]`)).toHaveAttribute('aria-selected', 'true');
  await expect(app.locator('#composer')).toHaveValue(/button\.pay[\s\S]*make this green/);
  await expect(app.locator('#composer')).toHaveValue(/^> /);
});

test('1038_side_pane_my_browser_and_own_space_annotate', async ({ app, core }) => {
  await withAgent(app, core);
  await icon(app, 'right', 'Terminal').click();
  await icon(app, 'right', 'Browser').click();
  const p = pane(app);
  await order(p.locator('.btool')); // the session's own space, as before
  await p.getByLabel('Browser space').selectOption('you');
  await expect(p.getByLabel('Browser space')).toHaveValue('you');
  await order(p.locator('.btool'));
  await p.locator('.btool').getByRole('button', { name: 'Annotate', exact: true }).click();
  await expect(p.getByRole('region', { name: 'Annotations' })).toContainText('To fix-login');
});

test('1038_no_session_annotate_is_inert_and_says_why', async ({ app, core }) => {
  await fakeApp(app);
  core.shell(core.project('alpha'), 'build'); // a shell takes no notes and has no side pane
  await openWindow(app, {}, core);
  // The 250 px widget: under about 260 px Annotate is in ⋯ (the mockup's narrow rule), greyed, saying why.
  await icon(app, 'right', 'Browser').click();
  const side = sidebar(app, 'right');
  await expect(side.locator('.btool').getByRole('button', { name: 'Annotate', exact: true })).toBeHidden();
  await side.locator('.btool').getByRole('button', { name: 'More actions' }).click();
  const item = side.getByRole('menuitemcheckbox', { name: /^Annotate/ });
  await expect(item).toBeDisabled();
  await expect(item).toContainText('Open a session to send notes');
  await app.keyboard.press('Escape');
  // The centre tab is wide: the icon is in its place, inert, and its tooltip says why.
  await app.keyboard.press('Shift+Meta+KeyB');
  const tool = centre(app).locator('.btool');
  await order(tool);
  const ann = tool.getByRole('button', { name: 'Annotate', exact: true });
  await expect(ann).toHaveAttribute('aria-disabled', 'true');
  await expect(ann).toHaveAttribute('data-tip', 'Open a session to send notes');
  await ann.click({ force: true }); // Playwright waits on aria-disabled; a person can still click it
  await ann.press('Enter');
  await expect(ann).toHaveAttribute('aria-pressed', 'false');
  expect(await calls(app, 'browser_annotate')).toHaveLength(0);
});
