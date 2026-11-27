// Design book contrast (docs/design/design-book/index.html, pairs()): every bundled and catalog theme, run through the
// window's derive rule, reads each word pair at 4.5:1 and each mark pair at 3:1 on every surface it sits on.
// Pure functions, no page.
import { expect, test } from '@playwright/test';
import { THEMES } from '../src/themes/catalog/catalog.gen';
import { contrast, deriveTokens } from '../src/themes/derive';
import { parseGhostty, type ThemeColors } from '../src/themes/ghostty';
import { DARK_PICK, LIGHT_PICK } from '../src/themes/nunchiro';

const ch = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const hx = (c: number[]) => `#${c.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')}`;
const mix = (a: string, b: string, t: number) => hx(ch(a).map((v, i) => v + (ch(b)[i] - v) * t));
/** `fg` at alpha `a` painted on `bg`. */
const over = (fg: string, a: number, bg: string) => mix(bg, fg, a);
/** An #rrggbbaa (or #rrggbb) token painted on `under`. */
const on = (v: string, under: string) => over(v.slice(0, 7), v.length > 7 ? parseInt(v.slice(7, 9), 16) / 255 : 1, under);

type Pair = { label: string; fg: string; bg: string; min: number };

/** The book's pairs(), reading the window's token names. */
function pairs(t: Record<string, string>): Pair[] {
  const v = (k: string) => {
    const x = t[k];
    if (!x) throw new Error(`deriveTokens sets no ${k}`);
    return x;
  };
  const [page, panel, raised] = [v('--page'), v('--panel'), v('--raised')];
  const sel = on(v('--tint-2'), page), selP = on(v('--tint-2'), panel);
  const sec = on(v('--tint-2'), raised), secH = on(v('--tint-3'), raised), field = on(v('--tint-1'), panel);
  const wash = over(v('--you-glow'), 0.14, page);
  const gc = on(v('--glass-chrome'), page), gf = on(v('--glass-float'), panel), gfr = on(v('--glass-float'), raised);
  const hov = mix(v('--primary'), v('--text'), 0.1), prs = mix(v('--primary'), v('--text'), 0.18);
  const P: Pair[] = [];
  const add = (label: string, fg: string, bgs: [string, string][], min: number) =>
    bgs.forEach(([n, bg]) => P.push({ label: `${label} on ${n}`, fg, bg, min }));
  const S: [string, string][] = [['page', page], ['panel', panel], ['raised', raised], ['selected row', sel]];
  const B3: [string, string][] = [['page', page], ['panel', panel], ['raised', raised]];
  const diff: [string, string][] = [['raised', raised], ['added line', v('--diff-add')], ['removed line', v('--diff-del')]];
  add('text', v('--text'), [...S, ['secondary button', sec], ['secondary hover', secH], ['field', field], ['chrome glass', gc], ['float glass', gf], ['float glass on card', gfr]], 4.5);
  add('muted', v('--muted'), [...S, ['selected (panel)', selP], ['field (placeholder)', field], ['chrome glass', gc], ['float glass', gf]], 4.5);
  add('needs-you words', v('--you-text'), [...B3, ['needs-you wash', wash], ['chrome glass', gc]], 4.5);
  add('failed words', v('--bad-text'), [...S, ['chrome glass', gc], ['float glass', gf]], 4.5);
  add('near-limit figure', v('--warn-text'), [['page', page], ['raised', raised], ['chrome glass', gc], ['float glass', gf]], 4.5);
  add('primary label', v('--on-primary'), [['primary', v('--primary')], ['primary hover', hov], ['primary pressed', prs]], 4.5);
  add('code text', v('--chat-code'), [['panel', panel], ['raised', raised]], 4.5);
  add('keyword', v('--syn-keyword'), diff, 4.5);
  add('string', v('--syn-string'), diff, 4.5);
  add('line number', v('--muted'), diff, 4.5);
  add('focus ring', v('--accent'), [...S, ['chrome glass', gc]], 3);
  add('working dot', v('--light-run'), [...S, ['chrome glass', gc]], 3);
  add('needs-you dot', v('--light-you'), [...B3, ['needs-you wash', wash], ['chrome glass', gc]], 3);
  add('failed dot', v('--light-bad'), [...S, ['chrome glass', gc]], 3);
  add('done ring', v('--light-done'), S, 3);
  add('done and added words', v('--ok-text'), S, 4.5);
  add('idle ring, control edge', v('--faint'), B3, 3);
  add('redline, near-limit arc', v('--light-warn'), [['page', page], ['raised', raised], ['chrome glass', gc]], 3);
  add('checked control (ink)', v('--text'), [['panel', panel], ['raised', raised]], 3);
  // Old names that many rules still paint as words (color: var(--you) ...), and the old focus ring name.
  for (const k of ['--you', '--bad', '--ok', '--done', '--warn', '--run']) add(`old ${k} as words`, v(k), S, 4.5);
  add('old --ring-focus', v('--ring-focus'), [...S, ['chrome glass', gc]], 3);
  return P;
}

const ALL: [string, ThemeColors][] = [
  ['Nunchiro Light', LIGHT_PICK.colors],
  ['Nunchiro Dark', DARK_PICK.colors],
  ...Object.entries(THEMES).map(([name, text]) => [name, parseGhostty(text)] as [string, ThemeColors]),
];

/** Pairs a theme cannot reach (a mid-grey background has no colour that reads on every surface); derive returns its best.
 *  `theme: pair` -> the measured ratio. Each entry must still fail at that ratio, so a fixed theme drops off this list. */
const ALLOWED: Record<string, number> = {};

test('book_contrast: every bundled and catalog theme reads the book pairs through deriveTokens', { tag: '@chromium' }, () => {
  const failing: string[] = [];
  const allowed: string[] = [];
  for (const [name, c] of ALL) {
    for (const p of pairs(deriveTokens(c))) {
      const r = contrast(p.fg, p.bg);
      if (r >= p.min) continue;
      const key = `${name}: ${p.label}`;
      if (key in ALLOWED && Math.abs(ALLOWED[key] - r) < 0.01) allowed.push(key);
      else failing.push(`${key} ${r.toFixed(2)} < ${p.min} (${p.fg} on ${p.bg})`);
    }
  }
  expect(failing, 'pairs under their minimum').toEqual([]);
  expect(allowed.sort(), 'every allowlisted pair still fails at its listed ratio').toEqual(Object.keys(ALLOWED).sort());
});
