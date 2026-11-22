// v25-palette-groups: the tree row's tones for one session (tree.ts rowState: your turn, working, failed), and `done` for an ended one.
import { ageText } from '../chat/PrChip';
import type { T } from '../i18n';
import { status, statusKey, type Session } from '../types';

export type PaletteState = 'you' | 'run' | 'done' | 'bad' | 'idle';

export const paletteState = (s: Session): PaletteState => {
  const st = status(s);
  return st === 'waiting' ? 'you' : st === 'working' ? 'run' : st === 'done' ? 'done' : st === 'failed' ? 'bad' : 'idle';
};

/** Look 1117 v10 Home S3-5, v11 A S3-12: two sessions of one name in one project gave two identical "Go to" rows. Each of
 *  them adds the state word its tree row reads and its last activity (" · resumable · 3 h ago"), and the session id's last four
 *  characters after a "#" when those words match too; a unique name adds nothing. */
export const sameNameTell = (list: readonly Session[], name: (s: Session) => string, t: T, now = Date.now()) => {
  const key = (s: Session) => `${s.project}\0${name(s)}`;
  const count = new Map<string, number>();
  for (const s of list) count.set(key(s), (count.get(key(s)) ?? 0) + 1);
  const words = (s: Session) => {
    const age = s.attention.last_activity ? ageText(new Date(s.attention.last_activity).toISOString(), now, t) : '';
    return ` · ${t(statusKey(s))}${age && ` · ${age}`}`;
  };
  // v16 A S3-12: two of them with the same state and time words still matched; those add their id's tail too.
  const same = new Map<string, number>();
  for (const s of list) if ((count.get(key(s)) ?? 0) > 1) same.set(key(s) + words(s), (same.get(key(s) + words(s)) ?? 0) + 1);
  return (s: Session) => {
    if ((count.get(key(s)) ?? 0) < 2) return '';
    const w = words(s);
    return (same.get(key(s) + w) ?? 0) > 1 ? `${w} · #${s.id.slice(-4)}` : w;
  };
};
