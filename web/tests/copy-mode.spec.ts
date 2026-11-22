// Terminal copy mode (V1A-42; needs 25, 30): prefix [ enters vi-style keyboard selection over the xterm buffer, y copies
// through the clipboard helper, nothing reaches the PTY. Cursor cells are 0-based buffer coordinates (data-cursor "x,y").
import type { Page } from '@playwright/test';
import { expect, grantClipboard, openWindow, test, terminalText } from './fixtures';

// 300 lines, no trailing newline: the terminal cursor rests after "line 300" (x 17, y 299).
// cols: line 0-3, 001 5-7, ab 9-10, cd_ef 12-16.
const TEXT = Array.from({ length: 300 }, (_, i) => `line ${String(i + 1).padStart(3, '0')} ab cd_ef`).join('\r\n');
const L = (n: number) => `line ${String(n).padStart(3, '0')} ab cd_ef`;

const KEYS: Record<string, string> = { h: 'KeyH', j: 'KeyJ', k: 'KeyK', l: 'KeyL', w: 'KeyW', b: 'KeyB', e: 'KeyE', v: 'KeyV', y: 'KeyY', q: 'KeyQ', g: 'KeyG', '0': 'Digit0' };
type Mode = 'latin' | 'hangul';

/** A step is a key name ("h", "$", "G", "V", "Ctrl+d", "Escape"); the hangul source sends the same physical codes with a Hangul `key`. */
async function press(page: Page, mode: Mode, step: string) {
  const [mods, name] = /^(?:(Ctrl)\+)?(.+)$/.exec(step)!.slice(1);
  const shift = name === 'G' || name === 'V' || name === '$' || name === '^';
  const code = name === '$' ? 'Digit4' : name === '^' ? 'Digit6' : name === 'G' || name === 'V' ? `Key${name}` : KEYS[name] ?? name.replace(/^([a-z])$/, (c) => `Key${c.toUpperCase()}`);
  if (mode === 'latin') return page.keyboard.press([mods === 'Ctrl' ? 'Control' : '', shift ? 'Shift' : '', code].filter(Boolean).join('+'));
  await page.evaluate(
    ([c, s, ctrl]) => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, code: c, key: 'ㅁ', shiftKey: !!s, ctrlKey: !!ctrl })),
    [code, shift, mods === 'Ctrl'] as const,
  );
}
const keys = async (page: Page, mode: Mode, steps: string) => {
  for (const s of steps.split(' ')) await press(page, mode, s);
};
const cursor = (page: Page) => page.locator('.copy-layer').getAttribute('data-cursor');
const enter = async (page: Page, mode: Mode = 'latin') => {
  await page.keyboard.press('Control+Space');
  await press(page, mode, 'BracketLeft');
  await expect(page.locator('.copy-status')).toBeVisible();
};
const clip = (page: Page) => page.evaluate(() => navigator.clipboard.readText());

async function setup(app: Page, core: Parameters<Parameters<typeof test>[2]>[0]['core']) {
  await grantClipboard(app); // V1A-50: per engine, so the clipboard checks run on WebKit too
  const a = core.replay(core.project('demo'), 'alpha', TEXT);
  await openWindow(app);
  await expect.poll(() => terminalText(app, a.id)).toContain('line 300');
  return a;
}

test('prefix [ enters copy mode at the terminal cursor with a text status; motions land on the expected cells', async ({ app, core }) => {
  const a = await setup(app, core);
  await enter(app);
  await expect(app.locator('.copy-status')).toHaveText('Copy mode · v select · y copy · esc leave');
  await expect(app.locator('.copy-status')).toHaveAttribute('aria-live', 'polite');
  expect(await cursor(app)).toBe('17,299');
  await keys(app, 'latin', 'g g');
  expect(await cursor(app)).toBe('17,0');
  await keys(app, 'latin', '0');
  expect(await cursor(app)).toBe('0,0');
  await keys(app, 'latin', 'l l h');
  expect(await cursor(app)).toBe('1,0');
  await keys(app, 'latin', 'j j k');
  expect(await cursor(app)).toBe('1,1');
  await keys(app, 'latin', '0 w');
  expect(await cursor(app)).toBe('5,1');
  await keys(app, 'latin', 'w w');
  expect(await cursor(app)).toBe('12,1');
  await keys(app, 'latin', 'w'); // the next word starts on the next line
  expect(await cursor(app)).toBe('0,2');
  await keys(app, 'latin', 'b');
  expect(await cursor(app)).toBe('12,1');
  await keys(app, 'latin', '0 e');
  expect(await cursor(app)).toBe('3,1');
  await keys(app, 'latin', '$');
  expect(await cursor(app)).toBe('16,1');
  await keys(app, 'latin', '^');
  expect(await cursor(app)).toBe('0,1');
  await keys(app, 'latin', 'G');
  expect((await cursor(app))!.split(',')[1]).toBe('299');
  // Half page, and the view follows the cursor.
  await keys(app, 'latin', 'g g Ctrl+d');
  const [, y] = (await cursor(app))!.split(',').map(Number);
  expect(y).toBeGreaterThan(5);
  await keys(app, 'latin', 'Ctrl+u');
  expect((await cursor(app))!.split(',')[1]).toBe('0');
  await keys(app, 'latin', 'G');
  await expect.poll(() => terminalText(app, a.id)).toContain('line 300');
  await expect(app.locator('.copy-cursor')).toBeVisible();
  await keys(app, 'latin', 'g g');
  await expect.poll(() => terminalText(app, a.id)).toContain('line 001');
  await expect(app.locator('.copy-cursor')).toBeVisible();
});

