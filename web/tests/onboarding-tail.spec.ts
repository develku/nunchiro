// Ticket 479 (472 review notes): onboarding names only a project its own Add project added and that is still in the tree;
// a chooser cancelled there does not claim a later add; the agents line says what the card says; the New tab the chooser
// opens after an onboarding add leads with the found agent. Shots: SHOTS_TAG (default `after`) and SHOTS_DIR, so the same
// spec shoots base main.
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

const SHOTS = process.env.SHOTS_DIR ?? '../.scratch/shots';
const TAG = process.env.SHOTS_TAG ?? 'after';
const folderPanel = (app: Page, answer: string) =>
  app.addInitScript((a) => {
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = { invoke: async (cmd: string) => (cmd === 'plugin:dialog|open' ? a : null) };
  }, answer);
const step = (app: Page, id: string) => app.locator(`.ob-step[data-step="${id}"]`);
const panel = (app: Page) => app.locator('.ob-panel');
const popover = (app: Page) => app.getByRole('dialog', { name: 'New tab' });
const chooser = (app: Page) => app.getByRole('dialog', { name: 'Add project', exact: true });
const shot = (app: Page, name: string) => app.screenshot({ path: path.join(SHOTS, `${TAG}-479-${name}-dark-${test.info().project.name}.png`) });

/** An existing user's window opens no onboarding by itself: they go back to it from Settings. */
async function openOnboarding(app: Page) {
  await app.getByRole('navigation', { name: 'Left bar' }).getByRole('button', { name: 'Settings' }).click();
  await app.getByRole('navigation', { name: 'Settings pages' }).locator('button[data-page="onboarding"]').click();
  await expect(panel(app)).toBeVisible();
}

test.use({ colorScheme: 'dark' });

test('onboarding_cancelled_add_claims_no_later_add: cancel the chooser, add from the sidebar, the step names none', async ({ app, core }) => {
  core.shell(core.project('older'), 'old');
  await folderPanel(app, core.project('picked'));
  await app.goto('/');
  await openOnboarding(app);
  await step(app, 'project').click();
  await panel(app).getByRole('button', { name: 'Add project' }).click();
  await chooser(app).getByRole('button', { name: 'Cancel' }).click();
  await expect(chooser(app)).toHaveCount(0);
  // Later, the sidebar's own "+ Project" adds a folder: not onboarding's add.
  await app.locator('.addproj').click();
  await chooser(app).getByRole('button', { name: /^Browse folder/ }).press('Enter');
  await expect(popover(app)).toContainText('picked');
  await app.keyboard.press('Escape');
  await openOnboarding(app);
  await step(app, 'project').click();
  await expect(panel(app).getByRole('button', { name: 'Start Claude' })).toBeVisible();
  await expect(panel(app).getByRole('status')).toHaveCount(0);
});

test('onboarding_removed_project_is_not_named: add via onboarding, remove it, the step names none and starts in one that exists', async ({ app, core }) => {
  core.shell(core.project('older'), 'old');
  await folderPanel(app, core.project('picked'));
  await app.goto('/');
  await openOnboarding(app);
  await step(app, 'project').click();
  await panel(app).getByRole('button', { name: 'Add project' }).click();
  await chooser(app).getByRole('button', { name: /^Browse folder/ }).press('Enter');
  await expect(popover(app)).toContainText('picked');
  await expect(async () => {
    await app.keyboard.press('Escape');
    await expect(popover(app)).toHaveCount(0, { timeout: 1000 });
  }).toPass();
  await openOnboarding(app);
  await step(app, 'project').click();
  await expect(panel(app).getByRole('status')).toHaveText('Added picked. Start your first agent session in it.');
  await app.getByRole('button', { name: 'Close Settings' }).click();
  // F15: an added project with no session leaves the tree by its own hover button.
  const drop = app.locator('button.pdrop[aria-label="Remove picked from the tree"]');
  await app.getByRole('group', { name: 'picked: idle' }).hover();
  await drop.click();
  await expect(drop).toHaveCount(0);
  await openOnboarding(app);
  await step(app, 'project').click();
  await expect(panel(app).getByRole('button', { name: 'Start Claude' })).toBeVisible();
  await shot(app, '2-removed');
  await expect(panel(app).getByRole('status')).toHaveCount(0);
  await panel(app).getByRole('button', { name: 'Start Claude' }).click();
  await expect
    .poll(() => (core.cli('snapshot', '--json').sessions as { project: string; kind: string }[]).filter((s) => s.kind === 'claude').map((s) => path.basename(s.project)))
    .toEqual(['older']);
});

