// Ticket 1168 (mockup docs/design/bots-1166.html): a bot as the core keeps it (crates/nunchiro-core/src/team/bots.rs). It is
// the teammate with the same id, plus a face, a seat and a model rule; `team_list` answers both lists in the same order.
import { useSyncExternalStore } from 'react';
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

/** The 36 faces a bot can have (the core's `SHAPES` and `TILES`, team/bots.rs): six heads on six tiles. */
const SHAPES = ['bun', 'bear', 'round', 'drop', 'cat', 'bot'];
const TILES = ['lilac', 'sky', 'mint', 'peach', 'teal', 'slate'];
const faceAt = (k: number): BotFace => ({ shape: SHAPES[k % 6], tile: TILES[Math.floor(k / 6) % 6] });
const indexOf = (f: BotFace) => TILES.indexOf(f.tile) * 6 + SHAPES.indexOf(f.shape);
/** A face no bot has, for a bot not made yet: the next one after `from`, seven places on each time (as the core steps,
 *  so the head and the tile both change), or a first one picked by `start`. With all 36 in use, the next one anyway. */
export function freeFace(taken: BotFace[], from: BotFace | number): BotFace {
  const at = typeof from === 'number' ? from - 7 : indexOf(from);
  const used = new Set(taken.map(indexOf));
  for (let n = 1; n <= 36; n++) if (!used.has((at + 7 * n + 36) % 36)) return faceAt((at + 7 * n + 36) % 36);
  return faceAt((at + 7 + 36) % 36);
}

/** A bot's first chat while it lasts (the core's `First`, team/bots/first.rs): it wrote its SOUL file, and the seat its
 *  template asks for. */
export type First = { wrote: boolean; seat?: 'lead' | 'chief' | null };
export type SoulReply = { id: string; text: string; first?: First | null };

// Which bots are in their first chat, as the chat's cards last read it (FirstChat.tsx): the chat's header says so.
const firstChats = new Set<string>();
const firstSubs = new Set<() => void>();
export function markFirstChat(id: string, on: boolean) {
  if (firstChats.has(id) === on) return;
  if (on) firstChats.add(id);
  else firstChats.delete(id);
  firstSubs.forEach((f) => f());
}
export const useFirstChat = (id: string | null | undefined) =>
  useSyncExternalStore(
    (f) => (firstSubs.add(f), () => void firstSubs.delete(f)),
    () => !!id && firstChats.has(id),
  );

// The one-step dialog is the window's (App.tsx mounts it once): the Bots view and the palette ask for it.
const news = new Set<() => void>();
export const askNewBot = () => news.forEach((f) => f());
export const onNewBot = (f: () => void) => (news.add(f), () => void news.delete(f));
// The same for "Hand to a bot": the worktree whose row asked.
const hands = new Set<(path: string) => void>();
export const askHand = (path: string) => hands.forEach((f) => f(path));
export const onHand = (f: (path: string) => void) => (hands.add(f), () => void hands.delete(f));
