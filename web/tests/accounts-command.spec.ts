// Ticket 358 (327): Claude's and Codex's own command on Settings > Accounts, against a real core and fake agents that log
// how they were launched. Sessions start over the window's own socket, so they are owner starts.
import AxeBuilder from '@axe-core/playwright';
import type { Locator, Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ownerOk, owner } from './acp-fakes';
import { openRow } from './accounts-rows';
import { expect, openWindow, test, type Core } from './fixtures';
import { openSettings } from './settings-modal';

/** A fake agent: answers `--version`, and logs `<path> <args>` to `<path>.log` when run as a session. */
function fake(file: string, version: string) {
  fs.writeFileSync(file, `#!/bin/sh\n[ "$1" = --version ] && { echo '${version}'; exit 0; }\necho "$0 $*" > "$0.log"\nexec /bin/cat\n`, { mode: 0o700 });
  return file;
}
function agents(core: Core) {
  fake(path.join(core.home, 'bin', 'claude'), 'claude 1.0.0');
  fake(path.join(core.home, 'bin', 'codex'), 'codex-cli 1.0.0');
  return { claude: fake(path.join(core.home, 'my-claude'), 'claude 2.1.319'), codex: fake(path.join(core.home, 'my-codex'), 'codex-cli 0.161.0') };
}
async function openAccounts(app: Page) {
  await openSettings(app);
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Providers' }).click();
}
const row = (app: Page, agent: string): Locator => app.locator(`[data-field="command"][data-agent="${agent}"]`);
const change = (app: Page, agent: string) => row(app, agent).getByRole('button', { name: 'Change', exact: true }).click();
const check = (app: Page, agent: string) => row(app, agent).getByRole('button', { name: /^Check/ }).click();
const approveButton = (app: Page, agent: string) => row(app, agent).getByRole('button', { name: 'Approve and save' });

