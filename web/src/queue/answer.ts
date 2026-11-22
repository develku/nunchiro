// What the window may send for a waiting item (ticket 08 answer rules, decisions.txt 21:08 and 20:46).
// Permission: allow once or deny. Questions: the transient choices. Dialogs: decline only. Options that
// persist to user config are text, never sendable. Restored items (not actionable) are never answerable.
import { checking, type Decision, type Session } from '../types';
import type { Key } from '../i18n';
import { sessionName } from '../sessionNames';
import { mcpLine, planTitle } from '../decisions/readable';

type T = (key: Key, args?: Record<string, string | number>) => string;

export type Answer =
  | { type: 'allow_once' }
  | { type: 'deny' }
  | { type: 'choose'; index: number }
  | { type: 'resolved' } // v1b-18: resolved is board-only
  | { type: 'deny_with'; text: string } // V2-8e: deny with a one-line instruction (the card and the row's deny)
  | { type: 'allow_always' } // V2-8e: the agent's session-only "don't ask again" (card, mouse only)
  | { type: 'choose_with'; index: number; text: string }; // Home look S2-7: a question's "Type something." with its words (card only)

/** Home look S2-7: Claude's free-text row of a question; its digit alone only opens a text field, so it is never a plain act. */
/** Look 1117 v10 N10-S2-5: so is the plan approval's "Tell Claude what to change" (crates/nunchiro-core/src/queue/mod.rs `takes_text`). */
export const takesText = (label: string) => /^(type something|tell claude what to change)\.?$/i.test(label.trim());

/** V2-8e: every answer from this window goes through here, so one item is sent at most once however many paths
 * (row, peek, card, keys, strip) fire for it; a refused answer can be tried again. `steps`: an item that takes more
 * than one answer (an Outbox card: Send, then Undo within 10 s) is held only while an answer is on its way, so a
 * double click still sends once (look v20 S1: the held Send dropped the Undo, and the mail went). */
const sent = new Set<string>();
export function answerOnce(item: string, send: () => Promise<unknown>, steps = false): Promise<unknown> | null {
  if (sent.has(item)) return null;
  sent.add(item);
  return send().then(
    (r) => {
      denyNotes.delete(item); // answered: its instruction is not kept
      if (steps) sent.delete(item);
      return r;
    },
    (e) => {
      sent.delete(item);
      throw e;
    },
  );
}
/** Whether this window already sent an answer for the item (its row, peek and card buttons show as sent). */
export const answered = (item: string) => sent.has(item);
/** Look 1117 v13 N12-S2-3: the instruction typed in a permission card's field, by item. Every Deny of that item carries it
 *  (the chat's edit card sent a plain deny beside the card, and Claude got only "The user denied this"). */
/** Codex NOTE (w20-h): only non-empty notes, dropped when the item is answered or its card goes (it left the snapshot),
 *  and at most DENY_NOTES_MAX (oldest out), so typed instructions do not pile up in the window. */
const denyNotes = new Map<string, string>();
const DENY_NOTES_MAX = 200;
export function setDenyNote(item: string, text: string) {
  denyNotes.delete(item);
  if (!text.trim()) return;
  denyNotes.set(item, text);
  if (denyNotes.size > DENY_NOTES_MAX) denyNotes.delete(denyNotes.keys().next().value!);
}
/** A card that goes drops its note, unless another card of the item has set its own since. */
export const dropDenyNote = (item: string, text: string) => void (denyNotes.get(item) === text && denyNotes.delete(item));
export const withNote = (item: string, a: Answer): Answer => {
  const text = a.type === 'deny' ? denyNotes.get(item)?.trim() : undefined;
  return text ? { type: 'deny_with', text } : a;
};
export interface Act {
  label: string;
  answer: Answer;
  /** Physical key (`KeyboardEvent.code`), so a Korean input source still answers. */
  code: string;
}
export interface Plan {
  acts: Act[];
  /** Labels shown as text with "answer in the terminal". */
  terminal: string[];
  /** Why there is nothing to send, when there is nothing. */
  note?: string;
}
/** V2-8e: the longest deny instruction (crates/nunchiro-core/src/queue/mod.rs `DENY_NOTE_MAX`). */
export const DENY_NOTE_MAX = 500;
/** V2-8e: a session's name as the tree and the card show it. Ticket 491: the tab's name ("New Claude session 2"), never "claude c026a0". */
export const whoOf = (s: Session) => sessionName(s);

