// Ticket 413: after the terminal pane narrows and widens (a side pane such as Diff opening and closing), the shell's
// prompt is redrawn in place, once. Real core, real zsh with a right prompt.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, openWindow, terminalText, test, type Core } from './fixtures';

/** zsh with a two-line prompt whose first line is filled to the right edge (as starship's $fill draws it), ending in
 *  the part that showed on a second line in the owner's report. A one-line RPROMPT redraws cleanly without the fix.
 *  `marks`: the prompt carries OSC 133 marks (A at its start, B before input, C before a command's output).
 *  'core': the user's files have no marks and zsh is the session's own program, so the core's start file adds them.
 *  'fixed': marks, and the prompt is padded once per command in precmd (oh-my-posh), so a SIGWINCH redraws it at the old width. */
function zsh(core: Core, marks: boolean | 'core' | 'fixed') {
  const dir = marks === 'core' ? path.join(core.home, 'sentinel-home') : path.join(core.home, 'zdot');
  fs.mkdirSync(dir, { recursive: true });
  const prompt = "'left${(l:COLUMNS-13:: :)}at 15:39'$'\\n''%# '";
  const rc = marks === 'fixed'
    ? ["precmd() { PROMPT=$'%{\\e]133;A\\a%}'\"left${(l:COLUMNS-13:: :)}at 15:39\"$'\\n%# %{\\e]133;B\\a%}' }", "preexec() { print -n '\\e]133;C\\a' }"]
    : marks === true
    ? ['setopt promptsubst', `PROMPT=$'%{\\e]133;A\\a%}'${prompt}$'%{\\e]133;B\\a%}'`, "preexec() { print -n '\\e]133;C\\a' }"]
    : ['setopt promptsubst', `PROMPT=${prompt}`];
  fs.writeFileSync(path.join(dir, '.zshrc'), rc.join('\n') + '\n');
  if (marks === 'core') return core.shell(core.project('demo'), 'z', '/bin/zsh', '-i');
  return core.shell(core.project('demo'), 'z', '/usr/bin/env', `ZDOTDIR=${dir}`, '/bin/zsh', '-i');
}

/** Every resize the window sends to the core, in order. */
const recordResizes = (app: Page) =>
  app.addInitScript(() => {
    const w = window as unknown as { __resizes: [number, number][] };
    w.__resizes = [];
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      try {
        const r = JSON.parse(String(data)).request;
        if (r?.op === 'resize') w.__resizes.push([r.cols, r.rows]);
      } catch {
        // Not JSON: not a request.
      }
      return send.call(this, data);
    };
  });
const resizes = (app: Page) => app.evaluate(() => (window as unknown as { __resizes: [number, number][] }).__resizes.slice());
/** The grid xterm shows now: its row count, and its width in cells measured on the 120-cell output row. */
const grid = (app: Page, id: string) =>
  app.evaluate((id) => {
    const term = document.querySelector(`.term[data-session="${id}"]`)!;
    const rows = [...term.querySelectorAll('.xterm-rows > div')];
    const out = rows.find((r) => r.textContent?.startsWith('xxx'))!;
    const range = document.createRange();
    range.selectNodeContents(out);
    const cell = range.getBoundingClientRect().width / out.textContent!.length;
    return { rows: rows.length, cols: Math.round(term.querySelector('.xterm-screen')!.getBoundingClientRect().width / cell) };
  }, id);
/** The screen's rows, trailing blanks trimmed. */
const screen = async (app: Page, id: string) => (await terminalText(app, id)).split('\n').map((l) => l.trimEnd());
/** Rows that show any part of the current prompt: those below the last output row (older prompts above it are output). */
const prompts = (rows: string[]) => rows.slice(rows.findLastIndex((l) => /^(xxx|===)/.test(l)) + 1).filter((l) => /left|at 15:39/.test(l));
const ONE = [expect.stringMatching(/^left +at 15:39$/)];

/** Opens zsh's tab on a clean screen: the session starts at the core's 160 columns, so its first prompt is drawn wider
 *  than the grid (a separate cause); Ctrl+L redraws it at the grid's width. */
