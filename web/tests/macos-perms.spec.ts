// Ticket 252 (needs 197, G20): Settings > Permissions shows the macOS permissions Nunchiro uses, read-only. The app's
// `permission_status` command is faked here; the page only reads it and opens System Settings, never asks for a grant.
import type { Page } from '@playwright/test';
import { expect, openWindow, test } from './fixtures';

type Status = { full_disk: boolean | null; volumes: 'not_needed' | 'granted' | 'not_granted' | 'unknown' };
type Call = [string, Record<string, unknown> | undefined];
type W = { __calls: Call[]; __replies: Status[]; __TAURI_INTERNALS__: unknown };

const PANES = {
  fullDisk: 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles',
  volumes: 'x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders',
  network: 'x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_LocalNetwork',
};

/** The app shell: `permission_status` answers each reply in turn (the last one repeats); every call is recorded. */
async function fakeApp(app: Page, replies: Status[]) {
  await app.addInitScript((replies) => {
    const w = window as unknown as W;
    w.__calls = [];
    w.__replies = replies;
    w.__TAURI_INTERNALS__ = {
      invoke: (cmd: string, args?: Record<string, unknown>) => {
        w.__calls.push([cmd, args]);
        if (cmd === 'permission_status') return Promise.resolve(w.__replies.length > 1 ? w.__replies.shift() : w.__replies[0]);
        return Promise.resolve(null);
      },
      transformCallback: () => 0,
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main', windowLabel: 'main' } },
    };
  }, replies);
}
const calls = (app: Page) => app.evaluate(() => (window as unknown as W).__calls);
const nav = (app: Page) => app.getByRole('navigation', { name: 'Settings pages' });
const row = (app: Page, id: string) => app.locator(`[data-row="${id}"]`);

async function openPermissions(app: Page) {
  await app.getByRole('navigation', { name: 'Left bar' }).getByRole('button', { name: 'Settings' }).click(); // click 1
  await nav(app).locator('[data-group="privacy"] button[data-page="permissions"]').click(); // click 2
  await expect(app.locator('.settings header.phd h1')).toHaveText('Permissions');
}

test('permissions_page_in_privacy_group_within_two_clicks', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await fakeApp(app, [{ full_disk: true, volumes: 'granted' }]);
  await openWindow(app);
  await openPermissions(app);
  // The last page of the 개인정보 · 권한 group, after its built-in pages.
  expect(await nav(app).locator('[data-group="privacy"] button[data-page]').evaluateAll((els) => els.map((e) => e.getAttribute('data-page')))).toEqual(['browser', 'libraries', 'history', 'permissions']);
  await expect(row(app, 'perm.fullDisk')).toBeVisible();
  await expect(row(app, 'perm.volumes')).toBeVisible();
  await expect(row(app, 'perm.network')).toBeVisible();
  // Ticket 1043 (look v35 c S3-3): the 22nd page's summary line, the two states macOS reports.
  await expect(app.locator('.settings header.phd .ssum')).toHaveText('Full Disk Access Granted · Removable volumes Granted');
});

test('permissions_rows_show_status_from_probe_and_refresh_rereads', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await fakeApp(app, [
    { full_disk: false, volumes: 'not_needed' },
    { full_disk: true, volumes: 'granted' },
    { full_disk: null, volumes: 'not_granted' },
    { full_disk: true, volumes: 'unknown' },
  ]);
  await openWindow(app);
  await openPermissions(app);
  const chip = (id: string) => row(app, id).locator('.chip');
  await expect(chip('perm.fullDisk')).toHaveText('Not granted');
  await expect(chip('perm.volumes')).toHaveText('Not needed'); // the home is not on an external volume
  await expect(chip('perm.network')).toHaveText('Unknown'); // macOS does not report it
  await app.locator('.settings header.phd').getByRole('button', { name: 'Refresh' }).click();
  await expect(chip('perm.fullDisk')).toHaveText('Granted');
  await expect(chip('perm.volumes')).toHaveText('Granted');
  await app.locator('.settings header.phd').getByRole('button', { name: 'Refresh' }).click();
  await expect(chip('perm.fullDisk')).toHaveText('Unknown');
  await expect(chip('perm.volumes')).toHaveText('Not granted');
  // The volume probe failed (not a refusal): unknown, not "not needed".
  await app.locator('.settings header.phd').getByRole('button', { name: 'Refresh' }).click();
  await expect(chip('perm.fullDisk')).toHaveText('Granted');
  await expect(chip('perm.volumes')).toHaveText('Unknown');
  expect((await calls(app)).filter(([c]) => c === 'permission_status')).toHaveLength(4);
});

test('permissions_open_settings_opens_privacy_pane_url_only', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await fakeApp(app, [{ full_disk: false, volumes: 'not_granted' }]);
  await openWindow(app);
  await openPermissions(app);
  for (const id of ['fullDisk', 'volumes', 'network'] as const) await row(app, `perm.${id}`).getByRole('button', { name: 'Open System Settings' }).click();
  await expect.poll(async () => (await calls(app)).filter(([c]) => c === 'plugin:opener|open_url').map(([, a]) => a?.url)).toEqual([PANES.fullDisk, PANES.volumes, PANES.network]);
  // Status display only: the page reads `permission_status` and opens URLs; nothing asks macOS for a grant.
  const used = new Set((await calls(app)).map(([c]) => c));
  expect([...used].filter((c) => /permission|request|grant|prompt|access/i.test(c))).toEqual(['permission_status']);
});

test('permissions_full_disk_row_says_it_reaches_agents', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await fakeApp(app, [{ full_disk: true, volumes: 'not_needed' }]);
  await openWindow(app);
  await openPermissions(app);
  await expect(row(app, 'perm.fullDisk')).toContainText('also reaches every agent Nunchiro starts');
});

test('permissions_page_only_in_the_app: a plain browser has no app to probe, so no page', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await app.getByRole('navigation', { name: 'Left bar' }).getByRole('button', { name: 'Settings' }).click();
  await expect(nav(app).locator('button[data-page="history"]')).toBeVisible();
  await expect(nav(app).locator('button[data-page="permissions"]')).toHaveCount(0);
});
