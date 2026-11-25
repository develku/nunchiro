// Codex reset tickets (needs 225; design docs/design/usage-1106/codex-reset.md, mockup usage.html): every promise starts
// from a visible, labelled control on Settings > Providers (inside the Codex card since ticket 391) or Usage (Settings, the page, the card). A fake `codex` in
// the test's bin answers as `codex ... app-server` from files in CODEX_HOME and records what it was sent; no real codex
// and no account is touched.
import type { Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { type Core, expect, openWindow, REPO, test, codexFake } from './fixtures';
import { icon, sidebar } from './d5b';
import { openRow } from './accounts-rows';

const DAY = 86_400;
const now = () => Math.floor(Date.now() / 1000);
const FAKE = `#!/bin/sh
for a in "$@"; do last=$a; done
[ "$last" = app-server ] || exit 1
d=$CODEX_HOME
printf '%s\\n' "$*" >> "$d/argv"
while IFS= read -r line; do
  printf '%s\\n' "$line" >> "$d/rpc.log"
  case "$line" in
    *'"method":"initialize"'*) printf '{"id":1,"result":{}}\\n' ;;
    *'"method":"account/rateLimits/read"'*) cat "$d/read.json" ;;
    *'"method":"account/rateLimitResetCredit/consume"'*) cat "$d/consume.json" ;;
  esac
done
`;

function seed(core: Core, available = 2) {
  const d = path.join(core.home, 'codex-home');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(core.home, 'bin/codex'), codexFake(FAKE), { mode: 0o700 });
  const credits = Array.from({ length: available }, (_, i) => ({ id: `c${i}`, resetType: 'codexRateLimits', status: 'available', grantedAt: 1, expiresAt: now() + (7 + i) * DAY, title: null, description: null }));
  const read = { id: 2, result: { ordinaryUsageAllowed: true, rateLimits: { primary: null, secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: now() + DAY } }, rateLimitsByLimitId: null, rateLimitResetCredits: { availableCount: available, credits }, accountId: null, rateLimitUpsell: null } };
  fs.writeFileSync(path.join(d, 'read.json'), JSON.stringify(read) + '\n');
  fs.writeFileSync(path.join(d, 'consume.json'), '{"id":2,"result":{"outcome":"reset"}}\n');
  return {
    started: () => fs.existsSync(path.join(d, 'argv')),
    consumes: () => (fs.existsSync(path.join(d, 'rpc.log')) ? fs.readFileSync(path.join(d, 'rpc.log'), 'utf8').split('\n').filter((l) => l.includes('rateLimitResetCredit/consume')).length : 0),
  };
}

async function page(app: Page) {
  await openWindow(app);
  await app.getByRole('navigation', { name: 'Left bar' }).getByRole('button', { name: 'Settings' }).click(); // click 1
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Providers' }).click(); // click 2
  await openRow(app, 'Codex'); // ticket 391: the reset blocks end the Codex card's 계정 block
  await expect(app.getByRole('heading', { name: 'Limits', exact: true })).toBeVisible();
  return app.getByRole('region', { name: 'Settings' });
}
// v25f: a reload keeps the Settings modal; only the page is chosen again.
async function reopened(app: Page) {
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Providers' }).click();
  await openRow(app, 'Codex');
  await expect(app.getByRole('heading', { name: 'Limits', exact: true })).toBeVisible();
  return app.getByRole('region', { name: 'Settings' });
}
async function toPage(app: Page, name: 'Providers' | 'Usage') {
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name }).click();
  if (name === 'Providers') await openRow(app, 'Codex');
}
const refreshOf = (sec: ReturnType<Page['locator']>) => sec.locator('#s-usage').getByRole('button', { name: 'Refresh usage' });
const codexRow = (sec: ReturnType<Page['locator']>) => sec.locator('#s-usage [data-limit="codex:own"]');

