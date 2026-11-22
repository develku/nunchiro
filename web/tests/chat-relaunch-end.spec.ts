// N32 (look 1117 v3 B): after a window relaunch or a core restart the chat opened at its top; it opens at its newest
// message, as before the relaunch (and as the Room does, 684f3fbb9).
import { append, chat, expect, openChat, rec, test } from './fixtures/chat/harness';

test('chat_opens_at_newest_after_reload (N32)', async ({ page, chatCore }) => {
  const s = chatCore.chat('long');
  for (let i = 0; i < 120; i++) append(s.file, rec.user(`question ${i}`), rec.assistant(`answer ${i} `.repeat(30)));
  await openChat(page, s.id);
  const view = chat(page, s.id);
  await expect(view.getByText('question 119')).toBeVisible();
  const gap = () => view.locator('.cscroll').evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
  await expect.poll(gap).toBeLessThan(80);
  await page.reload();
  await expect(chat(page, s.id).getByText('question 119')).toBeVisible();
  await expect.poll(gap).toBeLessThan(80);
});

test('chat_opens_at_newest_after_core_restart (N32)', async ({ page, chatCore }) => {
  const s = chatCore.chat('long2');
  for (let i = 0; i < 120; i++) append(s.file, rec.user(`question ${i}`), rec.assistant(`answer ${i} `.repeat(30)));
  chatCore.cli('serve', 'stop');
  await chatCore.restart();
  await page.addInitScript((boot) => (window.__NUNCHIRO__ = boot), chatCore.boot());
  await page.goto('/');
  await expect(page.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  await page.keyboard.press('Meta+KeyK');
  await page.getByRole('dialog', { name: 'Command palette' }).locator(`[data-command="session.open.${s.id}"]`).click();
  const view = chat(page, s.id);
  await expect(view.getByText('question 119')).toBeVisible();
  await expect.poll(() => view.locator('.cscroll').evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(80);
});
