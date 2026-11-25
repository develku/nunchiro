// V2-2c limit mark on Settings > Accounts against a real core: a fake Claude on account "Work" prints Claude Code
// 2.1.312's limit line; that row alone shows "limit · resets <time>", reached from Settings > Accounts (two clicks).
// Screenshots with and without the mark go to .scratch/limit-shots for REPORT.md.
import fs from 'node:fs';
import path from 'node:path';
import { REPO, expect, openWindow, test, codexFake } from './fixtures';
import { openRow } from './accounts-rows';

const ID = 'aaaaaaaa-0000-4000-8000-000000000031';
// Status probes fail fast; a session prints the screen the test left, then idles.
const FAKE = `#!/bin/sh
case "$1" in --version) echo "2.1.312 (Claude Code)"; exit 0;; esac
[ "$1 $2" = "auth status" ] && { echo '{"loggedIn": true}'; exit 0; }
[ "$1 $2" = "login status" ] && exit 1
cat "$NUNCHIRO_HOME/screen" 2>/dev/null
exec /bin/cat
`;
/** Two hours from now in this machine's zone, as Claude prints a reset within a day ("4:05pm"). */
function resetAhead() {
  const t = new Date(Date.now() + 7_200_000);
  const h = t.getHours();
  return `${((h + 11) % 12) + 1}:${String(t.getMinutes()).padStart(2, '0')}${h < 12 ? 'am' : 'pm'}`;
}

test('limit_mark_shows_on_accounts_page: only the marked account row shows the reset time', async ({ app, core }, info) => {
  const out = path.join(REPO, '.scratch/limit-shots');
  fs.mkdirSync(out, { recursive: true });
  for (const name of ['claude', 'codex']) fs.writeFileSync(path.join(core.home, 'bin', name), codexFake(FAKE), { mode: 0o700 });
  fs.mkdirSync(path.join(core.home, 'accounts/claude', ID), { recursive: true });
  fs.writeFileSync(path.join(core.home, 'accounts.toml'), `version = 1\n\n[[accounts]]\nagent = "claude"\nid = "${ID}"\nlabel = "Work"\n`);
  const project = core.project('demo');
  core.shell(project, 'alpha');

  await openWindow(app);
  const open = async () => {
    // Two clicks on visible, labelled controls: the Settings button, then Accounts.
    await app.getByRole('button', { name: 'Settings', exact: true }).click();
    await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Providers' }).click();
    await openRow(app, 'Claude');
  };
  await open();
  const rows = (agent: string) => app.locator('#s-accounts').locator(`.acct-card[data-agent-name="${agent}"]`); // v25-fix-settings: Usage shares the page
  await expect(rows('Claude')).toHaveCount(2);
  await expect(app.locator('#s-accounts')).not.toContainText('limit · resets');
  await app.locator('#s-accounts').screenshot({ path: path.join(out, `without-mark-${info.project.name}.png`) });

  const resets = resetAhead();
  fs.writeFileSync(path.join(core.home, 'screen'), `You've hit your 5-hour limit · resets ${resets} (Local)\r\n/rate-limit-options\r\n`);
  const session = core.cli('session', 'start', '--kind', 'claude', '--project', project, '--label', 'limited', '--account', 'Work').session as { id: string };
  await expect.poll(() => core.screen(session.id)).toContain("You've hit your 5-hour limit");
  // Back to the tab and to Settings again: the page refetches on open (v25f: Esc closes the Settings modal).
  await app.keyboard.press('Escape');
  await expect(app.locator('#s-accounts')).toHaveCount(0);
  await open();
  const work = rows('Claude').and(app.locator(`[data-account="${ID}"]`));
  await expect(work).toContainText(`limit · resets ${resets}`);
  await expect(rows('Claude').first()).not.toContainText('limit · resets');
  await expect(app.locator('#s-accounts').getByText('limit · resets')).toHaveCount(1);
  await expect(app.getByText(/switch account/i)).toHaveCount(0);
  await expect(app.locator('#s-accounts')).not.toContainText('%');
  await app.locator('#s-accounts').screenshot({ path: path.join(out, `with-mark-${info.project.name}.png`) });
});
