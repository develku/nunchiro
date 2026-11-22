// Ticket 358 (mock #models2): the model filter, the owner's own model ids, and those ids in the new-session list, so they launch.
import type { Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { openRow } from './accounts-rows';
import { type Core, expect, openWindow, REPO, test } from './fixtures';
import { closeSettings, openSettings } from './settings-modal';
import { cleanCustomModels } from '../src/settings/agents/newDefaults';

const KEY = 'agents.custom_models';
const FIXTURES = path.join(REPO, 'crates/nunchiro/tests/fixtures');
const CLAUDE_LIMIT = 'A custom model is used when a new session starts. It cannot be switched to in a running Claude session.';
const windowFeature = (app: Page, key: string) => app.evaluate((k) => JSON.parse(localStorage.getItem('nunchiro.settings.v1') ?? '{}').features?.[k], key);
const setWindowFeature = (app: Page, key: string, value: unknown) =>
  app.evaluate(
    ([k, v]) => {
      const s = JSON.parse(localStorage.getItem('nunchiro.settings.v1') ?? '{}');
      localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ ...s, features: { ...s.features, [k as string]: v } }));
    },
    [key, value] as const,
  );
const models = (app: Page, kind: string) => app.locator(`#s-accounts [data-field="models"][data-agent="${kind}"]`);
const row = (app: Page, kind: string, id: string) => models(app, kind).locator('.prv-mr').filter({ hasText: id });
async function accounts(app: Page, agent: string) {
  await openSettings(app);
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Providers' }).click();
  await openRow(app, agent);
}
async function add(app: Page, kind: string, id: string, name = '') {
  await models(app, kind).getByRole('textbox', { name: 'Model ID' }).fill(id);
  await models(app, kind).getByRole('textbox', { name: 'Label (optional)' }).fill(name);
  await models(app, kind).getByRole('button', { name: 'Add', exact: true }).click();
}
const stored = (core: Core) => JSON.parse(fs.readFileSync(path.join(core.home, 'settings.json'), 'utf8')).features?.[KEY];
/** Writes the core's value the way the window does (the file alone is read only when the core starts). */
function seed(app: Page, value: unknown) {
  return app.evaluate(
    ([key, v]) =>
      new Promise<void>((ok) => {
        const ws = new WebSocket(`ws://127.0.0.1:${window.__NUNCHIRO__!.port}/ws`, ['nunchiro.v1', `nunchiro.token.${window.__NUNCHIRO__!.token}`]);
        ws.onopen = () => ws.send(JSON.stringify({ id: 1, request: { op: 'quit_settings', patch: { features: { [key as string]: v } } } }));
        ws.onmessage = (e) => JSON.parse(e.data).id === 1 && (ws.close(), ok());
      }),
    [KEY, value] as const,
  );
}
/** A git project with a window on it; the fake Claude records its argv, so the launch is what is checked. */
async function project(app: Page, core: Core) {
  const dir = core.project('alpha');
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir });
  git('init', '-q', '-b', 'main');
  git('commit', '-q', '--allow-empty', '-m', 'init');
  fs.writeFileSync(path.join(core.home, 'bin/claude'), `#!/bin/sh\nprintf '%s\\n' "$@" > '${core.home}/claude-argv'\nexec /bin/cat\n`, { mode: 0o700 });
  core.shell(dir, 'main');
  await openWindow(app);
}
async function worktreeCard(app: Page) {
  await app.keyboard.press('Meta+KeyN');
  const card = app.getByRole('dialog', { name: 'New worktree', exact: true });
  await card.getByRole('button', { name: '⌥↵ Advanced: base and branch' }).click();
  await card.getByRole('checkbox', { name: 'Start an agent here' }).check();
  await card.getByRole('button', { name: /^Model/ }).click();
  return card;
}

test('358-model-filter: a filter with no match says so and clearing it brings every row back', async ({ app, core }) => {
  core.shell(core.project('demo'), 'main');
  await openWindow(app);
  await accounts(app, 'Codex');
  const box = models(app, 'codex').getByRole('textbox', { name: 'Filter models' });
  await expect(models(app, 'codex').locator('.prv-mr')).toHaveCount(8); // ticket 994: with gpt-6.1-terra
  await box.fill('gpt-9');
  await expect(models(app, 'codex').locator('.prv-mr')).toHaveCount(0);
  await expect(models(app, 'codex')).toContainText('No matching models');
  // The id that matched nothing is the one to add next: the row stays.
  await expect(models(app, 'codex').getByRole('textbox', { name: 'Model ID' })).toBeVisible();
  await expect(models(app, 'codex')).toContainText('A model that is turned off is not offered for new sessions.');
  await expect(models(app, 'codex')).not.toContainText(CLAUDE_LIMIT);
  await box.fill('LUNA'); // name or id, in any case
  await expect(models(app, 'codex').locator('.prv-mr')).toHaveCount(2);
  await box.fill('');
  await expect(models(app, 'codex').locator('.prv-mr')).toHaveCount(8); // ticket 994: with gpt-6.1-terra
});

