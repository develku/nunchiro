// V1A-64 (needs 71): the terminal font is picked from installed coding fonts, previewed in their own faces, with
// Custom… keeping the free-text list and an optional Symbols Nerd Font fallback. Detection is mocked through
// window.__NUNCHIRO_FONTS__; the detector itself is tested with a fake measure function. V1A-67: fonts only the app
// holds come from its font_families / font_faces commands, stubbed here with a real font file's bytes.
import type { Page } from '@playwright/test';
import fs from 'node:fs';
import { DEFAULTS, FONT } from '../src/settings';
import { CURATED, detect, SYMBOLS, withSymbols } from '../src/settings/appearance/fonts';
import { unpack } from '../src/settings/appearance/serve';
import { expect, openWindow, terminalText, test } from './fixtures';

const KEY = 'nunchiro.settings.v1';
const stored = (app: Page) => app.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? '{}').termFont as string | undefined, KEY);
const mock = (app: Page, fonts: string[]) => app.addInitScript((f) => ((window as { __NUNCHIRO_FONTS__?: string[] }).__NUNCHIRO_FONTS__ = f), fonts);
const picker = (app: Page) => app.getByRole('button', { name: /^Terminal font/ });
const listbox = (app: Page) => app.getByRole('listbox', { name: 'Terminal font' });
const options = (app: Page) => listbox(app).getByRole('option');
const search = (app: Page) => app.getByRole('combobox', { name: 'Search fonts' });
const symbols = (app: Page) => app.getByRole('checkbox', { name: /Symbols Nerd Font fallback/ });
const custom = (app: Page) => app.getByRole('textbox', { name: 'Custom font list' });

async function appearance(app: Page) {
  // Settings is a modal that stays open over a reload; Meta+Comma would close it.
  if (!(await app.getByRole('button', { name: 'Close Settings' }).isVisible())) await app.keyboard.press('Meta+Comma');
  // needs 149/150 (309459ab): Settings opens on General; needs 192 (ticket 250): the terminal font lives on Terminal.
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Terminal', exact: true }).click();
  await expect(picker(app)).toBeVisible();
}
async function choose(app: Page, name: string) {
  await picker(app).click();
  await expect(search(app)).toBeFocused(); // a click before the search box holds focus races its blur handler
  await options(app).filter({ hasText: new RegExp(`^${name.replace('…', '\\…')}`) }).click();
}

test('font-detect-mocked: the detector keeps fonts whose width differs from both fallbacks', () => {
  // Fake widths: a missing font measures as its fallback; "Wide" changes the serif width only, so it is missing.
  const widths: Record<string, number> = { serif: 100, 'sans-serif': 90, '"Menlo", serif': 120, '"Menlo", sans-serif': 120, '"Hack", serif': 130, '"Hack", sans-serif': 131, '"Wide", serif': 140 };
  const measure = (font: string) => widths[font] ?? widths[font.replace(/^"[^"]+", /, '')];
  expect(detect(['Hack', 'Wide', 'Menlo', 'Gone'], measure)).toEqual(['Hack', 'Menlo']);
  // The curated list carries each family with its Nerd Font Mono variant right after it.
  expect(CURATED.indexOf('JetBrainsMono Nerd Font Mono')).toBe(CURATED.indexOf('JetBrains Mono') + 1);
  expect(CURATED).not.toContain(SYMBOLS);
});

test('font-detect-mocked: the dropdown lists exactly the installed subset in curated order, each in its own face', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await mock(app, ['Hack', 'Menlo', 'Not A Curated Font', 'JetBrainsMono Nerd Font Mono']);
  await openWindow(app);
  await appearance(app);
  await picker(app).click();
  await expect(options(app)).toHaveText([/^Menlo/, /^JetBrainsMono Nerd Font Mono/, /^Hack/, /^Custom…/]);
  for (const [i, f] of ['Menlo', 'JetBrainsMono Nerd Font Mono', 'Hack'].entries())
    expect(await options(app).nth(i).evaluate((el) => getComputedStyle(el).fontFamily.replaceAll('"', ''))).toMatch(new RegExp(`^${f},`));
  // The default list's first face (SF Mono) is not mocked as installed, so it reads as the face it renders in.
  await expect(options(app).filter({ hasText: /^Menlo/ })).toHaveAttribute('aria-selected', 'true');
  await expect(app.getByText('Coding fonts installed on this Mac, ~/Library/Fonts included.')).toBeVisible();
  // The button closes an open list.
  await picker(app).click();
  await expect(listbox(app)).toHaveCount(0);
  await picker(app).click();
  await app.keyboard.press('Escape');
  await expect(listbox(app)).toHaveCount(0);
  await expect(picker(app)).toBeFocused();
});

