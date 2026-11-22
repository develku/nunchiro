// Ticket 1041 lane 1 (A+B+C tokens): every gallery theme, the derived Nunchiro pair and a few hard themes get the new
// tokens, words at 4.5:1 and marks (the focus ring and the four state lights) at 3:1 on --page, --panel and the selected
// tint step. Pure functions, no page; the tokens.css side (bundled values, the shared rules) is checked from the file.
import fs from 'node:fs';
import { expect, test } from '@playwright/test';
import { THEMES } from '../src/themes/catalog/catalog.gen';
import { contrast, deriveTokens } from '../src/themes/derive';
import { parseGhostty } from '../src/themes/ghostty';
import { NUNCHIRO_DARK, NUNCHIRO_LIGHT } from '../src/themes/nunchiro';

const HARD: Record<string, string> = {
  'Mid grey': 'background = #777777\nforeground = #8a8a8a\n',
  'Low contrast dark': 'background = #0f191c\nforeground = #426644\n',
  'Washed light': 'background = #f0f0f0\nforeground = #a0a0a0\npalette = 1=#ffb0b0\npalette = 3=#ffffb0\npalette = 4=#b0b0ff\npalette = 11=#ffff80\n',
};
// GALLERY_DIR=<a checkout's ghostty/ folder at the catalog pin> adds the whole online gallery (861 themes at 04a98db0);
// the gate runs offline on the bundled catalog, the derived pair and the hard themes.
const gallery = process.env.GALLERY_DIR ? fs.readdirSync(process.env.GALLERY_DIR).map((f): [string, string] => [f, fs.readFileSync(`${process.env.GALLERY_DIR}/${f}`, 'utf8')]) : [];
const SET: [string, string][] = [...Object.entries(THEMES), ['Nunchiro light (derived)', NUNCHIRO_LIGHT], ['Nunchiro dark (derived)', NUNCHIRO_DARK], ...Object.entries(HARD), ...gallery];

/** A #rrggbbaa over an opaque #rrggbb, as the browser composites it. */
const over = (base: string, top: string) => {
  const ch = (h: string, i: number) => parseInt(h.slice(i, i + 2), 16);
  const a = ch(top, 7) / 255;
  return `#${[1, 3, 5].map((i) => Math.round(ch(base, i) + (ch(top, i) - ch(base, i)) * a).toString(16).padStart(2, '0')).join('')}`;
};
const NEW = ['--tint-1', '--tint-2', '--select-text', '--glass-bg', '--glass-hi', '--shadow-float', '--ring-focus', '--light-run', '--light-you', '--light-bad', '--light-limited'];

