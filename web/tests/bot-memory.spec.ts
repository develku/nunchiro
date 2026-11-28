// A bot's memory on screen (approved design, mockup round 1 frames 1 and 3): the bot page's Profile | Memory tabs; the
// Memory tab shows the always-read files, the index with each line's date and source, topic files and saved copies;
// Forget asks once and deletes the line; Edit keeps a saved copy that Undo puts back; the Bots view's Memory group sets
// how long copies are kept. A real core; the memory files are written as a bot's seat would leave them.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { type Core, expect, openWindow, REPO, test } from './fixtures';
import { mates } from './leader-990';
import { openSettings } from './settings-modal';

const MARK = '<!-- One fact per line: date, fact, (from: source). Change it with `nunchiro memory add` and `nunchiro memory forget`. -->';
const dir = (core: Core) => path.join(core.home, 'team', 'bot-bom');
const index = (core: Core) => fs.readFileSync(path.join(dir(core), 'MEMORY.md'), 'utf8');
const features = (core: Core) => (JSON.parse(fs.readFileSync(path.join(core.home, 'settings.json'), 'utf8')).features ?? {}) as Record<string, unknown>;

function bom(core: Core) {
  mates(core, [{ id: 'bot-bom', name: 'Bom', job: 'Keeps your mail and calendar in order.' }]);
  fs.mkdirSync(path.join(dir(core), 'memory'), { recursive: true });
  const lines = [
    '- 2026-11-27 Never send a mail without an Outbox card. (from: you)',
    '- 2026-11-26 Weekly review is on Friday at 10:00. (from: a conversation)',
    '- 2026-11-25 Dana at Acme prefers meetings on Thursday. (from: mail)',
    '- 2026-11-24 Mail rules: see mail-rules.md (from: you)',
    '- 2026-11-20 Keep Monday mornings free for focus work. (from: a conversation)',
    '- 2026-11-19 Invoices go out on the first of the month. (from: you)',
    '- 2026-11-18 Sign mails as Kim. (from: you)',
  ];
  fs.writeFileSync(path.join(dir(core), 'MEMORY.md'), `# Memory\n${MARK}\n\n${lines.join('\n')}\n`);
  fs.writeFileSync(path.join(dir(core), 'SOUL.md'), 'I keep your mail tidy.\nI never send without your yes.\n');
  fs.writeFileSync(path.join(dir(core), 'memory', 'mail-rules.md'), '# mail-rules\n\n- 2026-11-24 Reply within a day. (from: you)\n');
  // The core's record of the lines it wrote (team/memory.rs `write_kept`); a line missing from it reads `(from: unknown)`.
  const record = (file: string, kept: string[]) => fs.writeFileSync(path.join(core.home, 'memory-state', 'bot-bom', file), JSON.stringify(kept.map((l) => crypto.createHash('sha256').update(l).digest('hex'))));
  fs.mkdirSync(path.join(core.home, 'memory-state', 'bot-bom'), { recursive: true });
  record('MEMORY.md.json', lines.filter((l) => !l.includes('Sign mails as Kim')));
  record('memory_mail-rules.md.json', ['- 2026-11-24 Reply within a day. (from: you)']);
}
async function memoryTab(app: Page) {
  await openSettings(app);
  await app.locator('.settings > nav button[data-page="team"]').click();
  await app.locator('.sbody [data-open-bots]').click();
  const view = app.getByRole('dialog', { name: 'Bots' }).locator('[data-bots]');
  await view.locator('[data-bot="bot-bom"]').click();
  await expect(view.getByRole('tab', { name: 'Profile' })).toHaveAttribute('aria-selected', 'true');
  await view.getByRole('tab', { name: 'Memory' }).click();
  return view.locator('[data-bot-memory="bot-bom"]');
}