test('font-select-writes-termfont: an entry writes a valid list starting with it; the open terminal follows; Hangul still types', async ({ app, core }) => {
  const a = core.shell(core.project('demo'), 'alpha', '/bin/sh', '-c', 'exec cat');
  await mock(app, ['Menlo', 'D2Coding', 'Hack']);
  await openWindow(app);
  await appearance(app);
  await choose(app, 'Hack');
  const font = (await stored(app))!;
  expect(FONT.test(font)).toBe(true);
  expect(font).toBe('"Hack", "Symbols Nerd Font Mono", "Menlo", "D2Coding", monospace'); // needs 152: the fallback is on by default
  await expect(picker(app)).toContainText('Hack');
  // Keyboard: open, move down, pick.
  await picker(app).focus();
  await app.keyboard.press('ArrowDown');
  // The search box takes focus after paint: a key sent before that lands on the button and never reaches the list.
  await expect(search(app)).toBeFocused();
  await expect(options(app).filter({ hasText: /^Hack/ })).toHaveAttribute('aria-selected', 'true');
  await app.keyboard.press('ArrowUp');
  await app.keyboard.press('Enter');
  await expect.poll(() => stored(app)).toBe('"Menlo", "Symbols Nerd Font Mono", "D2Coding", monospace');
  await expect(listbox(app)).toHaveCount(0);
  // Typing filters the list and Enter takes the first match; the list stays closed afterwards.
  await app.keyboard.press('ArrowDown');
  await expect(search(app)).toBeFocused();
  await app.keyboard.type('hac');
  await expect(options(app)).toHaveText([/^Hack/]);
  await app.keyboard.press('Enter');
  await expect.poll(() => stored(app)).toBe('"Hack", "Symbols Nerd Font Mono", "Menlo", "D2Coding", monospace');
  await expect(listbox(app)).toHaveCount(0);
  await expect(picker(app)).toBeFocused();
  await choose(app, 'Hack');
  await app.getByRole('button', { name: 'Close Settings' }).click(); // Settings is a modal: what sits behind it cannot be clicked
  await app.getByRole('tab', { name: /alpha/ }).click();
  const rows = app.locator(`.term[data-session="${a.id}"] .xterm-rows`);
  await expect.poll(() => rows.evaluate((el) => getComputedStyle(el).fontFamily.replaceAll('"', ''))).toBe('Hack, Symbols Nerd Font Mono, Menlo, D2Coding, monospace');
  // Acceptance card, Korean input: committed Hangul still reaches the session after the font change.
  await app.locator(`.term[data-session="${a.id}"] .xterm-helper-textarea`).focus();
  await app.keyboard.insertText('한글 입력');
  await expect.poll(() => terminalText(app, a.id)).toContain('한글 입력');
});

test('font-custom-validated: an invalid list shows the error and is not saved; a valid one saves; an unknown value opens as Custom', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await mock(app, ['Menlo']);
  await openWindow(app);
  await appearance(app);
  await choose(app, 'Menlo');
  await expect(custom(app)).toHaveCount(0);
  await choose(app, 'Custom…');
  await expect(custom(app)).toHaveValue('"Menlo", "Symbols Nerd Font Mono", "D2Coding", monospace');
  await custom(app).fill('x; } body { display: none');
  await expect(app.getByRole('alert')).toContainText('Font names');
  expect(await stored(app)).toBe('"Menlo", "Symbols Nerd Font Mono", "D2Coding", monospace');
  await custom(app).fill('Courier New, monospace');
  await expect(app.getByRole('alert')).toHaveCount(0);
  await expect.poll(() => stored(app)).toBe('Courier New, monospace');
  await app.getByRole('button', { name: 'Default', exact: true }).click(); // 49caef92: the row resets are "Reset … to default"
  await expect.poll(() => stored(app)).toBe(DEFAULTS.termFont);
  await custom(app).fill('Courier New, monospace');
  await app.reload();
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  await appearance(app);
  await expect(picker(app)).toContainText('Custom…');
  await expect(custom(app)).toHaveValue('Courier New, monospace');
});