test('358-custom-models: add with a name, change the name, remove; a bad id is refused', async ({ app, core }) => {
  core.shell(core.project('demo'), 'main');
  await openWindow(app);
  await accounts(app, 'Claude');
  await expect(models(app, 'claude')).toContainText(CLAUDE_LIMIT);
  await add(app, 'claude', '-rf', '나쁜 모델');
  await expect(models(app, 'claude').getByRole('alert')).toContainText('Start with a letter or digit');
  await add(app, 'claude', 'opus');
  await expect(models(app, 'claude').getByRole('alert')).toContainText('already on the list');

  await add(app, 'claude', 'claude-x-preview', '내 모델');
  const mine = row(app, 'claude', 'claude-x-preview');
  await expect(mine).toContainText('내 모델');
  await expect(models(app, 'claude')).toContainText('On 5/5');
  await expect.poll(() => stored(core)).toEqual({ claude: [{ id: 'claude-x-preview', name: '내 모델' }] });

  await mine.getByRole('button', { name: 'Change claude-x-preview' }).click();
  const name = models(app, 'claude').getByRole('textbox', { name: 'Label of claude-x-preview' });
  await expect(name).toHaveValue('내 모델');
  await name.fill('새 이름');
  await name.press('Enter');
  await expect(mine).toContainText('새 이름');
  await expect.poll(() => stored(core)).toEqual({ claude: [{ id: 'claude-x-preview', name: '새 이름' }] });

  await mine.getByRole('button', { name: 'Remove claude-x-preview' }).click();
  await expect(mine).toHaveCount(0);
  await expect(models(app, 'claude')).toContainText('On 4/4');
  await expect.poll(() => stored(core)).toEqual({ claude: [] });
});

test('358-custom-models-picker: a custom Claude model picked in the new-session list launches on that id', async ({ app, core }) => {
  await project(app, core);
  await accounts(app, 'Claude');
  await add(app, 'claude', 'claude-x-preview', '내 모델');
  await expect(row(app, 'claude', 'claude-x-preview')).toBeVisible();
  await closeSettings(app);

  const card = await worktreeCard(app);
  await card.getByRole('option', { name: '내 모델' }).click();
  await expect(card.getByRole('button', { name: /^Model/ })).toContainText('내 모델');
  await card.getByRole('textbox', { name: 'New worktree name, task, or GitHub PR or issue URL' }).fill('try custom');
  await card.getByRole('button', { name: 'Create and start', exact: true }).click();
  await expect(card).toHaveCount(0, { timeout: 15_000 });
  await expect.poll(() => (core.cli('snapshot', '--json').sessions as { kind: string; model?: string | null }[]).find((s) => s.kind === 'claude')?.model).toBe('claude-x-preview');
  await expect.poll(() => fs.existsSync(path.join(core.home, 'claude-argv')), { timeout: 15_000 }).toBe(true);
  const argv = fs.readFileSync(path.join(core.home, 'claude-argv'), 'utf8').split('\n');
  expect(argv[argv.indexOf('--model') + 1]).toBe('claude-x-preview');
});

test('358 threat 2: a model past the stored limit is refused clearly and the list stays', async ({ app, core }) => {
  core.shell(core.project('demo'), 'main');
  await openWindow(app);
  const full = { claude: Array.from({ length: 34 }, (_, i) => ({ id: `model-${i}-${'x'.repeat(100)}` })) };
  await seed(app, full);
  await accounts(app, 'Claude');
  await expect(models(app, 'claude').locator('.prv-mr')).toHaveCount(38);
  await add(app, 'claude', `one-more-${'y'.repeat(100)}`);
  await expect(models(app, 'claude').getByRole('alert')).toContainText('4096');
  await expect(models(app, 'claude').locator('.prv-mr')).toHaveCount(38);
  expect(stored(core)).toEqual(full);
});

test('358 threat 3: a custom id switched off is absent from the new-session list', async ({ app, core }) => {
  await project(app, core);
  await accounts(app, 'Claude');
  await add(app, 'claude', 'claude-x-preview', '내 모델');
  await row(app, 'claude', 'claude-x-preview').getByRole('switch', { name: '내 모델' }).click();
  await expect(models(app, 'claude')).toContainText('On 4/5');
  await closeSettings(app);
  const card = await worktreeCard(app);
  await expect(card.getByRole('option', { name: 'Opus' })).toBeVisible();
  await expect(card.getByRole('option', { name: '내 모델' })).toHaveCount(0);
});

