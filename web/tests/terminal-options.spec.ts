// Ticket 251 (needs 197 G01, G02): Settings > Terminal, Input and Look. Each value reaches the open terminal without a
// restart; the checks read what the user sees or what the PTY gets (bytes over the socket, the tty's echo), never xterm's
// own state. Real core; `cat` echoes what the window sends.
import type { Page } from '@playwright/test';
import { cleanPrefs, cursorTheme, optionIsMeta, TERM_DEFAULTS, XTERM_WORD_SEPARATORS, xtermOptions, type TermPrefs } from '../src/terminal/options';
import { expect, grantClipboard, openWindow, terminalText, test, type Core } from './fixtures';

const KEY = 'nunchiro.settings.v1';
/** Stored before the window loads, as a value set in an earlier run. */
const seed = (app: Page, patch: Partial<TermPrefs>) =>
  app.addInitScript(
    ([k, p]) => localStorage.setItem(k, JSON.stringify({ ...JSON.parse(localStorage.getItem(k) ?? '{}'), features: { 'terminal.options': p } })),
    [KEY, { ...TERM_DEFAULTS, ...patch }] as const,
  );
/** Every request this window sends over the core socket (splits.spec.ts). */
const record = (app: Page) =>
  app.addInitScript(() => {
    const w = window as unknown as { __sent: { op: string; id?: string; text?: string }[] };
    w.__sent = [];
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      try {
        const r = typeof data === 'string' ? JSON.parse(data).request : null;
        if (r) w.__sent.push(r);
      } catch {
        // Not JSON: not ours.
      }
      return send.call(this, data);
    };
  });
const typed = (app: Page, id: string) =>
  app.evaluate((s) => (window as unknown as { __sent: { op: string; id?: string; text?: string }[] }).__sent.filter((r) => r.op === 'send_text' && r.id === s).map((r) => r.text ?? ''), id);

const term = (app: Page, id: string) => app.locator(`.term[data-session="${id}"]`);
const pty = (app: Page, id: string) => term(app, id).locator('.xterm-helper-textarea');
const tab = (app: Page, id: string) => app.locator(`.tab[data-tab="${id}"]`);
async function show(app: Page, id: string) {
  if (await app.locator('.ovl').count()) await app.keyboard.press('Escape'); // v25f: Settings is a modal over the tabs
  await tab(app, id).click();
  await expect(term(app, id).locator('.xterm-screen')).toBeVisible();
}
async function terminalPage(app: Page) {
  await app.keyboard.press('Meta+Comma');
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Terminal', exact: true }).click();
  await expect(app.getByRole('heading', { name: 'Input', exact: true })).toBeVisible();
  // Ticket 391: the rows past the everyday ones sit in each card's closed Advanced fold.
  const closed = app.locator('details.term-more:not([open]) > summary');
  while (await closed.count()) await closed.first().click();
}
const shell = (core: Core, label: string, script: string) => core.shell(core.project('demo'), label, '/bin/sh', '-c', `${script}; exec cat`);
const topLine = async (app: Page, id: string) => Number(/line (\d+)/.exec(await terminalText(app, id))?.[1]);

test('terminal_options_unit: the prefs map to xterm options; a broken field reads as its default, the rest stay', () => {
  // Today's look and bytes are the defaults.
  expect(xtermOptions(TERM_DEFAULTS)).toEqual({
    scrollSensitivity: 1,
    fastScrollSensitivity: 5,
    rightClickSelectsWord: true,
    wordSeparator: XTERM_WORD_SEPARATORS,
    macOptionIsMeta: false,
    cursorStyle: 'block',
    cursorInactiveStyle: 'outline',
    cursorBlink: false,
    fontWeight: 400,
    fontWeightBold: 700,
    scrollback: 5000,
  });
  expect(xtermOptions({ ...TERM_DEFAULTS, cursor: 'bar', rightClickPaste: true })).toMatchObject({ cursorStyle: 'bar', cursorInactiveStyle: 'bar', rightClickSelectsWord: false });
  for (const [mode, left, right] of [['auto', false, false], ['off', false, false], ['on', true, true], ['left', true, false], ['right', false, true]] as const) {
    expect([optionIsMeta(mode, 'left'), optionIsMeta(mode, 'right')], mode).toEqual([left, right]);
  }
  expect(cleanPrefs({ ...TERM_DEFAULTS, scroll: 3, cursor: 'triangle', fontWeight: 450, scrollback: 999, padLeft: -1, gpu: 'yes', wordSeparators: ' .' })).toEqual({ ...TERM_DEFAULTS, scroll: 3, wordSeparators: ' .' });
  expect(cleanPrefs([])).toBeUndefined();
  expect(cleanPrefs({})).toEqual(TERM_DEFAULTS);
  expect(cursorTheme({ cursor: '#1f2328' }, 0.5).cursor).toBe('#1f232880');
  expect(cursorTheme({ cursor: '#fff' }, 0.25).cursor).toBe('#ffffff40');
  expect(cursorTheme({ cursor: '#1f2328' }, 1).cursor).toBe('#1f2328');
});

