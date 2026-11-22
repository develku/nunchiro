// Ticket 497: every copy copies its text or says it did not. A paired browser over plain HTTP has no
// `navigator.clipboard` (not a secure context), and a refused write rejects; neither may throw or show "Copied".
import type { Page } from '@playwright/test';
import { type Core, expect, openWindow, test } from './fixtures';
import { append, chat, openChat, rec, test as chatTest } from './fixtures/chat/harness';

type Clip = 'missing' | 'missing-refused' | 'rejects';

/** Shapes the clipboard before the page runs. `missing-refused` also makes the execCommand fallback fail. */
const clipboard = (page: Page, clip: Clip, crash = false) =>
  page.addInitScript(
    ({ clip, crash }) => {
      const w = window as unknown as { __testCrash?: string; __copied: string[] };
      if (crash) w.__testCrash = 'boot';
      w.__copied = [];
      const writeText = () => Promise.reject(new DOMException('Write permission denied.', 'NotAllowedError'));
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: clip === 'rejects' ? { writeText } : undefined });
      // Records what the fallback selected; the real command still runs unless refused.
      const real = document.execCommand.bind(document);
      document.execCommand = (cmd: string, ...rest: never[]) => {
        if (cmd !== 'copy') return real(cmd, ...rest);
        if (clip === 'missing-refused') return false;
        const el = document.activeElement as HTMLTextAreaElement | null;
        const ok = real(cmd, ...rest);
        if (ok) w.__copied.push(el?.value?.slice(el.selectionStart, el.selectionEnd) ?? '');
        return ok;
      };
    },
    { clip, crash },
  );

const uncaught = (page: Page) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  return errors;
};
const copied = (page: Page) => page.evaluate(() => (window as unknown as { __copied: string[] }).__copied);

/** "Copied" only with the text recorded, else "Could not copy" with nothing recorded; refused paths never say Copied. */
async function honest(page: Page, said: string, clip: Clip, expected: (text: string) => boolean) {
  const got = await copied(page);
  if (said === 'Copied') expect(got.length === 1 && expected(got[0]), JSON.stringify(got)).toBe(true);
  else expect(got).toEqual([]);
  if (clip !== 'missing') expect(said).toBe('Could not copy');
}

test.describe('crash screen Copy details', () => {
  for (const clip of ['missing', 'missing-refused', 'rejects'] as const) {
    test(`copy_fails_crash_${clip}: no uncaught error, no false Copied`, async ({ app }) => {
      const errors = uncaught(app);
      await clipboard(app, clip, true);
      await app.goto('/');
      const copy = app.getByRole('button', { name: 'Copy details' });
      await copy.click();
      const done = app.getByRole('button', { name: /^(Copied|Could not copy)$/ });
      await expect(done).toBeVisible();
      await honest(app, await done.innerText(), clip, (t) => t.includes('Error: test crash (boot)'));
      expect(errors).toEqual([]);
    });
  }
});

/** Refuses the next `scrollback_edit` with `raw`, so the status bar shows a failure note (errors-plain.spec.ts). */
async function failNote(app: Page, core: Core, raw: string) {
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    let armed = true;
    ws.onMessage((msg) => {
      const r = typeof msg === 'string' ? JSON.parse(msg) : null;
      if (armed && r?.request?.op === 'scrollback_edit') return (armed = false), ws.send(JSON.stringify({ id: r.id, response: { Err: raw } }));
      server.send(msg);
    });
    server.onMessage((msg) => ws.send(msg));
  });
  const s = core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await app.locator(`.tab[data-tab="${s.id}"]`).click();
  await app.getByRole('button', { name: /palette/ }).first().click();
  await app.getByRole('combobox').first().fill('$EDITOR');
  await app.keyboard.press('Enter');
  const note = app.locator('.pane-status .pane-note');
  await expect(note).toHaveAttribute('data-tip', raw);
  expect(core.opened()).toBe(''); // ticket 800: the refused op never reached the core's `open -t`
  return note;
}

test.describe('error note copy', () => {
  for (const clip of ['missing', 'missing-refused', 'rejects'] as const) {
    test(`copy_fails_note_${clip}: no uncaught error, no false Copied`, async ({ app, core }) => {
      const errors = uncaught(app);
      await clipboard(app, clip);
      const raw = 'holder busy';
      const note = await failNote(app, core, raw);
      await note.click();
      await expect(note).toHaveText(/^(Copied|Could not copy)$/);
      await honest(app, await note.innerText(), clip, (t) => t === raw);
      expect(errors).toEqual([]);
    });
  }
});

// Round 2: the chat message Copy (Rows.tsx MessageActions) on a page without navigator.clipboard.
chatTest.describe('chat message copy', () => {
  for (const clip of ['missing', 'missing-refused'] as const) {
    chatTest(`copy_fails_chat_${clip}: no uncaught error, no false Copied`, async ({ page, chatCore }) => {
      const errors = uncaught(page);
      await clipboard(page, clip);
      const s = chatCore.chat('copy');
      const text = 'Please rename `foo` to `bar`.';
      append(s.file, rec.user(text));
      await openChat(page, s.id);
      const row = chat(page, s.id).locator('.message-row').first();
      await row.hover();
      await row.locator('.message-actions').getByRole('button', { name: 'Copy message', exact: true }).click();
      const said = row.locator('.message-actions [aria-live="polite"]');
      await expect(said).toHaveText(/^(Copied|Could not copy)$/);
      await honest(page, await said.innerText(), clip, (t) => t === text);
      expect(errors).toEqual([]);
    });
  }
});

// Round 3: copy mode's y (and Hints, which share App's note) says "Could not copy" when the copy did not happen.
test('copy_fails_copy_mode_missing-refused: the note says Could not copy, never Copied', async ({ app, core }) => {
  const errors = uncaught(app);
  await clipboard(app, 'missing-refused');
  const a = core.replay(core.project('demo'), 'alpha', 'line 001 ab cd_ef');
  await openWindow(app);
  await expect(app.locator(`.term[data-session="${a.id}"] .xterm-rows`)).toContainText('line 001');
  await app.keyboard.press('Control+Space');
  await app.keyboard.press('BracketLeft');
  await expect(app.locator('.copy-status')).toBeVisible();
  for (const k of ['KeyG', 'KeyG', 'Digit0', 'KeyV', 'KeyE', 'KeyY']) await app.keyboard.press(k);
  await expect(app.locator('.copied-note')).toHaveText('Could not copy');
  expect(await copied(app)).toEqual([]);
  expect(errors).toEqual([]);
});

// Round 3: the fallback's hidden textarea takes the page selection for a moment; selected page text comes back.
test('copy_fails_fallback_keeps_selection: selected page text is selected again after a fallback copy', async ({ app }) => {
  await clipboard(app, 'missing', true);
  await app.goto('/');
  await expect(app.getByRole('button', { name: 'Copy details' })).toBeVisible();
  const kept = await app.evaluate(() => {
    const title = document.querySelector('.bfail-title')!;
    getSelection()!.selectAllChildren(title);
    (document.querySelector('.bfail-acts .btn:not(.p)') as HTMLButtonElement).click();
    return getSelection()!.toString();
  });
  expect(kept).toBe('This window hit a problem');
});
