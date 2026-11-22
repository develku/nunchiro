// Hint labels (needs 118, ticket 75; ticket 389 amends needs 25 and 118). Projects and sessions read p1 p2 and s1 s2 (the
// project and session kind letters are prefixes, s1 = Cmd-1); every other target takes one letter from the set that
// matches its screen region, letters before digits; Shift + a kind letter filters to that kind.
// Owner 11-10: labels are letters and the person types the letter shown. A keydown matches by the character typed
// (KeyboardEvent.key), so any remap works (macOS layouts, Karabiner, firmware); only when an input method gives no
// plain letter (Korean or Chinese on) does the key's QWERTY letter stand in. No layout setting.
import type { Key } from './i18n';
import type { Bindings } from './keys';

/** Labelling order of the kinds: p s t l r w f u h o. */
export const KINDS = ['project', 'session', 'tab', 'left', 'right', 'pane', 'path', 'url', 'hash', 'other'] as const;
export type Kind = (typeof KINDS)[number];

export interface HintKeys {
  /** One letter per kind: p and s start labels, the rest filter under Shift. */
  kinds: Record<Kind, string>;
  /** Label letters, first = shortest labels. The p and s prefix letters stay stored here but are not used in labels. */
  alphabet: string[];
}

/** The keyboard drawn on Settings > Keys > Hints, by row (physical codes, drawn with their QWERTY letters). */
export const ROWS: string[][] = [
  ['Backquote', 'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9', 'Digit0', 'Minus', 'Equal'],
  ['KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyT', 'KeyY', 'KeyU', 'KeyI', 'KeyO', 'KeyP', 'BracketLeft', 'BracketRight', 'Backslash'],
  ['KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG', 'KeyH', 'KeyJ', 'KeyK', 'KeyL', 'Semicolon', 'Quote'],
  ['KeyZ', 'KeyX', 'KeyC', 'KeyV', 'KeyB', 'KeyN', 'KeyM', 'Comma', 'Period', 'Slash'],
];
const QWERTY = ['`1234567890-=', 'qwertyuiop[]\\', "asdfghjkl;'", 'zxcvbnm,./'];

/** The QWERTY letter of a physical key code, or '' for a key not on the drawing. */
export function letterOf(code: string): string {
  for (let r = 0; r < ROWS.length; r++) {
    const c = ROWS[r].indexOf(code);
    if (c >= 0) return QWERTY[r][c];
  }
  return '';
}
/** Every letter a hint can use: the drawn keys' QWERTY letters. */
export const DRAWN = new Set(QWERTY.join(''));

/**
 * The letter a keydown typed: its character when that is a plain Latin letter or digit (any layout or remap), else the
 * QWERTY letter of its physical key, so an input method (Korean 2-set, Chinese: key 'Process' or a jamo) still works.
 */
export function typedKey(e: { key: string; code: string }): string {
  const k = e.key.length === 1 ? e.key.toLowerCase() : '';
  return /^[a-z0-9]$/.test(k) ? k : letterOf(e.code);
}

/** Ticket 389: home row first, every letter, digits last (owner 11-10). p and s stay stored; as prefixes they do not label. */
export const DEFAULT_ALPHABET = [...'asdfjklghewruiopqtyvcmnxzb1234567890'];
/** The alphabet before ticket 389 (owner 2026-10-28); only a stored value equal to it migrates. */
const OLD_ALPHABET = [...'123456qwertyasdfgzxcvb'];

/**
 * Screen region of a target (`data-hint-region` on its container) → the letters it labels from, in order: the left bar
 * always gets a d f g q, and so on. s and p sit at the ends, used only if the prefixes are moved off them.
 */
export const REGIONS = {
  left: [...'adfgqs'],
  top: [...'werty'],
  right: [...'jklhuiop'],
  composer: [...'zxcvbnm'],
} as const;
export type Region = keyof typeof REGIONS;
export const isRegion = (v: string | undefined): v is Region => !!v && v in REGIONS;

const DEFAULT_KINDS: Record<Kind, string> = { project: 'p', session: 's', tab: 't', left: 'l', right: 'r', pane: 'w', path: 'f', url: 'u', hash: 'h', other: 'o' };
export const DEFAULT_HINT_KEYS: HintKeys = { kinds: DEFAULT_KINDS, alphabet: DEFAULT_ALPHABET };

