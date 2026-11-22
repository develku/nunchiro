// needs 171 (copy a message): every user and agent message has a Copy button in its hover / focus-within action group.
// It writes the message's raw text (the user's text, the agent's Markdown source) on a click or Enter only, reads
// "Copied" for 1.5 s inside a polite live region, and stays in an exited session's read-only chat. The right-click Copy
// of a message belongs to the system-owned context menu (menu/surfaces.ts): not tested here.
import type { Locator, Page } from '@playwright/test';
import { append, chat, expect, openChat, rec, test } from './fixtures/chat/harness';

/** `navigator.clipboard.writeText` replaced by a recorder (WebKit has no clipboard-write permission). */
const stubClipboard = (page: Page) =>
  page.addInitScript(() => {
    const w = window as unknown as { __clip: string[] };
    w.__clip = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t: string) => void w.__clip.push(t) } });
  });
/** The message's own action group (an agent message with a fenced block also carries that block's Copy). */
const actions = (row: Locator) => row.locator('.message-actions');
const clip = (page: Page) => page.evaluate(() => (window as unknown as { __clip: string[] }).__clip);

const USER = 'Please rename `foo` to `bar`.\nThen run the tests.';
const AGENT = 'Done: **renamed** `foo` in [a.ts](src/a.ts).\n\n```ts\nconst bar = 1;\n```';

test('chat_copy_message: Copy on a user and on an agent message writes the raw text; the label reads Copied, then Copy again', async ({ page, chatCore }) => {
  await stubClipboard(page);
  const s = chatCore.chat('copy');
  append(s.file, rec.user(USER), rec.assistant(AGENT));
  await openChat(page, s.id);
  const view = chat(page, s.id);
  const rows = view.locator('.message-row');
  await expect(rows).toHaveCount(2);
  // The user's message.
  await rows.nth(0).hover();
  const copyUser = actions(rows.nth(0)).getByRole('button', { name: 'Copy message', exact: true });
  await expect(copyUser).toBeVisible();
  await copyUser.click();
  await expect(actions(rows.nth(0)).getByRole('button', { name: 'Copied' })).toBeVisible();
  await expect(actions(rows.nth(0)).locator('[aria-live="polite"]')).toHaveText('Copied');
  expect(await clip(page)).toEqual([USER]);
  await expect(actions(rows.nth(0)).getByRole('button', { name: 'Copy message', exact: true })).toBeVisible({ timeout: 4000 }); // back after 1.5 s
  // The agent's message: its Markdown source, not the rendered text.
  await rows.nth(1).hover();
  await actions(rows.nth(1)).getByRole('button', { name: 'Copy message', exact: true }).click();
  await expect(actions(rows.nth(1)).getByRole('button', { name: 'Copied' })).toBeVisible();
  expect(await clip(page)).toEqual([USER, AGENT]);
  // The fork action is still there beside it.
  await expect(rows.nth(1).getByRole('button', { name: 'Fork from here' })).toHaveCount(1);
});

test('chat_copy_message (keyboard): the group is reached by Tab and Enter copies; nothing is written before that', async ({ page, chatCore }) => {
  await stubClipboard(page);
  const s = chatCore.chat('copy-key');
  append(s.file, rec.user(USER), rec.assistant(AGENT));
  await openChat(page, s.id);
  const row = chat(page, s.id).locator('.message-row').nth(0); // the user's message: the agent's has a code block with its own Copy ahead of the group
  expect(await clip(page)).toEqual([]); // opening the chat and showing the buttons wrote nothing
  const copy = actions(row).getByRole('button', { name: 'Copy message', exact: true });
  if (test.info().project.name === 'webkit') {
    // WebKit's Tab skips buttons (macOS "Press Tab to highlight each item" is off; cf5-fork's fork_button_keyboard_reachable
    // fails the same way there), so only the focus-within and Enter behaviour is checked on it.
    await copy.focus();
  } else {
    await row.focus(); // the message wrapper takes focus; real Tab reaches Fork from here, then Copy
    await page.keyboard.press('Tab');
    await expect(actions(row).getByRole('button', { name: 'Fork from here' })).toBeFocused();
    await page.keyboard.press('Tab');
  }
  await expect(copy).toBeFocused();
  // Focus inside the group shows it (it is hidden by opacity until hover or focus-within).
  expect(await row.locator('.message-actions').evaluate((e) => getComputedStyle(e).opacity)).toBe('1');
  expect(await clip(page)).toEqual([]);
  await page.keyboard.press('Enter');
  await expect(actions(row).getByRole('button', { name: 'Copied' })).toBeFocused();
  expect(await clip(page)).toEqual([USER]);
});

test('chat_copy_message (exited session): Copy still works in the read-only chat', async ({ page, chatCore }) => {
  await stubClipboard(page);
  const s = chatCore.chat('copy-ended');
  append(s.file, rec.user('끝나기 전 질문'), rec.assistant('끝나기 전 **답**'));
  await openChat(page, s.id);
  chatCore.cli('session', 'send-text', s.id, 'EXIT\r');
  await expect(page.locator(`.tab[data-tab="${s.id}"] .tdot`)).toHaveAttribute('data-s', 'done');
  const row = chat(page, s.id).locator('.message-row').nth(1);
  await row.hover();
  await actions(row).getByRole('button', { name: 'Copy message', exact: true }).click();
  await expect(actions(row).getByRole('button', { name: 'Copied' })).toBeVisible();
  expect(await clip(page)).toEqual(['끝나기 전 **답**']);
});