async function open(app: Page, core: Core, marks: boolean | 'core') {
  await recordResizes(app);
  const s = zsh(core, marks);
  await openWindow(app);
  await app.locator(`.tab[data-tab="${s.id}"]`).click();
  await expect.poll(() => terminalText(app, s.id)).toContain('at 15:39');
  await expect.poll(async () => (await resizes(app)).length).toBeGreaterThan(0);
  await app.locator(`.term[data-session="${s.id}"]`).click();
  await app.keyboard.press('Control+L');
  await expect.poll(async () => prompts(await screen(app, s.id))).toEqual(ONE);
  return s;
}

/** Runs a command and waits for the next prompt below its output. */
async function run(app: Page, id: string, command: string, shows: string) {
  await app.keyboard.type(`${command}\n`);
  await expect.poll(() => terminalText(app, id)).toContain(shows);
  await expect.poll(async () => prompts(await screen(app, id))).toEqual(ONE);
}

/** Opens and closes Diff three times; each step waits for its resize and for `settled` to hold. */
async function cycles(app: Page, settled: { narrow: () => Promise<void>; wide: () => Promise<void> }) {
  const start = (await resizes(app)).length;
  for (let i = 0; i < 3; i++) {
    await diff(app).click();
    await expect(dock(app)).toBeVisible();
    await expect.poll(async () => (await resizes(app)).length).toBe(start + 2 * i + 1);
    await settled.narrow();
    await diff(app).click();
    await expect(dock(app)).toHaveCount(0);
    await expect.poll(async () => (await resizes(app)).length).toBe(start + 2 * i + 2);
    await settled.wide();
  }
  return (await resizes(app)).slice(start);
}
const diff = (app: Page) => app.getByRole('navigation', { name: 'Right bar' }).getByRole('button', { name: 'Diff', exact: true });
const dock = (app: Page) => app.getByRole('complementary', { name: 'Diff' });

test('terminal_redraw_after_side_pane: with OSC 133 marks, three Diff open/close cycles send only settled sizes and the prompt shows once', async ({ app, core }) => {
  const s = await open(app, core, true);
  // Output wider than the narrow grid is reflowed, never erased.
  await run(app, s.id, 'print -r -- ${(l:120::x:)}', 'x'.repeat(120));
  const before = await screen(app, s.id);
  const wide = (await resizes(app)).at(-1)!;
  const sizes = await cycles(app, {
    // Narrow: the prompt shows once, both parts on one row.
    narrow: () => expect.poll(async () => prompts(await screen(app, s.id))).toEqual(ONE),
    // The shell's redraw has landed once the screen is back to how it was.
    wide: () => expect.poll(() => screen(app, s.id)).toEqual(before),
  });
  // One size per settled layout: narrow, wide, three times, and nothing between.
  const narrow = sizes[0];
  expect(narrow[0]).toBeLessThan(wide[0]);
  expect(sizes).toEqual([narrow, wide, narrow, wide, narrow, wide]);
  const count = (await resizes(app)).length;
  await app.waitForTimeout(300);
  expect(await resizes(app)).toHaveLength(count);
  // The PTY's own size is the visible grid.
  const g = await grid(app, s.id);
  expect(wide).toEqual([g.cols, g.rows]);
  await app.locator(`.term[data-session="${s.id}"]`).click();
  await app.keyboard.type('stty size\n');
  await expect.poll(() => terminalText(app, s.id)).toContain(`${g.rows} ${g.cols}`);
});

test('terminal_redraw_after_side_pane: full-width output right above a marked prompt keeps all its text', async ({ app, core }) => {
  const s = await open(app, core, true);
  await run(app, s.id, 'print -r -- ${(l:COLUMNS::=:)}', '=====');
  const before = await screen(app, s.id);
  const cols = (await resizes(app)).at(-1)![0];
  const rule = before.findLastIndex((l) => l.startsWith('==='));
  expect(before[rule]).toBe('='.repeat(cols));
  expect(before[rule + 1]).toMatch(/^left +at 15:39$/); // directly above the prompt
  await cycles(app, {
    narrow: () => expect.poll(async () => prompts(await screen(app, s.id))).toEqual(ONE),
    wide: () => expect.poll(() => screen(app, s.id)).toEqual(before),
  });
  expect((await screen(app, s.id))[rule]).toBe('='.repeat(cols));
});

