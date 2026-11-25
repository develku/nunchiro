// Ticket 1071: ⌘= ⌘+ ⌘- ⌘0 zoom the whole window (uiZoom, 0.5-2.0 by 0.1), not the terminal font; the native View menu's
// items reach the page as 'nunchiro:command' (main.rs command_script). In the browser runner the zoom is read from
// <html data-ui-zoom>; the app also calls the webview's setZoom, which this runner cannot see.
import { expect, openWindow, test } from './fixtures';

test('zoom keys zoom the window, clamp to 0.5-2.0, reset, persist, and leave the terminal font and the PTY alone', async ({ app, core }) => {
  const p = core.project('demo');
  const ids = ['one', 'two'].map((l) => core.shell(p, l).id);
  await openWindow(app);
  await app.locator(`.tab[data-tab="${ids[0]}"]`).click();
  await app.locator(`.term[data-session="${ids[0]}"]`).click();
  const before = core.read(ids[0]) + core.read(ids[1]);
  const saved = () => app.evaluate(() => JSON.parse(localStorage.getItem('nunchiro.settings.v1') ?? '{}') as { uiZoom?: number; termFontSize?: number });
  const shown = () => app.evaluate(() => document.documentElement.dataset.uiZoom);
  await expect.poll(shown).toBe('1');
  await app.keyboard.press('Meta+Equal');
  await expect.poll(async () => (await saved()).uiZoom).toBe(1.1);
  await expect.poll(shown).toBe('1.1');
  await app.keyboard.press('Shift+Meta+Equal');
  await expect.poll(shown).toBe('1.2');
  for (let i = 0; i < 12; i++) await app.keyboard.press('Meta+Equal');
  await expect.poll(shown).toBe('2');
  await app.reload();
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  await expect.poll(shown).toBe('2');
  await app.keyboard.press('Meta+Digit0');
  await expect.poll(shown).toBe('1');
  for (let i = 0; i < 8; i++) await app.keyboard.press('Meta+Minus');
  await expect.poll(shown).toBe('0.5');
  expect((await saved()).uiZoom).toBe(0.5);
  expect((await saved()).termFontSize ?? 12).toBe(12);
  // The View menu's script runs the same commands.
  await app.evaluate(() => window.dispatchEvent(new CustomEvent('nunchiro:command', { detail: 'zoom.reset' })));
  await expect.poll(shown).toBe('1');
  // No bytes reached either PTY for the zoom keys: a typed marker is the only new output (resize size marks left out).
  await app.locator(`.term[data-session="${ids[0]}"]`).click();
  await app.keyboard.type('qz');
  await expect.poll(() => core.read(ids[0])).toContain('qz');
  const keys = (s: string) => s.replace(/\x1b\[8;\d+;\d+t/g, '').replace('qz', '').replace('qz', '');
  expect(keys(core.read(ids[0]) + core.read(ids[1]))).toBe(keys(before));
});

test('the palette lists the three zoom commands; the menu event jumps to a tab', async ({ app, core }) => {
  const p = core.project('demo');
  const ids = ['one', 'two'].map((l) => core.shell(p, l).id);
  await openWindow(app);
  await app.keyboard.press('Meta+KeyK');
  const palette = app.getByRole('dialog', { name: 'Command palette' });
  await palette.getByRole('combobox', { name: 'Command palette search' }).fill('zoom');
  for (const id of ['zoom.in', 'zoom.out', 'zoom.reset']) await expect(palette.locator(`[data-command="${id}"]`)).toHaveCount(1);
  await app.keyboard.press('Escape');
  const activeTab = () => app.locator('.tab[aria-selected="true"]').getAttribute('data-tab');
  await app.evaluate(() => window.dispatchEvent(new CustomEvent('nunchiro:command', { detail: 'session.jump.2' })));
  await expect.poll(activeTab).toBe(ids[1]);
  await app.evaluate(() => window.dispatchEvent(new CustomEvent('nunchiro:command', { detail: 'session.jump.1' })));
  await expect.poll(activeTab).toBe(ids[0]);
});