test('font-symbols-fallback: on appends the symbols face once after the main face, off removes it', () => {
  const on = withSymbols('"Hack", "Menlo", monospace', true);
  expect(on).toBe(`"Hack", "${SYMBOLS}", "Menlo", monospace`);
  expect(withSymbols(on, true)).toBe(on);
  expect(withSymbols(on, false)).toBe('"Hack", "Menlo", monospace');
  expect(withSymbols(`'Hack', ${SYMBOLS}, Menlo`, false)).toBe("'Hack', Menlo");
});

// needs 152 (amends needs 71): the symbols face is bundled. needs 192 (7) (ticket 250) removed its toggle (Ghostty model):
// the face is an always-on fallback behind the picked font, so there is no checkbox and every pick keeps it once.
test('font-symbols-fallback: no toggle; every pick keeps the bundled face once, right after the main face', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await mock(app, ['Hack', SYMBOLS]);
  await openWindow(app);
  await appearance(app);
  await expect(symbols(app)).toHaveCount(0);
  await choose(app, 'Hack');
  await expect.poll(() => stored(app)).toBe(`"Hack", "${SYMBOLS}", "Menlo", "D2Coding", monospace`);
  // The entry stays Hack, and another pick keeps the fallback once.
  await expect(picker(app)).toContainText('Hack');
  await choose(app, 'Custom…');
  await choose(app, 'Hack');
  expect(((await stored(app))!.match(/Symbols Nerd Font Mono/g) ?? []).length).toBe(1);

  // A system without the font file still gets the bundled face, and says nothing about it.
  await app.addInitScript(() => ((window as { __NUNCHIRO_FONTS__?: string[] }).__NUNCHIRO_FONTS__ = ['Hack']));
  await app.reload();
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  await appearance(app);
  await expect(app.getByText('Symbols Nerd Font Mono is not installed.')).toHaveCount(0);
  await expect(symbols(app)).toHaveCount(0);
  await expect.poll(() => stored(app)).toBe(`"Hack", "${SYMBOLS}", "Menlo", "D2Coding", monospace`);
});

test('font-symbols-fallback: a stored list is kept as written (no toggle rewrites it)', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await mock(app, ['Menlo', SYMBOLS]);
  const long = `"${'a'.repeat(177)}", monospace`;
  await app.addInitScript(([k, v]) => localStorage.getItem(k) || localStorage.setItem(k, JSON.stringify({ termFont: v })), [KEY, long]);
  await openWindow(app);
  await appearance(app);
  await expect(symbols(app)).toHaveCount(0);
  expect(await stored(app)).toBe(long);
  // The symbols face alone stays the whole list.
  await app.evaluate(([k, v]) => localStorage.setItem(k, JSON.stringify({ ...JSON.parse(localStorage.getItem(k)!), termFont: v })), [KEY, `"${SYMBOLS}"`]);
  await app.reload();
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  await appearance(app);
  expect(await stored(app)).toBe(`"${SYMBOLS}"`);
});

test('font-setting-survives-reload: the entry and the fallback toggle come back; a broken store falls back to the default', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await mock(app, ['SF Mono', 'JetBrainsMono Nerd Font Mono', SYMBOLS]);
  await openWindow(app);
  await appearance(app);
  // The default list reads as its first face when that face is installed.
  await expect(picker(app)).toContainText('SF Mono');
  await choose(app, 'JetBrainsMono Nerd Font Mono');
  await expect.poll(() => stored(app)).toContain(SYMBOLS); // needs 192 (7): always on, no toggle
  await app.reload();
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  await appearance(app);
  await expect(picker(app)).toContainText('JetBrainsMono Nerd Font Mono');
  expect(await stored(app)).toContain(SYMBOLS);
  await app.evaluate((k) => {
    const s = JSON.parse(localStorage.getItem(k)!);
    s.termFont = 'x; } body { display: none';
    localStorage.setItem(k, JSON.stringify(s));
  }, KEY);
  await app.reload();
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  await appearance(app);
  await expect(picker(app)).toContainText('SF Mono');
  expect(DEFAULTS.termFont).toContain(SYMBOLS); // needs 152: the default list carries the symbols face
  await expect.poll(() => stored(app)).toBe(DEFAULTS.termFont);
});

