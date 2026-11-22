// Look 1117 v4f A S2-2: a terminal opened in a split draws its prompt once. Real core, real zsh whose prompt fills the
// row (as starship's $fill does): a terminal that opens at a size other than its final one reflows that row and the
// shell's redraw leaves a second copy above it.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, openWindow, terminalText, test, type Core } from './fixtures';

/** The core's shells are zsh with a filled one-line prompt, then a second line ("%# "). `slow`: its start files take a
 *  while, as a real set-up's do. */
async function zshCore(core: Core, app: Page, slow: boolean) {
  const dir = path.join(core.home, 'zdot');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.zshrc'), [slow ? 'sleep 0.3' : '', 'setopt promptsubst', "PROMPT='left${(l:COLUMNS-13:: :)}at 15:39'$'\\n''%# '"].join('\n') + '\n');
  core.run(['serve', 'stop', '--yes']);
  core.env.SHELL = '/bin/zsh';
  core.env.ZDOTDIR = dir;
  await core.restart();
  // A fresh core writes a fresh window token: the window opens with it.
  await app.addInitScript((boot) => (window.__NUNCHIRO__ = boot), core.boot());
}

/** Records the sizes the window sends. `lateWatch`: a watch of any session but the first goes out that many ms late. */
const recordResizes = (app: Page, lateWatch: number) =>
  app.addInitScript((lateWatch) => {
    const w = window as unknown as { __resizes: { id: string; cols: number; rows: number }[] };
    w.__resizes = [];
    let first: string | undefined;
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      try {
        const frame = JSON.parse(String(data));
        const r = frame.request;
        if (r?.op === 'resize') w.__resizes.push({ id: r.id, cols: r.cols, rows: r.rows });
        if (frame.watch && lateWatch && frame.watch !== (first ??= frame.watch)) return void setTimeout(() => send.call(this, data), lateWatch);
      } catch {
        // Not JSON: not a request.
      }
      return send.call(this, data);
    };
  }, lateWatch);
const resizes = (app: Page, id: string) => app.evaluate((id) => (window as unknown as { __resizes: { id: string; cols: number; rows: number }[] }).__resizes.filter((r) => r.id === id).map((r) => [r.cols, r.rows]), id);
const prompts = async (app: Page, id: string) => (await terminalText(app, id)).split('\n').map((l) => l.trimEnd()).filter((l) => /left|at 15:39/.test(l));

// Lane w74: the shell's first prompt and the window's watch race, so each order is made sure of. Window first: the replay
// is empty, and an empty replay never reached the terminal, which waits for its replay to open and to tell the PTY its
// size (both then came a second late, REPLAY_WAIT_MS, after the prompt was drawn at the tab's width). Shell first: the
// prompt drawn at the tab's width is in the replay (ticket 995's case, in a split).
// Not covered: a size that lands in the very milliseconds the shell draws its first prompt in (zsh then draws at the old
// width into the new grid); with neither side slowed that was 1 of 30 runs in WebKit after the fix.
for (const order of ['window first', 'shell first'] as const) test(`split_terminal_draws_its_prompt_once, ${order} (look 1117 v4f A S2-2)`, async ({ app, core }) => {
  await zshCore(core, app, order === 'window first');
  const first = core.cli('session', 'start', '--kind', 'shell', '--project', core.project('demo'), '--label', 'one').session as { id: string };
  await recordResizes(app, order === 'shell first' ? 300 : 0);
  await openWindow(app, {}, core);
  await app.locator(`.tab[data-tab="${first.id}"]`).click();
  await expect.poll(() => terminalText(app, first.id)).toContain('at 15:39');
  await app.locator(`.term[data-session="${first.id}"]`).click();
  await app.keyboard.press('Meta+KeyD');
  await app.getByRole('listbox', { name: 'Open in this split' }).getByRole('option', { name: /^Terminal new shell/ }).click();
  const term = app.locator('[data-split-id] .term[data-session]');
  await expect(term).toBeVisible();
  const id = (await term.getAttribute('data-session'))!;
  await expect.poll(() => terminalText(app, id)).toContain('at 15:39');
  await app.waitForTimeout(800); // the shell's redraw after the last resize lands within it
  // The PTY was told one width, the split's (its rows may change after, as the layout settles around the focused shell).
  expect(new Set((await resizes(app, id)).map((r) => r[0])).size).toBe(1);
  expect(await prompts(app, id)).toEqual([expect.stringMatching(/^left +at 15:39$/)]);
});
