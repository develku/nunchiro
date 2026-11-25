// Ticket 358 against a real core with fake agents: a failed row carries its actions (diagnostics with no variable value,
// logs, docs, recheck), a tile carries its links, every link is https from the fixed tables, and a display name changes what
// the row and New session show without asking for approval again.
import type { Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { agentsToml, entryHash, fakeAcp, ownerOk, tomlEntry } from './acp-fakes';
import { openAdd, openRow } from './accounts-rows';
import { expect, openWindow, test, type Core, codexFake } from './fixtures';
import { openSettings } from './settings-modal';

// Inherited by the fixture's core (fixtures.ts keeps every variable but its own prefixes).
const PLANTED = 'planted-value-7f3a91';
process.env.ACCOUNTS_PLANTED = PLANTED;

/** The clipboard and `window.open` as recorders (WebKit has no clipboard-write permission). */
const stubs = (app: Page) =>
  app.addInitScript(() => {
    const w = window as unknown as { __clip: string[]; __opened: string[] };
    w.__clip = [];
    w.__opened = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t: string) => void w.__clip.push(t) } });
    window.open = ((url: string) => (w.__opened.push(url), null)) as typeof window.open;
  });
const clip = (app: Page) => app.evaluate(() => (window as unknown as { __clip: string[] }).__clip);
const opened = (app: Page) => app.evaluate(() => (window as unknown as { __opened: string[] }).__opened);
async function accounts(app: Page) {
  await stubs(app);
  await openWindow(app);
  await openSettings(app);
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Providers' }).click();
  await expect(app.locator('#s-accounts .prv-tile').first()).toBeVisible();
}
const row = (app: Page, name: string) => app.locator(`#s-accounts .acct-agent[data-agent="${name}"]`);
const tile = (app: Page, name: string) => app.locator(`#s-accounts [data-tile="${name}"]`);
function approve(core: Core, name: string) {
  ownerOk(core, { op: 'acp_agent_grant', name, hash: ownerOk(core, { op: 'acp_agent_status', name }).view.hash });
}

test('failed_row_actions: diagnostics name the failure and carry no value; logs and docs open', async ({ app, core }) => {
  const cmd = path.join(core.home, 'bin/gemini');
  fs.writeFileSync(cmd, `#!/bin/sh\necho "gemini 0.9.1 ${PLANTED}"\n`, { mode: 0o700 });
  fs.writeFileSync(agentsToml(core), tomlEntry('gemini', cmd, ['--experimental-acp', `--key=${PLANTED}`], ['ACCOUNTS_PLANTED', 'GEMINI_API_KEY']));
  approve(core, 'gemini');
  await accounts(app);
  const r = row(app, 'gemini');
  await expect(r.locator('.prv-row')).toContainText('Failed');
  await expect(r.locator('[data-field="env-missing"]')).toContainText('GEMINI_API_KEY missing');
  await r.getByRole('button', { name: 'Copy diagnostics' }).click();
  await expect(r.getByRole('button', { name: 'Copied' })).toBeVisible();
  const [text] = await clip(app);
  expect(text).toContain('failure: variable missing');
  expect(text).toContain('GEMINI_API_KEY: unset');
  expect(text).toContain('ACCOUNTS_PLANTED: set');
  expect(text).toContain('version: 0.9.1');
  expect(text).not.toContain(PLANTED);
  // Outside the app the logs folder is shown to copy; in the app it opens in Finder (the real RC proves that).
  await r.getByRole('button', { name: 'Open logs' }).click();
  await expect(r.locator('[data-field="logs-path"]')).toContainText(path.join(fs.realpathSync(core.home), 'logs'));
  await r.getByRole('button', { name: 'Open docs' }).click();
  await expect.poll(() => opened(app)).toEqual(['https://geminicli.com/docs/']);
});

test('failed_row_recheck: the cause fixed outside the app, Check again returns the row to Approved', async ({ app, core }) => {
  const cmd = fakeAcp(core, 'tool', 'tool 1.0');
  const script = fs.readFileSync(cmd);
  fs.writeFileSync(agentsToml(core), tomlEntry('tool', cmd));
  approve(core, 'tool');
  fs.rmSync(cmd);
  await accounts(app);
  const r = row(app, 'tool');
  await expect(r.locator('.prv-row')).toContainText('Not installed'); // ticket 391: a missing program's chip reads 설치 안 됨
  // A custom entry has no confirmed page, so no button.
  await expect(r.getByRole('button', { name: 'Open docs' })).toHaveCount(0);
  fs.writeFileSync(cmd, script, { mode: 0o700 });
  await r.getByRole('button', { name: 'Check again' }).click();
  await expect(r.locator('.prv-row')).toContainText('Approved');
  await expect(r.getByRole('button', { name: 'Copy diagnostics' })).toHaveCount(0);
});

