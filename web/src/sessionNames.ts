// Ticket 491: one name for a session wherever it shows (tabs, the tree, the palette, the approval card and strip).
import { agentName } from './chat/conversation';
import { words } from './layout/store';
import type { Session } from './types';

/** Ticket 471: a session without a label is named after its agent ("New Claude session"), never its kind and an id prefix. */
const plainName = (s: Session) => {
  if (s.label) return s.label;
  const t = words();
  return s.kind === 'shell' ? t('session.untitledShell') : t('session.untitled', { agent: s.kind === 'acp' ? (s.acp_agent ?? agentName('acp')) : agentName(s.kind) });
};

/** Look 1117 v14 O1: a closed session keeps the number it was given (its tab reads "New terminal 2" still, not "New terminal");
 *  only an open one is given a new number. Ticket 1017: a name from the first message is numbered too; one the user set never. */
const kept = (o: Session) => (!o.label || !!o.auto_label) && !o.account_tab;
/** Every open unlabeled session but a Settings login tab (never in the tree); shells and side chats too (506 r3: the old
 *  strip numbered any unlabeled asker). */
const counted = (o: Session) => kept(o) && o.state !== 'closed';

/** Ticket 991 A21: each unlabeled session's number, kept once given (by session id), and in this window's storage so a
 *  reload shows the same names. 1 is the plain name (ticket 491: the first of its kind has no number). */
const KEY = 'nunchiro.sessionNumbers.v1';
const numbers = new Map<string, number>(
  (() => {
    try {
      const v: unknown = JSON.parse(localStorage.getItem(KEY) ?? '{}');
      return v && typeof v === 'object' ? Object.entries(v).filter((e): e is [string, number] => Number.isInteger(e[1]) && (e[1] as number) > 0) : [];
    } catch {
      return [];
    }
  })(),
);
/** Per project and kind, the highest number given while this window lives: a closed session's number is never given again. */
const top = new Map<string, number>();
/** Ticket 1017: first-message names number by the name (any agent), unlabeled ones by the agent. */
const kindOf = (s: Session) => (s.label ? `${s.project}\0=${s.label}` : `${s.project}\0${s.kind}\0${s.acp_agent ?? ''}`);
/** A number is the session's under the name it was given for: an unlabeled "New Claude session 2" titled "ASK" is not "ASK 2". */
const keyOf = (s: Session) => (s.label ? `${s.id}\0${s.label}` : s.id);

/** The open sessions in the tree's order (settings.order, which is start order unless moved), set by the window each
 *  render. A session seen for the first time takes the next number of its project and kind (the first one 1, its plain
 *  name); numbers of sessions gone are dropped from storage but never reused while the window lives. */
export const setNameScope = (ordered: readonly Session[]) => {
  let changed = false;
  for (const s of ordered) {
    const n = numbers.get(keyOf(s));
    if (n && kept(s)) top.set(kindOf(s), Math.max(top.get(kindOf(s)) ?? 0, n));
  }
  if (ordered.length) for (const k of numbers.keys()) if (!ordered.some((o) => keyOf(o) === k && kept(o))) changed = numbers.delete(k);
  // Ticket 1017: a first-message name is numbered only once two open sessions of the project show it (a hand-set one
  // counts, unnumbered), each from 1 ("ASK 1").
  const twins = new Map<string, number>();
  for (const s of ordered) if (s.label && s.state !== 'closed' && !s.account_tab) twins.set(kindOf(s), (twins.get(kindOf(s)) ?? 0) + 1);
  for (const s of ordered) {
    const lone = !!s.label && (twins.get(kindOf(s)) ?? 0) < 2;
    // Look v34 S3-2: a first-message name that is unique again (its twin renamed or closed) loses its number.
    if (lone && counted(s) && numbers.delete(keyOf(s))) changed = true;
    if (!counted(s) || numbers.has(keyOf(s)) || lone) continue;
    // A first-message twin takes the lowest number its open twins do not hold, so "ASK" renamed back reads "ASK 1" again.
    const held = new Set(ordered.filter((o) => o !== s && kept(o) && kindOf(o) === kindOf(s)).map((o) => numbers.get(keyOf(o))));
    let n = (top.get(kindOf(s)) ?? 0) + 1;
    if (s.label) for (n = 1; held.has(n); n++);
    top.set(kindOf(s), n);
    numbers.set(keyOf(s), n);
    changed = true;
  }
  if (changed) {
    try {
      localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(numbers)));
    } catch {
      // No storage: the numbers hold for this window's life.
    }
  }
};

/** Ticket 491: the first unlabeled session of its kind in a project reads "New terminal", later ones "New terminal 2",
 *  "… 3", so the strip, the card, the tab, the tree row and the palette row agree. Ticket 991 A21: a number is given once
 *  and kept, so a name never changes by itself when another session arrives or closes. */
export const sessionName = (s: Session) => {
  const shown = plainName(s);
  const n = kept(s) ? numbers.get(keyOf(s)) : undefined;
  return n && (n > 1 || s.label) ? `${shown} ${n}` : shown;
};
