// V2.5-31 (needs 145): the orchestration switch against a real core. Owner F5 (2026-11-08): a skill card only; no agent limits.
// Ticket 391: it moved from its own page into Skills & hooks > Nunchiro defaults.
import fs from 'node:fs';
import path from 'node:path';
import { expect, openWindow, test } from './fixtures';
import { openSettings } from './settings-modal';

const stored = (home: string) => JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8')).orchestration;

async function open(app: import('@playwright/test').Page) {
  await openSettings(app); // click 1
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Skills & hooks', exact: true }).click(); // click 2
  await expect(app.getByRole('heading', { name: 'Skills & hooks', level: 1 })).toBeVisible();
}

test('settings_orchestration_skill_card: switch persists, override opens, no limits', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await app.evaluate(() => {
    const w = window as unknown as { __revealed: string[]; __NUNCHIRO_FILES__: { reveal: (p: string) => void } };
    w.__revealed = [];
    w.__NUNCHIRO_FILES__ = { reveal: (p) => w.__revealed.push(p) };
  });
  await open(app);
  const enabled = app.getByRole('switch', { name: 'Orchestration skill for new sessions' });
  await expect(enabled).toBeChecked();

  // The removed controls stay gone: the card holds the hook, Nunchiro skill and orchestration switches only.
  const page = app.getByRole('region', { name: 'Nunchiro defaults' });
  await expect(page.getByRole('spinbutton')).toHaveCount(0);
  await expect(page.getByRole('radio')).toHaveCount(0);
  await expect(page.getByRole('switch')).toHaveCount(3);
  await expect(page.locator('[data-setting]')).toHaveCount(2);
  // Owner 2026-11-16: the row has View beside its switch, as the two rows above; the examples and the override copy open under it.
  await expect(page.getByText('Try asking an agent')).toHaveCount(0);
  await page.getByRole('button', { name: 'View: Orchestration skill for new sessions' }).click();
  const how = page.getByRole('group', { name: 'View: Orchestration skill for new sessions' });
  await expect(how).toContainText('Try asking an agent');
  await expect(how.locator('> .sds')).toHaveCount(4);

  await enabled.uncheck();
  await expect.poll(() => stored(core.home)?.enabled).toBe(false);

  const folder = path.join(core.home, 'skills', 'orchestration');
  expect(fs.existsSync(folder)).toBe(false);
  await page.getByRole('button', { name: 'Open my own copy of the files' }).click();
  await expect.poll(() => app.evaluate(() => (window as unknown as { __revealed: string[] }).__revealed)).toEqual([folder]);
  expect(fs.readdirSync(folder)).toEqual([]);

  await app.reload();
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  await open(app);
  await expect(enabled).not.toBeChecked();
});

test('settings_orchestration_old_keys: a settings.json from before F5 loads', async ({ app, core }) => {
  const file = path.join(core.home, 'settings.json');
  const before = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  fs.writeFileSync(file, JSON.stringify({ ...before, orchestration: { enabled: true, level: 'strict', max_workers: 3, max_depth: 2, merge: 'auto', auto_close_finished: false } }));
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await open(app);
  await expect(app.getByRole('switch', { name: 'Orchestration skill for new sessions' })).toBeChecked();
});
