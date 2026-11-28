// A plugin's skill (docs/plugins.md): the review sheet lists it with what it does, and a SKILL.md that could run a
// command (here a `!` command line) cannot be reviewed at all: the Plugins page says why. A real core.
import fs from 'node:fs';
import path from 'node:path';
import { expect, openWindow, test, type Core } from './fixtures';
import { openSettings } from './settings-modal';

function skilled(core: Core, id: string, body: string) {
  const dir = path.join(core.home, `plugins/${id}`);
  fs.mkdirSync(path.join(dir, 'skills/review'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'plugin.toml'), `id = "${id}"\nname = "${id}"\nversion = "1.0.0"\n\n[[skill]]\nname = "review"\n`);
  fs.writeFileSync(path.join(dir, 'skills/review/SKILL.md'), `---\nname: review\ndescription: Review a change before it is pushed.\n---\n\n${body}\n`);
}

test('plugin_skill_sheet: the review sheet lists a skill; one that runs a command is refused with its reason', async ({ app, core }) => {
  skilled(core, 'notes', 'Read the diff and list what is missing.');
  skilled(core, 'runner', 'The log: !`git log -1`');
  await openWindow(app, core.boot(), core);
  await openSettings(app);
  await app.locator('.settings > nav button[data-page="plugins"]').click();
  await expect(app.locator('.plg[data-plugin="runner"]')).toContainText('Claude runs when the skill loads');
  await app.locator('.plg[data-plugin="notes"]').getByRole('button', { name: 'Review notes' }).click();
  await expect(app.locator('.ps [data-field="extras"] li')).toHaveText(['skill review instructs Claude sessions']);
  // What will instruct Claude, in full, before the yes.
  await expect(app.locator('.ps [data-field="skill-text"]')).toBeVisible();
  await expect(app.locator('.ps [data-field="skill-text"]')).toHaveText(/^---\nname: review\n[\s\S]*Read the diff and list what is missing\.\n$/);
});