test('358-custom-models: a stored id is offered as the default model, not as a typed name', async ({ app, core }) => {
  core.shell(core.project('demo'), 'main');
  await openWindow(app);
  await seed(app, { claude: [{ id: 'claude-x-preview', name: '내 모델' }] });
  await openSettings(app);
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Providers' }).click();
  await openRow(app, 'Claude'); // ticket 391: the default model is in the Claude card
  const pick = app.getByRole('combobox', { name: 'Default model and effort · Claude' });
  await expect.poll(() => pick.locator('option').allTextContents()).toContain('내 모델');
  await pick.selectOption('claude-x-preview');
  await expect(pick).toHaveValue('claude-x-preview');
});

test('358-custom-models-picker: the composer offers a custom id on Codex, which restarts on it, and not on Claude, whose own picker cannot reach it', async ({ app, core }) => {
  fs.copyFileSync(path.join(FIXTURES, 'claude-picker'), path.join(core.home, 'bin/claude'));
  fs.copyFileSync(path.join(FIXTURES, 'codex-picker'), path.join(core.home, 'bin/codex'));
  const session = (kind: string) => core.cli('session', 'start', '--kind', kind, '--project', core.project('demo'), '--label', kind).session as { id: string };
  const claude = session('claude');
  const codex = session('codex');
  await expect.poll(() => (core.cli('snapshot', '--json').sessions as { id: string; agent_session_id?: string }[]).find((s) => s.id === codex.id)?.agent_session_id).toBeTruthy();
  await openWindow(app);
  await seed(app, { claude: [{ id: 'claude-x-preview', name: '내 모델' }], codex: [{ id: 'gpt-x-preview', name: '내 코덱스' }] });
  const chip = app.locator('[data-picker="model"]');
  const menu = app.locator('[data-menu="model"]');

  await app.locator(`.tab[data-tab="${claude.id}"]`).click();
  await chip.click();
  await expect(menu.getByRole('menuitemradio', { name: 'Opus' })).toBeVisible();
  await expect(menu.getByRole('menuitemradio', { name: '내 모델' })).toHaveCount(0);
  // W35 round 2: it is under More models ›, "starts a new Claude session": a click starts one on it and opens it.
  await menu.locator('[data-item="more"]').click();
  await expect(app.locator('[data-menu="more"] .pk-group').first()).toHaveText('Your models · starts a new Claude session');
  await app.locator('[data-menu="more"]').getByRole('menuitemradio', { name: '내 모델' }).click();
  type Row = { id: string; kind: string; state: string; model?: string };
  await expect.poll(() => (core.cli('snapshot', '--json').sessions as Row[]).find((s) => s.kind === 'claude' && s.model === 'claude-x-preview')?.state).toBe('running');
  const started = (core.cli('snapshot', '--json').sessions as Row[]).find((s) => s.model === 'claude-x-preview')!;
  await expect(app.locator('.tab[aria-selected="true"]')).toHaveAttribute('data-tab', started.id);
  expect((core.cli('snapshot', '--json').sessions as Row[]).find((s) => s.id === claude.id)?.state).toBe('running'); // the old one stays

  await app.locator(`.tab[data-tab="${codex.id}"]`).click();
  await app.getByRole('button', { name: 'Terminal', exact: true }).click(); // the input box is drawn once the window fits the terminal
  await expect.poll(() => core.screen(codex.id)).toContain('gpt-fixture redrawn');
  await chip.click();
  await menu.getByRole('menuitemradio', { name: '내 코덱스' }).click();
  await expect(chip).toHaveText('Codex · 내 코덱스');
  await expect.poll(() => (core.cli('snapshot', '--json').sessions as { kind: string; state: string; model?: string }[]).find((s) => s.kind === 'codex' && s.state === 'running')?.model).toBe('gpt-x-preview');
});

test('358 round 2: an old settings file without the key lists the built-ins, and the first add keeps the rest of the file', async ({ app, core }) => {
  core.shell(core.project('demo'), 'main');
  await openWindow(app);
  expect(stored(core)).toBeUndefined();
  await accounts(app, 'Claude');
  await expect(models(app, 'claude').locator('.prv-mr')).toHaveCount(4);
  await add(app, 'claude', 'claude-x-preview');
  await expect.poll(() => stored(core)).toEqual({ claude: [{ id: 'claude-x-preview' }] });
  expect(JSON.parse(fs.readFileSync(path.join(core.home, 'settings.json'), 'utf8')).worktrees_dir).toBe(path.join(core.home, 'wt'));
});

