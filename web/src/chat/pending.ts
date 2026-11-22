// v1b-12 (ticket 12): which pending permission a chat diff card answers, and with what. Window only, nothing new in
// the queue: Claude's PermissionRequest carries no tool_use_id and the core keeps only its `tool_input` as the item
// text, so a card matches an item of its session whose tool input equals the unresolved call's (key order aside).
// No match, or more than one call or item with that input: no buttons (the strip still answers).
import { createContext } from 'react';
import { CoreClient, type Boot } from '../api';
import { answerOnce, plan, withNote, type Act, type Answer } from '../queue/answer';
import type { Decision, Session } from '../types';
import type { Data } from './feed';
import type { Row, Tool } from './model';

type Edit = Extract<Data, { kind: 'edit' }>;
const EDITS = new Set(['Write', 'Edit', 'MultiEdit', 'apply_patch']);

/** JSON with object keys sorted at every level: the core writes the item's input key-sorted, a transcript keeps the agent's order. */
export function canonical(v: unknown): string {
  return JSON.stringify(v, (_, x) =>
    x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x,
  );
}

const lines = (s: unknown) => (typeof s === 'string' && s !== '' ? s.replace(/\n$/, '').split('\n') : []);

/** The card of a Claude edit call that has no result yet (its `edit` event comes with the result): removed lines
 * from the old text, added from the new, counted as 03 counts an edit event's hunks. Codex apply_patch calls already
 * have their edit events. */
export function pendingEdit(use: Extract<Data, { kind: 'tool_use' }>): Edit | null {
  const i = (use.input ?? {}) as Record<string, unknown>;
  if (typeof i.file_path !== 'string') return null;
  let pairs: [unknown, unknown][];
  if (use.name === 'Write') pairs = [['', i.content]];
  else if (use.name === 'Edit') pairs = [[i.old_string, i.new_string]];
  else if (use.name === 'MultiEdit' && Array.isArray(i.edits)) pairs = i.edits.map((e) => [e?.old_string, e?.new_string]);
  else return null;
  const hunks = pairs.flatMap(([o, n]) => [...lines(o).map((l) => `-${l}`), ...lines(n).map((l) => `+${l}`)]);
  return tighten({ kind: 'edit', tool_id: use.tool_id, path: i.file_path, added: 0, removed: 0, hunks });
}

/** B9 (ticket 991): each run of removed and added lines as a real line diff, so a line a patch removes and adds again
 *  (Claude's Edit anchor, Codex's patch context written as -/+) shows as context, and the counts are the true ones.
 *  Only text hunks: Claude's structuredPatch objects are already a diff. */
export function tighten(e: Edit): Edit {
  if (!e.hunks.every((h) => typeof h === 'string')) return e;
  const out: string[] = [];
  // N11 (look 1117): Codex's bare "@@" carries no line numbers: dropped at the top, a gap mark between hunks.
  const hunks = (e.hunks as string[]).flatMap((h, i) => (h.trim() !== '@@' ? [h] : i ? ['⋯'] : []));
  for (let i = 0; i < hunks.length; ) {
    let j = i;
    while (j < hunks.length && /^[-+]/.test(hunks[j])) j++;
    if (j === i) {
      out.push(hunks[i++]);
      continue;
    }
    const run = hunks.slice(i, j);
    const del = run.filter((l) => l[0] === '-').map((l) => l.slice(1));
    const add = run.filter((l) => l[0] === '+').map((l) => l.slice(1));
    // shortcut: a run over 200x200 lines keeps the agent's -/+ (the LCS table would be large); a real diff then.
    // A loop, not a spread: an agent's patch of 150,000 lines passed the argument limit and crashed the chat (Codex look).
    if (!del.length || !add.length || del.length * add.length > 40_000) for (const l of run) out.push(l);
    else {
      const L = Array.from({ length: del.length + 1 }, () => new Array<number>(add.length + 1).fill(0));
      for (let x = del.length - 1; x >= 0; x--) for (let y = add.length - 1; y >= 0; y--) L[x][y] = del[x] === add[y] ? L[x + 1][y + 1] + 1 : Math.max(L[x + 1][y], L[x][y + 1]);
      let x = 0;
      let y = 0;
      while (x < del.length || y < add.length) {
        if (x < del.length && y < add.length && del[x] === add[y]) out.push(` ${del[x++]}`), y++;
        else if (x < del.length && (y === add.length || L[x + 1][y] >= L[x][y + 1])) out.push(`-${del[x++]}`);
        else out.push(`+${add[y++]}`);
      }
    }
    i = j;
  }
  const removed = e.removed === null ? null : out.filter((l) => l[0] === '-').length;
  return { ...e, hunks: out, added: out.filter((l) => l[0] === '+').length, removed };
}

