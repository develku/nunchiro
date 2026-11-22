// Ticket 391 (docs/design/providers-391/final.html scene a): Settings > Providers, the old Agents and Accounts pages in one.
// Each flow starts from a visible control; the agents are fakes in the test's bin, never a real login.
import type { Page } from '@playwright/test';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type { Session } from '../src/types';
import { openRow } from './accounts-rows';
import { agentsToml, fakeAcp, ownerOk, tomlEntry } from './acp-fakes';
import { agentsZone, expect, openWindow, REPO, test, type Core } from './fixtures';
import { closeSettings, openSettings } from './settings-modal';

test.beforeEach(({ core }) => agentsZone(core));

const FIXTURES = path.join(REPO, 'crates/nunchiro-core/tests/fixtures/accounts');
const ID = '0123456789abcdef0123456789abcdef';
const LABEL = 'work';

/** The sign-in fakes: an account folder holding `.logged-in` is signed in. Claude has its own login and one added account. */
function setup(core: Core) {
  const bin = path.join(core.home, 'bin');
  fs.copyFileSync(path.join(FIXTURES, 'signin-fake-claude.sh'), path.join(bin, 'claude'));
  fs.copyFileSync(path.join(FIXTURES, 'signin-fake-codex.sh'), path.join(bin, 'codex'));
  for (const name of ['claude', 'codex']) fs.chmodSync(path.join(bin, name), 0o700);
  const folder = path.join(core.home, 'accounts/claude', ID);
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(folder, '.logged-in'), '');
  fs.writeFileSync(path.join(core.home, 'accounts.toml'), `version = 1\n\n[[accounts]]\nagent = "claude"\nid = "${ID}"\nlabel = "${LABEL}"\n`);
}
async function providers(app: Page) {
  await openSettings(app);
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Providers' }).click();
  await expect(app.locator('.settings header.phd h1')).toHaveText('Providers');
}
async function newTab(app: Page) {
  await app.keyboard.press('Meta+KeyK');
  await app.getByRole('dialog', { name: 'Command palette' }).locator('[data-command="session.new"]').click();
  const dlg = app.getByRole('dialog', { name: 'New tab' });
  await expect(dlg).toBeVisible();
  return dlg;
}
const defaultAgent = (app: Page) => app.getByRole('combobox', { name: 'Default agent' });
const options = (app: Page) => defaultAgent(app).locator('option').allTextContents();
const feature = (app: Page, key: string) => app.evaluate((k) => JSON.parse(localStorage.getItem('nunchiro.settings.v1') ?? '{}').features?.[k], key);
const snap = (core: Core) => core.cli('snapshot', '--json').sessions as Session[];

test('providers: the Claude card has the five blocks in order, and its default account starts the next session', async ({ app, core }) => {
  setup(core);
  core.shell(core.project('alpha'), 'main');
  await openWindow(app);
  await providers(app);
  await openRow(app, 'Claude');
  const card = app.locator('#s-accounts .acct-agent[data-agent="claude"]');
  await expect(card.locator('.prv-bh')).toHaveText(['Connection & sign-in', /^Accounts/, /^Models/, /^New session defaults/, 'Advanced']);
  await expect(card.locator('.acct-card')).toHaveCount(2);
  const pick = card.getByRole('combobox', { name: 'Default account · Claude' });
  await expect(pick.locator('option')).toHaveText(['Default', LABEL]);
  await pick.selectOption({ label: LABEL });
  await expect(card.locator(`.acct-card[data-account="${ID}"]`)).toContainText('Default');
  await expect(card.locator('[data-row="claude"] .prv-acc')).toHaveText(LABEL);
  await closeSettings(app);
  const dlg = await newTab(app);
  const first = dlg.getByRole('option', { name: /^Claude/ }).first();
  await expect(first).toContainText(`Claude · ${LABEL}`, { timeout: 15_000 });
  await first.click();
  await expect.poll(() => snap(core).filter((s) => s.kind === 'claude').map((s) => s.account)).toEqual([LABEL]);
});

test('providers: turning Codex off in its head takes it out of the default agent and the New tab; on brings it back', async ({ app, core }) => {
  setup(core);
  core.shell(core.project('alpha'), 'main');
  await openWindow(app);
  await providers(app);
  await expect.poll(() => options(app)).toEqual(['Last used', 'Claude', 'Codex', 'Plain shell']);
  const use = app.locator('#s-accounts [data-row="codex"]').getByRole('switch', { name: 'Use Codex' });
  await use.click(); // in the head: it does not open the card
  await expect(app.locator('#s-accounts .acct-agent[data-agent="codex"] .prv-body')).toHaveCount(0);
  await expect.poll(() => options(app)).toEqual(['Last used', 'Claude', 'Plain shell']);
  await closeSettings(app);
  let dlg = await newTab(app);
  await expect(dlg.getByRole('option', { name: /^Codex/ })).toHaveCount(0);
  await app.keyboard.press('Escape');
  await providers(app);
  await use.click();
  await expect.poll(() => options(app)).toEqual(['Last used', 'Claude', 'Codex', 'Plain shell']);
  await closeSettings(app);
  dlg = await newTab(app);
  await expect(dlg.getByRole('option', { name: /^Codex/ })).toHaveCount(1);
});

