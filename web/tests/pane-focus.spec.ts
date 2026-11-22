// V1A-54 real-window owner-check items for pane mode (V1A-43): focus after a swap, and Control+h/l on the centre zone.
import type { Page } from '@playwright/test';
import { expect, openWindow, terminalText, test, type Core, legacyLayout } from './fixtures';

test.beforeEach(({ core }) => legacyLayout(core)); // D5b: the default window has no tree or AGENTS zone; this spec is about zones, so it starts from their old shape

const pane = async (app: Page) => {
  await app.keyboard.press('Control+Space');
  await app.keyboard.press('KeyR');
};
const focused = (app: Page) => app.locator('[data-pane-focus="true"]');

for (const keys of [['Shift+KeyH'], ['Shift+KeyH', 'Shift+KeyL']]) {
  test(`pane-swap-esc-focus: ${keys.join(' ')} swap, Esc, typed text reaches the focused terminal`, async ({ app, core }) => {
    const s = core.shell(core.project('demo'), 'alpha');
    await openWindow(app);
    await app.locator(`.term[data-session="${s.id}"]`).click();
    await pane(app);
    for (const [i, key] of keys.entries()) {
      await app.keyboard.press(key);
      // The terminal widget sits in the tree zone after Shift+h and is back in its own zone after Shift+l.
      const zone = i % 2 ? 'terminal' : 'tree';
      await expect(focused(app)).toHaveAttribute('data-zone-id', zone);
      // At a person's pace: the moved terminal has remounted its xterm before the next key.
      await expect(app.locator(`[data-zone-id="${zone}"] [data-widget="terminal"] .xterm-helper-textarea`)).toBeAttached();
    }
    await expect(focused(app)).toHaveCount(1);
    await app.keyboard.press('Escape');
    await expect(focused(app)).toHaveCount(0);
    await expect.poll(() => app.evaluate(() => document.activeElement?.id ?? '')).not.toBe('key-sink');
    await app.keyboard.type('swapped');
    await expect.poll(() => terminalText(app, s.id)).toContain('swapped');
  });
}

const width = async (app: Page, id: string) => Math.round((await app.locator(`[data-zone-id="${id}"]`).boundingBox())!.width);
const withBoard = async (app: Page, core: Core) => {
  core.cli('layout', 'edge', 'right', 'board'); // UXFIX (c): the Board icon opens a centre tab; this test is about the edge zone
  await expect(app.locator('[data-zone-id] [data-widget="board"]')).toBeVisible();
};

test('pane-resize-ctrl-lh: on the centre zone between the sidebar and the board, Control+l then Control+h cancels and the sidebar keeps its width', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await withBoard(app, core);
  await app.locator('.term').first().click();
  await pane(app);
  await expect(focused(app)).toHaveAttribute('data-zone-id', 'terminal');
  const [t0, s0] = [await width(app, 'terminal'), await width(app, 'tree')];
  await app.keyboard.press('Control+KeyL');
  await expect.poll(() => width(app, 'terminal')).toBe(t0 + 16);
  expect(await width(app, 'tree')).toBe(s0);
  await app.keyboard.press('Control+KeyH');
  await expect.poll(() => width(app, 'terminal')).toBe(t0);
  expect(await width(app, 'tree')).toBe(s0);
});

test('pane-resize-ctrl-lh: pane focus on the board draws its outline on screen', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await withBoard(app, core);
  await app.locator('.term').first().click();
  await pane(app);
  await app.keyboard.press('KeyL');
  const board = focused(app);
  await expect(board.locator('[data-widget="board"]')).toBeVisible();
  const want = await board.evaluate((el) => getComputedStyle(el, '::after').borderTopColor);
  const b = (await board.boundingBox())!;
  // The outline is inset 2 px: the pixel 1 px inside the left edge, halfway down, must be the focus colour.
  const png = await app.screenshot({ clip: { x: b.x + 1, y: b.y + b.height / 2, width: 1, height: 1 } });
  const px = await app.evaluate(async (data) => {
    const img = await createImageBitmap(new Blob([Uint8Array.from(atob(data), (ch) => ch.charCodeAt(0))], { type: 'image/png' }));
    const c = new OffscreenCanvas(1, 1).getContext('2d')!;
    c.drawImage(img, 0, 0);
    return [...c.getImageData(0, 0, 1, 1).data.slice(0, 3)];
  }, png.toString('base64'));
  expect(`rgb(${px.join(', ')})`).toBe(want);
});