/** `t`: the window's language for the labels and notes (ticket 565). */
export function plan(d: Decision, session: Session | undefined, t: T): Plan {
  const persistent = d.choices.filter((c) => c.changes_settings).map((c) => c.label);
  // v1a-23: a human action a session asked for. A widget or integration source is reviewed in the permission sheet
  // (the strip's Review button; r2: sources too), so its card sends only Dismiss; verified yes is one click. Never
  // typed into a terminal.
  if (d.kind === 'owner') {
    const dismiss: Act = { label: t('own.ans.dismiss'), answer: { type: 'deny' }, code: 'KeyN' };
    if (d.owner?.type === 'approval' || d.owner?.type === 'setup' || d.owner?.type === 'stall') return { acts: [dismiss], terminal: [] }; // ticket 259: setup too; ticket 1004: a stalled task's card
    // Ticket 990 slice h: the yes keeps the chosen lessons first, so it is given only on the card in Decisions.
    if (d.owner?.type === 'merge') return { acts: [{ ...dismiss, label: t('notes.merge.notYet') }], terminal: [], note: t('notes.merge.onCard') };
    if (d.owner?.type === 'role') return { acts: [{ ...dismiss, label: t('lead.roleCard.notNow') }], terminal: [], note: t('lead.roleCard.onCard') };
    // Ticket 993: the yes changes the schedules, so it is given only on the card, with the whole task to read first.
    if (d.owner?.type === 'schedule') return { acts: [d.owner.change === 'failed' ? dismiss : { ...dismiss, label: t('lead.roleCard.notNow') }], terminal: [], note: t('schedule.card.onCard') };
    // Ticket 1003: an open loop's yes keeps or closes a row, so it is given only on the card, with the row to read first.
    if (d.owner?.type === 'loop') return { acts: [{ ...dismiss, label: t(d.owner.change === 'overdue' ? 'loops.act.open' : 'lead.roleCard.notNow') }], terminal: [], note: t('loops.onCard') };
    // Ticket 1005: a yes asks the teammate to tidy its memory file; Not now dismisses the card.
    if (d.owner?.type === 'tidy') return { acts: [{ label: t('tidy.yes'), answer: { type: 'allow_once' }, code: 'KeyY' }, { ...dismiss, label: t('lead.roleCard.notNow') }], terminal: [] };
    // Needs 225: Allow spends one Codex reset ticket through the owner's codex; Deny spends nothing.
    if (d.owner?.type === 'codex_reset')
      return { acts: [{ label: t('own.ans.allow'), answer: { type: 'allow_once' }, code: 'KeyY' }, { ...dismiss, label: t('own.ans.deny') }], terminal: [] };
    return { acts: [{ label: t('own.ans.turnOn'), answer: { type: 'allow_once' }, code: 'KeyY' }, dismiss], terminal: [] };
  }
  // v1b-18: a board item is only ever marked resolved in Nunchiro; nothing reaches a terminal or the integration.
  if (d.kind === 'board') return { acts: [{ label: t('own.ans.resolved'), answer: { type: 'resolved' }, code: 'KeyR' }], terminal: [] };
  if (d.kind === 'stale') return { acts: [], terminal: [], note: t('own.ans.stale') };
  if (d.kind === 'background') return { acts: [], terminal: [], note: t('own.ans.background') };
  if (!d.actionable && d.reconciled === false) return { acts: [], terminal: [], note: t('own.ans.pending') }; // v1b-32
  // V2-1b: answerable only once fresh evidence after the restart proves it again (then it comes back with a new id).
  if (checking(d)) return { acts: [], terminal: [], note: t('own.ans.checking') };
  // Kept as the fail-closed default: any other item that is not actionable (e.g. one without `reconciled`) sends nothing.
  if (!d.actionable) return { acts: [], terminal: [], note: t('own.ans.restored') };
  if (session && session.state !== 'running') return { acts: [], terminal: [], note: t('own.ans.notRunning', { state: t(`own.state.${session.state}` as Key) }) };
  // V2-8e: a risky permission (the core's flag; absent = risky) is allowed only in the panel card, by focus then Enter,
  // which confirms it; the core refuses an unconfirmed allow. Deny stays everywhere.
  if (d.kind === 'permission' && (d as { risky?: boolean }).risky !== false)
    return { acts: [{ label: t('own.ans.deny'), answer: { type: 'deny' }, code: 'KeyN' }], terminal: persistent };
  if (d.kind === 'permission')
    return {
      acts: [
        { label: t('own.ans.allowOnce'), answer: { type: 'allow_once' }, code: 'KeyY' },
        { label: t('own.ans.deny'), answer: { type: 'deny' }, code: 'KeyN' },
      ],
      terminal: persistent,
    };
  if (d.kind === 'dialog') return { acts: [{ label: t('own.ans.decline'), answer: { type: 'deny' }, code: 'KeyN' }], terminal: d.choices.map((c) => c.label) };
  const acts: Act[] = [];
  d.choices.forEach((c, index) => {
    if (!c.changes_settings && index < 9 && !takesText(c.label)) acts.push({ label: `${index + 1} ${c.label}`, answer: { type: 'choose', index }, code: `Digit${index + 1}` });
  });
  acts.push({ label: t('own.ans.cancel'), answer: { type: 'deny' }, code: 'KeyN' });
  return { acts, terminal: persistent };
}