test('bot_memory_tab: the Memory tab lists the index with date and source, Forget asks then deletes, Edit and Undo keep a copy', async ({ app, core }) => {
  bom(core);
  await openWindow(app, {}, core);
  const mem = await memoryTab(app);
  await expect(mem.getByRole('region', { name: 'Always read' })).toContainText('the index · 7 of 200 lines');
  await expect(mem.getByRole('region', { name: 'Always read' })).toContainText('who Bom is · 2 lines');
  const line = mem.locator('[data-memory-line="Dana at Acme prefers meetings on Thursday."]');
  await expect(line.locator('.mem-date')).toHaveText('11-25');
  await expect(line.locator('.mem-from')).toHaveText('from: mail');
  await expect(mem.locator('[data-memory-line]')).toHaveCount(5);
  await mem.locator('[data-memory-more]').click();
  await expect(mem.locator('[data-memory-line]')).toHaveCount(7);
  // A line the core did not write (a hand edit of the file) claims no source the core believes.
  await expect(mem.locator('[data-memory-line="Sign mails as Kim."] .mem-from')).toHaveText('from: unknown');
  await expect(mem.locator('[data-memory-topic="mail-rules.md"]')).toContainText('1 line');
  // Forget asks first; Cancel keeps the line.
  await line.hover();
  await line.getByRole('button', { name: 'Forget' }).click();
  await expect(line.getByRole('group', { name: 'Forget this line?' })).toContainText('This cannot be undone.');
  await line.getByRole('button', { name: 'Cancel' }).click();
  expect(index(core)).toContain('Dana at Acme');
  await line.hover();
  await line.getByRole('button', { name: 'Forget' }).click();
  await line.locator('[data-memory-forget]').click();
  await expect(line).toHaveCount(0);
  expect(index(core)).not.toContain('Dana at Acme');
  // Edit keeps the version before it as a saved copy; Undo puts it back.
  await mem.locator('[data-memory-edit]').click();
  await mem.getByRole('textbox', { name: "Bom's memory index" }).fill('- Only this line now.\n');
  await mem.getByRole('button', { name: 'Save' }).click();
  await expect(mem.locator('[data-memory-line]')).toHaveCount(1);
  const copy = mem.locator('[data-memory-copy="edit"]');
  await expect(copy).toContainText('You edited MEMORY.md');
  await copy.getByRole('button', { name: 'Undo' }).click();
  await expect(mem.locator('[data-memory-line="Never send a mail without an Outbox card."]')).toBeVisible();
  expect(index(core)).toContain('Never send a mail without an Outbox card. (from: you)');
  await expect(mem.locator('[data-memory-copy="undo"]')).toContainText('Before an Undo');
});

test('bot_memory_settings: the Bots view has a Memory group beside Models and limits that sets how long copies are kept', async ({ app, core }) => {
  bom(core);
  await openWindow(app, {}, core);
  await openSettings(app);
  await app.locator('.settings > nav button[data-page="team"]').click();
  await app.locator('.sbody [data-open-bots]').click();
  const view = app.getByRole('dialog', { name: 'Bots' }).locator('[data-bots]');
  const group = view.locator('[data-bots-memory]');
  await expect(group.locator('summary')).toContainText('Memory');
  await group.locator('summary').click();
  const keep = group.getByRole('radiogroup', { name: 'Keep saved copies' });
  await expect(keep.getByRole('radio', { name: '30 days' })).toBeChecked();
  await keep.getByRole('radio', { name: '7 days' }).click();
  await expect(keep.getByRole('radio', { name: '7 days' })).toBeChecked();
  await expect.poll(() => features(core)['team.memory']).toEqual({ keep_days: 7 });
  await view.locator('[data-bot="bot-bom"]').click();
  await view.getByRole('tab', { name: 'Memory' }).click();
  await expect(view.getByRole('region', { name: 'Saved copies' })).toContainText('kept 7 days');
});

// Pictures on request: PW_OPT_IN=shots ... --project shots -g bot_memory_shots (light and dark).
test('bot_memory_shots @shots: the Memory tab with a Forget question open, and the Memory group', async ({ app, core }) => {
  const shots = path.join(REPO, '.scratch/shots');
  fs.mkdirSync(shots, { recursive: true });
  bom(core);
  await openWindow(app, {}, core);
  const mem = await memoryTab(app);
  const line = mem.locator('[data-memory-line="Weekly review is on Friday at 10:00."]');
  await line.hover();
  await line.getByRole('button', { name: 'Forget' }).click();
  for (const scheme of ['light', 'dark'] as const) {
    await app.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await app.screenshot({ path: path.join(shots, `bot-memory-tab-${scheme}.png`) });
  }
});
