// Ticket 378 (설정 나머지), four small rows: the branch prefix answers while typing, a missing CLI's chip is grey, and the
// SSH machines list is read again on its own. The agents are fakes in the test's bin, never a real login.
import type { Page } from '@playwright/test';
import { stripOnTop, expect, openWindow, test } from './fixtures';
import { openSettings } from './settings-modal';

test.beforeEach(({ core }) => stripOnTop(core));

async function page(app: Page, name: string) {
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name, exact: true }).click();
  await expect(app.locator('.settings header.phd h1')).toHaveText(name);
}

test('prefix_live: the line under the branch prefix shows the branch, one slash however it is typed, and a refused prefix is not saved', async ({ app }) => {
  await openWindow(app);
  await openSettings(app);
  await page(app, 'Git & worktrees');
  const field = app.getByRole('textbox', { name: 'Branch name prefix for new worktrees' });
  const line = app.locator('[data-field="prefix-example"]');
  await expect(line).toHaveText("A new worktree's branch would be add-search");
  await field.fill('feature');
  await expect(line).toHaveText("A new worktree's branch would be feature/add-search");
  await field.fill('feature/');
  await expect(line).toHaveText("A new worktree's branch would be feature/add-search");
  await field.press('Enter');
  // What was typed is what is stored and shown again.
  await page(app, 'General');
  await page(app, 'Git & worktrees');
  await expect(field).toHaveValue('feature/');
  // A space: refused, said so, and the stored prefix stays.
  await field.fill('a b');
  await expect(line).toHaveRole('alert');
  await expect(line).toContainText('Nothing was saved.');
  await expect(field).toHaveAttribute('aria-invalid', 'true');
  await field.press('Enter');
  await page(app, 'General');
  await page(app, 'Git & worktrees');
  await expect(field).toHaveValue('feature/');
});

test('missing_chip_grey: a CLI that is not installed has a grey chip, not the amber of a problem to fix by signing in', async ({ app }) => {
  await openWindow(app);
  await openSettings(app);
  await page(app, 'Providers');
  const chip = app.locator('#s-accounts [data-row="codex"] .pchip', { hasText: 'Not installed' });
  await expect(chip).toBeVisible();
  await expect(chip).not.toHaveClass(/warn/);
});

test('machines_refresh: the SSH machines list is read again every 10 s while the page is open', async ({ app }) => {
  let reads = 0;
  app.on('websocket', (ws) =>
    ws.on('framesent', (f) => {
      try {
        const r = JSON.parse(String(f.payload)).request;
        if (r?.op === 'machine_details' && !r.alias) reads += 1;
      } catch {
        // not JSON
      }
    }),
  );
  await app.clock.install();
  await openWindow(app);
  await openSettings(app);
  await page(app, 'SSH machines');
  await expect.poll(() => reads).toBeGreaterThanOrEqual(1);
  const before = reads;
  await app.clock.fastForward(10_500);
  await expect.poll(() => reads).toBe(before + 1);
  await app.clock.fastForward(10_500);
  await expect.poll(() => reads).toBe(before + 2);
});

test('machine_one_line: an SSH machine is one line (icon, name, ssh line, chip, chevron); a long version ends in an ellipsis; a click still opens it', async ({ app }) => {
  const long = { state: 'up', since_ms: Date.now(), remote_version: `0.9.4-${'x'.repeat(200)}`, remote_protocol: 2, local_protocol: 2 };
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.request?.op === 'machine_details') ws.send(JSON.stringify({ id: msg.id, response: { Ok: { type: 'machine_details', machines: [{ machine: 'macbook', host: 'macbook.local', user: 'me', port: 22, keys: [], fingerprint: null, channel: long }] } } }));
      else server.send(raw);
    });
    server.onMessage((raw) => ws.send(raw));
  });
  await openWindow(app);
  await openSettings(app);
  await page(app, 'SSH machines');
  const row = app.locator('[data-machine="macbook"] .machine-row');
  await expect(app.locator('.settings header.phd .ssum')).toHaveText('Machines 1 · Connected 1 · Unreachable 0');
  const parts = [row.locator('svg').first(), row.locator('.prv-name'), row.locator('.machine-line'), row.locator('.pchip'), row.locator('.sctl')];
  const mids = await Promise.all(parts.map(async (p) => { const b = (await p.boundingBox())!; return b.y + b.height / 2; }));
  for (const m of mids) expect(Math.abs(m - mids[0])).toBeLessThan(4);
  expect((await row.boundingBox())!.height).toBeLessThan(60);
  await expect(row.locator('.machine-line .machine-mono')).toBeVisible();
  expect(await row.locator('.machine-line').evaluate((e) => e.scrollWidth > e.clientWidth && getComputedStyle(e).textOverflow)).toBe('ellipsis');
  await app.locator('.machines-page').screenshot({ path: `../.scratch/shots/machine-one-line-${test.info().project.name}.png` });
  await row.click();
  await expect(row).toHaveAttribute('aria-expanded', 'true');
  await expect(app.locator('[data-machine="macbook"]').getByRole('button', { name: 'Remove', exact: true })).toBeVisible();
});

