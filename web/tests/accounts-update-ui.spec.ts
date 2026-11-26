// Ticket 358, mock #update: the 새 버전 popover and 모두 업데이트 (n), against a real core with the fake tools of
// crates/nunchiro-core/tests/fixtures/accounts/update-fake.sh and a local fake of the npm registry. No real installer runs.
import type { Page } from '@playwright/test';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { agentsToml, ownerOk, tomlEntry } from './acp-fakes';
import { openRow } from './accounts-rows';
import { REPO, expect, openWindow, test, type Core } from './fixtures';

const FAKE = path.join(REPO, 'crates/nunchiro-core/tests/fixtures/accounts/update-fake.sh');
const servers: http.Server[] = [];
test.afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

async function registry(latest: Record<string, string>) {
  const server = http.createServer((req, res) => {
    const version = latest[(req.url ?? '').replace(/^\/|\/latest$/g, '')];
    res.writeHead(version ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(version ? JSON.stringify({ version }) : '');
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
}

function install(from: string, to: string) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  fs.chmodSync(to, 0o700);
}
const NEXT = '2.1.320';
const LATEST = { '@anthropic-ai/claude-code': NEXT, '@openai/codex': NEXT, '@google/gemini-cli': '0.10.0', '@opencode/cli': '1.3.0' };

/** Claude is a native install and Gemini an npm-global install; `codex: false` leaves Codex where its path proves nothing, `geminiAdded: false` leaves Gemini on the PATH but not in Accounts. */
async function setup(app: Page, core: Core, { codex = true, opencode = false, geminiAdded = true } = {}) {
  const user = core.env.HOME!;
  const bin = path.join(core.home, 'bin');
  const write = (name: string, text: string) => fs.writeFileSync(path.join(user, name), `${text}\n`);
  write('fake-version', '1.2.0');
  write('fake-version-claude', '2.1.319 (Claude Code)');
  write('fake-version-codex', 'codex-cli 0.161.0');
  write('fake-version-gemini', '0.9.1');
  write('fake-version-opencode', '1.2.4');
  write('fake-next-version', NEXT);

  const link = (real: string, name: string) => {
    install(FAKE, real);
    fs.rmSync(path.join(bin, name), { force: true });
    fs.symlinkSync(real, path.join(bin, name));
  };
  link(path.join(user, '.local/share/claude/versions/2.1.319'), 'claude');
  if (codex) link(path.join(user, '.codex/packages/standalone/codex'), 'codex');
  else install(FAKE, path.join(bin, 'codex'));
  link(path.join(user, 'npm/lib/node_modules/@google/gemini-cli/cli.js'), 'gemini');
  install(FAKE, path.join(user, 'npm/bin/npm'));
  const added = geminiAdded ? ['gemini'] : [];
  if (opencode) {
    link(path.join(user, 'npm/lib/node_modules/@opencode/cli/cli.js'), 'opencode');
    added.push('opencode');
  }
  fs.writeFileSync(agentsToml(core), added.map((n) => tomlEntry(n, path.join(bin, n))).join('\n'));

  core.run(['serve', 'stop'], 10_000);
  core.env.NUNCHIRO_UPDATE_REGISTRY = await registry(LATEST);
  await core.restart();
  for (const name of added) ownerOk(core, { op: 'acp_agent_grant', name, hash: ownerOk(core, { op: 'acp_agent_status', name }).view.hash });

  const starts: unknown[] = [];
  app.on('websocket', (ws) =>
    ws.on('framesent', ({ payload }) => {
      const request = JSON.parse(String(payload)).request;
      if (request?.op === 'agent_update_start') starts.push(request);
    }),
  );
  await app.addInitScript((boot) => {
    window.__NUNCHIRO__ = boot;
    const w = window as unknown as { __clip: string[] };
    w.__clip = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t: string) => void w.__clip.push(t) } });
  }, core.boot());
  await openWindow(app);
  await app.keyboard.press('Meta+Comma');
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Providers' }).click();
  await expect(row(app, 'claude').locator('.prv-ver')).toHaveText('2.1.319');
  return starts;
}
// Ticket 391: the whole card (head, update strip, open blocks), not only its head.
const row = (app: Page, name: string) => app.locator(`#s-accounts .acct-agent[data-agent="${name}"]`);
const mode = (core: Core, m: string) => fs.writeFileSync(path.join(core.env.HOME!, 'fake-mode'), m);
const log = (core: Core) => fs.readFileSync(path.join(core.env.HOME!, 'update.log'), 'utf8');
const clip = (app: Page) => app.evaluate(() => (window as unknown as { __clip: string[] }).__clip);
const all = (app: Page) => app.locator('#s-accounts .prv-head').getByRole('button', { name: /^Update all/ }); // settings kit: on the Your agents heading, beside Check again
const POLLED = 10_000;

