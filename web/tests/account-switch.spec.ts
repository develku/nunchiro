// Ticket 451: the status bar's account switch. Against a real core with a fake `claude`: two added accounts (회사 signed in,
// 개인 signed out) beside "Your own". A pick is the stored default for new sessions, the same one Settings > Providers shows.
import type { Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { openRow } from './accounts-rows';
import { expect, openWindow, test, type Core } from './fixtures';

const WORK = '0123456789abcdef0123456789abcdef';
const OTHER = 'fedcba9876543210fedcba9876543210';
const FAKE = `#!/bin/sh
D="\${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
case "$1" in --version) echo "2.1.311 (Claude Code)"; exit 0;; esac
if [ "$1 $2" = "auth status" ]; then
  if [ -e "$D/.logged-in" ]; then echo '{"loggedIn": true}'; exit 0; fi
  echo '{"loggedIn": false}'; exit 1
fi
exec /bin/cat
`;
function setup(core: Core) {
  fs.writeFileSync(path.join(core.home, 'bin/claude'), FAKE, { mode: 0o700 });
  for (const id of [WORK, OTHER]) fs.mkdirSync(path.join(core.home, 'accounts/claude', id), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(core.home, 'accounts/claude', WORK, '.logged-in'), '');
  fs.writeFileSync(path.join(core.home, 'accounts.toml'), `version = 1\n\n[[accounts]]\nagent = "claude"\nid = "${WORK}"\nlabel = "회사"\n\n[[accounts]]\nagent = "claude"\nid = "${OTHER}"\nlabel = "개인"\n`);
}
const chip = (app: Page) => app.locator('footer.status [data-switch="claude"]');
const menu = (app: Page) => app.getByRole('menu', { name: 'Claude account for new sessions' });
// Round 2: two Codex accounts beside Codex's "Your own" (CODEX_HOME). Round 3 (Codex security look P1): nothing switches
// automatically, Codex included: its rollouts are files a session can write.
const CX1 = '11111111111111111111111111111111';
const CX2 = '22222222222222222222222222222222';
function codexAccounts(core: Core) {
  for (const id of [CX1, CX2]) fs.mkdirSync(path.join(core.home, 'accounts/codex', id), { recursive: true, mode: 0o700 });
  fs.appendFileSync(path.join(core.home, 'accounts.toml'), `\n[[accounts]]\nagent = "codex"\nid = "${CX1}"\nlabel = "cx-main"\n\n[[accounts]]\nagent = "codex"\nid = "${CX2}"\nlabel = "cx-spare"\n`);
}
/** A rollout of Codex's "Your own" whose last `token_count` says `used`% of the week (usage.rs `codex_limits`). */
function codexWeek(core: Core, used: number) {
  const now = Math.floor(Date.now() / 1000);
  const dir = path.join(core.home, 'codex-home/sessions/2026/11/25');
  fs.mkdirSync(dir, { recursive: true });
  const line = { timestamp: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), type: 'event_msg', payload: { type: 'token_count', rate_limits: { secondary: { used_percent: used, window_minutes: 10_080, resets_at: now + 3 * 86_400 } } } };
  fs.writeFileSync(path.join(dir, 'rollout-2026-11-25T00-00-00-week.jsonl'), JSON.stringify(line) + '\n');
}
const codexChip = (app: Page) => app.locator('footer.status [data-switch="codex"]');
const codexMenu = (app: Page) => app.getByRole('menu', { name: 'Codex account for new sessions' });

