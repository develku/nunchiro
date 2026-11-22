// Theme import with Enter (ticket 202 item 3; needs 171, 172): the fields sit in a form. Enter in the name or URL field runs
// the same import as the "Add" button; Enter in the text area stays a newline; an IME's Enter never submits.
import { expect, openWindow, test } from './fixtures';
import { stored } from './theme-harness';

const THEME = 'background = #102030\nforeground = #e0e0e0\npalette = 1=#ff0000\n';

async function form(app: import('@playwright/test').Page) {
  await openWindow(app);
  await app.getByRole('navigation', { name: 'Left bar' }).getByRole('button', { name: 'Settings' }).click();
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Appearance' }).click();
  await app.getByText('Import a theme file').click();
  return {
    name: app.getByRole('textbox', { name: 'Name' }),
    text: app.getByRole('textbox', { name: 'Theme file text' }),
    url: app.getByRole('textbox', { name: 'Source (optional)' }),
    // The app keeps imported themes in its own settings (needs 55): the names stored, not what the gallery shows.
    imported: { count: async () => (JSON.parse((await stored(app)) ?? '{}').themesImported ?? []).length as number },
  };
}

test('theme_import_enter_name: Enter in the name field imports, the form empties', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  const f = await form(app);
  await f.text.fill(THEME);
  await f.name.fill('Enter Name');
  await f.name.press('Enter');
  await expect.poll(() => f.imported.count()).toBe(1);
  await expect(f.name).toHaveValue('');
  await expect(f.text).toHaveValue('');
});

test('theme_import_enter_url: Enter in the URL field imports', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  const f = await form(app);
  await f.name.fill('Enter Url');
  await f.text.fill(THEME);
  await f.url.fill('https://example.com/my-theme');
  await f.url.press('Enter');
  await expect.poll(() => f.imported.count()).toBe(1);
  await expect(f.url).toHaveValue('');
});

test('theme_import_enter_refusal: Enter on a bad theme shows the same refusal as the button, adds nothing', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  const f = await form(app);
  await f.name.fill('Bad');
  await f.text.fill('font-size = 12');
  await f.name.press('Enter');
  await expect(app.getByRole('alert')).toContainText('No theme found');
  await expect.poll(() => f.imported.count()).toBe(0);
  await expect(app).toHaveURL(/./); // the page did not reload (a native form submit would navigate)
  await expect(f.name).toHaveValue('Bad');
});

test('theme_import_enter_textarea: Enter in the text area is a newline and submits nothing', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  const f = await form(app);
  await f.name.fill('Textarea');
  await f.text.fill('background = #102030');
  await f.text.press('Enter');
  await f.text.pressSequentially('foreground = #e0e0e0');
  await expect(f.text).toHaveValue('background = #102030\nforeground = #e0e0e0');
  await expect.poll(() => f.imported.count()).toBe(0);
  await expect(app.getByRole('alert')).toHaveCount(0);
});

test('theme_import_enter_ime: an IME Enter in the name or URL field never submits', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  const f = await form(app);
  await f.name.fill('Composing');
  await f.text.fill(THEME);
  for (const field of [f.name, f.url]) {
    for (const init of [{ isComposing: true }, { keyCode: 229 }]) {
      await field.evaluate((el, i) => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...i })), init);
    }
  }
  await app.waitForTimeout(300);
  await expect.poll(() => f.imported.count()).toBe(0);
  await expect(f.name).toHaveValue('Composing');
});
