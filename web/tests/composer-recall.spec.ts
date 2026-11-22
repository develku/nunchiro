// Ticket 371 item 14: Up and Down in the empty composer bring back this session's earlier prompts. Real core, a fake
// Claude whose transcript the test writes. The guards are what keep the user's own typing and an IME's keys safe.
import type { Page } from '@playwright/test';
import { append, chat, expect, openChat, rec, test, type ChatCore } from './fixtures/chat/harness';
import { give, helpers } from './fixtures/images/helpers';

const ta = (page: Page) => page.locator('.cbox textarea:not(.hoff-edit)').first();
const menu = (page: Page) => page.getByRole('listbox');
const saved = (name: string) => `/data/images/sess-1/${name.repeat(64)}.png`;

/** A session whose transcript holds `prompts`, with the composer focused and every prompt on screen. */
async function start(page: Page, core: ChatCore, ...prompts: string[]) {
  const s = core.chat('recall');
  append(s.file, ...prompts.map((p) => rec.user(p)), rec.assistant('Done reading'));
  await page.addInitScript(helpers);
  await openChat(page, s.id);
  await expect(chat(page, s.id).getByText('Done reading')).toBeVisible();
  await ta(page).click();
  return s;
}

test('recall_steps_back_and_returns_to_empty', async ({ page, chatCore }) => {
  await start(page, chatCore, 'first prompt', 'second prompt');
  await ta(page).press('ArrowUp');
  await expect(ta(page)).toHaveValue('second prompt');
  await ta(page).press('ArrowUp');
  await expect(ta(page)).toHaveValue('first prompt');
  await ta(page).press('ArrowUp'); // nothing older: it stays
  await expect(ta(page)).toHaveValue('first prompt');
  await ta(page).press('ArrowDown');
  await expect(ta(page)).toHaveValue('second prompt');
  await ta(page).press('ArrowDown');
  await expect(ta(page)).toHaveValue('');
});

test('recall_skips_a_repeat_and_saved_image_lines', async ({ page, chatCore }) => {
  await start(page, chatCore, 'older', 'same', 'same', `${saved('a')}\nfix this picture`, saved('b'));
  await ta(page).press('ArrowUp');
  await expect(ta(page)).toHaveValue('fix this picture'); // the image-only prompt has no words to bring back
  await ta(page).press('ArrowUp');
  await expect(ta(page)).toHaveValue('same');
  await ta(page).press('ArrowUp');
  await expect(ta(page)).toHaveValue('older');
});

test('recall_is_nothing_during_hangul_composition', async ({ page, chatCore }) => {
  await start(page, chatCore, 'first prompt');
  await ta(page).evaluate((el: HTMLTextAreaElement) => {
    el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', keyCode: 229, isComposing: true, bubbles: true, cancelable: true }));
  });
  await expect(ta(page)).toHaveValue('');
  // A key an IME reports as 229 outside its composition events is the IME's too.
  await ta(page).evaluate((el: HTMLTextAreaElement) => {
    el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '' }));
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', keyCode: 229, bubbles: true, cancelable: true }));
  });
  await expect(ta(page)).toHaveValue('');
  await ta(page).press('ArrowUp'); // composition over: the key is ours again
  await expect(ta(page)).toHaveValue('first prompt');
});

test('recalled_command_does_not_open_the_menu', async ({ page, chatCore }) => {
  await start(page, chatCore, 'first prompt', '@README.md', '/compact');
  await ta(page).press('ArrowUp');
  await expect(ta(page)).toHaveValue('/compact');
  await expect(menu(page)).toHaveCount(0);
  await ta(page).press('ArrowUp'); // the menu did not take the key
  await expect(ta(page)).toHaveValue('@README.md');
  await expect(menu(page)).toHaveCount(0);
  await ta(page).press('ArrowUp');
  await expect(ta(page)).toHaveValue('first prompt');
  await ta(page).fill('');
  await ta(page).pressSequentially('/'); // typing still opens it
  await expect(menu(page)).toBeVisible();
  await ta(page).press('ArrowDown'); // and an open menu still owns the arrows
  await expect(ta(page)).toHaveValue('/');
});

test('recall_never_replaces_typed_text', async ({ page, chatCore }) => {
  await start(page, chatCore, 'first prompt');
  await ta(page).pressSequentially('my own words');
  await ta(page).press('ArrowUp');
  await expect(ta(page)).toHaveValue('my own words');
  await ta(page).fill('');
  await ta(page).press('ArrowUp');
  await expect(ta(page)).toHaveValue('first prompt');
  await ta(page).pressSequentially(' edited'); // a recalled prompt that was edited is the user's now
  await ta(page).press('ArrowUp');
  await expect(ta(page)).toHaveValue('first prompt edited');
  await ta(page).press('ArrowDown');
  await expect(ta(page)).toHaveValue('first prompt edited');
});

test('recall_leaves_a_box_with_an_image_chip', async ({ page, chatCore }) => {
  await start(page, chatCore, 'first prompt');
  await give(page, [{ png: [40, 30, 1, 'shot.png'] }]);
  await expect(page.locator('.cbox .ichip')).toHaveCount(1);
  await ta(page).press('ArrowUp');
  await expect(ta(page)).toHaveValue('');
  await expect(page.locator('.cbox .ichip')).toHaveCount(1);
});

test('recall_needs_the_bare_key_on_the_edge_line', async ({ page, chatCore }) => {
  await start(page, chatCore, 'older', 'line one\nline two');
  await ta(page).press('Shift+ArrowUp');
  await expect(ta(page)).toHaveValue('');
  await ta(page).press('ArrowUp');
  await expect(ta(page)).toHaveValue('line one\nline two');
  await ta(page).press('ArrowUp'); // the caret is on the last line: the key moves it
  await expect(ta(page)).toHaveValue('line one\nline two');
  await ta(page).press('ArrowUp'); // now on the first line
  await expect(ta(page)).toHaveValue('older');
});

test('no_prompts_means_no_recall', async ({ page, chatCore }) => {
  await start(page, chatCore);
  await ta(page).press('ArrowUp');
  await ta(page).press('ArrowDown');
  await expect(ta(page)).toHaveValue('');
});
