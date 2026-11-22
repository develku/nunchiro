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

  // While it runs there is nothing to press: the menu says to end it first.
  await chip(app).click();
  const group = menu(app).getByRole('group', { name: 'This session runs on 회사' });
  await expect(group).toContainText('End this session first; then it can continue on another account.');
  await expect(group.getByRole('menuitem')).toHaveCount(0);
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
