// Ticket 1093, the owner's three lines: a window button toggles icon-bar auto-hide; the tab he is looking at drags to an edge
// and splits (the next tab shows beside it); with a Preview beside the chat in any host the composer stays under the chat.
// Chromium through Playwright, pointer events; not the app's WKWebView. Shots in .scratch/shots/1093-*.png.
import type { Page } from '@playwright/test';
import { expect, openWindow, test, type Core } from './fixtures';
import { append, openChat, rec, test as chatTest } from './fixtures/chat/harness';
import { bar, drag, stored } from './d5b';
import { showPreview } from './agent-pane';
import { room } from '../src/pane/composerRoom';

const shot = (p: Page, name: string) => p.screenshot({ path: `../.scratch/shots/1093-${name}.png` });
const agent = (core: Core, label: string) => core.agent(core.project('agents'), label, 'never-created').id;
const tab = (p: Page, id: string) => p.locator(`.tab[data-tab="${id}"]`);
const tabIds = (p: Page) => p.locator('.tab[data-tab]').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.tab));
const overlay = (p: Page) => p.locator('[data-split-overlay]');
const shown = (p: Page) =>
  p.evaluate(() => Object.fromEntries(Object.entries(JSON.parse(localStorage.getItem('nunchiro.splits.v1') ?? '{}') as Record<string, { side: string; what: string }[]>).map(([k, l]) => [k, l.map((s) => [s.side, s.what])])));
async function rightEdge(p: Page) {
  const b = (await p.locator('[data-split-host]').boundingBox())!;
  return { x: b.x + b.width - 30, y: b.y + b.height / 2 };
}

test('autohide_button: the left bar\'s foot has a toggle above Settings; one press hides the bars, another keeps them shown', async ({ app }) => {
  await openWindow(app);
  const btn = bar(app, 'left').getByRole('button', { name: 'Auto-hide icon bars' });
  await expect(btn).toHaveAttribute('aria-pressed', 'false');
  await expect(btn).toHaveAttribute('data-tip', 'Auto-hide icon bars');
  await expect(bar(app, 'right').getByRole('button', { name: 'Auto-hide icon bars' })).toHaveCount(0);
  const b = (await btn.boundingBox())!;
  const gear = (await bar(app, 'left').locator('.ai.gear').boundingBox())!;
  expect(b.y + b.height).toBeLessThanOrEqual(gear.y); // right above Settings
  expect(gear.y - (b.y + b.height)).toBeLessThan(12);
  await shot(app, 'autohide-off');

  await btn.click();
  await expect.poll(async () => (await stored(app)).bars.barsAuto).toBe(true); // the Settings switch's own setting
  await expect(btn).toHaveAttribute('aria-pressed', 'true');
  await app.mouse.move(700, 400);
  await expect(bar(app, 'left')).not.toBeInViewport();
  await expect(bar(app, 'right')).not.toBeInViewport();
  await shot(app, 'autohide-on');
  await app.mouse.move(2, 400); // the window edge brings the bar, and the button in it
  await expect(bar(app, 'left')).toBeInViewport({ ratio: 1 });
  await shot(app, 'autohide-on-edge');

  await btn.click();
  await expect.poll(async () => (await stored(app)).bars.barsAuto).toBeUndefined();
  await expect(btn).toHaveAttribute('aria-pressed', 'false');
  await app.mouse.move(700, 400);
  await expect(bar(app, 'left')).toBeInViewport({ ratio: 1 });
  await expect(bar(app, 'right')).toBeInViewport({ ratio: 1 });
});

test('shown_tab_splits: the tab shown drags to the right edge, the next tab shows on the left; closing the split brings it back', async ({ app, core }) => {
  const [a, b, c] = [agent(core, 'a'), agent(core, 'b'), agent(core, 'c')];
  await openWindow(app, {}, core);
  await tab(app, a).click();
  await expect(tab(app, a)).toHaveAttribute('aria-selected', 'true');
  await drag(app, tab(app, a), await rightEdge(app), { release: false });
  await expect(overlay(app).locator('.half')).toHaveAttribute('data-side', 'right');
  await app.mouse.up();
  await expect.poll(() => shown(app)).toEqual({ [b]: [['right', `session:${a}`]] });
  await expect(tab(app, b)).toHaveAttribute('aria-selected', 'true');
  await expect.poll(() => tabIds(app)).toEqual([b, c]);
  await expect(app.locator('[data-split-id][data-side="right"]')).toBeVisible();
  await shot(app, 'shown-tab-split');
  // Review r1: the composer ends at its chat column beside a session split and never crosses it.
  const split = (await app.locator('[data-split-id]').boundingBox())!;
  const col = (await app.locator('.sview').boundingBox())!;
  const cardRight = async () => { const c = (await app.locator('.composer:not([data-pinned]) .cbox').boundingBox())!; return c.x + c.width; };
  await expect.poll(cardRight).toBeLessThanOrEqual(split.x);
  expect(await cardRight()).toBeLessThanOrEqual(col.x + col.width + 1);
  await shot(app, 'shown-tab-split-composer');
  await app.locator('[data-split-id]').getByRole('button', { name: 'Close split' }).click();
  await expect.poll(() => tabIds(app)).toEqual([b, c, a]);
});

