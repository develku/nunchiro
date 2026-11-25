// Ticket 1145 (scorecard p13 First use T10, p04 Usability): a chat session that shows takes the composer, so a pasted
// `claude mcp add ...` line lands there with no click (T3 Code ChatView.tsx: focus on thread show, refocus on window focus).
// Arrow travel in the tab strip keeps the strip; a shell keeps its terminal; no focus moves during an IME composition.
import type { Page } from '@playwright/test';
import { chat, expect, openChat, test } from './fixtures/chat/harness';
import { grantClipboard } from './fixtures';

const LINE = 'claude mcp add x -- /bin/echo hi';
const box = (page: Page) => page.locator('#composer');
/** A real paste (⌘V) into whatever has focus, with no click first: the offer row shows only on a paste. */
const paste = async (page: Page) => {
  await grantClipboard(page);
  await page.evaluate((t) => navigator.clipboard.writeText(t), LINE);
  await page.keyboard.press('ControlOrMeta+KeyV');
  await expect(box(page)).toHaveValue(LINE);
  await expect(page.locator('.mcp-offer')).toBeVisible();
};
const shown = (page: Page, id: string) => expect(chat(page, id).locator('.clist')).toHaveAttribute('aria-busy', 'false');

test('tab_click_then_paste: clicking a chat tab focuses its composer', async ({ page, chatCore }) => {
  const a = chatCore.chat('a', true, false, 'p');
  const b = chatCore.chat('b', true, false, 'p');
  await openChat(page, a.id);
  await page.locator(`.tab[data-tab="${b.id}"]`).click();
  await shown(page, b.id);
  await expect(box(page)).toBeFocused();
  await paste(page);
});

test('tree_click_then_paste: clicking a session row in the tree focuses its composer', async ({ page, chatCore }) => {
  const a = chatCore.chat('a', true, false, 'p');
  const b = chatCore.chat('b', true, false, 'p');
  await openChat(page, a.id);
  await page.locator(`.tree button.row.wt2[data-menu-session="${b.id}"]`).click();
  await shown(page, b.id);
  await expect(box(page)).toBeFocused();
  await paste(page);
});

test('start_then_paste: a session started from the project row + focuses its composer', async ({ page, chatCore }) => {
  await page.addInitScript(() => localStorage.getItem('nunchiro.settings.v1') === null && localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ features: { 'onboarding.default_agent': 'claude' } })));
  const a = chatCore.chat('a', true, false, 'p');
  await openChat(page, a.id);
  const head = page.locator('.row.head', { hasText: 'p' }).first();
  await head.hover();
  await head.getByRole('button', { name: 'New Claude session in p' }).click();
  await expect(page.locator('.tab[aria-selected="true"]')).not.toHaveAttribute('data-tab', a.id);
  await expect(box(page)).toBeFocused();
  await paste(page);
});

test('window_focus_then_paste: the window coming back with a chat in front focuses its composer', async ({ page, chatCore }) => {
  const a = chatCore.chat('a', true, false, 'p');
  await openChat(page, a.id);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(box(page)).toBeFocused();
  await paste(page);
});

test('window_focus_keeps_a_focused_element: the window event (also fired by a Tab walk out of the page and back) leaves a focused button alone', async ({ page, chatCore }) => {
  const a = chatCore.chat('a', true, false, 'p');
  await openChat(page, a.id);
  const row = page.getByRole('button', { name: 'Open command palette' }); // a button a Tab walk reaches (decision-rows keyboard_only_and_axe)
  await row.focus();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.waitForTimeout(200); // past the two frames the refocus waits
  await expect(row).toBeFocused();
  await expect(box(page)).not.toBeFocused();
});

test('strip_arrows_keep_the_strip: ArrowRight on a tab shows the next chat and focus stays on the tab', async ({ page, chatCore }) => {
  const a = chatCore.chat('a', true, false, 'p');
  const b = chatCore.chat('b', true, false, 'p');
  await openChat(page, a.id);
  await page.locator(`.tab[data-tab="${a.id}"]`).focus();
  await page.keyboard.press('ArrowRight');
  await shown(page, b.id);
  await page.waitForTimeout(200); // past the frames a deferred focus would take
  await expect(page.locator(`.tab[data-tab="${b.id}"]`)).toBeFocused();
});

test('shell_keeps_its_terminal: clicking a shell tab never focuses a composer', async ({ page, chatCore }) => {
  const a = chatCore.chat('a', true, false, 'p');
  const s = chatCore.shell(chatCore.project('p'), 'sh');
  await openChat(page, a.id);
  await page.locator(`.tab[data-tab="${s.id}"]`).click();
  await page.waitForTimeout(200);
  await expect(page.locator('#composer:focus')).toHaveCount(0); // a shell shows no composer until asked
});

test('no_focus_move_mid_composition: window focus during an IME composition leaves focus where it is', async ({ page, chatCore }) => {
  const a = chatCore.chat('a', true, false, 'p');
  await openChat(page, a.id);
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    document.body.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    window.dispatchEvent(new Event('focus'));
  });
  await page.waitForTimeout(200);
  await expect(box(page)).not.toBeFocused();
  await page.evaluate(() => document.body.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })));
});
