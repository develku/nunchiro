// V2.5-10 Usage tab against a real core and hand-written transcripts: cost and tokens per account over 24 h and 7 d,
// Codex's own remaining share with its reset, no remaining share for Claude (no local source), and no outbound request.
import fs from 'node:fs';
import path from 'node:path';
import { expect, openWindow, test } from './fixtures';

const iso = (hoursAgo: number) => new Date(Date.now() - hoursAgo * 3_600_000).toISOString();
const jsonl = (file: string, ...lines: object[]) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l) + '\n').join(''));
};
const claudeLine = (id: string, at: string, model: string, input: number) => ({ type: 'assistant', timestamp: at, message: { id, model, usage: { input_tokens: input, output_tokens: 0 } } });

test('usage_tab_reachable: Settings then Usage, two clicks, and the numbers come from local files only', async ({ app, core }) => {
  const outside: string[] = [];
  app.on('request', (r) => {
    const u = new URL(r.url());
    if (!['127.0.0.1', 'localhost'].includes(u.hostname) && u.protocol.startsWith('http')) outside.push(r.url());
  });
  // 1M Sonnet tokens an hour ago ($3.00), 1M Opus 4.5 tokens 3 days ago ($5.00): 24 h $3.00, 7 d $8.00.
  jsonl(
    path.join(core.home, 'claude-home/projects/p/a.jsonl'),
    claudeLine('m1', iso(1), 'claude-sonnet-4-20250514', 1_000_000),
    claudeLine('m2', iso(72), 'claude-opus-4-5-20251101', 1_000_000),
  );
  const resets = Math.floor(Date.now() / 1000) + 3 * 3600;
  jsonl(
    path.join(core.home, 'codex-home/sessions/2026/10/24/rollout-1.jsonl'),
    { timestamp: iso(2), type: 'turn_context', payload: { model: 'gpt-5-codex' } },
    {
      timestamp: iso(1),
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: { total_token_usage: { total_tokens: 2_000_000 }, last_token_usage: { input_tokens: 2_000_000, output_tokens: 0 } },
        rate_limits: { primary: { used_percent: 25, window_minutes: 300, resets_at: resets }, secondary: { used_percent: 60, window_minutes: 10080, resets_at: resets + 86_400 } },
      },
    },
  );
  for (const name of ['claude', 'codex']) fs.writeFileSync(path.join(core.home, 'bin', name), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  core.shell(core.project('demo'), 'alpha');

  await openWindow(app);
  await app.keyboard.press('Meta+Comma'); // click 1: Settings
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Usage' }).click(); // click 2
  const usage = app.locator('#s-usage');
  await usage.getByRole('tab', { name: 'Agent' }).click();
  const card = (agent: string) => usage.locator(`.prov[data-agent-name="${agent}"]`);
  await expect(card('Claude')).toContainText('2M');
  await expect(card('Claude')).toContainText('$8.00');
  // 2M Codex tokens at gpt-5 input price $1.25/M: $2.50; 25 % and 60 % used.
  await expect(card('Codex')).toContainText('2M');
  await expect(card('Codex')).toContainText('$2.50');
  await expect(usage.locator('[data-limit="codex:own"]')).toContainText('25% used');
  await expect(usage.locator('[data-limit="codex:own"]')).toContainText('60% used');
  await expect(usage.locator('[data-limit="claude:own"]')).toContainText('No limit in its records');
  expect(outside).toEqual([]);
});
