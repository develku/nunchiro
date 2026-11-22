// Ticket 211 round 2 (review MUST-1): a Usage row whose default folder links outside the user's home shows the target
// and an "Allow this folder" control; pressing it (by keyboard here) stores the folder through the core's settings
// request and the count appears. Two clicks from the window: Settings, then the Accounts & Usage page.
import fs from 'node:fs';
import path from 'node:path';
import { type Core, expect, openWindow, test } from './fixtures';
import { openSettings } from './settings-modal';

const iso = (hoursAgo: number) => new Date(Date.now() - hoursAgo * 3_600_000).toISOString();

// A codex sessions folder that links outside HOME, one shell so the window has a project.
function seedRefusedLink(core: Core) {
  const target = path.join(core.home, 'volume/Local-Migrations/codex/sessions'); // outside HOME (sentinel-home): "another volume"
  fs.mkdirSync(path.join(target, '2026/10/24'), { recursive: true });
  fs.writeFileSync(
    path.join(target, '2026/10/24/r.jsonl'),
    JSON.stringify({ timestamp: iso(1), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 1500 }, last_token_usage: { input_tokens: 1500, output_tokens: 0 } } } }) + '\n',
  );
  fs.mkdirSync(path.join(core.home, 'codex-home'), { recursive: true });
  fs.symlinkSync(target, path.join(core.home, 'codex-home/sessions'));
  for (const name of ['claude', 'codex']) fs.writeFileSync(path.join(core.home, 'bin', name), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  core.shell(core.project('demo'), 'alpha');
  return target;
}

test('usage_refused_link_offers_allow_and_counts_after_it', async ({ app, core }) => {
  const target = seedRefusedLink(core);

  await openWindow(app);
  await openSettings(app); // click 1: Settings
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Usage' }).click(); // click 2
  const row = app.locator('#s-usage [data-limit="codex:own"]');
  const real = fs.realpathSync(target);
  await expect(row).toContainText("Not counted: this account’s folder is a link to a folder outside your user folder");
  await expect(row.locator(`[data-menu="path"][title="${real}"]`)).toHaveCount(1); // the path is the tooltip; the sentence is not mono since 9d44ad7ba
  await app.locator('#s-usage').getByRole('tab', { name: 'Agent' }).click();
  const card = app.locator('#s-usage .prov[data-agent-name="Codex"]');
  await expect(card).toContainText('No records in this range');

  // The path is a path reference: right-click offers Copy path (Reveal needs the app).
  await row.locator('[data-menu="path"]').click({ button: 'right' });
  await expect(app.getByRole('menu', { name: 'Actions' }).getByRole('menuitem', { name: 'Copy path' })).toBeVisible();
  await app.keyboard.press('Escape');

  // The control: a real button with a keyboard path, named for what it allows.
  const allow = row.getByRole('button', { name: /Allow this folder/ });
  await expect(allow).toBeEnabled();
  await allow.focus();
  await expect(allow).toBeFocused();
  await app.keyboard.press('Enter');
  await expect(row).toContainText(`via link: ${real}`);
  await expect(card).toContainText('1.5k');
  await expect(row.getByRole('button', { name: /Allow this folder/ })).toHaveCount(0);

  // It sticks: the core stored the folder, so a reload still counts.
  await app.reload();
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  await openSettings(app);
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Usage' }).click();
  await expect(app.locator('#s-usage [data-limit="codex:own"]')).toContainText(`via link: ${real}`);
});

// Review SHOULD of ticket 211 round 2: Allow on an idle page asked the core twice (the repeat flag was set with no read running).
test('usage_allow_with_no_read_in_flight_reads_once', async ({ app, core }) => {
  const target = seedRefusedLink(core);
  let asked = 0;
  app.on('websocket', (ws) => ws.on('framesent', (f) => typeof f.payload === 'string' && f.payload.includes('"account_usage"') && asked++));
  await openWindow(app);
  await openSettings(app);
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Usage' }).click();
  const row = app.locator('#s-usage [data-limit="codex:own"]');
  const real = fs.realpathSync(target);
  await expect(row).toContainText("Not counted: this account’s folder is a link to a folder outside your user folder");
  await expect(row.locator(`[data-menu="path"][title="${real}"]`)).toHaveCount(1); // the path is the tooltip; the sentence is not mono since 9d44ad7ba
  asked = 0; // the initial load is not counted

  const allow = row.getByRole('button', { name: /Allow this folder/ });
  await allow.focus();
  await app.keyboard.press('Enter');
  await expect(row).toContainText(`via link: ${real}`);
  await app.waitForTimeout(500); // a wrongly queued second read would be sent by now
  expect(asked).toBe(1);
});