test('lone_tab_refused: with one tab the drag says a split needs a second tab and changes nothing', async ({ app, core }) => {
  const b = agent(core, 'b');
  await openWindow(app, {}, core);
  await tab(app, b).click();
  await drag(app, tab(app, b), await rightEdge(app), { release: false });
  await expect(overlay(app)).toHaveAttribute('data-refused', '');
  await expect(overlay(app).getByRole('status')).toHaveText('A split needs a second tab');
  await expect(overlay(app).locator('.half')).toHaveCount(0);
  await shot(app, 'lone-tab-refused');
  await app.mouse.up();
  await expect(app.locator('[data-split-id]')).toHaveCount(0);
  await expect.poll(() => tabIds(app)).toEqual([b]);
});

test('composer_room_rule: a host whose edge falls inside the composer takes the rest on that side; a full-width one takes none', () => {
  const c = { left: 500, right: 1200 };
  expect(room(c, [])).toEqual({ left: 0, right: 0 });
  expect(room(c, [{ left: 950, right: 1390 }])).toEqual({ left: 0, right: 250 });
  expect(room(c, [{ left: 300, right: 700 }])).toEqual({ left: 200, right: 0 });
  expect(room(c, [{ left: 300, right: 1390 }])).toEqual({ left: 0, right: 0 }); // a split below the chat
  expect(room(c, [{ left: 1200, right: 1390 }])).toEqual({ left: 0, right: 0 }); // already clear
  expect(room(c, [{ left: 950, right: 1390 }, { left: 850, right: 1390 }])).toEqual({ left: 0, right: 350 });
  expect(room(c, [{ left: 905, right: 1183 }])).toEqual({ left: 0, right: 295 }); // a right pane ending inside the composer is not a left host
  expect(room(c, [{ left: 300, right: 400 }])).toEqual({ left: 0, right: 0 }); // clear on the left
});

const card = (p: Page) => p.locator('.composer:not([data-pinned]) .cbox');
const SPLIT = 'nunchiro.splits.v1';
for (const where of ['side pane', 'right split', 'left split', 'zone'] as const) {
  chatTest(`composer_beside_preview (${where}): the message box stays under the chat, never across the Preview`, async ({ page, chatCore }) => {
    const s = chatCore.chat('col', true, true, 'p');
    append(s.file, rec.user('go'), rec.assistant('ok'));
    if (where.endsWith('split')) {
      await page.goto('/');
      await page.evaluate(([k, id, side]) => localStorage.setItem(k, JSON.stringify({ [id]: [{ id: 'sp1', side, what: 'preview' }] })), [SPLIT, s.id, where.split(' ')[0]]);
    }
    await openChat(page, s.id);
    if (where === 'side pane') await showPreview(page);
    if (where === 'zone') chatCore.cli('layout', 'split', 'right', 'preview');
    const pv = page.locator(where === 'side pane' ? '[data-side-pane] .preview' : where === 'zone' ? '[data-zone-id] .preview' : '[data-split-id="sp1"] .preview');
    await expect(pv).toBeVisible();
    const p = async () => (await pv.boundingBox())!;
    const c = async () => (await card(page).boundingBox())!;
    if (where === 'left split') await expect.poll(async () => (await c()).x).toBeGreaterThanOrEqual((await p()).x + (await p()).width);
    else await expect.poll(async () => (await c()).x + (await c()).width).toBeLessThanOrEqual((await p()).x);
    const chat = (await page.locator('.chat:not([data-off])').first().boundingBox())!;
    expect((await c()).width).toBeGreaterThan(200); // still a usable box under the chat
    expect((await c()).x).toBeGreaterThanOrEqual(chat.x - 1);
    expect((await c()).x + (await c()).width).toBeLessThanOrEqual(chat.x + chat.width + 1);
    await shot(page, `composer-${where.replace(' ', '-')}`);
  });
}
