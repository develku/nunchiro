// Shared helpers of the LAYOUT D5b specs (layout-d5b-a*.spec.ts).
import { expect, type Locator, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { REPO, type Core } from './fixtures';

export const bar = (page: Page, side: 'left' | 'right') => page.getByRole('navigation', { name: side === 'left' ? 'Left bar' : 'Right bar' });
/** The accessible names of a bar's icons in slot order, empty slots left out (Settings and Layout are icons like the rest). */
export const names = (page: Page, side: 'left' | 'right') => page.$$eval(`nav[data-bar="${side}"] button.ai`, (els) => els.map((e) => (e.getAttribute('aria-label') ?? '').replace('Editing layout · Done', 'Layout'))); // Layout reads "Editing layout · Done" in edit mode
/** An icon by its widget's name. Ticket 1041: the bars draw no label; the name is the accessible name, alone, with a count
 *  after " · " (Board, Team), or folded. */
export const icon = (page: Page, side: 'left' | 'right', name: string) =>
  bar(page, side).locator(`button.ai:is([aria-label="${name}"], [aria-label^="${name} · "], [aria-label="${name} (folded)"])`);
export const slot = (page: Page, side: 'left' | 'right', index: number) => bar(page, side).locator(`[data-slot="${index}"]`);
export const sidebar = (page: Page, side: 'left' | 'right') => page.locator(`aside.sbar[data-side="${side}"]`);
export const layoutButton = (page: Page) => page.locator('nav[data-bar="right"] .lay');
export const editBar = (page: Page) => page.getByRole('toolbar', { name: 'Layout edit' });
export const lib = (page: Page) => page.getByRole('complementary', { name: 'Widget library' });
export const card = (page: Page, kind: string) => page.locator(`.lib .lcard[data-card="${kind}"]`);
export const toast = (page: Page) => page.locator('.toast');
export const zones = (page: Page) => page.$$eval('[data-zone-id]', (els) => els.map((e) => (e as HTMLElement).dataset.zoneId));
export const zone = (page: Page, id: string) => page.locator(`[data-zone-id="${id}"]`);
export const startEdit = async (page: Page) => {
  await layoutButton(page).click();
  await editBar(page).waitFor();
  // The cards move down when the widget list arrives (its note above them); a drag aimed before then grabs the card above.
  await expect(lib(page)).not.toHaveAttribute('aria-busy', 'true');
};
export const endEdit = (page: Page) => editBar(page).getByRole('button', { name: 'Done', exact: true }).click();
export const stored = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('nunchiro.settings.v1') ?? '{}'));
export const layoutFile = (core: Core) => path.join(core.home, 'layout.toml');
export const readLayout = (core: Core) => (fs.existsSync(layoutFile(core)) ? fs.readFileSync(layoutFile(core), 'utf8') : '');

/** Presses on `from`, moves past the drag threshold, then to `to` (a point or a locator's centre), optionally releasing. */
export async function drag(page: Page, from: Locator, to: Locator | { x: number; y: number }, opts: { release?: boolean; dy?: number } = {}) {
  const b = (await from.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2 + 6, b.y + b.height / 2 + 6, { steps: 2 });
  const t = 'x' in to ? to : await centre(to, opts.dy ?? 0);
  await page.mouse.move(t.x, t.y, { steps: 8 });
  if (opts.release !== false) await page.mouse.up();
  return t;
}
export async function centre(l: Locator, dy = 0) {
  const b = (await l.boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 + dy };
}
/** A point in a zone: fx, fy are fractions of its box. */
export async function at(page: Page, id: string, fx: number, fy: number) {
  const b = (await zone(page, id).boundingBox())!;
  return { x: b.x + b.width * fx, y: b.y + b.height * fy };
}
/** The centre of the first empty slot of a bar (where an icon dropped "at the end" lands). */
export async function barEnd(page: Page, side: 'left' | 'right') {
  const b = (await bar(page, side).locator('.slot.empty').first().boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}
/** The centre of slot `index` of a bar (an occupied slot swaps with the dropped icon). */
export async function barBefore(page: Page, side: 'left' | 'right', index: number) {
  const b = (await slot(page, side, index).boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}
export const pageErrors = (page: Page) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  return errors;
};
/** Two script widgets that are not approved (their folders only; the core lists them as not allowed). */
export function unapproved(core: Core, ...list: string[]) {
  for (const name of list) {
    const dir = path.join(core.home, 'widgets', name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'widget.toml'), 'version = 1\nkind = "script"\nauthor = "test"\ncommand = ["/bin/sh", "run.sh"]\ninterval = 60\npermissions = ["read"]\n');
    fs.writeFileSync(path.join(dir, 'run.sh'), 'echo hi\n');
  }
}


export { REPO };

/** needs 153: the window has no ':' command line; `nunchiro layout` takes the same words. The CLI refuses while the
 *  window is editing, so an open Layout is finished (Done) first and opened again after. */
export async function layoutCli(page: Page, core: Core, line: string) {
  const strip = page.getByRole('toolbar', { name: 'Layout edit' });
  const editing = (await strip.count()) > 0;
  if (editing) await strip.getByRole('button', { name: 'Done', exact: true }).click();
  if (editing) await strip.waitFor({ state: 'detached' });
  core.cli('layout', ...line.split(' '));
  if (editing) {
    await page.locator('nav.ib .lay').click();
    await strip.waitFor();
  }
}