test('account_switch: the chip names the account for new sessions, its menu picks another, and Settings shows the same pick', async ({ app, core }) => {
  setup(core);
  core.shell(core.project('demo'), 'work');
  await openWindow(app, {}, core);
  // Codex has one account here ("Your own"): nothing to switch, so no chip.
  await expect(app.locator('footer.status [data-switch="codex"]')).toHaveCount(0);
  await expect(chip(app)).toHaveAccessibleName('Claude account for new sessions: Default', { timeout: 15_000 });

  await chip(app).click();
  const rows = menu(app).getByRole('menuitemradio');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toHaveAttribute('aria-checked', 'true'); // Your own
  await expect(rows.nth(0)).toBeFocused();
  await expect(menu(app).locator(`[data-account="${OTHER}"]`)).toBeDisabled(); // signed out: not a choice
  await expect(menu(app).locator(`[data-account="${OTHER}"]`)).toContainText('Signed out');
  await app.screenshot({ path: `../.scratch/shots/account-switch-${test.info().project.name}.png` });

  // Esc closes and focus is back on the chip.
  await app.keyboard.press('Escape');
  await expect(menu(app)).toHaveCount(0);
  await expect(chip(app)).toBeFocused();

  // Keyboard: open, down to 회사, Enter.
  await app.keyboard.press('Enter');
  await app.keyboard.press('ArrowDown');
  await expect(menu(app).locator(`[data-account="${WORK}"]`)).toBeFocused();
  await app.keyboard.press('Enter');
  await expect(menu(app)).toHaveCount(0);
  await expect(chip(app)).toHaveAccessibleName('Claude account for new sessions: 회사');
  await expect(app.locator('footer.status').getByRole('status').filter({ hasText: 'New Claude sessions start on 회사. Running sessions keep theirs.' })).toBeVisible();

  // The same stored pick: Settings > Providers shows 회사 as the default, and it survives a reload.
  await chip(app).click();
  await menu(app).getByRole('menuitem', { name: 'Manage accounts…' }).click();
  await expect(app.getByRole('heading', { level: 2, name: /Providers/ })).toBeVisible();
  await openRow(app, 'Claude');
  await expect(app.locator(`#s-accounts .acct-card[data-account="${WORK}"]`)).toContainText('Default');
  await app.reload();
  await expect(chip(app)).toHaveAccessibleName('Claude account for new sessions: 회사', { timeout: 15_000 });
});

// Step 2: an ended Claude session continues on another account. The core copies the conversation's record into that
// account's folder and resumes there; the first account keeps its copy.
test('account_switch_continue: the shown ended session continues on another account, with its record copied there', async ({ app, core }) => {
  setup(core);
  fs.writeFileSync(path.join(core.home, 'accounts/claude', OTHER, '.logged-in'), ''); // 개인 is signed in here
  const project = core.project('alpha');
  type S = { id: string; state: string; account?: string; agent_session_id?: string | null; config_dir?: string | null };
  const snap = () => core.cli('snapshot', '--json').sessions as S[];
  const live = core.cli('session', 'start', '--kind', 'claude', '--project', project, '--label', 'live', '--account', '회사').session as S;
  const conversation = live.agent_session_id!;
  expect(conversation).toBeTruthy();
  const record = path.join(core.home, 'accounts/claude', WORK, 'projects/-some-folder', `${conversation}.jsonl`);
  fs.mkdirSync(path.dirname(record), { recursive: true });
  fs.writeFileSync(record, '{"type":"user"}\n');
  await openWindow(app, {}, core);
  const tab = app.locator(`.tab[data-tab="${live.id}"]`);
  await tab.click();

  // Ticket 1126: while it runs and is not mid-turn, the rows say they end it and reopen the conversation there.
  await chip(app).click();
  const group = menu(app).getByRole('group', { name: 'This session runs on 회사' });
  await expect(group.getByRole('menuitem', { name: /Continue this session on 개인/ })).toContainText('Ends “live” and opens the same conversation on 개인 in this tab.');
  await app.keyboard.press('Escape');

  core.windowClose(live.id); // ticket 1013 F6: the window's own Close keeps the done tab
  await expect.poll(() => snap().find((s) => s.id === live.id)?.state).not.toBe('running');
  await chip(app).click();
  await expect(group.getByRole('menuitem')).toHaveText(['Continue this session on Default', 'Continue this session on 개인']); // every other account not known to be signed out
  await group.getByRole('menuitem', { name: 'Continue this session on 개인' }).click();
  await expect(app.locator('footer.status').getByRole('status').filter({ hasText: 'The session continues on 개인.' })).toBeVisible();
  const moved = snap().find((s) => s.id !== live.id && s.account === '개인')!;
  expect(moved.agent_session_id).toBe(conversation);
  expect(fs.readFileSync(path.join(core.home, 'accounts/claude', OTHER, 'projects/-some-folder', `${conversation}.jsonl`), 'utf8')).toBe('{"type":"user"}\n');
  expect(fs.existsSync(record)).toBe(true);
  await expect(app.locator(`.tab[data-tab="${moved.id}"]`)).toHaveAttribute('aria-selected', 'true');
});

