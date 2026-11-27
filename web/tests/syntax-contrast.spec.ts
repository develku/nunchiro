// Syntax colours follow the theme (ticket 482, owner 2026-11-12). Pure functions, no page: every --syn-* token reads at
// 4.5:1 or more on --panel, --raised, --diff-add and --diff-del, for tokens.css's two Nunchiro themes, the bundled catalog, the
// Nunchiro theme files run through deriveTokens, and a few hard themes (a pale light one, a low-contrast dark one).
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { THEMES } from '../src/themes/catalog/catalog.gen';
import { highlight } from '../src/files/highlight';
import { contrast, deriveTokens } from '../src/themes/derive';
import { parseGhostty } from '../src/themes/ghostty';
import { NUNCHIRO_DARK, NUNCHIRO_LIGHT } from '../src/themes/nunchiro';

const ROLES = ['keyword', 'string', 'func', 'const', 'type', 'comment', 'punct'];
const SURFACES = ['--panel', '--raised', '--diff-add', '--diff-del']; // --raised: the design book's code and card surface

// Hard cases: Solarized Light's foreground reads at 4.1:1 on its own background; a dull grey dark theme.
const PALE_LIGHT = `background = #fdf6e3
foreground = #657b83
palette = 1=#dc322f
palette = 2=#859900
palette = 3=#b58900
palette = 4=#268bd2
palette = 5=#d33682
palette = 6=#2aa198
`;
const DULL_DARK = `background = #3a3a3a
foreground = #8a8a8a
palette = 1=#7a4a4a
palette = 2=#4a6a4a
palette = 3=#6a6a3a
palette = 4=#3a4a7a
palette = 5=#6a3a6a
palette = 6=#3a6a6a
`;
const WASHED_LIGHT = `background = #f0f0f0
foreground = #a0a0a0
palette = 1=#ffb0b0
palette = 2=#b0ffb0
palette = 3=#ffffb0
palette = 4=#b0b0ff
palette = 5=#ffb0ff
palette = 6=#b0ffff
`;

const themes: [string, string][] = [
  ...Object.entries(THEMES),
  ['Nunchiro light (derived)', NUNCHIRO_LIGHT],
  ['Nunchiro dark (derived)', NUNCHIRO_DARK],
  ['pale light', PALE_LIGHT],
  ['dull dark', DULL_DARK],
  ['washed light', WASHED_LIGHT],
];

