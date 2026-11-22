// v25f (owner RC F3): the terminal font picker lists every installed family, searchable, monospace first, each row in its
// own face, with a hover preview in the sample that saves nothing. The app's list is mocked through window.__NUNCHIRO_FONTS_ALL__.
import type { Page } from '@playwright/test';
import { FONT } from '../src/settings';
import { expect, openWindow, test } from './fixtures';
import { openSettings } from './settings-modal';

const KEY = 'nunchiro.settings.v1';
const pad = (i: number) => String(i).padStart(2, '0');
// 10 monospace and 20 other families, interleaved so that "monospace first" is the picker's doing.
const FAMILIES = Array.from({ length: 30 }, (_, i) => (i % 3 === 0 ? { name: `Mono ${pad(i)}`, mono: true } : { name: `Sans ${pad(i)}`, mono: false }));

const stored = (app: Page) => app.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? '{}').termFont as string | undefined, KEY);
const picker = (app: Page) => app.getByRole('button', { name: /^Terminal font/ });
const listbox = (app: Page) => app.getByRole('listbox', { name: 'Terminal font' });
const options = (app: Page) => listbox(app).getByRole('option');
const search = (app: Page) => app.getByRole('combobox', { name: 'Search fonts' });
const row = (app: Page, name: string) => options(app).filter({ hasText: new RegExp(`^${name}`) });
const sample = (app: Page) => app.locator('.fsample .fs-term').evaluate((el) => (el as HTMLElement).style.fontFamily.replaceAll('"', ''));

async function page(app: Page) {
  await openSettings(app);
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Terminal', exact: true }).click();
  await expect(picker(app)).toBeVisible();
}
async function open(app: Page) {
  await app.addInitScript((f) => ((window as { __NUNCHIRO_FONTS_ALL__?: unknown }).__NUNCHIRO_FONTS_ALL__ = f), FAMILIES);
  await openWindow(app);
  await page(app);
}
async function show(app: Page) {
  await picker(app).click();
  await expect(search(app)).toBeFocused();
}

test('font-all: monospace group first, Custom… last, each row in its own face; search filters', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await open(app);
  await show(app);
  const groups = listbox(app).getByRole('group');
  await expect(groups.nth(0)).toHaveAccessibleName('Monospace');
  await expect(groups.nth(1)).toHaveAccessibleName('All fonts');
  await expect(groups.nth(0).getByRole('option')).toHaveCount(10);
  await expect(options(app)).toHaveCount(31);
  await expect(options(app).first()).toHaveText(/^Mono 00/);
  await expect(options(app).last()).toHaveText(/^Custom…/);
  expect(await row(app, 'Sans 01').evaluate((el) => getComputedStyle(el).fontFamily.replaceAll('"', ''))).toMatch(/^Sans 01,/);

  await search(app).fill('sAnS 0');
  await expect(options(app)).toHaveText([/^Sans 01/, /^Sans 02/, /^Sans 04/, /^Sans 05/, /^Sans 07/, /^Sans 08/]);
  await expect(groups).toHaveCount(1);
  await search(app).fill('no such family');
  await expect(options(app)).toHaveCount(0);
  await expect(app.getByText('No fonts match')).toBeVisible();
  await app.keyboard.press('Enter'); // nothing to take: the list stays open and nothing is saved
  await expect(search(app)).toBeFocused();
  await app.keyboard.press('Escape');
  await expect(listbox(app)).toHaveCount(0);
  await expect(picker(app)).toBeFocused();
});

test('font-all: a pick writes a termFont starting with the family and shows by name after a reload', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await open(app);
  await show(app);
  await search(app).fill('sans 07');
  await app.keyboard.press('Enter');
  await expect.poll(() => stored(app)).toMatch(/^"Sans 07", /);
  expect(FONT.test((await stored(app))!)).toBe(true);
  await app.reload();
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  await page(app);
  await expect(picker(app)).toContainText('Sans 07');
  await expect(app.getByRole('textbox', { name: 'Custom font list' })).toHaveCount(0);
  await show(app);
  await expect(row(app, 'Sans 07')).toHaveAttribute('aria-selected', 'true');
});

