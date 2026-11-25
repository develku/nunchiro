// G2 (owner 11-08), ticket 1082: the update item of a build that updates itself. The app shell is a recording
// `__TAURI_INTERNALS__`; `rcUpdates` is what the shell puts in the boot object only for such a build, so without it (the
// isolated test build, a dev build) nothing may be called or shown.
import type { Page } from '@playwright/test';
import { expect, openWindow, test } from './fixtures';

type W = { __calls: string[]; __cb: Record<number, (e: unknown) => void>; __on: Record<string, number>; __check: unknown; __TAURI_INTERNALS__: unknown };

const shell = (app: Page, check: unknown) =>
  app.addInitScript((check) => {
    const w = window as unknown as W;
    w.__calls = [];
    w.__cb = {};
    w.__on = {};
    w.__check = check;
    let n = 0;
    w.__TAURI_INTERNALS__ = {
      invoke: (cmd: string, args: Record<string, unknown>) => {
        w.__calls.push(cmd);
        if (cmd === 'plugin:event|listen') {
          w.__on[args.event as string] = args.handler as number;
          return Promise.resolve(1);
        }
        if (cmd === 'rc_update_check') return w.__check === 'fails' ? Promise.reject('offline') : Promise.resolve(w.__check);
        if (cmd === 'rc_update_install') return Promise.reject('install failed');
        return Promise.resolve(null);
      },
      transformCallback: (cb: (e: unknown) => void) => ((w.__cb[++n] = cb), n),
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main', windowLabel: 'main' } },
    };
  }, check);

const RC = { rcUpdates: true };
const calls = (app: Page) => app.evaluate(() => (window as unknown as W).__calls);
const checks = async (app: Page) => (await calls(app)).filter((c) => c === 'rc_update_check').length;
const item = (app: Page) => app.locator('footer.status .rcupdate');
/** Opens the palette and types the command's name; the dialog then lists it or does not. */
const searchPalette = async (app: Page) => {
  await app.getByRole('button', { name: 'Open command palette' }).click();
  const dialog = app.getByRole('dialog', { name: 'Command palette' });
  await dialog.getByRole('combobox', { name: 'Command palette search' }).fill('Check for updates');
  return dialog;
};

test('rc_update_owner_build_calls_and_shows_nothing', async ({ app }) => {
  await shell(app, '0.1.0-rc.2');
  await openWindow(app);
  await expect(item(app)).toHaveCount(0);
  await expect(await searchPalette(app)).not.toContainText('Check for updates');
  expect((await calls(app)).filter((c) => c.startsWith('rc_update'))).toEqual([]);
});

test('rc_update_palette_command_checks_and_says_when_nothing_is_newer', async ({ app }) => {
  await shell(app, null);
  await openWindow(app, RC);
  await expect.poll(() => checks(app)).toBe(1);
  const dialog = await searchPalette(app);
  await dialog.getByText('Check for updates').click();
  await expect.poll(() => checks(app)).toBe(2);
  await expect(app.getByText('No newer build')).toBeVisible();
});

test('rc_update_item_appears_for_a_verified_build_and_one_click_installs', async ({ app }) => {
  await shell(app, null);
  await openWindow(app, RC);
  await expect.poll(() => checks(app)).toBe(1);
  await expect(item(app)).toHaveCount(0); // nothing newer: nothing shown
  await app.evaluate(() => {
    const w = window as unknown as W;
    w.__cb[w.__on['rc-update']]({ event: 'rc-update', id: 1, payload: '0.1.0-rc.2' });
  });
  await expect(item(app)).toHaveText('New build 0.1.0-rc.2 ready · Install and restart');
  await expect(item(app)).toHaveAttribute('data-version', '0.1.0-rc.2');
  await item(app).click();
  await expect.poll(() => calls(app)).toContain('rc_update_install');
  // Ticket 377 item 3: the failed install relabels the same button as a retry, keeps the raw error in its tip and says so.
  await expect(item(app)).toHaveText('Install failed · Retry');
  await expect(item(app)).toHaveAttribute('data-tip', 'install failed');
  // Ticket 1031: "Connected" is a second screen-reader status in the bar, so the update's own one is named.
  await expect(app.locator('footer.status .rclater + .sr[role="status"]')).toHaveText('Install failed · Retry');
  await item(app).click();
  await expect.poll(async () => (await calls(app)).filter((c) => c === 'rc_update_install').length).toBe(2);
});

test('rc_update_item_says_sessions_keep_running', async ({ app }) => {
  await shell(app, '0.1.0-rc.3');
  await openWindow(app, RC);
  await expect(item(app)).toHaveAttribute('data-tip', 'Restarts the app. Running sessions keep going.');
});

test('rc_update_later_hides_the_item_until_a_newer_build', async ({ app }) => {
  await shell(app, '0.1.0-rc.3');
  await openWindow(app, RC);
  await app.locator('footer.status .rclater').click();
  await expect(item(app)).toHaveCount(0);
  await app.reload();
  await expect.poll(() => checks(app)).toBe(1);
  await expect(item(app)).toHaveCount(0); // the same build stays hidden after reopening
  await app.evaluate(() => {
    const w = window as unknown as W;
    w.__cb[w.__on['rc-update']]({ event: 'rc-update', id: 1, payload: '0.1.0-rc.4' });
  });
  await expect(item(app)).toHaveAttribute('data-version', '0.1.0-rc.4');
});

test('rc_update_a_check_the_user_started_shows_a_version_later_hid', async ({ app }) => {
  await shell(app, '0.1.0-rc.3');
  await openWindow(app, RC);
  await app.locator('footer.status .rclater').click();
  await expect(item(app)).toHaveCount(0);
  const dialog = await searchPalette(app);
  await dialog.getByText('Check for updates').click();
  await expect(item(app)).toHaveAttribute('data-version', '0.1.0-rc.3');
});

test('rc_update_a_check_the_user_started_says_it_failed', async ({ app }) => {
  await shell(app, 'fails');
  await openWindow(app, RC);
  await expect.poll(() => checks(app)).toBe(1);
  const dialog = await searchPalette(app);
  await dialog.getByText('Check for updates').click();
  // Ticket 476: the shell's words are the note's tooltip.
  await expect(app.locator('.pane-status .pane-note')).toHaveText('Update check failed: That did not work. Click this note to copy the details.');
  await expect(app.locator('.pane-status .pane-note')).toHaveAttribute('data-tip', 'offline');
});

test('rc_update_a_build_already_verified_shows_when_the_window_opens', async ({ app }) => {
  await shell(app, '0.1.0-rc.3');
  await openWindow(app, RC);
  await expect(item(app)).toHaveAttribute('data-version', '0.1.0-rc.3');
});

test('rc_update_a_failed_check_stays_silent', async ({ app }) => {
  await shell(app, 'fails');
  await openWindow(app, RC);
  await expect.poll(() => checks(app)).toBe(1);
  await expect(item(app)).toHaveCount(0);
  await expect(app.getByRole('alert')).toHaveCount(0);
});
