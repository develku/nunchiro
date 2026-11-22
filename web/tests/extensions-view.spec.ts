// Ticket 452: Settings > Skills & hooks shows what an item holds, opens its files in the app, saves a custom item's file
// and makes a new skill. Against the real core, on the test's own home: nothing under a real user folder is touched.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, openWindow, test, type Core } from './fixtures';
import { openSettings } from './settings-modal';

const SKILL = '---\nname: review\ndescription: Checks a diff before merge.\n---\n\nRead the diff first.\n';
function seed(core: Core) {
  const ext = path.join(core.home, 'extensions');
  fs.mkdirSync(path.join(ext, 'review-kit/.claude-plugin'), { recursive: true });
  fs.mkdirSync(path.join(ext, 'review-kit/skills/review'), { recursive: true });
  fs.writeFileSync(path.join(ext, 'review-kit/.claude-plugin/plugin.json'), JSON.stringify({ name: 'review-kit', version: '1', description: 'Checks a diff before merge.' }));
  fs.writeFileSync(path.join(ext, 'review-kit/skills/review/SKILL.md'), SKILL);
  fs.mkdirSync(path.join(ext, 'my-hooks/hooks'), { recursive: true });
  fs.writeFileSync(path.join(ext, 'my-hooks/hooks/hooks.json'), JSON.stringify({ hooks: { PreToolUse: [], Stop: [] } }));
  return ext;
}
async function open(app: Page, core: Core) {
  await openWindow(app, {}, core);
  await openSettings(app);
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Skills & hooks', exact: true }).click();
  await expect(app.getByRole('heading', { level: 1, name: 'Skills & hooks', exact: true })).toBeVisible();
}
const row = (app: Page, id: string) => app.locator(`[data-row="ext:${id}"]`);

test('extensions_view: a row says what the item holds, and the shipped skill is read in the app, read only', async ({ app, core }) => {
  seed(core);
  await open(app, core);
  // A custom plugin: its kind as a tag, its description, its skills and file count. A hook item: the events it runs on.
  await expect(row(app, 'custom:review-kit')).toContainText('Skill');
  await expect(row(app, 'custom:review-kit')).toContainText('Checks a diff before merge.');
  await expect(row(app, 'custom:review-kit')).toContainText('Skills: review · Files: 2');
  await expect(row(app, 'custom:my-hooks')).toContainText('Hook');
  await expect(row(app, 'custom:my-hooks')).toContainText('Runs on: PreToolUse, Stop · Files: 1');
  // The shipped skill: View opens its files; the text is there and cannot be changed.
  await expect(row(app, 'nunchiro')).toContainText('Skills: artifacts, nunchiro, orchestration');
  await row(app, 'nunchiro').getByRole('button', { name: 'View the files of Nunchiro skill' }).click();
  const files = app.getByRole('group', { name: 'Files of Nunchiro skill' });
  await expect(files.getByRole('list', { name: 'Files' }).getByRole('button')).toHaveCount(4);
  const text = files.getByRole('textbox');
  await expect(text).toHaveValue(/nunchiro/);
  await expect(text).toHaveAttribute('readonly', '');
  await expect(files.getByRole('button', { name: 'Save' })).toHaveCount(0);
  await expect(files).toContainText('read only');
  // One panel at a time: opening another item's files closes this one.
  await row(app, 'custom:review-kit').getByRole('button', { name: 'Edit the files of review-kit' }).click();
  await expect(files).toHaveCount(0);
});

test('extensions_edit: a custom item file is changed and saved from the app; Revert drops an unsaved change', async ({ app, core }) => {
  const ext = seed(core);
  await open(app, core);
  await row(app, 'custom:review-kit').getByRole('button', { name: 'Edit the files of review-kit' }).click();
  const files = app.getByRole('group', { name: 'Files of review-kit' });
  const text = files.getByRole('textbox', { name: 'skills/review/SKILL.md' });
  await expect(text).toHaveValue(SKILL);
  const save = files.getByRole('button', { name: 'Save', exact: true });
  await expect(save).toBeDisabled();
  // An unsaved change marks the file and is dropped by Revert.
  await text.fill(SKILL + 'Unsaved line.\n');
  await expect(files.getByRole('img', { name: 'not saved' })).toBeVisible();
  await files.getByRole('button', { name: 'Revert' }).click();
  await expect(text).toHaveValue(SKILL);
  // Saved: the file on disk has the new text, and the page says when it applies.
  await text.fill(SKILL + 'Then list what could break.\n');
  await save.click();
  await expect(files.getByRole('status')).toHaveText('Saved. Sessions started from now on use it.');
  expect(fs.readFileSync(path.join(ext, 'review-kit/skills/review/SKILL.md'), 'utf8')).toBe(SKILL + 'Then list what could break.\n');
  await expect(save).toBeDisabled();
  // The item stays off: saving a file never turns anything on.
  await expect(row(app, 'custom:review-kit').getByRole('switch')).not.toBeChecked();
});

