// Ticket 260 (G28): Settings › Providers › Shell environment (features/user-env.tsx) saves the core's `env.inherit_shell`
// and `env.names`, which crates/nunchiro-core/src/user_env.rs reads at each PTY session start (tests/user_env.rs there).
import fs from 'node:fs';
import path from 'node:path';
import { expect, openWindow, test, type Core } from './fixtures';

const stored = (core: Core, key: string) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(core.home, 'settings.json'), 'utf8')).features?.[key];
  } catch {
    return undefined;
  }
};

test('shell_env_rows_on_agents_page_and_searchable', async ({ app, core }) => {
  await openWindow(app);
  await app.getByRole('navigation', { name: 'Left bar' }).getByRole('button', { name: 'Settings' }).click();
  await app.getByRole('searchbox', { name: 'Search settings' }).fill('login shell');
  await app.getByRole('list', { name: 'Matching settings' }).getByRole('button', { name: /Use my login shell environment/ }).click();
  await expect(app.locator('.settings header.phd h1')).toHaveText('Providers');
  const body = app.locator('.sbody');
  await expect(body.locator('[data-setting="envInheritShell"]')).toBeFocused();
  const sec = body.getByRole('region', { name: 'Shell environment' });
  const on = sec.getByRole('switch', { name: 'Use my login shell environment' });
  await expect(on).toBeChecked();
  // The test core never reads a login shell (fixtures set NUNCHIRO_LOGIN_PATH=off), and the section says so.
  await expect(sec.locator('[data-field="shell-env-error"]')).toContainText('NUNCHIRO_LOGIN_PATH=off');
  const names = sec.getByLabel('Variables to pass from your shell', { exact: true });
  await expect(names).toHaveCount(0); // only while the switch is off
  await on.click();
  await expect.poll(() => stored(core, 'env.inherit_shell')).toBe(false);
  await expect(sec).toContainText('PATH, locale and SSH_AUTH_SOCK are always passed.');
  // A name a shell would not accept and a repeat are dropped.
  await names.fill('AWS_PROFILE bad-name NODE_OPTIONS AWS_PROFILE');
  await names.press('Enter');
  await expect.poll(() => stored(core, 'env.names')).toEqual(['AWS_PROFILE', 'NODE_OPTIONS']);
  await expect(names).toHaveValue('AWS_PROFILE NODE_OPTIONS');
  // Back to the defaults: both keys go away.
  await sec.getByRole('button', { name: 'Reset Variables to pass from your shell to default' }).click();
  await expect.poll(() => stored(core, 'env.names')).toBeUndefined();
  await sec.getByRole('button', { name: 'Reset Use my login shell environment to default' }).click();
  await expect.poll(() => stored(core, 'env.inherit_shell')).toBeUndefined();
  await expect(on).toBeChecked();
});

// Ticket 1008: the switch that leaves secret-looking names out of agent sessions (on by default) and the names kept.
test('secret_env_rows_save_names_only', async ({ app, core }) => {
  await openWindow(app);
  await app.getByRole('navigation', { name: 'Left bar' }).getByRole('button', { name: 'Settings' }).click();
  await app.getByRole('searchbox', { name: 'Search settings' }).fill('API key');
  await app.getByRole('list', { name: 'Matching settings' }).getByRole('button', { name: /Leave secret-looking variables out of agents/ }).click();
  const sec = app.locator('.sbody').getByRole('region', { name: 'Shell environment' });
  const strip = sec.getByRole('switch', { name: 'Leave secret-looking variables out of agents' });
  await expect(strip).toBeFocused();
  await expect(strip).toBeChecked();
  await expect(sec).toContainText('Shell tabs you open keep them.');
  const keep = sec.getByLabel('Keep these variables for agents', { exact: true });
  await keep.fill('ANTHROPIC_API_KEY bad-name ANTHROPIC_API_KEY');
  await keep.press('Enter');
  await expect.poll(() => stored(core, 'env.keep_secrets')).toEqual(['ANTHROPIC_API_KEY']);
  await strip.click();
  await expect.poll(() => stored(core, 'env.strip_secrets')).toBe(false);
  // Ticket 1024 (ledger v27-a-S3-3): off, the kept names stay in view, greyed (not editable), with the reason on the
  // row, and Reset still clears them.
  await expect(keep).toBeDisabled();
  await expect(keep).toHaveValue('ANTHROPIC_API_KEY');
  expect(await keep.getAttribute('aria-describedby')).toBe('why-env-keep');
  await expect(sec.locator('[data-why="why-env-keep"]')).toHaveText('These names are not used while the switch above is off. Reset clears them.');
  await sec.getByRole('button', { name: 'Reset Keep these variables for agents to default' }).click();
  await expect.poll(() => stored(core, 'env.keep_secrets')).toBeUndefined();
  await expect(keep).toHaveCount(0); // nothing kept: the row shows only while the switch is on
  await sec.getByRole('button', { name: 'Reset Leave secret-looking variables out of agents to default' }).click();
  await expect.poll(() => stored(core, 'env.strip_secrets')).toBeUndefined();
  await expect(keep).toBeEnabled();
  await expect(keep).toHaveValue('');
});
