// Ticket 1082: the installed app updates itself from the update folder set in Settings > About. The app shell is a
// recording `__TAURI_INTERNALS__`: `update_source` answers the folder (set by its `folder` argument), `rc_update_check` the
// commit of a new build or null; `rcUpdates` in the boot object says this build updates itself.
import type { Page } from '@playwright/test';
import { expect, openWindow, test } from './fixtures';
// Built from parts: no literal personal path in tests (project rule; the publish scan refuses one).
const BUILDS = ['', 'Users', 'me', 'builds'].join('/');

type Call = { cmd: string; args?: Record<string, unknown> };
type W = { __calls: Call[]; __folder: string; __ready: string | null; __TAURI_INTERNALS__: unknown };

const shell = (app: Page, folder: string, ready: string | null) =>
  app.addInitScript(
    ({ folder, ready }) => {
      const w = window as unknown as W;
      w.__calls = [];
      w.__folder = folder;
      w.__ready = ready;
      w.__TAURI_INTERNALS__ = {
        invoke: (cmd: string, args: Record<string, unknown>) => {
          w.__calls.push({ cmd, args });
          if (cmd === 'update_source') {
            if (typeof args?.folder === 'string') w.__folder = args.folder.trim();
            return Promise.resolve(w.__folder);
          }
          if (cmd === 'rc_update_check') return Promise.resolve(w.__ready);
          if (cmd === 'rc_update_install') return Promise.reject('refused: the sha256 of nunchiro does not match the stamp');
          return Promise.resolve(null);
        },
        transformCallback: () => 0,
        metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main', windowLabel: 'main' } },
      };
    },
    { folder, ready },
  );

const SELF = { rcUpdates: true };
const calls = (app: Page) => app.evaluate(() => (window as unknown as W).__calls);
const row = (app: Page) => app.locator('[data-row="updates"]');
const item = (app: Page) => app.locator('footer.status .rcupdate');
async function openAbout(app: Page) {
  await app.getByRole('navigation', { name: 'Left bar' }).getByRole('button', { name: 'Settings' }).click();
  await app.locator('.settings > nav button[data-page="about"]').click();
}

test('self_update_about_shows_a_new_build_and_install_and_restart', async ({ app }) => {
  await shell(app, BUILDS, 'abc123def');
  await openWindow(app, SELF);
  await openAbout(app);
  await expect(row(app).locator('.sds').first()).toHaveText('New build abc123def ready');
  await expect(row(app).getByRole('textbox', { name: 'Update folder' })).toHaveValue(BUILDS);
  await row(app).getByRole('button', { name: 'Install and restart' }).click();
  await expect.poll(async () => (await calls(app)).map((c) => c.cmd)).toContain('rc_update_install');
  // A refused install says why in plain words and keeps the raw reason.
  await expect(row(app)).toContainText('Install failed:');
});

test('self_update_about_without_a_folder_is_off', async ({ app }) => {
  await shell(app, '', null);
  await openWindow(app, SELF);
  await openAbout(app);
  await expect(row(app).locator('.sds').first()).toHaveText('Off: no update folder is set.');
  // Setting the folder sends it to the shell and checks at once.
  const field = row(app).getByRole('textbox', { name: 'Update folder' });
  await field.fill(BUILDS);
  await field.press('Enter');
  await expect.poll(async () => (await calls(app)).find((c) => c.cmd === 'update_source' && c.args?.folder)?.args?.folder).toBe(BUILDS);
  await expect(row(app).locator('.sds').first()).toHaveText('No newer build');
});

test('self_update_status_bar_item_shows_only_when_a_build_is_ready', async ({ app }) => {
  await shell(app, BUILDS, null);
  await openWindow(app, SELF);
  await expect.poll(async () => (await calls(app)).filter((c) => c.cmd === 'rc_update_check').length).toBeGreaterThan(0);
  await expect(item(app)).toHaveCount(0);
  // a later check finds one: the next window shows it at once
  await app.addInitScript(() => void ((window as unknown as W).__ready = 'abc123def'));
  await app.reload();
  await expect(item(app)).toHaveText('New build abc123def ready · Install and restart');
});

test('self_update_isolated_test_build_shows_no_folder_and_no_item', async ({ app }) => {
  await shell(app, BUILDS, 'abc123def');
  await openWindow(app);
  await expect(item(app)).toHaveCount(0);
  await openAbout(app);
  await expect(row(app).getByRole('textbox', { name: 'Update folder' })).toHaveCount(0);
  await expect(row(app).getByRole('button', { name: 'Check now' })).toBeDisabled();
  expect((await calls(app)).filter((c) => c.cmd === 'update_source' || c.cmd.startsWith('rc_update'))).toEqual([]);
});