// Look 1117 v11 A S2-1: oh-my-posh pads its prompt once for the wide pane. Narrowed, zsh redraws that string and it wraps
// to two rows; widened, reflow joined them under zsh, which moved up by the rows it drew and redrew over the output line
// above (one line lost per split or sidebar open/close). The prompt is erased before any width change now.
test('terminal_redraw_wrapped_prompt: a prompt padded for the wide pane wraps when narrow, and widening keeps the output above it', async ({ app, core }) => {
  await recordResizes(app);
  const s = zsh(core, 'fixed');
  await openWindow(app);
  await app.locator(`.tab[data-tab="${s.id}"]`).click();
  await expect.poll(() => terminalText(app, s.id)).toContain('at 15:39');
  await expect.poll(async () => (await resizes(app)).length).toBeGreaterThan(0);
  await app.locator(`.term[data-session="${s.id}"]`).click();
  // `clear` runs precmd again: the prompt is padded for the grid's width. `$c` keeps the typed line from matching.
  await run(app, s.id, 'c=CCC; clear; print -l "===AAA" "===BBB" "===$c"', '===CCC');
  const before = await screen(app, s.id);
  await cycles(app, {
    // Narrow: the wide prompt shows on two rows (the case of the finding).
    narrow: () => expect.poll(async () => prompts(await screen(app, s.id))).toEqual(['left', expect.stringMatching(/^ +at 15:39$/)]),
    wide: () => expect.poll(() => screen(app, s.id)).toEqual(before),
  });
  expect(before.filter((l) => l.startsWith('==='))).toEqual(['===AAA', '===BBB', '===CCC']);
});

// Look 1117 v12 A S2-A: the same pane after a reopen. The replay held zsh's redraws for both widths and drew them at one,
// so their moves up erased one output line per cycle. The holder marks each size change in the output; the replay draws at each size.
test('terminal_replay_after_resizes: a reopened window replays a pane that was narrowed and widened with all its output lines', async ({ app, core }) => {
  await recordResizes(app);
  const s = zsh(core, 'fixed');
  await openWindow(app);
  await app.locator(`.tab[data-tab="${s.id}"]`).click();
  await expect.poll(() => terminalText(app, s.id)).toContain('at 15:39');
  await expect.poll(async () => (await resizes(app)).length).toBeGreaterThan(0);
  await app.locator(`.term[data-session="${s.id}"]`).click();
  await run(app, s.id, 'c=CCC; clear; print -l "===AAA" "===BBB" "===$c" "===DDD"', '===DDD');
  const before = await screen(app, s.id);
  await cycles(app, {
    narrow: () => expect.poll(async () => prompts(await screen(app, s.id))).toEqual(['left', expect.stringMatching(/^ +at 15:39$/)]),
    wide: () => expect.poll(() => screen(app, s.id)).toEqual(before),
  });
  await app.reload();
  await app.locator(`.tab[data-tab="${s.id}"]`).click();
  await expect.poll(() => terminalText(app, s.id)).toContain('at 15:39');
  await expect.poll(async () => (await screen(app, s.id)).filter((l) => l.startsWith('==='))).toEqual(['===AAA', '===BBB', '===CCC', '===DDD']);
  expect(prompts(await screen(app, s.id))).toEqual(ONE);
});

// Codex look of wave 19 (MUST): a program can print the size mark itself; a size no window has is never applied.
test('terminal_replay_ignores_a_huge_size_mark: output that carries CSI 8;1000000;1000000t replays at a sane size', async ({ app, core }) => {
  const s = core.shell(core.project('demo'), 'huge', '/bin/sh', '-c', "printf 'before\\n\\033[8;1000000;1000000tafter\\n'; exec cat");
  await openWindow(app);
  await app.locator(`.tab[data-tab="${s.id}"]`).click();
  await expect.poll(() => terminalText(app, s.id)).toContain('after');
  await app.reload();
  await app.locator(`.tab[data-tab="${s.id}"]`).click();
  await expect.poll(() => terminalText(app, s.id)).toContain('after');
  const size = await app.locator(`.term[data-session="${s.id}"] .xterm-rows`).evaluate((el) => el.children.length);
  expect(size).toBeLessThan(500);
});