for (const [stored, shown] of [['terminal', 'Plain shell'], ['acp:gone', 'acp:gone']] as const) {
  test(`providers: a stored default agent "${stored}" shows as ${shown} and opening the page never rewrites it`, async ({ app, core }) => {
    core.shell(core.project('alpha'), 'main');
    await openWindow(app);
    await app.evaluate((v) => {
      const key = 'nunchiro.settings.v1';
      const s = JSON.parse(localStorage.getItem(key) ?? '{}');
      localStorage.setItem(key, JSON.stringify({ ...s, features: { ...s.features, 'onboarding.default_agent': v } }));
    }, stored);
    await app.reload();
    await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
    await providers(app);
    await expect(defaultAgent(app)).toHaveValue(stored);
    expect(await defaultAgent(app).evaluate((e) => (e as HTMLSelectElement).selectedOptions[0].textContent)).toBe(shown);
    await app.waitForTimeout(500);
    expect(await feature(app, 'onboarding.default_agent')).toBe(stored);
  });
}

test('providers: searching "Codex resets" and pressing Enter opens the Codex card on the reset switch', async ({ app, core }) => {
  setup(core);
  core.shell(core.project('alpha'), 'main');
  await openWindow(app);
  await openSettings(app);
  const search = app.getByRole('searchbox', { name: 'Search settings' });
  await search.fill('Codex resets');
  await search.press('Enter');
  await expect(app.locator('#s-accounts .acct-agent[data-agent="codex"] .prv-chv')).toHaveAttribute('aria-expanded', 'true');
  await expect(app.getByRole('switch', { name: 'Show Codex resets' })).toBeFocused();
});

test('providers: the AGENTS event with a name opens Providers with that card open', async ({ app, core }) => {
  setup(core);
  core.shell(core.project('alpha'), 'main');
  await openWindow(app);
  await app.evaluate(() => window.dispatchEvent(new CustomEvent('nunchiro:agents', { detail: { name: 'codex' } })));
  await expect(app.locator('.settings header.phd h1')).toHaveText('Providers');
  await expect(app.locator('#s-accounts .acct-agent[data-agent="codex"] .prv-chv')).toHaveAttribute('aria-expanded', 'true');
  await expect(app.locator('#s-accounts .acct-agent[data-agent="claude"] .prv-body')).toHaveCount(0);
});

// The mock's dark and light at the default Settings width and at 900 px: every card head stays one line (a long name ends
// in an ellipsis) and nothing in it overlaps. The shots for the report land in .scratch/shots/391/.
const LONG = 'my-agent-with-a-very-long-name-for-the-head';
for (const scheme of ['light', 'dark'] as const) {
  for (const width of [1440, 900]) {
    test(`providers: heads stay on one line (${scheme}, ${width} px)`, async ({ app, core }) => {
      setup(core);
      const cmd = fakeAcp(core, LONG, '1.4.0');
      fs.writeFileSync(agentsToml(core), tomlEntry(LONG, cmd, [], ['MY_AGENT_TOKEN']));
      const view = ownerOk(core, { op: 'acp_agent_status', name: LONG }).view;
      ownerOk(core, { op: 'acp_agent_grant', name: LONG, hash: view.hash });
      core.shell(core.project('alpha'), 'main');
      await app.setViewportSize({ width, height: 900 });
      await app.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      await openWindow(app);
      await providers(app);
      await openRow(app, 'Claude');
      const heads = app.locator('#s-accounts .prv-hd');
      await expect(heads).toHaveCount(3);
      await expect(app.locator(`#s-accounts [data-row="${LONG}"] .prv-ver`)).toHaveText('1.4.0');
      const bad = await heads.evaluateAll((els) =>
        els.flatMap((h) => {
          const id = (h as HTMLElement).dataset.row;
          const out: string[] = [];
          const box = h.getBoundingClientRect();
          if (box.height > 60) out.push(`${id}: ${box.height}px tall`);
          const kids = [...h.children].map((k) => k.getBoundingClientRect()).filter((r) => r.width > 0);
          for (let i = 1; i < kids.length; i++) if (kids[i].left < kids[i - 1].right - 0.5) out.push(`${id}: cell ${i} overlaps cell ${i - 1}`);
          if (box.right < kids[kids.length - 1].right - 0.5) out.push(`${id}: runs past its card`);
          return out;
        }),
      );
      expect(bad).toEqual([]);
      const dir = path.join(REPO, '.scratch/shots/391');
      fs.mkdirSync(dir, { recursive: true });
      await app.screenshot({ path: path.join(dir, `providers-${scheme}-${width}-${test.info().project.name}.png`), fullPage: true });
    });
  }
}

