// V2.5-38 (ticket 186, draft B second band): the one-line list density, as the right-bar board shows it. One row per
// card: dot, #id, title, its column; orange your turn and red broken as on the cards (word in the label, not colour alone).
import { Fragment, useMemo, useState, type KeyboardEvent } from 'react';
import type { Session } from '../types';
import { sessionName } from '../Sidebar';
import { Bdot } from './CardView';
import { columnTitle, keyOf, type Card, type Column } from './model';
import type { T } from './Board';
import { broken, shortId, taskDot, yourTurn, type Lane } from './tasks';

/** Dot tokens (data, not words): your turn, and the To do column that claims no state. */
const DOT = { you: 'you', todo: 'todo' } as const;

/** `onKey`: the grid's card keys (Alt+arrows move, as `Board` does for a card); lanes fold as the grid's do (Columns.tsx). */
export function ListView({ t, columns, lanes, sessions, onOpen, onKey }: { t: T; columns: Column[]; lanes: Lane[]; sessions: Session[]; onOpen: (card: Card) => void; onKey: (e: KeyboardEvent, card: Card, column: Column) => void }) {
  const order = new Map(columns.map((c, i) => [c.id, i]));
  // First match wins, as `find` did; one pass instead of a scan per card.
  const bySession = useMemo(() => sessions.reduce((m, s) => (m.has(s.id) ? m : m.set(s.id, s)), new Map<string, Session>()), [sessions]);
  const byColumn = useMemo(() => columns.reduce((m, c) => (m.has(c.id) ? m : m.set(c.id, c)), new Map<string, Column>()), [columns]);
  const [folded, setFolded] = useState<Set<string>>(new Set());
  const fold = (key: string) => setFolded((f) => (f.has(key) ? new Set([...f].filter((k) => k !== key)) : new Set([...f, key])));
  return (
    <ul className="blist" aria-label={t('board.list.label')}>
      {lanes.map((lane) => (
        <Fragment key={lane.key}>
          {lane.kind !== 'all' && (
            <li className="blsh">
              <button type="button" className="blfold" aria-expanded={!folded.has(lane.key)} onClick={() => fold(lane.key)}>
                <svg viewBox="0 0 10 10" aria-hidden><path d="M3.5 2l3 3-3 3" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>
                <span className="blname">{lane.name || t('board.lane.none')}</span>
              </button>
            </li>
          )}
          {!folded.has(lane.key) && [...lane.cards]
            .sort((a, b) => (order.get(a.column) ?? 0) - (order.get(b.column) ?? 0))
            .map((card) => {
              const session = card.session_id == null ? undefined : bySession.get(card.session_id);
              const column = byColumn.get(card.column);
              const title = card.source === 'session' && session ? sessionName(session) : card.title;
              const you = yourTurn(card, session);
              const bad = broken(card, session);
              const word = bad ? t('board.list.broken') : you ? t('board.task.yourTurn') : '';
              return (
                <li key={keyOf(card)}>
                  <button type="button" className="bli" data-card={keyOf(card)} data-menu="board" data-menu-arg={keyOf(card)} data-you={you || undefined} data-bad={bad || undefined} aria-label={t('board.card.aria', { title, word: [column && columnTitle(t, column), word].filter(Boolean).join(', ') })} onClick={() => onOpen(card)} onKeyDown={(e) => onKey(e, card, column ?? columns[0])}>
                    <Bdot s={card.source === 'manual' ? taskDot(card, session, column) : you ? DOT.you : (column?.states[0] ?? DOT.todo)} />
                    {card.source === 'manual' && <span className="bid">#{shortId(card.id)}</span>}
                    <span className="bltt">{title}</span>
                    <span className="blcol">{column && columnTitle(t, column)}</span>
                  </button>
                </li>
              );
            })}
        </Fragment>
      ))}
    </ul>
  );
}