const CHOICE = /^[\s❯›>○●]*\d+[.)]\s/;
const NOISE = /^(do you want to proceed\?|would you like to run the following command|enter to select|esc to cancel|.*\bto cancel\b.*)$/i;

/** Look 1117 v9 B N-S3-8: Codex shows the command it asks to run as "$ <command>", wrapped over lines in a narrow
 *  terminal; the card read only the wrap's tail ("h/look-1117/v9/b/cxout.txt"). That block, the last before the choices,
 *  is shown whole, its lines kept as printed: guessing where a wrap fell can merge two arguments ("rm -rf /tmp/a " +
 *  "/tmp/b" read "/tmp/a/tmp/b"), and an approval card must never show a command that differs from what runs. */
export function screenCommand(text: string): string | null {
  const all = text.split('\n').map((l) => l.replace(/[│╭╮╰╯─┌┐└┘]/g, '').trim());
  const first = all.findIndex((l) => CHOICE.test(l));
  const lines = first < 0 ? all : all.slice(0, first);
  const at = lines.findLastIndex((l) => l.startsWith('$ '));
  if (at < 0) return null;
  const end = lines.findIndex((l, i) => i > at && !l);
  if (end >= 0 && lines.slice(end).some(Boolean)) return null; // only the block right above the choices, never the chat above
  return lines.slice(at, end < 0 ? undefined : end).join('\n').slice(2).trim() || null;
}

/** One line for the card: a hook item's tool input, else the meaningful screen line(s). */
export function summary(d: Decision): string {
  const mcp = mcpLine(d); // look v31 a S2-1: an MCP tool is named wherever this line shows
  if (mcp) return mcp;
  try {
    const v = JSON.parse(d.text);
    if (v && typeof v === 'object') {
      const q = v.questions?.[0]?.question ?? v.questions?.[0]?.title ?? v.question;
      const plan = typeof v.plan === 'string' ? planTitle(v.plan) || undefined : undefined; // N10-S2-5: never the whole plan on one line
      const s = v.command ?? v.file_path ?? q ?? plan ?? Object.values(v).find((x) => typeof x === 'string');
      if (typeof s === 'string' && s.trim()) return s.trim();
    }
  } catch {
    // Screen text, not JSON.
  }
  // The screen also holds the conversation above the prompt: keep the last lines before the first choice.
  const lines = d.text.split('\n').map((l) => l.replace(/[│╭╮╰╯─┌┐└┘]/g, '').trim());
  const first = lines.findIndex((l) => CHOICE.test(l));
  const cmd = screenCommand(d.text);
  if (cmd) return cmd;
  const head = (first < 0 ? lines : lines.slice(0, first)).filter(Boolean);
  const useful = head.filter((l) => !NOISE.test(l));
  return (useful.length ? useful.slice(-2) : head.slice(-1)).join(' · ') || d.text.trim();
}
