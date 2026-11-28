// Ticket 355, against a real core with fake ACP agents: the add flow's promises. The confined check comes before approval; a
// variable field holds names and refuses a value; only what the form showed is granted; any change needs approval again.
import type { Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { agentsToml, entryHash, fakeAcp, fakeTerminalCli, ownerOk, tomlEntry } from './acp-fakes';
import { openAdd, openRow } from './accounts-rows';
import { expect, openWindow, test, type Core, codexFake } from './fixtures';
import { openSettings } from './settings-modal';

async function accounts(app: Page) {
  await openWindow(app);
  await openSettings(app);
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Providers' }).click();
  await expect(app.locator('#s-accounts .prv-tile').first()).toBeVisible();
}
const tile = (app: Page, name: string) => app.locator(`#s-accounts [data-tile="${name}"]`);
const form = (app: Page, name: string | RegExp) => app.locator('#s-accounts').getByRole('group', { name });
const approveOf = (f: ReturnType<typeof form>) => f.getByRole('button', { name: 'Approve and add' });
const approvals = (core: Core) => path.join(core.home, 'approvals.json');
function sent(app: Page) {
  const frames: any[] = [];
  app.on('websocket', (ws) =>
    ws.on('framesent', (f) => {
      try {
        const j = JSON.parse(String(f.payload));
        if (j.request) frames.push(j.request);
      } catch {
        // not JSON
      }
    }),
  );
  return frames;
}

test('check_before_approve: an API key tile fills the form, approve appears only after the check, a missing key is reported', async ({ app, core }) => {
  const cmd = fakeAcp(core, 'opencode', 'opencode 1.2.4', [], 1.5);
  const frames = sent(app);
  await accounts(app);
  await tile(app, 'openrouter').click();
  const f = form(app, 'OpenRouter');
  await expect(f.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('openrouter');
  await expect(f.getByRole('textbox', { name: 'Command' })).toHaveValue(`${cmd} acp`);
  await expect(f.locator('.prv-tag')).toHaveText(['OPENROUTER_API_KEY×']);
  // Opening a tile runs nothing: the check waits for the owner's click, and until it finished there is no approval to give.
  await app.waitForTimeout(800);
  expect(frames.filter((x) => x.op === 'acp_agent_check')).toHaveLength(0);
  await expect(f.locator('[data-field="check-result"]')).toHaveText('Not checked');
  await expect(approveOf(f)).toHaveCount(0);
  await f.getByRole('button', { name: 'Check', exact: true }).click();
  await expect(approveOf(f)).toHaveCount(0);
  await expect(approveOf(f)).toBeVisible({ timeout: 20_000 });
  await expect(f.locator('[data-field="check-result"]')).toHaveText('Variable missing');
  await expect(f).toContainText('opencode 1.2.4 · ACP v1');
  await expect(f.locator('[data-field="env-missing"]')).toContainText('OPENROUTER_API_KEY missing');
  await approveOf(f).click();
  // Only the name is stored, the grant is the hash of what was shown, and the row says the key is missing.
  const shown = { name: 'openrouter', command: cmd, args: ['acp'], env: ['OPENROUTER_API_KEY'] };
  expect(frames.find((x) => x.op === 'acp_agent_add').entry).toEqual(shown);
  await expect.poll(() => frames.find((x) => x.op === 'acp_agent_grant')?.hash).toBe(entryHash(shown));
  const row = app.locator('#s-accounts .acct-agent[data-agent="openrouter"]');
  await expect(row.locator('.prv-name')).toHaveText('OpenRouter');
  await expect(row.locator('.prv-meta')).toHaveText('OpenCode');
  await expect(row).toContainText('Failed');
  await expect(row.locator('[data-field="env-missing"]')).toContainText('OPENROUTER_API_KEY missing');
  await row.getByRole('button', { name: 'How to set it' }).click();
  await expect(row.locator('[data-field="env-howto"]')).toContainText('launchctl setenv OPENROUTER_API_KEY');
  await expect(tile(app, 'openrouter').locator('.tl-check')).toBeVisible();
});

test('variable_field_refuses_a_value: a pasted key is cleared, never shown again and never stored', async ({ app, core }) => {
  const cmd = fakeAcp(core, 'tool', 'tool 1.0');
  const secret = 'sk-or-v1-abcdef0123456789';
  await accounts(app);
  await app.getByRole('button', { name: 'Enter manually' }).click();
  const f = form(app, 'Enter manually');
  await f.getByRole('textbox', { name: 'Name', exact: true }).fill('tool');
  await f.getByRole('textbox', { name: 'Command' }).fill(cmd);
  const field = f.getByRole('textbox', { name: 'Variable names' });
  await field.fill(secret);
  await field.press('Enter');
  await expect(f.locator('[data-field="env-error"]')).toBeVisible();
  await expect(field).toHaveValue('');
  await expect(f.locator('.prv-tag')).toHaveCount(0);
  await expect(app.locator('#s-accounts')).not.toContainText(secret);
  // A name goes through, and nothing runs until the owner asks: a typed command is not checked by itself.
  await field.fill('MY_TOOL_KEY');
  await field.press('Enter');
  await expect(f.locator('.prv-tag')).toHaveText(['MY_TOOL_KEY×']);
  await expect(f.locator('[data-field="check-result"]')).toHaveText('Not checked');
  await expect(approveOf(f)).toHaveCount(0);
  await f.getByRole('button', { name: 'Check', exact: true }).click();
  await expect(approveOf(f)).toBeVisible({ timeout: 20_000 });
  await approveOf(f).click();
  await expect(app.locator('#s-accounts .acct-agent[data-agent="tool"]')).toBeVisible();
  const toml = fs.readFileSync(agentsToml(core), 'utf8');
  expect(toml).toContain('MY_TOOL_KEY');
  expect(toml).not.toContain(secret);
  // The core refuses a value too, whatever the window sends, and does not repeat it.
  const refused = JSON.stringify(
    (await import('./acp-fakes')).owner(core, { op: 'acp_agent_add', entry: { name: 'bad', command: cmd, args: [], env: [secret] } }),
  );
  expect(refused).toContain('names only');
  expect(refused).not.toContain(secret);
});

test('approved_entries_are_read_only: a change is checked and approved again; remove asks twice', async ({ app, core }) => {
  const cmd = fakeAcp(core, 'tool', 'tool 1.0');
  fs.writeFileSync(agentsToml(core), tomlEntry('tool', cmd, ['--a'], []));
  ownerOk(core, { op: 'acp_agent_grant', name: 'tool', hash: ownerOk(core, { op: 'acp_agent_status', name: 'tool' }).view.hash });
  await accounts(app);
  await openRow(app, 'tool');
  const row = app.locator('#s-accounts .acct-agent[data-agent="tool"]');
  await expect(row.getByRole('textbox')).toHaveCount(0);
  await expect(row).toContainText(`${cmd} --a`);
  await row.getByRole('button', { name: 'Change' }).click();
  const f = form(app, 'tool');
  await expect(approveOf(f)).toHaveCount(0);
  await f.getByRole('textbox', { name: 'Command' }).fill(`${cmd} --b`);
  await f.getByRole('button', { name: 'Check', exact: true }).click();
  await expect(approveOf(f)).toBeVisible({ timeout: 20_000 });
  await approveOf(f).click();
  // The chip said Approved for the old entry all along; the form closing and the new command shown read-only are the grant's answer.
  await expect(row.getByRole('textbox')).toHaveCount(0);
  await expect(row).toContainText(`${cmd} --b`);
  await expect(row).toContainText('Approved');
  const view = ownerOk(core, { op: 'acp_agent_status', name: 'tool' }).view;
  expect(view).toMatchObject({ state: 'approved', hash: entryHash({ name: 'tool', command: cmd, args: ['--b'], env: [] }) });
  await openRow(app, 'tool');
  await row.getByRole('button', { name: 'Remove' }).click();
  expect(fs.readFileSync(agentsToml(core), 'utf8')).toContain('tool');
  await row.getByRole('button', { name: 'Remove permanently?' }).click();
  await expect(row).toHaveCount(0);
  expect(fs.readFileSync(agentsToml(core), 'utf8')).not.toContain('--b');
});

test('entry_changed_on_disk_is_shown_read_only_runs_only_on_a_click_and_a_race_grants_nothing', async ({ app, core }) => {
  const cmd = fakeAcp(core, 'tool', 'tool 1.0');
  fs.writeFileSync(agentsToml(core), tomlEntry('tool', cmd, ['--a'], []));
  ownerOk(core, { op: 'acp_agent_grant', name: 'tool', hash: ownerOk(core, { op: 'acp_agent_status', name: 'tool' }).view.hash });
  // An agent swaps the entry after the approval.
  fs.writeFileSync(agentsToml(core), tomlEntry('tool', cmd, ['--swapped'], ['AWS_SECRET_ACCESS_KEY']));
  const frames = sent(app);
  await accounts(app);
  await openRow(app, 'tool');
  const f = form(app, 'tool');
  await expect(f.getByRole('textbox', { name: 'Command' })).toHaveValue(`${cmd} --swapped`);
  await expect(f.getByRole('textbox', { name: 'Command' })).not.toBeEditable();
  await expect(f.locator('.prv-tag')).toHaveText(['AWS_SECRET_ACCESS_KEY']);
  await app.waitForTimeout(1200);
  expect(frames.filter((x) => x.op === 'acp_agent_check')).toHaveLength(0);
  await f.getByRole('button', { name: 'Check', exact: true }).click();
  await expect(approveOf(f)).toBeVisible({ timeout: 20_000 });
  expect(frames.filter((x) => x.op === 'acp_agent_check')[0].confirmed).toBe(true);
  // Rewritten once more after the form showed it: nothing is granted.
  const before = fs.readFileSync(approvals(core), 'utf8');
  fs.writeFileSync(agentsToml(core), tomlEntry('tool', cmd, ['--evil'], []));
  await approveOf(f).click();
  await expect(f.locator('[data-field="error"]')).toContainText('The entry changed; review it again.');
  expect(fs.readFileSync(approvals(core), 'utf8')).toBe(before);
});

test('control_characters_are_escaped_and_nothing_is_cut', async ({ app, core }) => {
  const cmd = fakeAcp(core, 'tool', 'tool 1.0');
  const long = `--flag=${'x'.repeat(300)}`;
  fs.writeFileSync(agentsToml(core), `[[agent]]\nname = "tool"\ncommand = ${JSON.stringify(cmd)}\nargs = ["a\\u0007b", ${JSON.stringify(long)}]\nenv = []\n`);
  await accounts(app);
  await openRow(app, 'tool');
  const box = form(app, 'tool').getByRole('textbox', { name: 'Command' });
  await expect(box).toHaveValue(new RegExp(`\\\\u\\{7\\}b.*${long}`));
  const size = await box.evaluate((el: HTMLTextAreaElement) => ({ scroll: el.scrollHeight, client: el.clientHeight }));
  expect(size.scroll).toBeLessThanOrEqual(size.client + 2);
});

test('tiles_route_by_what_each_tool_can_do', async ({ app, core }) => {
  fakeTerminalCli(core, 'aider', 'aider 0.86');
  fakeAcp(core, 'gemini', 'gemini 0.11.2');
  await app.addInitScript(() => ((window as any).open = (u: string) => (((window as any).__opened = u), null)));
  await accounts(app);
  // Terminal only: no ACP form for Aider.
  await expect(tile(app, 'aider')).toContainText('Terminal only');
  await expect(tile(app, 'aider').and(app.locator('button'))).toHaveCount(0);
  // A listed agent: its four steps with the install command, no page opened and no bare form.
  await tile(app, 'cursor').click();
  expect(await app.evaluate(() => (window as any).__opened)).toBeUndefined();
  await expect(app.locator('[data-field="acp-steps"]')).toContainText('curl https://cursor.com/install -fsS | bash');
  await expect(form(app, 'Cursor').getByRole('textbox', { name: 'Command' })).toHaveCount(0);
  // No confirmed ACP switch: the install page and the blank form.
  await tile(app, 'pi').click();
  expect(await app.evaluate(() => (window as any).__opened)).toBe('https://pi.dev');
  await expect(form(app, 'Pi').getByRole('textbox', { name: 'Command' })).toHaveValue('');
  // GLM names no variable in its own docs: prefilled blank.
  await tile(app, 'glm').click();
  await expect(form(app, 'GLM').locator('.prv-tag')).toHaveCount(0);
  await tile(app, 'kimi').click();
  await expect(form(app, 'Kimi').locator('.prv-tag')).toHaveText(['MOONSHOT_API_KEY×']);
  // No "new" chips from the mock, and every group is complete.
  await expect(app.locator('#s-accounts')).not.toContainText('새로 필요');
  await expect(app.locator('#s-accounts .prv-tile')).toHaveCount(21);
  // A listed agent's tile says what it costs.
  await expect(tile(app, 'gemini')).toContainText('Paid key');
  // vc-4 (look 1117): every tile says its state; Muse Code (no install page known) is set up by hand.
  await expect(tile(app, 'muse').locator('.prv-st')).toHaveText('Set up');
  for (const st of await app.locator('#s-accounts .prv-tile .prv-st').allTextContents()) expect(st.trim()).not.toBe('');
});

test('terminal_login_that_ends_unsigned_says_so_on_its_row', async ({ app, core }) => {
  fs.writeFileSync(path.join(core.home, 'bin/codex'), codexFake(`#!/bin/sh\ncase "$1" in --version) echo "codex 0.161.0"; exit 0;; login) [ "$2" = status ] && { echo 'Not logged in' >&2; exit 1; }; exit 0;; esac\nexec /bin/cat\n`), { mode: 0o700 });
  core.shell(core.project('demo'), 'alpha');
  await accounts(app);
  await openRow(app, 'Codex');
  await openAdd(app, 'codex');
  await app.getByRole('group', { name: 'Add Codex account' }).getByRole('textbox', { name: 'Name' }).fill('team');
  await app.getByRole('button', { name: 'Sign in using a terminal instead' }).click();
  const row = app.locator('#s-accounts .acct-agent[data-agent="codex"]');
  await expect(row).toContainText('The sign-in tab ended without signing in.', { timeout: 20_000 });
  await expect(row.locator('.prv-row')).toContainText('team failed');
  await expect(row.getByRole('button', { name: 'Sign in again' })).toBeVisible();
});
