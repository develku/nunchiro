// Ticket 1031: the status bar's usage block and its popover (mockups docs/design/usage-home-1121/index.html part 1 and
// docs/design/bot-statusbar-1121/index.html 1-1). "Used", per agent its logo, a tiny bar and "used % + time to reset" per
// window; a click opens the Usage popover (Detailed / Compact, kept across a reload), which also carries the Codex reset
// tickets. Codex's limits are the records in the test's own CODEX_HOME (as account-usage-v4.spec.ts writes them); Claude
// has no local source, so it reads "no data". The resets talk to a fake `codex` (as account-codex-reset.spec.ts): no real
// codex and no account is touched.
import type { Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import fs from 'node:fs';
import path from 'node:path';
import { type Core, expect, openWindow, REPO, test } from './fixtures';

const DAY = 86_400;
const now = () => Math.floor(Date.now() / 1000);
const OUT = path.join(REPO, '.scratch/shots/1031');

/** One Codex record: `session` % of the 5 h window used (resets in 3 h), `weekly` % of the week (resets in 2 days). */
function limits(core: Core, session: number, weekly?: number) {
  const day = new Date();
  const dir = path.join(core.home, 'codex-home/sessions', String(day.getUTCFullYear()), String(day.getUTCMonth() + 1).padStart(2, '0'), String(day.getUTCDate()).padStart(2, '0'));
  fs.mkdirSync(dir, { recursive: true });
  const at = new Date(Date.now() - 3_600_000).toISOString().replace(/\.\d+Z$/, '.000Z');
  const rate = { primary: { used_percent: session, window_minutes: 300, resets_at: now() + 3 * 3600 }, ...(weekly === undefined ? {} : { secondary: { used_percent: weekly, window_minutes: 10080, resets_at: now() + 2 * DAY } }) };
  const rows = [
    { timestamp: at, type: 'session_meta', payload: { id: 'cx-1', cwd: core.project('demo') } },
    { timestamp: at, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 10 }, last_token_usage: { input_tokens: 5, cached_input_tokens: 0, output_tokens: 5 } }, rate_limits: rate } },
  ];
  fs.writeFileSync(path.join(dir, 'r.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

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
/** A fake codex with two reset tickets; `started` and `consumes` say what it was asked. */
function fakeCodex(core: Core) {
  const d = path.join(core.home, 'codex-home');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(core.home, 'bin/codex'), FAKE, { mode: 0o700 });
  const credits = [0, 1].map((i) => ({ id: `c${i}`, resetType: 'codexRateLimits', status: 'available', grantedAt: 1, expiresAt: now() + (7 + i) * DAY, title: null, description: null }));
  const read = { id: 2, result: { ordinaryUsageAllowed: true, rateLimits: { primary: null, secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: now() + DAY } }, rateLimitsByLimitId: null, rateLimitResetCredits: { availableCount: 2, credits }, accountId: null, rateLimitUpsell: null } };
  fs.writeFileSync(path.join(d, 'read.json'), JSON.stringify(read) + '\n');
  fs.writeFileSync(path.join(d, 'consume.json'), '{"id":2,"result":{"outcome":"reset"}}\n');
  return {
    started: () => fs.existsSync(path.join(d, 'argv')),
    consumes: () => (fs.existsSync(path.join(d, 'rpc.log')) ? fs.readFileSync(path.join(d, 'rpc.log'), 'utf8').split('\n').filter((l) => l.includes('rateLimitResetCredit/consume')).length : 0),
  };
}

const block = (app: Page) => app.locator('footer.status button.usg');
const pop = (app: Page) => app.getByRole('dialog', { name: 'Usage' });
const shot = (app: Page, name: string, project: string) => (fs.mkdirSync(OUT, { recursive: true }), app.screenshot({ path: path.join(OUT, `${name}-${project}.png`) }));