test('onboarding_line_matches_unchecked_card: a found agent with no check started, the line says Not checked as the card does', async ({ app }) => {
  // The first look finds no agent; the look on focus finds Claude while the account list (which starts the checks) waits.
  let missing = true;
  let hold = false;
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => {
      const msg = typeof m === 'string' ? JSON.parse(m) : null;
      if (missing && msg?.request?.op === 'first_run') {
        const agents = ['claude', 'codex'].map((agent) => ({ agent, found: false, version: null }));
        return ws.send(JSON.stringify({ id: msg.id, response: { Ok: { agents } } }));
      }
      if (hold && msg?.request?.op === 'account_list') return; // never answered: no check starts
      server.send(m);
    });
    server.onMessage((m) => ws.send(m));
  });
  await app.goto('/');
  await openOnboarding(app);
  await step(app, 'providers').click();
  const claude = panel(app).locator('[data-row="claude"]');
  await expect(claude).toContainText('Not installed');
  missing = false;
  hold = true;
  await app.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(claude).toContainText('Not checked');
  await expect(claude.getByRole('button', { name: 'Check' })).toBeVisible();
  await shot(app, '3-unchecked');
  await expect(panel(app).getByRole('status')).toHaveText('Found Claude; its sign-in is not checked yet. Press Check.');
});

test.describe('first run', () => {
  test.use({ firstRun: true });
  test('onboarding_add_popover_leads_with_the_agent: the New tab after an onboarding add has the found agent first', async ({ app, core }) => {
    await folderPanel(app, core.project('picked'));
    await app.goto('/');
    await expect(panel(app)).toBeVisible();
    await step(app, 'project').click();
    await panel(app).getByRole('button', { name: 'Add project' }).click();
    await chooser(app).getByRole('button', { name: /^Browse folder/ }).press('Enter');
    await expect(popover(app)).toContainText('picked');
    await expect(popover(app).getByRole('option', { name: /^Claude/ })).toBeVisible();
    await shot(app, '4-add-popover');
    await expect(popover(app).getByRole('option', { selected: true })).toHaveAccessibleName(/^Claude/);
  });
});

test('onboarding_removed_while_open_is_not_named: the project leaves the tree while Settings stays open, the step stops naming it', async ({ app, core }) => {
  // Ticket 485: the page reads the app's live project list, not a tree copy of its own that only an add updates.
  core.shell(core.project('older'), 'old');
  await folderPanel(app, core.project('picked'));
  await app.goto('/');
  await openOnboarding(app);
  await step(app, 'project').click();
  await panel(app).getByRole('button', { name: 'Add project' }).click();
  await chooser(app).getByRole('button', { name: /^Browse folder/ }).press('Enter');
  await expect(popover(app)).toContainText('picked');
  await expect(async () => {
    await app.keyboard.press('Escape');
    await expect(popover(app)).toHaveCount(0, { timeout: 1000 });
  }).toPass();
  await openOnboarding(app);
  await step(app, 'project').click();
  await expect(panel(app).getByRole('status')).toHaveText('Added picked. Start your first agent session in it.');
  // Settings stays open: the tree's remove button is pressed under it (as a command or another surface of the window would).
  const drop = app.locator('button.pdrop[aria-label="Remove picked from the tree"]');
  await drop.dispatchEvent('click');
  await expect(drop).toHaveCount(0);
  await expect(panel(app)).toBeVisible();
  await expect(panel(app).getByRole('status')).toHaveCount(0);
  await expect(panel(app).getByRole('button', { name: 'Start Claude' })).toBeVisible();
});
