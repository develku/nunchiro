// Ticket 391 part 1 review (b): a stored default agent whose 사용 switch is off shows its proper name marked off in the
// Default agent select, and opening the page writes nothing.
import { STORE_VERSION } from '../src/settings';
import { expect, openWindow, test } from './fixtures';
import { openSettings } from './settings-modal';

test('default_agent_off_named: a stored Claude default with Claude off reads "Claude (Off)" and stays stored', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await app.addInitScript((version) => {
    if (!sessionStorage.getItem('seeded')) {
      localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ version, features: { 'onboarding.default_agent': 'claude', 'agents.off': ['claude'] } }));
      sessionStorage.setItem('seeded', '1');
    }
  }, STORE_VERSION);
  await openWindow(app);
  await openSettings(app);
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Providers' }).click();
  const select = app.getByRole('combobox', { name: 'Default agent' });
  await expect(select).toHaveValue('claude');
  await expect(select.locator('option:checked')).toHaveText('Claude (Off)');
  // The stored value is not rewritten by opening the page.
  const stored = () => app.evaluate(() => JSON.parse(localStorage.getItem('nunchiro.settings.v1') ?? '{}').features?.['onboarding.default_agent']);
  expect(await stored()).toBe('claude');
});