for (const mode of ['latin', 'hangul'] as const) {
  test(`${mode}: v selects characters, Shift+v lines; y copies exactly the selection and leaves`, async ({ app, core }) => {
    const a = await setup(app, core);
    const before = core.read(a.id);
    await enter(app, mode);
    await keys(app, mode, 'g g 0 v e y');
    expect(await clip(app)).toBe('line');
    await expect(app.locator('.copy-layer')).toHaveCount(0);
    await expect(app.locator('.copied-note')).toHaveText('Copied');
    await enter(app, mode);
    await keys(app, mode, 'g g 0 j v w w y');
    expect(await clip(app)).toBe('line 002 a');
    await enter(app, mode);
    await keys(app, mode, 'g g V j y');
    expect(await clip(app)).toBe(`${L(1)}\n${L(2)}`);
    // Selecting backwards copies the same cells.
    await enter(app, mode);
    await keys(app, mode, 'g g j 0 l l l v k y');
    expect(await clip(app)).toBe('e 001 ab cd_ef\nline');
    // None of those keys reached the PTY (cat would have echoed them).
    expect(core.read(a.id)).toBe(before);
  });
}

test('Esc and q leave without copying; the PTY gets nothing and a plain key types again afterwards', async ({ app, core }) => {
  const a = await setup(app, core);
  const before = core.read(a.id);
  await app.evaluate(() => navigator.clipboard.writeText('sentinel'));
  await enter(app);
  await keys(app, 'latin', 'g g v l l Escape');
  await expect(app.locator('.copy-layer')).toHaveCount(0);
  expect(await clip(app)).toBe('sentinel');
  await enter(app);
  await keys(app, 'latin', 'V q');
  await expect(app.locator('.copy-layer')).toHaveCount(0);
  expect(await clip(app)).toBe('sentinel');
  expect(core.read(a.id)).toBe(before);
  // Global bindings are quiet inside the mode, and back after it.
  await enter(app);
  await app.keyboard.press('Meta+KeyK');
  await expect(app.getByRole('dialog', { name: 'Command palette' })).toHaveCount(0);
  await app.keyboard.press('Escape');
  await app.locator(`.term[data-session="${a.id}"]`).click();
  await app.keyboard.type('hi');
  await expect.poll(() => terminalText(app, a.id)).toContain('hi');
});

test('the entry command is in the palette', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await app.keyboard.press('Meta+KeyK');
  const palette = app.getByRole('dialog', { name: 'Command palette' });
  await expect(palette.locator('[data-command="terminal.copy"]')).toBeVisible();
});

// V2.5-67: the reload below replays alpha into a fresh terminal, and the mode seeds its cursor from the parsed buffer, so
// the cursor is 17,299 only once the replay is parsed (0,0 before it; seen with the page's CPU slowed 60x, 3 of 8 runs).
// The delayed run holds the core's output frames back 800 ms on purpose, so the old spec fails every time; the wait is
// on the replayed text, not a delay.
for (const lateMs of [0, 800])
  test(lateMs === 0 ? 'Alt keys are swallowed too, and the mode ends when another tab is shown' : 'copy_mode_alt_swallowed_deterministic: the same with the replay arriving 800 ms late', async ({ app, core }) => {
    const a = await setup(app, core);
    core.shell(core.project('demo'), 'beta');
    if (lateMs)
      await app.routeWebSocket(/\/ws$/, (ws) => {
        const server = ws.connectToServer();
        ws.onMessage((m) => server.send(m));
        server.onMessage((m) => (typeof m === 'string' ? ws.send(m) : void setTimeout(() => ws.send(m), lateMs)));
      });
    await openWindow(app);
    await expect.poll(() => terminalText(app, a.id)).toContain('line 300');
    const before = core.read(a.id);
    await enter(app);
    await app.keyboard.press('Alt+KeyX');
    await app.keyboard.press('Alt+KeyH');
    expect(await cursor(app)).toBe('17,299');
    expect(core.read(a.id)).toBe(before);
    await app.getByRole('tab', { name: /beta/ }).click();
    await expect(app.locator('.copy-status')).toHaveCount(0);
  });

