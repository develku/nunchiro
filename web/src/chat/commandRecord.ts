import { useSyncExternalStore } from 'react';
import { userView } from './conversation';

/** W35-picker2 S2-2: a slash command as Claude records it (`<command-name>/effort</command-name>...`, the picker's own control
 *  commands among them). It is never given back to the box: sent again it would be a prompt. */
export const isCommandRecord = (text: string) => text.trimStart().startsWith('<command-name>');

// Ticket 1019: the commands the app typed itself (the picker's `/effort ultracode on|off`), per session, so their record
// reads as one quiet line and not as the person's bubble. Round 2 (Fable review SHOULD 1): each note claims exactly one
// record, the first with its text after the chat event the window had drawn when it sent, so a command the user types by
// hand stays a bubble; a send the core refused writes no note.
const CONTROLS_KEY = 'nunchiro.chat.controls.v2';
const MAX_NOTES = 20;
const MAX_SESSIONS = 50;
type Note = { text: string; after: number; key?: number };
/** The user rows the chat last built, per session (window memory): a note written after its record arrived claims it here. */
const rowsOf = new Map<string, { key: number; text: string }[]>();
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => (listeners.add(l), () => void listeners.delete(l));
function readNotes(): Record<string, Note[]> {
  try {
    const all = JSON.parse(localStorage.getItem(CONTROLS_KEY) ?? '{}') as unknown;
    return all && typeof all === 'object' && !Array.isArray(all) ? (all as Record<string, Note[]>) : {};
  } catch {
    return {};
  }
}
function writeNotes(session: string, notes: Note[]) {
  const { [session]: _, ...rest } = readNotes();
  try {
    localStorage.setItem(CONTROLS_KEY, JSON.stringify(Object.fromEntries(Object.entries({ ...rest, [session]: notes.slice(-MAX_NOTES) }).slice(-MAX_SESSIONS))));
  } catch {
    return; // storage blocked: the record reads as a bubble, as before
  }
  listeners.forEach((l) => l());
}
/** The command a record shows (`/effort ultracode on`), or null for any other message. */
const shownCommand = (raw: string) => (isCommandRecord(raw) ? userView(raw).text : null);
function claim(session: string) {
  const rows = rowsOf.get(session);
  const notes = readNotes()[session];
  if (!rows || !notes?.some((n) => n.key === undefined)) return;
  const taken = new Set(notes.map((n) => n.key));
  let changed = false;
  for (const n of notes) {
    if (n.key !== undefined) continue;
    const row = rows.find((r) => r.key > n.after && !taken.has(r.key) && shownCommand(r.text) === n.text);
    if (row) (n.key = row.key), taken.add(row.key), (changed = true);
  }
  if (changed) writeNotes(session, notes);
}
/** ChatView: the rows it built, so a waiting note claims its record. */
export function claimControls(session: string, rows: { kind: string; key: number; text?: string }[]) {
  rowsOf.set(session, rows.flatMap((r) => (r.kind === 'user' && r.text !== undefined ? [{ key: r.key, text: r.text }] : [])));
  claim(session);
}
/** The picker, once the core took the send: `after` is the chat event the window had drawn when it sent. */
export function noteControl(session: string, command: string, after: number) {
  writeNotes(session, [...(readNotes()[session] ?? []), { text: command, after }]);
  claim(session);
}
/** The record at `key` is one the app typed. */
export const useAppControl = (session: string, key: number | null) => useSyncExternalStore(subscribe, () => key !== null && !!readNotes()[session]?.some((n) => n.key === key));