/** Commands whose shortcut V1A-48 added; "Reset to defaults" in the Hints section clears only these bindings. */
const NEW_ICON_COMMANDS = ['sidebar.left.toggle', 'files.show', 'artifacts.toggle', 'board.toggle', 'preview.toggle'];
export function resetHintBindings(overrides: Bindings): Bindings {
  return Object.fromEntries(Object.entries(overrides).filter(([id]) => !NEW_ICON_COMMANDS.includes(id)));
}

/** The letters a user types, or a message naming the first character that cannot be used. */
export function parseAlphabet(text: string, t: (key: Key, args?: Record<string, string | number>) => string): { ok: true; keys: string[] } | { ok: false; error: string } {
  const keys: string[] = [];
  for (const ch of text) {
    if (/\s/.test(ch)) return { ok: false, error: t('own.hints.space') };
    const k = ch.toLowerCase();
    if (!DRAWN.has(k)) return { ok: false, error: t('own.hints.notDrawn', { ch }) };
    if (keys.includes(k)) return { ok: false, error: t('own.hints.twice', { ch }) };
    keys.push(k);
  }
  if (keys.length < 2) return { ok: false, error: t('own.hints.min') };
  return { ok: true, keys };
}

/** The alphabet letters labels use: the stored alphabet without the p and s prefix letters. */
export function effectiveAlphabet(keys: HintKeys): string[] {
  return keys.alphabet.filter((c) => c !== keys.kinds.project && c !== keys.kinds.session);
}

/** One mark value on an element (`data-hint-kind`) as a kind; Sidebar and RowIcon still say `agent` for a session. */
export function kindOfMark(mark: string | undefined): Kind | null {
  if (mark === 'agent') return 'session';
  return (KINDS as readonly string[]).includes(mark ?? '') ? (mark as Kind) : null;
}

export interface HintItem {
  kind: Kind;
  /** Position inside the kind. A project's row rank; a session's or tab's slot: tab order, then tree order. */
  order: number;
  /** The icon-bar command, kept for tests and for the label's data attribute. */
  icon?: string;
  /** The screen region its one-letter label comes from. */
  region?: Region;
  /** Labelled only under Shift + its kind letter (rare controls). Panes are always quiet. */
  quiet?: boolean;
}

/** Prefix-free labels, shortest first: as many one-key labels as fit, the last key of the shortest level giving way to longer ones. */
function codesFor(count: number, alphabet: string[]): string[][] {
  if (!alphabet.length) return [];
  let leaves = alphabet.map((c) => [c]);
  while (leaves.length < count && alphabet.length > 1) {
    const min = leaves[0].length;
    const at = leaves.findLastIndex((l) => l.length === min);
    const [leaf] = leaves.splice(at, 1);
    leaves = [...leaves, ...alphabet.map((c) => [...leaf, c])];
  }
  return leaves.slice(0, count);
}

const isDigit = (c: string) => c >= '0' && c <= '9';
const sameList = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && a.every((c, i) => c === b[i]);
const isPrefixed = (k: Kind) => k === 'project' || k === 'session' || k === 'tab';

/** A region's letters: the table's order for the default alphabet, else the person's alphabet letters in that region, in their order. */
function regionKeys(region: Region, keys: HintKeys, alpha: string[]): string[] {
  const table: readonly string[] = REGIONS[region];
  return sameList(keys.alphabet, DEFAULT_ALPHABET) ? table.filter((c) => alpha.includes(c)) : alpha.filter((c) => table.includes(c));
}

/**
 * One label (letters) per item, in item order.
 * - A project takes p + its slot key (1-9, 0, then the letters), a session or tab s + its slot key: a tab and its tree row
 *   share one label, and adding one never moves a one-letter label.
 * - Every other target takes the next letter of its region; the rest (no region, or a full region) take the letters no
 *   region used, letters before digits, in `order`; past that the last ones turn into prefixes.
 * - Quiet targets and panes get [] unless `only` names their kind.
 * With `only`, just that kind is labelled, from the start of the alphabet: its labels depend on its own targets alone.
 */
