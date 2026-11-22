// Ticket 358, mock #update: the new-version mark and a row's update progress, 취소 and 다시 시도, against a real core with
// the fake tools of crates/nunchiro-core/tests/fixtures/accounts/update-fake.sh and a local fake of the npm registry. No real
// installer runs. Starting an update goes through the op: the 지금 업데이트 button belongs to v28-acct-update-ui.
import type { Page } from '@playwright/test';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { agentsToml, ownerOk, tomlEntry } from './acp-fakes';
import { REPO, expect, openWindow, test, type Core } from './fixtures';

const FAKE = path.join(REPO, 'crates/nunchiro-core/tests/fixtures/accounts/update-fake.sh');
/** An update started through the op shows at the window's next idle poll (updateRow.tsx `IDLE_MS`). */
const POLLED = 10_000;
const servers: http.Server[] = [];
test.afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

async function registry(answers: Record<string, string>) {
  const server = http.createServer((req, res) => {
    const body = answers[req.url ?? ''];
    res.writeHead(body === undefined ? 404 : 200, { 'Content-Type': 'application/json' });
    res.end(body ?? '');
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
}
const version = (v: string) => JSON.stringify({ version: v });
const GOOD = { '/@anthropic-ai/claude-code/latest': version('2.1.320'), '/@openai/codex/latest': version('0.170.0'), '/@google/gemini-cli/latest': version('0.10.0') };

function install(from: string, to: string) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  fs.chmodSync(to, 0o700);
}
/** Claude is a native install, Codex one with no update, Gemini an approved npm-global entry and goose one with no source. */
async function setup(app: Page, core: Core, answers: Record<string, string>, env: Record<string, string> = {}) {
  const user = core.env.HOME!;
  const bin = path.join(core.home, 'bin');
  const write = (name: string, text: string) => fs.writeFileSync(path.join(user, name), `${text}\n`);
  write('fake-version', '1.2.0');
  write('fake-version-claude', '2.1.319 (Claude Code)');
  write('fake-version-codex', 'codex-cli 0.161.0');
  write('fake-version-gemini', '0.9.1');
  write('fake-next-version', '2.1.320 (Claude Code)');

  const claude = path.join(user, '.local/share/claude/versions/2.1.319');
  install(FAKE, claude);
  fs.rmSync(path.join(bin, 'claude'));
  fs.symlinkSync(claude, path.join(bin, 'claude'));
  install(FAKE, path.join(bin, 'codex'));
  const gemini = path.join(user, 'npm/lib/node_modules/@google/gemini-cli/cli.js');
  install(FAKE, gemini);
  install(FAKE, path.join(user, 'npm/bin/npm'));
  fs.symlinkSync(gemini, path.join(bin, 'gemini'));
  install(FAKE, path.join(bin, 'goose'));
  fs.writeFileSync(agentsToml(core), `${tomlEntry('gemini', path.join(bin, 'gemini'))}\n${tomlEntry('goose', path.join(bin, 'goose'))}`);

  core.run(['serve', 'stop'], 10_000);
  core.env.NUNCHIRO_UPDATE_REGISTRY = await registry(answers);
  Object.assign(core.env, env);
  await core.restart();
  for (const name of ['gemini', 'goose']) ownerOk(core, { op: 'acp_agent_grant', name, hash: ownerOk(core, { op: 'acp_agent_status', name }).view.hash });
  await app.addInitScript((boot) => {
    window.__NUNCHIRO__ = boot;
  }, core.boot());
  await openWindow(app);
  await app.keyboard.press('Meta+Comma');
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Providers' }).click();
  await expect(row(app, 'claude').locator('.prv-ver')).toHaveText('2.1.319');
}
// Ticket 391: the whole card (head, update strip, open blocks), not only its head.
const row = (app: Page, name: string) => app.locator(`#s-accounts .acct-agent[data-agent="${name}"]`);
const mode = (core: Core, m: string) => fs.writeFileSync(path.join(core.env.HOME!, 'fake-mode'), m);
const start = (core: Core, tool: string) => ownerOk(core, { op: 'agent_update_start', tool });
const log = (core: Core) => fs.readFileSync(path.join(core.env.HOME!, 'update.log'), 'utf8');

test('update_mark: an older install shows the new version; a tool with no confirmed source shows none', async ({ app, core }) => {
  await setup(app, core, GOOD);
  const codex = row(app, 'codex');
  await expect(codex.locator('.upd')).toHaveText('New version 0.170.0');
  await expect(codex.locator('.prv-ver')).toHaveText('0.161.0');
  await expect(row(app, 'gemini').locator('.upd')).toHaveText('New version 0.10.0');
  await expect(row(app, 'goose').locator('.prv-ver')).toHaveText('1.2.0');
  await expect(row(app, 'goose').locator('.upd')).toHaveCount(0);
});

test('threat_update_args: a registry answer holding shell text gives no mark and the update runs the same arguments', async ({ app, core }) => {
  const text = '9.9.9; touch $HOME/PWNED_358';
  await setup(app, core, { ...GOOD, '/@anthropic-ai/claude-code/latest': version(text) });
  await expect(row(app, 'codex').locator('.upd')).toBeVisible();
  await expect(row(app, 'claude').locator('.upd')).toHaveCount(0);
  await expect(row(app, 'claude')).not.toContainText('9.9.9');
  mode(core, 'same');
  start(core, 'claude');
  await expect(row(app, 'claude').locator('.upd-meta')).toBeVisible({ timeout: POLLED });
  await expect(row(app, 'claude').locator('.upd-line')).toHaveText('Update finished, but the version did not change · already up to date');
  await expect(row(app, 'claude').locator('.upd-st .pchip')).toHaveText('No change');
  await expect(row(app, 'claude').locator('.upd-st .pchip.bad')).toHaveCount(0);
  expect(log(core)).toBe('claude update\n');
  expect(fs.existsSync(path.join(core.env.HOME!, 'PWNED_358'))).toBe(false);
});

test('update_progress: 업데이트 중 with moving text and an indeterminate bar, no percent, then the new version', async ({ app, core }) => {
  await setup(app, core, GOOD);
  const claude = row(app, 'claude');
  await expect(claude.locator('.upd')).toHaveText('New version 2.1.320');
  mode(core, 'slow');
  start(core, 'claude');
  await expect(claude.locator('.pchip.upd-run')).toHaveText('Updating', { timeout: POLLED });
  await expect(claude.locator('.bar i.ind')).toBeVisible();
  await expect(claude.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow');
  const seen = new Set<string>();
  await expect
    .poll(async () => {
      seen.add((await claude.locator('.upd-line').textContent()) ?? '');
      return [...seen].filter((s) => s.startsWith('downloading part')).length;
    })
    .toBeGreaterThanOrEqual(2);
  await expect(claude).not.toContainText('%');
  await expect(claude.locator('.upd-meta')).toHaveCount(0, { timeout: 20_000 });
  await expect(claude.locator('.prv-ver')).toHaveText('2.1.320');
  await expect(claude.locator('.upd')).toHaveCount(0);
});

test('update_cancel_retry: 취소 returns the row to its old version; a failure offers 다시 시도, which works', async ({ app, core }) => {
  await setup(app, core, GOOD);
  const claude = row(app, 'claude');
  mode(core, 'hang');
  start(core, 'claude');
  await expect(claude.getByText('waiting on the download')).toBeVisible({ timeout: POLLED });
  await claude.getByRole('button', { name: 'Cancel' }).click();
  await expect(claude.locator('.upd-meta')).toHaveCount(0);
  await expect(claude.locator('.prv-ver')).toHaveText('2.1.319');
  await expect(claude.locator('.upd')).toHaveText('New version 2.1.320');

  mode(core, 'fail');
  start(core, 'claude');
  const retry = claude.getByRole('button', { name: 'Retry' });
  await expect(retry).toBeVisible({ timeout: POLLED });
  await expect(claude.locator('.upd-line')).toHaveText('2.1.320 update failed · could not reach the update server');
  await expect(claude.locator('.pchip.bad')).toHaveText('Failed');
  mode(core, 'ok');
  await retry.click();
  await expect(claude.locator('.pchip.upd-run')).toHaveText('Updating');
  await expect(claude.locator('.prv-ver')).toHaveText('2.1.320', { timeout: 15_000 });
  await expect(claude.locator('.upd-meta')).toHaveCount(0);
});

test('update_failure_reason: a failed row says why and shows the last output without a hover', async ({ app, core }) => {
  await setup(app, core, GOOD, { NUNCHIRO_UPDATE_TIMEOUT_MS: '2500' });
  const claude = row(app, 'claude');
  mode(core, 'hang');
  start(core, 'claude');
  await expect(claude.locator('.upd-line')).toHaveText('2.1.320 update failed · Timed out · waiting on the download', { timeout: POLLED });
  // A file that cannot be executed: the check before the start passes, the spawn does not.
  fs.writeFileSync(path.join(core.env.HOME!, '.local/share/claude/versions/2.1.319'), '#!/nonexistent/interpreter\n');
  start(core, 'claude');
  await expect(claude.locator('.upd-line')).toHaveText('2.1.320 update failed · Could not start the update', { timeout: POLLED });
  await expect(claude.locator('.upd-st .pchip.bad')).toBeVisible();
});

test('update_screen: the three states of the mock, in Korean (REPORT capture)', async ({ app, core }, info) => {
  await setup(app, core, GOOD);
  mode(core, 'fail');
  start(core, 'gemini');
  await expect(row(app, 'gemini').locator('.upd-st .pchip.bad')).toBeVisible({ timeout: POLLED });
  mode(core, 'hang');
  start(core, 'claude');
  await expect(row(app, 'claude').locator('.upd-run')).toBeVisible({ timeout: POLLED });
  await app.evaluate(() => localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ ...JSON.parse(localStorage.getItem('nunchiro.settings.v1') ?? '{}'), language: 'ko' })));
  await app.reload();
  // The shortcut does nothing until the reloaded window is up.
  await expect(async () => {
    await app.keyboard.press('Meta+Comma');
    await app.getByRole('button', { name: '프로바이더', exact: true }).click({ timeout: 1_000 });
  }).toPass();
  const claude = row(app, 'claude');
  await expect(claude.locator('.upd-run')).toHaveText('업데이트 중');
  await expect(claude.getByRole('button', { name: '취소' })).toBeVisible();
  await expect(row(app, 'codex').locator('.upd')).toHaveText('새 버전 0.170.0');
  await expect(row(app, 'gemini').locator('.upd-line')).toHaveText('0.10.0 업데이트 실패 · could not reach the update server');
  await expect(row(app, 'gemini').getByRole('button', { name: '다시 시도' })).toBeVisible();
  await app.screenshot({ path: path.join(REPO, `.scratch/shots/update-${info.project.name}.png`) });
  ownerOk(core, { op: 'agent_update_cancel', tool: 'claude' });
});
