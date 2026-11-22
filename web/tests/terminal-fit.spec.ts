// V1A-54 item 6 (owner pass 2026-10-26): the terminal's last row is fully on screen above the answer strip, and a
// session zoomed while its tab is hidden shows its newest output when shown.
import type { Page } from '@playwright/test';
import { expect, openWindow, terminalText, test } from './fixtures';

const LINES = Array.from({ length: 200 }, (_, i) => `row ${i + 1}`).join('\r\n');

/** Bottom of the last drawn row vs the bottom of the terminal box and the top of whatever sits below it. */
const lastRow = (app: Page, id: string) =>
  app.evaluate((id) => {
    const term = document.querySelector<HTMLElement>(`.term[data-session="${id}"]`)!;
    const screen = term.querySelector('.xterm-screen')!.getBoundingClientRect();
    const box = term.getBoundingClientRect();
    const below = document.elementFromPoint(box.left + 20, screen.bottom - 2);
    return { rowBottom: Math.round(screen.bottom), boxBottom: Math.round(box.bottom), ownsBottom: !!below && term.contains(below) };
  }, id);

for (const size of [{ width: 1440, height: 900 }, { width: 1280, height: 777 }, { width: 1100, height: 640 }]) {
  test(`terminal-last-row-visible: ${size.width}x${size.height} the last row ends inside the terminal box`, async ({ app, core }) => {
    await app.setViewportSize(size);
    const s = core.replay(core.project('demo'), 'alpha', LINES);
    await openWindow(app);
    await expect.poll(() => terminalText(app, s.id)).toContain('row 200');
    const m = await lastRow(app, s.id);
    expect(m.rowBottom, JSON.stringify(m)).toBeLessThanOrEqual(m.boxBottom);
    expect(m.ownsBottom, JSON.stringify(m)).toBe(true);
  });
}

const zoom = async (app: Page) => {
  await app.keyboard.press('Control+Space');
  await app.keyboard.press('KeyZ');
};
for (const order of ['zoom, then show', 'zoom, unzoom, then show', 'show zoomed, unzoom', 'cold: zoom, then show', 'cold: show zoomed, unzoom']) {
  test(`terminal-last-row-visible: a session hidden while the zoom changes shows its newest row (${order})`, async ({ app, core }) => {
    const b = core.replay(core.project('demo'), 'beta', LINES);
    const a = core.replay(core.project('demo'), 'alpha', LINES);
    if (order.startsWith('cold')) await app.clock.install();
    await openWindow(app);
    // Both tabs have drawn once, so beta's xterm is warm while hidden.
    await app.locator(`.tab[data-tab="${b.id}"]`).click();
    await expect.poll(() => terminalText(app, b.id)).toContain('row 200');
    await app.locator(`.tab[data-tab="${a.id}"]`).click();
    await app.locator(`.term[data-session="${a.id}"]`).click();
    // Hidden past COOL_MS: beta's xterm is dropped and rebuilt from the core's log when shown.
    if (order.startsWith('cold')) {
      await app.clock.fastForward(31_000);
      await expect(app.locator(`.term[data-session="${b.id}"] .xterm`)).toHaveCount(0);
    }
    await zoom(app);
    await expect(app.locator('[data-zone-id="tree"]')).toBeHidden();
    if (order === 'zoom, unzoom, then show') await zoom(app);
    await app.keyboard.press('Control+Space');
    await app.keyboard.press('KeyN'); // next tab
    await expect(app.locator(`.term[data-session="${b.id}"]`)).toBeVisible();
    if (order.endsWith('show zoomed, unzoom')) await zoom(app);
    await expect.poll(() => terminalText(app, b.id)).toContain('row 200');
  });
}
