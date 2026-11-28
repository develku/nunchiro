// v25f-project-add (F15): "+ Project" on a folder the core cannot read says so in the window; it never does nothing.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, openWindow, test } from './fixtures';
import { startOf } from './start-op';

/** A native folder picker that answers `folder`; every other app call answers null. */
const picker = (page: Page, folder: string) =>
  page.addInitScript((f) => {
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
      invoke: (cmd: string) => Promise.resolve(cmd === 'plugin:dialog|open' ? f : null),
      transformCallback: () => 1,
      metadata: {},
    };
  }, folder);

const pop = (app: Page) => app.getByRole('dialog', { name: 'New tab' });

async function addExisting(app: Page) {
  await app.getByRole('button', { name: '+ Project' }).click();
  await app.getByRole('dialog', { name: 'Add project' }).getByRole('button', { name: /^Browse folder/ }).click();
}

test('project_add_unreadable_folder_says_so: a folder whose mode refuses is said by name, without the System Settings steps', async ({ app, core }) => {
  const locked = core.project('locked');
  fs.chmodSync(locked, 0);
  try {
    await picker(app, locked);
    await openWindow(app);
    await addExisting(app);
    // Walk 11: the refusal comes right after the pick, and the popover does not keep the refused folder.
    // The refusal is said in the popover, by name. chmod is EACCES: the folder's mode, which System Settings cannot fix.
    const alert = pop(app).getByRole('alert');
    await expect(alert).toContainText('locked');
    await expect(alert).toContainText('no permission to read');
    await expect(alert.getByRole('button')).toHaveCount(0);
    expect(core.cli('snapshot', '--json').sessions).toHaveLength(0);
  } finally {
    fs.chmodSync(locked, 0o700);
  }
});

test('project_add_normal_folder_starts: a readable folder picked through "+ Project" starts the agent there', async ({ app, core }) => {
  const ok = core.project('fine');
  await picker(app, ok);
  await openWindow(app);
  await addExisting(app);
  await expect(pop(app).locator('.nt-in')).toHaveAttribute('title', ok);
  await pop(app).getByRole('option', { name: /^Claude/ }).click();
  await expect(pop(app)).toHaveCount(0);
  await expect.poll(() => (core.cli('snapshot', '--json').sessions).map((s: { project: string }) => path.basename(s.project))).toEqual(['fine']);
});

// F15 r2: macOS privacy (EPERM, or no answer) is the case System Settings fixes: its two panes are offered.
test('project_add_privacy_refusal_offers_settings: an EPERM refusal shows the Files and Folders and Full Disk Access buttons', async ({ app, core }) => {
  const ok = core.project('vol');
  await picker(app, ok);
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((msg) => {
      const r = typeof msg === 'string' ? JSON.parse(msg) : null;
      if (startOf(r?.request)) return ws.send(JSON.stringify({ id: r.id, response: { Err: `file_access: cannot read ${ok}: Operation not permitted (os error 1)` } }));
      server.send(msg);
    });
    server.onMessage((msg) => ws.send(msg));
  });
  await openWindow(app);
  await addExisting(app);
  await pop(app).getByRole('option', { name: /^Claude/ }).click();
  const alert = pop(app).getByRole('alert');
  await expect(alert).toContainText('cannot read');
  await expect(alert.getByRole('button', { name: 'Open Settings' })).toBeVisible();
  await expect(alert.getByRole('button', { name: 'Open Full Disk Access' })).toBeVisible();
});

// Ticket 601: a file_access reason in a shape the window does not know shows a plain sentence, not the core's English; the
// core's own words stay under Details.
test('project_add_unknown_file_access_reason_is_plain: an unmatched file_access reason says what happened and keeps the core text under Details', async ({ app, core }) => {
  const ok = core.project('odd');
  await picker(app, ok);
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((msg) => {
      const r = typeof msg === 'string' ? JSON.parse(msg) : null;
      if (startOf(r?.request)) return ws.send(JSON.stringify({ id: r.id, response: { Err: 'file_access: the disk answered in an odd way' } }));
      server.send(msg);
    });
    server.onMessage((msg) => ws.send(msg));
  });
  await openWindow(app);
  await addExisting(app);
  await pop(app).getByRole('option', { name: /^Claude/ }).click();
  const alert = pop(app).getByRole('alert');
  await expect(alert).toContainText('Not started: the folder could not be opened');
  await expect(alert.locator('details.err-details')).not.toHaveAttribute('open');
  await expect(alert.locator('details.err-details')).toContainText('the disk answered in an odd way');
  expect(await alert.locator('p').first().innerText()).not.toContain('the disk answered');
});

// F15 r2: the owner's case. A folder picked and the popover closed before any agent: the project is in the tree, with no
// session, and its own remove takes it out again.
test('project_add_pick_then_close_keeps_the_project: the picked folder is a tree project with no session', async ({ app, core }) => {
  const picked = core.project('picked');
  await picker(app, picked);
  await openWindow(app);
  await addExisting(app);
  await expect(pop(app).locator('.nt-in')).toHaveAttribute('title', picked);
  await app.keyboard.press('Escape');
  await expect(pop(app)).toHaveCount(0);
  const head = app.locator(`.row.head[data-project-path="${picked}"]`);
  await expect(head).toBeVisible();
  expect(core.cli('snapshot', '--json').sessions).toHaveLength(0);
  // Reload: the core holds it, not the window.
  await app.reload();
  await expect(head).toBeVisible();
  await head.hover();
  await head.getByRole('button', { name: 'Remove picked from the tree' }).click();
  await expect(head).toHaveCount(0);
});
