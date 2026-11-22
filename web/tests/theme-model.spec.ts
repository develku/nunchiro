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
// Every role token is its source field, byte for byte (round 3, ticket 293 option A: no AA fit). --text and --run are
// the exception for the app's chrome (ticket 520): see MIN_CONTRAST below.
const ROLES: [string, (c: Colors) => string][] = [
  ['--ok', (c) => c.palette[2]],
  ['--done', (c) => c.palette[5]],
  ['--you', (c) => c.palette[3]],
  ['--bad', (c) => c.palette[1]],
  ['--stale', (c) => c.palette[11]],
  ['--stale-line', (c) => c.palette[11]],
  ['--warn', (c) => c.palette[11]],
  ['--panel', (c) => c.background],
  ['--raised', (c) => c.background],
  ['--on-status', (c) => c.background],
  ['--selection-bg', (c) => c.selectionBackground],
  ['--selection-text', (c) => c.selectionForeground ?? c.foreground],
];
const AA = 4.5;
// Ticket 520 (owner owner 2026-11-13, amends D-20261108-11; minimum contrast for the chrome only): --text is the foreground when it reads at 4.5:1 on
// --page and --panel, and --run is palette 4 when the --on-status text (the background) reads at 4.5:1 on it; else each
// steps toward black (light theme) or white (dark) until it does. Returns why a token breaks the rule, or ''.
const MIN_CONTRAST: [string, (c: Colors) => string, (t: Record<string, string>) => number][] = [
  ['--text', (c) => c.foreground, (t) => Math.min(contrast(t['--text'], t['--page']), contrast(t['--text'], t['--panel']))],
  ['--run', (c) => c.palette[4], (t) => contrast(t['--run'], t['--on-status'])],
];
function minContrastBreak(c: Colors, t: Record<string, string>) {
  for (const [token, source, ratio] of MIN_CONTRAST) {
    const asWritten = { ...t, [token]: source(c) };
    if (ratio(asWritten) >= AA) {
      if (t[token] !== source(c)) return `${token} moved although ${source(c)} reads ${ratio(asWritten).toFixed(2)}:1`;
    } else if (ratio(t) < AA) return `${token} ${t[token]} reads ${ratio(t).toFixed(2)}:1`;
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

// Ticket 293 option A: the fit is gone. The theme below writes your turn, broken and muted under 4.5:1 on its own background;
// each still comes out as written. The worst ratio per role over the whole set is printed and asserts nothing.
test('theme_roles_used_as_written_even_below_aa: a role colour under 4.5:1 on its surface is not moved', () => {
  const low = parseGhostty(SET['Light, red under 4.5']);
  expect(contrast(low.palette[1], low.background)).toBeLessThan(AA);
  expect(contrast(low.palette[3], low.background)).toBeLessThan(AA);
  expect(contrast(low.palette[8], low.background)).toBeLessThan(AA);
  const worst: Record<string, [number, string]> = {};
  for (const [name, text] of Object.entries(SET)) {
    const c = parseGhostty(text);
    const t = deriveTokens(c);
    for (const [token, source] of ROLES) {
      expect(t[token], `${name} ${token}`).toBe(source(c));
      const r = contrast(t[token], c.background);
      if (!worst[token] || r < worst[token][0]) worst[token] = [r, name];
    }
  }
  expect(Object.values(worst).some(([r]) => r < AA)).toBe(true);
  console.log(`WORST on background ${Object.entries(worst).map(([k, [r, n]]) => `${k} ${r.toFixed(2)} (${n})`).join(', ')}`);
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

test('muted_mixed_from_bg_fg: --muted starts 60% toward the foreground, --faint 45%; diff tints and the card shadow come from the theme', () => {
  const t = deriveTokens(parseGhostty('background = #000000\nforeground = #ffffff\npalette = 1=#ff0000\npalette = 2=#00ff00\n'));
  expect(t['--muted']).toBe('#999999'); // 60% of 255, already over 4.5:1
  expect(t['--faint']).toBe('#737373'); // 45% of 255, already over 3:1
  expect(t['--diff-add']).toBe(mixHex('#000000', '#00ff00', 0.15));
  expect(t['--diff-del']).toBe(mixHex('#000000', '#ff0000', 0.15));
  expect(t['--shadow-card']).toMatch(/^0 1px 3px #[0-9a-f]{8}$/);
  // A low-contrast theme: muted steps toward the foreground until it reads, faint likewise.
  const low = parseGhostty('background = #ffffff\nforeground = #555555\n');
  const l = deriveTokens(low);
  expect(contrast(l['--muted'], l['--page'])).toBeGreaterThanOrEqual(AA);
  expect(l['--muted']).not.toBe(mixHex('#ffffff', '#555555', 0.6));
});

test('theme_roles_taken_as_written: lines and hovers are plain mixes of background and foreground', () => {
  const t = deriveTokens(parseGhostty('background = #000000\nforeground = #ffffff\n'));
  expect(t['--hover']).toBe('#121212'); // 7% of 255
  expect(t['--line']).toBe('#2d2d2d'); // 17.5% of 255
  expect(t['--you-bg']).toBe(mixHex('#000000', t['--you'], 0.2));
});
const mixHex = (a: string, b: string, t: number) =>
  `#${[1, 3, 5].map((i) => Math.round(parseInt(a.slice(i, i + 2), 16) + (parseInt(b.slice(i, i + 2), 16) - parseInt(a.slice(i, i + 2), 16)) * t).toString(16).padStart(2, '0')).join('')}`;

test('no_contrast_push_for_catalog_themes: no status role is changed at all, however low its contrast; only --text, --run, --ok-text and --bad-text meet 4.5:1', () => {
  // foreground 2.2:1 on the background: --text steps toward white only (ticket 520); palette 2 under 3:1 stays.
  const c = parseGhostty('background = #0f191c\nforeground = #426644\npalette = 2=#10181b\n');
  const t = deriveTokens(c);
  expect(contrast(c.foreground, c.background)).toBeLessThan(3);
  expect(contrast(t['--text'], t['--page'])).toBeGreaterThanOrEqual(AA);
  expect(t['--ok']).toBe('#10181b');
  // The ko/ status hues are not a fallback: a theme that wrote none of them does not get them.
  const mid = deriveTokens(parseGhostty('background = #777777\nforeground = #8a8a8a\n'));
  expect(mid['--ok']).toBe(DEFAULT_PALETTE[2]);
  const KO = ['#bc4c00', '#cf222e', '#0969da', '#1a7f37', '#8250df', '#f0883e', '#f85149', '#4493f8', '#3fb950', '#a371f7'];
  for (const [name, text] of Object.entries(SET)) {
    const cc = parseGhostty(text);
    const tk = deriveTokens(cc);
    for (const [token, source] of ROLES) expect(tk[token], `${name} ${token} changed`).toBe(source(cc));
    expect(minContrastBreak(cc, tk), name).toBe('');
    for (const k of ['--you', '--bad', '--run', '--ok', '--done']) expect(KO, `${name} ${k}`).not.toContain(tk[k]);
  }
});

test('selection_and_legend_mapped: selection takes the theme selection fields as written; the stale key and warn take palette 11 as written', () => {
  for (const [name, text] of Object.entries(SET)) {
    const c = parseGhostty(text);
    const t = deriveTokens(c);
    expect(t['--selection-bg'], name).toBe(c.selectionBackground);
    expect(t['--selection-text'], `${name} selection text as written`).toBe(c.selectionForeground ?? c.foreground);
    expect(t['--stale'], name).toBe(c.palette[11]);
    expect(t['--stale-line'], name).toBe(c.palette[11]);
    expect(t['--warn'], name).toBe(c.palette[11]);
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
const DRACULA_FILE = `${DRACULA}cursor-color = #f8f8f2\ncursor-text = #282a36\nselection-foreground = #ffffff\n`;
// Dracula's derived tokens on main before ticket 520 (it already passes, so nothing may move). Ticket 561 moved --bad-text only: #ff5555 read 4.05:1 on --page.
// Ticket 1039 adds the three chat roles (--chat-code, --chat-link as written; --chat-mark stepped from 4.0:1) and moves nothing.
const DRACULA_ON_MAIN = {"--tint-1":"#f8f8f20e","--tint-2":"#f8f8f21a","--select-text":"#f8f8f2","--glass-bg":"#41434d80","--glass-hi":"#ffffff24","--shadow-float":"0 12px 32px #00000073, 0 1px 3px #0000004d","--ring-focus":"#959699","--light-run":"#bd93f9","--light-you":"#f1fa8c","--light-bad":"#ff5e5e","--light-limited":"#ffffa5","--panel":"#282a36","--raised":"#282a36","--on-status":"#282a36","--text":"#f8f8f2","--page":"#30323e","--hover":"#373843","--line":"#4c4e57","--muted":"#a5a6a7","--faint":"#86878b","--idle":"#86878b","--run":"#bd93f9","--ok":"#50fa7b","--ok-text":"#50fa7b","--done":"#ff79c6","--you":"#f1fa8c","--you-bg":"#505447","--bad":"#ff5555","--bad-text":"#ff6f6f","--stale":"#ffffa5","--stale-bg":"#53554c","--stale-line":"#ffffa5","--warn":"#ffffa5","--diff-add":"#2e4940","--diff-del":"#48303b","--syn-keyword":"#fe8ccd","--syn-string":"#50fa7b","--syn-func":"#c6a2f8","--syn-const":"#8be9fd","--syn-type":"#f1fa8c","--syn-comment":"#afb0b0","--syn-punct":"#cecfcc","--chat-code":"#ff79c6","--chat-link":"#8be9fd","--chat-mark":"#a286ce","--shadow-card":"0 1px 3px #0c0d105c","--selection-bg":"#44475a","--selection-text":"#ffffff"};

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
  for (const s of ['--page', '--panel', '--raised', '--hover']) expect(contrast(t['--text'], t[s]), `--text on ${s}`).toBeGreaterThanOrEqual(AA);
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
  expect(t['--text']).toBe(first(c.foreground, (v) => Math.min(contrast(v, t['--page']), contrast(v, t['--panel'])) >= AA));
  expect(t['--run']).toBe(first(c.palette[4], (v) => contrast(v, c.background) >= AA));
  // the status roles, surfaces and the terminal are untouched
  expect([t['--panel'], t['--on-status'], t['--ok'], t['--bad'], t['--you'], t['--done']]).toEqual([c.background, c.background, c.palette[2], c.palette[1], c.palette[3], c.palette[5]]);
  const x = xtermTheme(c);
  expect([x.background, x.foreground, x.cursor, x.cursorAccent, x.selectionBackground, x.selectionForeground]).toEqual(['#fdf6e3', '#657b83', '#657b83', '#eee8d5', '#eee8d5', '#586e75']);
  expect([x.black, x.red, x.green, x.yellow, x.blue, x.magenta, x.cyan, x.white, x.brightBlack, x.brightRed, x.brightGreen, x.brightYellow, x.brightBlue, x.brightMagenta, x.brightCyan, x.brightWhite]).toEqual(
    SOLARIZED_LIGHT.split('\n').filter((l) => l.startsWith('palette')).map((l) => l.split('=').pop()),
  );
  // a passing theme is byte-for-byte what main derived (plus the ticket 1041 tokens, first 11 keys)
  expect(deriveTokens(parseGhostty(DRACULA_FILE))).toEqual(DRACULA_ON_MAIN);
});
