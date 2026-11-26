// Ticket 1168 (mockup docs/design/bots-1166.html): a bot as the core keeps it (crates/nunchiro-core/src/team/bots.rs). It is
// the teammate with the same id, plus a face, a seat and a model rule; `team_list` answers both lists in the same order.
import { shownStatus, type Session } from '../types';

export type Seat = { kind: 'none' } | { kind: 'chief' } | { kind: 'lead'; project: string };
export type BotFace = { shape: string; tile: string };
export type Bot = {
  id: string;
  name: string;
  job: string;
  face: BotFace;
  seat: Seat;
  agent: string;
  model: { rule: 'follow' } | { rule: 'pinned'; model: string; effort?: string | null };
  v1?: { project?: string; effort?: string; level?: string; level_max?: string; next_level?: string };
};

/** What a face's eyes say: closed (resting), down and reading (working), on you (needs you). */
export type Eyes = 'rest' | 'work' | 'look';
/** The bot's state is its seat's: the session it sits in waits for the person, works, or neither (no seat runs: resting). */
export function eyesOf(sessions: Session[], id: string): Eyes {
  const seat = sessions.find((s) => s.teammate === id && s.state === 'running');
  const st = seat ? shownStatus(seat) : null;
  return st === 'waiting' ? 'look' : st === 'working' ? 'work' : 'rest';
}

// The Bots view is the window's (App.tsx owns the modal); a Settings page or a command asks for it from anywhere.
const asks = new Set<(id?: string) => void>();
export const openBots = (id?: string) => asks.forEach((f) => f(id));
export const onOpenBots = (f: (id?: string) => void) => (asks.add(f), () => void asks.delete(f));