/** fonts.rs `pack`: per face a u16 weight, a u8 italic flag, a u32 length (big-endian), then the bytes. */
function pack(faces: { weight: number; italic: boolean; bytes: Uint8Array }[]) {
  const out = Buffer.concat(faces.flatMap((f) => [Buffer.from([f.weight >> 8, f.weight & 255, f.italic ? 1 : 0, ...[24, 16, 8, 0].map((s) => (f.bytes.length >> s) & 255)]), Buffer.from(f.bytes)]));
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.length) as ArrayBuffer;
}

test('app-fonts: the packed faces split into weight, style and bytes; a cut-off tail is dropped', () => {
  const buf = pack([
    { weight: 400, italic: false, bytes: new Uint8Array([1, 2, 3]) },
    { weight: 700, italic: true, bytes: new Uint8Array([9]) },
  ]);
  const faces = unpack(buf);
  expect(faces.map((f) => [f.weight, f.italic, [...new Uint8Array(f.bytes)]])).toEqual([
    [400, false, [1, 2, 3]],
    [700, true, [9]],
  ]);
  expect(unpack(buf.slice(0, buf.byteLength - 1))).toHaveLength(1);
  expect(unpack(new ArrayBuffer(0))).toEqual([]);
});

test('app-fonts: a family only the app holds shows as usable, and the terminal renders in the face it hands over', async ({ app, core }) => {
  const a = core.shell(core.project('demo'), 'alpha', '/bin/sh', '-c', 'exec cat');
  // The webview sees Menlo only; the app holds "JetBrains Mono" (here: Monaco's real bytes) and the symbols face.
  await mock(app, ['Menlo']);
  const bytes = [...fs.readFileSync('/System/Library/Fonts/Monaco.ttf')];
  await app.addInitScript((font) => {
    const w = window as unknown as { __calls: { cmd: string; args: Record<string, unknown> }[] };
    w.__calls = [];
    const face = new Uint8Array([1, 144, 0, ...[24, 16, 8, 0].map((s) => (font.length >> s) & 255), ...font]);
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args: Record<string, unknown>) => {
        w.__calls.push({ cmd, args });
        if (cmd === 'font_families') return (args.names as string[]).filter((n) => ['JetBrains Mono', 'Symbols Nerd Font Mono'].includes(n));
        if (cmd === 'font_faces') return (args.family === 'JetBrains Mono' ? face : new Uint8Array()).buffer;
      },
    };
  }, bytes);
  const calls = () => app.evaluate(() => (window as unknown as { __calls: { cmd: string; args: Record<string, unknown> }[] }).__calls.filter((c) => c.cmd.startsWith('font_')));
  await openWindow(app);
  await appearance(app);
  const loaded = () =>
    app.evaluate(() => [...document.fonts].filter((f) => f.family.replaceAll('"', '') === 'JetBrains Mono' && f.status === 'loaded').map((f) => `${f.weight} ${f.style}`));
  expect(await loaded()).toEqual([]);
  await picker(app).click();
  await expect(options(app)).toHaveText([/^Menlo/, /^JetBrains Mono/, /^Custom…/]);
  // Opening the list loads the app's face, so the option previews in it, not in its fallback (V1A-64's promise).
  await expect.poll(loaded).toEqual(['400 normal']);
  expect(await options(app).nth(1).evaluate((el) => getComputedStyle(el).fontFamily.replaceAll('"', ''))).toMatch(/^JetBrains Mono,/);
  await app.keyboard.press('Escape');
  await expect(symbols(app)).toHaveCount(0); // needs 192 (7) (ticket 250): no toggle; the face is always on
  await expect(app.getByText(/is not installed/)).toHaveCount(0);
  await choose(app, 'JetBrains Mono');
  await expect.poll(() => stored(app)).toBe('"JetBrains Mono", "Symbols Nerd Font Mono", "Menlo", "D2Coding", monospace');
  // The face is loaded under the family name, and text in it measures differently from its fallback.
  await expect.poll(loaded).toEqual(['400 normal']);
  const width = (family: string) =>
    app.evaluate((f) => {
      const ctx = document.createElement('canvas').getContext('2d')!;
      ctx.font = `40px ${f}`;
      return ctx.measureText('mmmmiiiilll1').width;
    }, family);
  expect(await width('"JetBrains Mono", serif')).not.toBe(await width('serif'));
  await app.getByRole('button', { name: 'Close Settings' }).click(); // Settings is a modal: what sits behind it cannot be clicked
  await app.getByRole('tab', { name: /alpha/ }).click();
  const rows = app.locator(`.term[data-session="${a.id}"] .xterm-rows`);
  await expect.poll(() => rows.evaluate((el) => getComputedStyle(el).fontFamily.replaceAll('"', ''))).toBe('JetBrains Mono, Symbols Nerd Font Mono, Menlo, D2Coding, monospace');
  // The page asked by family name only: the curated names once, then each family of the list it applies, once
  // (the generic monospace names no file and is not asked for).
  const made = await calls();
  expect(made.filter((c) => c.cmd === 'font_families')).toEqual([{ cmd: 'font_families', args: { names: [...CURATED, SYMBOLS] } }]);
  const faces = made.filter((c) => c.cmd === 'font_faces').map((c) => c.args);
  expect(faces.every((args) => Object.keys(args).join() === 'family')).toBe(true);
  // Lists are debounced, so the start-up list may be superseded before it is asked for (SF Mono then never is); each
  // family is asked at most once, and only families of a list the page applied.
  const asked = (await calls()).filter((c) => c.cmd === 'font_faces').map((c) => c.args.family as string);
  expect(asked).toContain('JetBrains Mono');
  expect(new Set(asked).size).toBe(asked.length);
  expect(asked.every((f) => ['SF Mono', 'Menlo', 'D2Coding', 'JetBrains Mono'].includes(f))).toBe(true);
});