test('358 round 2: removing a model that is the default clears that default, and a new session no longer starts on it', async ({ app, core }) => {
  const dir = core.project('demo');
  core.shell(dir, 'main');
  await openWindow(app);
  await seed(app, { claude: [{ id: 'claude-x-preview', name: '내 모델' }] });
  const DEFAULTS = 'agents.new_session_defaults';
  await setWindowFeature(app, DEFAULTS, { all: { claude: { model: 'claude-x-preview', effort: 'high' }, codex: { model: 'gpt-6-sol' } }, projects: { [dir]: { claude: { model: 'claude-x-preview' } } } });
  await app.reload();
  await accounts(app, 'Claude');
  await row(app, 'claude', 'claude-x-preview').getByRole('button', { name: 'Remove claude-x-preview' }).click();
  await expect(row(app, 'claude', 'claude-x-preview')).toHaveCount(0);
  await expect
    .poll(async () => {
      const d = await windowFeature(app, DEFAULTS);
      return [d.all.claude.model ?? null, d.all.claude.effort, d.all.codex.model, d.projects[dir].claude.model ?? null];
    })
    .toEqual([null, 'high', 'gpt-6-sol', null]);
  await closeSettings(app);
  await app.keyboard.press('Meta+KeyK');
  await app.getByRole('dialog', { name: 'Command palette' }).locator('[data-command="session.new"]').click();
  await app.getByRole('dialog', { name: 'New tab' }).getByRole('option', { name: /^Claude/ }).first().click();
  await expect.poll(() => (core.cli('snapshot', '--json').sessions as { kind: string; model?: string | null }[]).filter((x) => x.kind === 'claude').map((x) => x.model ?? null)).toEqual([null]);
});

test('358 round 2: a removal the core refuses keeps the model, its off state and its default', async ({ app, core }) => {
  core.shell(core.project('demo'), 'main');
  await openWindow(app);
  await seed(app, { claude: [{ id: 'claude-x-preview', name: '내 모델' }] });
  await setWindowFeature(app, 'agents.models_off', { claude: ['claude-x-preview'] });
  await setWindowFeature(app, 'agents.new_session_defaults', { all: { claude: { model: 'claude-x-preview' } }, projects: {} });
  await app.reload();
  await accounts(app, 'Claude');
  fs.writeFileSync(path.join(core.home, 'settings.json'), 'not json'); // the core reads the file before it writes, and refuses this
  await row(app, 'claude', 'claude-x-preview').getByRole('button', { name: 'Remove claude-x-preview' }).click();
  await expect(models(app, 'claude').getByRole('alert')).toContainText('invalid settings');
  await expect(row(app, 'claude', 'claude-x-preview').getByRole('switch', { name: '내 모델' })).not.toBeChecked();
  expect((await windowFeature(app, 'agents.models_off')).claude).toEqual(['claude-x-preview']);
  expect((await windowFeature(app, 'agents.new_session_defaults')).all.claude.model).toBe('claude-x-preview');
});

test('358 round 2: a save rewrites only the entry it changes; what this version cannot read stays stored', async ({ app, core }) => {
  core.shell(core.project('demo'), 'main');
  await openWindow(app);
  const other = [{ id: '-not-a-word', note: 'kept' }, { id: 'gpt-x-preview' }];
  const later = [{ id: 'some-model' }];
  await seed(app, { claude: [{ id: '--odd' }, { id: 'claude-a', name: 'A' }], codex: other, gemini: later });
  await accounts(app, 'Claude');
  await add(app, 'claude', 'claude-b');
  await expect.poll(() => stored(core)).toEqual({ claude: [{ id: '--odd' }, { id: 'claude-a', name: 'A' }, { id: 'claude-b' }], codex: other, gemini: later });
  await row(app, 'claude', 'claude-a').getByRole('button', { name: 'Remove claude-a' }).click();
  await expect.poll(() => stored(core)).toEqual({ claude: [{ id: '--odd' }, { id: 'claude-b' }], codex: other, gemini: later });
});

test('358 round 2: on read a repeated id counts once and a display name the core would refuse falls back to the id', () => {
  expect(
    cleanCustomModels({
      claude: [{ id: 'dup', name: 'First' }, { id: 'dup', name: 'Second' }, { id: 'bad-name', name: 'a\u0000b' }, { id: 'long-name', name: 'x'.repeat(65) }, { id: '-flag' }, 'junk'],
    }).claude,
  ).toEqual([{ id: 'dup', name: 'First' }, { id: 'bad-name' }, { id: 'long-name' }]);
});
