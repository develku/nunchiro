// Acceptance 8 (window half): the 01 test text through IME composition, reattach and paste. Chromium drives a
// real composition over CDP; WebKit has no IME driver in Playwright, so it covers commit, paste and reattach.
import type { CDPSession, Page } from '@playwright/test';
import { expect, HANGUL, openWindow, test, terminalText, showComposer } from './fixtures';

const count = (hay: string, needle: string) => hay.split(needle).length - 1;

/**
 * Composes each Hangul syllable through its jamo stages (ㄴ → 누 → 눈), as the 2-set IME does, 15 ms per
 * key. With no gap at all, about 1 run in 100 gets an extra space after a syllable that a space commits
 * (xterm.js finalises a composition on a 0 ms timer); human typing is slower than 15 ms per key.
 */
async function compose(cdp: CDPSession, text: string) {
  const gap = () => new Promise((r) => setTimeout(r, 15));
  for (const ch of text) {
    await gap();
    const code = ch.charCodeAt(0) - 0xac00;
    if (code < 0 || code > 11171) {
      await cdp.send('Input.insertText', { text: ch });
      continue;
    }
    const lead = String.fromCharCode(0x1100 + Math.floor(code / 588));
    const stages = [lead.normalize('NFC'), String.fromCharCode(0xac00 + code - (code % 28))];
    if (code % 28) stages.push(ch);
    for (const s of stages) {
      await cdp.send('Input.imeSetComposition', { text: s, selectionStart: s.length, selectionEnd: s.length });
      await gap();
    }
    await cdp.send('Input.insertText', { text: ch });
  }
}

async function paste(page: Page, selector: string, text: string) {
  await page.locator(selector).evaluate((el, t) => {
    const data = new DataTransfer();
    data.setData('text/plain', t);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, text);
}

test('terminal: composed Hangul reaches the PTY exactly once and survives reattach', async ({ app, core, browserName }) => {
  const a = core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await app.locator(`.term[data-session="${a.id}"]`).click();
  if (browserName === 'chromium') {
    const cdp = await app.context().newCDPSession(app);
    // An uncommitted syllable stays in the IME: nothing reaches the PTY until it commits.
    await cdp.send('Input.imeSetComposition', { text: '누', selectionStart: 1, selectionEnd: 1 });
    await app.waitForTimeout(150);
    expect(core.read(a.id)).not.toContain('누');
    await cdp.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 });
    await compose(cdp, HANGUL);
  } else await app.keyboard.insertText(HANGUL);
  // The tty echoes each byte once; a duplicated or dropped syllable changes the count.
  await expect.poll(() => count(core.read(a.id), HANGUL)).toBe(1);
  await app.keyboard.press('Enter');
  await expect.poll(() => count(core.read(a.id), HANGUL)).toBe(2);
  await expect.poll(() => terminalText(app, a.id)).toContain(HANGUL);
  await app.reload();
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  await expect.poll(() => terminalText(app, a.id)).toContain(HANGUL);
  expect(count(await terminalText(app, a.id), HANGUL)).toBe(2);
});

test('terminal: pasted Hangul arrives intact', async ({ app, core }) => {
  const a = core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await app.locator(`.term[data-session="${a.id}"]`).click();
  await paste(app, `.term[data-session="${a.id}"] textarea`, HANGUL);
  await expect.poll(() => count(core.read(a.id), HANGUL)).toBe(1);
});

test('composer: Enter during composition commits only; the next Enter sends the exact text once', async ({ app, core, browserName }) => {
  const a = core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await showComposer(app); // V2.5-34: a shell's composer is asked for
  const box = app.locator('.cbox textarea');
  await box.focus();
  if (browserName === 'chromium') {
    const cdp = await app.context().newCDPSession(app);
    await compose(cdp, HANGUL.slice(0, -1));
    await cdp.send('Input.imeSetComposition', { text: '요', selectionStart: 1, selectionEnd: 1 });
  } else await app.keyboard.insertText(HANGUL.slice(0, -1));
  // The Enter that commits a syllable carries isComposing (Safari: keyCode 229) and must not send.
  await box.evaluate((el) => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true, bubbles: true, cancelable: true }));
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229, bubbles: true, cancelable: true } as KeyboardEventInit));
  });
  if (browserName === 'chromium') await (await app.context().newCDPSession(app)).send('Input.insertText', { text: '요' });
  else await app.keyboard.insertText('요');
  await expect(box).toHaveValue(HANGUL);
  expect(core.read(a.id)).not.toContain('눈치로');
  await box.press('Enter');
  // Echo of the sent line plus cat's copy: exactly two, so nothing was sent twice or early.
  await expect.poll(() => count(core.read(a.id), HANGUL)).toBe(2);
  await expect(box).toHaveValue('');
});

test('composer: pasted Hangul is sent as typed', async ({ app, core, browserName }) => {
  const a = core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await showComposer(app); // V2.5-34: a shell's composer is asked for
  const box = app.locator('.cbox textarea');
  await box.focus();
  if (browserName === 'chromium') {
    await app.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await app.evaluate((t) => navigator.clipboard.writeText(t), HANGUL);
    await app.keyboard.press('ControlOrMeta+KeyV');
  } else await app.keyboard.insertText(HANGUL);
  await expect(box).toHaveValue(HANGUL);
  await box.press('Enter');
  await expect.poll(() => count(core.read(a.id), HANGUL)).toBe(2);
});