test('app-fonts: typing a Custom list asks the app only for the list it settles on', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await mock(app, ['Menlo']);
  await app.addInitScript(() => {
    const w = window as unknown as { __faces: string[] };
    w.__faces = [];
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args: Record<string, unknown>) => {
        if (cmd === 'font_families') return [];
        if (cmd === 'font_faces') w.__faces.push(args.family as string);
        return new ArrayBuffer(0);
      },
    };
  });
  const faces = () => app.evaluate(() => (window as unknown as { __faces: string[] }).__faces);
  await openWindow(app);
  await appearance(app);
  await choose(app, 'Custom…');
  await custom(app).fill('');
  // The app asks for the list that settles for 250 ms (serve.ts). Real keys sent 20 ms apart let a loaded machine stall past
  // that gap, so a prefix ("Ios") was asked for (2 of 560 at 4 workers). The page clock is held and moved 20 ms per key instead:
  // the gap between keys is exact, and a debounce shorter than it would still ask for prefixes.
  await app.clock.install({ time: Date.now() });
  await app.clock.pauseAt(Date.now() + 1000);
  for (const ch of 'Iosevka Term, monospace') {
    await custom(app).pressSequentially(ch);
    await app.clock.runFor(20);
  }
  await app.clock.runFor(300); // the list settles
  await expect.poll(() => stored(app)).toBe('Iosevka Term, monospace');
  await expect.poll(async () => (await faces()).includes('Iosevka Term')).toBe(true);
  await app.clock.runFor(400);
  // No prefix of the name ("I", "Io", "Iosevka", ...) was ever asked for.
  expect((await faces()).filter((f) => f.startsWith('I'))).toEqual(['Iosevka Term']);
});

