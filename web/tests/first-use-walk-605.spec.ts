// Ticket 605 (first-use walk 3, F10): a Codex session that failed because Codex is not installed reads `exited` after the
// core restarts (the app quit and opened again). Ticket 603 dropped the "codex unknown is an untested version" band only
// for `failed`, so it came back next to "Codex is not installed".
import { expect, test } from './fixtures';

test('walk3_605_no_version_band_on_a_never_started_session_after_a_core_restart', async ({ app, core }) => {
  const project = core.project('demo');
  try {
    core.cli('session', 'start', '--kind', 'codex', '--project', project, '--label', 'cx');
  } catch {
    // The start may report the failure itself; the session is kept either way.
  }
  core.run(['serve', 'stop', '--yes']);
  await core.restart();
  const cx = () => (core.cli('snapshot', '--json').sessions as { id: string; label: string; state: string }[]).find((s) => s.label === 'cx');
  await expect.poll(() => cx()?.state).toBe('exited');
  // The fixture's boot names the first core's port and token; this one runs after it.
  await app.addInitScript((b) => {
    window.__NUNCHIRO__ = b;
  }, core.boot());
  await app.goto('/');
  await app.locator('.tree').getByText('cx', { exact: true }).click();
  const chat = app.locator(`.chat[data-session="${cx()!.id}"]`);
  await expect(chat).toBeVisible();
  await expect(app.locator('.problem-band .cause')).toContainText('Codex is not installed');
  await expect(chat.locator('.vbanner')).toHaveCount(0);
});