// Ticket 1126 (mockup docs/design/default-account-1126, states 1 to 4b). Shots go beside the mockup's states.
const shot = (app: Page, state: string) => app.screenshot({ path: `../.scratch/shots/1126-${state}-${test.info().project.name}.png` });
const features = (core: Core) => (JSON.parse(fs.readFileSync(path.join(core.home, 'settings.json'), 'utf8')).features ?? {}) as Record<string, unknown>;
/** The weekly shares Claude Code handed its status line, per account id (`claude-limits.json`, ticket 1036). */
function weekly(core: Core, used: Record<string, number>) {
  const now = Math.floor(Date.now() / 1000);
  const told = Object.fromEntries(Object.entries(used).map(([id, pct]) => [id, { at: now, weekly: { left_pct: 100 - pct, resets_at: now + 3 * 86_400 } }]));
  fs.writeFileSync(path.join(core.home, 'claude-limits.json'), JSON.stringify(told), { mode: 0o600 });
}
/** The window's usage read runs the core's rule (account_near.rs); the status bar reads its records at connect. */
async function records(app: Page, core: Core, key: string) {
  await expect.poll(() => features(core)[key], { timeout: 15_000 }).toBeTruthy();
  await app.reload();
}
const card = (app: Page, kind: string) => app.locator(`.acsw-card[data-card="${kind}"]`);

test('account_switch_1126_menu: the menu has no automatic switch and says every new session starts on the pick', async ({ app, core }) => {
  setup(core);
  codexAccounts(core);
  core.shell(core.project('demo'), 'work');
  await openWindow(app, {}, core);
  await chip(app).click();
  await expect(menu(app).locator('.hd').first()).toHaveText('New Claude sessions start on');
  // Usage numbers come from files sessions write: no automatic switch is offered (rounds 2 and 3).
  await expect(menu(app).getByRole('menuitemcheckbox', { name: /Switch new sessions automatically/ })).toHaveCount(0);
  await expect(menu(app)).toContainText("Every new session starts on the checked account: yours, your leads', their workers' and reviewers'.");
  await shot(app, 'state1');
  await codexChip(app).click();
  await expect(codexMenu(app).getByRole('menuitemcheckbox', { name: /Switch new sessions automatically/ })).toHaveCount(0);
  await chip(app).click();
  // Owner 2026-11-25: "Leads may use any of my accounts", off by default; the owner's click turns it on.
  const leads = menu(app).getByRole('menuitemcheckbox', { name: /Leads may use any of my accounts/ });
  await expect(leads).toHaveAttribute('aria-checked', 'false');
  await leads.click();
  await expect.poll(() => features(core)['accounts.leads_any']).toBe(true);
  await leads.click();
  await expect.poll(() => 'accounts.leads_any' in features(core)).toBe(false);
});

test('account_switch_1126_near: at 98% of the week a card offers the next account with one button; nothing switches by itself', async ({ app, core }) => {
  setup(core);
  weekly(core, { own: 98, [WORK]: 18 });
  await openWindow(app, {}, core);
  await records(app, core, 'accounts.near.claude');
  const near = card(app, 'near');
  await expect(near).toContainText('Default has used 98% of its week', { timeout: 15_000 });
  await expect(near).toContainText('New Claude sessions still start on Default. 회사 has used 18% of its week. Default resets');
  await expect(near.getByRole('checkbox')).toHaveCount(0);
  await expect(near).toContainText('Claude switches only when you click: its usage numbers come from its own sessions.');
  expect(features(core)['accounts.default.claude']).toBeUndefined();
  await shot(app, 'state3');
  await near.getByRole('button', { name: 'Start new sessions on 회사' }).click();
  await expect(chip(app)).toHaveAccessibleName('Claude account for new sessions: 회사');
  await expect(near).toHaveCount(0);
  expect(features(core)['accounts.default.claude']).toBe(WORK);
});

