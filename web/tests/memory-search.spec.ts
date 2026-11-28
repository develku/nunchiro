// Bot memory, layer 3 on screen (approved mockup, frames 3 and 4): a seat's search of past conversations shows in its
// reply as the hit count, the newest hit as a card whose Open goes to that conversation, and the other hits in one line;
// the Bots view's Memory group shows the index's size and turning search off deletes the index. A real core.
import fs from 'node:fs';
import path from 'node:path';
import { REPO } from './fixtures';
import { append, chat, expect, openChat, rec, test } from './fixtures/chat/harness';
import { openSettings } from './settings-modal';

const hits = (acme: string) => ({
  type: 'memory_hits',
  total: 3,
  hits: [
    { session: acme, label: 'Acme invoices', kind: 'codex', at: '2026-11-12T14:05:00Z', role: 'user', text: 'PO number in the file name, one per order' },
    { session: acme, label: 'Acme invoices', kind: 'claude', at: '2026-11-03T09:00:00Z', role: 'assistant', text: 'Acme wants a PO number' },
    { session: acme, label: 'Acme invoices', kind: 'codex', at: '2026-10-29T09:00:00Z', role: 'user', text: 'Acme invoice as PDF' },
  ],
});
const shotsDir = path.join(REPO, '.scratch/shots');

test('memory_search_hit: a search of past conversations shows its hits in the reply, and Open goes to the conversation', async ({ page, chatCore }) => {
  const acme = chatCore.chat('Acme invoices', true, false, 'home');
  append(acme.file, rec.user('Invoices for Acme: PDF, PO number in the file name, one per order.'), rec.end());
  const bom = chatCore.chat('Bom', true, false, 'home');
  append(
    bom.file,
    rec.user('What did we settle for the Acme invoice format?'),
    rec.use('m1', 'mcp__nunchiro__memory_search', { query: 'acme invoice' }),
    rec.result('m1', JSON.stringify(hits(acme.id))),
    rec.assistant("PDF, with the PO number in the file name, and one invoice per order. You settled it on 11-12 with Dana's note in mind."),
    rec.end(),
  );
  await openChat(page, bom.id);
  const block = chat(page, bom.id).locator('[data-memory-hits]');
  await expect(block).toContainText('Searched past conversations · 3 hits');
  const card = block.locator(`[data-memory-hit="${acme.id}"]`);
  await expect(card).toContainText('Acme invoices');
  await expect(card).toContainText('Codex ·');
  await expect(card).toContainText('“PO number in the file name, one per order”');
  await expect(block.locator('.mem-hits-more')).toContainText(/^2 more hits · Claude Code \d\d-\d\d, Codex \d\d-\d\d$/);
  if (process.env.PW_SHOTS) {
    fs.mkdirSync(shotsDir, { recursive: true });
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      await page.screenshot({ path: path.join(shotsDir, `memory-search-hit-${scheme}.png`) });
    }
  }
  await card.getByRole('button', { name: 'Open' }).click();
  await expect(page.locator(`.tab[data-tab="${acme.id}"]`)).toHaveAttribute('aria-selected', 'true');
});

test('memory_search_settings: the Memory group shows the index, and turning search off deletes it', async ({ page, chatCore }) => {
  const acme = chatCore.chat('Acme invoices', true, false, 'home');
  append(acme.file, rec.user('Invoices for Acme: PDF, PO number in the file name.'), rec.end());
  await page.goto('/');
  await expect(page.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  await openSettings(page);
  await page.locator('.settings > nav button[data-page="team"]').click();
  await page.locator('.sbody [data-open-bots]').click();
  const group = page.getByRole('dialog', { name: 'Bots' }).locator('[data-bots-memory]');
  await group.locator('summary').click();
  const stats = group.locator('[data-memory-search-stats]');
  await expect(stats).toHaveText(/^1 conversation · \d+\.\d MB · updated just now$/);
  await expect(group).toContainText('The index stays on this Mac and masks secrets. Turning it off deletes the index.');
  await expect(group).toContainText("The agents' own conversation files stay theirs");
  const index = path.join(chatCore.home, 'memory-search');
  expect(fs.existsSync(path.join(index, `${acme.id}.jsonl`))).toBe(true);
  if (process.env.PW_SHOTS) {
    fs.mkdirSync(shotsDir, { recursive: true });
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      await page.screenshot({ path: path.join(shotsDir, `memory-search-group-${scheme}.png`) });
    }
  }
  const toggle = group.getByRole('switch', { name: 'Search past conversations' });
  await expect(toggle).toBeChecked();
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await expect(stats).toHaveCount(0);
  await expect.poll(() => fs.existsSync(index)).toBe(false);
  const features = JSON.parse(fs.readFileSync(path.join(chatCore.home, 'settings.json'), 'utf8')).features;
  expect(features['team.memory']).toEqual({ keep_days: 30, search: false });
});
