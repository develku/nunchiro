// Ticket 990 (leader and room, docs/design/leader-room/index.html H2): the window's copy of the teammates (Settings > Team)
// and the few questions every leader view asks of it. A place is a project folder, or '' for Home (no project). Every new
// piece of the window keys on a `lead` teammate or on a Home teammate: with neither, nothing new is drawn.
import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { CoreClient } from '../api';
import type { ListedWorktree } from '../tree';
import { agentState, type Session } from '../types';

type Level = 'light' | 'standard' | 'deep';
/** Ticket 992: `level` absent is Auto (`level_max` its upper limit), else pinned; `next_level` is the level picked on the seat's
 *  row for the next task. A teammate with a `model` has no levels ("Custom model"). Ticket 994: `agent` names the ACP agent
 *  of a teammate whose `kind` is `acp`. */
export type Teammate = { id: string; name: string; job: string; kind: 'claude' | 'codex' | 'acp'; agent?: string | null; model?: string | null; effort?: string | null; project?: string | null; lead?: boolean; level?: Level | null; level_max?: Level | null; next_level?: Level | null };
/** `team_list`: the teammates and the folder every Home teammate works in (also Home's room). */
export type Team = { teammates: Teammate[]; home: string };

const NONE: Team = { teammates: [], home: '' };
let state: Team = NONE;
let client: CoreClient | null = null;
const subs = new Set<() => void>();
/** Settings > Team hands every list it gets here, so the tree and the headers follow a save at once. */
export function setTeam(next: Team) {
  state = next;
  subs.forEach((f) => f());
}
export async function refreshTeam(core: CoreClient | null = client) {
  if (!core) return;
  client = core;
  try {
    setTeam((await core.request({ op: 'team_list' })) as Team);
  } catch {
    // A core without the team ops has no teammates: nothing new is drawn.
  }
}
export function useTeam(core: CoreClient, connected: boolean): Team {
  useEffect(() => void (connected && refreshTeam(core)), [core, connected]);
  return useSyncExternalStore(
    (f) => (subs.add(f), () => subs.delete(f)),
    () => state,
  );
}

/** Ticket 990: the core finds the teammate's seat or starts it with its brief (`team_open`); the caller shows its tab. */
export async function openSeat(core: CoreClient, id: string) {
  return (await core.request({ op: 'team_open', id })) as { session: Session; started: boolean };
}

export const placeOfMate = (m: Teammate) => m.project ?? '';
/** A session's place: Home for the Home folder, else its project (a worktree session's project is its main checkout). */
export const placeOf = (s: Session, team: Team) => (team.home && s.project === team.home ? '' : s.project);
/** The folder a place's room is kept under. */
export const roomOfPlace = (place: string, team: Team) => place || team.home;
export const leadOf = (team: Team, place: string) => team.teammates.find((m) => m.lead && placeOfMate(m) === place) ?? null;
const live = (s: Session) => agentState(s) === 'running' && !s.side_chat && !s.account_tab;
/** A teammate's seat while it runs. */
export const seatOf = (sessions: Session[], id: string) => sessions.find((s) => s.teammate === id && live(s)) ?? null;
/** Sixth look (Home S3): the word of a teammate with no running seat. One whose seat can be resumed (its run ended with
 *  the core) reads "resumable", as that seat's header, tab and status bar do; "not running" is one with no seat to continue. */
export const restKey = (sessions: Session[], id: string) => (sessions.some((s) => s.teammate === id && s.state === 'resumable') ? 'mw.status.resumable' : 'lead.notRunning');
/** Sixth look (Home S3): an idle seat ended for a task at another level (team.rs `open_seat` starts the new seat and ends
 *  the old one in one lock) hands its open tab to the new seat, as the tree row does: the tab stayed on the closed seat,
 *  read only. Only a seat that was running at the last snapshot: a seat that ended earlier keeps its tab, so an old
 *  conversation can still be read beside the new one. */
export function useSeatFollow(sessions: Session[], tabs: string[], follow: (old: string, next: string) => void) {
  const before = useRef<Session[]>([]);
  useEffect(() => {
    for (const old of before.current) {
      if (!old.teammate || !live(old) || !tabs.includes(old.id)) continue;
      const next = seatOf(sessions, old.teammate);
      if (next && next.id !== old.id && !sessions.some((s) => s.id === old.id && live(s))) follow(old.id, next.id);
    }
    before.current = sessions;
  }, [sessions]); // eslint-disable-line react-hooks/exhaustive-deps
}
/** The teammate whose seat this session is, when that teammate leads its place. */
export const leadSeatMate = (s: Session | null, team: Team) => (s?.teammate ? (team.teammates.find((m) => m.id === s.teammate && m.lead) ?? null) : null);

/** Rule 3 (H2): the worktrees of a lead's team, and the project's independent ones. */
export const teamWorktrees = (list: ListedWorktree[], lead: Teammate) => list.filter((w) => w.team === lead.id && !w.missing);
export const independent = (list: ListedWorktree[], project: string) => list.filter((w) => w.project === project && !w.team && !w.missing);

/** The lead a session works for, other than its own seat: its worktree is in the lead's team, its parent chain reaches
 *  the lead's seat, or it is another teammate of a place that has a lead. */
export function workingFor(s: Session, team: Team, sessions: Session[], list: ListedWorktree[]): Teammate | null {
  const lead = leadOf(team, placeOf(s, team));
  if (s.teammate && lead?.id === s.teammate) return null;
  const wt = list.find((w) => w.path === s.cwd && w.team);
  if (wt) return team.teammates.find((m) => m.id === wt.team) ?? null;
  if (!lead) return null;
  if (s.teammate) return lead;
  const byId = new Map(sessions.map((x) => [x.id, x]));
  let at: Session | undefined = s;
  for (let i = 0; i < 32 && at?.parent; i++) {
    at = byId.get(at.parent);
    if (at?.teammate === lead.id) return lead;
  }
  return null;
}
