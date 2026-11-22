// Ticket 625 (first-use walk 6, F10): dead ends a fresh walk found, each fixed with its test here.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, openWindow, test } from './fixtures';

// The row's Deny on a dialog Nunchiro cannot answer ("Answer it in the agent's terminal"), then the answer typed in the
// terminal: the line and its error must leave. Before the fix the "Just deny" button unmounted with focus and fired no
// blur, so the tree stayed frozen for good and showed "✓ answered" with the stale error under an idle session.
test('deny_then_terminal_answer_unfreezes_tree: the answered line and its error leave once the pointer is out', async ({ app, core }) => {
  const p = core.project('demo');
  const a = core.agent(p, 'a', 'go');
  await openWindow(app);
  fs.writeFileSync(path.join(a.cwd, 'go'), ''); // the fake agent shows its "Do you want to proceed?" dialog now
  const line = app.locator(`.tree .q[data-line="${a.id}"]`);
  await expect(line).toBeVisible({ timeout: 8000 });
  await line.locator('[data-act="deny"]').click();
  await app.getByRole('button', { name: 'Just deny' }).click();
  // Ticket 611: the fake now redraws after the tab's resize, so this deny goes through (Esc, which the fake ignores); the
  // walk's "Answer it in the agent" error came from the fake's blank screen.
  await app.mouse.move(900, 400); // the pointer leaves the tree, as it does on the way to the terminal
  core.run(['session', 'send-keys', a.id, '2', 'enter']); // lane w102: send-text waits out a start question
  await expect(app.locator('aside.dock.l')).toHaveAttribute('data-held', 'false');
  await expect(line).toHaveCount(0, { timeout: 8000 });
  await expect(app.locator('.tree .qerr')).toHaveCount(0);
});

/** Opens the window, then switches it to Korean (openWindow waits for the English "Connected"). */
async function korean(app: Page) {
  await openWindow(app);
  await app.evaluate(() => localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ ...JSON.parse(localStorage.getItem('nunchiro.settings.v1') ?? '{}'), language: 'ko' })));
  await app.reload();
  await expect(app.getByRole('status').filter({ hasText: /^연결됨$/ })).toBeVisible();
}

// The split chooser in Korean listed the library's widgets with the registry's English data ("Tree waiting slots",
// "Agents dots · spawn order"). It now shows the library card's words in the window's language.
test('split_chooser_in_korean: widget rows read in Korean, no English registry notes', async ({ app, core }) => {
  core.shell(core.project('demo'), 's');
  await korean(app);
  await app.locator('.tab[data-tab]:not([data-tab="settings"])').first().click();
  await app.keyboard.press('Meta+d');
  const chooser = app.getByRole('listbox', { name: '새 분할 창 선택' }).or(app.locator('.chooser'));
  await expect(chooser.getByRole('option').first()).toBeFocused();
  const text = await chooser.innerText();
  expect(text).toContain('에이전트마다 점 하나, 상태 표시');
  expect(text).toContain('따라가기 또는 고정');
  expect(text).not.toMatch(/spawn order|follows or pinned|waiting slots/);
});

// The key sheet (⌘/ or the prefix then ?) in Korean showed its area names and most rows in English; it now uses the
// Keys page's words.
test('key_sheet_in_korean: area names and command rows read in Korean', async ({ app, core }) => {
  core.shell(core.project('demo'), 's');
  await korean(app);
  await app.keyboard.press('Meta+Slash');
  const help = app.locator('.prefix-help');
  await expect(help).toBeVisible();
  await expect(help.locator('.ph-area b').first()).toHaveText('팔레트와 창');
  await expect(help.locator('.ph-row[data-command="focus.tree"]')).toContainText('트리로');
  await expect(help).not.toContainText('Palette and window');
});
