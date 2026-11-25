// Ticket 1065: bold beside Hangul closes; Latin emphasis is unchanged. Real core, fake agent.
import { append, chat, expect, openChat, rec, test } from './fixtures/chat/harness';

test('chat-render-1065: strong closes beside Korean text, Latin text renders as before', async ({ page, chatCore }) => {
  const s = chatCore.chat();
  const korean = ['호스트를 **`macbook`**으로 다시 추가', '**"인용"**은 그대로', '**(괄호)**를 닫음'];
  const latin = ['snake_case_word', '2*3*4', '**bold**text', 'a**b**c', '*emphasis*', '`**code**`'];
  append(s.file, rec.assistant([...korean, ...latin].join('\n\n')), rec.assistant('done'));
  await openChat(page, s.id);
  const view = chat(page, s.id);
  await expect(view.getByText('done')).toBeVisible();
  const md = view.locator('.md').first();
  await expect(md.locator('strong')).toHaveText(['macbook', '"인용"', '(괄호)', 'bold', 'b']);
  await expect(md.locator('em')).toHaveText(['3', 'emphasis']); // 2*3*4 is emphasis in CommonMark too
  await expect(md.locator('code').last()).toHaveText('**code**');
  const text = await md.innerText();
  expect(text).toContain('snake_case_word');
  expect(text.replace('**code**', '')).not.toContain('**');
});
