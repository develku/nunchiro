// Theme model (needs 55; ticket V1A-34): Ghostty-format parser, token derivation as written, xterm mapping.
// Pure functions, no page.
import { expect, test } from '@playwright/test';
import { DEFAULT_PALETTE, FILE_CAP, LINE_CAP, parseGhostty, validColors } from '../src/themes/ghostty';
import { importTheme as importWith } from '../src/themes/import';
import { makeT } from './i18n-tables';
import { contrast, deriveTokens, isDark, xtermTheme } from '../src/themes/derive';
import { THEMES } from '../src/themes/catalog/catalog.gen';

const SAMPLE = `# a comment
background=#101820

  foreground   =   #F0E0D0
palette = 3=#aabbcc
palette = 15=#ABCDEF
cursor-color = #ff0000
font-family = Comic Sans
selection-background = #333333
`;

test('parser reads comments, blanks, spaces around =, palette entries, upper-case hex; unknown keys ignored', () => {
  const c = parseGhostty(SAMPLE);
  expect(c.background).toBe('#101820');
  expect(c.foreground).toBe('#f0e0d0');
  expect(c.palette[3]).toBe('#aabbcc');
  expect(c.palette[15]).toBe('#abcdef');
  expect(c.palette[0]).toBe(DEFAULT_PALETTE[0]);
  expect(c.cursor).toBe('#ff0000');
  // Missing optional keys get defaults: cursor text is the background; a set selection keeps cell colours.
  expect(c.cursorText).toBe('#101820');
  expect(c.selectionBackground).toBe('#333333');
  expect(c.selectionForeground).toBeUndefined();
  expect(Object.keys(c)).not.toContain('font-family');
});

