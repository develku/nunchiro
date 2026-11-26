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

export function takeDraftsHome(core: CoreClient, sessions: Session[], composer: RefObject<HTMLTextAreaElement | null>) {
  for (const s of sessions) {
    const home = s.draft_home;
    if (!home) continue;
    const key = `${s.id}:${home.at}`;
    if (!taken.has(key)) {
      taken.add(key);
      const el = composer.current;
      let homed: Homed;
      if (el && el.dataset.draftFor === s.id) {
        const before = el.value;
        el.value = joined(before, home.words);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        homed = { words: home.words, before, after: el.value };
      } else {
        const before = getDraft(s.id);
        setDraft(s.id, joined(before, home.words));
        homed = { words: home.words, before, after: getDraft(s.id) };
      }
      noted.set(s.id, homed);
      emit();
    }
    // Answered on every snapshot that still carries them (a lost answer is sent again); the core keeps them until then.
    void core.request({ op: 'draft_taken', id: s.id }).catch(() => {});
  }
}