/** Starts a session the way the window does; the reply is the core's. */
function start(app: Page, project: string, kind: 'claude' | 'codex') {
  return app.evaluate(
    ([p, k]) =>
      new Promise<{ Ok?: { session: { id: string; state: string } }; Err?: string }>((ok) => {
        const ws = new WebSocket(`ws://127.0.0.1:${window.__NUNCHIRO__!.port}/ws`, ['nunchiro.v1', `nunchiro.token.${window.__NUNCHIRO__!.token}`]);
        ws.onopen = () => ws.send(JSON.stringify({ id: 1, request: { op: 'start', session: { kind: k, project: p, label: k, model: null, effort: null, resume: null } } }));
        ws.onmessage = (e) => {
          const m = JSON.parse(e.data);
          if (m.id === 1) (ws.close(), ok(m.response));
        };
      }),
    [project, kind],
  );
}
/** The log of the session started after this call: the old log is cleared first. */
async function launched(app: Page, core: Core, kind: 'claude' | 'codex', file: string, project = core.project('demo')) {
  fs.rmSync(`${file}.log`, { force: true });
  const reply = await start(app, project, kind);
  expect(reply.Ok?.session.state, JSON.stringify(reply)).toBeTruthy();
  await expect.poll(() => fs.existsSync(`${file}.log`), { timeout: 15_000 }).toBe(true);
  return fs.readFileSync(`${file}.log`, 'utf8');
}
/** Folders a test made outside its core's home, removed after it (the core has stopped by then). */
const temps: string[] = [];
test.afterEach(() => {
  for (const d of temps.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
// The row shows ~ for the home folder (ticket 471); a checkout under the home folder (the nightly's) puts the test home there.
const tilde = (p: string) => (p.startsWith(`${os.homedir()}/`) ? `~${p.slice(os.homedir().length)}` : p);
const approve = (core: Core, agent: string, file: string, args: string[]) => {
  const { check: result } = ownerOk(core, { op: 'agent_command_check', agent, path: file, args, env: [] });
  return ownerOk(core, { op: 'agent_command_grant', agent, hash: result.hash });
};

test('accounts_command: approve only after the check; a change waits for approval while the old command runs', async ({ app, core }) => {
  const { claude } = agents(core);
  await openWindow(app);
  await openAccounts(app);
  await openRow(app, 'Claude');
  const first = row(app, 'claude');
  await expect(first).toContainText(tilde(path.join(core.home, 'bin', 'claude')));
  await expect(first).toContainText('no arguments');

  await change(app, 'claude');
  await new AxeBuilder({ page: app }).include('[data-field="command"]').analyze().then((r) => expect(r.violations).toEqual([]));
  await first.getByLabel('Executable path').fill(claude);
  await first.getByLabel('Arguments').fill('--verbose');
  await expect(approveButton(app, 'claude')).toHaveCount(0);
  await check(app, 'claude');
  await expect(first.locator('[data-field="check-result"]')).toHaveText('Passed');
  await expect(first).toContainText('claude 2.1.319');
  // A change after a pass takes the button away again.
  await first.getByLabel('Arguments').fill('--verbose --x');
  await expect(approveButton(app, 'claude')).toHaveCount(0);
  await first.getByLabel('Arguments').fill('--verbose');
  await check(app, 'claude');
  await approveButton(app, 'claude').click();
  await expect(first.locator('.mono').first()).toHaveText(tilde(claude));
  await expect(first).toContainText('--verbose');
  expect(await launched(app, core, 'claude', claude)).toContain(`${claude} `);

  await change(app, 'claude');
  await first.getByLabel('Arguments').fill('--debug');
  await check(app, 'claude');
  await expect(first.locator('[data-field="check-result"]')).toHaveText('Passed');
  // Left without pressing approve: the row says so and new sessions keep the approved command.
  await openRow(app, 'Claude');
  await app.locator('#s-accounts [data-row="claude"] .prv-chv').click();
  await openRow(app, 'Claude');
  const again = row(app, 'claude');
  await expect(again.locator('[data-field="command-pending"]')).toContainText('--debug');
  let log = await launched(app, core, 'claude', claude);
  expect(log).toContain('--verbose');
  expect(log).not.toContain('--debug');

  await change(app, 'claude');
  await check(app, 'claude');
  await approveButton(app, 'claude').click();
  await expect(again.locator('[data-field="command-pending"]')).toHaveCount(0);
  log = await launched(app, core, 'claude', claude);
  expect(log).toContain('--debug');
  expect(log).not.toContain('--verbose');
});

test('accounts_command: a tampered file refuses the start and the row says why; reset returns to PATH', async ({ app, core }) => {
  const { claude } = agents(core);
  approve(core, 'claude', claude, ['--verbose']);
  const stored = path.join(core.home, 'agent-commands', 'claude.json');
  fs.writeFileSync(stored, fs.readFileSync(stored, 'utf8').replace('--verbose', '--evil'));
  await openWindow(app);
  await openAccounts(app);
  await openRow(app, 'Claude');
  await expect(row(app, 'claude').locator('[data-field="command-refused"]')).toContainText('changed since it was approved');

  const reply = await start(app, core.project('demo'), 'claude');
  expect(reply.Err).toContain('changed since');
  expect(fs.existsSync(`${claude}.log`)).toBe(false);

  await change(app, 'claude');
  await row(app, 'claude').getByRole('button', { name: 'Reset to default' }).click();
  const first = row(app, 'claude');
  await expect(first).toContainText(tilde(path.join(core.home, 'bin', 'claude')));
  await expect(first).toContainText('no arguments');
  await expect(first.locator('[data-field="command-refused"]')).toHaveCount(0);
  const onPath = path.join(core.home, 'bin', 'claude');
  expect(await launched(app, core, 'claude', onPath)).not.toContain('--verbose');
});

test('accounts_command: Cancel drops the held change and keeps the approved command', async ({ app, core }) => {
  const { claude } = agents(core);
  approve(core, 'claude', claude, ['--verbose']);
  await openWindow(app);
  await openAccounts(app);
  await openRow(app, 'Claude');
  await change(app, 'claude');
  const first = row(app, 'claude');
  await first.getByLabel('Arguments').fill('--debug');
  await check(app, 'claude');
  await expect(first.locator('[data-field="check-result"]')).toHaveText('Passed');
  // Q9 en-b-J14-1: an edit after the passed check clears the result, but the core still holds the checked command.
  await first.getByLabel('Arguments').fill('--debug --trace');
  await expect(first.locator('[data-field="check-result"]')).toHaveText('Not checked');
  await first.getByRole('button', { name: 'Cancel' }).click();
  await expect(first.locator('[data-field="command-pending"]')).toHaveCount(0);
  await expect(first).toContainText('--verbose');
  expect(owner(core, { op: 'agent_command_status', agent: 'claude' }).Ok?.view.pending).toBeNull();
});

test('accounts_command: Codex with an argument has no hooks and says so; a path alone keeps them', async ({ app, core }) => {
  const { codex } = agents(core);
  // The core adds Codex hooks only when no Codex config sits in any folder above the session (sessions.rs
  // codex_hooks_exclusive, da5890cb). The test's own folder is under the checkout, so under the developer's home and its
  // own Codex config: the session runs in a folder of the system temp folder instead, checked free of one.
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nx-codex-')));
  temps.push(project);
  const above: string[] = [];
  for (let d = project; ; d = path.dirname(d)) {
    above.push(...['hooks.json', 'config.toml', 'plugins'].map((n) => path.join(d, '.codex', n)).filter((f) => fs.existsSync(f)));
    if (d === path.dirname(d)) break;
  }
  expect(above, 'a Codex config above the temp folder withholds the hooks').toEqual([]);
  approve(core, 'codex', codex, []);
  await openWindow(app);
  expect(await launched(app, core, 'codex', codex, project)).toContain('hooks.');

  approve(core, 'codex', codex, ['--verbose']);
  const log = await launched(app, core, 'codex', codex, project);
  expect(log).toContain('--verbose');
  expect(log).not.toContain('hooks.');
  await openAccounts(app);
  await openRow(app, 'Codex');
  await expect(row(app, 'codex').locator('[data-field="codex-args-note"]')).toContainText('cannot see when the agent waits');
});

test('accounts_command: a value typed as an env name is refused and never saved', async ({ app, core }) => {
  const { claude } = agents(core);
  await openWindow(app);
  await openAccounts(app);
  await openRow(app, 'Claude');
  await change(app, 'claude');
  const first = row(app, 'claude');
  await first.getByLabel('Executable path').fill(claude);
  const name = first.getByRole('textbox', { name: 'Variable names' });
  await name.fill('sk-ant-secret');
  await name.press('Enter');
  await expect(name).toHaveValue('');
  await expect(first.locator('[data-field="env-error"]')).toBeVisible();
  await expect(first).not.toContainText('sk-ant-secret');
  await name.fill('ANTHROPIC_API_KEY');
  await name.press('Enter');
  await check(app, 'claude');
  await approveButton(app, 'claude').click();
  await expect(first.locator('[data-field="env-missing"]')).toContainText('ANTHROPIC_API_KEY');
  const stored = fs.readFileSync(path.join(core.home, 'agent-commands', 'claude.json'), 'utf8');
  expect(stored).not.toContain('sk-ant-secret');
});

// Ticket 471 (looks check 2026-11-14): the Advanced Path row showed the home folder in full. The window shows ~ for it; the
// full path stays in the tooltip. The test home is outside /Users, so the core's replies are rewritten to a home under it.
test('accounts_command_path_shows_home_as_tilde', async ({ app, core }) => {
  agents(core);
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => server.send(m));
    server.onMessage((m) => ws.send(typeof m === 'string' ? m.split(core.home).join('/Users/tester/.nunchiro') : m));
  });
  await openWindow(app);
  await openAccounts(app);
  await openRow(app, 'Claude');
  const shown = row(app, 'claude').locator('.mono').first();
  await expect(shown).toHaveText('~/.nunchiro/bin/claude');
  await expect(shown).toHaveAttribute('title', '/Users/tester/.nunchiro/bin/claude');
});
