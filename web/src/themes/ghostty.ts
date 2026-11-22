// Ghostty-format theme files (needs 55): `key = value` lines; only the colour keys below are read.
// Theme text is untrusted (catalog, pasted imports): only `#rrggbb` values survive parsing, so nothing
// else can reach CSS or xterm. A bad line is skipped and its key keeps the default.

export interface ThemeColors {
  background: string;
  foreground: string;
  cursor: string;
  cursorText: string;
  selectionBackground: string;
  /** Absent: xterm keeps each cell's own colour under the selection. */
  selectionForeground?: string;
  /** ANSI 0-15. */
  palette: string[];
}

/** xterm.js's built-in ANSI colours, used where a file sets no palette entry. */
export const DEFAULT_PALETTE = [
  '#2e3436', '#cc0000', '#4e9a06', '#c4a000', '#3465a4', '#75507b', '#06989a', '#d3d7cf',
  '#555753', '#ef2929', '#8ae234', '#fce94f', '#729fcf', '#ad7fa8', '#34e2e2', '#eeeeec',
];
export const LINE_CAP = 1024;
/** Whole-file cap for pasted imports; catalog files are under 1 KiB. */
export const FILE_CAP = 64 * 1024;

const HEX = /^#[0-9a-f]{6}$/i;
export const isHex = (v: unknown): v is string => typeof v === 'string' && HEX.test(v);

const KEYS: Record<string, keyof Omit<ThemeColors, 'palette'>> = {
  background: 'background',
  foreground: 'foreground',
  'cursor-color': 'cursor',
  'cursor-text': 'cursorText',
  'selection-background': 'selectionBackground',
  'selection-foreground': 'selectionForeground',
};

export function parseGhostty(text: string): ThemeColors {
  const set: Partial<ThemeColors> = {};
  const palette = [...DEFAULT_PALETTE];
  for (const line of text.slice(0, FILE_CAP).split(/\r?\n/)) {
    if (line.length > LINE_CAP) continue;
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    const key = t.slice(0, eq).trim();
    const value = t.slice(eq + 1).trim();
    if (key === 'palette') {
      const m = /^(\d{1,2})\s*=\s*(\S+)$/.exec(value);
      const n = m ? Number(m[1]) : -1;
      if (m && n <= 15 && isHex(m[2])) palette[n] = m[2].toLowerCase();
    } else if (KEYS[key] && isHex(value)) {
      set[KEYS[key]] = value.toLowerCase();
    }
  }
  const background = set.background ?? '#000000';
  const foreground = set.foreground ?? '#ffffff';
  return {
    background,
    foreground,
    cursor: set.cursor ?? foreground,
    cursorText: set.cursorText ?? background,
    selectionBackground: set.selectionBackground ?? foreground,
    ...(set.selectionForeground ? { selectionForeground: set.selectionForeground } : set.selectionBackground ? {} : { selectionForeground: background }),
    palette,
  };
}

/** Validates stored colours (settings store) the same way the parser does; null when anything is off. */
export function validColors(v: unknown): ThemeColors | null {
  if (!v || typeof v !== 'object') return null;
  const c = v as Record<string, unknown>;
  const keys = ['background', 'foreground', 'cursor', 'cursorText', 'selectionBackground'] as const;
  if (!keys.every((k) => isHex(c[k]))) return null;
  if (c.selectionForeground !== undefined && !isHex(c.selectionForeground)) return null;
  if (!Array.isArray(c.palette) || c.palette.length !== 16 || !c.palette.every(isHex)) return null;
  const out: ThemeColors = {
    background: c.background as string,
    foreground: c.foreground as string,
    cursor: c.cursor as string,
    cursorText: c.cursorText as string,
    selectionBackground: c.selectionBackground as string,
    palette: [...(c.palette as string[])],
  };
  if (c.selectionForeground !== undefined) out.selectionForeground = c.selectionForeground as string;
  return out;
}
