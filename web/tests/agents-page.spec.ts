// Settings > Agents after ticket 355, Settings > Providers since ticket 391: agents.toml, the picker hand-off group and the
// New session defaults (the default agent on top, model, effort and permission in the Claude card). Adding and approving
// agents: provider-add.spec.ts.
import type { Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { agentsToml, fakeAcp, ownerOk, tomlEntry } from './acp-fakes';
import { type Core, expect, openWindow, REPO, test } from './fixtures';
import { openRow } from './accounts-rows';

/** The visible route: the Settings button, then the Providers nav item, then the Claude card, whose 새 세션 기본값 block holds the rows. */
async function openAgents(app: Page) {
  await app.getByRole('button', { name: 'Settings', exact: true }).click();
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Providers' }).click();
  await expect(app.getByRole('heading', { level: 2, name: 'Providers', exact: true })).toBeVisible();
  await openRow(app, 'Claude');
}
/** Every JSON request the window sent over its socket. */
function sent(app: Page) {
  const frames: any[] = [];
  app.on('websocket', (ws) =>
    ws.on('framesent', (f) => {
      try {
        const j = JSON.parse(String(f.payload));
        if (j.request) frames.push(j.request);
      } catch {
        // not JSON (an ack frame)
      }
    }),
  );
  return frames;
}

test('open_agents_toml_link_present', async ({ app, core }) => {
  await openWindow(app);
  await openAgents(app);
  await expect(app.getByRole('button', { name: 'Open agents.toml' })).toBeVisible();
  // Ticket 391: the path is always shown, with Copy (outside the Nunchiro app there is no Finder). Settings kit: it is the
  // page's last row ("Agent list file").
  await expect(app.locator('[data-field="agents-toml-path"]')).toContainText(agentsToml(core));
  await expect(app.locator('[data-row="agentsFile"]').getByRole('button', { name: 'Copy the path of agents.toml' })).toBeVisible();
});

test('picker_lists_approved_acp_agents', async ({ app, core }) => {
  // The session handed off from is a Claude fake that shows a prompt (the V2-3b fixture).
  fs.copyFileSync(path.join(REPO, 'crates/nunchiro/tests/fixtures/claude-picker'), path.join(core.home, 'bin/claude'));
  const cmd = fakeAcp(core, 'good', 'good 1.0');
  fakeAcp(core, 'bad', 'bad 1.0');
  fs.writeFileSync(agentsToml(core), tomlEntry('good', cmd) + '\n' + tomlEntry('bad', path.join(core.home, 'bin/bad')));
  const view = ownerOk(core, { op: 'acp_agent_status', name: 'good' }).view;
  ownerOk(core, { op: 'acp_agent_grant', name: 'good', hash: view.hash });
  const from = core.cli('session', 'start', '--kind', 'claude', '--project', core.project('demo'), '--label', 'claude').session as { id: string };
  const frames = sent(app);
  await openWindow(app);
  await expect.poll(() => core.read(from.id)).toContain('❯');
  await app.locator('[data-picker="model"]').click();
  const menu = app.locator('[data-menu="model"]');
  await menu.locator('[data-item="more"]').click(); // W35: the hand-off group is under More models ›
  await expect(menu.locator('[data-item="handoff-acp:good"]')).toHaveText('good · ACP');
  await expect(menu.locator('[data-item="handoff-acp:bad"]')).toHaveCount(0);
  // "Add or manage agents…" opens Settings > Agents.
  await menu.locator('[data-item="manage"]').click();
  await expect(app.getByRole('heading', { level: 2, name: 'Providers', exact: true })).toBeVisible();
  // Choosing the agent stages the hand-off (nothing starts); Enter in the composer sends it.
  await app.keyboard.press('Escape'); // v25f: Settings is a modal over the tabs
  await app.locator(`.tab[data-tab="${from.id}"]`).click();
  await app.locator('[data-picker="model"]').click();
  await app.locator('[data-menu="model"] [data-item="more"]').click();
  await app.locator('[data-menu="model"] [data-item="handoff-acp:good"]').click();
  await expect(app.getByText('Switching to good (ACP) · handoff')).toBeVisible();
  // Staged is not sendable: Enter before handoff_preview replies is dropped (useComposerSend: `ho && !ho.preview`), and the chip reads
  // "Reading…" until then. The counts line is the settled state.
  await expect(app.getByText(/^Handoff from Claude · prompts \d+/)).toBeVisible();
  expect(core.cli('snapshot', '--json').sessions).toHaveLength(1);
  await app.locator('#composer').press('Enter');
  await expect.poll(() => frames.find((f) => f.op === 'handoff_send')).toMatchObject({ to: 'acp', acp_agent: 'good', from: from.id });
  await expect.poll(() => (core.cli('snapshot', '--json').sessions as { kind: string; acp_agent?: string }[]).find((s) => s.kind === 'acp')?.acp_agent).toBe('good');
});

// ---------------------------------------------------------------------------------------------------------------
// Design conformance: each promise of the approved mockup's Option A (03-acp-setup.html), from the visible controls.


// accounts.rs: "Your own" is probed only when the owner asks, as the status command writes into the live config.

// Ticket 223: New session defaults.
/** Settings has no tab strip, so this asks for the popover the way the tree's "+" does. */
const startClaude = async (app: Page, project: string) => {
  await app.evaluate((p) => window.dispatchEvent(new CustomEvent('nunchiro:session.new', { detail: { project: p } })), project);
  await app.getByRole('dialog', { name: 'New tab' }).getByRole('option', { name: 'Claude' }).first().click();
};
// Since #57 the window's own starts (the New tab menu, the tree's +) go as `start_or_wait`, the start inside it.
const lastStart = (frames: any[]) => frames.map((f) => (f.op === 'start_or_wait' ? f.start : f)).filter((f) => f?.op === 'start').at(-1)?.session;
/** The window's stored defaults, as a hand-edited settings file would leave them; read at load. */
async function seedDefaults(app: Page, stored: unknown, backup?: unknown) {
  await app.evaluate(([v, b]) => {
    const key = 'nunchiro.settings.v1';
    const s = JSON.parse(localStorage.getItem(key) ?? '{}');
    localStorage.setItem(key, JSON.stringify({ ...s, features: { ...s.features, 'agents.new_session_defaults': v, ...(b ? { 'agents.new_session_permission_backup': b } : {}) } }));
  }, [stored, backup] as const);
  await app.reload();
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
}
const claudeModel = (app: Page) => app.getByRole('combobox', { name: 'Default model and effort · Claude' });
const claudeEffort = (app: Page) => app.getByRole('combobox', { name: 'Effort · Claude', exact: true });

test('agents_default_model_effort_applies_to_new_session', async ({ app, core }) => {
  const frames = sent(app);
  const demo = core.project('demo');
  core.shell(demo, 'alpha');
  await openWindow(app);
  await openAgents(app);
  await claudeModel(app).selectOption('opus');
  await claudeEffort(app).selectOption('high');
  await startClaude(app, demo);
  await expect.poll(() => lastStart(frames)).toMatchObject({ kind: 'claude', model: 'opus', effort: 'high' });
});

// Ticket 382: the row is the core's agents.permission, the value a launch reads. The fake claude logs its own argv.
const permission = (app: Page, name: string) => app.getByRole('combobox', { name: `Permission · ${name}` });
const shownChoice = (l: ReturnType<typeof permission>) => l.evaluate((e) => (e as HTMLSelectElement).selectedOptions[0].textContent);
async function launchArgs(core: Core, seen: string[]) {
  let id = '';
  await expect.poll(() => (id = (core.cli('snapshot', '--json').sessions as { id: string; kind: string }[]).find((s) => s.kind === 'claude' && !seen.includes(s.id))?.id ?? '')).not.toBe('');
  seen.push(id);
  const log = path.join(core.home, `stdin-${id}.log`);
  await expect.poll(() => fs.existsSync(log) && fs.readFileSync(log, 'utf8').includes('LAUNCH')).toBe(true);
  return fs.readFileSync(log, 'utf8').split('\n').find((l) => l.startsWith('LAUNCH'))!;
}

const BACKUP = 'agents.new_session_permission_backup';
const feature = (app: Page, key: string) => app.evaluate((k) => JSON.parse(localStorage.getItem('nunchiro.settings.v1') ?? '{}').features?.[k], key);
const featureText = async (app: Page, key: string) => JSON.stringify(await feature(app, key));
const corePermission = (core: Core) => ownerOk(core, { op: 'agent_permission_get' }) as { claude: string; codex: string };

test('default_permissions_shows_what_a_new_session_gets_and_changes_the_next_launch', async ({ app, core }) => {
  fs.copyFileSync(path.join(REPO, 'crates/nunchiro/tests/fixtures/claude-picker'), path.join(core.home, 'bin/claude'));
  const demo = core.project('demo');
  core.shell(demo, 'alpha');
  const seen: string[] = [];
  await openWindow(app);
  await openAgents(app);
  // Nothing stored: the core launches with full access, and the row says so.
  await expect(permission(app, 'Claude')).toHaveValue('full-access');
  expect(await shownChoice(permission(app, 'Claude'))).toBe('Bypass permissions');
  await openRow(app, 'Codex'); // one card open at a time
  await expect(permission(app, 'Codex')).toHaveValue('full-access');
  expect(await shownChoice(permission(app, 'Codex'))).toBe('Bypass permissions');
  await startClaude(app, demo);
  expect(await launchArgs(core, seen)).toContain('--dangerously-skip-permissions');

  await openAgents(app);
  await permission(app, 'Claude').selectOption('ask');
  await expect.poll(() => JSON.parse(fs.readFileSync(path.join(core.home, 'settings.json'), 'utf8')).features?.['agents.permission']).toMatchObject({ claude: 'ask' });
  await startClaude(app, demo);
  const asked = await launchArgs(core, seen);
  expect(asked).toContain('"--permission-mode", "manual"');
  expect(asked).not.toContain('--dangerously-skip-permissions');
});

test('a_value_from_the_old_permission_row_never_widens', async ({ app, core }) => {
  fs.copyFileSync(path.join(REPO, 'crates/nunchiro/tests/fixtures/claude-picker'), path.join(core.home, 'bin/claude'));
  const frames = sent(app);
  const demo = core.project('demo');
  core.shell(demo, 'alpha');
  const seen: string[] = [];
  await openWindow(app);
  await seedDefaults(app, { all: { permission: 'plan' }, projects: {} });
  // Not moved yet: the launch keeps what the owner stored.
  await startClaude(app, demo);
  await expect.poll(() => lastStart(frames)?.args).toEqual(['--permission-mode', 'plan']);
  await launchArgs(core, seen);
  await app.getByRole('dialog', { name: 'New tab' }).waitFor({ state: 'hidden' });
  await openAgents(app);
  // Plan has no place in agents.permission: the strict choice, the old value leaves the launch and is kept in the backup.
  await expect(permission(app, 'Claude')).toHaveValue('ask');
  await expect.poll(() => featureText(app, 'agents.new_session_defaults')).not.toContain('permission');
  expect(await feature(app, BACKUP)).toEqual({ all: 'plan', projects: {}, before: 'full-access', to: 'ask', moved: true });
  frames.length = 0;
  await startClaude(app, demo);
  await expect.poll(() => lastStart(frames)).toBeTruthy();
  expect(lastStart(frames).args).toBeUndefined();
  expect(await launchArgs(core, seen)).toContain('"--permission-mode", "manual"');
});

test('old_accept_edits_becomes_accept_edits', async ({ app, core }) => {
  await openWindow(app);
  await seedDefaults(app, { all: { permission: 'acceptEdits' }, projects: {} });
  await openAgents(app);
  await expect(permission(app, 'Claude')).toHaveValue('accept-edits');
  expect(corePermission(core).claude).toBe('accept-edits');
  await expect.poll(() => feature(app, BACKUP)).toEqual({ all: 'acceptEdits', projects: {}, before: 'full-access', to: 'accept-edits', moved: true });
});

test('a_project_on_old_default_becomes_ask', async ({ app, core }) => {
  const demo = core.project('demo');
  await openWindow(app);
  await seedDefaults(app, { all: {}, projects: { [demo]: { permission: 'default' } } });
  await openAgents(app);
  await expect(permission(app, 'Claude')).toHaveValue('ask');
  expect(corePermission(core).claude).toBe('ask');
  await expect.poll(() => feature(app, BACKUP)).toEqual({ projects: { [demo]: 'default' }, before: 'full-access', to: 'ask', moved: true });
});

test('an_old_value_never_loosens_a_stricter_current_choice', async ({ app, core }) => {
  ownerOk(core, { op: 'agent_permission_set', agent: 'claude', choice: 'ask' });
  await openWindow(app);
  await seedDefaults(app, { all: { permission: 'acceptEdits' }, projects: {} });
  await openAgents(app);
  await expect(permission(app, 'Claude')).toHaveValue('ask');
  expect(corePermission(core).claude).toBe('ask');
  await expect.poll(() => feature(app, BACKUP)).toMatchObject({ all: 'acceptEdits', before: 'ask', moved: true });
  await expect.poll(() => featureText(app, 'agents.new_session_defaults')).not.toContain('permission');
});

// The move was cut short after the core step, or the owner changed the choice since it began: the core is not written again.
for (const [name, moved, before] of [['after_the_core_step', true, 'full-access'], ['over_a_newer_choice', false, 'ask']] as const) {
  test(`a_resumed_move_only_finishes: ${name}`, async ({ app, core }) => {
    await openWindow(app);
    await seedDefaults(app, { all: { permission: 'plan' }, projects: {} }, { all: 'plan', projects: {}, before, to: 'ask', moved });
    await openAgents(app);
    await expect(permission(app, 'Claude')).toHaveValue('full-access');
    expect(corePermission(core).claude).toBe('full-access');
    await expect.poll(() => featureText(app, 'agents.new_session_defaults')).not.toContain('permission');
    expect(await feature(app, BACKUP)).toMatchObject({ all: 'plan', to: 'ask', moved: true });
  });
}

test('agents_project_override_wins', async ({ app, core }) => {
  const frames = sent(app);
  const demo = core.project('demo');
  core.shell(demo, 'alpha');
  await openWindow(app);
  await openAgents(app);
  await claudeModel(app).selectOption('opus');
  await claudeEffort(app).selectOption('high');
  // Ticket 1040: the project's own value is set on its page in Settings > Projects.
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Projects' }).click();
  await app.locator('.pj-row').filter({ hasText: 'demo' }).locator('.pj-open').click();
  const mine = app.locator('.pj-one').getByRole('combobox', { name: 'Default model and effort · Claude' });
  await expect(mine).toHaveValue('');
  await mine.selectOption('sonnet');
  await startClaude(app, demo);
  // The project's model; its empty effort follows All projects.
  await expect.poll(() => lastStart(frames)).toMatchObject({ project: demo, model: 'sonnet', effort: 'high' });
});

test('composer_chip_overrides_default_for_one_session: the chip changes that session, a later one still gets the default', async ({ app, core }) => {
  const frames = sent(app);
  const demo = core.project('demo');
  fs.copyFileSync(path.join(REPO, 'crates/nunchiro/tests/fixtures/claude-picker'), path.join(core.home, 'bin/claude'));
  const s = core.cli('session', 'start', '--kind', 'claude', '--project', demo, '--label', 'claude', '--model', 'haiku').session as { id: string };
  await openWindow(app);
  await seedDefaults(app, { all: { claude: { model: 'opus' } }, projects: {} });
  const chip = app.locator('[data-picker="model"]');
  await expect(chip).toHaveText('Claude · Haiku');
  await expect.poll(() => core.read(s.id)).toContain('❯');
  await chip.click();
  await app.locator('[data-menu="model"]').getByRole('menuitemradio', { name: 'Sonnet' }).click();
  await expect(chip).toHaveText('Claude · Sonnet');
  expect(frames.filter((f) => f.op === 'switch_model').map((f) => f.model)).toEqual(['sonnet']);
  await startClaude(app, demo);
  await expect.poll(() => lastStart(frames)).toMatchObject({ kind: 'claude', model: 'opus' });
});

test('stored_defaults_outside_the_rules_never_reach_the_start_frame', async ({ app, core }) => {
  const frames = sent(app);
  const demo = core.project('demo');
  core.shell(demo, 'alpha');
  await openWindow(app);
  await seedDefaults(app, {
    all: { permission: 'bypassPermissions', claude: { model: '--dangerously-skip-permissions' } },
    projects: { [demo]: { permission: '--dangerously-skip-permissions', claude: { model: '-x' } } },
  });
  await startClaude(app, demo);
  await expect.poll(() => lastStart(frames)).toBeTruthy();
  expect(lastStart(frames)).toMatchObject({ kind: 'claude', model: null });
  expect(lastStart(frames).args).toBeUndefined();
});

test('type_a_model_clears_the_stored_one_so_the_screen_and_the_launch_agree', async ({ app, core }) => {
  const frames = sent(app);
  const demo = core.project('demo');
  core.shell(demo, 'alpha');
  await openWindow(app);
  await openAgents(app);
  await claudeModel(app).selectOption('opus');
  await claudeModel(app).selectOption('__custom');
  await startClaude(app, demo);
  await expect.poll(() => lastStart(frames)).toMatchObject({ kind: 'claude', model: null });
});

test('default_model_accepts_a_typed_name_and_refuses_a_flag', async ({ app, core }) => {
  const frames = sent(app);
  const demo = core.project('demo');
  core.shell(demo, 'alpha');
  await openWindow(app);
  await openAgents(app);
  await claudeModel(app).selectOption('__custom');
  const name = app.getByRole('textbox', { name: 'Claude model name' });
  await name.fill('--dangerously-skip-permissions');
  await expect(app.locator('[data-row="newDefaultModel"] [role="alert"]')).toContainText('Nothing was saved.');
  await name.fill('claude-opus-5-5[1m]');
  await startClaude(app, demo);
  await expect.poll(() => lastStart(frames)).toMatchObject({ kind: 'claude', model: 'claude-opus-5-5[1m]' });
});
