// Ticket 388 (mock final/388.html, approved 11-10): a project or group head's sessions as one colour strip in a fixed
// right column, one bar per session. Same colours sit together in the order red, orange, (limited), yellow, blue, grey;
// a colour with 3 or more sessions is one bar and its number. Clicking a colour opens its longest-waiting session.
import { useEffect, useId, useRef, useState, type RefObject } from 'react';
import { leaves, rowState, type Worktree, type WorktreeFact } from '../tree';
import { shownStatus, type Session } from '../types';
import { asks } from './decisions';
import type { T } from './state';

/** r failed, o your turn, w usage limit, y stale, b working, g idle or resting. A finished session folded into "N done" has no bar. */
export type Tone = 'r' | 'o' | 'w' | 'y' | 'b' | 'g';
export const TONES: readonly Tone[] = ['r', 'o', 'w', 'y', 'b', 'g'];
const WORD = { r: 'tree.strip.r', o: 'tree.strip.o', w: 'tree.strip.w', y: 'tree.strip.y', b: 'tree.strip.b', g: 'tree.strip.g' } as const;
const ONE: Partial<Record<string, 'look8.strip.w1' | 'look8.strip.y1' | 'look8.strip.g1' | 'look8.strip.gDone1'>> = { 'tree.strip.w': 'look8.strip.w1', 'tree.strip.y': 'look8.strip.y1', 'tree.strip.g': 'look8.strip.g1', 'tree.strip.gDone': 'look8.strip.gDone1' };
/** "2 failed", "3 idle": a colour's word and count. Ticket 991 A7: grey also counts finished sessions whose row still shows
 *  (ticket 462), so its words say which are idle and which finished ("2 idle, 1 finished"). */
export const word = (t: T, x: Tone, list: StripSession[]) => {
  const done = x === 'g' ? list.filter((s) => s.rest).length : 0;
  const live = list.length - done;
  // Eighth look (C): Spanish read "1 inactivas". The words that take a number in es, fr and pt have a form for one.
  const say = (key: (typeof WORD)[Tone] | 'tree.strip.gDone', n: number) => t((n === 1 && ONE[key]) || key, { n });
  if (!done) return say(WORD[x], live);
  return live ? `${say(WORD[x], live)}, ${say('tree.strip.gDone', done)}` : say('tree.strip.gDone', done);
};
// Keyed by the status word, not the type: v29-limit's `limited` status lands its own tone here whether or not it is on main yet.
// A turn waiting for an answer (`agent ask --wait`) is no working bar: grey, as its row (look 1117 v13 B N13-S3-6).
const OF: Partial<Record<string, Tone>> = { failed: 'r', waiting: 'o', limited: 'w', stale: 'y', working: 'b', asked: 'g', idle: 'g' };
/** `rest`: a finished session whose row still shows (the mockup's 쉬는 중, grey rail and check icon); see `stripSessions`. */
export type StripSession = Session & { rest?: true };
export const toneOf = (s: StripSession): Tone | undefined => {
  const st = shownStatus({ ...s, pending: asks(s.pending) });
  return OF[st] ?? (st === 'done' && s.rest ? 'g' : undefined);
};

/** A head's strip: every main-folder session of the project, one bar per worktree row, and (ticket 462, owner 11-12) one grey
 * bar for each visible worktree row with no coloured session. Main-folder finished sessions fold into "N done" and merged or gone rows leave: no bar. */
export function stripSessions(g: { main: Session[]; worktrees: Worktree[] }, facts?: ReadonlyMap<string, WorktreeFact>): StripSession[] {
  const rest = new Set(g.worktrees.flatMap((w) => (!w.sessions.length || w.sessions.some((s) => toneOf(s)) || leaves(rowState(w, w.sessions, facts?.get(w.path))) ? [] : [w.sessions[0].id])));
  const mark = (s: Session): StripSession => (rest.has(s.id) ? { ...s, rest: true } : s);
  // Look 1117 v10 A-N6: a worktree's sessions share its one row (TREEROWS), so it is one bar too: its most urgent session's.
  const rank = (s: StripSession) => TONES.indexOf(toneOf(s)!);
  const one = (w: Worktree) => w.sessions.map(mark).filter((s) => toneOf(s)).sort((a, b) => rank(a) - rank(b) || since(a) - since(b)).slice(0, 1);
  return [...g.main.map(mark), ...g.worktrees.flatMap(one)];
}
/** When it began waiting: its oldest ask, else its last output. Smaller waited longer. */
export const since = (s: Session) => {
  const a = asks(s.pending).map((d) => d.observed_at);
  return a.length ? Math.min(...a) : s.attention.last_activity;
};

