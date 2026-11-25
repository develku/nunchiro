// Ticket 494 (상태 확인이 실패하면 프로바이더 줄에 다음 할 일이 없음): when Claude's own status command fails (it exits 2,
// as in the first-use walk), the Providers row says it could not check and why, offers Sign in (the signed-out row's
// action) beside Check, and a Check shows that it ran even when the answer is the same. The agent is a fake, never a login.
import type { Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { stripOnTop, expect, openWindow, REPO, test, type Core } from './fixtures';
import { openSettings } from './settings-modal';

test.beforeEach(({ core }) => stripOnTop(core));

// The status run takes a second and exits 2 with nothing on stdout; any session idles as `cat`. It makes no config folder
// (ticket 509: the core's login step makes it).
const CLAUDE = `#!/bin/sh
case "$1" in --version) echo '2.1.311 (Claude Code)'; exit 0;; esac
if [ "$1 $2" = "auth status" ]; then sleep 1.2; echo 'unexpected failure' >&2; exit 2; fi
printf 'fake agent ready\\r\\n'
exec /bin/cat
`;
const setup = (core: Core) => fs.writeFileSync(path.join(core.home, 'bin/claude'), CLAUDE, { mode: 0o700 });
const head = (app: Page) => app.locator('#s-accounts [data-row="claude"]');
const note = (app: Page) => app.locator('#s-accounts .acct-agent[data-agent="claude"] .prv-checkfail');
const shot = (name: string) => path.join(REPO, '.scratch/shots', `494-${name}-${test.info().project.name}.png`);
type Listed = { label: string; state: string };
const snap = (core: Core) => core.cli('snapshot', '--json').sessions as Listed[];

test('check_failed_offers_next_step: a failed status check says so and why, offers Sign in beside Check, and a Check shows it ran', async ({ app, core }) => {
  setup(core);
  await openWindow(app);
  await openSettings(app);
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Providers' }).click();
  await expect(head(app).locator('.prv-chips')).toHaveText("Could not check", { timeout: 20_000 });
  // Why, in plain words, and what to try next.
  await expect(note(app)).toContainText('gave no answer');
  await expect(note(app)).toContainText('run Claude once in a terminal');
  await expect(note(app)).toContainText(/Checked at \d/);
  // Sign in beside Check.
  const check = head(app).getByRole('button', { name: 'Check Claude sign-in for Default' });
  const signIn = head(app).getByRole('button', { name: 'Sign in to Claude · Default' });
  await expect(check).toBeVisible();
  await expect(signIn).toBeVisible();
  fs.mkdirSync(path.join(REPO, '.scratch/shots'), { recursive: true });
  await app.locator('#s-accounts .acct-agent[data-agent="claude"]').screenshot({ path: shot('failed') });
  // Check again: busy while it runs, then a new time though the answer is the same.
  const before = await note(app).innerText();
  await check.click();
  await expect(check).toHaveText('Checking…');
  await expect(check).toHaveAttribute('aria-busy', 'true');
  await expect(check).toHaveText('Check', { timeout: 20_000 });
  await expect(note(app)).not.toHaveText(before);
  await expect(head(app).locator('.prv-chips')).toHaveText("Could not check");
  // Sign in starts the same terminal login as a signed-out "Your own".
  await signIn.click();
  await expect.poll(() => snap(core).some((s) => s.label === 'Login: Default')).toBe(true);
});
