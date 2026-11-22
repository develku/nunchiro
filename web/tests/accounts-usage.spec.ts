// V2-2c, D2, ticket 324: Settings > Usage and Accounts against a real core and hand-written transcripts: the account filter
// narrows Usage, Accounts shows limits and no account-switch suggestion, the 60 s refresh runs while a page is open and
// stops once it is left (page clock), and the two are separate pages inside the Settings modal.
import fs from 'node:fs';
import path from 'node:path';
import { expect, openWindow, test } from './fixtures';
import { openRow } from './accounts-rows';

const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString();
const jsonl = (file: string, ...lines: object[]) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l) + '\n').join(''));
};
const claudeLine = (id: string, at: string, input: number) => ({ type: 'assistant', timestamp: at, message: { id, usage: { input_tokens: input, output_tokens: 0 } } });
const codexLine = (at: string, input: number, total: number) => ({
  timestamp: at,
  type: 'event_msg',
  payload: { type: 'token_count', info: { total_token_usage: { total_tokens: total }, last_token_usage: { input_tokens: input, output_tokens: 0 } } },
});
const ID = 'aaaaaaaa-0000-4000-8000-000000000001';

test('accounts-usage: the account filter narrows Usage, no % and no switch suggestion, refresh stops after leaving the page', async ({ app, core }) => {
  const claude = path.join(core.home, 'claude-home');
  // Today 1500 and three days ago 2000 (week only): 1.5k and 3.5k.
  jsonl(path.join(claude, 'projects/p/a.jsonl'), claudeLine('m1', iso(0), 1500), claudeLine('m2', iso(3), 2000));
  jsonl(path.join(core.home, 'codex-home/sessions/2026/10/24/rollout-1.jsonl'), codexLine(iso(0), 1_200_000, 1_200_000));
  fs.mkdirSync(path.join(core.home, 'accounts/claude', ID, 'projects/p'), { recursive: true });
  jsonl(path.join(core.home, 'accounts/claude', ID, 'projects/p/a.jsonl'), claudeLine('m3', iso(0), 42));
  fs.writeFileSync(path.join(core.home, 'accounts.toml'), `version = 1\n\n[[accounts]]\nagent = "claude"\nid = "${ID}"\nlabel = "Work"\n`);
  // Fast stand-ins for the agents' status commands, so the sign-in probes of the list return at once.
  for (const name of ['claude', 'codex']) fs.writeFileSync(path.join(core.home, 'bin', name), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  core.shell(core.project('demo'), 'alpha');

  let asked = 0;
  // Ticket 1031: the status bar's usage block reads limits only, on its own slow timer; the page's reads are counted here.
  app.on('websocket', (ws) => ws.on('framesent', (f) => typeof f.payload === 'string' && f.payload.includes('"account_usage"') && !f.payload.includes('"limits":true') && asked++));
  await app.clock.install();
  await openWindow(app);
  await app.keyboard.press('Meta+Comma');
  const nav = app.getByRole('navigation', { name: 'Settings pages' });
  await nav.getByRole('button', { name: 'Usage' }).click();
  const usage = app.locator('#s-usage');
  const tiles = usage.getByRole('group', { name: 'Summary' });
  await expect(tiles).toContainText('1.2M'); // every account
  const account = usage.getByRole('combobox', { name: 'Account' });
  await account.selectOption({ label: 'Claude · Work' });
  await expect(tiles).toContainText('Claude 42 · Codex 0');
  await expect(usage.locator('[data-limit]')).toHaveCount(1);
  await account.selectOption({ label: 'Claude · Default' });
  await expect(tiles).toContainText('Claude 3.5k · Codex 0');
  await account.selectOption({ label: 'All accounts' });
  await expect(tiles).toContainText('1.2M');
  await nav.getByRole('button', { name: 'Providers' }).click();
  await openRow(app, 'Claude');
  await expect(app.locator('#s-accounts').locator('.acct-card[data-agent-name="Claude"]')).toHaveCount(2);
  await expect(app.locator('#s-accounts').getByRole('columnheader', { name: 'Sessions' })).toHaveCount(0);
  await expect(app.locator('#s-accounts')).not.toContainText('%');
  await expect(app.getByText(/switch account/i)).toHaveCount(0);

  await expect.poll(() => asked).toBe(2); // one read per page opened
  await app.clock.fastForward(60_000);
  await expect.poll(() => asked).toBe(3);
  // Leaving the page unmounts it: the timer is gone.
  await app.keyboard.press('Escape'); // v25f: Settings is a modal over the tabs; Esc closes it first
  await app.locator('.tab').filter({ hasText: 'alpha' }).click();
  await expect(app.locator('#s-accounts')).toHaveCount(0);
  await app.clock.fastForward(300_000);
  await app.waitForTimeout(500);
  expect(asked).toBe(3);
});

test('usage_page_windows_are_rolling: 24 hours and 7 days count back from now, not from the local day', async ({ app, core }) => {
  // Rolling windows: 1500 an hour ago and 700 twenty hours ago are the 24 h (2.2k); with 2000 three days ago the 7 d (4.2k).
  // A local-day "Today" would count the 20 h line only after midnight, so it cannot pass both ways.
  const ago = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
  jsonl(path.join(core.home, 'claude-home/projects/p/a.jsonl'), claudeLine('m1', ago(1), 1500), claudeLine('m2', ago(20), 700), claudeLine('m3', ago(72), 2000));
  for (const name of ['claude', 'codex']) fs.writeFileSync(path.join(core.home, 'bin', name), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await app.keyboard.press('Meta+Comma');
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Usage' }).click();
  const usage = app.locator('#s-usage');
  const tiles = usage.getByRole('group', { name: 'Summary' });
  const range = usage.getByRole('radiogroup', { name: 'Range' });
  await range.getByRole('radio', { name: '24 hours' }).click();
  await expect(tiles).toContainText('2.2k');
  await range.getByRole('radio', { name: '7 days' }).click();
  await expect(tiles).toContainText('4.2k');
});

test('usage_page_follows_the_tick: a new limit reading shows on Usage at the next 60 s read', async ({ app, core }) => {
  const file = path.join(core.home, 'codex-home/sessions/2026/10/24/rollout-1.jsonl');
  const resets = Math.floor(Date.now() / 1000) + 3 * 3600;
  const reading = (used: number) => {
    const line = codexLine(iso(0), 1200, 1200);
    return { ...line, payload: { ...line.payload, rate_limits: { primary: { used_percent: used, window_minutes: 300, resets_at: resets } } } };
  };
  jsonl(file, reading(25));
  for (const name of ['claude', 'codex']) fs.writeFileSync(path.join(core.home, 'bin', name), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  core.shell(core.project('demo'), 'alpha');
  await app.clock.install();
  await openWindow(app);
  await app.keyboard.press('Meta+Comma');
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Usage' }).click();
  const limit = app.locator('#s-usage [data-limit="codex:own"]');
  await expect(limit).toContainText('25% used');
  fs.appendFileSync(file, JSON.stringify(reading(30)) + '\n');
  await app.clock.fastForward(60_000);
  await expect(limit).toContainText('30% used');
});

// D2 (mockup usage.html): two pages inside the Settings modal; "View usage" and search reach them.
test('settings_split_accounts_and_usage: two pages, limit chips, View usage lands on the account, search finds each', async ({ app, core }) => {
  const resets = Math.floor(Date.now() / 1000) + 3 * 3600;
  jsonl(path.join(core.home, 'codex-home/sessions/2026/10/24/rollout-1.jsonl'), {
    ...codexLine(iso(0), 1200, 1200),
    payload: { ...codexLine(iso(0), 1200, 1200).payload, rate_limits: { primary: { used_percent: 25, window_minutes: 300, resets_at: resets }, secondary: { used_percent: 60, window_minutes: 10080, resets_at: resets + 86_400 } } },
  });
  for (const name of ['claude', 'codex']) fs.writeFileSync(path.join(core.home, 'bin', name), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await app.keyboard.press('Meta+Comma');
  const nav = app.getByRole('navigation', { name: 'Settings pages' });
  await nav.getByRole('button', { name: 'Providers' }).click();
  await expect(app.locator('.settings header.phd h1')).toHaveText('Providers');
  await expect(app.locator('#s-usage')).toHaveCount(0);
  await openRow(app, 'Codex');
  await expect(app.getByRole('heading', { name: 'Limits', exact: true })).toBeVisible(); // ticket 391: inside the Codex card
  const codex = app.locator('#s-accounts .acct-card[data-agent-name="Codex"]').first();
  await expect(codex).toContainText('Session (5 hours) · 25% used'); // ticket 1031: "used", not "left"
  await expect(codex).toContainText('Weekly · 60% used');

  await codex.getByRole('button', { name: 'View usage for Codex · Default' }).click();
  await expect(nav.locator('[aria-current="page"]')).toHaveText('Usage');
  await expect(app.locator('.settings header.phd h1')).toHaveText('Usage');
  await expect(app.locator('#s-usage [data-limit="codex:own"]')).toBeFocused();
  // Ticket 324: the row's account is the filter, so its numbers are the ones shown.
  await expect(app.locator('#s-usage').getByRole('combobox', { name: 'Account' })).toHaveValue('codex:own');
  await expect(app.locator('#s-usage [data-limit]')).toHaveCount(1);
  await expect(app.locator('#s-accounts')).toHaveCount(0);
  await expect(app.locator('#s-codex-resets')).toHaveCount(0);

  const search = app.getByRole('searchbox', { name: 'Search settings' });
  await search.fill('resets');
  await expect(nav.locator('[data-page="providers"]')).toBeVisible();
  await expect(nav.locator('[data-page="usage"]')).toHaveCount(0);
  // Ticket 391: the reset blocks sit in the closed Codex card; the match opens it (accounts-providers.spec.ts).
  await expect(app.getByRole('list', { name: 'Matching settings' })).toContainText('Show Codex resets');
  await search.fill('tokens');
  await expect(nav.locator('[data-page="usage"]')).toBeVisible();
  await expect(nav.locator('[data-page="providers"]')).toHaveCount(0);
  await expect(app.locator('#s-usage')).toBeVisible();
});