// Ticket 391 follow-up B and C (real-app check 11-10): with a "New version" mark in each head (Claude, Codex and an ACP
// agent), the head stays one line, nothing in it overlaps (the mark under the next cell was the defect), the version reads
// whole, and every card's chevron has the same x. The tools are crates/nunchiro-core/tests/fixtures/accounts/update-fake.sh
// and a local fake of the npm registry. Shots for the report land in .scratch/shots/391b/.
const UPDATE_FAKE = path.join(FIXTURES, 'update-fake.sh');
const registries: http.Server[] = [];
test.afterEach(() => {
  for (const s of registries.splice(0)) s.close();
});
async function updates(core: Core) {
  const latest: Record<string, string> = { '@anthropic-ai/claude-code': '2.1.320', '@openai/codex': '0.162.0', '@opencode/cli': '2.3.0' };
  const server = http.createServer((req, res) => {
    const version = latest[(req.url ?? '').replace(/^\/|\/latest$/g, '')];
    res.writeHead(version ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(version ? JSON.stringify({ version }) : '');
  });
  registries.push(server);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const user = core.env.HOME!;
  const bin = path.join(core.home, 'bin');
  for (const [name, v] of [['claude', '2.1.319 (Claude Code)'], ['codex', 'codex-cli 0.161.0'], ['opencode', '2.2.5']]) fs.writeFileSync(path.join(user, `fake-version-${name}`), `${v}\n`);
  const link = (real: string, name: string) => {
    fs.mkdirSync(path.dirname(real), { recursive: true });
    fs.copyFileSync(UPDATE_FAKE, real);
    fs.chmodSync(real, 0o700);
    fs.rmSync(path.join(bin, name), { force: true });
    fs.symlinkSync(real, path.join(bin, name));
  };
  link(path.join(user, '.local/share/claude/versions/2.1.319'), 'claude');
  link(path.join(user, '.codex/packages/standalone/codex'), 'codex');
  link(path.join(user, 'npm/lib/node_modules/@opencode/cli/cli.js'), 'opencode');
  fs.mkdirSync(path.join(user, 'npm/bin'), { recursive: true });
  fs.copyFileSync(UPDATE_FAKE, path.join(user, 'npm/bin/npm'));
  fs.chmodSync(path.join(user, 'npm/bin/npm'), 0o700);
  fs.writeFileSync(agentsToml(core), tomlEntry('opencode', path.join(bin, 'opencode')));
  core.run(['serve', 'stop'], 10_000);
  core.env.NUNCHIRO_UPDATE_REGISTRY = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  await core.restart();
  ownerOk(core, { op: 'acp_agent_grant', name: 'opencode', hash: ownerOk(core, { op: 'acp_agent_status', name: 'opencode' }).view.hash });
}
for (const scheme of ['light', 'dark'] as const) {
  for (const width of [1440, 900]) {
    test(`providers: with a New version mark, heads stay one line, the version whole, the chevrons in one column (${scheme}, ${width} px)`, async ({ app, core }) => {
      await updates(core);
      await app.setViewportSize({ width, height: 900 });
      await app.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      await app.addInitScript((boot) => void (window.__NUNCHIRO__ = boot), core.boot());
      await openWindow(app);
      await providers(app);
      for (const id of ['claude', 'codex', 'opencode']) await expect(app.locator(`#s-accounts [data-row="${id}"] .prv-sub .upd`)).toBeVisible({ timeout: 15_000 });
      await expect(app.locator('#s-accounts [data-row="codex"] .prv-ver')).toHaveText('0.161.0');
      await expect(app.locator('#s-accounts [data-row="opencode"] .prv-ver')).toHaveText('2.2.5');
      const bad = await app.locator('#s-accounts .prv-hd').evaluateAll((els) =>
        els.flatMap((h) => {
          const id = (h as HTMLElement).dataset.row;
          const out: string[] = [];
          const box = h.getBoundingClientRect();
          if (box.height > 60) out.push(`${id}: ${box.height}px tall`);
          const cells = [...h.children].filter((k) => k.getBoundingClientRect().width > 0);
          // Each cell's own content, the "New version" mark included, stays inside the cell: never under the next one.
          const extent = (k: Element) => Math.max(k.getBoundingClientRect().right, ...[...k.querySelectorAll('*')].filter((d) => !d.closest('.acct-menu')).map((d) => d.getBoundingClientRect().right));
          for (let i = 1; i < cells.length; i++) if (cells[i].getBoundingClientRect().left < extent(cells[i - 1]) - 0.5) out.push(`${id}: cell ${i - 1} runs under cell ${i}`);
          for (const v of h.querySelectorAll('.prv-ver')) if ((v as HTMLElement).scrollWidth > (v as HTMLElement).clientWidth + 0.5) out.push(`${id}: version cut`);
          return out;
        }),
      );
      expect(bad).toEqual([]);
      const xs = await app.locator('#s-accounts .prv-hd .prv-chv').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().left)));
      expect(xs.length).toBe(3);
      expect(new Set(xs).size, `chevron x: ${xs.join(', ')}`).toBe(1);
      const dir = path.join(REPO, '.scratch/shots/391b');
      fs.mkdirSync(dir, { recursive: true });
      await app.screenshot({ path: path.join(dir, `heads-update-${scheme}-${width}-${test.info().project.name}.png`), fullPage: true });
    });
  }
}
