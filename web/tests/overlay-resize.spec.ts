// Owner 2026-11-16: the Settings modal is resized with the corner grip; the size is kept; a double click restores full size.
import { expect, openWindow, test } from './fixtures';
import { openSettings } from './settings-modal';

test('overlay_resize: the grip makes Settings smaller, the size survives a reopen, a double click restores it', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await openSettings(app);
  const panel = app.locator('.ovl-panel');
  const full = (await panel.boundingBox())!;
  const grip = (await app.locator('.ovl-grip').boundingBox())!;
  await app.mouse.move(grip.x + 8, grip.y + 8);
  await app.mouse.down();
  await app.mouse.move(grip.x - 92, grip.y - 52, { steps: 4 });
  await app.mouse.up();
  const small = (await panel.boundingBox())!;
  expect(Math.round(full.width - small.width)).toBe(200); // centred: both edges move
  expect(Math.round(full.height - small.height)).toBe(120);
  expect(Math.round(small.x - full.x)).toBe(100);
  await app.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await openSettings(app);
  expect(Math.round((await panel.boundingBox())!.width)).toBe(Math.round(small.width));
  await app.locator('.ovl-grip').dblclick();
  expect(Math.round((await panel.boundingBox())!.width)).toBe(Math.round(full.width));
});
