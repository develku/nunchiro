// Ticket 286 item 1 r5 (card C-20261106-06): "done" arrives when the AGENT ends, not when the shell it leaves quits.
// A real core, a fake Claude that exits on "EXIT"; its wrapper's shell stays Running and is never quit here.
import fs from 'node:fs';
import path from 'node:path';
import { append, chat, openChat, rec, test, expect } from './fixtures/chat/harness';
import { terminalText } from './fixtures';

test('agent_ended_reads_done: dot, done sound, board Done and the composer follow the agent; the terminal still reaches the shell', async ({ page, chatCore }) => {
  fs.copyFileSync(path.join(import.meta.dirname, 'fixtures/board/layout.toml'), path.join(chatCore.home, 'layout.toml'));
  await page.addInitScript(() => {
    const w = window as unknown as { __calls: { cmd: string; args: unknown }[] };
    w.__calls = [];
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = { invoke: async (cmd: string, args: unknown) => void w.__calls.push({ cmd, args }) };
    document.hasFocus = () => false; // a session the user is looking at gets no done cue (isViewed)
  });
  const sounds = () => page.evaluate(() => (window as unknown as { __calls: { cmd: string; args: unknown }[] }).__calls.filter((c) => c.cmd === 'play_sound').map((c) => c.args));
  const s = chatCore.chat('ended');
  append(s.file, rec.user('끝나기 전 질문'), rec.assistant('끝나기 전 답'));
  await openChat(page, s.id);
  await expect(chat(page, s.id).getByText('끝나기 전 답')).toBeVisible();
  chatCore.cli('session', 'send-text', s.id, 'EXIT\r');
  await expect.poll(() => fs.existsSync(path.join(chatCore.home, `agent-ended-${s.id}`)), { timeout: 15_000 }).toBe(true);
  await expect(page.locator(`.tab[data-tab="${s.id}"] .tdot`)).toHaveAttribute('data-s', 'done', { timeout: 15_000 });
  await expect.poll(sounds, { timeout: 5000 }).toEqual([{ name: 'Glass', volume: 1 }]);
  await page.mouse.move(2, 2); // the board holds still while the pointer is over it (needs 26)
  await expect(page.locator('.board [data-column="done"] .bcard')).toHaveCount(1, { timeout: 10_000 });
  await expect(page.locator('.composer textarea')).toBeDisabled();
  await expect(page.locator('.composer .why')).toHaveText('The agent has ended: type in the terminal.');
  // The shell is the user's: still Running, and keys typed in the terminal reach it.
  expect((chatCore.cli('snapshot', '--json').sessions as { id: string; state: string }[]).find((x) => x.id === s.id)?.state).toBe('running');
  await page.getByRole('button', { name: 'Terminal', exact: true }).click(); // the Right bar's Terminal icon: the side pane
  const term = page.locator(`[data-side-pane] .term[data-session="${s.id}"]`);
  await expect(term).toBeVisible();
  await term.click();
  // The wrapper drops keys typed before its shell starts; the user types at the prompt.
  await expect.poll(() => terminalText(page, s.id), { timeout: 10_000 }).toMatch(/\$\s*$/);
  await page.keyboard.type('echo $((40+2))x\r');
  await expect.poll(() => terminalText(page, s.id), { timeout: 10_000 }).toContain('42x');
});
