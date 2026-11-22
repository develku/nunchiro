// Ticket 571 (room panel): the Room tab of a project. One synthetic tab per project, `room:<project folder>`, at the end of the
// strip. It is not in the window's tab list (it cannot be closed or lost); the strip draws it for the shown project.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CoreClient } from '../api';
import type { Session } from '../types';
import type { TaskView } from '../lead/tasks';

export type RoomMessage = {
  id: string;
  kind: 'message' | 'ask' | 'reply' | 'timeout' | 'cap' | 'lost' | 'team' | 'typed'; // typed: what one seat typed into another's terminal (the core keeps it for the room)
  from: string;
  to: string;
  thread: string;
  reply_to?: string;
  body: string;
  created_by: 'agent' | 'person' | 'core';
  ts: number;
  /** Ticket 990: on a `team` line written by the core, what happened to the lead's team (the body says it in English). */
  team?: TeamNote;
};
export type TeamNote = { what: 'created' | 'removed' | 'handed' | 'taken' | 'told' | 'goal' | 'goal_no' | 'goal_yes' | 'memory_masked'; worktree?: string; name?: string; branch?: string; merged?: boolean; seat?: string };

const PREFIX = 'room:';
export const roomTabId = (project: string) => `${PREFIX}${project}`;
export const isRoomTab = (id: string | null) => !!id?.startsWith(PREFIX);
export const roomOfTab = (id: string | null) => (isRoomTab(id) ? id!.slice(PREFIX.length) : null);

export const PERSON = 'person';
/** The core numbers a room's messages m1, m2, ... in log order. */
export const num = (m: { id: string }) => Number(m.id.slice(1)) || 0;

/** The project of the top of a session's parent chain: the core's room scope (a worker in a worktree shares its lead's room). */
const top = (s: Session, byId: Map<string, Session>) => {
  for (let i = 0; i < 32 && s.parent && byId.has(s.parent); i++) s = byId.get(s.parent)!;
  return s;
};
/** The live sessions in a project's room, and the lead. Ticket 990: with a lead teammate (`leadMate`, an id) its live seat
 *  or none; without one the first root agent; else a root shell that started seats of its own (a script acting as an
 *  agent through the CLI). A lone shell is no lead: with no agent in the room there is none. */
export function seatsOf(project: string, sessions: Session[], byId: Map<string, Session>, leadMate?: string | null) {
  const seats = sessions.filter((s) => s.state === 'running' && !s.account_tab && !s.side_chat && top(s, byId).project === project);
  const roots = seats.filter((s) => !s.parent || !byId.has(s.parent));
  // Look 1117 v11 A S3-11: an unrelated Codex chat of the project stood in for a resumable lead.
  if (leadMate) return { seats, lead: seats.find((s) => s.teammate === leadMate && !s.agent_ended) ?? null };
  return { seats, lead: roots.find((s) => s.kind !== 'shell') ?? roots.find((r) => seats.some((s) => s.parent === r.id)) ?? null };
}

/** Look 1117 v11 B N11-S3-1: each seat the lead's ledger keeps, by its session id, with the name it was given. An ended seat
 *  whose row is gone (its worktree merged and cleaned up) is still named on the room's lines by it, never by its id. */
export const seatNames = (tasks: TaskView[]) => new Map(tasks.flatMap((x) => (x.seats ?? []).map((s) => [s.session, s.name] as const)));

/** Sessions of the room that ended (exited, failed or resumable; a closed tab is gone) and sent or were sent a message in it. */
export function endedSeats(project: string, sessions: Session[], byId: Map<string, Session>, messages: RoomMessage[]) {
  const named = new Set(messages.flatMap((m) => [m.from, m.to]));
  return sessions.filter((s) => s.state !== 'running' && s.state !== 'closed' && named.has(s.id) && !s.account_tab && !s.side_chat && top(s, byId).project === project);
}

const read = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null; // storage blocked: the room still works, it just forgets
  }
};
const write = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // as above
  }
};
// A message number means nothing in another log (a log moved aside starts again at m1), so what is kept is keyed by the project
// and the log's id (the core's `log`: the time of its first message).
export const roomKey = (project: string, log: number) => `${project}#${log}`;
const SEEN = (key: string) => `nunchiro.room.seen:${key}`;
// Ticket 593: pins live in the core now; this was where ticket 571c kept them, read once to carry them over.
const OLD_PINS = (key: string) => `nunchiro.room.pins:${key}`;

/** Ticket 592: the core pushes a `room` frame when any room changes, and the panel reads at once. The poll is a fallback
 *  only (a frame lost to a reconnect is caught by the read every reconnect makes). */
