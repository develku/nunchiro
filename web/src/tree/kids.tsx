// V2-CF4: the sub-agents under a session row, read-only. One `subagents` read per session, refreshed on a timer; the
// request only ever reads the core's copy of the agent's own transcript, so opening or folding a row writes nothing.
import { useEffect, useMemo, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { sessionKids, type Linked, type T } from './state';
import { openSession } from '../tree';
import type { CoreClient } from '../api';
import { agentState, type Kid, type Session } from '../types';

/** A working child can change without the snapshot moving, so the count is re-read at this pace while the window is connected. */
export const REFRESH_MS = 5000;

/** V2.5-30: a child session carries its own children, so a worker's workers nest under it to any depth. `session`:
 *  the row comes from a `parent` link, so it is a session of its own (it opens as one), not a transcript child. */
export type Nest = Kid & { kids?: Nest[]; session?: true };

export type KidMap = ReadonlyMap<string, Nest[]>;

/** A child session in the words a transcript child uses: an idle one claims nothing, like an undated launch. */
const sessionState = (s: Linked): Kid['state'] =>
  s.state === 'failed' ? 'failed' : agentState(s) !== 'running' ? 'done' : s.attention.working ? 'working' : 'unknown';

/** The children, and the moment they were last read: a child's age moves with this read, not with a timer of its own. */
export type KidRead = { map: KidMap; now: number };

export function useKids(core: CoreClient, connected: boolean, sessions: Session[]): KidRead {
  const [kids, setKids] = useState<KidMap>(new Map());
  const [now, setNow] = useState(() => Date.now());
  // A shell never reports children, and neither does an ACP agent that sends no `subagent_update`: no read for them.
  const key = sessions
    .filter((s) => s.kind !== 'shell' && s.state === 'running')
    .map((s) => s.id)
    .sort()
    .join('\n');
  useEffect(() => {
    if (!connected) return;
    let live = true;
    const read = () => {
      const ids = key ? key.split('\n') : [];
      void Promise.all(
        ids.map((id) =>
          core.request({ op: 'subagents', id }).then(
            (r): readonly [string, Kid[]] => [id, (r as { kids?: Kid[] }).kids ?? []],
            (): readonly [string, Kid[]] => [id, []],
          ),
        ),
      ).then((rows) => {
        if (!live) return;
        const next = new Map(rows.filter(([, list]) => list.length));
        // The same read dates the ages: one timer, so a child's "1m" never ticks on a frame of its own.
        setNow(Date.now());
        setKids((old) => (JSON.stringify([...old]) === JSON.stringify([...next]) ? old : next));
      });
    };
    read();
    const timer = window.setInterval(read, REFRESH_MS);
    return () => ((live = false), window.clearInterval(timer));
  }, [core, connected, key]);
  // V2.5-30: the sessions each session started (its `parent` link) join its transcript's children, after them.
  const map = useMemo(() => {
    const tree = sessionKids(sessions);
    const nest = (s: Linked): Nest => ({ id: s.id, label: s.label || s.kind, state: sessionState(s), session: true, kids: (tree.get(s.id) ?? []).map(nest) });
    const all = new Map<string, Nest[]>(kids);
    for (const [id, list] of tree) all.set(id, [...(all.get(id) ?? []), ...list.map(nest)]);
    return all;
  }, [kids, sessions]);
  return { map, now };
}

/**
 * What a row says. `running` is a child the core saw launched, has not seen end, and dated: the transcript's own record
 * of a launch still in flight, so the row reads "working 1m". A child the agent reported none of that for stays
 * `unknown`: no word, a neutral rail, and no working count, rather than a guess that it is running.
 */
type Show = 'running' | 'done' | 'failed' | 'unknown';

const shown = (k: Kid): Show => {
  if (k.state === 'unknown') return k.started_at === undefined ? 'unknown' : 'running';
  return k.state === 'working' ? 'running' : k.state;
};

export const WORD = { running: 'tree.subagents.working', done: 'tree.subagents.done', failed: 'tree.subagents.failed' } as const;

/** A row's state word with its age ("working 1m"); nothing for a child nobody said anything about. The panel reads it too. */
export const wordOf = (k: Kid, now: number, t: T) => {
  const s = shown(k);
  if (s === 'unknown') return '';
  return s === 'running' && k.started_at !== undefined ? [t(WORD[s]), age(k.started_at, now)].join(' ') : t(WORD[s]);
};

/** The age since a launch, coarse (s under a minute, then m, then h): the mockup's "working 1m", not a stopwatch. */
const age = (startedAt: number, now: number) => {
  const s = Math.max(0, Math.floor(now / 1000 - startedAt));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`;
};

/**
 * The session's `↳ N`, at the right end of its own row (option A: no extra row while folded). The words sit in the
 * tooltip and the label only, so the number reads once; the control is a button, so pointer and keyboard open alike.
 * A row that is itself a button cannot hold one: `over` places it over that row's right end instead.
 */
export function KidCount({ ids, name, kids, open, onToggle, over = false, t }: { ids: string[]; name: string; kids: Kid[]; open: boolean; onToggle: () => void; over?: boolean; t: T }) {
  const working = kids.filter((k) => shown(k) === 'running').length;
  return (
    <button
      type="button"
      className={`kidcount${over ? ' over' : ''}`}
      data-hint-skip // ticket 389: hover-only, and its row opens the same
      data-kids={ids.join(' ')}
      aria-expanded={open}
      aria-label={t(open ? 'tree.subagents.collapse' : 'tree.subagents.expand', { name, n: kids.length, working })}
      title={t('tree.subagents.count', { n: kids.length, working })}
      onClick={(e) => (e.stopPropagation(), onToggle())}
    >
      ↳ {kids.length}
    </button>
  );
}

/**
 * The session's children, under its row while open: indented one step past the row, dimmed, each with its own state
 * word (the option A mockup's proportions: a smaller row, a thinner rail). Finished rows stay dimmed. `now` is the
 * read the ages come from, so "working 1m" moves only when the tree next reads the children.
 */
export function Kids({ id, kids, open, now, onOpen, t }: { id: string; kids: Nest[]; open: boolean; now: number; onOpen: (kid: Nest) => void; t: T }) {
  if (!kids.length) return null;
  // V2.5-30: a child session's own children follow its row, one step further in.
  const rows = (list: Nest[], depth: number): ReactNode[] =>
    list.flatMap((k) => {
      const s = shown(k);
      // A child nobody has dated or ended shows no word at all: nothing to say is not the same as running.
      const word = wordOf(k, now, t);
      // needs 169: the row is a button. A child session opens as the session it is (SESSION_OPEN); a transcript child opens
      // its own output beside the parent (KidPeek). Pointer and keyboard alike; the click stops here as KidCount's does.
      const go = () => (k.session ? openSession(k.id) : onOpen(k));
      const press = (e: KeyboardEvent) => {
        if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
        e.preventDefault();
        e.stopPropagation();
        go();
      };
      const name = t('tree.subagents.open', { name: k.label });
      return [
        <div
          key={k.id}
          className={`row kid${s === 'running' ? ' light-run' : s === 'failed' ? ' light-bad light-edge' : ''}`} // ticket 1041 (C)
          role="button"
          tabIndex={0}
          aria-label={name}
          title={name}
          data-kid={k.id}
          data-state={s}
          data-label={k.label}
          data-depth={depth}
          style={depth ? ({ '--depth': depth } as CSSProperties) : undefined}
          onClick={(e) => (e.stopPropagation(), go())}
          onKeyDown={press}
        >
          <span className="n">{k.label}</span>
          {word && (
            <span className="s" aria-hidden="true">
              {word}
            </span>
          )}
        </div>,
        ...rows(k.kids ?? [], depth + 1),
      ];
    });
  return (
    <div className="kids" data-session={id} data-open={open ? 'true' : 'false'}>
      {open && rows(kids, 0)}
    </div>
  );
}
