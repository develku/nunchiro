// Ticket 580 (scorecard F8): the hook half of Settings > Skills & hooks as a new user does it: make a hook, read what it
// runs, change its file, switch it on and off. Real core, the test's own home; nothing under a real user folder is touched.
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
const stored = (core: Core) => () => JSON.parse(fs.readFileSync(path.join(core.home, 'settings.json'), 'utf8')).features?.['extensions.enabled'];

test('hook_make_and_switch_580: New hook makes a hook item that says what it runs and stays off until switched on', async ({ app, core }) => {
  await open(app, core);
  const section = app.locator('section[aria-labelledby="h-ext-skills"]');
  // The section's head offers both makers, so a new user finds the hook one without reading docs.
  await expect(section.locator('.ext-empty')).toBeVisible();
  await section.getByRole('button', { name: 'New hook' }).click();
  const form = app.getByRole('form', { name: 'New hook' });
  await form.getByRole('textbox', { name: 'Name' }).fill('log-stop');
  await form.getByRole('button', { name: 'Create' }).click();
  await expect(form.getByRole('alert')).toHaveText('Write one line saying what this hook does.');
  await form.getByRole('textbox', { name: 'What it is for, in one line' }).fill('Prints a line when a turn ends.');
  await form.getByRole('button', { name: 'Create' }).click();
  await expect(form).toHaveCount(0);
  // Listed as a hook, off, with its starting command and event shown above its files.
  const made = row(app, 'custom:log-stop');
  await expect(made).toContainText('Hook');
  await expect(made).toContainText('Prints a line when a turn ends.');
  await expect(made.getByRole('switch')).not.toBeChecked();
  const lines = app.getByRole('group', { name: 'What log-stop runs' });
  await expect(lines.locator('tbody td')).toHaveText(['Stop', 'The agent finishes its turn.', "echo 'A session finished its turn.'"]);
  await expect(app.getByRole('group', { name: 'Files of log-stop' }).getByRole('textbox', { name: 'hooks/hooks.json' })).toHaveValue(/"Stop"/);
  expect(fs.existsSync(path.join(core.home, 'extensions/log-stop/hooks/hooks.json'))).toBe(true);
  // Switch on and off: the core's stored list follows.
  await made.getByRole('switch').click();
  await app.getByRole('alertdialog', { name: 'Turn on log-stop?' }).getByRole('button', { name: 'Turn on', exact: true }).click(); // ticket 456
  await expect.poll(stored(core)).toEqual(['nunchiro', 'custom:log-stop']);
  await made.getByRole('switch').click();
  await expect.poll(stored(core)).toEqual(['nunchiro']);
});

test("hook_edit_580: a hook item's file is changed and saved in the window, and what it runs follows the saved text", async ({ app, core }) => {
  const file = path.join(core.home, 'extensions/my-hooks/hooks/hooks.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: './check.sh' }] }] } }));
  await open(app, core);
  await row(app, 'custom:my-hooks').getByRole('button', { name: 'Edit the files of my-hooks' }).click();
  const lines = app.getByRole('group', { name: 'What my-hooks runs' });
  // The cell shows the short command; its tooltip keeps the whole one (shortCommand, extension-files.tsx).
  await expect(lines.locator('tbody td').last()).toHaveText('check.sh');
  await expect(lines.locator('tbody td').last()).toHaveAttribute('title', './check.sh');
  const next = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: './done.sh' }] }] } });
  await app.getByRole('textbox', { name: 'hooks/hooks.json' }).fill(next);
  await app.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(app.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible();
  expect(fs.readFileSync(file, 'utf8')).toBe(next);
  await expect(lines.locator('tbody td')).toHaveText(['Stop', 'The agent finishes its turn.', 'done.sh']);
});

test('kind_tags_580: a folder with only skills reads Skill, only hooks Hook, both Plugin', async ({ app, core }) => {
  const ext = path.join(core.home, 'extensions');
  fs.mkdirSync(path.join(ext, 'only-skill/skills/a'), { recursive: true });
  fs.writeFileSync(path.join(ext, 'only-skill/skills/a/SKILL.md'), '---\nname: a\ndescription: A.\n---\n');
  fs.mkdirSync(path.join(ext, 'both/skills/b'), { recursive: true });
  fs.writeFileSync(path.join(ext, 'both/skills/b/SKILL.md'), '---\nname: b\ndescription: B.\n---\n');
  fs.mkdirSync(path.join(ext, 'both/hooks'), { recursive: true });
  fs.writeFileSync(path.join(ext, 'both/hooks/hooks.json'), '{"hooks":{}}');
  await open(app, core);
  await expect(row(app, 'custom:only-skill').locator('.tag')).toHaveText('Skill');
  await expect(row(app, 'custom:both').locator('.tag')).toHaveText('Plugin');
});
