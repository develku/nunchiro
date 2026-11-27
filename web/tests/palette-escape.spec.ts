// Esc closes the command palette however soon it comes after the palette opened, also while snapshots re-render the
// window (ended-session-actions restart_one_rule failed about one run in two: the palette stayed open after Esc).
import { expect, openWindow, test } from './fixtures';

test('palette_escape_at_once: Esc right after ⌘K closes the palette, every time', async ({ app, core }) => {
  const p = core.project('demo');
  for (const l of ['one', 'two', 'three']) core.shell(p, l);
  await openWindow(app);
  const palette = app.getByRole('dialog', { name: 'Command palette' });
  const stuck: number[] = [];
  for (let i = 0; i < 40; i++) {
    await app.keyboard.press('Meta+KeyK');
    await expect(palette).toBeVisible();
    await app.keyboard.press('Escape');
    if (!(await palette.count().then((n) => n === 0)) && !(await palette.waitFor({ state: 'detached', timeout: 1000 }).then(() => true, () => false))) {
      stuck.push(i);
      await app.keyboard.press('Escape');
      await expect(palette).toHaveCount(0);
    }
  }
  expect(stuck, 'presses after which Esc left the palette open').toEqual([]);
});
