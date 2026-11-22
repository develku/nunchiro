// V1A-36: the IME candidate window follows the agent's input caret. macOS places it at xterm.js's helper
// textarea, which xterm moves to the buffer cursor (with the composition view) while composing. The screens below
// are cut from real PTY captures at a 100x30 input box (Claude Code 2.1.310, codex-cli 0.161.0, 2026-10-26):
// cursor and DECTCEM sequences kept, footer rows trimmed (Claude's relative moves shortened to match). Both agents hide the cursor while drawing a frame, then move
// it to the drawn caret and show it again (CSI ?25h), so the composition lands at the caret with no window fix.
import type { Page } from '@playwright/test';
import { expect, openWindow, terminalText, test } from './fixtures';

const DIVIDER = '\x1b[38;2;138;138;138m' + '─'.repeat(100) + '\x1b[39m\r\r\n';
// Ink draws top-down, then walks back up to the prompt (CSI nC, CSI nA) and shows the cursor; the next frame hides
// it and walks back down (CSI nD, CSI nB) before redrawing. Typed "a", then "b": the caret ends after "❯ ab".
const CLAUDE =
  '\x1b[?2004h\x1b]0;✳ Claude Code\x07' +
  '\x1b[38;2;215;119;87m ▐▛███▛█\x1b[12G\x1b[39m\x1b[1mClaude\x1b[19GCode\x1b[22m\x1b[24Gv2.1.310\r\r\n\r\r\n' +
  DIVIDER +
  '❯\xa0\x1b[2mTry\x1b[7G"edit\x1b[13Glib.py\x1b[20Gto..."\x1b[22m\r\r\n' +
  DIVIDER +
  '\x1b[3G\x1b[38;2;150;108;30m⏵⏵\x1b[6Gauto\x1b[11Gmode\x1b[16Gon\x1b[39m\r\r\n' +
  '\x1b[2C\x1b[3A\x1b[?25h' +
  '\x1b[?25l\x1b[2D\x1b[3B\r\x1b[2C\x1b[3Aa\x1b[K\r\r\n\r\n\r\n\x1b[3C\x1b[3A\x1b[?25h' +
  '\x1b[?25l\x1b[3D\x1b[3B\r\x1b[3C\x1b[3Ab\r\r\n\r\n\r\n\x1b[4C\x1b[3A\x1b[?25h';
// Ratatui on the alternate screen: each frame is a synchronized update (DECSET 2026) that hides the cursor, draws
// at absolute positions and ends with CUP to the caret and CSI ?25h.
const CODEX =
  '\x1b[?2004h\x1b[?2026h\x1b[?25l\x1b[?1049h\x1b[?25l\x1b[1;1H\x1b[J' +
  '\x1b[2;3H\x1b[38;2;99;168;248;49m>_ \x1b[1m\x1b[39;49mOpenAI Codex\x1b[22m\x1b[2m (v0.161.0)' +
  '\x1b[27;1H\x1b[22m\x1b[1m›\x1b[27;3H\x1b[22m\x1b[2mAsk Codex to do anything\x1b[30;3H\x1b[22m\x1b[1m?\x1b[30;5H\x1b[22mfor\x1b[30;9Hshortcuts' +
  '\x1b[39m\x1b[49m\x1b[0m\x1b[27;3H\x1b[?25h\x1b[?2026l' +
  '\x1b[?2026h\x1b[?25l\x1b[27;4H\x1b[0m\x1b[49m\x1b[K\x1b[27;3Ha\x1b[30;3H \x1b[30;5H   \x1b[30;9H         \x1b[39m\x1b[49m\x1b[0m\x1b[27;4H\x1b[?25h\x1b[?2026l' +
  '\x1b[?2026h\x1b[?25l\x1b[27;4Hb\x1b[39m\x1b[49m\x1b[0m\x1b[27;5H\x1b[?25h\x1b[?2026l';

/** Where the caret after the drawn `ab` is, and where xterm put the composition view and the IME's textarea. */
function positions(page: Page, id: string) {
  return page.locator(`.term[data-session="${id}"]`).evaluate((term) => {
    const row = [...term.querySelectorAll('.xterm-rows > div')].find((r) => r.textContent?.includes('ab'))!;
    const walk = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    let node: Text | null;
    while ((node = walk.nextNode() as Text | null) && !node.data.includes('ab'));
    const range = document.createRange();
    const at = node!.data.indexOf('ab') + 1;
    range.setStart(node!, at);
    range.setEnd(node!, at + 1);
    const cell = range.getBoundingClientRect();
    const box = (sel: string) => term.querySelector(sel)!.getBoundingClientRect();
    return {
      caret: { x: cell.right, y: row.getBoundingClientRect().top },
      cell: { w: cell.width, h: row.getBoundingClientRect().height },
      view: box('.composition-view'),
      textarea: box('textarea'),
      composing: term.querySelector('.composition-view')!.classList.contains('active'),
    };
  });
}

for (const [agent, bytes, rowsBelow] of [
  ['Claude Code 2.1.310', CLAUDE, 0],
  ['Codex 0.161.0', CODEX, 0],
  ['visible cursor (shell)', 'ab', 0],
  // Not an agent screen: the cursor left hidden two rows below the box. xterm.js 6 puts the composition at the hidden
  // buffer cursor, two rows under the caret. V1A-36 closed with no window fix (real Claude and Codex park the cursor at
  // the caret, the cases above), so today's intended behaviour is xterm's: the composition follows the buffer cursor.
  // Ticket 540 replaced the `test.fail` (a test may not stay expected-to-fail) with this pin of that behaviour; if an
  // agent ever parks its cursor away, the window fix V1A-36 held back is the change, and this case flips to 0.
  ['hidden cursor parked two rows down (synthetic: follows the buffer cursor, V1A-36 no window fix)', CLAUDE + '\x1b[2B\x1b[?25l', 2],
] as const) {
  const where = rowsBelow ? 'sits at the buffer cursor' : 'sits at its caret';
  test(`terminal: composing Hangul at the ${agent} input ${where} and sends nothing`, async ({ app, core, browserName }) => {
    test.skip(browserName !== 'chromium', 'composition needs the CDP IME driver');
    const a = core.replay(core.project('demo'), 'alpha', bytes);
    await openWindow(app);
    // The tty adds CR before each LF (onlcr), so the log is compared with itself, not with `bytes`.
    await expect.poll(() => core.read(a.id).endsWith(bytes.slice(-8))).toBe(true);
    const shown = core.read(a.id);
    await expect.poll(() => terminalText(app, a.id)).toContain('ab');
    await app.locator(`.term[data-session="${a.id}"]`).click();
    const cdp = await app.context().newCDPSession(app);
    await cdp.send('Input.imeSetComposition', { text: '한', selectionStart: 1, selectionEnd: 1 });
    await expect.poll(async () => (await positions(app, a.id)).composing).toBe(true);
    const p = await positions(app, a.id);
    for (const el of [p.view, p.textarea]) {
      expect(Math.abs(el.top - (p.caret.y + rowsBelow * p.cell.h))).toBeLessThan(p.cell.h / 2);
      expect(Math.abs(el.left - p.caret.x)).toBeLessThan(p.cell.w / 2);
    }
    await cdp.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 });
    await app.waitForTimeout(150);
    // An uncommitted then cancelled syllable writes no byte: the PTY log is still exactly the replayed screen.
    expect(core.read(a.id)).toBe(shown);
  });
}
