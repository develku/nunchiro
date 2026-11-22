// v25-chat-calm: the chat width bar moves the transcript's column and the composer box together (needs 144).
import { append, chat, expect, openChat, rec, test } from './fixtures/chat/harness';

test('chat_width_bar_applies_and_persists: one bar, both widths, kept across reload', async ({ page, chatCore }) => {
  await page.setViewportSize({ width: 1500, height: 900 });
  const s = chatCore.chat('calm');
  append(s.file, rec.user('hello'), rec.assistant('Hi there.'));
  await openChat(page, s.id);
  await expect(chat(page, s.id).locator('.md')).toContainText('Hi there.');
  const w = (sel: string) => page.locator(sel).first().evaluate((el) => Math.round(el.getBoundingClientRect().width));
  const body = () => w(`.chat[data-session="${s.id}"] .cin`);
  const box = () => w('.composer .cbox');
  expect(await box()).toBe(700);
  expect(await body()).toBe(724);
  // needs 144, V2.5-32 (nine-page Settings skeleton), needs 162: the bar is a field of Settings > Appearance, not of the chat page.
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Appearance' }).click();
  await page.getByRole('spinbutton', { name: 'Chat width' }).fill('80'); // needs 192 (ticket 250 r3): a stepper, as final.html draws it
  await page.keyboard.press('Escape'); // v25f: Settings is a modal over the tabs; Esc closes it first
  await page.locator(`.tab[data-tab="${s.id}"]`).click();
  await expect.poll(box).toBe(560);
  expect(await body()).toBe(584);
  await page.reload();
  await expect.poll(box).toBe(560);
  expect(await body()).toBe(584);
});
