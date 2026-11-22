// Ticket 372 against a real core: a live fake Claude prints Claude Code 2.1.312's limit line. Its tree row reads as the
// yellow clock with "Limit", its tab dot and session header say limited, and its band offers Resume at <time>; a press turns
// it into Cancel (armed in the core, nothing typed), Cancel turns it back. When the line leaves the screen the band goes
// and the row returns to normal. The send at the reset itself is the core's test
// (sessions.rs `limit_resume_arms_fires_once_and_cancels`): a spec cannot wait for a printed minute to come round.
// Screenshots go to .scratch/shots/372 for REPORT.md.
import fs from 'node:fs';
import path from 'node:path';
import { REPO, expect, openWindow, test } from './fixtures';

// Prints the screen the test left, waits for the test's `clear` file, then clears the screen and idles as `cat`.
const FAKE = `#!/bin/sh
case "$1" in --version) echo "2.1.312 (Claude Code)"; exit 0;; esac
[ "$1 $2" = "auth status" ] && { echo '{"loggedIn": true}'; exit 0; }
cat "$NUNCHIRO_HOME/screen" 2>/dev/null
while [ ! -f "$NUNCHIRO_HOME/clear" ]; do sleep 0.1; done
printf '\\033[2J\\033[H> \\r\\n'
exec /bin/cat
`;
/** Two hours from now in this machine's zone, as Claude prints a reset within a day ("4:05pm"). */
function resetAhead() {
  const t = new Date(Date.now() + 7_200_000);
  const h = t.getHours();
  return `${((h + 11) % 12) + 1}:${String(t.getMinutes()).padStart(2, '0')}${h < 12 ? 'am' : 'pm'}`;
}

test('limit_band_resume_and_row_state: a live limited session shows its band and row; Resume arms, Cancel disarms', async ({ app, core }, info) => {
  const out = path.join(REPO, '.scratch/shots/372');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(core.home, 'bin', 'claude'), FAKE, { mode: 0o700 });
  const resets = resetAhead();
  fs.writeFileSync(path.join(core.home, 'screen'), `You've hit your 5-hour limit · resets ${resets} (Local)\r\n/rate-limit-options\r\n`);
  const project = core.project('demo');
  const session = core.cli('session', 'start', '--kind', 'claude', '--project', project, '--label', 'calm').session as { id: string };
  await expect.poll(() => core.screen(session.id)).toContain("You've hit your 5-hour limit");

  await openWindow(app);
  await app.locator(`.tab[data-tab="${session.id}"]`).click();
  const band = app.locator('.problem-band.limit');
  await expect(band).toContainText('Usage limit reached · resets');
  const resume = band.getByRole('button', { name: /^Resume at / });
  await expect(resume).toBeVisible();
  await expect(band.getByRole('button', { name: 'Switch agent' })).toBeVisible();
  // The tree row: the yellow clock with "Limit", its reset in the tip; the tab dot and the session header say limited.
  const row = app.locator('.row.wt2[data-kind="limit"]');
  await expect(row).toHaveCount(1);
  await expect(row).toHaveClass(/\bwarn\b/);
  await expect(row).toContainText('Limit');
  await expect(row).toHaveAttribute('aria-label', new RegExp(`Usage limit · resets ${resets}`));
  await expect(app.locator(`.tab[data-tab="${session.id}"] .tdot`)).toHaveAttribute('data-s', 'limited');
  await expect(app.locator('.shead .dim').first()).toContainText('claude · limited');
  await expect(app.locator('.status .flimit')).toHaveCount(0); // ticket 1031: no limit chip; the band and the usage block say it
  await app.locator('.pane, .centre').first().screenshot({ path: path.join(out, `band-${info.project.name}.png`) }).catch(() => {});
  await app.screenshot({ path: path.join(out, `window-${info.project.name}.png`) });

  // Resume at <time>: armed in the core, nothing typed into the session now.
  await resume.click();
  await expect(band).toHaveAttribute('data-limit', 'armed');
  await expect(band).toContainText('One “continue” message will be sent to this session at');
  await expect(band.getByRole('button', { name: 'Cancel' })).toBeVisible();
  const armed = () => (core.cli('snapshot', '--json').sessions as { id: string; limit?: { armed?: boolean } }[]).find((s) => s.id === session.id)?.limit?.armed ?? false;
  expect(armed()).toBe(true);
  expect(core.screen(session.id)).not.toContain('Continue where you left off');
  await app.screenshot({ path: path.join(out, `armed-${info.project.name}.png`) });
  // Cancel: disarmed, the band is the first one again.
  await band.getByRole('button', { name: 'Cancel' }).click();
  await expect(band).toHaveAttribute('data-limit', 'reached');
  await expect(resume).toBeVisible();
  expect(armed()).toBe(false);

  // The line leaves the screen: no band, and the row is no longer limited.
  fs.writeFileSync(path.join(core.home, 'clear'), '');
  await expect(band).toHaveCount(0);
  await expect(app.locator('.row.wt2[data-kind="limit"]')).toHaveCount(0);
  await expect(app.locator(`.tab[data-tab="${session.id}"] .tdot`)).not.toHaveAttribute('data-s', 'limited');
  expect(core.screen(session.id)).not.toContain('Continue where you left off');
});

// Ticket 1031: the status bar's Codex limit chip is gone; the usage block that replaced it is usage-block-1031.spec.ts.

// Round 2, the fail scene: the arm is refused (the window's socket answers it with the core's refusal shape, as
// tree-rows.spec.ts proxies the socket); the reason shows on the band's error line, the button stays Resume at <time>.
test('limit_band_fail_scene: a refused arm says why on the band and keeps the button', async ({ app, core }, info) => {
  const out = path.join(REPO, '.scratch/shots/372');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(core.home, 'bin', 'claude'), FAKE, { mode: 0o700 });
  fs.writeFileSync(path.join(core.home, 'screen'), `You've hit your 5-hour limit · resets ${resetAhead()} (Local)\r\n/rate-limit-options\r\n`);
  const project = core.project('demo');
  const session = core.cli('session', 'start', '--kind', 'claude', '--project', project, '--label', 'calm').session as { id: string };
  await expect.poll(() => core.screen(session.id)).toContain("You've hit your 5-hour limit");
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => {
      const frame = typeof m === 'string' ? JSON.parse(m) : null;
      if (frame?.request?.op === 'limit_resume') ws.send(JSON.stringify({ id: frame.id, response: { Err: 'the session did not answer' } }));
      else server.send(m);
    });
    server.onMessage((m) => ws.send(m));
  });
  await openWindow(app);
  await app.locator(`.tab[data-tab="${session.id}"]`).click();
  const band = app.locator('.problem-band.limit');
  await band.getByRole('button', { name: /^Resume at / }).click();
  // Ticket 534: one sentence with the reason in plain words; the session's own words under a closed Details.
  await expect(band.getByRole('alert')).toHaveText(/^Not scheduled because the session did not answer; try again in a moment\.Details/);
  await expect(band.getByRole('alert').locator('details.err-details')).not.toHaveAttribute('open');
  await expect(band.getByRole('alert').locator('details.err-details')).toContainText('the session did not answer');
  await expect(band).toHaveAttribute('data-limit', 'reached');
  await expect(band.getByRole('button', { name: /^Resume at / })).toBeEnabled();
  expect((core.cli('snapshot', '--json').sessions as { id: string; limit?: { armed?: boolean } }[]).find((s) => s.id === session.id)?.limit?.armed ?? false).toBe(false);
  await app.screenshot({ path: path.join(out, `fail-${info.project.name}.png`) });
});
