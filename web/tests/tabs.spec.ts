// V1A-41: rename and reorder session tabs from the window; the V1A-37 live-region carry-over.
import type { Locator, Page } from '@playwright/test';
import { clashes, DEFAULT_BINDINGS } from '../src/keys';
import { expect, grantClipboard, openWindow, test, type Core, stripOnTop } from './fixtures';

test.beforeEach(({ core }) => stripOnTop(core));

const labelOf = (core: Core, id: string) => (core.cli('snapshot', '--json').sessions as { id: string; label: string }[]).find((s) => s.id === id)!.label;
const tabIds = (page: Page) => page.locator('.tab').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.tab));
const stored = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('nunchiro.settings.v1') ?? '{}').order as string[]);
const prefix = async (page: Page, ...keys: string[]) => {
  await page.keyboard.press('Control+Space');
  for (const k of keys) await page.keyboard.press(k);
};
const field = (page: Page, name?: string) => page.getByRole('textbox', { name: name ? `Rename ${name}` : /^Rename / });
const three = (core: Core) => {
  const p = core.project('demo');
  return ['one', 'two', 'three'].map((l) => core.shell(p, l).id);
};

test('rename by double-click saves the typed text through the core label; tab, sidebar and palette show it; reload keeps it', async ({ app, core }) => {
  const [a] = three(core);
  await openWindow(app);
  await app.locator(`.tab[data-tab="${a}"]`).dblclick();
  await expect(field(app, 'one')).toBeFocused();
  await field(app).fill('  build lane  ');
  await app.keyboard.press('Enter');
  await expect(field(app)).toHaveCount(0);
  expect(labelOf(core, a)).toBe('build lane');
  await expect(app.locator(`.tab[data-tab="${a}"]`)).toContainText('build lane');
  await expect(app.locator('.tree, .ar').getByText('build lane').first()).toBeVisible();
  await app.keyboard.press('Meta+KeyK');
  await expect(app.getByRole('dialog', { name: 'Command palette' }).locator(`[data-command="session.open.${a}"]`)).toContainText('build lane');
  await app.keyboard.press('Escape');
  await app.reload();
  await expect(app.locator(`.tab[data-tab="${a}"]`)).toContainText('build lane');
});

test('tab.rename (prefix Comma) edits the active tab; Escape sends nothing; empty clears back to the default name', async ({ app, core }) => {
  const [a] = three(core);
  await openWindow(app);
  await prefix(app, 'Comma');
  await expect(field(app, 'one')).toBeFocused();
  await field(app).fill('typed then abandoned');
  await app.keyboard.press('Escape');
  await expect(field(app)).toHaveCount(0);
  await expect(app.locator(`.tab[data-tab="${a}"]`)).toBeFocused(); // keyboard users stay in the strip
  expect(labelOf(core, a)).toBe('one');
  await expect(app.locator(`.tab[data-tab="${a}"]`)).toContainText('one');
  await prefix(app, 'Comma');
  await field(app).fill('');
  await app.keyboard.press('Enter');
  await expect.poll(() => labelOf(core, a)).toBe('');
  await expect(app.locator(`.tab[data-tab="${a}"]`)).toContainText("New terminal");
});

test('a name over 256 bytes is refused with a visible message and nothing is sent; 256 bytes pass', async ({ app, core }) => {
  const [a] = three(core);
  await openWindow(app);
  await app.locator(`.tab[data-tab="${a}"]`).dblclick();
  await field(app).fill('a'.repeat(300));
  await app.keyboard.press('Enter');
  await expect(app.getByRole('alert').filter({ hasText: '256' })).toBeVisible();
  await expect(field(app)).toBeVisible();
  expect(labelOf(core, a)).toBe('one');
  // 100 Korean syllables are 100 characters but 300 bytes: the limit counts bytes.
  await field(app).fill('가'.repeat(100));
  await app.keyboard.press('Enter');
  await expect(app.getByRole('alert').filter({ hasText: '256' })).toBeVisible();
  expect(labelOf(core, a)).toBe('one');
  await field(app).fill('a'.repeat(256));
  await app.keyboard.press('Enter');
  await expect.poll(() => labelOf(core, a)).toBe('a'.repeat(256));
});

