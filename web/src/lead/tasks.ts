// Ticket 990 slice g (mockup docs/design/leader-room/team-j.html ②): the core's job ledger as the window reads it. A place
// is a project root, or the Home folder for a Home lead; with no place nothing is asked.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CoreClient } from '../api';
import { rawError } from '../errors';
import { agentState, shownStatus, type Decision, type Session } from '../types';

export type Seat = { session: string; name: string; role: string; writes: boolean; worktree?: string; at: number };
export type Told = { at: number; session: string; name: string; text: string };
export type Review = { revision: string; pass: boolean; note?: string; by: string; name: string; at: number };
/** crates/nunchiro-core/src/ledger.rs `View`: the task record flattened, plus what the core worked out now. */
export type TaskView = {
  id: string;
  place: string;
  title: string;
  accept?: string[];
  lead?: string;
  auto?: boolean;
  worktrees?: string[];
  seats?: Seat[];
  told?: Told[];
  review?: Review;
  closed?: { at: number; how: string };
  created: number;
  updated: number;
  state: string;
  stale?: boolean;
  live?: string[];
  asks?: string[];
  /** The seats with an open ask (ledger.rs `View::asking`): they wait for its answer, also while their turn runs the wait. */
  asking?: string[];
  /** The window's own: the id of the open merge card the lead asked the person to answer (`withMerges`). */
  merge?: string;
  /** Ticket 1081: each seat's last activity (ms), what waits on the lead, and the seats the core saw stalled. */
  seen?: Record<string, number>;
  waits?: 'review' | 'merge';
  /** Part B: `review` is `waits` (its Reviewer waits for a free seat) or `started` (the core started it). */
  advance?: { stalled?: { session: string; name: string; why: string }[]; review?: 'waits' | 'started' };
};

/** crates/nunchiro-core/src/ledger.rs `Place`: the place's way of working and what its writing seats may do unasked. */
/** `auto` (ticket 1081): the core leaves it out while on. */
/** `cap` (ticket 1081 part B): the seats at once the core may start up to; left out at 4. */
// Ticket 1120: `account` is the label of the agent account the place's seats start on; absent: the lead's own.
export type Place = { way: 'solo' | 'team' | 'strict'; seats: 'ask' | 'edits'; auto?: boolean; cap?: number; account?: string };
export type Role = { name: string; job: string; kind: string; model?: string; effort?: string; writes: boolean };

// A change made in this window (the way menu) reads every list again at once.
const readers = new Set<() => void>();
export const tasksChanged = () => readers.forEach((f) => f());

// The window hears no `tasks` event (the core sends it only `room`), so the list is read again on a room change, on a
// seat's state change, on coming back to the window, and on a slow poll as the last fallback.
const POLL_MS = 15_000;
export function useTasks(core: CoreClient, place: string | null, connected: boolean, sessions: Session[]): { tasks: TaskView[]; place: Place | null } {
  const [got, setGot] = useState<{ tasks: TaskView[]; place: Place | null }>(NONE);
  const asked = useRef(place);
  asked.current = place;
  const [read, setRead] = useState(0);
  useEffect(() => {
    setGot(NONE);
    if (!place || !connected) return;
    const tick = () => document.visibilityState === 'visible' && setRead((n) => n + 1);
    readers.add(tick);
    const timer = setInterval(tick, POLL_MS);
    const off = core.onRoom(tick);
    document.addEventListener('visibilitychange', tick);
    window.addEventListener('focus', tick);
    return () => (readers.delete(tick), clearInterval(timer), off(), document.removeEventListener('visibilitychange', tick), window.removeEventListener('focus', tick));
  }, [core, place, connected]);
  // Only what a task's state reads from a session: which runs and whether it works or waits.
  const seats = sessions.map((s) => `${s.id}:${s.state}:${shownStatus(s)}`).join(',');
  useEffect(() => {
    if (!place || !connected) return;
    let live = true;
    let again: ReturnType<typeof setTimeout> | undefined;
    core.request({ op: 'task', operation: 'list', project: place, all: true }).then(
      (r) => {
        const reply = r as { tasks?: TaskView[]; place?: Place };
        if (live && asked.current === place) setGot({ tasks: reply.tasks ?? [], place: reply.place ?? null });
      },
      // Q4 lead-row-team (v9-Home-S3-7): a press on the lead's row starts a burst of off-loop reads, and the core refuses
      // one past its in-flight cap (MAX_JOBS); the Team view then kept no rows until the 15 s tick. That refusal reads
      // again shortly, as useDigest does; any other (a core without the ledger has no tasks) shows none.
      (e: unknown) => void (live && rawError(e).includes('in flight') && (again = setTimeout(() => live && setRead((n) => n + 1), 100))),
    );
    return () => void ((live = false), clearTimeout(again));
  }, [core, place, connected, seats, read]);
  return useMemo(() => {
    const byId = new Map(sessions.map((s) => [s.id, s]));
    return { ...got, tasks: got.tasks.map((x) => nowState(x, byId)) };
  }, [got, seats]); // eslint-disable-line react-hooks/exhaustive-deps
}
const NONE = { tasks: [] as TaskView[], place: null };

/** The core's state word brought up to the seats as the window sees them now, by the core's own rule (ledger.rs `view`: a
 *  working seat that does not write is a review, one that writes is work). The list is read again only after a seat
 *  changes, and for that moment a task read "idle" while its Reviewer worked (q67 look L10-2). A closed task and one
 *  that needs the person keep the core's word. */
export function nowState(x: TaskView, byId: Map<string, Session>): TaskView {
  if (x.closed || x.state === 'needs') return x;
  // Look 1117 v11 (B N11-S2-3): a seat in `agent ask --wait` runs a command but waits for its answer, as the core's rule says.
  const busy = (writes: boolean) => (x.seats ?? []).some((seat) => seat.writes === writes && !!x.live?.includes(seat.session) && !x.asking?.includes(seat.session) && ((s) => !!s && agentState(s) === 'running' && shownStatus(s) === 'working')(byId.get(seat.session)));
  const state = busy(false) ? 'review' : busy(true) ? 'working' : x.state;
  return state === x.state ? x : { ...x, state };
}

/** A task whose merge the lead asked for (an open `merge` card in the owner decisions) waits for the person: it reads
 *  "needs you", and its card is the answer (real app 11-17: it read "ready to merge" while the lead waited). */
export function withMerges(tasks: TaskView[], owner: Decision[]): TaskView[] {
  const card = (x: TaskView) => owner.find((d) => d.owner?.type === 'merge' && d.owner.task === x.id && d.owner.place === x.place)?.id;
  return tasks.map((x) => (x.closed ? x : ((m) => (m ? { ...x, state: 'needs', merge: m } : x))(card(x))));
}

/** The user's roles (`role list`; Builder and Reviewer always exist), read once per mount. */
export function useRoles(core: CoreClient, on: boolean): Role[] {
  const [roles, setRoles] = useState<Role[]>([]);
  useEffect(() => {
    if (!on) return;
    let live = true;
    core.request({ op: 'role', operation: 'list' }).then(
      (r) => live && setRoles((r as { roles?: Role[] }).roles ?? []),
      () => {}, // a core without roles: the card lists none
    );
    return () => void (live = false);
  }, [core, on]);
  return roles;
}

/** The user sets the place's way or what its seats may do; every list is read again after. */
export async function setPlace(core: CoreClient, project: string, operation: 'way' | 'grant' | 'auto' | 'cap' | 'account', text: string) {
  await core.request({ op: 'task', operation, project, text });
  tasksChanged();
}
