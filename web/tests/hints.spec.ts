// Hint labels by kind (V1A-48; needs 25, 30, 61; ticket 389): s1 prefixes, Shift+kind filter, icon letters, a Korean source,
// and Settings > Keys > Hints.
import type { Page } from '@playwright/test';
import { stripOnTop, expect, openWindow, test } from './fixtures';

test.beforeEach(({ core }) => stripOnTop(core));

/** A keydown as a Korean input source delivers it: the physical code, a Hangul key and keyCode 229. */
const korean = (page: Page, code: string) =>
  page.evaluate((c) => (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, code: c, key: 'ㅁ', keyCode: 229 })), code);
/** A label letter's QWERTY key code. */
const codeOf = (k: string) => (/\d/.test(k) ? `Digit${k}` : `Key${k.toUpperCase()}`);

const hints = async (page: Page) => {
  await page.keyboard.press('Control+Space');
  await page.keyboard.press('KeyF');
  await expect(page.locator('.hint').first()).toBeVisible();
};

for (const source of ['us', 'korean'] as const) {
  test(`s then 2 opens the second session, Shift+L then a label opens Search (${source} source)`, async ({ app, core }) => {
    const p = core.project('demo');
    const ids = ['one', 'two', 'three'].map((l) => core.shell(p, l).id);
    await openWindow(app);
    await expect(app.locator('.tab')).toHaveCount(3);
    const press = (code: string) => (source === 'korean' ? korean(app, code) : app.keyboard.press(code));
    await hints(app);
    // Ticket 389: tabs read s1 s2 s3 from the start; s keeps them in place and dims the rest; Backspace undoes it.
    await expect(app.locator('.hint[data-hint-kind="tab"]')).toHaveText(['s1', 's2', 's3']);
    await press('KeyS');
    await expect(app.locator('.hint:not([data-dim])[data-hint-kind="tab"]')).toHaveText(['s1', 's2', 's3']);
    await expect(app.locator('.hint[data-dim]').first()).toBeVisible();
    await press('Backspace');
    await expect(app.locator('.hint[data-dim]')).toHaveCount(0);
    await press('KeyS');
    await press('Digit2');
    await expect(app.locator('.hint')).toHaveCount(0);
    await expect(app.locator(`.tab[data-tab="${ids[1]}"]`)).toHaveAttribute('aria-selected', 'true');
    // The Search icon sits on the left bar: Shift+L, then its label.
    await hints(app);
    if (source === 'korean') await app.evaluate(() => (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, code: 'KeyL', key: 'ㅣ', keyCode: 229, shiftKey: true })));
    else await app.keyboard.press('Shift+KeyL');
    await expect(app.locator('.hint:not([data-hint-kind="left"])')).toHaveCount(0);
    for (const code of (await app.locator('.hint[data-hint-icon="search.open"]').getAttribute('data-keys'))!.split(' ')) await press(codeOf(code));
    await expect(app.locator('.hint')).toHaveCount(0);
    await expect(app.locator('.sbar .spanel')).toBeVisible();
  });
}

test('the third session label opens the third session: a file tab moved between sessions does not shift it', async ({ app, core }) => {
  const p = core.project('demo');
  const ids = ['one', 'two', 'three'].map((l) => core.shell(p, l).id);
  await openWindow(app);
  await expect(app.locator('.tab')).toHaveCount(3);
  await app.evaluate((root) => window.dispatchEvent(new CustomEvent('nunchiro:files.open', { detail: { root, path: 'notes.txt' } })), ids[0]);
  await expect(app.locator('.tab')).toHaveCount(4);
  await app.keyboard.press('Control+Space');
  await app.keyboard.press('Shift+Comma'); // tab.move.left: one two notes.txt three
  await expect(app.locator('.tab').nth(2)).toHaveAttribute('data-tab', `file:${ids[0]}:notes.txt`);
  await hints(app);
  // s4 is the fourth tab (Cmd-4): the session three, after the moved file tab in slot 3.
  await expect(app.locator('.hint[data-hint-kind="tab"]')).toHaveText(['s1', 's2', 's3', 's4']);
  await app.keyboard.press('KeyS');
  await app.keyboard.press('Digit4');
  await expect(app.locator(`.tab[data-tab="${ids[2]}"]`)).toHaveAttribute('aria-selected', 'true');
});

test('every target worth a click keeps a label; only a tab and its own session rows share one', async ({ app, core }) => {
  const p = core.project('demo');
  for (const l of ['one', 'two', 'three']) core.shell(p, l);
  await openWindow(app);
  await hints(app);
  const labels = await app.locator('.hint:not([data-hint-kind="tab"]):not([data-hint-kind="session"])').evaluateAll((hs) => hs.map((h) => (h as HTMLElement).dataset.keys));
  expect(new Set(labels).size).toBe(labels.length);
  // The tab strip's inactive tabs are reachable too (kind t).
  await expect(app.locator('.hint[data-hint-kind="tab"]')).toHaveCount(3);
});

test('Settings > Keys > Hints: the alphabet typed in the field shows in the preview, labels use it, and Reset restores the default', async ({ app, core }) => {
  const p = core.project('demo');
  for (const l of ['one', 'two', 'three']) core.shell(p, l);
  await openWindow(app);
  await app.keyboard.press('Meta+Comma');
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Keyboard' }).click();
  await app.getByRole('button', { name: 'Options ↓' }).click(); // needs 192 (ticket 250): hints are the Keyboard page's last part, reached from the Options link
  const section = app.getByRole('region', { name: 'Hints' });
  const preview = section.getByRole('img', { name: /preview/i });
  const field = section.getByRole('textbox', { name: 'Hint alphabet' });
  await expect(field).toHaveValue('asdfjklghewruiopqtyvcmnxzb1234567890');
  await expect(preview.locator('[data-hint-kind="left"]')).toHaveText(['a', 'd', 'f']);
  await field.fill('jkmnbvcxzqeya1234567890'); // no prefix key inside, so every key is used
  await expect(preview.locator('[data-hint-kind="left"]')).toHaveText(['q', 'a', 'n']);
  // The window's hints use the saved alphabet: a Shift-filtered tab view starts at its first key.
  await app.keyboard.press('Escape');
  await app.locator('.tab').first().click();
  await hints(app);
  await app.keyboard.press('Shift+KeyT');
  await expect(app.locator('.hint[data-hint-kind="tab"]')).toHaveText(['j', 'k', 'm']);
  await app.keyboard.press('Escape');
  await app.reload();
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  await app.locator('.tab').first().click(); // WebKit gives a reloaded page keys only after a click in it
  await app.keyboard.press('Meta+Comma');
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Keyboard' }).click();
  await app.getByRole('button', { name: 'Options ↓' }).click(); // needs 192 (ticket 250): hints are the Keyboard page's last part, reached from the Options link
  await expect(field).toHaveValue('jkmnbvcxzqeya1234567890');
  await section.getByRole('button', { name: 'Reset to defaults' }).click();
  await expect(field).toHaveValue('asdfjklghewruiopqtyvcmnxzb1234567890');
});