test('font-all: hover and arrow keys preview in the sample without saving; leaving or Escape restores it', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await open(app);
  const saved = await stored(app);
  const before = await sample(app);
  const place = () => app.locator('.fsample').boundingBox();
  const at = await place();
  await show(app);
  // The open list is not clipped by the settings card: its last pixel row is its own.
  const bottomIsList = await app.locator('.font-pop').evaluate((el) => {
    const box = el.getBoundingClientRect();
    return el.contains(document.elementFromPoint(box.left + box.width / 2, box.bottom - 2));
  });
  expect(bottomIsList).toBe(true);
  await row(app, 'Mono 03').hover();
  await expect.poll(() => sample(app)).toMatch(/^Mono 03,/);
  expect(await place()).toEqual(at); // the sample stays where it is, or the preview could not be seen
  expect(await stored(app)).toBe(saved);
  await app.mouse.move(0, 0);
  await expect.poll(() => sample(app)).toBe(before);
  await expect(listbox(app)).toBeVisible();
  await app.keyboard.press('ArrowDown');
  await expect.poll(() => sample(app)).not.toBe(before);
  expect(await stored(app)).toBe(saved);
  await app.keyboard.press('Escape');
  await expect.poll(() => sample(app)).toBe(before);
  expect(await stored(app)).toBe(saved);
});

test('font-all: a family file loads when its row shows, not up front', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await app.addInitScript(() => {
    const w = window as unknown as { __faces: string[] };
    w.__faces = [];
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args: Record<string, unknown>) => {
        if (cmd === 'font_faces') w.__faces.push(args.family as string);
        return new ArrayBuffer(0);
      },
    };
  });
  const faces = () => app.evaluate(() => (window as unknown as { __faces: string[] }).__faces.filter((f) => /^(Mono|Sans) \d/.test(f)));
  await open(app);
  expect(await faces()).toEqual([]);
  await show(app);
  // No mocked family matches the default list, so it reads as Custom… and the list opens at its end.
  await expect.poll(faces).toContain('Sans 29');
  const first = await faces();
  expect(first.length).toBeLessThan(30);
  expect(first).not.toContain('Mono 00');
  await row(app, 'Mono 00').scrollIntoViewIfNeeded();
  await expect.poll(faces).toContain('Mono 00');
});

test('font-all: the picker sits in the right-hand slot of its row; the open list stays inside the window and leaves the preview sample uncovered', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await open(app);
  const name = (await app.locator('#term-font-label').boundingBox())!;
  const btn = (await picker(app).boundingBox())!;
  expect(btn.x).toBeGreaterThan(name.x + name.width);
  await show(app);
  const pop = (await app.locator('.font-pop').boundingBox())!;
  const view = app.viewportSize()!;
  expect(pop.x).toBeGreaterThanOrEqual(0);
  expect(pop.y + pop.height).toBeLessThanOrEqual(view.height);
  expect(pop.x + pop.width).toBeLessThanOrEqual(btn.x + btn.width + 1); // opens leftwards from the button
  const sample = (await app.locator('.fsample').boundingBox())!;
  expect(pop.x + pop.width).toBeLessThanOrEqual(sample.x); // the sample is not under the list
});

test('font-all: at the minimum window a very long family name does not push the list out of the settings scroller', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await app.setViewportSize({ width: 900, height: 560 });
  const long = `Extra Long Family Name ${'Wide '.repeat(30)}Mono`;
  await app.addInitScript((f) => ((window as { __NUNCHIRO_FONTS_ALL__?: unknown }).__NUNCHIRO_FONTS_ALL__ = f), [{ name: long, mono: true }, ...FAMILIES]);
  await openWindow(app);
  await page(app);
  await show(app);
  const pop = (await app.locator('.font-pop').boundingBox())!;
  const body = (await app.locator('.sbody').boundingBox())!;
  expect(pop.x).toBeGreaterThanOrEqual(body.x);
  expect(pop.x + pop.width).toBeLessThanOrEqual(app.viewportSize()!.width);
  // The list's left edge is its own pixel, not the scroller's clip.
  const clipped = await app.locator('.font-pop').evaluate((el) => {
    const b = el.getBoundingClientRect();
    return !el.contains(document.elementFromPoint(b.left + 2, b.top + b.height / 2));
  });
  expect(clipped).toBe(false);
});

// Owner 11-17: the UI, chat and composer font pickers listed a few coding fonts only; they list every installed family too.
test('font-all: the UI font picker lists every installed family, not only coding fonts', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await app.addInitScript((f) => ((window as { __NUNCHIRO_FONTS_ALL__?: unknown }).__NUNCHIRO_FONTS_ALL__ = f), [...FAMILIES, { name: 'Pretendard', mono: false }]);
  await openWindow(app);
  await openSettings(app);
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Appearance', exact: true }).click();
  const ui = app.locator('[data-setting="type.ui"] select, [data-row="type.ui"] select').first();
  await expect(ui.locator('option', { hasText: 'Pretendard' })).toHaveCount(1);
  await ui.selectOption('Pretendard');
  await expect.poll(() => app.evaluate(() => getComputedStyle(document.body).fontFamily)).toContain('Pretendard');
});