// Q9 en-b-J13-1: text typed while a save is on its way stays a draft when the save's answer lands; the saved text is on disk.
test('extensions_type_during_save: a line typed while the save is on its way survives its reply', async ({ app, core }) => {
  const ext = seed(core);
  // The core's answer to extensions_item_save is held until the next line is typed.
  let release: (() => void) | null = null;
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    let sent: unknown;
    ws.onMessage((m) => {
      const f = typeof m === 'string' ? JSON.parse(m) : null;
      if (f?.request?.op === 'extensions_item_save') sent = f.id;
      server.send(m);
    });
    server.onMessage((m) => {
      const f = typeof m === 'string' ? JSON.parse(m) : null;
      if (sent !== undefined && f?.id === sent) return void ((sent = undefined), (release = () => ws.send(m)));
      ws.send(m);
    });
  });
  await open(app, core);
  await row(app, 'custom:review-kit').getByRole('button', { name: 'Edit the files of review-kit' }).click();
  const files = app.getByRole('group', { name: 'Files of review-kit' });
  const text = files.getByRole('textbox', { name: 'skills/review/SKILL.md' });
  await text.fill(SKILL + 'Saved line.\n');
  await files.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => !!release).toBe(true);
  await text.fill(SKILL + 'Saved line.\nTyped while saving.\n');
  release!();
  await expect(files.getByRole('status')).toHaveText('Saved. Sessions started from now on use it.');
  expect(fs.readFileSync(path.join(ext, 'review-kit/skills/review/SKILL.md'), 'utf8')).toBe(SKILL + 'Saved line.\n');
  await expect(text).toHaveValue(SKILL + 'Saved line.\nTyped while saving.\n');
  await expect(files.getByRole('img', { name: 'not saved' })).toBeVisible();
});

// Q9 en-b-J13-2, -3, -4: a file the core could not read is never typed over; an unsaved edit outlives closing its item; a
// save over a change made on disk since the file was opened is refused.
test('extensions_keep: an unread file is read only, a closed item keeps its edit, a change on disk is not overwritten', async ({ app, core }) => {
  const ext = seed(core);
  const big = 'x'.repeat(300 * 1024);
  fs.writeFileSync(path.join(ext, 'review-kit/skills/review/big.md'), big);
  await open(app, core);
  const edit = row(app, 'custom:review-kit').getByRole('button', { name: 'Edit the files of review-kit' });
  await edit.click();
  const files = app.getByRole('group', { name: 'Files of review-kit' });
  await files.getByRole('list', { name: 'Files' }).getByRole('button', { name: 'skills/review/big.md' }).click();
  await expect(files.getByRole('textbox', { name: 'skills/review/big.md' })).toHaveAttribute('readonly', '');
  await files.getByRole('list', { name: 'Files' }).getByRole('button', { name: 'skills/review/SKILL.md' }).click();
  const text = files.getByRole('textbox', { name: 'skills/review/SKILL.md' });
  await text.fill(SKILL + 'Mine.\n');
  await edit.click();
  await expect(files).toHaveCount(0);
  await edit.click();
  await expect(text).toHaveValue(SKILL + 'Mine.\n');
  fs.writeFileSync(path.join(ext, 'review-kit/skills/review/SKILL.md'), SKILL + 'Theirs.\n');
  await files.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(files.getByRole('alert')).toContainText('The file changed on disk after you opened it');
  expect(fs.readFileSync(path.join(ext, 'review-kit/skills/review/SKILL.md'), 'utf8')).toBe(SKILL + 'Theirs.\n');
  expect(fs.readFileSync(path.join(ext, 'review-kit/skills/review/big.md'), 'utf8')).toBe(big);
});

test('extensions_new_skill: an empty form says what is missing; a created skill opens on its text and stays off', async ({ app, core }) => {
  await open(app, core);
  // No custom item yet: the empty state says so; the section's Add buttons make one (look 1117 v15 Q6-11).
  const section = app.locator('section[aria-labelledby="h-ext-skills"]');
  await expect(section).toContainText('You have not added any skills or hooks yet.');
  // Ticket 585: the agents' own skills are not listed on purpose, and the lede says it without the word "plugin".
  await expect(section).toContainText('Items in the folders of your agents');
  await expect(section).toContainText('press “New skill” or “New hook”');
  await expect(section).not.toContainText(/plugin/i);
  await section.getByRole('button', { name: 'New skill' }).click();
  const form = app.getByRole('form', { name: 'New skill' });
  await form.getByRole('button', { name: 'Create' }).click();
  await expect(form.getByRole('alert')).toHaveText('Name: use letters, digits, - and _ (up to 64).');
  await form.getByRole('textbox', { name: 'Name' }).fill('release-notes');
  await form.getByRole('button', { name: 'Create' }).click();
  await expect(form.getByRole('alert')).toHaveText('Write one line saying when the agent should use it.');
  await form.getByRole('textbox', { name: 'What it is for, in one line' }).fill('Writes release notes from merged pull requests.');
  await form.getByRole('button', { name: 'Create' }).click();
  // The new item is listed, off, with its files open on the skill's text.
  await expect(form).toHaveCount(0);
  await expect(row(app, 'custom:release-notes')).toContainText('Writes release notes from merged pull requests.');
  await expect(row(app, 'custom:release-notes').getByRole('switch')).not.toBeChecked();
  await expect(app.getByRole('group', { name: 'Files of release-notes' }).getByRole('textbox', { name: 'skills/release-notes/SKILL.md' })).toHaveValue(/name: release-notes/);
  expect(fs.existsSync(path.join(core.home, 'extensions/release-notes/skills/release-notes/SKILL.md'))).toBe(true);
  // The same name again is refused by the core: its fixed sentence in plain words, the core's words under a closed
  // Details (ticket 534).
  await section.getByRole('button', { name: 'New skill' }).click();
  await app.getByRole('form', { name: 'New skill' }).getByRole('textbox', { name: 'Name' }).fill('release-notes');
  await app.getByRole('form', { name: 'New skill' }).getByRole('textbox', { name: 'What it is for, in one line' }).fill('Again.');
  await app.getByRole('form', { name: 'New skill' }).getByRole('button', { name: 'Create' }).click();
  const refused = app.getByRole('form', { name: 'New skill' }).getByRole('alert');
  await expect(refused).toHaveText(/^An extension named release-notes already exists\. Choose another name\.Details/);
  await expect(refused.locator('details.err-details')).not.toHaveAttribute('open');
  await expect(refused.locator('details.err-details')).toContainText('an extension named release-notes already exists');
});