test('terminal_scroll_speed_reaches_open_terminal', async ({ app, core }) => {
  const a = shell(core, 'lines', 'seq 1 400 | sed "s/^/line /"');
  const tui = shell(core, 'tui', "printf '\\033[?1000h\\033[?1006h'");
  await openWindow(app);
  await show(app, a.id);
  await expect.poll(() => terminalText(app, a.id)).toContain('line 400');
  const box = (await term(app, a.id).boundingBox())!;
  await app.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const bottom = await topLine(app, a.id);
  await app.mouse.wheel(0, -120);
  await expect.poll(() => topLine(app, a.id)).toBeLessThan(bottom);
  const d1 = bottom - (await topLine(app, a.id));

  // Settings while the terminal stays open behind its tab.
  await terminalPage(app);
  await app.getByRole('spinbutton', { name: 'Scroll speed', exact: true }).fill('3');
  await app.getByRole('spinbutton', { name: 'Scroll speed in full-screen apps' }).fill('3');
  await show(app, a.id);
  await app.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await app.mouse.wheel(0, 20_000);
  await expect.poll(() => topLine(app, a.id)).toBe(bottom);
  await app.mouse.wheel(0, -120);
  await expect.poll(async () => bottom - (await topLine(app, a.id))).toBeGreaterThanOrEqual(Math.max(2, d1 * 2));

  // A full-screen app that tracks the mouse gets three wheel reports per notch (SGR 1006: ESC [ < 64 ; …).
  await show(app, tui.id);
  await expect(term(app, tui.id).locator('.xterm.enable-mouse-events')).toHaveCount(1);
  const t = (await term(app, tui.id).boundingBox())!;
  await app.mouse.move(t.x + t.width / 2, t.y + t.height / 2);
  await app.mouse.wheel(0, -120);
  await expect.poll(() => core.read(tui.id).split('[<64;').length - 1).toBe(3);
});

test('terminal_right_click_pastes_when_on', async ({ app, core }) => {
  const a = shell(core, 'paste', 'true');
  await grantClipboard(app);
  await openWindow(app);
  await show(app, a.id);
  await app.evaluate(() => navigator.clipboard.writeText('pasted-by-right-click'));
  await term(app, a.id).locator('.xterm-screen').click({ button: 'right' });
  await app.waitForTimeout(300);
  expect(core.read(a.id)).not.toContain('pasted-by-right-click');

  await terminalPage(app);
  await app.getByRole('switch', { name: 'Right-click pastes' }).check();
  await show(app, a.id);
  await term(app, a.id).locator('.xterm-screen').click({ button: 'right' });
  await expect.poll(() => core.read(a.id)).toContain('pasted-by-right-click');
});

test('terminal_focus_follows_mouse_between_panes', async ({ app, core }) => {
  const a = shell(core, 'left', 'true');
  await seed(app, { focusFollowsMouse: true });
  await openWindow(app);
  await show(app, a.id);
  await pty(app, a.id).focus();
  await app.keyboard.press('Meta+KeyD');
  const chooser = app.getByRole('listbox', { name: 'Open in this split' });
  await chooser.getByRole('option', { name: /^Terminal new shell/ }).click();
  const split = app.locator('[data-split-id] .term');
  await expect(split.locator('.xterm-screen')).toBeVisible();
  const other = split.locator('.xterm-helper-textarea');
  await pty(app, a.id).focus();

  const over = async (l: ReturnType<Page['locator']>) => {
    const b = (await l.boundingBox())!;
    await app.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 3 });
  };
  await over(split);
  await expect(other).toBeFocused();
  await over(term(app, a.id));
  await expect(pty(app, a.id)).toBeFocused();
  // A held button (a selection drag) never moves focus.
  await app.mouse.down();
  await over(split);
  await expect(pty(app, a.id)).toBeFocused();
  await app.mouse.up();
});