test('a Korean name typed with composition is saved whole; Enter that commits a syllable does not save', async ({ app, core, browserName }) => {
  const [a] = three(core);
  await openWindow(app);
  await app.locator(`.tab[data-tab="${a}"]`).dblclick();
  const box = field(app);
  const name = '눈치로 탭 이름';
  if (browserName === 'chromium') {
    const cdp = await app.context().newCDPSession(app);
    for (const ch of name) {
      await cdp.send('Input.imeSetComposition', { text: ch, selectionStart: 1, selectionEnd: 1 });
      await cdp.send('Input.insertText', { text: ch });
    }
    // Enter while the last syllable is still composing only commits it.
    await cdp.send('Input.imeSetComposition', { text: '가', selectionStart: 1, selectionEnd: 1 });
    await app.keyboard.press('Enter');
    expect(labelOf(core, a)).toBe('one');
    await cdp.send('Input.insertText', { text: '' });
    await box.fill(name);
  } else await app.keyboard.insertText(name);
  await app.keyboard.press('Enter');
  await expect.poll(() => labelOf(core, a)).toBe(name);
  await expect(app.locator(`.tab[data-tab="${a}"]`)).toContainText(name);
});

test('rename field has an accessible name and a label is shown as text, never as markup', async ({ app, core }) => {
  const [a] = three(core);
  await openWindow(app);
  await app.locator(`.tab[data-tab="${a}"]`).dblclick();
  await expect(field(app, 'one')).toBeVisible();
  await field(app).fill('<img src=x onerror=alert(1)>');
  await app.keyboard.press('Enter');
  await expect(app.locator(`.tab[data-tab="${a}"] img`)).toHaveCount(0);
  await expect(app.locator(`.tab[data-tab="${a}"]`)).toContainText('<img src=x onerror=alert(1)>');
});

test('tab.move.right / tab.move.left reorder the tabs and settings.order; reload opens them in that order; jump 1 follows', async ({ app, core }) => {
  const [a, b, c] = three(core);
  await openWindow(app);
  expect(await tabIds(app)).toEqual([a, b, c]);
  await prefix(app, 'Shift+Period');
  expect(await tabIds(app)).toEqual([b, a, c]);
  await expect(app.locator('[data-live="tabs"]')).toContainText('one');
  await expect(app.locator('[data-live="tabs"]')).toContainText('2 of 3');
  expect((await stored(app)).slice(0, 3)).toEqual([b, a, c]);
  await prefix(app, 'Shift+Period');
  expect(await tabIds(app)).toEqual([b, c, a]);
  await prefix(app, 'Shift+Period'); // at the end: nothing moves
  expect(await tabIds(app)).toEqual([b, c, a]);
  await prefix(app, 'Shift+Comma');
  expect(await tabIds(app)).toEqual([b, a, c]);
  expect((await stored(app)).slice(0, 3)).toEqual([b, a, c]);
  await app.reload();
  await expect(app.locator('.tab')).toHaveCount(3);
  expect(await tabIds(app)).toEqual([b, a, c]);
  await prefix(app, 'Digit1');
  await expect(app.locator('.tab[aria-selected="true"]')).toHaveAttribute('data-tab', b);
});

test('dragging a tab onto another moves it and settings.order; Settings is a modal, never a tab (v25f)', async ({ app, core }) => {
  const [a, b, c] = three(core);
  await openWindow(app);
  await app.locator(`.tab[data-tab="${a}"]`).dragTo(app.locator(`.tab[data-tab="${c}"]`));
  expect(await tabIds(app)).toEqual([b, c, a]);
  expect((await stored(app)).slice(0, 3)).toEqual([b, c, a]);
  await app.keyboard.press('Meta+Comma');
  await expect(app.getByRole('dialog', { name: 'Settings' })).toBeVisible();
  expect(await tabIds(app)).toEqual([b, c, a]);
  await app.keyboard.press('Escape');
  await app.reload();
  await expect(app.locator('.tab')).toHaveCount(3);
  expect(await tabIds(app)).toEqual([b, c, a]);
});

