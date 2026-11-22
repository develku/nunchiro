// Ticket 454: the model menu shows the version a Claude alias last ran as ("Opus 5.5"), read from the user's own records
// (the core's usage read), so it follows Claude Code when an alias moves. A family never run keeps its plain name.
import fs from 'node:fs';
import path from 'node:path';
import { versionsFrom } from '../src/picker/seenModels';
import { expect, openWindow, REPO, test } from './fixtures';

const FIXTURES = path.join(REPO, 'crates/nunchiro/tests/fixtures');

test('versions_from_ids: the highest version per family, dated ids included, older id shapes left out', () => {
  expect(versionsFrom(['claude-opus-5', 'claude-opus-5-5', 'claude-opus-4-8', 'claude-fable-5-2', 'claude-sonnet-5-5-20261001', 'claude-3-5-sonnet-20241022', 'gpt-6-sol', '<synthetic>'])).toEqual({ opus: '5.5', fable: '5.2', sonnet: '5.5' });
  expect(versionsFrom(['claude-haiku-5'])).toEqual({ haiku: '5' });
});

/** One record of a reply by `model`, today, in the user's own Claude folder (where the core's usage read looks). */
function ran(folder: string, model: string, n: number) {
  const dir = path.join(folder, 'projects/-work-demo');
  fs.mkdirSync(dir, { recursive: true });
  const line = { type: 'assistant', timestamp: new Date().toISOString(), sessionId: `0000000${n}-2222-4333-8444-555555555555`, cwd: '/work/demo', message: { id: `msg_${n}`, model, usage: { input_tokens: 10, output_tokens: 5 } }, requestId: `req_${n}` };
  fs.writeFileSync(path.join(dir, `0000000${n}-2222-4333-8444-555555555555.jsonl`), JSON.stringify(line) + '\n');
}

test('picker_versions: an alias the user ran shows its version; one never run stays plain', async ({ app, core }) => {
  fs.copyFileSync(path.join(FIXTURES, 'claude-picker'), path.join(core.home, 'bin/claude'));
  const own = path.join(core.home, 'claude-home'); // the test core's CLAUDE_CONFIG_DIR (fixtures.ts)
  ran(own, 'claude-opus-5-5', 1);
  ran(own, 'claude-fable-5-2', 2);
  core.cli('session', 'start', '--kind', 'claude', '--project', core.project('demo'), '--label', 'claude');
  await openWindow(app);
  await app.locator('[data-picker="model"]').click();
  const rows = app.locator('[data-menu="model"]');
  await expect(rows.getByText('Opus 5.5', { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(rows.getByText('Fable 5.2', { exact: true })).toBeVisible();
  await expect(rows.getByText('Sonnet', { exact: true })).toBeVisible(); // never run: no number
});

// Dogfood 11-20: a session started with a full model id (`agent start --model claude-opus-5-5`) showed only "Claude".
test('model_text: a full model id outside the menu is named on the chip', async () => {
  const { modelText } = await import('../src/picker/catalog');
  expect(modelText('Claude', 'claude', 'claude-opus-5-5')).toBe('Claude · Opus 5.5');
  expect(modelText('Claude', 'claude', 'opus')).toBe('Claude · Opus');
  expect(modelText('Claude', 'claude', null, undefined, 'claude-fable-5-2')).toBe('Claude · Fable 5.2');
  expect(modelText('Claude', 'claude', null)).toBe('Claude');
  expect(modelText('Claude', 'claude', 'my-proxy-model')).toBe('Claude');
});