export function assign(items: HintItem[], keys: HintKeys, only?: Kind): string[][] {
  const alpha = effectiveAlphabet(keys);
  const out: string[][] = items.map(() => []);
  const ranked = (pick: (it: HintItem) => boolean) => items.flatMap((it, i) => (pick(it) ? [i] : [])).sort((a, b) => items[a].order - items[b].order || a - b);
  if (only) {
    const at = ranked((it) => it.kind === only);
    codesFor(at.length, alpha).forEach((l, r) => (out[at[r]] = l));
    return out;
  }
  const second = [...'1234567890', ...alpha.filter((c) => !isDigit(c))];
  items.forEach((it, i) => {
    // ponytail: slots past 1-0 and the letters (about 34) get no prefix label; Shift + the kind letter still reaches them.
    if (isPrefixed(it.kind) && second[it.order]) out[i] = [keys.kinds[it.kind === 'project' ? 'project' : 'session'], second[it.order]];
  });
  const one = ranked((it) => !isPrefixed(it.kind) && !it.quiet && it.kind !== 'pane');
  const used = new Set<string>();
  const spill: number[] = [];
  for (const i of one) {
    const r = items[i].region;
    const k = r && regionKeys(r, keys, alpha).find((c) => !used.has(c));
    if (k) {
      used.add(k);
      out[i] = [k];
    } else spill.push(i);
  }
  const pool = [...alpha.filter((c) => !used.has(c) && !isDigit(c)), ...alpha.filter((c) => !used.has(c) && isDigit(c))];
  if (spill.length > pool.length && pool.length < 2) {
    // A custom alphabet its regions used up leaves no room for longer labels: label every one-letter target from the whole alphabet.
    codesFor(one.length, alpha).forEach((l, r) => (out[one[r]] = l));
    return out;
  }
  codesFor(spill.length, pool).forEach((l, r) => (out[spill[r]] = l));
  return out;
}

/** The item index of a kind with exactly one target (Shift + its kind letter alone picks it), else null. */
export function soleTarget(items: HintItem[], kind: Kind): number | null {
  const at = items.flatMap((it, i) => (it.kind === kind ? [i] : []));
  return at.length === 1 ? at[0] : null;
}

/**
 * A stored value rebuilt from known fields only, or null. Stored physical codes (the shapes with `layout`, ticket 389
 * and before) become their QWERTY letters once; the layout is dropped. The V1A-48 shape (`index`, `agent`) migrates too,
 * and the pre-389 default alphabet becomes the new default (a custom alphabet is kept).
 */
export function cleanHintKeys(v: unknown): HintKeys | null {
  const h = v as Record<string, unknown> | null;
  const plain = (o: unknown): o is Record<string, unknown> => !!o && typeof o === 'object' && !Array.isArray(o);
  const shape = (o: object, keys: readonly string[]) => Object.keys(o).length === keys.length && keys.every((k) => k in o);
  if (!plain(h)) return null;
  const v1 = shape(h, ['kinds', 'index', 'layout']);
  const coded = v1 || shape(h, ['kinds', 'alphabet', 'layout']);
  if (!coded && !shape(h, ['kinds', 'alphabet'])) return null;
  if (coded && typeof h.layout !== 'string') return null;
  const { kinds } = h;
  const stored = v1 ? h.index : h.alphabet;
  const oldKinds = ['project', 'agent', 'tab', 'url', 'path', 'hash', 'other'];
  if (!plain(kinds) || !shape(kinds, v1 ? oldKinds : KINDS) || !Array.isArray(stored)) return null;
  // A code as its QWERTY letter ('' when not a drawn key, which fails below); a letter as itself.
  const key = (c: unknown) => (typeof c !== 'string' ? '' : coded ? letterOf(c) : c);
  const drawn = (c: string) => DRAWN.has(c) && c.length === 1;
  const letters = stored.map(key);
  const alphabet = sameList(letters, OLD_ALPHABET) ? DEFAULT_ALPHABET : letters;
  const saved = Object.fromEntries(Object.entries(kinds).map(([k, c]) => [k === 'agent' ? 'session' : k, key(c)]));
  const used = Object.values(saved);
  if (!used.every(drawn)) return null;
  const out: Partial<Record<Kind, string>> = saved;
  // New kinds take their default letter, or the first free drawn letter when a saved one already holds it.
  const taken = new Set<string>(used);
  const pending = KINDS.filter((k) => !(k in out));
  for (const k of pending) {
    const want = new Set(pending.map((p) => DEFAULT_KINDS[p]));
    let c = DEFAULT_KINDS[k];
    if (taken.has(c)) c = [...QWERTY.slice(1).join('')].find((x) => /[a-z]/.test(x) && !taken.has(x) && !want.has(x)) ?? c;
    out[k] = c;
    taken.add(c);
  }
  if (new Set(Object.values(out)).size !== KINDS.length) return null;
  if (alphabet.length < 2 || !alphabet.every(drawn) || new Set(alphabet).size !== alphabet.length) return null;
  const clean: HintKeys = { kinds: Object.fromEntries(KINDS.map((k) => [k, out[k]!])) as Record<Kind, string>, alphabet: [...alphabet] };
  return effectiveAlphabet(clean).length >= 2 ? clean : null;
}
