// Window tokens from a theme's colours (needs 28, 55, 212; ticket 293 option A, amended by D-20261108-11). A catalog or
// imported theme is applied as written: one fixed role table takes each token straight from a theme field, with no fixed
// status set (the user picks another theme if one reads badly; the non-colour cues, glyphs and shapes, carry the state).
// One exception, for the app's own chrome only (ticket 520, owner owner 2026-11-13, amends D-20261108-11; minimum contrast as iTerm2 and Ghostty name
// it): when the foreground reads under 4.5:1 on --page or --panel, --text steps toward black (a light theme) or white (a
// dark one) only until it reads 4.5:1; when the --on-status text (the background) reads under 4.5:1 on the accent fill
// (palette 4), --run steps the same way; --ok-text and --bad-text (the status colours as words in the chrome: the "In use"
// badge, the danger menu item; ticket 559) step the same way from palette 2 and 1, while --ok and --bad stay as written. A theme that passes keeps every value as written, and the terminal's colours
// (xtermTheme below) are never touched. Lines, hovers, the page step, the diff tints and the card shadow are plain mixes of
// the theme's own colours. Secondary text (--muted, --faint, --idle) is a mix of background and foreground too, not
// palette 8 (D-20261108-11: palette 8 read at 1.9-2.5:1 in Settings): --muted starts 60% toward the foreground and
// --faint 45%, each stepping toward --text until it reads at 4.5:1 (--muted) or 3:1 (--faint) on --page and
// --panel, or reaches the foreground. The window paints the two bundled Nunchiro themes from tokens.css exactly:
// themes/apply.ts removes the overrides for them instead of calling this (the gallery's mini window maps their colours
// like any theme's). The terminal takes the colours as they are. The R8 names (--bg, --g0..--g7, --ink, ...) are
// aliases in tokens.css and follow these roles.
//
// Role table (theme field -> token): palette 4 -> --run (the accent), 3 -> --you (your turn), 1 -> --bad, 2 -> --ok,
// 5 -> --done, 11 -> --stale, --stale-line and --warn; foreground -> --text; background -> --panel, --raised and
// --on-status; selectionBackground -> --selection-bg, selectionForeground (else the foreground) -> --selection-text
// (applied by themes/apply.ts as the window's ::selection). Syntax (--syn-*): 5 magenta -> keyword, 2 green -> string,
// 4 blue -> function, 6 cyan -> constant, 3 yellow -> type, comment and punctuation from background/foreground mixes;
// each made readable on the panel and diff tints (deriveTokens below). Chat marks (ticket 1039, owner 2026-11-21, approved
// mockup docs/design/chat-theme-1121; chat/chat.css, off with Settings > Appearance > Chat colours > Plain): 5 magenta ->
// --chat-code (inline code and file paths), 6 cyan -> --chat-link, 4 mixed 25% toward the background -> --chat-mark
// (list markers); headings and bold read --chat-accent (ticket 1064, 1088: the theme's own colour by default, themeColour() below, or palette slot 1-6 by Settings > Appearance > Chat accent;
// chatAccent() below, set by themes/apply.ts, which also redoes --chat-mark for the slot); tool names read --run, success and error words --ok-text and --bad-text. Each
// steps toward black or white only until it reads at 4.5:1 on what it is drawn on: the chat surface (the background),
// and for --chat-code the inline code background (--page) too. The body text stays --text.
import type { ITheme } from '@xterm/xterm';
import type { ThemeColors } from './ghostty';

const channels = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const hex = (c: number[]) => `#${c.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')}`;
const mix = (a: string, b: string, t: number) => {
  const x = channels(a);
  const y = channels(b);
  return hex(x.map((v, i) => v + (y[i] - v) * t));
};

