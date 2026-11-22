// v25-quiet-chat: screenshots for the owner's review page (QUIET_SHOTS=1, QUIET_TAG=before|after, light and dark).
// Runs on any tree: on the base tree it draws the strips and the decision line, on this one their absence.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { append, chat, expect, openChat, rec, test } from './fixtures/chat/harness';

const TAG = process.env.QUIET_TAG ?? 'after';
const OUT = process.env.QUIET_OUT ?? path.join(import.meta.dirname, '../../.scratch/shots-v25-quiet-chat');

async function patch(page: Page, id: string, kind: 'dialog' | 'permission', text: string) {
  await page.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => server.send(m));
    server.onMessage((raw) => {
      if (typeof raw !== 'string' || JSON.parse(raw).event !== 'snapshot') return ws.send(raw);
      const msg = JSON.parse(raw);
      for (const s of msg.sessions ?? [])
        if (s.id === id) {
          Object.assign(s.attention, { working: true, waiting: true, stale: false, failed: false });
          s.pending = [{ id: `d-${id}`, session_id: id, scope: s.project, kind, text, choices: [], observed_at: Date.now() - 5_000, actionable: true, risky: false }];
        }
      ws.send(JSON.stringify(msg));
    });
  });
}

for (const scheme of ['light', 'dark'] as const) {
  test(`quiet shots ${scheme}`, async ({ page, chatCore }) => {
    test.skip(!process.env.QUIET_SHOTS, 'set QUIET_SHOTS=1');
    fs.mkdirSync(OUT, { recursive: true });
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 1440, height: 900 });
    const shot = (name: string) => page.screenshot({ path: path.join(OUT, `${name}-${scheme}-${TAG}.png`) });

    // 1. A waiting session: the decision line (before) or the quiet chat (after).
    const w = chatCore.chat('waiting');
    append(w.file, rec.user('install it'), rec.assistant('Ready to install.'));
    await patch(page, w.id, 'permission', 'Bash: pnpm install');
    await openChat(page, w.id);
    await page.mouse.move(700, 880);
    await shot('waiting-session');

    // 2. A closed session: the "is closed + Resume" row (before) or the plain read-only chat (after).
    const c = chatCore.chat('closed');
    append(c.file, rec.user('before closing'), rec.assistant('the answer'));
    chatCore.cli('session', 'close', c.id);
    await page.keyboard.press('Meta+KeyK');
    await page.getByRole('dialog', { name: 'Command palette' }).locator(`[data-command="session.open.${c.id}"]`).click();
    await expect(chat(page, c.id).getByText('the answer')).toBeVisible();
    await shot('closed-session');

    // 3. The skip note beside the Normal button (900 px is where they met).
    const k = chatCore.chat('skipped');
    append(k.file, rec.assistant('before'), '{"type":"nope"}', 'garbage line');
    await page.setViewportSize({ width: 900, height: 700 });
    await page.locator(`.tab[data-tab="${k.id}"]`).click();
    await expect(chat(page, k.id).locator('.skipped')).toBeVisible();
    await shot('skip-note');
  });

  test(`quiet shots first message ${scheme}`, async ({ page, chatCore }) => {
    test.skip(!process.env.QUIET_SHOTS || TAG === 'before', 'after only: the base tree has no held message');
    fs.mkdirSync(OUT, { recursive: true });
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 1440, height: 900 });
    const s = chatCore.chat('first', false);
    await patch(page, s.id, 'dialog', 'Do you trust the files in this folder?');
    await openChat(page, s.id);
    await page.locator('.composer textarea').fill('hello agent');
    await page.locator('.composer .send').click();
    await expect(page.locator('.composer .held')).toContainText('hello agent');
    await page.screenshot({ path: path.join(OUT, `first-message-held-${scheme}-${TAG}.png`) });
    // Round 2 (review S3): a second Send while it waits stays in the box and the composer says why.
    await page.locator('.composer textarea').fill('and one more thing');
    await page.locator('.composer .send').click();
    await expect(page.locator('.composer .held-why')).toBeVisible();
    await page.screenshot({ path: path.join(OUT, `second-send-why-${scheme}-${TAG}.png`) });
  });
}