test('polish_tokens_every_theme_1041: new tokens derived for every gallery theme; words 4.5:1, ring and lights 3:1', () => {
  expect(SET.length).toBeGreaterThanOrEqual(7 + gallery.length);
  const worst: Record<string, [number, string]> = {};
  const note = (k: string, r: number, name: string) => (!worst[k] || r < worst[k][0]) && (worst[k] = [r, name]);
  for (const [name, text] of SET) {
    const t = deriveTokens(parseGhostty(text));
    for (const k of NEW) expect(t[k], `${name} ${k}`).toBeTruthy();
    expect(t['--tint-1'], name).toMatch(/^#[0-9a-f]{8}$/);
    expect(t['--glass-bg'], name).toMatch(/^#[0-9a-f]{8}$/);
    const base = [t['--page'], t['--panel']];
    const selected = base.map((b) => over(b, t['--tint-2']));
    // 4.5:1, or on a mid grey where neither white nor black reaches it, the best either can (as the syntax roles do).
    const reach = Math.min(4.5, Math.max(...['#ffffff', '#000000'].map((v) => Math.min(...selected.map((s) => contrast(v, s))))));
    for (const s of selected) {
      const r = contrast(t['--select-text'], s);
      expect(r, `${name} --select-text on the selected step`).toBeGreaterThanOrEqual(reach - 1e-9);
      note('--select-text', r, name);
    }
    // The primary button: label --control-text (= --panel) on --control-bg (= --text).
    expect(contrast(t['--panel'], t['--text']), `${name} primary button`).toBeGreaterThanOrEqual(4.5);
    // --error is --bad-text.
    for (const s of base) expect(contrast(t['--bad-text'], s), `${name} --error on ${s}`).toBeGreaterThanOrEqual(4.5);
    for (const k of ['--ring-focus', '--light-run', '--light-you', '--light-bad', '--light-limited'])
      for (const s of [...base, ...selected]) {
        const r = contrast(t[k], s);
        expect(r, `${name} ${k} on ${s}`).toBeGreaterThanOrEqual(3);
        note(k, r, name);
      }
  }
  console.log(`WORST ${Object.entries(worst).map(([k, [r, n]]) => `${k} ${r.toFixed(2)} (${n})`).join(', ')}`);
});

test('polish_tokens_passing_theme_kept_1041: a light that already reads 3:1 is the theme colour as written', () => {
  const c = parseGhostty(THEMES['Catppuccin Mocha']);
  const t = deriveTokens(c);
  expect(contrast(c.palette[1], c.background)).toBeGreaterThan(3);
  expect(t['--light-bad']).toBe(c.palette[1]);
  expect(t['--light-run']).toBe(t['--run']);
});

const css = fs.readFileSync(new URL('../src/tokens.css', import.meta.url), 'utf8');
const rules = fs.readFileSync(new URL('../src/light-glass.css', import.meta.url), 'utf8');

test('polish_tokens_bundled_1041: light, dark (media) and dark (attribute) each set the themed tokens; the roles keep their meaning', () => {
  for (const k of ['--tint-1', '--tint-2', '--glass-bg', '--glass-hi', '--shadow-float', '--ring-focus'])
    expect(css.match(new RegExp(`^\\s*${k}:`, 'gm'))?.length, k).toBe(3);
  for (const [k, v] of [
    ['--error', 'var(--bad-text)'],
    ['--light-limited', 'var(--warn)'],
    ['--light-run', 'var(--run)'],
    ['--control-bg', 'var(--text)'],
    ['--fs-1', 'var(--fs-11)'],
    ['--fs-2', 'var(--fs-13)'],
    ['--fs-3', 'var(--fs-15)'],
    ['--accent', 'var(--run)'],
    ['--focus-ring', 'var(--accent)'],
  ])
    expect(css, k).toMatch(new RegExp(`^\\s*${k}: ${v.replace(/[()]/g, '\\$&')};`, 'm'));
});

test('polish_rules_1041: the shared state light holds still under reduced motion; glass has an opaque reduced-transparency form', () => {
  for (const c of ['light-run', 'light-you', 'light-bad', 'light-limited', 'light-edge', 'glow-you', 'glow-bad', 'glow-limited', 'glass']) expect(rules, c).toContain(`.${c}`);
  const still = rules.slice(rules.indexOf('@media (prefers-reduced-motion: reduce)'));
  expect(still).toMatch(/:is\(\.light-run, \.light-you\)::after \{\s*animation: none;/);
  // Ticket 1041 lane 6: every glass layer reads its fill and blur from two properties the reduced-transparency query swaps.
  expect(rules).toMatch(/@media \(prefers-reduced-transparency: reduce\) \{\s*:root \{\s*--glass-fill: var\(--raised\);\s*--glass-filter: none;/);
  expect(rules).toMatch(/\.glass,\s*:where\([^)]*\.cmenu[^)]*\) \{\s*border: 0;\s*background: var\(--glass-fill\);\s*-webkit-backdrop-filter: var\(--glass-filter\);\s*backdrop-filter: var\(--glass-filter\);/);
  // Only the two moving lights animate.
  expect(rules.match(/animation: light-/g)?.length).toBe(2);
});

test('polish_defaults_1041: new sizes only for a user who never changed them; a size picked by hand stays', async () => {
  const { DEFAULTS, heights, parse } = await import('../src/settings');
  expect([DEFAULTS.tabFont, heights(DEFAULTS)]).toEqual([13, { row: 32, arow: 24, tabh: 36 }]);
  // An older store that never touched the sizes: the old tab default moves, the row follows the new comfortable.
  const never = parse(JSON.stringify({ version: 2, density: 'comfortable', densityPicked: false, rowHeight: null, tabFont: 11.5 })).settings;
  expect([never.tabFont, heights(never)]).toEqual([13, { row: 32, arow: 24, tabh: 36 }]);
  // Picked by hand: the old comfortable keeps 30 / 24 / 32, a typed row and another tab size stay.
  const picked = parse(JSON.stringify({ version: 2, density: 'comfortable', densityPicked: true, rowHeight: null, tabFont: 12 })).settings;
  expect([picked.tabFont, heights(picked)]).toEqual([12, { row: 30, arow: 24, tabh: 32 }]);
  expect(heights(parse(JSON.stringify({ version: 2, densityPicked: true, rowHeight: 27 })).settings).row).toBe(27);
  expect(heights(parse(JSON.stringify({ version: 2, density: 'compact', densityPicked: true })).settings)).toEqual({ row: 22, arow: 20, tabh: 26 });
  // A store already at version 3 is never moved again (11.5 there was picked after the change).
  expect(parse(JSON.stringify({ version: 3, tabFont: 11.5 })).settings.tabFont).toBe(11.5);
});
