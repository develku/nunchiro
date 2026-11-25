// V2-CF5 (needs 124; ticket 127): "Keep this Mac awake while a session is working" in Settings > Sessions and
// startup. Off by default, stored by the core, reachable in two clicks and by keyboard, and it never writes to a PTY.
import fs from 'node:fs';
import path from 'node:path';
import { expect, openWindow, test } from './fixtures';
import { openSettings } from './settings-modal';

const LABEL = 'Keep this Mac awake while a session is working';
const HINT = 'The display can still sleep. This ends 2 minutes after the agent’s last reply. A cup icon shows in the menu bar while it is on.';
const settingsFile = (home: string) => JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8'));

/** Two clicks on visible, labelled controls from the session view: the Settings button, then Sessions and startup. */
async function openLifetime(app: import('@playwright/test').Page) {
  await openSettings(app); // one click on the gear, or none when a reload kept the modal open
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'General' }).click();
}

test('keep_awake_default_off: unchecked, off in the core, the hint beside it', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await openLifetime(app);
  const box = app.getByRole('switch', { name: LABEL });
  await expect(box).not.toBeChecked();
  await expect(app.getByText(HINT)).toBeVisible();
  // Default off is the core's answer, not just the widget's: nothing was written.
  expect(settingsFile(core.home).keep_awake).toBeUndefined();
});

test('keep_awake_reachable_within_two_clicks: the labelled control, counted, and by keyboard', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await app.evaluate(() => {
    (window as unknown as { __clicks: number }).__clicks = 0;
    document.addEventListener('click', () => (window as unknown as { __clicks: number }).__clicks++, true);
  });
  await openLifetime(app);
  const box = app.getByRole('switch', { name: LABEL });
  await expect(box).toBeVisible();
  expect(await app.evaluate(() => (window as unknown as { __clicks: number }).__clicks)).toBe(2);

  // Tab focus reaches it from the page's own controls, and Space toggles it.
  await box.focus();
  await expect(box).toBeFocused();
  await app.keyboard.press('Space');
  await expect(box).toBeChecked();
});

test('keep_awake_stored_by_the_core: the toggle is written and survives a restart', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await openLifetime(app);
  const box = app.getByRole('switch', { name: LABEL });
  await box.check();
  await expect.poll(() => settingsFile(core.home).keep_awake).toBe(true);
  // Only the patched key is written.
  expect(settingsFile(core.home).keep_history).toBeUndefined();
  await app.reload();
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  await openLifetime(app);
  await expect(app.getByRole('switch', { name: LABEL })).toBeChecked();
  await app.getByRole('switch', { name: LABEL }).uncheck();
  await expect.poll(() => settingsFile(core.home).keep_awake).toBe(false);
});

// The full sequence (toggling, holding while a session works, releasing) with a recording fake is
// `nothing_auto_sends` in scripts/scenario/keep-awake.sh, where a session's token and a hook are at hand. Here: the
// window's half, a toggle writes no byte to any PTY.
test('nothing_auto_sends (window half): toggling writes no byte to a PTY', async ({ app, core }) => {
  // `cat` echoes every byte its PTY gets, so a stray write would land in `read`.
  const s = core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  const before = core.read(s.id);
  await openLifetime(app);
  const box = app.getByRole('switch', { name: LABEL });
  await box.check();
  await expect.poll(() => settingsFile(core.home).keep_awake).toBe(true);
  await box.uncheck();
  await expect.poll(() => settingsFile(core.home).keep_awake).toBe(false);
  expect(core.read(s.id)).toBe(before);
});