test('account_switch_1126_codex_near: a forged 98% Codex rollout with an old automatic-switch key on gives the card and moves nothing', async ({ app, core }) => {
  setup(core);
  codexAccounts(core);
  codexWeek(core, 98);
  const settings = path.join(core.home, 'settings.json');
  const s = fs.existsSync(settings) ? JSON.parse(fs.readFileSync(settings, 'utf8')) : {};
  fs.writeFileSync(settings, JSON.stringify({ ...s, features: { ...(s.features ?? {}), 'accounts.auto_switch.codex': true } }));
  await openWindow(app, {}, core);
  await codexChip(app).click(); // the menu's usage read runs the core's rule
  await expect.poll(() => features(core)['accounts.near.codex'], { timeout: 15_000 }).toBeTruthy();
  await codexChip(app).click();
  const near = card(app, 'near');
  await expect(near).toContainText('Default has used 98% of its week', { timeout: 15_000 });
  await expect(near.getByRole('checkbox')).toHaveCount(0);
  await expect(near).toContainText('Codex switches only when you click: its usage numbers come from its own sessions.');
  await expect(codexChip(app)).toHaveAccessibleName('Codex account for new sessions: Default');
  const f = features(core);
  expect(f['accounts.default.codex']).toBeUndefined();
  expect(f['accounts.switched.codex']).toBeUndefined();
});

test('account_switch_1126_all_near: every account at 98% shows a red card with the first reset and switches nothing', async ({ app, core }) => {
  setup(core);
  weekly(core, { own: 99, [WORK]: 98, [OTHER]: 100 });
  await openWindow(app, {}, core);
  await records(app, core, 'accounts.all_near.claude');
  const all = card(app, 'all');
  await expect(all).toContainText('Every Claude account has used 98% of its week', { timeout: 15_000 });
  await expect(all).toContainText('New sessions stay on Default (week 99%). Nothing switches until an account resets. First reset:');
  await expect(all).toHaveClass(/bad/);
  await shot(app, 'state4b');
  expect(features(core)['accounts.default.claude']).toBeUndefined();
});

// Round 4 (owner 2026-11-25 "사용자가 용량을 지정할수 있게"): the owner picks the level in the menu; the card shows at it.
test('account_switch_1126_level: the owner sets the card level in the menu and the card shows at it, not below', async ({ app, core }) => {
  setup(core);
  weekly(core, { own: 80, [WORK]: 18 });
  await openWindow(app, {}, core);
  await chip(app).click();
  const level = menu(app).getByRole('combobox', { name: 'Show the limit card when the checked account has used' });
  await expect(level).toHaveValue('98');
  await shot(app, 'level');
  await expect(card(app, 'near')).toHaveCount(0);
  await level.selectOption('85');
  await expect.poll(() => features(core)['accounts.near_percent']).toBe(85);
  await expect(card(app, 'near')).toHaveCount(0); // 80% is below 85
  await level.selectOption('80');
  await expect.poll(() => features(core)['accounts.near_percent']).toBe(80);
  await expect.poll(() => features(core)['accounts.near.claude'], { timeout: 15_000 }).toBeTruthy();
  await chip(app).click(); // the card waits behind an open menu
  const near = card(app, 'near');
  await expect(near).toContainText('Default has used 80% of its week', { timeout: 15_000 });
  await chip(app).click();
  await menu(app).getByRole('combobox', { name: 'Show the limit card when the checked account has used' }).selectOption('98');
  await expect.poll(() => 'accounts.near_percent' in features(core)).toBe(false); // absent is 98
  await expect.poll(() => features(core)['accounts.near.claude'], { timeout: 15_000 }).toBeFalsy();
});

