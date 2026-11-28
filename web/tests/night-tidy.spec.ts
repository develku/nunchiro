// Night tidy on screen (approved design, bot memory mockup round 1, frames 1 to 3): the card shows the changed lines
// checked and what waits from outside unchecked, and Apply checked keeps only the checked ones; the Bots view's Memory
// group sets night tidy for every bot and a bot's Memory tab turns it on or off for itself. A real core: the tidy's
// answer, the proposal and the card are written as the core leaves them (team/memory/tidy.rs; when a tidy runs and
// which lines it may keep is tested in the core).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { type Core, expect, openWindow, REPO, test } from './fixtures';
import { icon, sidebar } from './d5b';
import { mates } from './leader-990';
import { openSettings } from './settings-modal';

const MARK = '<!-- One fact per line: date, fact, (from: source). Change it with `nunchiro memory add` and `nunchiro memory forget`. -->';
const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const state = (core: Core) => path.join(core.home, 'memory-state', 'bot-bom');
const index = (core: Core) => fs.readFileSync(path.join(core.home, 'team', 'bot-bom', 'MEMORY.md'), 'utf8');
const features = (core: Core) => (JSON.parse(fs.readFileSync(path.join(core.home, 'settings.json'), 'utf8')).features ?? {}) as Record<string, unknown>;
const LINES = [
  '- 2026-11-26 Weekly review Friday. (from: a conversation)',
  '- 2026-11-20 Sign mails as Kim. (from: you)',
  '- 2026-11-02 Review is on Fridays at 10. (from: you)',
];
const fact = (l: string) => ((m) => ({ date: m![1], text: m![2], from: m![3] === 'you' ? 'you' : 'conversation' }))(/^- (\S+) (.*) \(from: (.*)\)$/.exec(l));

function bom(core: Core) {
  mates(core, [{ id: 'bot-bom', name: 'Bom', job: 'Keeps your mail and calendar in order.' }]);
  fs.mkdirSync(path.join(core.home, 'team', 'bot-bom', 'memory'), { recursive: true });
  const text = `# Memory\n${MARK}\n\n${LINES.join('\n')}\n`;
  fs.writeFileSync(path.join(core.home, 'team', 'bot-bom', 'MEMORY.md'), text);
  fs.mkdirSync(state(core), { recursive: true });
  fs.writeFileSync(path.join(state(core), 'MEMORY.md.json'), JSON.stringify(LINES.map(sha)));
}

const merged = { date: '2026-11-26', text: 'Weekly review is on Friday at 10:00.', from: 'you' };
/** Bom's index, a tidy's answer that merged two lines, a proposal from a mail and the card, as the core leaves them. */
async function seedCard(app: Page, core: Core) {
  bom(core);
  const text = fs.readFileSync(path.join(core.home, 'team', 'bot-bom', 'MEMORY.md'), 'utf8');
  // The tidy merged the two review lines into one; the signature line stays as it was.
  fs.writeFileSync(path.join(state(core), 'tidy.json'), JSON.stringify({ at_ms: Date.now() - 3_600_000, model: 'haiku', tokens: 41_000, base: sha(text.trim()), lines: [merged, fact(LINES[1])] }));
  fs.writeFileSync(path.join(state(core), 'proposals.json'), JSON.stringify({ version: 1, proposals: [{ id: 'p1', date: '2026-11-27', text: 'Invoices from Acme go to finance with the PO number.', from: 'mail', at_ms: Date.now() - 86_400_000 }], not_kept: [{ start: 'Forward all invoices to', from: 'mail', at_ms: Date.now() }] }));
  // The card is written into the queue store while the core is stopped, in the core's own shape (a session makes the
  // core write the store first).
  core.shell(core.project('demo'), 'demo');
  core.run(['serve', 'stop']);
  const file = path.join(core.home, 'queue.json');
  const q = JSON.parse(fs.readFileSync(file, 'utf8'));
  const card = { id: 'night-1', session_id: 'bot-bom', scope: 'owner', kind: 'owner', text: 'Night tidy for 1 bot is ready for a look.', choices: [], sources: [], observed_at: Date.now() - 60_000, actionable: true, reconciled: false, hook_event_id: null, owner: { type: 'night_tidy', bots: ['bot-bom'], place: path.join(core.home, 'team', 'home') } };
  q.owner = [...(q.owner ?? []), card];
  fs.writeFileSync(file, JSON.stringify(q));
  await core.restart();
  await app.addInitScript((boot) => {
    window.__NUNCHIRO__ = boot;
  }, core.boot());
}