/** Unresolved edit call id → the one permission item it answers. */
export function matches(rows: Row[], decisions: Decision[]): Map<string, Decision> {
  const calls = new Map<string, Set<Tool>>();
  for (const r of rows)
    if (r.kind === 'diff' && r.tool && !r.tool.result && EDITS.has(r.tool.use.name)) {
      const k = canonical(r.tool.use.input);
      calls.set(k, (calls.get(k) ?? new Set()).add(r.tool));
    }
  const items = new Map<string, Decision[]>();
  for (const d of decisions) {
    if (d.kind !== 'permission') continue;
    let input: unknown;
    try {
      input = JSON.parse(d.text);
    } catch {
      continue; // Screen text: nothing to compare.
    }
    const k = canonical(input);
    items.set(k, [...(items.get(k) ?? []), d]);
  }
  const out = new Map<string, Decision>();
  for (const [k, tools] of calls) {
    const ds = items.get(k);
    if (tools.size === 1 && ds?.length === 1) out.set([...tools][0].use.tool_id, ds[0]);
  }
  return out;
}

export interface CardPlan {
  accept?: Act;
  reject?: Act;
  /** plan()'s reason when nothing can be sent (restored item, session not running). */
  note?: string;
}

/** Accept = plan()'s allow once, Reject = its deny; nothing else is drawn. With screen choices read, Accept needs one
 * that allows once without changing settings (the core's rule in `Sessions::answer`, crates/nunchiro-core/src/sessions.rs), so a persistent-only allow shows Reject only. */
export function cardPlan(d: Decision, s: Session, t: Parameters<typeof plan>[2]): CardPlan {
  const p = plan(d, s, t);
  if (p.note) return { note: p.note };
  const once = !d.choices.length || d.choices.some((c) => !c.changes_settings && (c.label.toLowerCase().startsWith('yes') || c.label.toLowerCase().includes('this time')));
  return { accept: once ? p.acts.find((a) => a.answer.type === 'allow_once') : undefined, reject: p.acts.find((a) => a.answer.type === 'deny') };
}

/** The Diff path of an edit: relative to the session folder, or null when it is outside it. */
export function sessionPath(p: string, cwd: string): string | null {
  const root = cwd.replace(/\/+$/, '');
  const rel = p.startsWith('/') ? (root && p.startsWith(`${root}/`) ? p.slice(root.length + 1) : null) : p.replace(/^(\.\/)+/, '');
  return rel === null || rel.split('/').some((x) => x === '..' || x === '' || x === '.') ? null : rel;
}

/** The strip's request, exactly: `{op:'answer', item, answer, confirmed:false}`.
 * shortcut: one short-lived socket per click, since ChatPanes gets no CoreClient (App.tsx owns it and is outside
 * this lane); pass App's client down when App.tsx is next edited. */
export function answer(boot: Boot, item: string, a: Answer): Promise<unknown> {
  // V2-8e: the same one-answer-per-item guard as the strip, the rows and the card.
  return answerOnce(item, () => connectAndAnswer(boot, item, withNote(item, a))) ?? Promise.reject(new Error('already answered'));
}
function connectAndAnswer(boot: Boot, item: string, a: Answer): Promise<unknown> {
  const c = new CoreClient(boot);
  return new Promise((resolve, reject) => {
    // A core that never replies must not leave the card busy or the socket open.
    const timer = setTimeout(() => (c.close(), reject(new Error('core did not answer'))), 10_000);
    const settle = <T,>(f: (v: T) => void) => (v: T) => (clearTimeout(timer), f(v));
    resolve = settle(resolve);
    reject = settle(reject);
    c.onStatus = (up) => {
      if (!up) return c.close(), reject(new Error('core disconnected'));
      c.request({ op: 'answer', item, answer: a, confirmed: false })
        .then(resolve, reject)
        .finally(() => c.close());
    };
    c.connect();
  });
}

export const Pending = createContext<{ session: Session | null; boot: Boot | null; matched: Map<string, Decision> }>({ session: null, boot: null, matched: new Map() });

// board/rights.rs `hidden`, the one shared hidden-character set (V2.5-49): bidi overrides and isolates, the Arabic letter
// mark, zero-width and line-separator marks, tag characters. Agent text reorders or hides nothing where it is shown.
const HIDDEN = /[\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\u{e0000}-\u{e007f}]/gu;
const CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g;

/** Agent text for the eye: no hidden or control characters (a line break stays one, a bare CR included). Used where agent text shows (TurnFiles). */
export const plain = (text: string): string => text.replace(/\r\n?/g, '\n').replace(HIDDEN, '').replace(CONTROL, '');