// Ticket 991 (fifth look): a user's prompt (oh-my-posh, powerlevel10k) sends no marks of its own; the core's zsh start
// file adds them, so the same prompt as in the test below shows once.
test('terminal_redraw_core_marks: zsh started as the program of the session gets its marks from the core and its prompt shows once', async ({ app, core }) => {
  const s = await open(app, core, 'core');
  await run(app, s.id, 'print -r -- ${(l:120::x:)}', 'x'.repeat(120));
  const before = await screen(app, s.id);
  await cycles(app, {
    narrow: () => expect.poll(async () => prompts(await screen(app, s.id))).toEqual(ONE),
    wide: () => expect.poll(() => screen(app, s.id)).toEqual(before),
  });
  // The user's own start files were read from the user's folder: ZDOTDIR is theirs again (unset here).
  await app.locator(`.term[data-session="${s.id}"]`).click();
  await run(app, s.id, 'print "=== zd=[${ZDOTDIR-none}]"', '=== zd=[none]');
});

test('terminal_redraw_after_side_pane: without OSC 133 marks nothing is erased (the fit is as before)', async ({ app, core }) => {
  const s = await open(app, core, false);
  const wait = () => app.waitForTimeout(400); // nothing to wait for: zsh's redraw lands within it
  await cycles(app, { narrow: wait, wide: wait });
  // What main shows: each narrowing leaves the first half of the reflowed prompt row above the redrawn prompt.
  expect(prompts(await screen(app, s.id))).toEqual(['left', 'left', 'left', ...ONE]);
});

// Ticket 991 A11: zsh's PROMPT_SP mark ("%" and a row of spaces, then a carriage return) fills the row it was drawn at.
// The session starts at the core's 160 columns, wider than the window's grid: replayed at the grid's width, the spaces
// wrapped and left the inverted "%" on a row of its own above the prompt. Replayed wide enough, the shell's own erase holds.
test('terminal_replay_no_prompt_sp_mark_A11: a reopened window replays a wider prompt without a stray % row', async ({ app, core }) => {
  const dir = path.join(core.home, 'zdot');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.zshrc'), "PROMPT='ready%# '\n");
  const s = core.shell(core.project('demo'), 'z', '/usr/bin/env', `ZDOTDIR=${dir}`, '/bin/zsh', '-i');
  await openWindow(app);
  await app.locator(`.tab[data-tab="${s.id}"]`).click();
  await expect.poll(() => terminalText(app, s.id)).toContain('ready');
  await app.reload();
  await app.locator(`.tab[data-tab="${s.id}"]`).click();
  await expect.poll(() => terminalText(app, s.id)).toContain('ready');
  expect((await screen(app, s.id)).filter((l) => l.trim() === '%')).toEqual([]);
});

// Decisions pane race (nightly sweep, decisions-widget 5cec57a13): beside an agent's chat the side terminal's box passes
// through a shorter size for part of one frame when the Decisions sidebar opens (the composer card, still as wide as the
// old chat column allowed, wraps its chips until SidePane's --pane-room is set again), and each size was sent to the PTY:
// 47x42 then 47x46, two SIGWINCH, so an agent's prompt was re-filed under a new id between two clicks. One size per
// settled layout, as for Diff above.
test('terminal_one_size_per_settled_layout_decisions: the Decisions sidebar opening and closing beside a side terminal sends one size each', async ({ app, core }) => {
  await recordResizes(app);
  const a = core.agent(core.project('demo'), 'a', 'x');
  await openWindow(app);
  await app.locator(`.tab[data-tab="${a.id}"]`).click();
  const bar = app.getByRole('navigation', { name: 'Right bar' });
  const term = app.locator(`.spane .term[data-session="${a.id}"]`);
  if (!(await term.isVisible())) await bar.getByRole('button', { name: 'Terminal', exact: true }).click();
  await expect(term).toBeVisible();
  /** Holds once no resize was sent for 400 ms; gives them all. */
  const quiet = async () => {
    let n = -1;
    await expect.poll(async () => { const was = n; n = (await resizes(app)).length; return n > 0 && n === was; }, { intervals: [400] }).toBe(true);
    return resizes(app);
  };
  const before = await quiet();
  const wide = before.at(-1)!;
  // The card is beside the pane here (the case with the passing size); under it there is none.
  expect(await app.evaluate(() => parseInt(getComputedStyle(document.documentElement).getPropertyValue('--pane-room')))).toBeGreaterThan(0);
  const decisions = bar.getByRole('button', { name: 'Decisions', exact: true });
  await decisions.click();
  await expect(app.locator('aside.sbar[data-side="right"]')).toHaveAttribute('data-widget', 'decisions');
  await expect.poll(async () => (await resizes(app)).length).toBeGreaterThan(before.length);
  const opened = (await quiet()).slice(before.length);
  expect(opened).toHaveLength(1);
  expect(opened[0][0]).toBeLessThan(wide[0]);
  await decisions.click();
  await expect(app.locator('aside.sbar[data-side="right"]')).toHaveCount(0);
  await expect.poll(async () => (await resizes(app)).length).toBeGreaterThan(before.length + 1);
  expect((await quiet()).slice(before.length + 1)).toEqual([wide]);
});

