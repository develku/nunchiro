// The postMessage bridge's wire shape (ticket v1b-22). The frame posts {nunchiro:1, id, method, params}; the window
// replies {nunchiro:1, id, ok} or {nunchiro:1, id, error}. These two methods are the whole bridge.
import { agentOff } from '../settings/agents/newDefaults';
import type { Target } from './api';

export const METHODS = ['context', 'act'] as const;
export type Call = { id: string | number; method: 'context' } | { id: string | number; method: 'act'; text: string; target: Target };

const plain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const keys = (o: Record<string, unknown>, allowed: string[]) => Object.keys(o).every((k) => allowed.includes(k));

/** A bridge call, `{ error }` for a bridge message it refuses, or null for anything that is not a bridge message. */
export function parse(data: unknown): Call | { id: string | number; error: string } | null {
  if (!plain(data) || data.nunchiro !== 1) return null;
  const id = data.id;
  if (!((typeof id === 'number' && Number.isSafeInteger(id)) || (typeof id === 'string' && id.length <= 64))) return null;
  if (data.method === 'context') return { id, method: 'context' };
  if (data.method !== 'act') return { id, error: `unknown method; the bridge has ${METHODS.join(' and ')}` };
  const p = data.params;
  if (!plain(p) || typeof p.text !== 'string') return { id, error: 'act takes {text, session} or {text, start}' };
  if (keys(p, ['text', 'session']) && typeof p.session === 'string') return { id, method: 'act', text: p.text, target: { session: p.session } };
  if (keys(p, ['text', 'start']) && (p.start === 'claude' || p.start === 'codex')) {
    // Ticket 358: a window preference, so it is held here and not in the core.
    if (agentOff(p.start)) return { id, error: `${p.start} is turned off in Settings > Accounts` };
    return { id, method: 'act', text: p.text, target: { start: p.start } };
  }
  return { id, error: 'act takes {text, session} or {text, start: "claude"|"codex"}' };
}

/** web.rs `MAX_CHARS`: what a person reads in the confirm box before Send. */
export const MAX_CHARS = 1000;
// delivery.rs `shown`: what draws as itself; the four joiners are allowed only right after a visible character.
const SHOWN = /[\p{L}\p{M}\p{N}\p{P}\p{S}\p{Zs}]/u;
const IGNORABLE = /[\p{Default_Ignorable_Code_Point}\u2800]/u;
// board/rights.rs `hidden`, the one shared hidden-character set (needs 154/155), as a character-class body for a `u` regex.
const HIDDEN = '\\u061c\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u206f\\ufeff\\u{e0000}-\\u{e007f}';
// act.rs `check_leading` skips every character not drawn as itself; here only whitespace and HIDDEN, and `hiddenError`
// refuses any other such character, so both sides refuse the same texts.
const LEADING = new RegExp(`^[\\s${HIDDEN}]*[/!#]`, 'u');

/** act.rs `check_visible`: the confirm must show the text in the order and form it is sent. */
function hiddenError(text: string): string | null {
  let after = 3; // 0 visible, 1 selector, 2 joiner, 3 start or whitespace
  for (const c of text) {
    if (c === '\ufe0e' || c === '\ufe0f' || c === '\u200c' || c === '\u200d') {
      if ((c === '\ufe0e' || c === '\ufe0f') && after === 0) after = 1;
      else if ((c === '\u200c' || c === '\u200d') && after <= 1) after = 2;
      else return 'act text has a joiner or variation selector that follows no visible character';
      continue;
    }
    if (!SHOWN.test(c) || IGNORABLE.test(c)) return `act text contains an invisible, bidi or control character (U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')})`;
    after = /\s/u.test(c) ? 3 : 0;
  }
  return null;
}

/** The core's text rules (web.rs `check_text`), checked before the confirm shows; the core checks again. */
export function textError(text: string): string | null {
  if (!text.trim()) return 'act text is empty';
  if ([...text].length > MAX_CHARS) return `act text over ${MAX_CHARS} characters`;
  if (/[\u0000-\u001f\u007f-\u009f]/.test(text)) return 'act text contains a control character';
  if (/[^\S ]/u.test(text)) return 'act text contains a space other than U+0020';
  if (text.includes('   ')) return 'act text has more than 2 spaces in a row';
  // v1b-23 (S1): as web.rs, a ZWJ/ZWNJ between marks neither counts nor resets the run.
  if (/\p{M}{5}/u.test(text.replace(/[\u200c\u200d]/g, ''))) return 'act text stacks more than 4 combining marks';
  if (LEADING.test(text)) return 'act text may not start with /, ! or #';
  return hiddenError(text);
}

/** v1b-23 (NIT-1): a target label the confirm line may show: what a session label can be, drawn as itself. */
export function labelError(label: string): string | null {
  if (!label.trim() || new TextEncoder().encode(label).length > 256) return 'act target label is empty or over 256 bytes';
  if (/[\u0000-\u001f\u007f-\u009f]/.test(label) || /[^\S ]/u.test(label)) return 'act target label contains a control or space character';
  return hiddenError(label);
}
