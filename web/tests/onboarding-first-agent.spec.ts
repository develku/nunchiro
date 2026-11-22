// Ticket 472 (470 review notes 1-3): onboarding's "Start a session" lists the found agent first, so Enter starts an agent
// session; "Added X" names the project added in this step, not the list's first; the agents line says it is checking
// until the first check came back. Shots: SHOTS_TAG (default `after`) and SHOTS_DIR, so the same spec shoots base main.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

/** The core's check of "Your own" waits on `auth status`: this one answers (no verdict) only after 4 s. */
const SLOW_CHECK = `#!/bin/sh
case "$1 $2" in "--version ") echo '2.1.311 (Claude Code)'; exit 0;; "auth status") sleep 4; exit 2;; esac
printf 'fake agent ready\\r\\n'
exec /bin/cat
`;
const SHOTS = process.env.SHOTS_DIR ?? '../.scratch/shots';
const TAG = process.env.SHOTS_TAG ?? 'after';
const folderPanel = (app: Page, answer: string) =>
  app.addInitScript((a) => {
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = { invoke: async (cmd: string) => (cmd === 'plugin:dialog|open' ? a : null) };
  }, answer);
const step = (app: Page, id: string) => app.locator(`.ob-step[data-step="${id}"]`);
const panel = (app: Page) => app.locator('.ob-panel');
const popover = (app: Page) => app.getByRole('dialog', { name: 'New tab' });
type Snap = { sessions: { project: string; state: string; kind: string }[] };

/** Onboarding's project step: Add project, Browse folder (answered with `picked`), leave the popover the add opens. */
async function addThroughOnboarding(app: Page) {
  await expect(app.getByRole('dialog', { name: 'Settings' })).toBeVisible();
  await expect(panel(app)).toBeVisible();
  await step(app, 'project').click();
  await panel(app).getByRole('button', { name: 'Add project' }).click();
  await app.getByRole('dialog', { name: 'Add project', exact: true }).getByRole('button', { name: /^Browse folder/ }).press('Enter');
  await expect(popover(app)).toBeVisible();
  await app.keyboard.press('Escape');
  await app.keyboard.press('Meta+Comma');
  await step(app, 'project').click();
}

for (const scheme of ['dark', 'light'] as const) {
  test.describe(scheme, () => {
    test.use({ firstRun: true, colorScheme: scheme });
    const shot = (app: Page, name: string) => app.screenshot({ path: path.join(SHOTS, `${TAG}-472-${name}-${scheme}-${test.info().project.name}.png`) });

    test(`onboarding_start_session_enter_starts_the_agent (${scheme}): the found agent is the first row, Enter starts it`, async ({ app, core }) => {
      const picked = core.project('picked');
      await folderPanel(app, picked);
      await app.goto('/');
      await addThroughOnboarding(app);
      // Ticket 991 (A8): the button names the found agent and starts it, with no New tab pick in between.
      await panel(app).getByRole('button', { name: 'Start Claude' }).click();
      await expect
        .poll(() => (core.cli('snapshot', '--json') as Snap).sessions.map((s) => [path.basename(s.project), s.kind, s.state]))
        .toContainEqual(['picked', 'claude', 'running']);
    });

    test(`onboarding_added_names_the_new_project (${scheme}): with an older project first in the list, the line names the one just added`, async ({ app, core }) => {
      core.shell(core.project('older'), 'old');
      const picked = core.project('picked');
      await folderPanel(app, picked);
      await app.goto('/');
      // An existing user's window opens no onboarding by itself: they go back to it from Settings.
      await app.getByRole('navigation', { name: 'Left bar' }).getByRole('button', { name: 'Settings' }).click();
      await app.getByRole('navigation', { name: 'Settings pages' }).locator('button[data-page="onboarding"]').click();
      await addThroughOnboarding(app);
      await expect(panel(app).getByRole('status')).toHaveText(/^Added /);
      await shot(app, '2-added');
      await expect(panel(app).getByRole('status')).toHaveText('Added picked. Start your first agent session in it.');
      await panel(app).getByRole('button', { name: 'Start Claude' }).click();
      await expect
        .poll(() => (core.cli('snapshot', '--json') as Snap).sessions.filter((s) => s.kind === 'claude').map((s) => path.basename(s.project)))
        .toEqual(['picked']);
    });

    test(`onboarding_agents_line_checking (${scheme}): before the first check came back the line says it is checking`, async ({ app, core }) => {
      fs.writeFileSync(path.join(core.home, 'bin/claude'), SLOW_CHECK, { mode: 0o700 });
      await app.goto('/');
      await step(app, 'providers').click();
      const claude = panel(app).locator('[data-row="claude"]');
      await expect(claude).toContainText('Checking…', { timeout: 15_000 });
      await shot(app, '3-checking');
      await expect(panel(app).getByRole('status')).toHaveText('Found Claude. Checking its sign-in…');
      await expect(claude).toContainText("Could not check", { timeout: 20_000 });
      await expect(panel(app).getByRole('status')).toHaveText('Found Claude. Nunchiro could not check its sign-in. Start a session to see if it works. If it asks you to sign in, press Sign in.');
    });
  });
}
