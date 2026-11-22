// Ticket 991 (품질 조사 1116, lane q-first): the first run's words match what each step does (A8), the found agent signs in
// from the onboarding page (peers item 7), a missing agent is said before a start fails (peers item 18), Quick setup's
// keys line is plain words (A19), and no empty band sits under the page intro (A20).
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test, type Core } from './fixtures';

const NOT_SIGNED_IN = `#!/bin/sh
case "$1 $2" in "--version ") echo '2.1.311 (Claude Code)'; exit 0;; "auth status") echo '{"loggedIn": false}'; exit 1;; esac
printf 'fake agent ready\\r\\n'
exec /bin/cat
`;
const folderPanel = (app: Page, answer: string) =>
  app.addInitScript((a) => {
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = { invoke: async (cmd: string) => (cmd === 'plugin:dialog|open' ? a : null) };
  }, answer);
const step = (app: Page, id: string) => app.locator(`.ob-step[data-step="${id}"]`);
const panel = (app: Page) => app.locator('.ob-panel');
const quick = (app: Page) => app.locator('.ob-quick:not(.ob-preflight)');
type Snap = { project: string; state: string; kind: string; label: string };
const snap = (core: Core) => core.cli('snapshot', '--json').sessions as Snap[];
const running = (core: Core) => snap(core).filter((s) => s.state === 'running').map((s) => [path.basename(s.project), s.kind]);

test.use({ firstRun: true });

test('A20 onboarding_no_blank_band: Quick setup starts right under the page intro', async ({ app }) => {
  await app.goto('/');
  await expect(quick(app)).toBeVisible();
  const gap = await app.evaluate(() => document.querySelector('.ob-quick')!.getBoundingClientRect().top - document.querySelector('.spage > .phd')!.getBoundingClientRect().bottom);
  expect(gap).toBeLessThan(40); // was 58: the section rule's 30 px room for an outside title, over the body's own 28 px
});

test('A8 A19 quick_setup_words_match: names the agent it starts, says what the keys do, and the button starts it in the added project', async ({ app, core }) => {
  await folderPanel(app, core.project('picked'));
  await app.goto('/');
  await expect(quick(app)).toContainText('One button adds your first project and starts Claude in it.', { timeout: 15_000 });
  await expect(quick(app)).toContainText('to put a letter on every button');
  await expect(quick(app)).not.toContainText('hint keys');
  // The agent line names a button, and that button is on this card.
  await expect(quick(app)).toContainText(/[Pp]ress (Sign in|Check)\.|Checking its sign-in/); // look 1117 v6r: "…, press Sign in." when the check gave no answer
  await expect(quick(app).getByRole('button', { name: /^(Sign in|Check)/ })).toBeVisible({ timeout: 20_000 });
  await quick(app).getByRole('button', { name: 'Use recommended settings and add a project' }).click();
  await app.getByRole('dialog', { name: 'Add project', exact: true }).getByRole('button', { name: /^Browse folder/ }).press('Enter');
  // No pick in New tab: the agent starts in the folder just added.
  await expect.poll(() => running(core), { timeout: 15_000 }).toContainEqual(['picked', 'claude']);
  await expect(app.getByRole('dialog', { name: 'New tab' })).toHaveCount(0);
});

test('A8 first_agent_session_step: the last step is about an agent and its button starts the found agent directly', async ({ app, core }) => {
  core.shell(core.project('demo'), 'term');
  await app.goto('/');
  // A window with a session opens no onboarding by itself: back to it from Settings.
  await app.getByRole('navigation', { name: 'Left bar' }).getByRole('button', { name: 'Settings' }).click();
  await app.getByRole('navigation', { name: 'Settings pages' }).locator('button[data-page="onboarding"]').click();
  await step(app, 'session').click();
  await expect(panel(app).locator('h3')).toHaveText('Start your first agent session');
  // A terminal is no agent session: the step stays open and says so.
  await expect(panel(app).getByRole('status')).toHaveText('No agent session has started yet. Start one in demo.');
  await panel(app).getByRole('button', { name: 'Start Claude' }).click();
  await expect.poll(() => running(core), { timeout: 15_000 }).toContainEqual(['demo', 'claude']);
  await expect(app.getByRole('dialog', { name: 'New tab' })).toHaveCount(0);
});

test('peers-7 onboarding_sign_in_in_place: Sign in on the onboarding card runs the agent login, no Providers detour', async ({ app, core }) => {
  fs.writeFileSync(path.join(core.home, 'bin/claude'), NOT_SIGNED_IN, { mode: 0o700 });
  await app.goto('/');
  await expect(quick(app)).toContainText('Found Claude, not signed in. Press Sign in.', { timeout: 15_000 });
  await step(app, 'providers').click();
  const claude = panel(app).locator('[data-row="claude"]');
  await expect(claude).toContainText('Needs sign-in');
  await claude.getByRole('button', { name: 'Sign in' }).click();
  await expect.poll(() => snap(core).some((s) => s.label === 'Login: Default' && s.state === 'running'), { timeout: 15_000 }).toBe(true);
});

test('peers-18 onboarding_preflight_no_agent: with no agent CLI found, the page says so first and offers the installs', async ({ app, core }) => {
  fs.rmSync(path.join(core.home, 'bin/claude'));
  await app.goto('/');
  const pre = app.locator('.ob-preflight');
  await expect(pre).toContainText('Install a coding agent first', { timeout: 15_000 });
  await expect(pre).toContainText('Neither was found on this Mac');
  await expect(pre.getByRole('button', { name: 'Install Claude ↗' })).toBeVisible();
  await expect(pre.getByRole('button', { name: 'Install Codex ↗' })).toBeVisible();
  await expect(quick(app)).toContainText('Install an agent first, and the same button starts it there too.');
});

test('peers-18 onboarding_preflight_git (Q7 point 18): a git that does not answer is said in the same block, agents found or not', async ({ app, core }) => {
  // macOS's /usr/bin/git stub without the Command Line Tools fails `--version` the same way.
  fs.writeFileSync(path.join(core.home, 'bin/git'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  await app.goto('/');
  const pre = app.locator('.ob-preflight');
  await expect(pre.locator('h3')).toHaveText('Install Git first', { timeout: 15_000 });
  await expect(pre).toContainText('xcode-select --install');
  await expect(pre).not.toContainText('Install a coding agent first');
  fs.rmSync(path.join(core.home, 'bin/claude'));
  await app.evaluate(() => window.dispatchEvent(new Event('focus'))); // the page reads again when the window comes back
  await expect(pre.locator('h3')).toHaveText('Install a coding agent first');
  await expect(pre.locator('[data-missing="git"]')).toBeVisible();
});