export function luminance(h: string) {
  const [r, g, b] = channels(h).map((v) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

/** Dark when white text reads better on the background than black. */
const WHITE = '#ffffff';
const BLACK = '#000000';
export const isDark = (c: ThemeColors) => contrast(WHITE, c.background) > contrast(BLACK, c.background);

/** The first mix from `start` toward each colour of `toward` in turn (5% steps, from `t` of the way to the first) that
 *  reads at `min` on every surface. When none does: with `best`, the colour with the best worst-case ratio over the
 *  surfaces among every step tried, each colour of `toward`, white and black (review r1: on a mid-grey background the two
 *  diff tints sit either side of where white stops beating black, so no one colour reaches 4.5:1 on all three); else the
 *  last of `toward`. */
function readable(start: string, toward: string[], min: number, surfaces: string[], t = 0, best = false) {
  const worst = (v: string) => Math.min(...surfaces.map((s) => contrast(v, s)));
  const tried: string[] = [];
  let from = start;
  for (const to of toward) {
    for (; t < 1; t += 0.05) {
      const v = mix(from, to, t);
      if (worst(v) >= min) return v;
      tried.push(v);
    }
    [from, t] = [to, 0];
  }
  if (!best) return from;
  return [...tried, ...toward, WHITE, BLACK].reduce((a, b) => (worst(b) > worst(a) ? b : a));
}

const chroma = (h: string) => (Math.max(...channels(h)) - Math.min(...channels(h))) / 255;
/** Ticket 1088 (owner: the chat accent follows the theme): a theme file names no main colour, so it is the cursor's colour
 *  when the theme gave the cursor a colour of its own (Catppuccin Latte's rosewater), else the most saturated of palette 3-6
 *  (the first on a tie). Most cursors are the foreground grey, and palette 4 alone is blue in nearly every theme; red and
 *  green are left out because the chat uses them for errors and success. */
export function themeColour(c: ThemeColors): string {
  if (chroma(c.cursor) >= 0.25) return c.cursor;
  return [3, 4, 5, 6].map((i) => c.palette[i]).reduce((a, b) => (chroma(b) > chroma(a) ? b : a));
}

/** Ticket 1064, 1088: the chat's accent (headings, bold) and its list-marker mix from palette slot `slot` (1-6), or the theme's
 *  own colour for 0 (the default). Kept out of deriveTokens: the working light and --run stay on slot 4. */
export function chatAccent(c: ThemeColors, slot: number): Record<string, string> {
  const ink = isDark(c) ? WHITE : BLACK;
  const p = slot ? c.palette[slot] : themeColour(c);
  return {
    '--chat-accent': readable(p, [ink], 4.5, [c.background]),
    '--chat-mark': readable(mix(p, c.background, 0.25), [ink], 4.5, [c.background]),
  };
}

export function deriveTokens(c: ThemeColors): Record<string, string> {
  const p = c.palette;
  const dark = isDark(c);
  const tintShare = dark ? 0.2 : 0.1;
  const page = mix(c.background, c.foreground, 0.04);
  const surfaces = [page, c.background];
  // Minimum contrast for the chrome (ticket 520): each is the theme's own value when it already reads at 4.5:1.
  const ink = dark ? WHITE : BLACK;
  const text = readable(c.foreground, [ink], 4.5, surfaces);
  const accent = readable(p[4], [ink], 4.5, [c.background]);
  // Ticket 559 (F4): the two status colours that the chrome also draws as words (the "In use" badge on its 6% tint, the danger menu
  // item) get a text twin by the same rule on the same surfaces as --text (ticket 561); --ok and --bad themselves stay as written (dots, fills, lines).
  const okText = readable(p[2], [ink], 4.5, [...surfaces, mix(c.background, p[2], 0.06)]);
  const badText = readable(p[1], [ink], 4.5, surfaces);
  const faint = readable(c.background, [text], 3, surfaces, 0.45);
  const diffAdd = mix(c.background, p[2], dark ? 0.15 : 0.08);
  const diffDel = mix(c.background, p[1], dark ? 0.15 : 0.08);
  // Syntax (ticket 482): each role starts at an ANSI colour, as bat's `ansi` theme and delta do, and steps toward the
  // foreground (then white or black, when the foreground itself reads under 4.5:1 on a tint) until it reads at 4.5:1 on
  // the panel and both diff tints, or as near as one colour can (a mid-grey background). Comment and punctuation start as
  // background/foreground mixes like --muted.
  const code = [c.background, diffAdd, diffDel];
  const syntax = (start: string, t = 0) => readable(start, [c.foreground, dark ? WHITE : BLACK], 4.5, code, t, true);
  // Ticket 1041 lane 1 (A+B+C): the surface steps are the theme's own text at a low alpha, as the mockup's are ink at
  // 4.5% and 8.5% (light) or white at 5.5% and 10% (dark); glass is the background at 60% (light) or a lifted
  // background at 50% (dark). Words on the selected step read 4.5:1 (on a mid grey, where no ink can, the best one); the focus ring and the four state lights are marks
  // and read 3:1 on --page, --panel and the selected step, stepping toward black or white only as far as needed.
  const alpha = (v: string, a: number) => `${v}${Math.round(a * 255).toString(16).padStart(2, '0')}`;
  const [t1, t2] = dark ? [0.055, 0.1] : [0.045, 0.085];
  const a2 = Math.round(t2 * 255) / 255; // the alpha --tint-2 is written with, so the check sees what the browser paints
  const selected = [mix(page, text, a2), mix(c.background, text, a2)];
  const marks = [...surfaces, ...selected];
  const mark = (start: string) => readable(start, [ink], 3, marks);
  return {
    '--tint-1': alpha(text, t1),
    '--tint-2': alpha(text, t2),
    '--select-text': readable(text, [ink], 4.5, selected, 0, true),
    '--glass-bg': dark ? alpha(mix(c.background, c.foreground, 0.12), 0.5) : alpha(c.background, 0.6),
    '--glass-hi': alpha(WHITE, dark ? 0.14 : 0.85),
    '--shadow-float': `0 12px 32px ${alpha(BLACK, dark ? 0.45 : 0.14)}, 0 1px 3px ${alpha(BLACK, dark ? 0.3 : 0.08)}`,
    '--ring-focus': readable(mix(c.background, text, 0.5), [text, ink], 3, marks),
    '--light-run': mark(accent),
    '--light-you': mark(p[3]),
    '--light-bad': mark(p[1]),
    '--light-limited': mark(p[11]),
    '--panel': c.background,
    '--raised': c.background,
    '--on-status': c.background,
    '--text': text,
    '--page': page,
    '--hover': mix(c.background, c.foreground, 0.07),
    '--line': mix(c.background, c.foreground, 0.175),
    '--muted': readable(c.background, [text], 4.5, surfaces, 0.6),
    '--faint': faint,
    '--idle': faint,
    '--run': accent,
    '--ok': p[2],
    '--ok-text': okText,
    '--done': p[5],
    '--you': p[3],
    '--you-bg': mix(c.background, p[3], tintShare),
    '--bad': p[1],
    '--bad-text': badText,
    '--stale': p[11],
    '--stale-bg': mix(c.background, p[11], tintShare),
    '--stale-line': p[11],
    '--warn': p[11],
    '--diff-add': diffAdd,
    '--diff-del': diffDel,
    '--syn-keyword': syntax(p[5]),
    '--syn-string': syntax(p[2]),
    '--syn-func': syntax(p[4]),
    '--syn-const': syntax(p[6]),
    '--syn-type': syntax(p[3]),
    '--syn-comment': syntax(c.background, 0.6),
    '--syn-punct': syntax(c.background, 0.8),
    '--chat-code': readable(p[5], [ink], 4.5, [c.background, page]),
    '--chat-link': readable(p[6], [ink], 4.5, [c.background]),
    '--chat-mark': readable(mix(p[4], c.background, 0.25), [ink], 4.5, [c.background]),
    '--shadow-card': `0 1px 3px ${mix(c.background, BLACK, 0.7)}${dark ? '5c' : '1f'}`,
    '--selection-bg': c.selectionBackground,
    '--selection-text': c.selectionForeground ?? c.foreground,
  };
}

export function xtermTheme(c: ThemeColors): ITheme {
  const [black, red, green, yellow, blue, magenta, cyan, white, brightBlack, brightRed, brightGreen, brightYellow, brightBlue, brightMagenta, brightCyan, brightWhite] = c.palette;
  return {
    background: c.background,
    foreground: c.foreground,
    cursor: c.cursor,
    cursorAccent: c.cursorText,
    selectionBackground: c.selectionBackground,
    selectionForeground: c.selectionForeground,
    black, red, green, yellow, blue, magenta, cyan, white,
    brightBlack, brightRed, brightGreen, brightYellow, brightBlue, brightMagenta, brightCyan, brightWhite,
  };
}
