// Ticket 1069: a tab dragged to an edge of the session view becomes a split there; onto a split it replaces what the split
// shows (that session returns to the strip); the menu and the palette do the same; closing such a split returns the tab.
// Chromium through Playwright, pointer events (the mechanism of the bar icon drag); not the app's WKWebView.
import type { Page } from '@playwright/test';
import { expect, openWindow, test, type Core } from './fixtures';
import { drag } from './d5b';

type Side = 'left' | 'right' | 'up' | 'down';
const agent = (core: Core, label: string) => core.agent(core.project('agents'), label, 'never-created').id;
const tab = (p: Page, id: string) => p.locator(`.tab[data-tab="${id}"]`);
const tabIds = (p: Page) => p.locator('.tab[data-tab]').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.tab));
const host = (p: Page) => p.locator('[data-split-host]');
const splits = (p: Page) => p.locator('[data-split-id]');
const overlay = (p: Page) => p.locator('[data-split-overlay]');
const menu = (p: Page) => p.getByRole('menu', { name: 'Actions' });
/** What the window's splits show, per host session: [side, what]. */
const shown = (p: Page) =>
  p.evaluate(() => Object.fromEntries(Object.entries(JSON.parse(localStorage.getItem('nunchiro.splits.v1') ?? '{}') as Record<string, { side: string; what: string }[]>).map(([k, l]) => [k, l.map((s) => [s.side, s.what])])));
const open = async (p: Page, id: string) => {
  await tab(p, id).click();
  await expect(tab(p, id)).toHaveAttribute('aria-selected', 'true');
};
async function near(p: Page, side: Side) {
  const b = (await host(p).boundingBox())!;
  const x = side === 'left' ? b.x + 30 : side === 'right' ? b.x + b.width - 30 : b.x + b.width / 2;
  const y = side === 'up' ? b.y + 30 : side === 'down' ? b.y + b.height - 30 : b.y + b.height / 2;
  return { x, y };
}
const closeSplit = (p: Page) => splits(p).getByRole('button', { name: 'Close split' }).click();

test('tab_drag_edges: a tab dropped on each edge is a split there, leaves the strip, and comes back when the split closes', async ({ app, core }) => {
  const [a, b] = [agent(core, 'a'), agent(core, 'b')];
  await openWindow(app, {}, core);
  await open(app, a);
  for (const side of ['right', 'left', 'up', 'down'] as const) {
    await drag(app, tab(app, b), await near(app, side), { release: false });
    await expect(overlay(app).locator('.half')).toHaveAttribute('data-side', side);
    await app.mouse.up();
    await expect(overlay(app)).toHaveCount(0);
    await expect(splits(app)).toHaveAttribute('data-side', side);
    expect(await shown(app)).toEqual({ [a]: [[side, `session:${b}`]] });
    await expect(tab(app, b)).toHaveCount(0);
    await expect(tab(app, a)).toHaveAttribute('aria-selected', 'true');
    await closeSplit(app);
    await expect(splits(app)).toHaveCount(0);
    await expect.poll(() => tabIds(app)).toEqual([a, b]);
  }
});

test('tab_drag_replace: a tab dropped on a split replaces it; the session it showed returns to the strip', async ({ app, core }) => {
  const [a, b, c] = [agent(core, 'a'), agent(core, 'b'), agent(core, 'c')];
  await openWindow(app, {}, core);
  await open(app, a);
  await drag(app, tab(app, b), await near(app, 'right'));
  await expect(tab(app, b)).toHaveCount(0);
  await drag(app, tab(app, c), splits(app), { release: false });
  await expect(overlay(app).locator('.half')).toHaveAttribute('data-side', 'replace');
  await expect(overlay(app).locator('.half')).toHaveText('Show here instead');
  await app.mouse.up();
  expect(await shown(app)).toEqual({ [a]: [['right', `session:${c}`]] });
  await expect.poll(() => tabIds(app)).toEqual([a, b]);
  await closeSplit(app);
  await expect.poll(() => tabIds(app)).toEqual([a, b, c]);
});

