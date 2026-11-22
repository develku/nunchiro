// Widget output rules (ticket v1b-19): a JSON array is a table, other JSON pretty-prints, anything else is text.
// Escapes are stripped here; the view renders the result as text nodes only, never HTML.

export const MAX_ROWS = 500;
export const MAX_COLUMNS = 64;

// CSI, OSC, other ESC sequences, then any C0/C1 control except tab and newline.
const ESC = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[PX^_][^\x1b]*\x1b\\|\x1b[ -/]*[0-~]|[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;
// The hidden-character rule (V2.5-49): bidi controls, zero-width and line-separator marks and tag characters would show
// the owner a different string than the code compares. One definition in three places, kept equal by
// `widgets-clean.spec.ts`: `board/rights.rs` `hidden` (the core's), `webwidgets/bridge.ts` `HIDDEN` (the bridge's start
// check; not exported, so this is a copy), and this character-class body for a `u` regex.
export const HIDDEN = '\\u061c\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u206f\\ufeff\\u{e0000}-\\u{e007f}';
const HIDDEN_RE = new RegExp(`[${HIDDEN}]`, 'gu');
export const clean = (s: string) => s.replace(ESC, '').replace(HIDDEN_RE, '');

/** At most this many characters of a one-line status are drawn (then an ellipsis); its `title` holds up to TITLE_MAX. */
export const STATUS_MAX = 200;
export const TITLE_MAX = 2000;
/** A one-line status: the cleaned text cut for drawing, and the cleaned text (longer cut) for the `title` attribute. */
export function statusLine(s: string): { text: string; title: string } {
  const chars = [...clean(s)];
  return {
    text: chars.length > STATUS_MAX ? `${chars.slice(0, STATUS_MAX).join('')}…` : chars.join(''),
    title: chars.slice(0, TITLE_MAX).join(''),
  };
}

export interface Table {
  columns: string[];
  rows: string[][];
  /** Rows in the output; more than `rows.length` when capped. */
  total: number;
  /** Distinct keys past MAX_COLUMNS, not shown. */
  dropped: number;
}

const cell = (v: unknown) => (v === undefined || v === null ? '' : clean(typeof v === 'string' ? v : JSON.stringify(v)));
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Columns are the union of object keys in first-seen order, at most MAX_COLUMNS; scalars (and arrays) go in a
 * `value` column. */
export function table(items: unknown[]): Table {
  const shown = items.slice(0, MAX_ROWS);
  const seen = new Set<string>();
  const add = (k: string) => seen.add(k);
  for (const it of shown) {
    if (isObject(it)) Object.keys(it).forEach(add);
    else add('value');
  }
  const columns = [...seen].slice(0, MAX_COLUMNS);
  const rows = shown.map((it) => columns.map((c) => (isObject(it) ? cell(it[c]) : c === 'value' ? cell(it) : '')));
  return { columns, rows, total: items.length, dropped: seen.size - columns.length };
}
