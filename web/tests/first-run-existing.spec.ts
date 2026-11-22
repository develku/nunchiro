// Round 3 of ticket 305: a user who already has sessions but no first-run flag (webview data cleared) is not sent to Onboarding.
import { expect, openWindow, test } from './fixtures';

test.describe('existing user, flag lost', () => {
  test.use({ firstRun: true });

  test('first_run_skipped_when_sessions_exist: no Settings modal, the flag is set, the session stays open', async ({ app, core }) => {
    core.shell(core.project('beta'), 'beta');
    await openWindow(app, {}, core);
    // The flag first: it is set only once the guard has decided, so the negative counts below cannot pass by sampling early.
    await expect.poll(() => app.evaluate(() => localStorage.getItem('nunchiro.firstrun.started'))).toBe('1');
    await expect(app.getByRole('dialog', { name: 'Settings' })).toHaveCount(0);
    await expect(app.locator('.ob-step')).toHaveCount(0);
    await app.reload();
    await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
    await expect(app.getByRole('dialog', { name: 'Settings' })).toHaveCount(0);
  });
});