test('usage_block: Used, per agent a bar and "used % + time to reset" per window; warn at 80 % used; Claude has no data', async ({ app, core }, info) => {
  limits(core, 38, 82);
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  const b = block(app);
  await expect(b).toBeVisible();
  // The left end of the bar: nothing of the footer starts before it.
  const first = await app.locator('footer.status > *').first().evaluate((e) => e.className);
  expect(first).toContain('usg');
  await expect(b.locator('.usg-w')).toHaveText('Used');
  const codex = b.locator('[data-usage="codex"]');
  await expect(codex.locator('.usg-t')).toHaveText(/^38% (2h 5\dm|3h) · 82% (1d 23h|2d)$/);
  await expect(codex.locator('.usg-t')).toHaveAttribute('data-tone', 'warn'); // 82 % of the week is used
  await expect(codex.locator('.mini')).toHaveAttribute('data-tone', 'warn');
  expect(await codex.locator('.mini b').evaluate((e) => (e as HTMLElement).style.width)).toBe('82%'); // the most used window
  await expect(codex.locator('.agent-logo')).toHaveCount(1);
  const claude = b.locator('[data-usage="claude"]');
  await expect(claude).toContainText('no data');
  await expect(claude.locator('.mini')).toHaveCount(0);
  await expect(b).toHaveAccessibleName(/Used.*Claude.*no data.*Codex.*38%/);
  expect(await app.locator('footer.status').innerText()).not.toMatch(/% left/);
  expect((await new AxeBuilder({ page: app }).include('footer.status').analyze()).violations).toEqual([]);
  await shot(app, 'bar', info.project.name);
});

test('usage_block_calm: under 80 % the numbers are plain', async ({ app, core }) => {
  limits(core, 38);
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  const codex = block(app).locator('[data-usage="codex"]');
  await expect(codex.locator('.usg-t')).toHaveText(/^38% (2h 5\dm|3h)$/);
  await expect(codex.locator('.usg-t')).not.toHaveAttribute('data-tone', /./);
  await expect(codex.locator('.usg-rst')).toHaveCount(0); // no reset count before a read
});

test('usage_popover: Detailed and Compact (kept across a reload), labelled bars per account, and the two links', async ({ app, core }, info) => {
  limits(core, 38, 82);
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await block(app).click();
  const p = pop(app);
  await expect(p).toBeVisible();
  await expect(block(app)).toHaveAttribute('aria-expanded', 'true');
  // It opens above the block, inside the window.
  const [pb, bb] = [(await p.boundingBox())!, (await block(app).boundingBox())!];
  expect(pb.y + pb.height).toBeLessThanOrEqual(bb.y);
  expect(pb.x).toBeGreaterThanOrEqual(0);
  const density = p.getByRole('radiogroup', { name: 'Density' });
  await expect(density.getByRole('radio', { name: 'Detailed' })).toBeChecked();
  const codex = p.locator('[data-usage-row="codex:own"]');
  await expect(codex.locator('.u-name')).toHaveText('Codex · Default');
  await expect(codex.locator('.u-reset')).toHaveText(/^Resets in (2h 5\dm|3h)$/);
  await expect(codex.locator('.u-m')).toHaveText([/^5h\s*38%$/, /^wk\s*82%$/]);
  await expect(codex.locator('.u-m').nth(1).locator('.v')).toHaveAttribute('data-tone', 'warn');
  const claude = p.locator('[data-usage-row="claude:own"]');
  await expect(claude.locator('.u-name')).toHaveText('Claude · Default');
  await expect(claude).toContainText('No limit in its records');
  await expect(claude.locator('.bar')).toHaveCount(0);
  expect((await new AxeBuilder({ page: app }).include('.usg-pop').analyze()).violations).toEqual([]);
  await shot(app, 'popover-detailed', info.project.name);

  // Compact: one line per account with its most used window, and the bar follows.
  await density.getByRole('radio', { name: 'Compact' }).check();
  await expect(codex.locator('.u-m')).toHaveCount(0);
  await expect(codex.locator('.u-reset')).toHaveText(/^(1d 23h|2d)\s*82%$/);
  await expect(block(app).locator('[data-usage="codex"] .usg-t')).toHaveText(/^82% (1d 23h|2d)$/);
  await shot(app, 'popover-compact', info.project.name);
  await app.reload();
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  await expect(block(app).locator('[data-usage="codex"] .usg-t')).toHaveText(/^82% (1d 23h|2d)$/);
  await block(app).click();
  await expect(pop(app).getByRole('radio', { name: 'Compact' })).toBeChecked();

  // Escape closes it and gives the focus back to the block.
  await app.keyboard.press('Escape');
  await expect(pop(app)).toHaveCount(0);
  await expect(block(app)).toBeFocused();
  // The links: the existing Usage page, and Providers.
  await block(app).click();
  await pop(app).getByRole('button', { name: 'Usage details & history' }).click();
  await expect(pop(app)).toHaveCount(0);
  await expect(app.locator('#s-usage')).toBeVisible();
  await app.keyboard.press('Escape');
  await block(app).click();
  await pop(app).getByRole('button', { name: 'Manage accounts…' }).click();
  await expect(app.locator('.settings header.phd h1')).toHaveText('Providers');
});