for (const [name, text] of themes)
  test(`syntax tokens read at 4.5:1 on panel and diff tints: ${name}`, () => {
    const t = deriveTokens(parseGhostty(text));
    for (const r of ROLES)
      for (const s of SURFACES) {
        const fg = t[`--syn-${r}`];
        expect(fg, `--syn-${r}`).toMatch(/^#[0-9a-f]{6}$/);
        expect.soft(contrast(fg, t[s]), `--syn-${r} ${fg} on ${s} ${t[s]}`).toBeGreaterThanOrEqual(4.5);
      }
  });

test('syntax tokens read at 4.5:1 on panel and diff tints: tokens.css light and dark', () => {
  const read = (f: string) => fs.readFileSync(path.resolve(import.meta.dirname, '../src', f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const css = read('tokens.css');
  const book = read('book-tokens.css');
  // The light block and the [data-theme='dark'] block of each file; book-tokens.css (loaded second) wins, var() resolved
  // within the blocks and the book's primitives.
  const prims = book.slice(0, book.indexOf(':root,'));
  const bookDark = book.slice(book.indexOf(":root[data-theme='dark'] {"));
  const blocks = [
    [book.slice(book.indexOf(":root,"), book.indexOf('@media')), css.slice(0, css.indexOf('@media'))],
    [bookDark.slice(0, bookDark.indexOf('}')), css.slice(css.indexOf(":root[data-theme='dark'] {"))],
  ];
  for (const order of blocks) {
    const v = (k: string): string => {
      const raw = [...order, prims].map((b) => new RegExp(`${k}: ([^;]+);`).exec(b)?.[1]).find(Boolean)!;
      const ref = /^var\((--[\w-]+)\)$/.exec(raw);
      return ref ? v(ref[1]) : raw;
    };
    for (const r of ROLES)
      for (const s of SURFACES) expect.soft(contrast(v(`--syn-${r}`), v(s)), `--syn-${r} on ${s}`).toBeGreaterThanOrEqual(4.5);
  }
});

// Review r1: code the CSS-variables theme left plain. Variables, parameters and object keys stay --text (as GitHub).
test('syntax roles: numbers with units, Markdown headings and bold markers, namespaces, CSS custom properties', async () => {
  const roles = async (text: string, name: string) =>
    Object.fromEntries((await highlight(text, name)).map((s) => [text.slice(s.from, s.to), s.color.slice('var(--syn-'.length, -1)]));
  // shiki stops a line after 500 ms (`tokenizeTimeLimit`, its guard for the UI thread) and leaves the rest plain. On a loaded
  // host the first line of a grammar, which compiles its patterns, can pass that (`22px` came back plain), so each check is
  // read again once the grammar is warm: the roles are what this pins, not how fast the first line is.
  const check = (text: string, name: string, want: Record<string, string>) => expect(async () => expect(await roles(text, name)).toMatchObject(want)).toPass({ timeout: 10_000 });
  await check(':root { --gap: 22px; }\n.a { margin: var(--gap); }\n', 'a.css', { '--gap': 'type', '22px': 'const' });
  await check('# Title\n\nSome **bold** here.\n', 'a.md', { '# Title': 'keyword', '**': 'keyword' });
  await check('use std::collections::HashMap;\n', 'a.rs', { std: 'type', collections: 'type', HashMap: 'type' });
});

// Review r1: a mid-grey background (about #747474 to #767676) puts the two diff tints either side of where white stops
// beating black, so no one colour reaches 4.5:1 on panel, diff-add and diff-del. There each token must be the best one
// colour can do: as good as the better of white and black (contrast depends only on luminance, and the extremes win).
// Swept over every grey and 20,000 seeded random themes; the worst ratio is printed (ticket 482 names it).
test('syntax tokens on any background: 4.5:1, else the best one colour can reach', () => {
  let seed = 482;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed / 2 ** 31);
  const hex = () => `#${Array.from({ length: 3 }, () => Math.floor(rnd() * 256).toString(16).padStart(2, '0')).join('')}`;
  const grey = (v: number) => `#${v.toString(16).padStart(2, '0').repeat(3)}`;
  const base = parseGhostty(NUNCHIRO_DARK);
  const cases = [
    ...Array.from({ length: 256 }, (_, v) => ({ ...base, background: grey(v), foreground: v < 128 ? '#ffffff' : '#000000' })),
    ...Array.from({ length: 256 }, (_, v) => ({ ...base, background: grey(v), foreground: grey(255 - v) })),
    ...Array.from({ length: 20_000 }, () => ({ ...base, background: hex(), foreground: hex(), palette: Array.from({ length: 16 }, hex) })),
  ];
  let low = { ratio: Infinity, at: '' };
  let greyLow = Infinity;
  let short = 0;
  for (const [i, c] of cases.entries()) {
    const t = deriveTokens(c);
    const worst = (v: string) => Math.min(...SURFACES.map((s) => contrast(v, t[s])));
    const bestOne = Math.max(worst('#ffffff'), worst('#000000'));
    for (const r of ROLES) {
      const w = worst(t[`--syn-${r}`]);
      if (w < 4.5) {
        short++;
        expect.soft(w, `--syn-${r} on ${c.background}: best one colour reaches ${bestOne.toFixed(3)}`).toBeGreaterThanOrEqual(Math.min(4.5, bestOne) - 1e-9);
      }
      if (w < low.ratio) low = { ratio: w, at: `${c.background} --syn-${r}` };
      if (i < 512) greyLow = Math.min(greyLow, w);
    }
  }
  console.log(`syntax worst ${low.ratio.toFixed(3)}:1 (${low.at}); greys ${greyLow.toFixed(3)}:1; ${short} of ${cases.length * ROLES.length} tokens under 4.5`);
  // The mid-grey case itself.
  const mid = deriveTokens({ ...base, background: '#757575', foreground: '#000000' });
  for (const r of ROLES) expect(mid[`--syn-${r}`]).toMatch(/^#(ffffff|000000)$/);
});
