// Ticket 305: Settings > Onboarding opens by itself on the first run. Ticket 391 part 2 (providers-391 scene d): seven steps (ticket 582 adds the last, the first session; owner 11-16 the keys step),
// each counted, done from real state or from one stored list of marks (a page seen, the project step skipped). The macOS
// step needs the 권한 page, which exists only in the app: a browser window lists eight (ticket 1034 adds the assistant step; the last is the first session, ticket 582).
import { fakeAcp, ownerOk } from './acp-fakes';
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test, type Core } from './fixtures';

const CLAUDE = `#!/bin/sh
case "$1 $2" in "--version ") echo '2.1.311 (Claude Code)'; exit 0;; "auth status") echo '{"loggedIn": true}'; exit 0;; esac
printf 'fake agent ready\\r\\n'
exec /bin/cat
`;
const step = (app: Page, id: string) => app.locator(`.ob-step[data-step="${id}"]`);
const count = (app: Page) => app.locator('[data-ob-count]');
const pill = (app: Page) => app.locator('.ob-pill');
const settings = (app: Page) => app.getByRole('dialog', { name: 'Settings' });
const closeSettings = (app: Page) => settings(app).getByRole('button', { name: 'Close Settings' }).click();
const nav = (app: Page) => app.getByRole('navigation', { name: 'Settings pages' });
const stored = (app: Page) => app.evaluate(() => JSON.parse(localStorage.getItem('nunchiro.settings.v1') ?? '{}'));
/** On a first run Settings is open, as the modal, with no session. */
async function launch(app: Page) {
  await app.goto('/');
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
}
/** Stands in for the browser's permission; asking grants it. */
const fakeNotifications = (app: Page, permission: string) =>
  app.addInitScript((p) => {
    const n = { permission: p, requestPermission: async () => (n.permission = 'granted') };
    (window as unknown as { Notification: unknown }).Notification = n;
  }, permission);
const signedIn = (core: Core) => fs.writeFileSync(path.join(core.home, 'bin/claude'), CLAUDE, { mode: 0o700 });