const POLL_MS = 15_000;
/** `names`: look 1117 v13 Home S3-1, the names of seats whose rows are gone (a removed teammate's), by session id. */
type Names = Record<string, string>;
type Page = { messages?: RoomMessage[]; reset?: boolean; log?: number; pins?: string[]; names?: Names };
type Room = { messages: RoomMessage[]; log: number; pins: string[]; names: Names };
const EMPTY: Room = { messages: [], log: 0, pins: [], names: {} };
const last = (list: RoomMessage[]) => list[list.length - 1];
const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
/** The shown project's room: the first read takes the newest messages, a later one only what came after the last message
 *  seen, and nothing is asked while the window is hidden. `unread` counts the messages for the person that came after the
 *  last time the Room tab was open. `pins` are the room's pinned ids, kept by the core, the same in every window. */
export function useRoom(core: CoreClient, project: string | null, connected: boolean, open: boolean) {
  const [room, setRoom] = useState<Room>(EMPTY);
  // Ticket 773: how many carried-over pins the core refused, said once in the Room (the old key is gone after one try).
  const [dropped, setDropped] = useState(0);
  const now = useRef({ project, room });
  now.current = { project, room };
  const refresh = useCallback(async () => {
    const asked = now.current;
    if (!asked.project) return;
    const { messages, log } = asked.room;
    try {
      const page = (await core.request({ op: 'room_read', project: asked.project, since: messages.length ? num(last(messages)) : 0, log })) as Page;
      if (now.current.project !== asked.project) return;
      const got = page.messages ?? [];
      const pins = page.pins ?? [];
      const names = page.names ?? {};
      // The same list stays the same array: a read that found nothing new must not draw the window again.
      setRoom((old) => {
        const keep = same(old.pins, pins) ? old.pins : pins;
        const named = JSON.stringify(old.names) === JSON.stringify(names) ? old.names : names;
        if (page.reset) return old.log === page.log && old.messages.length === got.length && last(old.messages)?.id === last(got)?.id && last(old.messages)?.ts === last(got)?.ts && keep === old.pins && named === old.names ? old : { messages: got, log: page.log ?? 0, pins: keep, names: named };
        const fresh = got.filter((m) => num(m) > num(last(old.messages) ?? { id: 'm0' })); // two overlapping reads bring the same page twice
        return fresh.length || keep !== old.pins || named !== old.names ? { messages: [...old.messages, ...fresh], log: page.log ?? old.log, pins: keep, names: named } : old;
      });
    } catch {
      // The next push or poll tries again.
    }
  }, [core]);
  useEffect(() => {
    setRoom(EMPTY);
    setDropped(0);
    if (!project || !connected) return;
    const tick = () => document.visibilityState === 'visible' && void refresh();
    tick();
    const timer = setInterval(tick, POLL_MS);
    const off = core.onRoom(tick);
    document.addEventListener('visibilitychange', tick); // coming back to the window reads at once
    return () => (clearInterval(timer), off(), document.removeEventListener('visibilitychange', tick));
  }, [core, project, connected, refresh]);
  // Ticket 593: pins this window kept before the core held them are carried over once, then forgotten here.
  useEffect(() => {
    if (!project || !room.log) return;
    const key = OLD_PINS(roomKey(project, room.log));
    let ids: string[] = [];
    try {
      const v: unknown = JSON.parse(read(key) ?? '[]');
      ids = Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
      localStorage.removeItem(key);
    } catch {
      return; // storage blocked: nothing was kept there
    }
    const missing = ids.filter((id) => !room.pins.includes(id));
    if (missing.length)
      void Promise.allSettled(missing.map((message) => core.request({ op: 'room_pin', project, message, pinned: true }))).then((got) => {
        const refused = got.filter((r) => r.status === 'rejected').length;
        if (refused && now.current.project === project) setDropped(refused);
        return refresh();
      });
  }, [core, project, room.log, room.pins, refresh]);
  const toggle = useCallback(
    async (message: string) => {
      if (!project) return;
      await core.request({ op: 'room_pin', project, message, pinned: !now.current.room.pins.includes(message) });
      await refresh();
    },
    [core, project, refresh],
  );
  const key = roomKey(project ?? '', room.log);
  const [seen, setSeen] = useState<{ key: string; n: number }>({ key, n: 0 });
  const seenN = seen.key === key ? seen.n : Number(read(SEEN(key)) ?? 0) || 0;
  const newest = room.messages.reduce((n, m) => Math.max(n, num(m)), 0);
  useEffect(() => {
    if (!open || !project || newest <= seenN) return;
    write(SEEN(key), String(newest));
    setSeen({ key, n: newest });
  }, [open, project, key, newest, seenN]);
  const unread = open ? 0 : room.messages.filter((m) => m.to === PERSON && num(m) > seenN).length;
  return { messages: room.messages, log: room.log, pins: room.pins, names: room.names, dropped, toggle, unread, refresh };
}
