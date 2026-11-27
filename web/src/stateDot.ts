// Design book (tree rows and the five states): a session's state is one 8 px dot (`.sdot`, light-glass.css) plus its word.
import type { RowState } from './tree';

export type DotKind = 'run' | 'you' | 'bad' | 'warn' | 'done' | 'idle';

/** A status word (`shownStatus`, a tab's or the header's `data-s`) as its dot. Asked and stale rest as idle rings. */
const BY_STATUS: Record<string, DotKind> = { working: 'run', waiting: 'you', failed: 'bad', limited: 'warn', done: 'done' };
export const dotOfStatus = (s: string): DotKind => BY_STATUS[s] ?? 'idle';

/** A tree row's tone as its dot: an open PR or a merged branch is done; a finished row that still shows (`rest`) too. */
const BY_TONE: Record<RowState['tone'], DotKind> = { you: 'you', bad: 'bad', run: 'run', warn: 'warn', ok: 'done', done: 'done', idle: 'idle' };
export const dotOfRow = (r: Pick<RowState, 'tone' | 'rest'>): DotKind => (r.tone === 'idle' && r.rest ? 'done' : BY_TONE[r.tone]);

/** A working row's elapsed time, tabular: "0:42", "4:12", "1:04:12". */
export const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const [h, m, r] = [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60];
  const two = (n: number) => String(n).padStart(2, '0');
  return h ? `${h}:${two(m)}:${two(r)}` : `${m}:${two(r)}`;
};

/** A resting row's age, short: "<1m", "12m", "2h", "3d" (the design book's "idle · 2h"). */
export const shortAge = (ms: number) => {
  const m = Math.floor(Math.max(0, ms) / 60_000);
  return m < 1 ? '<1m' : m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`;
};

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