/** Sessions by tone, each list longest-waiting first; tones with none are absent. */
export function byTone(sessions: StripSession[]): Map<Tone, StripSession[]> {
  const m = new Map<Tone, StripSession[]>();
  for (const s of [...sessions].sort((a, b) => since(a) - since(b))) {
    const t = toneOf(s);
    if (t) m.set(t, [...(m.get(t) ?? []), s]);
  }
  return new Map(TONES.filter((t) => m.has(t)).map((t) => [t, m.get(t)!]));
}

/** The "]" queue: your turn first, then failed, each longest-waiting first. */
export const urgentQueue = (sessions: Session[]) => {
  const m = byTone(sessions);
  return [...(m.get('o') ?? []), ...(m.get('r') ?? [])];
};

/** The bars of one colour: 1 or 2 stay separate, 3 or more are one bar and the number. */
const Bars = ({ n }: { n: number }) => (n >= 3 ? <><i /><span className="num">{n}</span></> : <>{Array.from({ length: n }, (_, i) => <i key={i} />)}</>);

/** One line per present colour, the hovered one bold. */
const summary = (t: T, m: Map<Tone, StripSession[]>, on: Tone | null) =>
  [...m].map(([x, list], i) => (
    <span key={x}>
      {i > 0 && ' · '}
      {x === on ? <b>{word(t, x, list)}</b> : word(t, x, list)}
    </span>
  ));

export function Strip({ sessions, dim, next, onPick, t }: { sessions: StripSession[]; dim: boolean; next?: string; onPick: (tone: Tone, list: Session[]) => void; t: T }) {
  const [on, setOn] = useState<Tone | null>(null);
  const keyId = useId();
  const m = byTone(sessions);
  // The column stays when empty, so names and branches end at the same place on every head.
  if (!m.size) return <span className="cstrip" aria-hidden="true" />;
  return (
    <span className="cstrip" data-hint-quiet data-dim={dim || undefined} data-on={on ?? undefined} onPointerLeave={() => setOn(null)}>
      {[...m].map(([x, list]) => (
        <button
          key={x}
          type="button"
          className="sg"
          data-tone={x}
          data-n={list.length}
          data-on={x === on || undefined}
          data-ids={list.map((s) => s.id).join(' ')}
          aria-label={t('tree.strip.open', { what: word(t, x, list) })}
          aria-describedby={next ? keyId : undefined} // the "]" hint lives in the aria-hidden tip; a reader gets it here
          onPointerEnter={() => setOn(x)}
          onFocus={() => setOn(x)}
          onBlur={() => setOn(null)}
          onPointerDown={(e) => e.stopPropagation()} // not a project drag
          onClick={(e) => (e.stopPropagation(), onPick(x, list))}
        >
          <Bars n={list.length} />
        </button>
      ))}
      <span className="stip glass" aria-hidden="true">
        {summary(t, m, on)}
        {next && (
          <span className="key" id={keyId}>
            {/* the mockup's 5px after the key box, no space glyph; the hidden space keeps the words apart for a reader */}
            <kbd>]</kbd>
            <span className="sr"> </span>
            {t('tree.strip.next', { name: next })}
          </span>
        )}
      </span>
    </span>
  );
}

type Side = { name: string; ids: string[] };
const vis = (e: Element) => e.getClientRects().length > 0;
/** Where a session shows in the tree: its own row, else the innermost head strip that counts it. */
export function placeOf(nav: Element, id: string): HTMLElement | undefined {
  const row = [...nav.querySelectorAll<HTMLElement>(`button.row.wt2[data-menu-session="${CSS.escape(id)}"]`)].find(vis);
  return row ?? [...nav.querySelectorAll<HTMLElement>('.row .cstrip .sg')].filter((e) => vis(e) && e.dataset.ids!.split(' ').includes(id)).at(-1);
}
const nameAt = (e: Element) => e.closest<HTMLElement>('.grp[data-project]')?.dataset.project ?? e.closest<HTMLElement>('.pgrp[data-group]')?.dataset.group ?? '';