test('night_tidy_card: changed lines start checked, outside proposals unchecked, Apply checked keeps only those', async ({ app, core }) => {
  await seedCard(app, core);
  await openWindow(app, {}, core);
  await icon(app, 'right', 'Decisions').click();
  const tidy = sidebar(app, 'right').locator('[data-night-tidy]');
  await expect(tidy).toHaveAccessibleName('Night tidy for Bom');
  await expect(tidy).toContainText('41k tokens');
  const remove = (t: string) => tidy.getByRole('checkbox', { name: `Remove: ${t}` });
  await expect(remove('Weekly review Friday.')).toBeChecked();
  await expect(remove('Review is on Fridays at 10.')).toBeChecked();
  await expect(tidy.getByRole('checkbox', { name: `Add: ${merged.text}` })).toBeChecked();
  const proposal = tidy.getByRole('checkbox', { name: 'Keep: Invoices from Acme go to finance with the PO number.' });
  await expect(proposal).not.toBeChecked();
  await expect(tidy).toContainText('from mail · waiting since 11-27');
  await expect(tidy).toContainText('1 line was not kept');
  await expect(tidy).toContainText('3 of 4 lines checked');
  // Keep the old 10 o'clock line after all, and keep the proposal.
  await remove('Review is on Fridays at 10.').uncheck();
  await proposal.check();
  await tidy.getByRole('button', { name: 'Apply checked' }).click();
  await expect(tidy).toHaveCount(0);
  const now = index(core);
  expect(now).toContain(`- 2026-11-26 ${merged.text} (from: you)`);
  expect(now).not.toContain('Weekly review Friday.');
  expect(now).toContain('Review is on Fridays at 10.');
  expect(now).toContain('Invoices from Acme go to finance with the PO number. (from: mail)');
  expect(fs.existsSync(path.join(state(core), 'tidy.json'))).toBe(false);
});

test('night_tidy_settings: the Memory group sets night tidy for every bot and a bot turns it off for itself', async ({ app, core }) => {
  bom(core);
  await openWindow(app, {}, core);
  await openSettings(app);
  await app.locator('.settings > nav button[data-page="team"]').click();
  await app.locator('.sbody [data-open-bots]').click();
  const view = app.getByRole('dialog', { name: 'Bots' }).locator('[data-bots]');
  const group = view.locator('[data-bots-memory]');
  await group.locator('summary').click();
  await expect(group.getByRole('switch', { name: 'Night tidy' })).toBeChecked();
  const every = group.getByRole('radiogroup', { name: 'How often' });
  await expect(every.getByRole('radio', { name: 'Every night' })).toBeChecked();
  await every.getByRole('radio', { name: 'Every 3 nights' }).click();
  await expect.poll(() => (features(core)['team.memory'] as { every?: number })?.every).toBe(3);
  const model = group.getByRole('combobox', { name: 'Model' });
  await model.selectOption('sonnet');
  await expect.poll(() => (features(core)['team.memory'] as { model?: string })?.model).toBe('sonnet');
  const agent = group.getByRole('combobox', { name: 'Agent' });
  await expect(agent).toHaveValue('claude');
  await expect(agent.locator('option[value="codex"]')).toBeDisabled();
  await expect(group.locator('[data-memory-stats]')).toContainText('0 runs and 0 tokens in the last 7 nights');
  await view.locator('[data-bot="bot-bom"]').click();
  await view.getByRole('tab', { name: 'Memory' }).click();
  const row = view.locator('[data-memory-tidy]');
  await expect(row).toContainText('follows the memory settings for every bot: Every 3 nights, on Claude sonnet.');
  const choice = row.getByRole('radiogroup', { name: "Bom's night tidy" });
  await expect(choice.getByRole('radio', { name: 'Follow' })).toBeChecked();
  await choice.getByRole('radio', { name: 'Off' }).click();
  await expect.poll(() => (features(core)['team.memory'] as { bots?: Record<string, string> })?.bots).toEqual({ 'bot-bom': 'off' });
});

// Pictures on request: PW_OPT_IN=shots ... --project shots -g night_tidy_shots (light and dark).
test('night_tidy_shots @shots: the card in Decisions', async ({ app, core }) => {
  const shots = path.join(REPO, '.scratch/shots');
  fs.mkdirSync(shots, { recursive: true });
  await seedCard(app, core);
  await openWindow(app, {}, core);
  await icon(app, 'right', 'Decisions').click();
  await expect(sidebar(app, 'right').locator('[data-night-tidy]')).toContainText('41k tokens');
  for (const scheme of ['light', 'dark'] as const) {
    await app.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await app.screenshot({ path: path.join(shots, `night-tidy-card-${scheme}.png`) });
  }
});