test('threat_update_body: 명령 복사 pastes the table\'s command and 지금 업데이트 sends the tool name alone', async ({ app, core }) => {
  const starts = await setup(app, core);
  mode(core, 'slow');
  const codex = row(app, 'codex');
  await codex.locator('.upd').click();
  await codex.getByRole('button', { name: 'Copy command' }).click();
  expect(await clip(app)).toEqual(['codex update']);
  await expect(codex.getByRole('button', { name: 'Update now' })).toBeHidden();

  await codex.locator('.upd').click();
  await codex.getByRole('button', { name: 'Update now' }).click();
  await expect(codex.locator('.pchip.upd-run')).toHaveText('Updating');
  expect(starts).toEqual([{ op: 'agent_update_start', tool: 'codex' }]);
  await expect(app.locator('#s-accounts .acct-agent[data-agent="codex"] .prv-exp')).toHaveCount(0); // the click stayed on the mark
  await expect.poll(() => fs.existsSync(path.join(core.env.HOME!, 'update.log')) && log(core)).toBe('codex update\n');
  ownerOk(core, { op: 'agent_update_cancel', tool: 'codex' });
});

test('npm_command: the last row\'s popover is not cut off by the card, and an npm install copies its npm command', async ({ app, core }) => {
  await setup(app, core);
  const gemini = row(app, 'gemini');
  await gemini.locator('.upd').click();
  const copy = gemini.getByRole('button', { name: 'Copy command' });
  await expect(copy).toBeVisible();
  // Before the click: Playwright's own scroll would reach inside a clipped card, which a person cannot do.
  expect(
    await copy.evaluate((el) => {
      const box = el.getBoundingClientRect();
      return document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2) === el;
    }),
  ).toBe(true);
  await copy.click();
  expect(await clip(app)).toEqual(['npm install -g @google/gemini-cli@latest']);
});

test('popover_dismiss: a click outside and Escape close it, and neither leaves Settings', async ({ app, core }) => {
  await setup(app, core);
  const codex = row(app, 'codex');
  const now = codex.getByRole('button', { name: 'Update now' });
  await codex.locator('.upd').click();
  await expect(now).toBeVisible();
  await app.locator('#s-accounts .prv-head h3').first().click();
  await expect(now).toBeHidden();
  await codex.locator('.upd').click();
  await expect(now).toBeVisible();
  await app.keyboard.press('Escape');
  await expect(now).toBeHidden();
  await expect(row(app, 'claude')).toBeVisible();
});

test('update_all: two tools behind show the count, both rows show progress, then the new versions; a tool not in Accounts is left alone', async ({ app, core }) => {
  const starts = await setup(app, core, { geminiAdded: false });
  await expect(all(app)).toHaveText('Update all (2)', { timeout: POLLED });
  await all(app).click();
  for (const name of ['claude', 'codex']) await expect(row(app, name).locator('.pchip.upd-run')).toHaveText('Updating');
  expect(starts).toHaveLength(2);
  for (const name of ['claude', 'codex']) {
    await expect(row(app, name).locator('.prv-ver')).toHaveText(NEXT, { timeout: 20_000 });
    await expect(row(app, name).locator('.upd-meta')).toHaveCount(0);
  }
  expect(log(core).split('\n').filter(Boolean).sort()).toEqual(['claude update', 'codex update']);
});

