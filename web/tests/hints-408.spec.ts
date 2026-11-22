// Ticket 408 (real app 2026-11-10): hint labels covered the first letter of "notify", "Thinking", "Resume", the model and
// effort chips and "+ Project", and landed on disabled controls (a read-only session's chips and composer) and on a failed
// shell's empty terminal. A label now leaves every control's first character readable, and unusable things get none.
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, openWindow, REPO, test } from './fixtures';
import { append, chat, openChat, rec, test as chatTest } from './fixtures/chat/harness';

const SHOTS = path.join(REPO, '.scratch/shots/408');

const hints = async (page: Page) => {
  await page.keyboard.press('Control+Space');
  await page.keyboard.press('KeyF');
  await expect(page.locator('.hint').first()).toBeVisible();
};

/** Labels hiding a control's first character, as `<label> on "<control text>"`; checked for every control on screen. */
const covered = (page: Page) =>
  page.evaluate(() => {
    const meets = (a: DOMRect, b: DOMRect) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
    const labels = [...document.querySelectorAll<HTMLElement>('.hint[data-kind="element"]')].map((h) => ({ label: h.dataset.hint!, r: h.getBoundingClientRect() }));
    const out: string[] = [];
    const control = 'button, a[href], [role="button"], [role="tab"]';
    for (const el of document.querySelectorAll<HTMLElement>(control)) {
      if (el.closest('.hints-layer')) continue;
      const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let n = walk.nextNode(); n; n = walk.nextNode()) {
        const at = n.textContent!.search(/\S/);
        if (at < 0 || n.parentElement?.closest(control) !== el) continue;
        const range = document.createRange();
        range.setStart(n, at);
        range.setEnd(n, at + 1);
        const first = range.getBoundingClientRect();
        if (!first.width || !first.height) continue;
        for (const l of labels) if (meets(l.r, first)) out.push(`${l.label} on "${el.textContent!.trim().slice(0, 24)}"`);
        break;
      }
    }
    return out;
  });

/** The label each element got (test seam in Hints.tsx), or null. */
const labelOf = (page: Page, sel: string) =>
  page.evaluate((sel) => {
    const el = document.querySelector(sel);
    const all = (window as unknown as { __hintTargets: { el?: Element; label: string }[] }).__hintTargets;
    return all.find((h) => h.el === el)?.label ?? null;
  }, sel);

test('first_letters_stay_readable: notify, the model and effort chips and + Project keep their first letter and their label', async ({ app, core }) => {
  const a = core.project('nunchiro');
  core.agent(a, 'one', 'go1');
  core.shell(a, 'four');
  await openWindow(app);
  await app.locator('.tab').first().click();
  await expect(app.getByRole('button', { name: /^\+ Project|Add a project/ })).toBeVisible();
  await hints(app);
  await app.screenshot({ path: path.join(SHOTS, `controls-${test.info().project.name}.png`) });
  expect(await covered(app)).toEqual([]);
  // The controls keep their labels (ticket 389's letters for this screen).
  for (const sel of ['[data-picker="model"]', '[data-picker="effort"]', '[aria-label^="Notifications for"]']) expect(await labelOf(app, sel), sel).not.toBeNull();
});

chatTest('first_letters_stay_readable_in_chat: the Thinking row keeps its first letter', async ({ page, chatCore }) => {
  const s = chatCore.chat();
  append(s.file, rec.user('before'), rec.thinking('pondering the question'), rec.use('b1', 'Bash', { command: 'ls' }), rec.result('b1', 'a.rs'), rec.assistant('the answer'));
  await page.addInitScript(() => localStorage.setItem('nunchiro.chatView.v2', 'verbose')); // the Thinking row shows
  await openChat(page, s.id);
  await expect(chat(page, s.id).locator('.tool .tl', { hasText: 'Thinking' })).toBeVisible();
  await hints(page);
  await page.screenshot({ path: path.join(SHOTS, `chat-${test.info().project.name}.png`) });
  expect(await covered(page)).toEqual([]);
});

chatTest('read_only_session: the disabled composer and the model and effort chips get no label; Resume keeps its first letter', async ({ page, chatCore }) => {
  const s = chatCore.chat();
  append(s.file, rec.user('before'), rec.assistant('the answer'));
  await openChat(page, s.id);
  chatCore.windowClose(s.id); // ticket 1013 F6: the window's own Close keeps the done tab
  const box = page.locator('.composer textarea');
  await expect(box).toBeDisabled();
  const resume = page.locator('.composer .whyline').getByRole('button', { name: 'Continue', exact: true });
  await expect(resume).toBeVisible();
  await expect(page.locator('[data-picker="model"]')).toHaveAttribute('aria-disabled', 'true');
  await expect(page.locator('[data-picker="effort"]')).toHaveAttribute('aria-disabled', 'true');
  await hints(page);
  await page.screenshot({ path: path.join(SHOTS, `read-only-${test.info().project.name}.png`) });
  for (const sel of ['.composer textarea', '[data-picker="model"]', '[data-picker="effort"]']) expect(await labelOf(page, sel), sel).toBeNull();
  expect(await labelOf(page, '.composer .whyline .btn')).not.toBeNull();
  expect(await covered(page)).toEqual([]);
});

test('failed_shell_session: the empty read-only terminal gets no label', async ({ app, core }) => {
  const p = core.project('demo');
  core.shell(p, 'live');
  const broken = core.shell(p, 'broken', '/bin/sh', '-c', 'read x; exit 3').id;
  await openWindow(app);
  await app.locator(`.tab[data-tab="${broken}"]`).click();
  core.cli('session', 'send-text', broken, 'x\r'); // the shell fails with nothing on its screen
  await expect(app.locator('.roterm .term')).toBeVisible();
  await hints(app);
  await app.screenshot({ path: path.join(SHOTS, `failed-shell-${test.info().project.name}.png`) });
  expect(await labelOf(app, '.roterm .term')).toBeNull();
  // Other targets keep theirs: the tabs still read s1 s2.
  await expect(app.locator('.hint[data-hint-kind="tab"]')).toHaveCount(2);
  expect(await covered(app)).toEqual([]);
});