test('$ and ^ count cells, so a wide-character line ends at its last cell', async ({ app, core }) => {
  const a = core.replay(core.project('demo'), 'alpha', '  한글한글');
  await openWindow(app);
  await expect.poll(() => terminalText(app, a.id)).toContain('한글한글');
  await enter(app);
  await keys(app, 'latin', '$');
  expect(await cursor(app)).toBe('8,0'); // 2 blanks, then 한 2-3, 글 4-5, 한 6-7, 글 8-9: the last glyph starts at cell 8
  await keys(app, 'latin', '^');
  expect(await cursor(app)).toBe('2,0');
});

const textarea = (page: Page) => page.locator('.xterm-helper-textarea').first();

test('IME text cannot reach the PTY: focus is pulled off the terminal input, and keys sent straight to it are swallowed', async ({ app, core, browserName }) => {
  const a = await setup(app, core);
  const before = core.read(a.id);
  await enter(app);
  await textarea(app).focus();
  expect(await app.evaluate(() => document.activeElement?.classList.contains('xterm-helper-textarea'))).toBe(false);
  if (browserName === 'chromium') {
    // A composition and its commit, as an input source delivers them to the focused element.
    const cdp = await app.context().newCDPSession(app);
    await cdp.send('Input.imeSetComposition', { text: '하', selectionStart: 1, selectionEnd: 1 });
    await cdp.send('Input.insertText', { text: '한' });
  } else {
    // V1A-50: WebKit has no IME driver here; committed text, as an input source inserts it at the focused element.
    await app.keyboard.insertText('한');
  }
  // Keys dispatched at the terminal's input itself, composing or not, are the mode's: swallowed, and still motions.
  await app.evaluate(() => {
    const t = document.querySelector('.xterm-helper-textarea')!;
    for (const init of [{ code: 'KeyX' }, { code: 'KeyH', isComposing: true }, { code: 'KeyH', altKey: true }])
      t.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'ㅗ', ...init }));
  });
  expect(await cursor(app)).toBe('16,299');
  await expect(app.locator('.copy-status')).toBeVisible();
  await app.waitForTimeout(300);
  expect(core.read(a.id)).toBe(before);
});

test('the mode ends when its session closes and when the window loses focus', async ({ app, core }) => {
  const a = await setup(app, core);
  core.shell(core.project('demo'), 'beta');
  await openWindow(app);
  await enter(app);
  await app.locator(`.tab[data-tab="${a.id}"] ~ .x`).click({ force: true }); // CHROME: the ✕ is drawn on hover or focus
  await expect(app.locator(`.tab[data-tab="${a.id}"]`)).toHaveCount(0);
  await expect(app.locator('.copy-status')).toHaveCount(0);
  await enter(app);
  await app.evaluate(() => window.dispatchEvent(new Event('blur')));
  await expect(app.locator('.copy-status')).toHaveCount(0);
});

// V1A-54: a selection made in the mode is not left drawn once the mode ends, however it ends.
for (const exit of ['Escape', 'q', 'another tab', 'y'] as const) {
  test(`copy-selection-cleared: a Shift+v selection is gone after leaving with ${exit}`, async ({ app, core }) => {
    const a = await setup(app, core);
    const drawn = app.locator(`.term[data-session="${a.id}"] .xterm-selection div`);
    await enter(app);
    await keys(app, 'latin', 'V k k');
    await expect(drawn).not.toHaveCount(0);
    if (exit === 'another tab') {
      // Another tab shown ends the mode from outside it.
      const b = core.shell(core.project('demo'), 'beta');
      await expect(app.locator(`.tab[data-tab="${b.id}"]`)).toBeAttached();
      await app.locator(`.tab[data-tab="${b.id}"]`).click();
      await expect(app.locator('.copy-layer')).toHaveCount(0);
      await app.locator(`.tab[data-tab="${a.id}"]`).click();
    } else await keys(app, 'latin', exit);
    await expect(app.locator('.copy-layer')).toHaveCount(0);
    await expect(drawn).toHaveCount(0);
  });
}
