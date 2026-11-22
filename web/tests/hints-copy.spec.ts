// Hints copy mode (V1A-37; needs 25, 56): labels URLs, paths and git hashes; choosing one copies it, opens nothing.
import type { Page } from '@playwright/test';
import { expect, grantClipboard, openWindow, test, terminalText, showComposer } from './fixtures';

const choose = async (page: Page, kind: string, text: string) => {
  await page.keyboard.press('Control+Space');
  await page.keyboard.press('KeyY');
  const hint = page.locator(`.hint[data-kind="${kind}"][data-text="${text}"]`).first(); // the shell echoes the line, so the text shows twice
  const keys = await hint.getAttribute('data-keys');
  // Each label letter's QWERTY key with a Hangul key value, as a Korean input source delivers it (owner 11-10: the code stands in).
  for (const k of keys!.split(' '))
    await page.evaluate((c) => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, code: c, key: 'ㅁ' })), /\d/.test(k) ? `Digit${k}` : `Key${k.toUpperCase()}`);
};

test('prefix y labels hashes, paths and URLs; choosing one copies exactly its text and opens nothing', async ({ app, core }) => {
  await grantClipboard(app);
  const a = core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await showComposer(app); // V2.5-34: a shell's composer is asked for
  const popups: string[] = [];
  app.on('popup', (p) => popups.push(p.url()));
  await app.locator(`.term[data-session="${a.id}"]`).click();
  await app.keyboard.type('commit 1a2b3c4d src/a.rs:3 https://x.y/z build 12345678');
  await app.keyboard.press('Enter');
  await expect.poll(() => terminalText(app, a.id)).toContain('https://x.y/z');
  await app.keyboard.press('Control+Space');
  await app.keyboard.press('KeyY');
  // Copy mode labels terminal text only, and a plain number is not a hash.
  await expect(app.locator('.hint[data-kind="element"]')).toHaveCount(0);
  await expect(app.locator('.hint[data-kind="hash"][data-text="1a2b3c4d"]').first()).toBeVisible();
  await expect(app.locator('.hint[data-text="12345678"]')).toHaveCount(0);
  // V1A-48: copy mode shows only the u, f and h kinds.
  expect(new Set(await app.locator('.hint').evaluateAll((hs) => hs.map((h) => (h as HTMLElement).dataset.hintKind)))).toEqual(new Set(['hash', 'path', 'url']));
  await app.keyboard.press('Escape');
  for (const [kind, text] of [['hash', '1a2b3c4d'], ['path', 'src/a.rs:3'], ['url', 'https://x.y/z']]) {
    await choose(app, kind, text);
    await expect(app.locator('.hint')).toHaveCount(0);
    await expect(app.locator('.copied-note')).toHaveText('Copied');
    expect(await app.evaluate(() => navigator.clipboard.readText())).toBe(text);
    await app.evaluate(() => navigator.clipboard.writeText(''));
  }
  expect(popups).toEqual([]);
  await expect(app.locator('.cbox textarea')).toHaveValue('');
});

test('the existing hints mode is unchanged: prefix f still labels window elements', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await app.keyboard.press('Control+Space');
  await app.keyboard.press('KeyF');
  await expect(app.locator('.hint[data-kind="element"]').first()).toBeVisible();
});
