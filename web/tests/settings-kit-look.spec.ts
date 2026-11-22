// q67 look Q6-11: the same control looks the same on every Settings page. Chromium and WebKit.
import type { Locator, Page } from '@playwright/test';
import { expect, openWindow, test } from './fixtures';

const page = async (app: Page, name: string) => app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name, exact: true }).click();
const look = (l: Locator, props: string[]) => l.evaluate((e, props) => Object.fromEntries(props.map((p) => [p, getComputedStyle(e).getPropertyValue(p)])), props);

test('settings_kit_one_look: the icon button, the segmented control and the number boxes are the kit\'s on every page', async ({ app, core }) => {
  core.shell(core.project('demo'), 'one');
  await openWindow(app);
  await app.keyboard.press('Meta+Comma');
  // The icon-only button: Keyboard's pencil and Notifications' sound preview are both a bare square.
  const BOX = ['border-top-width', 'background-color', 'color'];
  await page(app, 'Keyboard');
  const pencil = await look(app.locator('tr[data-command] button.kedit').first(), BOX);
  await page(app, 'Notifications');
  const play = app.getByRole('button', { name: 'Preview the done sound' });
  expect(await look(play, BOX)).toEqual(pencil);
  expect(pencil['border-top-width']).toBe('0px');
  const size = await play.boundingBox();
  expect(size!.width).toBe(size!.height);
  // The segmented control: Usage's range is the kit's, as Notifications' level.
  const SEG = ['border-top-color', 'border-top-left-radius', 'font-size', 'font-family', 'height'];
  const ON = ['background-color', 'color', 'padding-left', 'min-height'];
  const seg = async () => {
    const s = app.locator('.settings .sseg').first();
    return [await look(s, SEG), await look(s.locator('label:has(input:checked)'), ON)];
  };
  const level = await seg();
  await page(app, 'Usage');
  expect(await seg()).toEqual(level);
  // Number boxes: Browser Access' port and Notifications' volume read in the font and size of Appearance's steppers.
  const FONT = ['font-family', 'font-size'];
  await page(app, 'Appearance');
  const stepper = await look(app.locator('.settings .sstep input').first(), FONT);
  await page(app, 'Notifications');
  expect(await look(app.locator('.settings .range .valb'), FONT)).toEqual(stepper);
  await page(app, 'Browser access');
  expect(await look(app.getByRole('textbox', { name: 'Port' }), FONT)).toEqual(stepper);
});