test('the commands are listed in the palette and have distinct default bindings', async ({ app, core }) => {
  three(core);
  await openWindow(app);
  await app.keyboard.press('Meta+KeyK');
  const palette = app.getByRole('dialog', { name: 'Command palette' });
  for (const id of ['tab.rename', 'tab.move.left', 'tab.move.right']) await expect(palette.locator(`[data-command="${id}"]`)).toBeVisible();
  expect(clashes(DEFAULT_BINDINGS)).toEqual([]); // ticket 534: keys.ts SHARED pairs (Settings-only ⌘F) are no clash
  expect(DEFAULT_BINDINGS['tab.rename']).toEqual(['prefix Comma', 'F2']); // needs 166 (f34bb5cf) added F2
  expect(DEFAULT_BINDINGS['tab.move.left']).toEqual(['prefix Shift+Comma']);
  expect(DEFAULT_BINDINGS['tab.move.right']).toEqual(['prefix Shift+Period']);
});

// Carried from the V1A-37 review: a live region must already exist when its text changes, or a screen reader says nothing.
test('the Zoomed marker keeps one mounted status element and reads "Zoomed" alone when zone.zoom has no binding', async ({ app, core }) => {
  three(core);
  await app.addInitScript(() => localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ bindings: { 'zone.zoom': [] } })));
  await openWindow(app);
  const live: Locator = app.locator('[data-live="zoom"]');
  await expect(live).toHaveAttribute('role', 'status');
  await expect(live).toHaveText('');
  const node = await live.elementHandle();
  await app.keyboard.press('Meta+KeyK');
  await app.getByRole('combobox', { name: 'Command palette search' }).fill('Zoom or restore');
  await app.keyboard.press('Enter');
  await expect(live).toHaveText('Zoomed');
  expect(await node!.evaluate((n) => n.isConnected)).toBe(true);
  await app.keyboard.press('Meta+KeyK');
  await app.getByRole('combobox', { name: 'Command palette search' }).fill('Zoom or restore');
  await app.keyboard.press('Enter');
  await expect(live).toHaveText('');
  expect(await node!.evaluate((n) => n.isConnected)).toBe(true);
});

test('the Copied status element is mounted before the copy and only its text changes', async ({ app, core }) => {
  await grantClipboard(app);
  const a = core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  const live = app.locator('[data-live="copied"]');
  await expect(live).toHaveAttribute('role', 'status');
  await expect(live).toHaveText('');
  const node = await live.elementHandle();
  await app.locator(`.term[data-session="${a.id}"]`).click();
  await app.keyboard.type('commit 1a2b3c4d');
  await app.keyboard.press('Enter');
  await expect.poll(() => app.locator(`.term[data-session="${a.id}"] .xterm-rows`).innerText()).toContain('1a2b3c4d');
  await prefix(app, 'KeyY');
  const hint = app.locator('.hint[data-kind="hash"][data-text="1a2b3c4d"]').first();
  await expect(hint).toBeVisible();
  for (const k of (await hint.getAttribute('data-keys'))!.split(' ')) // ticket 389: the letters shown; Korean input on, so key Process with the QWERTY code
    await app.evaluate((c) => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, code: c, key: 'Process', keyCode: 229 })), (/\d/.test(k) ? `Digit${k}` : `Key${k.toUpperCase()}`));
  await expect(live).toHaveText('Copied');
  expect(await node!.evaluate((n) => n.isConnected)).toBe(true);
  await expect(live).toHaveText('', { timeout: 5000 });
  expect(await node!.evaluate((n) => n.isConnected)).toBe(true);
});
