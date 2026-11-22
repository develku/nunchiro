// v25-popover-flake (V2.5-41): the New tab popover and a press right after it opens; the composer's seat settling.
import { expect, openWindow, test } from './fixtures';

// The press arrives in the same task as the popover's insertion into the page (a MutationObserver callback runs right
// after the commit, before the browser paints and before a passive effect would have run): the popover must already be
// listening, or this press is lost and the popover stays open behind the pointer.
test('popover_press_right_after_open_closes', async ({ app, core }) => {
  core.shell(core.project('alpha'), 'a1');
  await openWindow(app);
  await app.evaluate(() => {
    const ob = new MutationObserver(() => {
      if (!document.querySelector('[role="dialog"][aria-label="New tab"]')) return;
      ob.disconnect();
      (window as unknown as { pressed?: boolean }).pressed = true;
      document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true }));
    });
    ob.observe(document.body, { childList: true, subtree: true });
  });
  // Opened from the palette: its run is a timeout, so the render is not a discrete one and its effects wait for after the paint.
  await app.keyboard.press('Meta+KeyK');
  await app.locator('[data-command="session.new"]').click();
  await expect.poll(() => app.evaluate(() => (window as unknown as { pressed?: boolean }).pressed)).toBe(true); // the popover did open
  await expect(app.getByRole('dialog', { name: 'New tab' })).toHaveCount(0);
});
