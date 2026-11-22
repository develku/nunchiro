// Ticket 328 (looks check 2026-11-14): the My browser address field showed its placeholder cut to "Search or typ" in the
// side pane. Each language's placeholder must fit the field whole at the pane's default width.
// Ticket 991 C12 keeps the toolbar on one line (no wrap to give the field its own row), so the hint is shorter: "Search or URL".
// Ticket 997 L7's icon toolbar left 82 px at the 250 px default (fr needs 112): at 280 px or less Forward moves into More.
import type { Page } from '@playwright/test';
import { expect, openWindow, test } from './fixtures';
import { icon, sidebar } from './d5b';
import * as areas from '../src/i18n/areas/browser-pane';

const HINTS = (['en', 'ko', 'ja', 'zhHans', 'zhHant', 'es', 'fr', 'pt'] as const).map((l) => [l, areas[l]['browserPane.addressHint']] as const);

/** Each hint's drawn width against the field's room (its width less its padding). */
async function misfits(app: Page, hints: readonly (readonly [string, string])[]) {
  const bar = sidebar(app, 'right').getByLabel('Address');
  const [room, font] = await bar.evaluate((el) => {
    const s = getComputedStyle(el);
    return [el.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight), s.font] as const;
  });
  const out: string[] = [];
  for (const [lang, text] of hints) {
    const width = await app.evaluate(([f, s]) => {
      const c = document.createElement('canvas').getContext('2d')!;
      c.font = f;
      return c.measureText(s).width;
    }, [font, text] as const);
    if (width > room) out.push(`${lang} "${text}" needs ${width}px, the field has ${room}px`);
  }
  return out;
}

test('browser_address_placeholder_fits', async ({ app, core }) => {
  await openWindow(app, {}, core);
  await icon(app, 'right', 'Browser').click();
  const side = sidebar(app, 'right');
  await expect(side.getByLabel('Address')).toBeVisible();
  expect(Math.round((await side.boundingBox())!.width)).toBe(250);
  expect(await misfits(app, HINTS)).toEqual([]);
  // At 250 px Forward is in More, not in the toolbar; Back stays.
  const tool = side.locator('.btool');
  await expect(tool.getByRole('button', { name: 'Back', exact: true })).toBeVisible();
  await expect(tool.getByRole('button', { name: 'Forward', exact: true })).toBeHidden();
  await tool.getByRole('button', { name: 'More actions' }).click();
  await expect(side.getByRole('menuitem', { name: 'Forward' })).toBeVisible();
  await app.keyboard.press('Escape');

  // At 400 px Forward is back in the toolbar and gone from More; en and fr still fit.
  const edge = app.getByRole('separator', { name: 'Resize the right sidebar' });
  const e = (await edge.boundingBox())!;
  await app.mouse.move(e.x + e.width / 2, e.y + e.height / 2);
  await app.mouse.down();
  await app.mouse.move(e.x + e.width / 2 - 150, e.y + e.height / 2, { steps: 8 });
  await app.mouse.up();
  expect(Math.round((await side.boundingBox())!.width)).toBe(400);
  expect(await misfits(app, HINTS.filter(([l]) => l === 'en' || l === 'fr'))).toEqual([]);
  await expect(tool.getByRole('button', { name: 'Forward', exact: true })).toBeVisible();
  await tool.getByRole('button', { name: 'More actions' }).click();
  await expect(side.getByRole('menuitem', { name: 'Forward' })).toBeHidden();
});
