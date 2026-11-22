// Ticket 251 (needs 197 G01, G02): the Terminal page's Input and Look values and what each one means to xterm.js.
// Pure: no DOM, no React; Terminal.tsx applies the result to every open terminal when a value changes.
//
// Rows, ranges and the cursor's inactive style after Orca's terminal settings (TerminalInteractionSection.tsx,
// TerminalMacKeyboardSection.tsx, TerminalCursorAppearanceSection.tsx, TerminalAdvancedTypographyControls.tsx,
// TerminalRenderingSection.tsx, TerminalWindowSection.tsx; runtime: pane-terminal-options.ts
// `resolveTerminalCursorInactiveStyle`, terminal-appearance.ts cursor alpha), MIT License, Copyright (c) 2026 Lovecast Inc.
// Defaults are today's look and bytes (needs 102 STYLE; needs 166: Option alone stays the agent's), not Orca's where the two differ.
import type { ITerminalOptions, ITheme } from '@xterm/xterm';

export type OptionMeta = 'auto' | 'on' | 'off' | 'left' | 'right';
export type CursorShape = 'block' | 'bar' | 'underline';

export interface TermPrefs {
  /** Wheel lines per notch (xterm `scrollSensitivity`). */
  scroll: number;
  /** The same with Option held (`fastScrollSensitivity`). */
  fastScroll: number;
  /** Wheel reports per notch sent to a full-screen app that tracks the mouse (vim, less, htop). */
  tuiScroll: number;
  rightClickPaste: boolean;
  focusFollowsMouse: boolean;
  /** Characters that end a word for double-click selection (`wordSeparator`). */
  wordSeparators: string;
  optionMeta: OptionMeta;
  hidePointer: boolean;
  cursor: CursorShape;
  cursorBlink: boolean;
  cursorOpacity: number;
  fontWeight: number;
  boldWeight: number;
  ligatures: boolean;
  /** Space left of and above the text (the right edge holds the scrollbar, the bottom meets the answer strip). */
  padLeft: number;
  padTop: number;
  /** WebGL renderer; off is xterm's DOM renderer, today's. */
  gpu: boolean;
  /** Lines the window keeps above the screen (needs 191: Orca's default and range); the core keeps the whole log. */
  scrollback: number;
}
// Not here: inline images (G02, O-148). @xterm/addon-image 0.9 decodes SIXEL and iTerm2 images with WebAssembly, which
// the window's CSP (`default-src 'self'`, no 'wasm-unsafe-eval') refuses; it also has no Kitty graphics. Ticket 251 REPORT.

/** xterm.js's own word separators: today's double-click. */
export const XTERM_WORD_SEPARATORS = ' ()[]{}\',"`';

export const RANGES = {
  scroll: [0.1, 10, 0.05],
  fastScroll: [1, 20, 0.5],
  tuiScroll: [1, 10, 1],
  cursorOpacity: [0, 1, 0.05],
  fontWeight: [100, 900, 100],
  boldWeight: [100, 900, 100],
  padLeft: [0, 40, 1],
  padTop: [0, 40, 1],
  scrollback: [1000, 50000, 1],
} as const satisfies Partial<Record<keyof TermPrefs, readonly [number, number, number]>>;

const CHOICES = { optionMeta: ['auto', 'on', 'off', 'left', 'right'], cursor: ['block', 'bar', 'underline'] } as const;

export const TERM_DEFAULTS: TermPrefs = {
  scroll: 1,
  fastScroll: 5,
  tuiScroll: 1,
  rightClickPaste: false,
  focusFollowsMouse: false,
  wordSeparators: XTERM_WORD_SEPARATORS,
  optionMeta: 'auto',
  hidePointer: false,
  cursor: 'block',
  cursorBlink: false,
  cursorOpacity: 1,
  fontWeight: 400,
  boldWeight: 700,
  ligatures: false,
  padLeft: 10,
  padTop: 6,
  gpu: false,
  scrollback: 5000,
};

const onStep = (v: number, [min, max, step]: readonly [number, number, number]) => v >= min && v <= max && Number.isInteger(Math.round(((v - min) / step) * 1e6) / 1e6);

/** The stored value field by field: a field of the wrong type or out of range reads as its default, the others stay. */
export function cleanPrefs(v: unknown): TermPrefs | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const raw = v as Record<string, unknown>;
  const out = { ...TERM_DEFAULTS } as Record<string, unknown>;
  for (const [k, d] of Object.entries(TERM_DEFAULTS)) {
    const x = raw[k];
    const range = (RANGES as Record<string, readonly [number, number, number]>)[k];
    const choices = (CHOICES as Record<string, readonly string[]>)[k];
    const ok = range
      ? typeof x === 'number' && Number.isFinite(x) && onStep(x, range)
      : choices
        ? choices.includes(x as string)
        : k === 'wordSeparators'
          ? typeof x === 'string' && x.length <= 64
          : typeof x === typeof d;
    if (ok) out[k] = x;
  }
  return out as unknown as TermPrefs;
}

/** Whether xterm turns Option+key into ESC+key, given which Option key is held. `auto` keeps Option composing
 *  characters (Orca resolves auto to Meta only for an ABC/US input source the native side identifies; the window cannot read it). */
export function optionIsMeta(mode: OptionMeta, side: 'left' | 'right' | null): boolean {
  if (mode === 'on') return true;
  if (mode === 'left' || mode === 'right') return side === mode;
  return false;
}

/** The xterm options the prefs set; applied at creation and again, key by key, on every change. */
export function xtermOptions(p: TermPrefs, side: 'left' | 'right' | null = null): ITerminalOptions {
  return {
    scrollSensitivity: p.scroll,
    fastScrollSensitivity: p.fastScroll,
    // A right-click that pastes must not also select the word under it (xterm's macOS default).
    rightClickSelectsWord: !p.rightClickPaste,
    wordSeparator: p.wordSeparators,
    macOptionIsMeta: optionIsMeta(p.optionMeta, side),
    cursorStyle: p.cursor,
    // xterm's outline suits a block; a bar or underline outline draws stray strokes in an unfocused pane (Orca).
    cursorInactiveStyle: p.cursor === 'block' ? 'outline' : p.cursor,
    cursorBlink: p.cursorBlink,
    fontWeight: p.fontWeight as ITerminalOptions['fontWeight'],
    fontWeightBold: p.boldWeight as ITerminalOptions['fontWeightBold'],
    scrollback: p.scrollback,
  };
}

/** The theme with the cursor's opacity as its colour's alpha (a #rgb or #rrggbb cursor; any other colour is kept). */
export function cursorTheme(theme: ITheme, opacity: number): ITheme {
  const c = theme.cursor;
  const hex = c && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c)?.[1];
  if (opacity >= 1 || !hex) return theme;
  const full = hex.length === 3 ? [...hex].map((x) => x + x).join('') : hex;
  // #rrggbbaa: xterm parses it, and it keeps a colour-function literal out of the raw-literal ratchet
  const alpha = Math.round(opacity * 255).toString(16).padStart(2, '0');
  return { ...theme, cursor: '#' + full + alpha };
}

/** The addons the prefs load. */
export const addons = (p: TermPrefs) => ({ webgl: p.gpu, ligatures: p.ligatures });