test.describe('first run', () => {
  test.use({ firstRun: true });

  // Owner 11-15: one button accepts the recommended settings and goes to the one thing only the user can give, a project.
  test('quick_setup: one button keeps the found agent, asks for notifications, ticks look and skills, and opens Add project', async ({ app, core }) => {
    signedIn(core);
    await fakeNotifications(app, 'default');
    await launch(app);
    const quick = app.locator('.ob-quick');
    await expect(quick.getByRole('heading', { name: 'Quick setup' })).toBeVisible();
    await expect(quick).toContainText('Claude');
    await expect(quick).toContainText('Follows your Mac: theme and language');
    await expect(quick).toContainText('to put a letter on every button'); // ticket 991 (A19): what the keys do, not their names
    // The one choice on the card: what a new session may do without asking. It shows the core's value and sets both agents.
    const perm = quick.getByRole('combobox', { name: 'Permissions' });
    await expect(perm).toHaveValue('full-access');
    await perm.selectOption('ask');
    await expect.poll(() => ownerOk(core, { op: 'agent_permission_get' })).toMatchObject({ claude: 'ask', codex: 'ask' });
    await perm.selectOption('full-access');
    await expect.poll(() => ownerOk(core, { op: 'agent_permission_get' })).toMatchObject({ claude: 'full-access', codex: 'full-access' });
    await quick.screenshot({ path: '../.scratch/shots/quick-setup-en.png' });
    await quick.getByRole('button', { name: 'Add a project without starting' }).click(); // ticket 1123: Start is the main button now
    await expect(app.getByRole('dialog', { name: 'Add project', exact: true })).toBeVisible();
    expect(await app.evaluate(() => (window as unknown as { Notification: { permission: string } }).Notification.permission)).toBe('granted');
    const features = (await stored(app)).features ?? {};
    expect(features['onboarding.marks']).toEqual(expect.arrayContaining(['appearance', 'keys', 'skills']));

    expect(features['onboarding.default_agent']).toBe('claude');
    // Owner 2026-11-16: the recommended settings turn on the two Git helpers.
    await expect.poll(() => ownerOk(core, { op: 'quit_settings' }).settings.auto_clean_worktrees).toBe(true);
    await expect.poll(() => (JSON.parse(fs.readFileSync(path.join(core.home, 'settings.json'), 'utf8')).features ?? {})['git.auto_pull']).toBe(true);
  });

  test('onboarding_opens_on_first_run: the page opens once, the second launch does not', async ({ app }) => {
    await launch(app);
    await expect(app.locator('.ob-step')).toHaveCount(8);
    await expect(settings(app)).toBeVisible();
    await closeSettings(app); // a reload of the same window keeps a modal left open, so it is closed first
    await app.reload();
    await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
    await expect(settings(app)).toHaveCount(0);
  });

  test('onboarding_says_what_the_app_is_and_where_the_language_is: ticket 489 wording', async ({ app }) => {
    await launch(app);
    await expect(settings(app).getByText('Nunchiro runs your coding agents, each in its own tab.', { exact: false })).toBeVisible();
    await step(app, 'look').click();
    await expect(settings(app).getByText('Pick your theme and row spacing. The language is under General.')).toBeVisible();
  });

  test('onboarding_lists_eight_steps_in_a_browser (ticket 1034 adds the assistant step): no macOS step, every step counted, none coming soon', async ({ app }) => {
    await launch(app);
    expect(await app.locator('.ob-step').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.step))).toEqual(['look', 'providers', 'notify', 'keys', 'project', 'skills', 'assistant', 'session']);
    await expect(count(app)).toHaveText('0/8');
    await expect(count(app)).toHaveAttribute('data-tip', 'A step gets a check mark when Nunchiro finds that it is done on this Mac'); // ledger v4f-C-S3-5
    await expect(app.locator('.ob')).not.toContainText(/Coming soon|Check again|Choose your default agent/);
    // The first step not done is shown.
    await expect(step(app, 'look')).toHaveAttribute('aria-current', 'step');
  });

  test('onboarding_has_no_manual_tick and onboarding_has_no_milestones_and_no_yolo_default', async ({ app }) => {
    await launch(app);
    await expect(app.locator('.ob-step')).toHaveCount(8);
    await expect(app.locator('.ob').getByRole('checkbox')).toHaveCount(0);
    await expect(app.locator('.ob').getByRole('button', { name: /mark|tick/i })).toHaveCount(0);
    await expect(app.locator('.ob')).not.toContainText(/milestone|skip permissions|yolo/i);
  });

  test('onboarding_look_done_once_seen: opening Appearance and coming back finishes step 1, language and theme untouched', async ({ app }) => {
    await launch(app);
    await expect(step(app, 'look')).toHaveAttribute('data-done', 'false');
    await app.locator('.ob-panel[data-panel="look"] [data-go="appearance"]').click();
    await expect(nav(app).locator('button[data-page="appearance"]')).toHaveAttribute('aria-current', 'page');
    await nav(app).locator('button[data-page="onboarding"]').click();
    await expect(step(app, 'look')).toHaveAttribute('data-done', 'true');
    await expect(count(app)).toHaveText('1/8');
    const s = await stored(app);
    expect([s.language ?? 'system', s.themeMode ?? 'system']).toEqual(['system', 'system']);
  });

  test('onboarding_providers_done_from_real_state: a signed-in Claude finishes step 2 with no click, no default agent stored', async ({ app, core }) => {
    signedIn(core);
    fakeAcp(core, 'gemini', 'gemini 0.11.2');
    await launch(app);
    await step(app, 'providers').click();
    const panel = app.locator('.ob-panel[data-panel="providers"]');
    await expect(panel.locator('[data-row="claude"]')).toContainText('Signed in', { timeout: 15_000 });
    // Look 1117 v10 C-N10: an ACP agent found but not added reads "Installed", as on Providers' Add tile.
    await expect(panel.locator('[data-row="gemini"]')).toContainText('Installed');
    await expect(panel.locator('[data-row="gemini"]')).not.toContainText('Needs approval');
    await expect(step(app, 'providers')).toHaveAttribute('data-done', 'true');
    // Codex is not on the path: its card says so and offers the install page.
    await expect(panel.locator('[data-row="codex"]')).toContainText('Not installed');
    await expect(panel.locator('[data-row="codex"]').getByRole('button', { name: 'Install' })).toBeVisible();
    await expect(panel.getByText('Checked again when you come back to the window.')).toBeVisible();
    await expect(panel.locator('.ob-tile')).toHaveCount(0);
    expect((await stored(app)).features?.['onboarding.default_agent'] ?? '').toBe('');
  });

  test('onboarding_notify_ask_now: the request grants the permission and finishes step 3', async ({ app }) => {
    await fakeNotifications(app, 'default');
    await launch(app);
    await step(app, 'notify').click();
    await expect(step(app, 'notify')).toHaveAttribute('data-done', 'false');
    await app.locator('.ob-panel').getByRole('button', { name: 'Ask now' }).click();
    await expect(step(app, 'notify')).toHaveAttribute('data-done', 'true');
    await expect(app.locator('.ob-panel').getByRole('combobox', { name: 'Default for new sessions' })).toHaveValue('all');
  });

  test('onboarding_project_skip: Skip counts the step and survives a reload; a project then reads Done', async ({ app, core }) => {
    await launch(app);
    await step(app, 'project').click();
    await expect(count(app)).toHaveText('0/8');
    await app.locator('.ob-panel').getByRole('button', { name: 'Skip' }).click();
    await expect(step(app, 'project')).toHaveAttribute('data-done', 'true');
    await expect(step(app, 'project')).toContainText('Skipped');
    await expect(pill(app)).toHaveText('Skipped');
    await expect(count(app)).toHaveText('1/8');
    await expect(app.locator('.ob-panel').getByRole('button', { name: 'Skip' })).toHaveCount(0);
    await expect(app.locator('.ob-panel [data-go="project"]')).toBeVisible(); // Add project still works
    await app.reload();
    await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
    await expect(step(app, 'project')).toContainText('Skipped');
    await expect(count(app)).toHaveText('1/8');
    // A project arrives: the step is done for real, the skip tag goes.
    core.shell(core.project('demo'), 'alpha');
    await step(app, 'project').click();
    await expect(pill(app)).toHaveText('Done');
    await expect(step(app, 'project')).not.toContainText('Skipped');
  });

  test('onboarding_first_session_skip_path: skipping the project leaves one clear action, here and on the Landing (ticket 582)', async ({ app }) => {
    await launch(app);
    await step(app, 'project').click();
    await app.locator('.ob-panel').getByRole('button', { name: 'Skip' }).click();
    await step(app, 'session').click();
    const panel = app.locator('.ob-panel[data-panel="session"]');
    await expect(pill(app)).toHaveText('Not done');
    await expect(panel.getByRole('status')).toHaveText('No project yet. Add one, then start your session in it.');
    await expect(panel.getByRole('button')).toHaveCount(1);
    await expect(panel.getByRole('button', { name: 'Add project' })).toBeVisible();
    await closeSettings(app);
    const landing = app.locator('.landing');
    await expect(landing.locator('.btn.p')).toHaveCount(1);
    await expect(landing.getByRole('button', { name: 'Add project' })).toBeVisible();
  });

  test('onboarding_notify_line_names_no_missing_button: no Notification API says so; a button is named only when drawn (ticket 582)', async ({ app }) => {
    await app.addInitScript(() => delete (window as unknown as { Notification?: unknown }).Notification);
    await launch(app);
    await step(app, 'notify').click();
    const panel = app.locator('.ob-panel[data-panel="notify"]');
    await expect(panel).toContainText('This window cannot show system notifications.');
    await expect(panel).not.toContainText(/Press the button/);
    await expect(panel.getByRole('button', { name: 'Ask now' })).toHaveCount(0);
  });

  test('onboarding_skills_step: opening it finishes it, and its switches are the page switches', async ({ app, core }) => {
    await launch(app);
    await step(app, 'skills').click();
    await expect(step(app, 'skills')).toHaveAttribute('data-done', 'true');
    await expect(pill(app)).toHaveText('Done'); // the panel stays on step 6
    const panel = app.locator('.ob-panel[data-panel="skills"]');
    await expect(panel.getByRole('switch')).toHaveCount(3);
    await expect(panel.getByRole('button', { name: 'Open my own copy of the files' })).toHaveCount(0);
    const orch = panel.getByRole('switch', { name: 'Orchestration skill for new sessions' });
    await expect(orch).toBeChecked();
    await orch.click();
    await expect.poll(() => JSON.parse(fs.readFileSync(path.join(core.home, 'settings.json'), 'utf8')).orchestration?.enabled).toBe(false);
    await panel.locator('[data-go="extensions"]').click();
    await expect(app.getByRole('heading', { level: 1, name: 'Skills & hooks' })).toBeVisible();
    await expect(app.getByRole('region', { name: 'Nunchiro defaults' }).getByRole('switch', { name: 'Orchestration skill for new sessions' })).not.toBeChecked();
  });

  // Owner 2026-11-16: the prefix and the hint keys are set in the panel, with the Keyboard page's recorder and alphabet field.
  test('onboarding_keys_step: the prefix is recorded and the hint keys typed in the panel; reset puts both back', async ({ app }) => {
    await launch(app);
    await expect(step(app, 'keys')).toContainText('Pick your keys');
    await expect(step(app, 'keys')).toHaveAttribute('data-done', 'false');
    await step(app, 'keys').click();
    await expect(step(app, 'keys')).toHaveAttribute('data-done', 'true'); // shown once: the defaults are a choice
    const panel = app.locator('.ob-panel[data-panel="keys"]');
    const prefix = panel.locator('.srow').filter({ hasText: 'Prefix' }).first();
    const hints = panel.locator('.srow').filter({ hasText: 'Hint keys' });
    await expect(prefix).toContainText('Press it, release it, then press one more key to run a command.');
    await expect(hints).toContainText('These letters then label everything you can click');
    await expect(prefix.locator('.kbd')).toHaveText(['⌃.', '⌃␣']);
    await panel.screenshot({ path: '../.scratch/shots/onboarding-keys-en.png' });

    // Change records one chord in place; Enter saves it as the first prefix, and the focus is back on Change.
    await prefix.getByRole('button', { name: "Change Prefix (the key before a command's key)" }).click();
    await expect(prefix.getByRole('status')).toContainText('press a shortcut…');
    await panel.screenshot({ path: '../.scratch/shots/onboarding-keys-recording-en.png' });
    await app.keyboard.press('Control+KeyB');
    await app.keyboard.press('Enter');
    await expect(prefix.locator('.kbd')).toHaveText(['⌃B', '⌃␣']);
    await expect(prefix.getByRole('button', { name: "Change Prefix (the key before a command's key)" })).toBeFocused();
    expect((await stored(app)).bindings.prefix).toEqual(['Control+KeyB', 'Control+Space']);

    // The hint alphabet: a refused value says why and stores nothing; a good one is stored.
    const letters = hints.getByRole('textbox', { name: 'Hint alphabet' });
    await letters.fill('jj');
    await expect(hints.getByRole('alert')).toBeVisible();
    expect(((await stored(app)).hintKeys?.alphabet ?? [...'asdfjklghewruiopqtyvcmnxzb1234567890']).join('')).toBe('asdfjklghewruiopqtyvcmnxzb1234567890');
    await letters.fill('jkl;fd');
    await expect(hints.getByRole('alert')).toHaveCount(0);
    expect((await stored(app)).hintKeys.alphabet).toEqual([...'jkl;fd']);

    // The Keyboard page shows both.
    await panel.locator('[data-go="keys"]').click();
    await expect(app.locator('[data-command="prefix"] .kcell .kbd')).toHaveText(['⌃B', '⌃␣']);
    await expect(app.locator('input[data-setting="hintKeys"]')).toHaveValue('jkl;fd');

    // Reset on each row puts the default back.
    await nav(app).locator('button[data-page="onboarding"]').click();
    await step(app, 'keys').click();
    await prefix.getByRole('button', { name: 'Reset Prefix' }).click();
    await expect(prefix.locator('.kbd')).toHaveText(['⌃.', '⌃␣']);
    await hints.getByRole('button', { name: 'Reset Hint keys' }).click();
    await expect(letters).toHaveValue('asdfjklghewruiopqtyvcmnxzb1234567890');
    const s = await stored(app);
    expect(s.bindings.prefix).toBeUndefined();
    expect(s.hintKeys.alphabet.join('')).toBe('asdfjklghewruiopqtyvcmnxzb1234567890');
    await expect(step(app, 'keys')).toHaveAttribute('data-done', 'true'); // the mark stays
  });

  test('onboarding keeps the import block, outside the counted steps', async ({ app }) => {
    await launch(app);
    await expect(app.locator('[data-step="import"]').getByRole('button', { name: 'Look for conversations' })).toBeVisible();
  });
});

const firstRow = (app: Page) => app.getByRole('dialog', { name: 'New tab' }).getByRole('option').first();
test('default_agent_setting_picks_new_session_agent: no default keeps today, a default comes first', async ({ app, core }) => {
  signedIn(core);
  core.shell(core.project('alpha'), 'alpha');
  await app.goto('/');
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  await app.locator('.tadd').click();
  await expect(firstRow(app)).toContainText('New terminal');
  await app.keyboard.press('Escape');
  // Ticket 391: the default is picked on Providers > Default agent (onboarding no longer writes it).
  await app.keyboard.press('Meta+Comma');
  await nav(app).getByRole('button', { name: 'Providers' }).click();
  await app.getByRole('combobox', { name: 'Default agent' }).selectOption('claude');
  await closeSettings(app);
  await app.locator('.tadd').click();
  await expect(firstRow(app)).toContainText('Claude');
});
