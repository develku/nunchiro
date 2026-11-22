// Ticket 294 item 3 (needs 213): the Decisions card lists every option of the prompt, in the prompt's order and numbering.
// An option the window sends is a button that sends exactly its key; one it never sends (an option that changes the agent's
// settings) is listed as text, never guessed (ticket 991 B4: no button that does nothing). A dialog (a folder-trust prompt)
// lists none: the terminal answers it (ticket 991 B5). A risky allow stays
// focus + Enter only (needs 128). A real core and fake agents; the window's socket is proxied to record answers.
import type { Page } from '@playwright/test';
import { expect, openWindow, test, type Core } from './fixtures';
import { fakes, gitRepo, pending, PERMISSION, proxy, QUESTION, show } from './decision-rows-seed';
import { icon, sidebar } from './d5b';

const TRUST = ' Do you trust this folder?\r\n ❯ 1. Yes, I trust this folder\r\n   2. No, exit\r\n';
type Agent = { id: string; cwd: string };
async function setup(app: Page, core: Core) {
  fakes(core);
  const p = gitRepo(core, 'repo');
  const a: Agent = core.agent(p, 'wt-a', 'go-a', true);
  const px = await proxy(app);
  await openWindow(app);
  return { a, px };
}
/** The prompt on screen, then the Decisions widget open on it. */
async function ask(app: Page, core: Core, a: Agent, screen: string) {
  show(a.cwd, 'go-a', screen);
  await expect(app.locator(`.q[data-line="${a.id}"]`)).toBeVisible({ timeout: 8000 });
  await icon(app, 'right', 'Decisions').click();
  const card = sidebar(app, 'right').locator('.dc-item');
  await expect(card).toHaveCount(1);
  // Opening the sidebar refits the terminal and a redraw re-files the prompt under a new id: wait for the item the core holds now.
  await expect
    .poll(async () => {
      const shown = await card.first().getAttribute('data-item');
      return pending(core).some((d) => d.id === shown);
    })
    .toBe(true);
  return card;
}

test('decision_card_lists_all_options: a question lists every option in order; the sendable ones send their own key, the other is text', async ({ app, core }) => {
  const { a, px } = await setup(app, core);
  const card = await ask(app, core, a, QUESTION);
  const options = card.locator('.dc-btns [data-act="choose"], .dc-btns [data-act="option"]');
  await expect(options).toHaveText(['1 red', '2 blue', '3 Always pick red from now on']);
  await expect(options.nth(0)).toBeEnabled();
  await expect(options.nth(1)).toBeEnabled();
  await expect(options.nth(2)).toHaveJSProperty('tagName', 'SPAN'); // it persists to the agent's config: never sent from the window (v1a-03)
  await options.nth(2).click({ force: true });
  await app.waitForTimeout(300);
  expect(px.sent).toHaveLength(0);
  await options.nth(1).click();
  await expect.poll(() => core.read(a.id)).toContain('answered 2');
  expect(px.sent.map((s) => s.answer)).toEqual([{ type: 'choose', index: 1 }]);
});

test('decision_card_lists_all_options (dialog): a folder-trust prompt draws no choice buttons, only Open terminal; Deny (Esc) stays the one answer sent', async ({ app, core }) => {
  const { a, px } = await setup(app, core);
  const card = await ask(app, core, a, TRUST);
  await expect(card.locator('.dc-opts, [data-act="option"], [data-act="choose"]')).toHaveCount(0);
  await expect(card.locator('.dc-what')).toContainText('Do you trust this folder?');
  await expect(card.locator('.dc-why')).toContainText('terminal');
  await expect(card.locator('[data-act="terminal"]')).toBeVisible();
  await app.keyboard.press('Digit1');
  await app.keyboard.press('Digit2');
  await app.waitForTimeout(300);
  expect(px.sent).toHaveLength(0); // nothing guessed into the trust prompt
  // The one answer a dialog takes from the window is its deny (Esc): unchanged.
  await card.locator('[data-act="deny"]').click();
  await expect.poll(() => px.sent.length).toBe(1);
  expect(px.sent[0].answer).toEqual({ type: 'deny' });
});

// Option 1 persists to the agent's config, so it is disabled; the digit still means the prompt's own number (old code shifted it).
const SHIFTED = 'Red or blue?\r\n> 1. Always pick red from now on\r\n  2. red\r\n  3. blue\r\nEnter to select · Esc to cancel\r\n';
test('decision_card_options_digit_is_the_prompts_number: key 2 answers the prompt\'s option 2, whatever is disabled before it', async ({ app, core }) => {
  const { a, px } = await setup(app, core);
  const card = await ask(app, core, a, SHIFTED);
  await expect(card.locator('.dc-btns [data-act="choose"], .dc-btns [data-act="option"]')).toHaveText(['1 Always pick red from now on', '2 red', '3 blue']);
  await card.locator('[data-act="choose"]').first().focus();
  await app.keyboard.press('Digit1'); // disabled: nothing
  await app.keyboard.press('Digit2');
  await expect.poll(() => px.sent.length).toBe(1);
  expect(px.sent[0].answer).toEqual({ type: 'choose', index: 1 }); // what reaches the core; typing it is the first test's check
});

test('risky_allow_still_focus_enter_only: with the options listed, a risky allow still sends nothing on a click or key 1, and only Enter on its focus', async ({ app, core }) => {
  const { a, px } = await setup(app, core);
  px.risky.add('wt-a');
  const card = await ask(app, core, a, PERMISSION('rm -rf build'));
  await expect(card.locator('.dc-opts')).toHaveCount(0); // Yes and No are the Allow and Deny buttons already: no second copy
  const allow = card.locator('[data-act="allow"]');
  await app.keyboard.press('Digit1');
  await allow.click();
  await app.keyboard.press('Space');
  await app.waitForTimeout(300);
  expect(px.sent).toHaveLength(0);
  await allow.focus();
  await app.keyboard.press('Enter');
  await expect.poll(() => core.read(a.id)).toContain('answered 1');
  expect(px.sent.map((s) => s.answer)).toEqual([{ type: 'allow_once' }]);
});

test('trust_prompt_cue_in_empty_chat: while the agent asks its folder-trust question first, the empty chat says so and where to answer, not "What should we build" (ticket 991 A9, C7)', async ({ app, core }) => {
  const { a } = await setup(app, core);
  await app.locator(`.tab[data-tab="${a.id}"]`).click();
  const head = app.locator(`.chat[data-session="${a.id}"] .empty .ehead`);
  await expect(head.locator('h3')).toContainText('What should we build');
  show(a.cwd, 'go-a', TRUST);
  // The core reads the prompt off the screen: give it the 8 s `ask` gives the same read (5 s ran out in the 11-21 nightly).
  await expect(head.locator('h3')).toHaveText('wt-a asks you something first', { timeout: 8000 });
  await expect(head.locator('p')).toContainText('terminal');
});