test('terminal_focus_follows_mouse_never_takes_focus_from_a_text_field', async ({ app, core }) => {
  const a = shell(core, 'keep', 'true');
  await record(app);
  await seed(app, { focusFollowsMouse: true });
  await openWindow(app);
  await show(app, a.id);
  // Any text field outside a terminal (the Composer, a search box): focus moves only from one terminal to another.
  await app.evaluate(() => document.body.prepend(Object.assign(document.createElement('input'), { id: 'ffm-probe' })));
  const input = app.locator('#ffm-probe');
  await input.focus();
  const b = (await term(app, a.id).boundingBox())!;
  await app.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 3 });
  await app.keyboard.type('stays');
  await expect(input).toBeFocused();
  await expect(input).toHaveValue(/stays/);
  expect((await typed(app, a.id)).join('')).not.toContain('stays');
});

test('terminal_word_separators_change_double_click_selection', async ({ app, core }) => {
  const a = shell(core, 'words', 'echo alpha.beta-gamma');
  await grantClipboard(app);
  await openWindow(app);
  await show(app, a.id);
  await expect.poll(() => terminalText(app, a.id)).toContain('alpha.beta-gamma');
  const beta = async () =>
    term(app, a.id).evaluate((el) => {
      const walk = document.createTreeWalker(el.querySelector('.xterm-rows')!, NodeFilter.SHOW_TEXT);
      for (let n = walk.nextNode(); n; n = walk.nextNode()) {
        const i = n.textContent!.indexOf('beta-');
        if (i < 0) continue;
        const r = document.createRange();
        r.setStart(n, i + 1);
        r.setEnd(n, i + 2);
        const b = r.getBoundingClientRect();
        return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
      }
      throw new Error('no beta');
    });
  const pick = async () => {
    const p = await beta();
    await app.mouse.dblclick(p.x, p.y);
    return app.evaluate(() => navigator.clipboard.readText());
  };
  // xterm's own separators keep . and - inside a word (copy on select copies the double-click).
  await expect.poll(pick).toBe('alpha.beta-gamma');

  await terminalPage(app);
  await app.getByRole('textbox', { name: 'Word separators' }).fill(' .-');
  await show(app, a.id);
  await expect.poll(pick).toBe('beta');
});

test('terminal_option_as_meta_sends_esc_prefix', async ({ app, core }) => {
  const a = shell(core, 'meta', 'true');
  await record(app);
  await openWindow(app);
  await show(app, a.id);
  const press = async (side: 'AltLeft' | 'AltRight') => {
    await pty(app, a.id).focus();
    await app.keyboard.down(side);
    await app.keyboard.press('KeyB');
    await app.keyboard.up(side);
  };
  // Auto (the default) and Off: Option stays macOS's, no ESC prefix reaches the PTY.
  await press('AltLeft');
  await press('AltRight');
  await app.waitForTimeout(300);
  expect((await typed(app, a.id)).join('')).not.toContain('\x1b');

  const mode = async (label: string) => {
    await terminalPage(app);
    await app.getByRole('radiogroup', { name: 'Option as Meta' }).getByRole('radio', { name: label, exact: true }).check();
    await show(app, a.id);
  };
  await mode('Off');
  await press('AltLeft');
  await app.waitForTimeout(300);
  expect((await typed(app, a.id)).join('')).not.toContain('\x1b');

  await mode('On');
  await press('AltLeft');
  await expect.poll(async () => (await typed(app, a.id)).filter((t) => t === '\x1bb').length).toBe(1);
  await press('AltRight');
  await expect.poll(async () => (await typed(app, a.id)).filter((t) => t === '\x1bb').length).toBe(2);

  // Left: the right Option key keeps composing.
  await mode('Left');
  await press('AltRight');
  await app.waitForTimeout(300);
  expect((await typed(app, a.id)).filter((t) => t === '\x1bb')).toHaveLength(2);
  await press('AltLeft');
  await expect.poll(async () => (await typed(app, a.id)).filter((t) => t === '\x1bb').length).toBe(3);
});

