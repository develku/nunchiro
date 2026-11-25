// Ticket 1062: with the side pane open the composer card stays in the chat column, never over the pane, at any width,
// and its height is the same with and without the pane (the chips row stays one line).
import { expect, openChat, append, rec, test } from './fixtures/chat/harness';
import type { Page } from '@playwright/test';
import { icon } from './d5b';

// An idle agent with a model, an effort and a mode: a working one disables the pickers (composer-footer.spec.ts does the same).
async function idle(page: Page) {
  await page.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => server.send(m));
    server.onMessage((m) => {
      const frame = typeof m === 'string' ? JSON.parse(m) : null;
      if (frame?.event !== 'snapshot') return ws.send(m);
      for (const s of frame.sessions) Object.assign(s, { model: 'opus', effort: 'xhigh', permission_mode: 'accept edits', attention: { ...s.attention, working: false } });
      ws.send(JSON.stringify(frame));
    });
  });
}

const SIDE = '[data-side-pane]:not([hidden])';

for (const width of [1560, 1000]) {
  test(`composer_stays_in_chat_column (${width})`, async ({ page, chatCore }) => {
    const s = chatCore.chat('col', true, true, 'p');
    append(s.file, rec.user('go'), rec.assistant('ok'));
    await idle(page);
    await page.setViewportSize({ width, height: 900 });
    await openChat(page, s.id);
    const card = page.locator('.composer:not([data-pinned]) .cbox');
    const closed = (await card.boundingBox())!;
    const composerClosed = (await page.locator('.composer:not([data-pinned])').boundingBox())!;
    await icon(page, 'right', 'Terminal').click();
    const pane = page.locator(SIDE);
    await expect(pane).toBeVisible();
    // Polled: --pane-room is set on the frame after the pane lays out.
    await expect.poll(async () => (await card.boundingBox())!.x + (await card.boundingBox())!.width).toBeLessThanOrEqual((await pane.boundingBox())!.x);
    const p = (await pane.boundingBox())!;
    const open = (await card.boundingBox())!;
    const col = (await page.locator('.chat:not([data-off])').first().boundingBox())!;
    expect(open.x + open.width).toBeLessThanOrEqual(p.x);
    expect(open.x).toBeGreaterThanOrEqual(col.x);
    // No chip reaches the pane (at 1000 px the column is about 316 px: the pickers shrink to nothing and Send touches the box's edge).
    const over = await page.locator('.composer:not([data-pinned]) .cbox .chips > *').evaluateAll((els, r) => els.filter((e) => e.getBoundingClientRect().right > r).length, p.x);
    expect(over).toBe(0);
    // A menu that opens upward from the row is not clipped by it (only where the pickers still have a width).
    for (const menu of width > 1200 ? ['model', 'mode'] : []) {
      await page.locator(menu === 'model' ? '[data-picker="model"]' : '.composer .perm-wrap button.perm').first().click();
      const m = page.locator(menu === 'model' ? '[data-menu="model"]' : '.perm-menu').first();
      await expect(m).toBeVisible();
      const b = (await m.boundingBox())!;
      expect(await page.evaluate(([x, y]) => !!document.elementFromPoint(x, y)?.closest('.pk-menu, .perm-menu'), [b.x + b.width / 2, b.y + 6])).toBe(true);
      await page.keyboard.press('Escape');
    }
    expect((await page.locator('.composer:not([data-pinned])').boundingBox())!.height).toBe(composerClosed.height);
    // The pane's bottom centre is the pane's own, not covered by the composer.
    expect(await page.evaluate(([x, y]) => !!document.elementFromPoint(x, y)?.closest('[data-side-pane]'), [p.x + p.width / 2, p.y + p.height - 20])).toBe(true);
    // The pane closed: the card is where it was.
    await icon(page, 'right', 'Terminal').click();
    await expect(pane).toBeHidden();
    await expect.poll(async () => JSON.stringify(await card.boundingBox())).toBe(JSON.stringify(closed));
  });
}
