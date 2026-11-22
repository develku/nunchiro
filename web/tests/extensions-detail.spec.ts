// Ticket 455: Settings > Skills & hooks shows what a hook runs and when (Nunchiro's own hooks and a custom hook item), and
// the three defaults say when they are off their recommended value, with the kit's reset. Real core, the test's own home.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, openWindow, test, type Core } from './fixtures';
import { openSettings } from './settings-modal';

async function open(app: Page, core: Core) {
  await openWindow(app, {}, core);
  await openSettings(app);
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Skills & hooks', exact: true }).click();
  await expect(app.getByRole('heading', { level: 1, name: 'Skills & hooks', exact: true })).toBeVisible();
}
const row = (app: Page, id: string) => app.locator(`[data-row="ext:${id}"]`);

test('hooks_view: the hooks Nunchiro adds are shown, read only: each event, when it fires and the command', async ({ app, core }) => {
  await open(app, core);
  await row(app, 'nunchiro-hooks').getByRole('button', { name: 'View the hooks Nunchiro adds' }).click();
  const view = app.getByRole('group', { name: 'The hooks Nunchiro adds' });
  // One line per event a launch passes (sessions.rs HOOK_EVENTS), with the command Nunchiro runs on it.
  await expect(view.locator('tbody tr')).toHaveCount(9);
  const stop = view.locator('tbody tr', { hasText: 'The agent finishes its turn.' });
  await expect(stop.locator('td').first()).toHaveText('Stop');
  await expect(stop.locator('td').last()).toHaveText(/ hook Stop$/);
  await expect(view).toContainText('Read only.');
  await expect(view.getByRole('textbox')).toHaveCount(0);
  await row(app, 'nunchiro-hooks').getByRole('button', { name: 'View the hooks Nunchiro adds' }).click();
  await expect(view).toHaveCount(0);
});

test('own_hook_lines: a custom hook item says when it runs which command, above its files', async ({ app, core }) => {
  const dir = path.join(core.home, 'extensions/my-hooks/hooks');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'hooks.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: './check-command.sh' }] }] } }));
  await open(app, core);
  await row(app, 'custom:my-hooks').getByRole('button', { name: 'Edit the files of my-hooks' }).click();
  const lines = app.getByRole('group', { name: 'What my-hooks runs' });
  await expect(lines.locator('tbody tr')).toHaveCount(1);
  // The Runs cell shows the program's name, the whole command in its tooltip (ba25ef2f3).
  await expect(lines.locator('tbody td')).toHaveText(['PreToolUse [Bash]', 'Before the agent uses a tool.', 'check-command.sh']);
  await expect(lines.locator('tbody td').last()).toHaveAttribute('title', './check-command.sh');
  await expect(lines).toContainText('Read them before turning it on.');
});

test('recommended: a default that is off says the recommended value, a row reset and the card reset put it back', async ({ app, core }) => {
  await open(app, core);
  const base = app.getByRole('region', { name: 'Nunchiro defaults' });
  await expect(base).toContainText('Recommended: all on');
  const skill = row(app, 'nunchiro');
  // All on: nothing to reset.
  await expect(base.getByText('Recommended: on')).toHaveCount(0);
  await expect(base.getByRole('button', { name: /^Reset / })).toHaveCount(0);
  // One off: the row says so and has its reset; the card has its reset too.
  await skill.getByRole('switch').click();
  await expect(skill.getByText('Recommended: on')).toBeVisible();
  await expect(base.getByRole('button', { name: 'Reset Nunchiro defaults to defaults' })).toBeVisible();
  await skill.getByRole('button', { name: 'Reset Nunchiro skill to default' }).click();
  await expect(skill.getByRole('switch')).toBeChecked();
  await expect(base.getByText('Recommended: on')).toHaveCount(0);
  // Two off, then the card's reset: both back on.
  await skill.getByRole('switch').click();
  await row(app, 'nunchiro-hooks').getByRole('switch').click();
  await expect(base.getByText('Recommended: on')).toHaveCount(2);
  await base.getByRole('button', { name: 'Reset Nunchiro defaults to defaults' }).click();
  await expect(skill.getByRole('switch')).toBeChecked();
  await expect(row(app, 'nunchiro-hooks').getByRole('switch')).toBeChecked();
  await expect(base.getByText('Recommended: on')).toHaveCount(0);
});
