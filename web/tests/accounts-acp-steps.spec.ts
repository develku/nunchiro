// The add tiles of Settings > Accounts open four steps for a listed agent (mockup docs/design/agent-kinds-m7/index.html,
// section 3): Install, Approve, Sign in, Test, with the list's cost line. Against a real core; fake binaries on its PATH.
import fs from 'node:fs';
import path from 'node:path';
import { AGENT_PY, ownerOk } from './acp-fakes';
import { REPO, expect, openWindow, test, type Core } from './fixtures';
import { openSettings } from './settings-modal';

async function tiles(app: Parameters<typeof openWindow>[0]) {
  await openWindow(app);
  await openSettings(app);
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Providers' }).click();
  return app.locator('#s-accounts');
}
/** A fake `copilot` on the core's PATH: answers --version, else is the fake ACP agent. */
function fakeCopilot(core: Core) {
  const cmd = path.join(core.home, 'bin', 'copilot');
  fs.writeFileSync(cmd, `#!/bin/sh\n[ "$1" = --version ] && { echo 'GitHub Copilot CLI 1.0.83'; exit 0; }\nexec /usr/bin/python3 ${AGENT_PY} ${path.join(core.home, 'copilot.log')}\n`, { mode: 0o700 });
  return cmd;
}

test('acp_steps: the Copilot tile opens four steps with its cost line', async ({ app }) => {
  const page = await tiles(app);
  const tile = page.locator('[data-tile="copilot"]');
  await expect(tile).toContainText('Free plan works');
  await tile.click();
  const steps = page.locator('[data-field="acp-steps"]');
  for (const step of ['Install', 'Approve', 'Sign in', 'Test']) await expect(steps).toContainText(step);
  await expect(steps).toContainText('Copilot Free includes the CLI');
  await expect(steps).toContainText('npm install -g @github/copilot');
  await expect(steps.getByRole('button', { name: 'Open in a terminal tab' })).toBeVisible();
});

test('acp_steps: installed, Approve is one click and stores the entry the form would', async ({ app, core }) => {
  const cmd = fakeCopilot(core);
  const page = await tiles(app);
  await page.locator('[data-tile="copilot"]').click();
  const steps = page.locator('[data-field="acp-steps"]');
  await expect(steps).toContainText(cmd);
  await expect(steps).toContainText('1.0.83');
  await steps.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(page.locator('.acct-agent[data-agent="copilot"]')).toBeVisible();
  const view = ownerOk(core, { op: 'acp_agent_status', name: 'copilot' }).view;
  expect(view.state).toBe('approved');
  expect(view.entry).toMatchObject({ name: 'copilot', command: cmd, args: ['--acp'], env: [] });
});

test('acp_steps: Open in a terminal tab types the command and runs nothing', async ({ app, core }) => {
  const page = await tiles(app);
  await page.locator('[data-tile="copilot"]').click();
  await page.locator('[data-field="acp-steps"]').getByRole('button', { name: 'Open in a terminal tab' }).click();
  await expect.poll(() => ownerOk(core, { op: 'snapshot' }).sessions.filter((s: { kind: string }) => s.kind === 'shell').length).toBe(1);
  await expect(page.locator('[data-field="acp-steps"]')).toContainText('Not found yet');
  // Nothing ran: no npm was reached (the fake PATH has none, so a run would print "command not found").
  await app.waitForTimeout(1000);
  const shell = ownerOk(core, { op: 'snapshot' }).sessions.find((s: { kind: string }) => s.kind === 'shell');
  const screen = () => JSON.stringify(ownerOk(core, { op: 'agent_read', id: shell.id, source: 'screen', lines: 20 }));
  await expect.poll(screen).toContain('npm install -g @github/copilot');
  // Typed once, after the prompt: not echoed a second time.
  expect(screen().split('npm install -g @github/copilot').length - 1).toBe(1);
  expect(screen()).not.toContain('not found');
});

// Pictures on request: PW_OPT_IN=shots ... --project shots -g acp_steps_shots (tiles with cost words, the steps before and
// after install; light and dark).
test('acp_steps_shots @shots: tiles with cost words and the four steps', async ({ app, core }) => {
  const shots = path.join(REPO, '.scratch/shots');
  fs.mkdirSync(shots, { recursive: true });
  const page = await tiles(app);
  await page.locator('[data-tile="copilot"]').click();
  const grid = page.locator('.prv-pick').first();
  for (const scheme of ['light', 'dark'] as const) {
    await app.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await grid.screenshot({ path: path.join(shots, `acp-steps-tiles-${scheme}.png`) });
    await page.locator('[data-field="acp-steps"]').screenshot({ path: path.join(shots, `acp-steps-install-${scheme}.png`) });
  }
  fakeCopilot(core);
  await app.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.locator('[data-field="acp-steps"]')).toContainText('1.0.83');
  for (const scheme of ['light', 'dark'] as const) {
    await app.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.locator('[data-field="acp-steps"]').screenshot({ path: path.join(shots, `acp-steps-approve-${scheme}.png`) });
  }
});
