// Design book (tree rows and the five states): a session's state is one 8 px dot (`.sdot`, light-glass.css) plus its word.
import type { RowState } from './tree';

export type DotKind = 'run' | 'you' | 'bad' | 'warn' | 'done' | 'idle';

/** A status word (`shownStatus`, a tab's or the header's `data-s`) as its dot. Asked and stale rest as idle rings. */
const BY_STATUS: Record<string, DotKind> = { working: 'run', waiting: 'you', failed: 'bad', limited: 'warn', done: 'done' };
export const dotOfStatus = (s: string): DotKind => BY_STATUS[s] ?? 'idle';

/** A tree row's tone as its dot: an open PR or a merged branch is done; a finished row that still shows (`rest`) too. */
const BY_TONE: Record<RowState['tone'], DotKind> = { you: 'you', bad: 'bad', run: 'run', warn: 'warn', ok: 'done', done: 'done', idle: 'idle' };
export const dotOfRow = (r: Pick<RowState, 'tone' | 'rest'>): DotKind => (r.tone === 'idle' && r.rest ? 'done' : BY_TONE[r.tone]);

/** Every working dot on screen breathes in one phase: a breathe animation that starts (a dot mounts, unhides or turns
 *  working) is put on the document clock's zero, so its phase is the clock's, the same for all. */
export function syncBreathing(doc: Document = document) {
  doc.addEventListener(
    'animationstart',
    (e) => {
      if (e.animationName !== 'breathe') return;
      for (const a of (e.target as Element).getAnimations()) if ((a as CSSAnimation).animationName === 'breathe') a.startTime = 0;
    },
    true,
  );
}