test('failed_login_row: Codex after a login tab ended unsigned has the same actions', async ({ app, core }) => {
  fs.writeFileSync(path.join(core.home, 'bin/codex'), codexFake(`#!/bin/sh\ncase "$1" in --version) echo "codex 0.161.0"; exit 0;; login) [ "$2" = status ] && { [ -e "$CODEX_HOME/.in" ] && { echo 'Logged in using ChatGPT' >&2; exit 0; }; echo 'Not logged in' >&2; exit 1; }; exit 0;; esac\nexec /bin/cat\n`), { mode: 0o700 });
  core.shell(core.project('demo'), 'alpha');
  await accounts(app);
  await openRow(app, 'Codex');
  await openAdd(app, 'codex');
  await app.getByRole('group', { name: 'Add Codex account' }).getByRole('textbox', { name: 'Name' }).fill('team');
  await app.getByRole('button', { name: 'Sign in using a terminal instead' }).click();
  const r = row(app, 'codex');
  await expect(r).toContainText('The sign-in tab ended without signing in.', { timeout: 20_000 });
  await r.getByRole('button', { name: 'Copy diagnostics' }).click();
  const [text] = await clip(app);
  expect(text).toContain('name: codex');
  expect(text).toContain('failure: login ended');
  expect(text).toContain('version: 0.161.0');
  await r.getByRole('button', { name: 'Open docs' }).click();
  await expect.poll(async () => (await opened(app))[0] ?? '').toMatch(/^https:\/\//);
  const folder = fs.readdirSync(path.join(core.home, 'accounts/codex'))[0];
  fs.writeFileSync(path.join(core.home, 'accounts/codex', folder, '.in'), '');
  await r.getByRole('button', { name: 'Check again' }).click();
  await expect(r.getByRole('button', { name: 'Copy diagnostics' })).toHaveCount(0);
  await expect(r.locator('.prv-row')).toContainText('Signed in');
});

test('tile_info: the mark sits beside the tile button and opens Docs and Source, every link https', async ({ app }) => {
  await accounts(app);
  const pi = app.locator('#s-accounts .prv-slot:has([data-tile="pi"])');
  // A sibling: a button cannot hold another control.
  await expect(tile(app, 'pi').locator('summary, button')).toHaveCount(0);
  // Pi's mark is drawn before the core's rows arrive; their tiles then move it, and a click in that moment left it shut.
  const marks = app.locator('#s-accounts .prv-info');
  await expect.poll(() => marks.count()).toBeGreaterThan(8);
  await pi.getByLabel('Links for Pi').click();
  await pi.getByRole('button', { name: 'Docs' }).click();
  await pi.getByRole('button', { name: 'Source' }).click();
  await expect.poll(() => opened(app)).toEqual(['https://pi.dev/docs/latest', 'https://github.com/earendil-works/pi']);
  // The press opened the links only: no install page and no form.
  await expect(app.locator('#s-accounts .prv-exp.f')).toHaveCount(0);
  await pi.getByLabel('Links for Pi').click();
  // Every link on the page.
  for (const mark of await marks.all()) {
    await mark.locator('summary').click();
    for (const link of await mark.locator('.acct-menu button').all()) await link.click();
    await mark.locator('summary').click();
  }
  for (const url of await opened(app)) expect(url).toMatch(/^https:\/\//);
});

test('display_name: the row and New session show it, the entry stays approved with no second approval', async ({ app, core }) => {
  const cmd = fakeAcp(core, 'gemini', 'gemini 0.9.1');
  fs.writeFileSync(agentsToml(core), tomlEntry('gemini', cmd, ['--experimental-acp']));
  approve(core, 'gemini');
  const hash = entryHash({ name: 'gemini', command: cmd, args: ['--experimental-acp'], env: [] });
  core.shell(core.project('demo'), 'alpha');
  await accounts(app);
  await openRow(app, 'gemini');
  const r = row(app, 'gemini');
  await r.getByRole('button', { name: 'Change' }).click();
  const field = r.getByRole('textbox', { name: 'Display name' });
  await expect(field).toHaveValue('Gemini CLI');
  await expect(field).toBeFocused();
  await field.fill('내 제미니');
  // A name change needs no check and no approval.
  await expect(r.getByRole('button', { name: 'Approve and add' })).toHaveCount(0);
  await r.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(r.locator('.prv-name')).toHaveText('내 제미니');
  await expect(r.locator('.prv-row')).toContainText('Approved');
  expect(ownerOk(core, { op: 'acp_agent_status', name: 'gemini' }).view).toMatchObject({ state: 'approved', hash });
  expect(fs.readFileSync(agentsToml(core), 'utf8')).toContain('display = "내 제미니"');
  await app.keyboard.press('Escape');
  await app.keyboard.press('Meta+KeyT');
  await expect(app.locator('#newtab-list .nt-name').filter({ hasText: '내 제미니' })).toBeVisible();
});

test('links_checked_at_the_button: an http link that reaches the window draws no button', async ({ app, core }) => {
  const cmd = fakeAcp(core, 'gemini', 'gemini 0.9.1');
  fs.writeFileSync(agentsToml(core), tomlEntry('gemini', cmd, ['--experimental-acp'], ['GEMINI_API_KEY']));
  approve(core, 'gemini');
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => server.send(m));
    server.onMessage((m) => {
      const reply = typeof m === 'string' ? JSON.parse(m) : null;
      if (reply?.response?.Ok?.type !== 'acp_agents') return ws.send(m);
      for (const r of reply.response.Ok.acp) if (r.name === 'gemini') Object.assign(r, { docs_url: 'http://evil.example/', source_url: 'http://evil.example/src' });
      ws.send(JSON.stringify(reply));
    });
  });
  await accounts(app);
  const r = row(app, 'gemini');
  await expect(r.getByRole('button', { name: 'Copy diagnostics' })).toBeVisible();
  await expect(r.getByRole('button', { name: 'Open docs' })).toHaveCount(0);
  await expect(tile(app, 'gemini')).toBeVisible();
  await expect(app.locator('#s-accounts .prv-slot:has([data-tile="opencode"]) .prv-info')).toBeVisible();
  await expect(app.locator('#s-accounts .prv-slot:has([data-tile="gemini"])')).toHaveCount(0);
});