test('app-fonts: a live terminal re-measures its cells once a served face with other metrics loads', async ({ app, core }) => {
  const a = core.shell(core.project('demo'), 'alpha', '/bin/sh', '-c', 'exec cat');
  await mock(app, ['Menlo']);
  // The terminal opens on its fallback (Menlo) first: the face answers late, with metrics far from Menlo's.
  await app.addInitScript((k) => localStorage.getItem(k) || localStorage.setItem(k, JSON.stringify({ termFont: '"Wide Face", "Menlo", monospace' })), KEY);
  const bytes = [...fs.readFileSync('/System/Library/Fonts/Supplemental/Arial Black.ttf')];
  await app.addInitScript((font) => {
    const face = new Uint8Array([1, 144, 0, ...[24, 16, 8, 0].map((s) => (font.length >> s) & 255), ...font]);
    const w = window as unknown as { __release?: () => void };
    const gate = new Promise<void>((r) => (w.__release = r));
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args: Record<string, unknown>) => {
        if (cmd === 'font_families') return [];
        if (cmd === 'font_faces') return args.family === 'Wide Face' ? gate.then(() => face.buffer) : new ArrayBuffer(0);
      },
    };
  }, bytes);
  await openWindow(app);
  await app.getByRole('tab', { name: /alpha/ }).click();
  const cell = () =>
    app.locator(`.term[data-session="${a.id}"]`).evaluate((el) => {
      const row = el.querySelector('.xterm-rows > div') as HTMLElement;
      const screen = el.querySelector('.xterm-screen') as HTMLElement;
      return { row: row.getBoundingClientRect().height, width: screen.getBoundingClientRect().width };
    });
  await expect.poll(async () => (await cell()).row).toBeGreaterThan(0);
  const before = await cell();
  await app.evaluate(() => (window as unknown as { __release: () => void }).__release());
  await expect.poll(() => app.evaluate(() => [...document.fonts].some((f) => f.family.replaceAll('"', '') === 'Wide Face' && f.status === 'loaded'))).toBe(true);
  // Arial Black's line box is far taller than Menlo's: the rows follow it.
  await expect.poll(async () => (await cell()).row).toBeGreaterThan(before.row + 1);
});

test('app-fonts: fonts_loaded_event_names_the_family', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await mock(app, ['Menlo']);
  await app.addInitScript((k) => localStorage.getItem(k) || localStorage.setItem(k, JSON.stringify({ termFont: '"Named Face", "Menlo", monospace' })), KEY);
  const bytes = [...fs.readFileSync('/System/Library/Fonts/Monaco.ttf')];
  await app.addInitScript((font) => {
    const w = window as unknown as { __loaded: unknown[] };
    w.__loaded = [];
    window.addEventListener('nunchiro:fonts-loaded', (e) => w.__loaded.push((e as CustomEvent).detail));
    const face = new Uint8Array([1, 144, 0, ...[24, 16, 8, 0].map((s) => (font.length >> s) & 255), ...font]);
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args: Record<string, unknown>) => {
        if (cmd === 'font_families') return [];
        if (cmd === 'font_faces') return (args.family === 'Named Face' ? face : new Uint8Array()).buffer;
      },
    };
  }, bytes);
  await openWindow(app);
  await expect.poll(() => app.evaluate(() => (window as unknown as { __loaded: unknown[] }).__loaded)).toEqual([{ family: 'Named Face' }]);
});

test('app-fonts: startup_font_serve_is_not_debounced', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await mock(app, ['Menlo']);
  await app.addInitScript((k) => localStorage.getItem(k) || localStorage.setItem(k, JSON.stringify({ termFont: '"Quick Face", monospace' })), KEY);
  await app.addInitScript(() => {
    // The 250 ms settle never fires here, so only a call that skips it can reach the app.
    const real = window.setTimeout.bind(window);
    window.setTimeout = ((fn: TimerHandler, ms?: number, ...rest: unknown[]) => (ms === 250 ? 0 : real(fn, ms, ...rest))) as typeof window.setTimeout;
    const w = window as unknown as { __faces: string[] };
    w.__faces = [];
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args: Record<string, unknown>) => {
        if (cmd === 'font_families') return [];
        if (cmd === 'font_faces') w.__faces.push(args.family as string);
        return new ArrayBuffer(0);
      },
    };
  });
  await openWindow(app);
  await expect.poll(() => app.evaluate(() => (window as unknown as { __faces: string[] }).__faces)).toContain('Quick Face');
});