test('terminal_hides_pointer_while_typing_and_shows_on_move', async ({ app, core }) => {
  const a = shell(core, 'pointer', 'true');
  await openWindow(app);
  await show(app, a.id);
  const screen = term(app, a.id).locator('.xterm-screen');
  const cursor = () => screen.evaluate((el) => getComputedStyle(el).cursor);
  const b = (await screen.boundingBox())!;
  await app.mouse.move(b.x + 40, b.y + 40);
  await pty(app, a.id).focus();
  await app.keyboard.type('x');
  expect(await cursor()).toBe('text'); // off by default

  await terminalPage(app);
  await app.getByRole('switch', { name: 'Hide the pointer while typing' }).check();
  await show(app, a.id);
  await pty(app, a.id).focus();
  await app.keyboard.type('y');
  await expect.poll(cursor).toBe('none');
  await app.mouse.move(b.x + 60, b.y + 50);
  await expect.poll(cursor).toBe('text');
});

test('terminal_cursor_shape_blink_and_opacity_apply', async ({ app, core }) => {
  const a = shell(core, 'cursor', 'true');
  await openWindow(app);
  await show(app, a.id);
  const rows = term(app, a.id).locator('.xterm-rows');
  await pty(app, a.id).focus();
  await expect(rows.locator('.xterm-cursor.xterm-cursor-block')).toHaveCount(1);
  await expect(rows.locator('.xterm-cursor-blink')).toHaveCount(0);
  const rgb = (c: string) => (c.startsWith('#') ? [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16)) : (c.match(/\d+/g) ?? []).slice(0, 3).map(Number));
  const drawn = () => term(app, a.id).evaluate((el) => /blink_block_\d+ \{ 0% \{\s*background-color: (#[0-9a-f]{6})/i.exec([...el.querySelectorAll('style')].map((s) => s.textContent).join('\n'))?.[1] ?? '');
  const full = rgb(await drawn());
  const bg = rgb(await term(app, a.id).evaluate((el) => getComputedStyle(el).backgroundColor)); // the theme's background is the pane's

  await terminalPage(app);
  await app.getByRole('radiogroup', { name: 'Cursor shape' }).getByRole('radio', { name: 'Bar' }).check();
  await app.getByRole('switch', { name: 'Blinking cursor' }).check();
  await app.getByRole('spinbutton', { name: 'Cursor opacity' }).fill('0.5');
  await show(app, a.id);
  await pty(app, a.id).focus();
  await expect(rows.locator('.xterm-cursor.xterm-cursor-bar.xterm-cursor-blink')).toHaveCount(1);
  // xterm draws a translucent cursor blended over the background: half way between the full cursor and the background.
  await expect.poll(async () => rgb(await drawn()).map((c, i) => Math.abs(c - (full[i] + bg[i]) / 2) <= 1)).toEqual([true, true, true]);
  expect(rgb(await drawn())).not.toEqual(full);
});

test('terminal_font_weights_and_padding_apply', async ({ app, core }) => {
  const a = shell(core, 'weights', "printf 'plain \\033[1mBOLD\\033[0m\\n'");
  await openWindow(app);
  await show(app, a.id);
  await expect.poll(() => terminalText(app, a.id)).toContain('BOLD');
  const box = term(app, a.id);
  const style = () =>
    box.evaluate((el) => {
      const weight = (sel: string) => {
        const span = el.querySelector(sel);
        return span ? getComputedStyle(span).fontWeight : null;
      };
      return { pad: [getComputedStyle(el).paddingLeft, getComputedStyle(el).paddingTop], plain: weight('.xterm-rows span:not(.xterm-bold)'), bold: weight('.xterm-rows span.xterm-bold') };
    });
  // Today's look: 10 px left, 6 px top, regular and bold.
  await expect.poll(style).toEqual({ pad: ['10px', '6px'], plain: '400', bold: '700' });

  await terminalPage(app);
  await app.getByRole('spinbutton', { name: 'Text weight', exact: true }).fill('300');
  await app.getByRole('spinbutton', { name: 'Bold text weight' }).fill('800');
  await app.getByRole('spinbutton', { name: 'Left padding' }).fill('20');
  await app.getByRole('spinbutton', { name: 'Top padding' }).fill('12');
  await show(app, a.id);
  await expect.poll(style).toEqual({ pad: ['20px', '12px'], plain: '300', bold: '800' });
});

test('terminal_webgl_toggle_falls_back_to_dom_on_context_loss', async ({ app, core }) => {
  const a = shell(core, 'gpu', 'echo drawn-by-gpu');
  await openWindow(app);
  await show(app, a.id);
  await expect(term(app, a.id)).toHaveAttribute('data-renderer', 'dom');

  await terminalPage(app);
  await app.getByRole('switch', { name: 'GPU rendering' }).check();
  await show(app, a.id);
  await expect(term(app, a.id)).toHaveAttribute('data-renderer', 'webgl');
  await expect(term(app, a.id).locator('.xterm-screen canvas')).not.toHaveCount(0);
  // A lost context (a GPU reset) waits for a restore, then drops the addon: the DOM renderer draws the same screen.
  await term(app, a.id).evaluate((el) => {
    for (const c of el.querySelectorAll('.xterm-screen canvas')) (c as HTMLCanvasElement).getContext('webgl2')?.getExtension('WEBGL_lose_context')?.loseContext();
  });
  await expect(term(app, a.id)).toHaveAttribute('data-renderer', 'dom', { timeout: 10_000 });
  await expect.poll(() => terminalText(app, a.id)).toContain('drawn-by-gpu');
});

test('terminal_rows_on_terminal_page_and_searchable', async ({ app, core }) => {
  shell(core, 'rows', 'true');
  await openWindow(app);
  await terminalPage(app);
  // After the page's own font and clipboard cards, in this order.
  const headings = await app.locator('.settings[role="region"] section.ssec > h2').allInnerTexts();
  expect(headings.slice(-2)).toEqual(['Input', 'Appearance']);
  const labels = {
    // Ticket 391: Scroll speed and Option as Meta first, the rest in the fold.
    Input: ['Scroll speed', 'Option as Meta', 'Fast scroll speed', 'Scroll speed in full-screen apps', 'Right-click pastes', 'Focus follows the mouse', 'Word separators', 'Hide the pointer while typing'],
    Appearance: ['Cursor shape', 'Blinking cursor', 'Cursor opacity', 'Text weight', 'Bold text weight', 'Ligatures', 'Left padding', 'Top padding', 'GPU rendering'],
  };
  for (const [section, names] of Object.entries(labels)) {
    const card = app.getByRole('region', { name: section, exact: true });
    await expect(card.locator('.srow .snm')).toHaveText(names);
  }
  // Every row is found by the settings search and focused from it.
  const search = app.getByRole('searchbox', { name: 'Search settings' });
  for (const name of Object.values(labels).flat()) {
    await search.fill(name);
    await app.getByRole('list', { name: 'Matching settings' }).getByRole('button', { name: `${name} · Terminal`, exact: true }).click();
    await expect.poll(() => app.evaluate(() => document.activeElement?.closest('[data-row]')?.querySelector('.snm')?.textContent)).toBe(name);
  }
});

test('terminal_scrollback_setting: 5,000 lines by default, a typed count applies to the open terminal, an out-of-range one is held back', async ({ app, core }) => {
  const a = shell(core, 'alpha', 'i=1; while [ $i -le 3000 ]; do echo "line $i"; i=$((i+1)); done');
  await seed(app, { scroll: 10 });
  await openWindow(app);
  await show(app, a.id);
  await expect.poll(() => terminalText(app, a.id)).toContain('line 3000');
  const toTop = async () => {
    const box = (await term(app, a.id).boundingBox())!;
    await app.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let i = 0; i < 120; i++) await app.mouse.wheel(0, -3000); // a tick moves a few lines, times the seeded speed
  };
  await toTop();
  await expect.poll(() => topLine(app, a.id)).toBe(1); // more than the old fixed 2000
  await terminalPage(app);
  const field = app.locator('[data-setting="scrollback"]');
  await expect(field).toHaveValue('5000');
  // Look 1117 v15 Q6-11: one stepper; − and + step through 1,000, 5K, 10K, 25K and 50K.
  const up = app.getByRole('button', { name: /^Increase Lines you can scroll back to/ });
  const down = app.getByRole('button', { name: /^Decrease Lines you can scroll back to/ });
  await up.click();
  await expect(field).toHaveValue('10000');
  await down.click();
  await expect(field).toHaveValue('5000');
  await field.fill('999');
  await field.press('Enter');
  await expect(app.getByRole('alert')).toContainText('1,000 to 50,000');
  await expect(field).toHaveAttribute('aria-describedby', 'scrollback-err');
  await expect(down).toBeEnabled(); // held back, nothing applied: 5,000 is still in use
  await field.fill('1000');
  await field.press('Enter');
  await expect(down).toBeDisabled();
  await show(app, a.id);
  await toTop();
  await expect.poll(() => topLine(app, a.id)).toBeGreaterThan(1900);
  // A valid draft survives Settings closing with the field still focused.
  await terminalPage(app);
  await field.fill('12345');
  await app.keyboard.press('Escape');
  await expect(field).toHaveCount(0);
  await terminalPage(app);
  await expect(field).toHaveValue('12345');
});
