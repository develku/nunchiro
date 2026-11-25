// Ticket 1044: clipboard image names, the "!" shell cue, and /new in the slash menu.
import type { Page } from '@playwright/test';
import { expect, openWindow, test } from './fixtures';
import { give, helpers, type Spec } from './fixtures/images/helpers';

const PNG = (seed: number, name: string): Spec => ({ png: [40, 30, seed, name] });
const chips = (page: Page) => page.locator('.cbox .ichip');
const cbox = (page: Page) => page.locator('.cbox:visible').first();
const area = (page: Page) => cbox(page).locator('textarea:not(.hoff-edit)');

async function start(app: Page, core: { agent: (p: string, l: string, n: string) => { id: string }; project: (n: string) => string }) {
  await app.addInitScript(helpers);
  const a = core.agent(core.project('a'), 'x', 'alpha');
  await openWindow(app, {}, core as never);
  await app.locator(`.tab[data-tab="${a.id}"]`).click();
  await expect(area(app)).toBeEditable();
  await area(app).focus();
}

test('pasted clipboard images read Image #N; a real name stays', async ({ app, core }) => {
  await start(app, core as never);
  await give(app, [PNG(1, 'image.png'), PNG(2, 'image.png')]);
  await expect(chips(app)).toHaveCount(2);
  await expect(chips(app).nth(0)).toContainText('Image #1');
  await expect(chips(app).nth(1)).toContainText('Image #2');
  await app.getByRole('button', { name: 'Remove image Image #1' }).click();
  await expect(chips(app)).toHaveCount(1);
  await expect(chips(app).first()).toContainText('Image #1');
  await give(app, [PNG(3, 'photo.png')], 'drop');
  await expect(chips(app).nth(1)).toContainText('photo.png');
});

test('a leading ! marks the box; deleting it or sending clears it', async ({ app, core }) => {
  await start(app, core as never);
  await area(app).pressSequentially('!ls');
  await expect(cbox(app)).toHaveAttribute('data-shell', '');
  await area(app).press('ControlOrMeta+a');
  await area(app).press('Backspace');
  await expect(cbox(app)).not.toHaveAttribute('data-shell', '');
  await area(app).pressSequentially('!ls');
  await expect(cbox(app)).toHaveAttribute('data-shell', '');
  await area(app).press('Enter');
  await expect(area(app)).toHaveValue('');
  await expect(cbox(app)).not.toHaveAttribute('data-shell', '');
});

test('/n offers /new in a Claude session', async ({ app, core }) => {
  await start(app, core as never);
  await area(app).pressSequentially('/n');
  await expect(app.getByRole('listbox', { name: 'Commands and skills' }).getByRole('option', { name: /^\/new/ })).toBeVisible();
});
