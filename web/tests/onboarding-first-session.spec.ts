// Ticket 470 (scorecard F1): a fresh home goes from the first window to a running session without help. Each onboarding
// step says what it did; "Could not check" and "not signed in" offer the existing sign-in; the project step starts the first
// session through New session's own event. The fixture's fake Claude answers `auth status` with no verdict ("Could not check").
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

const NOT_SIGNED_IN = `#!/bin/sh
case "$1 $2" in "--version ") echo '2.1.311 (Claude Code)'; exit 0;; "auth status") echo '{"loggedIn": false}'; exit 1;; esac
printf 'fake agent ready\\r\\n'
exec /bin/cat
`;
/** The native folder panel is the only stand-in: it answers `answer`. */
const folderPanel = (app: Page, answer: string) =>
  app.addInitScript((a) => {
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = { invoke: async (cmd: string) => (cmd === 'plugin:dialog|open' ? a : null) };
  }, answer);
const step = (app: Page, id: string) => app.locator(`.ob-step[data-step="${id}"]`);
const panel = (app: Page) => app.locator('.ob-panel');
const popover = (app: Page) => app.getByRole('dialog', { name: 'New tab' });
const shot = (app: Page, name: string) => app.screenshot({ path: `../.scratch/shots/after-${name}-${test.info().project.name}.png` });

test.use({ firstRun: true, colorScheme: 'dark' });

test('onboarding_ends_in_a_running_session: every step says what it did, the project step starts the first session', async ({ app, core }) => {
  const picked = core.project('picked');
  await folderPanel(app, picked);
  await app.goto('/');
  await expect(app.getByRole('dialog', { name: 'Settings' })).toBeVisible();
  await shot(app, '1-open');

  // Providers: the found agent is named, with what is unknown about it and the sign-in next to Check.
  await step(app, 'providers').click();
  const claude = panel(app).locator('[data-row="claude"]');
  await expect(claude).toContainText("Could not check", { timeout: 15_000 });
  await expect(claude.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await expect(panel(app).getByRole('status')).toHaveText('Found Claude. Nunchiro could not check its sign-in. Start a session to see if it works. If it asks you to sign in, press Sign in.');
  await shot(app, '2-providers');

  // Import: the look says what it found.
  const imp = app.locator('[data-step="import"]');
  await imp.getByRole('button', { name: 'Look for conversations' }).click();
  await expect(imp).toContainText('No conversations found in ~/.claude or ~/.codex.');
  await imp.scrollIntoViewIfNeeded();
  await shot(app, '3-import');

  // Project, before: Add project is the one action.
  await step(app, 'project').click();
  await expect(panel(app).getByRole('button', { name: 'Start Claude' })).toHaveCount(0);
  await shot(app, '4-project');
  await panel(app).getByRole('button', { name: 'Add project' }).click();
  await app.getByRole('dialog', { name: 'Add project', exact: true }).getByRole('button', { name: /^Browse folder/ }).press('Enter');
  await expect(popover(app)).toBeVisible();
  await app.keyboard.press('Escape'); // the user leaves the popover: onboarding still leads to the session

  // Project, after: the step names the project and starts the session there.
  await app.keyboard.press('Meta+Comma');
  await step(app, 'project').click();
  await expect(panel(app).getByRole('status')).toHaveText('Added picked. Start your first agent session in it.');
  await shot(app, '5-project-added');
  await panel(app).getByRole('button', { name: 'Start Claude' }).click();
  await expect(app.getByRole('dialog', { name: 'Settings' })).toHaveCount(0);
  // Ticket 991 (A8): the found agent starts at once; no New tab pick in between.

  await expect
    .poll(() => (core.cli('snapshot', '--json').sessions as { project: string; state: string; kind: string }[]).map((s) => [path.basename(s.project), s.state]))
    .toContainEqual(['picked', 'running']);
  await expect(app.locator('.tab[data-tab]:not([data-tab="settings"])')).toHaveCount(1);
  await shot(app, '7-running');

  // Ticket 582, look 1117 v14 O3: the last step. This fake agent never answers; starting it is the step, so it is done already.
  await app.keyboard.press('Meta+Comma');
  await step(app, 'session').click();
  await expect(step(app, 'session')).toHaveAttribute('data-done', 'true');
  await expect(panel(app).getByRole('status')).toHaveText('Started Claude in picked.');
});

test('onboarding_not_signed_in_offers_sign_in: the step says so and Sign in runs the agent login from here (ticket 991)', async ({ app, core }) => {
  fs.writeFileSync(path.join(core.home, 'bin/claude'), NOT_SIGNED_IN, { mode: 0o700 });
  await app.goto('/');
  await step(app, 'providers').click();
  const claude = panel(app).locator('[data-row="claude"]');
  await expect(claude).toContainText('Needs sign-in', { timeout: 15_000 });
  await expect(panel(app).getByRole('status')).toHaveText('Found Claude, not signed in. Press Sign in.');
  await shot(app, '2-providers-not-signed-in');
  await claude.getByRole('button', { name: 'Sign in' }).click();
  await expect.poll(() => (core.cli('snapshot', '--json').sessions as { label: string; state: string }[]).some((s) => s.label === 'Login: Default' && s.state === 'running'), { timeout: 15_000 }).toBe(true);
});