// Ticket 358: an agent turned off is out of Update all, in the count and in the run.
test('update_all_skips_off: Codex off leaves the count and the run', async ({ app, core }) => {
  const starts = await setup(app, core, { geminiAdded: false });
  await expect(all(app)).toHaveText('Update all (2)', { timeout: POLLED });
  await openRow(app, 'Codex');
  await app.locator('#s-accounts .acct-agent[data-agent="codex"]').getByRole('switch', { name: 'Use Codex' }).click();
  await expect(all(app)).toHaveText('Update all (1)');
  await all(app).click();
  await expect(row(app, 'claude').locator('.prv-ver')).toHaveText(NEXT, { timeout: 20_000 });
  expect(starts).toEqual([{ op: 'agent_update_start', tool: 'claude' }]);
  expect(log(core).split('\n').filter(Boolean)).toEqual(['claude update']);
});

test('threat_update_all: the count leaves out a tool whose path proves nothing and one already updating, and neither is started', async ({ app, core }) => {
  const starts = await setup(app, core, { codex: false });
  // Codex is behind with no proven path: a mark and nothing to press.
  await expect(row(app, 'codex').locator('.upd')).toHaveText(`New version ${NEXT}`);
  await expect(row(app, 'codex').locator('details')).toHaveCount(0);
  mode(core, 'hang');
  ownerOk(core, { op: 'agent_update_start', tool: 'claude' });
  await expect(row(app, 'claude').locator('.pchip.upd-run')).toBeVisible({ timeout: POLLED });
  await expect(all(app)).toHaveText('Update all (1)');
  mode(core, 'same');
  await all(app).click();
  await expect.poll(() => starts).toEqual([{ op: 'agent_update_start', tool: 'gemini' }]);
  await expect.poll(() => log(core).split('\n').filter(Boolean).sort()).toEqual(['claude update', 'npm install -g @google/gemini-cli@latest']);
  ownerOk(core, { op: 'agent_update_cancel', tool: 'claude' });
});

test('update_all_shared_installer: two npm tools run one after the other, and the second is not refused', async ({ app, core }) => {
  await setup(app, core, { opencode: true });
  await expect(all(app)).toHaveText('Update all (4)', { timeout: POLLED });
  await all(app).click();
  await expect(row(app, 'gemini').locator('.pchip.upd-run')).toBeVisible();
  await expect(row(app, 'opencode').locator('.pchip.upd-run')).toHaveCount(0);
  await expect(row(app, 'opencode').locator('.pchip.upd-run')).toBeVisible({ timeout: 20_000 });
  await expect(row(app, 'gemini').locator('.pchip.upd-run')).toHaveCount(0);
  await expect(app.locator('#s-accounts .upd-err')).toHaveCount(0);
  // The chip shows once the core starts the run; the fake npm writes its line a moment later.
  await expect.poll(() => log(core).split('\n').filter((l) => l.startsWith('npm'))).toEqual(['npm install -g @google/gemini-cli@latest', 'npm i -g @opencode/cli@latest']);
});

test('update_ui_screen: the popover and the header in Korean (REPORT capture)', async ({ app, core }, info) => {
  await setup(app, core);
  mode(core, 'fail');
  ownerOk(core, { op: 'agent_update_start', tool: 'gemini' });
  await expect(row(app, 'gemini').locator('.upd-st .pchip.bad')).toBeVisible({ timeout: POLLED });
  mode(core, 'hang');
  ownerOk(core, { op: 'agent_update_start', tool: 'claude' });
  await expect(row(app, 'claude').locator('.upd-run')).toBeVisible({ timeout: POLLED });
  await app.evaluate(() => localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ ...JSON.parse(localStorage.getItem('nunchiro.settings.v1') ?? '{}'), language: 'ko' })));
  await app.reload();
  await expect(async () => {
    await app.keyboard.press('Meta+Comma');
    await app.getByRole('button', { name: '프로바이더', exact: true }).click({ timeout: 1_000 });
  }).toPass();
  const header = app.locator('#s-accounts .prv-head').getByRole('button', { name: /^모두 업데이트/ }); // settings kit: on the Your agents heading
  await expect(header).toHaveText('모두 업데이트 (2)', { timeout: POLLED });
  const codex = row(app, 'codex');
  await codex.locator('.upd').click();
  await expect(codex.getByRole('button', { name: '지금 업데이트' })).toBeVisible();
  await expect(codex.getByRole('button', { name: '명령 복사' })).toBeVisible();
  await app.screenshot({ path: path.join(REPO, `.scratch/shots/update-ui-${info.project.name}.png`) });
  ownerOk(core, { op: 'agent_update_cancel', tool: 'claude' });
});
