import fs from 'node:fs';
import path from 'node:path';
import { expect, openWindow, test } from './fixtures';
import { openSettings } from './settings-modal';

const settingsFile = (home: string) => JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8'));

test('lifetime defaults to keep running; start at login is off; hook injection is on', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await openSettings(app);
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'General' }).click();
  await expect(app.getByRole('radio', { name: /Keep agents running/ })).toBeChecked();
  await expect(app.getByRole('switch', { name: /Start at login/ })).not.toBeChecked();
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Skills & hooks', exact: true }).click(); // ticket 391: the hook switch is in Skills & hooks > Nunchiro defaults
  await expect(app.getByRole('switch', { name: /Add Nunchiro hooks/ })).toBeChecked();
  await expect(app.getByText('Off: waiting is read from the transcript and screen instead')).toBeVisible();
});

test('the three settings are stored by the core and survive a core restart', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await openSettings(app);
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'General' }).click();
  await app.getByRole('radio', { name: /Stop agents when I quit/ }).check();
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Skills & hooks', exact: true }).click();
  await app.getByRole('switch', { name: /Add Nunchiro hooks/ }).uncheck();
  await expect.poll(() => settingsFile(core.home)).toMatchObject({ session_lifetime: 'end_with_app', disable_hook_injection: true });
  // Only the patched keys are written.
  expect(settingsFile(core.home).start_at_login).toBeUndefined();
  // Other keys of the file are kept.
  expect(settingsFile(core.home).worktrees_dir).toContain('wt');
  await app.reload();
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  await openSettings(app);
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'General' }).click();
  await expect(app.getByRole('radio', { name: /Stop agents when I quit/ })).toBeChecked();
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Skills & hooks', exact: true }).click();
  await expect(app.getByRole('switch', { name: /Add Nunchiro hooks/ })).not.toBeChecked();
});

// v1a-74 (needs 79)
test('lifetime history option hidden when off', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await openSettings(app);
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Terminal history', exact: true }).click(); // needs 192 (ticket 250): history has its own page
  const keep = app.getByRole('switch', { name: /Keep terminal history for restarts/ });
  const mask = app.getByRole('switch', { name: /Hide known secrets when saving/ });
  await expect(keep).toBeChecked();
  await expect(mask).not.toBeChecked();
  await expect(app.getByText(/Best effort/)).toBeVisible();
  await mask.check();
  await expect.poll(() => settingsFile(core.home).mask_history).toBe(true);
  await keep.uncheck();
  await expect(mask).toHaveCount(0);
  await expect.poll(() => settingsFile(core.home).keep_history).toBe(false);
  await keep.check();
  await expect(mask).toBeChecked();
});

// Look 1117 v13 N3: an accessibility press (VoiceOver, Switch Control: a click with no pointer events) and Space flip a switch,
// and so does that press on the row's name.
test('a switch flips on a click with no pointer events and on Space', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await openSettings(app);
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Terminal history', exact: true }).click();
  const mask = app.getByRole('switch', { name: /Hide known secrets when saving/ });
  await expect(mask).not.toBeChecked();
  await mask.evaluate((el) => (el as HTMLElement).click());
  await expect(mask).toBeChecked();
  await expect.poll(() => settingsFile(core.home).mask_history).toBe(true);
  await mask.focus();
  await app.keyboard.press('Space');
  await expect(mask).not.toBeChecked();
  await expect.poll(() => settingsFile(core.home).mask_history).toBe(false);
  // Look 1117 v14 N2: the press reaches the row's name text first; the name flips its switch, as a <label> would.
  await app.locator('.srow', { has: mask }).locator('.snm > span').first().evaluate((el) => (el as HTMLElement).click());
  await expect(mask).toBeChecked();
  await expect.poll(() => settingsFile(core.home).mask_history).toBe(true);
});

test('a core error on save is shown and the row keeps its stored value', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await openSettings(app);
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'General' }).click();
  await expect(app.getByRole('radio', { name: /Keep agents running/ })).toBeChecked();
  // A directory where the file goes makes the core's atomic write fail.
  fs.rmSync(path.join(core.home, 'settings.json'));
  fs.mkdirSync(path.join(core.home, 'settings.json'));
  await app.getByRole('radio', { name: /Stop agents when I quit/ }).click();
  await expect(app.getByRole('alert')).toBeVisible();
  await expect(app.getByRole('radio', { name: /Keep agents running/ })).toBeChecked();
});

test('after a core restart the window comes back with its tab, read-only, and nothing resumes by itself; Restart session resumes it (v25-shell-chrome, ticket 282)', async ({ app, core }) => {
  const project = core.project('demo');
  core.agent(project, 'alpha', path.join(project, 'never'));
  await openWindow(app);
  const before = core.cli('snapshot', '--json').sessions[0];
  expect(before.state).toBe('running');
  // Simulated restart: the core stops (agents end) and starts again.
  core.cli('serve', 'stop');
  await core.restart();
  const after = core.cli('snapshot', '--json').sessions[0];
  expect(after).toMatchObject({ state: 'resumable', agent_session_id: before.agent_session_id, pid: null });
  const page = app;
  await page.addInitScript((boot) => (window.__NUNCHIRO__ = boot), core.boot());
  await page.reload();
  // needs 207 (v25-quiet-chat): the "Resume where you left off" bar is gone; the session stays resumable in the core and
  // nothing resumes by itself (the tree row and the tab menu's Restart session are how it comes back, lane v25-shell-chrome).
  await expect(page.getByRole('region', { name: 'Sessions to resume' })).toHaveCount(0);
  await page.waitForTimeout(500);
  expect(core.cli('snapshot', '--json').sessions[0]).toMatchObject({ state: 'resumable', agent_session_id: before.agent_session_id });
  // v25-shell-chrome (ticket 282): the tab it had is back, and the session stays ended until the user restarts it.
  const tab = page.locator(`.tab[data-tab="${before.id}"]`);
  await expect(tab).toBeVisible();
  await expect(page.getByRole('region', { name: 'Sessions to resume' })).toHaveCount(0);
  expect(core.cli('snapshot', '--json').sessions[0].state).toBe('resumable');
  await tab.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Resume session' }).click();
  await expect.poll(() => core.cli('snapshot', '--json').sessions[0].state).toBe('running');
  const resumed = core.cli('snapshot', '--json').sessions[0];
  expect(resumed.agent_session_id).toBe(before.agent_session_id);
});
