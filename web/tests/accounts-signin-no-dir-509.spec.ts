// Ticket 509 (~/.claude 폴더가 없으면 '내 계정' 로그인이 실패함): a new user who installed Claude but never ran it has no
// config folder. Sign in for "Your own" still starts the terminal login, and no "No such file or directory" shows. The
// fake never makes a folder (unlike 494's), and its login waits like a real one. The agent is a fake, never a login.
import fs from 'node:fs';
import path from 'node:path';
import { stripOnTop, expect, openWindow, test, type Core } from './fixtures';
import { openSettings } from './settings-modal';

test.beforeEach(({ core }) => stripOnTop(core));

// Signed out; the login stays open (as a real one waits for its code); any other run idles as `cat`. No mkdir anywhere.
const CLAUDE = `#!/bin/sh
case "$1" in --version) echo '2.1.311 (Claude Code)'; exit 0;; esac
if [ "$1 $2" = "auth status" ]; then echo '{"loggedIn": false, "authMethod": "none"}'; exit 1; fi
if [ "$1 $2" = "auth login" ]; then printf 'fake login waiting\\r\\n'; exec /bin/cat; fi
printf 'fake agent ready\\r\\n'
exec /bin/cat
`;
const setup = (core: Core) => fs.writeFileSync(path.join(core.home, 'bin/claude'), CLAUDE, { mode: 0o700 });
type Listed = { label: string; state: string };
const snap = (core: Core) => core.cli('snapshot', '--json').sessions as Listed[];

test('signin_without_config_folder: Sign in for the Default account starts the login when the config folder does not exist yet', async ({ app, core }) => {
  setup(core);
  const folder = core.env.CLAUDE_CONFIG_DIR!; // "Your own"'s folder for this core
  expect(fs.existsSync(folder)).toBe(false);
  await openWindow(app);
  await openSettings(app);
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Providers' }).click();
  const set = app.getByRole('dialog', { name: 'Settings' });
  await expect(set.getByText('Signed out').first()).toBeVisible({ timeout: 20_000 });
  // As in the first-use walk: the row's account and Sign in are behind its expand control.
  await set.getByRole('button', { name: /Claude/, expanded: false }).first().click();
  const signIn = set.getByRole('button', { name: /Sign in/ }).first();
  await expect(signIn).toBeVisible();
  expect(fs.existsSync(folder)).toBe(false); // a check never makes it; only the Sign in press does
  await signIn.click();
  // The login session runs, in a folder made owner-only and left empty by the core.
  await expect.poll(() => snap(core).find((s) => s.label === 'Login: Default')?.state, { timeout: 20_000 }).toBe('running');
  await expect(app.getByText(/No such file or directory/)).toHaveCount(0);
  expect(fs.statSync(folder).mode & 0o777).toBe(0o700);
  expect(fs.readdirSync(folder)).toEqual([]);
});