test('tab_drag_host_closed: a shell tab moved into a split keeps running and gets its tab back when the host session closes', async ({ app, core }) => {
  const a = agent(core, 'a');
  const b = core.shell(core.project('agents'), 'b').id;
  await openWindow(app, {}, core);
  await open(app, a);
  await drag(app, tab(app, b), await near(app, 'right'));
  await expect(tab(app, b)).toHaveCount(0);
  core.cli('session', 'close', a);
  await expect.poll(() => shown(app)).toEqual({});
  await expect(tab(app, b)).toHaveCount(1);
  const state = (core.cli('snapshot', '--json').sessions as { id: string; state: string }[]).find((s) => s.id === b)?.state;
  expect(state).toBe('running');
});

test('tab_drag_refused_and_cancelled: a file tab says why it cannot split, the active tab splits beside the next tab, Escape changes nothing; a drop on a tab still reorders', async ({ app, core }) => {
  const [a, b] = [agent(core, 'a'), agent(core, 'b')];
  await openWindow(app, {}, core);
  await open(app, a);
  await app.evaluate((r) => window.dispatchEvent(new CustomEvent('nunchiro:files.open', { detail: { root: r, path: 'notes.txt' } })), a);
  const file = `file:${a}:notes.txt`;
  await expect(tab(app, file)).toHaveCount(1);
  await open(app, a);
  // Ticket 1093: a file tab shows no half, only why; the release changes nothing.
  await drag(app, tab(app, file), await near(app, 'right'), { release: false });
  await expect(overlay(app)).toHaveAttribute('data-refused', '');
  await expect(overlay(app).getByRole('status')).toHaveText('This tab cannot go to a split yet');
  await expect(overlay(app).locator('.half')).toHaveCount(0);
  await app.mouse.up();
  await expect(overlay(app)).toHaveCount(0);
  await expect(splits(app)).toHaveCount(0);
  expect(await tabIds(app)).toEqual([a, b, file]);
  // Ticket 1093: the active tab onto its own view goes into a split of the next session tab, which shows.
  await drag(app, tab(app, a), await near(app, 'right'));
  await expect.poll(() => shown(app)).toEqual({ [b]: [['right', `session:${a}`]] });
  await expect(tab(app, b)).toHaveAttribute('aria-selected', 'true');
  await closeSplit(app);
  await expect.poll(() => tabIds(app)).toEqual([b, file, a]);
  await open(app, a);
  // Escape cancels a drag that showed its preview; the release after it does nothing.
  await drag(app, tab(app, b), await near(app, 'right'), { release: false });
  await expect(overlay(app)).toBeVisible();
  await app.keyboard.press('Escape');
  await expect(overlay(app)).toHaveCount(0);
  await app.mouse.up();
  await expect(splits(app)).toHaveCount(0);
  expect(await tabIds(app)).toEqual([b, file, a]);
  // Back on the strip a drop reorders, as before.
  await drag(app, tab(app, a), tab(app, file));
  await expect.poll(() => tabIds(app)).toEqual([b, a, file]);
  await expect(splits(app)).toHaveCount(0);
});

test('tab_split_commands: the tab menu moves its tab into a split of the shown view; the palette moves the tab shown before', async ({ app, core }) => {
  const [a, b] = [agent(core, 'a'), agent(core, 'b')];
  await openWindow(app, {}, core);
  await open(app, a);
  await tab(app, b).click({ button: 'right' });
  await menu(app).getByRole('menuitem', { name: 'Move tab to split right' }).click();
  expect(await shown(app)).toEqual({ [a]: [['right', `session:${b}`]] });
  await expect(tab(app, b)).toHaveCount(0);
  await expect(tab(app, a)).toHaveAttribute('aria-selected', 'true');
  await closeSplit(app);
  await expect.poll(() => tabIds(app)).toEqual([a, b]);
  // Palette: b was shown, then a; b goes below a.
  await open(app, b);
  await open(app, a);
  await app.keyboard.press('Meta+KeyK');
  await app.getByRole('dialog', { name: 'Command palette' }).getByRole('combobox').fill('Move tab to split below');
  await app.keyboard.press('Enter');
  await expect.poll(() => shown(app)).toEqual({ [a]: [['down', `session:${b}`]] });
  await expect(tab(app, b)).toHaveCount(0);
  await closeSplit(app);
  await expect.poll(() => tabIds(app)).toEqual([a, b]);
});
