// Text left in an agent's terminal box comes home (crates/nunchiro-core/src/sessions/home.rs): the core takes one row of
// the owner's words out of the box and hands them here (`draft_home`). The session's composer appends them to its draft,
// after a line break when it holds text, says so, and answers `draft_taken` so the core drops its side copy. Each hand-over
// is taken once (its time is its key); with no window the words wait in the core for the next one.
import { useSyncExternalStore, type RefObject } from 'react';
import type { CoreClient } from '../api';
import type { Session } from '../types';
import { getDraft, setDraft } from '../composer-drafts';

const taken = new Set<string>();
/** The composer's line, by session: the words that came home and the box before and after (for ⌘Z). */
export type Homed = { words: string; before: string; after: string };
const noted = new Map<string, Homed>();
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());
export const useHomed = (id: string | undefined) => useSyncExternalStore((f) => (subs.add(f), () => void subs.delete(f)), () => (id ? noted.get(id) : undefined));
export const clearHomed = (id: string) => noted.delete(id) && emit();

const joined = (draft: string, words: string) => (draft ? `${draft.replace(/\n*$/, '')}\n${words}` : words);

/** The words each session's composer took last: a merged hand-over that starts with them adds only the rest. */
const last = new Map<string, string>();
/** The draft store keeps this many characters (composer-drafts.ts): words that would not fit stay in the core. */
const ROOM = 100_000;

export function takeDraftsHome(core: CoreClient, sessions: Session[], composer: RefObject<HTMLTextAreaElement | null>) {
  for (const s of sessions) {
    const home = s.draft_home;
    if (!home) continue;
    const key = `${s.id}:${home.at}`;
    if (!taken.has(key)) {
      const before0 = last.get(s.id);
      // Words already taken whose answer the core had not seen yet, with newer ones behind them: only the newer ones.
      const words = before0 && home.words.startsWith(`${before0}\n`) ? home.words.slice(before0.length + 1) : home.words;
      const el = composer.current;
      const shown = !!el && el.dataset.draftFor === s.id;
      const before = shown ? el!.value : getDraft(s.id);
      const after = joined(before, words);
      if (after.length > ROOM) continue; // kept in the core (no answer) until the box has room
      taken.add(key);
      last.set(s.id, home.words);
      if (shown) {
        el!.value = after;
        el!.dispatchEvent(new Event('input', { bubbles: true }));
      } else setDraft(s.id, after);
      const homed: Homed = { words, before, after };
      noted.set(s.id, homed);
      emit();
    }
    // Answered on every snapshot that still carries them (a lost answer is sent again); `at` names this hand-over.
    void core.request({ op: 'draft_taken', id: s.id, at: home.at }).catch(() => {});
  }
}