// Look 1117 v11 A S3-13: an ended shell's read-only view has no shell to redraw its prompt, so a split or side pane
// opening and closing reflows it and erases nothing.
test('terminal_ended_shell_keeps_its_prompt: a closed shell read-only view keeps the prompt through Diff open/close cycles', async ({ app, core }) => {
  const s = await open(app, core, true);
  await run(app, s.id, 'c=DONE; print -r -- "===$c"', '===DONE');
  core.windowClose(s.id); // ticket 1013 F6: the window's own Close keeps the done tab
  const ro = app.locator(`.roterm .term[data-session="${s.id}"]`);
  await expect(ro).toBeVisible();
  await expect.poll(async () => prompts(await screen(app, s.id))).toEqual(ONE);
  for (let i = 0; i < 2; i++) {
    await diff(app).click();
    await expect(dock(app)).toBeVisible();
    await diff(app).click();
    await expect(dock(app)).toHaveCount(0);
  }
  await app.waitForTimeout(300); // the fit runs on the next frame after the box settles
  expect(prompts(await screen(app, s.id))).toEqual(ONE);
  expect(await screen(app, s.id)).toContain('===DONE');
});

// Ticket 995 (v12-C-V10): an idle shell's tab opened for the first time, after another terminal (so it parses its replay
// before it opens). Its prompt was drawn at the PTY's start width (160 columns) and the tab is narrower: the open fit
// split the prompt's first row in two and the shell's redraw for the tab's size landed below the first half. A shell
// whose redraw comes late, as zsh's usually does, after the replay; no Ctrl+L (`open` above uses one).
test('terminal_first_open_of_an_idle_shell: a prompt drawn at the start width shows once in a narrower tab', async ({ app, core }) => {
  // zsh's way: a marked two-line prompt filled to the width; on SIGWINCH, up to its first row, erase down, draw again.
  const draw = `draw() { set -- $(stty size); printf '\\033]133;A\\007left%*sat 15:39\\r\\n%% \\033]133;B\\007' $(($2 - 13)) ''; }`;
  const sh = `${draw}; trap 'sleep 0.3; printf "\\r\\033[A\\033[J"; draw' WINCH; draw; while :; do sleep 1 & wait $!; done`;
  const other = core.shell(core.project('demo'), 'c');
  const s = core.shell(core.project('demo'), 'z', '/bin/sh', '-c', sh);
  await expect.poll(() => core.read(s.id)).toContain('at 15:39'); // idle at its prompt before any window looks
  await recordResizes(app);
  await openWindow(app);
  await app.locator(`.tab[data-tab="${other.id}"]`).click();
  await expect(app.locator(`.term[data-session="${other.id}"] .xterm-rows`)).toBeVisible();
  await app.locator(`.tab[data-tab="${s.id}"]`).click();
  await expect.poll(() => terminalText(app, s.id)).toContain('at 15:39');
  await expect.poll(async () => (await resizes(app)).length).toBeGreaterThan(0);
  expect((await resizes(app)).at(-1)![0]).toBeLessThan(160); // the case: a tab narrower than the start width
  await app.waitForTimeout(1000); // the shell's redraw for the tab's size lands within it
  expect(prompts(await screen(app, s.id))).toEqual(ONE);
});