test('account_switch_1126_level_all: every account at the chosen level: the red card names that level', async ({ app, core }) => {
  setup(core);
  weekly(core, { own: 91, [WORK]: 90, [OTHER]: 95 });
  await openWindow(app, {}, core);
  await chip(app).click();
  await menu(app).getByRole('combobox', { name: 'Show the limit card when the checked account has used' }).selectOption('90');
  await expect.poll(() => features(core)['accounts.all_near.claude'], { timeout: 15_000 }).toBeTruthy();
  await chip(app).click();
  await expect(card(app, 'all')).toContainText('Every Claude account has used 90% of its week', { timeout: 15_000 });
});

test('account_switch_1126_continue_running: a running session that is not mid-turn continues on another account in two clicks', async ({ app, core }) => {
  setup(core);
  fs.writeFileSync(path.join(core.home, 'accounts/claude', OTHER, '.logged-in'), '');
  const project = core.project('beta');
  type S = { id: string; state: string; account?: string; agent_session_id?: string | null };
  const snap = () => core.cli('snapshot', '--json').sessions as S[];
  const live = core.cli('session', 'start', '--kind', 'claude', '--project', project, '--label', 'fix login', '--account', '회사').session as S;
  const record = path.join(core.home, 'accounts/claude', WORK, 'projects/-some-folder', `${live.agent_session_id}.jsonl`);
  fs.mkdirSync(path.dirname(record), { recursive: true });
  fs.writeFileSync(record, '{"type":"user"}\n');
  await openWindow(app, {}, core);
  await app.locator(`.tab[data-tab="${live.id}"]`).click();
  await chip(app).click();
  const row = menu(app).getByRole('group', { name: 'This session runs on 회사' }).getByRole('menuitem', { name: /Continue this session on 개인/ });
  // Round 2 review SHOULD 2: mid-turn the row waits for the turn to end; nothing stops a turn.
  core.hook(live.id, 'UserPromptSubmit');
  await expect(row).toBeDisabled();
  await expect(row).toContainText('Waits for this turn to end.');
  core.hook(live.id, 'Stop');
  await expect(row).toBeEnabled();
  await shot(app, 'state2');
  await row.click();
  await expect.poll(() => snap().find((s) => s.id !== live.id && s.account === '개인')?.agent_session_id, { timeout: 15_000 }).toBe(live.agent_session_id);
  expect(snap().find((s) => s.id === live.id)?.state).not.toBe('running');
});

test('account_switch_1126_continue_failed: a continue whose start fails reopens the conversation on the account it ran on', async ({ app, core }) => {
  setup(core);
  fs.writeFileSync(path.join(core.home, 'accounts/claude', OTHER, '.logged-in'), '');
  const project = core.project('gamma');
  type S = { id: string; state: string; account?: string; agent_session_id?: string | null };
  const snap = () => core.cli('snapshot', '--json').sessions as S[];
  const live = core.cli('session', 'start', '--kind', 'claude', '--project', project, '--label', 'fix login', '--account', '회사').session as S;
  await openWindow(app, {}, core);
  await app.locator(`.tab[data-tab="${live.id}"]`).click();
  await chip(app).click();
  const row = menu(app).getByRole('group', { name: 'This session runs on 회사' }).getByRole('menuitem', { name: /Continue this session on 개인/ });
  await expect(row).toBeEnabled();
  fs.rmSync(path.join(core.home, 'accounts/claude', OTHER), { recursive: true }); // the start there now fails
  await row.click();
  await expect(app.locator('footer.status')).toContainText('It reopened on the account it ran on.', { timeout: 15_000 });
  await expect.poll(() => snap().some((s) => s.id !== live.id && s.state === 'running' && s.account === '회사' && s.agent_session_id === live.agent_session_id), { timeout: 15_000 }).toBe(true);
});