test('codex_resets_off_by_default_then_refresh_shows_count_and_expiry', async ({ app, core }) => {
  const fake = seed(core);
  core.shell(core.project('demo'), 'alpha');
  const sec = await page(app);
  const show = sec.getByRole('switch', { name: 'Show Codex resets' });
  await expect(show).not.toBeChecked();
  // Off: the page's Refresh reads usage only, and no codex starts.
  await toPage(app, 'Usage');
  await refreshOf(sec).click();
  await expect(codexRow(sec)).not.toContainText('Press Refresh to check');
  expect(fake.started()).toBe(false);
  await toPage(app, 'Providers');
  await show.click();
  await expect(show).toBeChecked();
  // Turning it on starts nothing: only the owner's Refresh press does.
  await toPage(app, 'Usage');
  await expect(codexRow(sec)).toContainText('Press Refresh to check');
  expect(fake.started()).toBe(false);
  await refreshOf(sec).focus();
  await app.keyboard.press('Enter');
  const row = codexRow(sec);
  const expiry = await app.evaluate((s) => new Date(s * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }), now() + 7 * DAY);
  await expect(row).toContainText(`2 resets · earliest expires ${expiry}`);
  expect(fake.started()).toBe(true);
  // It sticks (the core's settings.json), and a reload reads nothing until Refresh again.
  await app.reload();
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  const again = await reopened(app);
  await expect(again.getByRole('switch', { name: 'Show Codex resets' })).toBeChecked();
  await toPage(app, 'Usage');
  await expect(codexRow(again)).toContainText('Press Refresh to check');
});

test('codex_reset_use_confirms_every_time_then_logs', async ({ app, core }) => {
  const fake = seed(core);
  core.shell(core.project('demo'), 'alpha');
  const sec = await page(app);
  await sec.getByRole('switch', { name: 'Show Codex resets' }).click();
  await expect(sec.getByRole('switch', { name: 'Show Codex resets' })).toBeChecked();
  await toPage(app, 'Usage');
  await refreshOf(sec).click();
  const row = codexRow(sec);
  await expect(row).toContainText('2 resets');
  // Cancel spends nothing; the confirm has no "don't ask again".
  await row.getByRole('button', { name: 'Use a reset' }).click();
  const confirm = row.getByRole('group', { name: 'Use a Codex reset' });
  await expect(confirm).toContainText('Reset Codex limits now? This uses 1 reset.');
  await expect(confirm.getByRole('checkbox')).toHaveCount(0);
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await expect(confirm).toHaveCount(0);
  expect(fake.consumes()).toBe(0);
  // Use, by keyboard: one consume, the outcome on the row, a line in the log.
  await row.getByRole('button', { name: 'Use a reset' }).click();
  await row.getByRole('group', { name: 'Use a Codex reset' }).getByRole('button', { name: 'Use', exact: true }).focus();
  await app.keyboard.press('Enter');
  await expect(row).toContainText('Limits reset.');
  expect(fake.consumes()).toBe(1);
  const log = sec.getByRole('list', { name: 'Reset use log' });
  await expect(log.getByRole('listitem')).toHaveCount(1);
  await expect(log).toContainText('You');
  await expect(log).toContainText('Limits reset.');
  // Every use asks again.
  await row.getByRole('button', { name: 'Use a reset' }).click();
  await expect(row.getByRole('group', { name: 'Use a Codex reset' })).toBeVisible();
});

test('codex_reset_agent_policy_defaults_to_ask_and_persists', async ({ app, core }) => {
  seed(core);
  core.shell(core.project('demo'), 'alpha');
  const sec = await page(app);
  const policy = sec.getByRole('radiogroup', { name: 'When an agent wants to use a Codex reset' });
  await expect(policy.getByRole('radio', { name: /Ask every time/ })).toBeChecked();
  await expect(sec.getByRole('group', { name: 'Allow-ahead conditions' })).toHaveCount(0);
  // The control follows the core's stored value, so the state shows once the core has written it.
  await policy.getByRole('radio', { name: /Allow ahead/ }).click();
  await expect(policy.getByRole('radio', { name: /Allow ahead/ })).toBeChecked();
  const conds = sec.getByRole('group', { name: 'Allow-ahead conditions' });
  await expect(conds.getByRole('checkbox', { name: 'Only when the weekly limit is used up' })).toBeChecked();
  await expect(conds.getByRole('checkbox', { name: 'Keep the last one' })).toBeChecked();
  await expect(conds.getByRole('spinbutton', { name: 'Most per week' })).toHaveValue('2');
  await conds.getByRole('checkbox', { name: 'Keep the last one' }).click();
  await expect(conds.getByRole('checkbox', { name: 'Keep the last one' })).not.toBeChecked();
  await app.reload();
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  const again = await reopened(app);
  await expect(again.getByRole('radio', { name: /Allow ahead/ })).toBeChecked();
  await expect(again.getByRole('checkbox', { name: 'Keep the last one' })).not.toBeChecked();
});