test('parser rejects malformed colours, palette index outside 0-15 and over-long lines; the key keeps its default', () => {
  const bad = [
    'background = #12345',
    'foreground = red',
    'cursor-color = #12345g',
    'selection-background = #123456; background: url(x)',
    'palette = 16=#ffffff',
    'palette = -1=#ffffff',
    'palette = 2=#zzzzzz',
    `palette = 1=#abcdef ${' '.repeat(LINE_CAP)}`,
    `cursor-text = #00ff00${' '.repeat(LINE_CAP)}`,
  ].join('\n');
  const c = parseGhostty(bad);
  expect(c.background).toBe('#000000');
  expect(c.foreground).toBe('#ffffff');
  expect(c.cursor).toBe('#ffffff');
  expect(c.cursorText).toBe('#000000');
  expect(c.palette).toEqual(DEFAULT_PALETTE);
  expect(c.palette).toHaveLength(16);
  // Nothing but #rrggbb can come out of the parser.
  for (const v of [c.background, c.foreground, c.cursor, c.cursorText, c.selectionBackground, ...c.palette]) expect(v).toMatch(/^#[0-9a-f]{6}$/);
});

test('stored colours are validated like parsed ones', () => {
  const c = parseGhostty(SAMPLE);
  expect(validColors(JSON.parse(JSON.stringify(c)))).toEqual(c);
  expect(validColors({ ...c, background: 'red' })).toBeNull();
  expect(validColors({ ...c, palette: c.palette.slice(1) })).toBeNull();
  expect(validColors({ ...c, selectionForeground: 'url(x)' })).toBeNull();
  expect(validColors(null)).toBeNull();
});

// Ticket 293 (needs 212) replaced the contrast push: a catalog theme's text is its foreground as written, so the old
// "every derived text token reaches 4.5:1" pins went (`no_contrast_push_for_catalog_themes` holds the new contract).
// What stays: the scheme is still taken by the background.
test('the scheme follows the background', () => {
  expect(isDark(parseGhostty(THEMES['Catppuccin Mocha']))).toBe(true);
  expect(isDark(parseGhostty(THEMES['Catppuccin Latte']))).toBe(false);
});

// Ticket 293: the old pin "Nunchiro Light and Dark reproduce the ko/ tokens within 8/255" tested the derivation the bundled
// pair no longer goes through; `bundled_themes_unchanged` (theme-as-written.spec.ts) checks the real window against tokens.css.

test('palette 0-15 maps to xterm black..brightWhite; cursor and selection keys map to xterm names', () => {
  const c = parseGhostty(THEMES['Catppuccin Mocha']);
  const y = xtermTheme(c);
  const names = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'] as const;
  names.forEach((n, i) => expect(y[n]).toBe(c.palette[i]));
  expect(y).toMatchObject({ background: c.background, foreground: c.foreground, cursor: c.cursor, cursorAccent: c.cursorText, selectionBackground: c.selectionBackground, selectionForeground: c.selectionForeground });
  const s = xtermTheme(parseGhostty(SAMPLE));
  expect(s.selectionForeground).toBeUndefined();
  expect(s.brightWhite).toBe('#abcdef');
});

const importTheme = (i: Parameters<typeof importWith>[0], taken: string[]) => importWith(i, taken, makeT('en', 'en'));
test('import seam: parsed text plus an optional source URL makes a pick, or a reason it cannot', () => {
  const text = 'background = #102030\nforeground = #e0e0e0\n';
  expect(importTheme({ name: ' Mine ', text, source: 'https://example.com/mine' }, [])).toEqual({
    pick: { id: 'imported:Mine', name: 'Mine', colors: parseGhostty(text), source: 'https://example.com/mine' },
  });
  expect(importTheme({ name: 'Mine', text }, [])).toEqual({ pick: { id: 'imported:Mine', name: 'Mine', colors: parseGhostty(text) } });
  expect(importTheme({ name: '', text }, [])).toMatchObject({ error: expect.stringContaining('name') });
  expect(importTheme({ name: 'Mine', text }, ['Mine'])).toMatchObject({ error: expect.stringContaining('already') });
  expect(importTheme({ name: 'Mine', text: 'font-size = 12' }, [])).toMatchObject({ error: expect.stringContaining('No theme found') });
  expect(importTheme({ name: 'Mine', text: text + 'x'.repeat(FILE_CAP) }, [])).toMatchObject({ error: expect.stringContaining('too large') });
  for (const source of ['javascript:alert(1)', 'ftp://x', 'https://' + 'a'.repeat(600)]) expect(importTheme({ name: 'Mine', text, source }, []), source).toMatchObject({ error: expect.stringContaining('source') });
});

// Ticket 293, needs 212: a catalog theme is applied as written. The role table: accent palette 4, your turn palette 3,
// bad palette 1, ok palette 2, done palette 5, text foreground, panel background. Muted and faint are mixed from background
// and foreground (D-20261108-11, amends option A's palette 8).
const DRACULA = `background = #282a36
foreground = #f8f8f2
selection-background = #44475a
palette = 0=#21222c
palette = 1=#ff5555
palette = 2=#50fa7b
palette = 3=#f1fa8c
palette = 4=#bd93f9
palette = 5=#ff79c6
palette = 6=#8be9fd
palette = 7=#f8f8f2
palette = 8=#6272a4
palette = 9=#ff6e6e
palette = 10=#69ff94
palette = 11=#ffffa5
palette = 12=#d6acff
palette = 13=#ff92df
palette = 14=#a4ffff
palette = 15=#ffffff
`;
type Colors = ReturnType<typeof parseGhostty>;
// These role tokens are their source field, byte for byte. Since the design book's derive rule, the status colours
// (--you, --bad, --ok, --done, --warn and their --light-* and -text roles) step until they read, and --raised lifts off
// the background; theme-book-contrast.spec.ts checks them. --text is the exception for the app's chrome (ticket 520):
// see MIN_CONTRAST below.
const ROLES: [string, (c: Colors) => string][] = [
  ['--stale', (c) => c.palette[11]],
  ['--stale-line', (c) => c.palette[11]],
  ['--panel', (c) => c.background],
  ['--on-status', (c) => c.background],
  ['--selection-bg', (c) => c.selectionBackground],
  ['--selection-text', (c) => c.selectionForeground ?? c.foreground],
];
const AA = 4.5;
// Ticket 520 (owner owner 2026-11-13, amends D-20261108-11; minimum contrast for the chrome only): --text is the foreground when it reads at 4.5:1 on
// --page and --panel, and --run is palette 4 when the --on-status text (the background) reads at 4.5:1 on it; else each
// steps toward black (light theme) or white (dark) until it does. Returns why a token breaks the rule, or ''.
const MIN_CONTRAST: [string, (c: Colors) => string, (t: Record<string, string>) => number][] = [
  ['--text', (c) => c.foreground, (t) => Math.min(...textOn(t).map((s) => contrast(t['--text'], s)))],
];
/** Where --text must read: the three surfaces and the selected tint at its darkest (the ink's own tint). */
function textOn(t: Record<string, string>) {
  const ink = contrast('#ffffff', t['--panel']) > contrast('#000000', t['--panel']) ? '#ffffff' : '#000000';
  const a2 = parseInt(t['--tint-2'].slice(7, 9), 16) / 255;
  return [t['--page'], t['--panel'], t['--raised'], mixHex(t['--page'], ink, a2), mixHex(t['--panel'], ink, a2)];
}
function minContrastBreak(c: Colors, t: Record<string, string>) {
  for (const [token, source, ratio] of MIN_CONTRAST) {
    const asWritten = { ...t, [token]: source(c) };
    if (ratio(asWritten) >= AA) {
      if (t[token] !== source(c)) return `${token} moved although ${source(c)} reads ${ratio(asWritten).toFixed(2)}:1`;
    } else if (ratio(t) < Math.min(AA, Math.max(ratio({ ...t, [token]: '#ffffff' }), ratio({ ...t, [token]: '#000000' }))) - 1e-9)
      // under 4.5:1 only where no ink reaches it (a mid grey), and then the best one can
      return `${token} ${t[token]} reads ${ratio(t).toFixed(2)}:1`;
  }
  return '';
}
const SET: Record<string, string> = {
  ...THEMES,
  Dracula: DRACULA,
  'Low contrast': 'background = #0f191c\nforeground = #426644\n',
  'Mid grey': 'background = #777777\nforeground = #8a8a8a\n',
  'Light, red under 4.5': 'background = #ffffff\nforeground = #222222\npalette = 1=#e53935\npalette = 3=#f9a825\npalette = 8=#aaaaaa\n',
};

test('theme_roles_taken_as_written: every catalog theme sets each role token to its source field, byte for byte', () => {
  expect(Object.keys(SET).length).toBeGreaterThanOrEqual(5);
  for (const [name, text] of Object.entries(SET)) {
    const c = parseGhostty(text);
    const t = deriveTokens(c);
    for (const [token, source] of ROLES) expect(t[token], `${name} ${token}`).toBe(source(c));
    expect(minContrastBreak(c, t), name).toBe('');
  }
});

// D-20261108-11: secondary text is mixed from the theme's background and foreground and reads on the window's surfaces.
test('muted_readable_every_catalog_theme: --muted reads at 4.5:1 and --faint at 3:1 on --page and --panel; --idle follows --faint', () => {
  const names = Object.keys(THEMES);
  expect(names.length).toBeGreaterThanOrEqual(2);
  const worst = { muted: [99, ''] as [number, string], faint: [99, ''] as [number, string] };
  for (const name of names) {
    const c = parseGhostty(THEMES[name]);
    const t = deriveTokens(c);
    for (const s of ['--page', '--panel']) {
      const m = contrast(t['--muted'], t[s]);
      const f = contrast(t['--faint'], t[s]);
      expect(m, `${name} --muted on ${s}`).toBeGreaterThanOrEqual(AA);
      expect(f, `${name} --faint on ${s}`).toBeGreaterThanOrEqual(3);
      if (m < worst.muted[0]) worst.muted = [m, name];
      if (f < worst.faint[0]) worst.faint = [f, name];
    }
    expect(t['--idle'], name).toBe(t['--faint']);
    // Muted sits between faint and the text: still secondary, never the foreground unless the theme leaves no room.
    expect(contrast(t['--muted'], c.background), name).toBeGreaterThanOrEqual(contrast(t['--faint'], c.background));
  }
  console.log(`WORST muted ${worst.muted[0].toFixed(2)} (${worst.muted[1]}), faint ${worst.faint[0].toFixed(2)} (${worst.faint[1]})`);
});

test('muted_mixed_from_bg_fg: --muted starts 60% toward the foreground, --faint 42%; diff tints and the card shadow come from the theme', () => {
  const t = deriveTokens(parseGhostty('background = #000000\nforeground = #ffffff\npalette = 1=#ff0000\npalette = 2=#00ff00\n'));
  expect(t['--muted']).toBe('#999999'); // 60% of 255, already over 4.5:1
  expect(t['--faint']).toBe('#6b6b6b'); // 42% of 255, already over 3:1
  expect(t['--diff-add']).toBe(mixHex('#000000', '#00ff00', 0.15));
  expect(t['--diff-del']).toBe(mixHex('#000000', '#ff0000', 0.15));
  expect(t['--shadow-card']).toMatch(/^0 1px 3px #[0-9a-f]{8}$/);
  // A low-contrast theme: muted steps toward the foreground until it reads, faint likewise.
  const low = parseGhostty('background = #ffffff\nforeground = #555555\n');
  const l = deriveTokens(low);
  expect(contrast(l['--muted'], l['--page'])).toBeGreaterThanOrEqual(AA);
  expect(l['--muted']).not.toBe(mixHex('#ffffff', '#555555', 0.6));
});

test('theme_roles_taken_as_written: lines are plain mixes of background and foreground, hovers the text at 5%', () => {
  const t = deriveTokens(parseGhostty('background = #000000\nforeground = #ffffff\n'));
  expect(t['--hover']).toBe('#ffffff0d'); // the design book's --tint-1: the text at 5%
  expect(t['--line']).toBe('#171717'); // 9% of 255 (dark)
  expect(t['--you-bg']).toBe(mixHex('#000000', t['--you-glow'], 0.12));
});
const mixHex = (a: string, b: string, t: number) =>
  `#${[1, 3, 5].map((i) => Math.round(parseInt(a.slice(i, i + 2), 16) + (parseInt(b.slice(i, i + 2), 16) - parseInt(a.slice(i, i + 2), 16)) * t).toString(16).padStart(2, '0')).join('')}`;

test('selection_and_legend_mapped: selection takes the theme selection fields as written; the stale key takes palette 11 as written', () => {
  for (const [name, text] of Object.entries(SET)) {
    const c = parseGhostty(text);
    const t = deriveTokens(c);
    expect(t['--selection-bg'], name).toBe(c.selectionBackground);
    expect(t['--selection-text'], `${name} selection text as written`).toBe(c.selectionForeground ?? c.foreground);
    expect(t['--stale'], name).toBe(c.palette[11]);
    expect(t['--stale-line'], name).toBe(c.palette[11]);
    expect(t['--stale-bg'], name).toBe(mixHex(c.background, c.palette[11], isDark(c) ? 0.2 : 0.1));
  }
});

// Ticket 520 (owner owner 2026-11-13, amends D-20261108-11): minimum contrast for the app's chrome only. The two catalogue files
// below are iTerm2-Color-Schemes' ghostty files at the catalog's COMMIT, as the core fetches them.
const SOLARIZED_LIGHT = `palette = 0=#073642
palette = 1=#dc322f
palette = 2=#859900
palette = 3=#b58900
palette = 4=#268bd2
palette = 5=#d33682
palette = 6=#2aa198
palette = 7=#bbb5a2
palette = 8=#002b36
palette = 9=#cb4b16
palette = 10=#586e75
palette = 11=#657b83
palette = 12=#839496
palette = 13=#6c71c4
palette = 14=#93a1a1
palette = 15=#fdf6e3
background = #fdf6e3
foreground = #657b83
cursor-color = #657b83
cursor-text = #eee8d5
selection-background = #eee8d5
selection-foreground = #586e75
`;

// Ticket 561: the status words read on every window surface (--page, --panel, and for --ok-text its 6% tint) in every theme of
// a sample: the bundled catalogue, Solarized Light, and a grid of backgrounds with a foreground that pulls --page away from the
// background and status colours near the 4.5:1 edge. (The full catalogue of 243 is fetched at run time, so the bundle holds a few.)
// A mid-grey background cannot reach 4.5:1 with black or white text, so a theme counts only when its ink can.
const GRID: string[] = [];
for (const bg of ['#000000', '#1e1e2e', '#282a36', '#ffffff', '#fdf6e3', '#eff1f5', '#f0e0d0'])
  for (const fg of ['#ffffff', '#000000', '#888888'])
    for (const hue of ['#ff0000', '#00ff00', '#777777', '#bbbbbb', '#444444']) GRID.push(`background = ${bg}\nforeground = ${fg}\npalette = 1=${hue}\npalette = 2=${hue}\n`);
test('status_text_sampled_themes_561: --ok-text and --bad-text read 4.5:1 on --page, --panel and the 6% tint wherever one ink can', () => {
  let checked = 0;
  for (const text of [...Object.values(SET), SOLARIZED_LIGHT, ...GRID]) {
    const c = parseGhostty(text);
    const t = deriveTokens(c);
    const ink = isDark(c) ? '#ffffff' : '#000000';
    const tint = mixHex(c.background, c.palette[2], 0.06);
    const rows: [string, string[]][] = [['--ok-text', [t['--page'], t['--panel'], tint]], ['--bad-text', [t['--page'], t['--panel']]]];
    for (const [token, surfaces] of rows) {
      if (surfaces.some((s) => contrast(ink, s) < AA)) continue;
      checked++;
      for (const s of surfaces) expect(contrast(t[token], s), `${text.replace(/\n/g, ' ')} ${token} on ${s}`).toBeGreaterThanOrEqual(AA);
    }
  }
  expect(checked).toBeGreaterThan(200);
});

test('min_contrast_chrome_520: Solarized Light gets --text and on-accent text at 4.5:1, its terminal unchanged; Dracula derives exactly as on main', () => {
  const c = parseGhostty(SOLARIZED_LIGHT);
  const t = deriveTokens(c);
  // as written it misses: foreground 3.95:1 on --page, background on palette 4 3.41:1
  expect(contrast(c.foreground, t['--page'])).toBeLessThan(AA);
  expect(contrast(c.background, c.palette[4])).toBeLessThan(AA);
  const hover = mixHex(t['--page'], t['--hover'].slice(0, 7), parseInt(t['--hover'].slice(7, 9), 16) / 255); // the tint painted on --page
  for (const s of [t['--page'], t['--panel'], t['--raised'], hover]) expect(contrast(t['--text'], s), `--text on ${s}`).toBeGreaterThanOrEqual(AA);
  expect(contrast(t['--on-status'], t['--run']), 'on-status text on the accent fill').toBeGreaterThanOrEqual(AA);
  // the primary button (fill --text, label --panel) and secondary text follow
  expect(contrast(t['--panel'], t['--text'])).toBeGreaterThanOrEqual(AA);
  expect(contrast(t['--muted'], t['--page'])).toBeGreaterThanOrEqual(AA);
  // ticket 559 (F4): as written --ok (2.8:1 on the "In use" badge tint) and --bad (4.28:1 on the menu) miss; their text twins read 4.5:1 and the roles stay
  const surfaces = [t['--panel'], t['--raised']];
  expect(contrast(c.palette[2], mixHex(c.background, c.palette[2], 0.06))).toBeLessThan(AA);
  expect(contrast(c.palette[1], t['--panel'])).toBeLessThan(AA);
  for (const s of [...surfaces, mixHex(c.background, c.palette[2], 0.06)]) expect(contrast(t['--ok-text'], s), `--ok-text on ${s}`).toBeGreaterThanOrEqual(AA);
  for (const s of surfaces) expect(contrast(t['--bad-text'], s), `--bad-text on ${s}`).toBeGreaterThanOrEqual(AA);
  // only as far as needed: the first 5% step from the theme's own value toward black that reads (a light theme)
  const first = (from: string, ok: (v: string) => boolean) => Array.from({ length: 21 }, (_, i) => mixHex(from, '#000000', i * 0.05)).find(ok);
  expect(t['--text']).toBe(first(c.foreground, (v) => Math.min(...textOn(t).map((s) => contrast(v, s))) >= AA));
  // the reading surface and the terminal are untouched
  expect([t['--panel'], t['--on-status']]).toEqual([c.background, c.background]);
  const x = xtermTheme(c);
  expect([x.background, x.foreground, x.cursor, x.cursorAccent, x.selectionBackground, x.selectionForeground]).toEqual(['#fdf6e3', '#657b83', '#657b83', '#eee8d5', '#eee8d5', '#586e75']);
  expect([x.black, x.red, x.green, x.yellow, x.blue, x.magenta, x.cyan, x.white, x.brightBlack, x.brightRed, x.brightGreen, x.brightYellow, x.brightBlue, x.brightMagenta, x.brightCyan, x.brightWhite]).toEqual(
    SOLARIZED_LIGHT.split('\n').filter((l) => l.startsWith('palette')).map((l) => l.split('=').pop()),
  );
});
