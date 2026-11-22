// Ticket 222 (B19a): Diff's scope. "Changes" is the session's changes against its start commit (the list as before);
// "Latest turn" keeps only the files the agent's last finished turn wrote, which the core puts on that turn's chat event
// (`files`, crates/nunchiro-core/src/chat/turn_files.rs). Own code: no local T3 Code checkout to port from.
// Paths are page text: they are only looked up in the Diff list, never evaluated or navigated.
import type { ChatEvent } from '../chat/feed';
import type { Change } from './Diff';

// Ticket 374: "Branch" compares with where this branch left origin's default branch (the core's `scope: 'branch'`).
export type Scope = 'turn' | 'changes' | 'branch';
export const SCOPE_KEY = 'nunchiro.diffScope';

/** The scope this window last chose; "Changes" when none (or storage is unavailable). */
export function storedScope(): Scope {
  try {
    const s = localStorage.getItem(SCOPE_KEY);
    return s === 'turn' || s === 'branch' ? s : 'changes';
  } catch {
    return 'changes';
  }
}

export function keepScope(s: Scope) {
  try {
    localStorage.setItem(SCOPE_KEY, s);
  } catch {
    // Per-window convenience only.
  }
}

type TurnData = { kind: string; state?: string; files?: unknown; files_partial?: unknown };
/** The last finished turn among `events` that carries a file list. */
function lastTurn(events: ChatEvent[]): TurnData | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const d = events[i].data as TurnData;
    if (d.kind !== 'turn' || (d.state !== 'completed' && d.state !== 'interrupted')) continue;
    // A turn indexed before the core recorded files has none: it does not count as known.
    if (Array.isArray(d.files)) return d;
  }
  return null;
}

/** The files of the last finished turn among `events`; null when no finished turn with a file list is there. */
export function latestTurn(events: ChatEvent[]): string[] | null {
  const files = lastTurn(events)?.files as unknown[] | undefined;
  return files ? files.filter((f): f is string => typeof f === 'string') : null;
}

/** Real-app 11-10 defect 3: the last turn ran a tool that may have written files its list does not name. */
export const latestTurnPartial = (events: ChatEvent[]) => lastTurn(events)?.files_partial === true;

/** Ticket 374: the cursor of the last finished turn among `events` (with or without files), so Diff re-reads when
 *  another turn finishes; null before one did. */
export function finishedTurnAt(events: ChatEvent[]): number | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const d = events[i].data as { kind: string; state?: string };
    if (d.kind === 'turn' && (d.state === 'completed' || d.state === 'interrupted')) return events[i].cursor;
  }
  return null;
}

/** The Diff list's files that the turn wrote and that still differ from the start commit, in the list's order. A file
 *  the turn wrote and then reverted is no longer in the list, so it drops out. */
export function scoped(files: Change[], turn: string[]): Change[] {
  const wrote = new Set(turn);
  return files.filter((f) => wrote.has(f.path) || (f.old_path !== null && wrote.has(f.old_path)));
}