/** Failed and your-turn sessions scrolled out of the tree's view, above and below; re-read on scroll, resize and every render. */
export function useHidden(nav: RefObject<HTMLElement | null>, urgent: Session[]) {
  const [hidden, setHidden] = useState<{ top?: Side; bottom?: Side }>({});
  const ids = useRef<string[]>([]);
  ids.current = urgent.map((s) => s.id);
  const frame = useRef(0);
  const read = useRef(() => {});
  read.current = () => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      const n = nav.current;
      if (!n) return;
      const box = n.getBoundingClientRect();
      const out: { top?: Side; bottom?: Side } = {};
      // In tree order, so the name is the one nearest the edge (the last above, the first below).
      const placed = ids.current.flatMap((id) => {
        const e = placeOf(n, id);
        return e ? [{ id, e, r: e.getBoundingClientRect() }] : [];
      });
      for (const { id, e, r } of placed.sort((a, b) => a.r.top - b.r.top)) {
        const side = r.bottom <= box.top + 1 ? 'top' : r.top >= box.bottom - 1 ? 'bottom' : null;
        if (!side) continue;
        const s = (out[side] ??= { name: nameAt(e), ids: [] });
        if (side === 'top') s.name = nameAt(e);
        s.ids.push(id);
      }
      setHidden((h) => (JSON.stringify(h) === JSON.stringify(out) ? h : out));
    });
  };
  useEffect(() => read.current());
  useEffect(() => {
    const n = nav.current;
    if (!n) return;
    const go = () => read.current();
    const ro = new ResizeObserver(go);
    ro.observe(n);
    n.addEventListener('scroll', go, { passive: true });
    return () => (ro.disconnect(), n.removeEventListener('scroll', go), cancelAnimationFrame(frame.current));
  }, [nav]);
  return hidden;
}

/** The small strip at the tree's top or bottom edge: the arrow scrolls to the nearest hidden one, a colour opens its longest-waiting session. */
export function Gather({ side, at, sessions, onScroll, onPick, t }: { side: 'top' | 'bottom'; at?: Side; sessions: Session[]; onScroll: (id: string) => void; onPick: (tone: Tone, list: Session[]) => void; t: T }) {
  if (!at) return null;
  const m = byTone(sessions.filter((s) => at.ids.includes(s.id)));
  if (!m.size) return null;
  const words = [t(side === 'top' ? 'tree.strip.above' : 'tree.strip.below', { name: at.name }), ...[...m].map(([x, l]) => word(t, x, l))].join(' · ');
  return (
    <div className={`gat ${side}`}>
      <div className="gbox glass" data-hint-quiet>
        {/* The mockup's gather summary: where, then each colour's count in bold. */}
        <span className="stip glass" aria-hidden="true">
          {t(side === 'top' ? 'tree.strip.above' : 'tree.strip.below', { name: at.name })}
          {[...m].map(([x, l]) => (
            <span key={x}>
              {' · '}
              <b>{word(t, x, l)}</b>
            </span>
          ))}
        </span>
        <button type="button" className="gch" aria-label={t(side === 'top' ? 'tree.strip.scrollUp' : 'tree.strip.scrollDown')} onClick={() => onScroll(side === 'top' ? at.ids.at(-1)! : at.ids[0])}>
          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
            <path d={side === 'top' ? 'M4 10l4-4 4 4' : 'M4 6l4 4 4-4'} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        {[...m].map(([x, list]) => (
          <button key={x} type="button" className="sg" data-tone={x} data-n={list.length} aria-label={`${words} · ${t('tree.strip.open', { what: word(t, x, list) })}`} onClick={() => onPick(x, list)}>
            <Bars n={list.length} />
          </button>
        ))}
      </div>
    </div>
  );
}