test('mcp_add_empty: Add with empty boxes stays pressable, turns the empty box red and says a name and command are needed', async ({ app }) => {
  await openWindow(app);
  await openSettings(app);
  await page(app, 'Skills & hooks');
  const own = app.locator('[data-mcp="own"]');
  const name = own.getByRole('textbox', { name: 'Server name' });
  const command = own.getByRole('textbox', { name: 'Command' });
  const add = own.getByRole('button', { name: 'Add for Nunchiro sessions' });
  const line = own.locator('[data-field="mcp-problem"]');
  await expect(add).toBeEnabled();
  await add.click();
  await expect(line).toHaveText('Type a name and a command to add a server.');
  await expect(name).toHaveAttribute('aria-invalid', 'true');
  await expect(command).toHaveAttribute('aria-invalid', 'true');
  await name.fill('srv');
  await expect(name).toHaveAttribute('aria-invalid', 'false');
  await expect(command).toHaveAttribute('aria-invalid', 'true');
  await command.fill('/bin/echo hi');
  await expect(line).toHaveCount(0);
  await add.click();
  await expect(own).toContainText('srv');
  await expect(name).toHaveValue('');
  await expect(line).toHaveCount(0);
});

test('scope_lines: no page has a scope line; the values of one project are on its page in Settings > Projects (ticket 1040)', async ({ app, core }) => {
  core.shell(core.project('demo'), 'demo-shell');
  await openWindow(app);
  await openSettings(app);
  for (const name of ['Git & worktrees', 'Providers']) {
    await page(app, name);
    await expect(app.locator('.settings .setscope')).toHaveCount(0);
    await expect(app.locator('.settings')).not.toContainText('Applying settings for');
  }
  await page(app, 'Projects');
  await expect(app.locator('.settings .pj-row .pj-name')).toHaveText(['demo']);
});

test('where_it_applies: Providers and Connected services say the accounts are on this Mac; the orchestration card does not talk about the core', async ({ app }) => {
  const line = 'The accounts are on this Mac; an SSH machine uses its own.';
  await openWindow(app);
  await openSettings(app);
  await page(app, 'Providers');
  await expect(app.locator('.settings header.phd')).toContainText('for this Mac here; an SSH machine has its own accounts.'); // plain wording since d4294e012 // two-line lede (accounts-head-414)
  await page(app, 'Git & worktrees');
  await expect(app.locator('#h-providers').locator('..')).toContainText(line);
  // Orchestration now sits in Skills & hooks' Nunchiro defaults card (ticket 391).
  await page(app, 'Skills & hooks');
  await expect(app.getByRole('region', { name: 'Nunchiro defaults' })).toContainText('Orchestration');
  await expect(app.locator('.settings .spage')).not.toContainText(/\bcore\b/i);
});

test('onboarding_worktree_folder: Browse on Onboarding sets the worktree folder Git & Worktrees shows', async ({ app, core }) => {
  const folder = core.project('wt-home');
  await app.addInitScript((a) => {
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = { invoke: async (cmd: string) => (cmd === 'plugin:dialog|open' ? a : null) };
  }, folder);
  await openWindow(app);
  await openSettings(app);
  await app.getByRole('navigation', { name: 'Settings pages' }).locator('button[data-page="onboarding"]').click();
  const section = app.locator('section[data-step="worktrees"]');
  await section.getByRole('button', { name: 'Browse' }).click();
  await expect(section.getByRole('textbox', { name: 'Folder for new worktrees' })).toHaveValue(folder);
  await section.screenshot({ path: `../.scratch/shots/onboarding-worktrees-${test.info().project.name}.png` });
  await page(app, 'Git & worktrees');
  await expect(app.getByRole('textbox', { name: 'Folder for new worktrees' })).toHaveValue(folder);
});