test('usage_popover_codex_resets: off with Turn on and its note; Refresh reads; Use a reset confirms on one line', async ({ app, core }, info) => {
  limits(core, 92, 61);
  const fake = fakeCodex(core);
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await block(app).click();
  const p = pop(app);
  const codex = p.locator('[data-usage-row="codex:own"]');
  // Off by default: one line, one button, and the note about what Refresh will run.
  await expect(codex).toContainText('Codex resets: off');
  await expect(codex).toContainText('Turning it on starts nothing. Refresh then runs your own codex once per account.');
  await shot(app, 'popover-resets-off', info.project.name);
  await p.getByRole('button', { name: 'Refresh usage' }).click();
  expect(fake.started()).toBe(false); // off: Refresh reads usage only
  await codex.getByRole('button', { name: 'Turn on' }).click();
  await expect(codex).toContainText('Press Refresh to check');
  await expect(codex).not.toContainText('Codex resets: off');
  expect(fake.started()).toBe(false); // turning it on starts nothing
  await p.getByRole('button', { name: 'Refresh usage' }).click();
  const expiry = await app.evaluate((s) => new Date(s * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }), now() + 7 * DAY);
  await expect(codex).toContainText(`2 resets · earliest expires ${expiry}`);
  expect(fake.started()).toBe(true);
  await expect(block(app).locator('[data-usage="codex"] .usg-rst')).toHaveText('2 resets'); // only once read
  await shot(app, 'popover-resets', info.project.name);
  // Use a reset: the same line asks, every time; Cancel spends nothing.
  await codex.getByRole('button', { name: 'Use a reset' }).click();
  const confirm = codex.getByRole('group', { name: 'Use a Codex reset' });
  await expect(confirm).toContainText('Reset Codex limits now? This uses 1 reset.');
  await expect(confirm.getByRole('checkbox')).toHaveCount(0);
  await expect(codex.getByText(/earliest expires/)).toBeHidden(); // the line became the question
  const indent = () => codex.locator('.rst').evaluate((e) => getComputedStyle(e).paddingLeft);
  expect(await indent()).toBe('0px'); // the question has the whole row
  await shot(app, 'popover-confirm', info.project.name);
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await expect(confirm).toHaveCount(0);
  expect(fake.consumes()).toBe(0);
  expect(await indent()).toBe('28px'); // and the count is back under the account's name (logo 20 + gap 8)
  await codex.getByRole('button', { name: 'Use a reset' }).click();
  await codex.getByRole('group', { name: 'Use a Codex reset' }).getByRole('button', { name: 'Use', exact: true }).click();
  await expect(codex).toContainText('Limits reset.');
  expect(fake.consumes()).toBe(1);
  expect(await indent()).toBe('28px');
  await shot(app, 'popover-used', info.project.name);
});