test('codex_reset_agent_ask_is_a_decisions_card_allow_spends_one', async ({ app, core }) => {
  const fake = seed(core);
  // The owner turns the feature on (Ask every time is the default).
  const sec = await page(app);
  await sec.getByRole('switch', { name: 'Show Codex resets' }).click();
  await expect(sec.getByRole('switch', { name: 'Show Codex resets' })).toBeChecked();
  // An agent in a Codex session asks through the Nunchiro CLI (its own session token).
  const bin = path.join(REPO, 'target/debug/nunchiro');
  const asks = () => `[ "$last" = app-server ] || { [ -n "$NUNCHIRO_SESSION" ] || exit 1; "${bin}" account codex-reset --reason "tests need more runs"; exec cat; }`;
  fs.writeFileSync(path.join(core.home, 'bin/codex'), codexFake(FAKE.replace('[ "$last" = app-server ] || exit 1', asks)), { mode: 0o700 });
  core.cli('session', 'start', '--kind', 'codex', '--project', core.project('demo'), '--label', 'add tests');
  const log = path.join(core.home, 'codex-resets.json');
  await expect.poll(() => fs.existsSync(log) && fs.readFileSync(log, 'utf8').includes('"asked"'), { timeout: 15_000 }).toBe(true);
  // Leave Settings for the session, then open the Decisions widget from the right bar.
  await app.keyboard.press('Escape');
  await app.getByRole('tablist', { name: 'Sessions' }).getByRole('tab', { name: /add tests/ }).click();
  await icon(app, 'right', 'Decisions').click();
  const side = sidebar(app, 'right');
  await expect(side).toHaveAttribute('data-widget', 'decisions');
  const card = side.getByRole('group', { name: /wants to use a Codex reset/ });
  await expect(card).toContainText('add tests');
  await expect(card).toContainText('tests need more runs');
  expect(fake.consumes()).toBe(0);
  await card.getByRole('button', { name: 'Allow' }).click();
  await expect(card).toHaveCount(0);
  await expect.poll(fake.consumes, { timeout: 15_000 }).toBe(1);
});

// Round 3: a reset log that cannot be read is said on the page; the owner's own use moves it aside and logs on a new
// one, and the page says agents' automatic uses are refused until 7 days after.
test('codex_reset_unreadable_log_is_shown_and_set_aside', async ({ app, core }) => {
  const fake = seed(core);
  core.shell(core.project('demo'), 'alpha');
  fs.writeFileSync(path.join(core.home, 'codex-resets.json'), '{not json');
  const sec = await page(app);
  await sec.getByRole('switch', { name: 'Show Codex resets' }).click();
  await expect(sec.getByRole('switch', { name: 'Show Codex resets' })).toBeChecked();
  await toPage(app, 'Usage');
  const card = sec.locator('.cxr-logcard');
  await expect(card.getByRole('alert')).toContainText('The reset log cannot be read.');
  await refreshOf(sec).click();
  const row = codexRow(sec);
  await row.getByRole('button', { name: 'Use a reset' }).click();
  await row.getByRole('group', { name: 'Use a Codex reset' }).getByRole('button', { name: 'Use', exact: true }).click();
  await expect(row).toContainText('Limits reset.');
  expect(fake.consumes()).toBe(1);
  await expect(card.getByRole('alert')).toContainText('was moved aside (codex-resets.json.bad-');
  await expect(card.getByRole('alert')).toContainText("Agents' automatic resets are refused until");
  await expect(sec.getByRole('list', { name: 'Reset use log' }).getByRole('listitem')).toHaveCount(1);
  expect(fs.readdirSync(core.home).filter((f) => f.startsWith('codex-resets.json.bad-'))).toHaveLength(1);
});
