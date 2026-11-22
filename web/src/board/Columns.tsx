// The board grid (V2.5-37, draft B): one header row of columns (title, needs-decision mark, count, proof badge), then a
// swimlane per lane key with its progress bar and "n/m done", each lane a row of cells under the columns.
import { Fragment, useState, type ReactNode } from 'react';
import { columnTitle, keyOf, type Card, type Column } from './model';
import type { T } from './Board';
import { isDone, type Lane } from './tasks';
import { cardCount } from './WatchGrid';
import './columns.css';

export function LaneGrid({ t, columns, lanes, counts, cell, onAdd }: { t: T; columns: Column[]; lanes: Lane[]; counts: Map<string, number>; cell: (card: Card, column: Column, lane: Lane | null) => ReactNode; onAdd: (column: string) => void }) {
  const [folded, setFolded] = useState<Set<string>>(new Set());
  const fold = (key: string) => setFolded((f) => (f.has(key) ? new Set([...f].filter((k) => k !== key)) : new Set([...f, key])));
  const done = new Set(columns.filter(isDone).map((c) => c.id));
  // An empty board still shows one row of cells: the "+ Add" buttons and the drop targets live there.
  const rows: (Lane | null)[] = lanes.length ? lanes : [null];
  // 140 px: the five default columns fit the 812 px centre zone beside the Tree at 1440x900 (5 x 140 + 4 x 8 gap + 24
  // padding = 756); a narrower zone scrolls sideways.
  return (
    <div className="bcols" style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(140px, 1fr))` }}>
      {columns.map((col) => (
        <section key={col.id} className="bcol" data-head={col.id} data-column={col.id} data-state={col.states[0]} aria-label={columnTitle(t, col)}>
          <header className="bch">
            <b title={columnTitle(t, col)}>{columnTitle(t, col)}</b>
            {col.needs_decision && (
              <span className="bnd" data-zero={!counts.get(col.id)} title={t('board.col.needsYouHint')}>
                {t('board.col.needsYou')}
              </span>
            )}
            <span className="bcount dim" aria-label={cardCount(t, counts.get(col.id) ?? 0)}>
              {counts.get(col.id) ?? 0}
            </span>
            {col.proof && (
              <span className="bproof" title={t('board.col.proofHint')}>
                {t('board.col.proof')}
              </span>
            )}
          </header>
        </section>
      ))}
      {rows.map((lane, li) => {
        const total = lane?.cards.length ?? 0;
        const n = lane?.cards.filter((c) => done.has(c.column)).length ?? 0;
        const open = !lane || !folded.has(lane.key);
        return (
          <Fragment key={lane?.key ?? ''}>
            {lane && lane.kind !== 'all' && (
              <div className="blh" data-lane={lane.key} data-kind={lane.kind}>
                {/* Draft B: name and key in a fixed first column, so the bars of all lanes line up. */}
                <span className="blt">
                  <button type="button" className="blfold" aria-expanded={open} onClick={() => fold(lane.key)}>
                    <svg viewBox="0 0 10 10" aria-hidden><path d="M3.5 2l3 3-3 3" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>
                    <span className="blname" title={lane.name || t('board.lane.none')}>{lane.name || t('board.lane.none')}</span>
                  </button>
                  {lane.kind !== 'none' && <span className="blk">{t(`board.lane.kind.${lane.kind}`)}</span>}
                </span>
                <span className="bpbar" role="progressbar" aria-label={t('board.lane.progress', { lane: lane.name || t('board.lane.none') })} aria-valuemin={0} aria-valuemax={total} aria-valuenow={n}>
                  <i style={{ width: `${total ? Math.round((n / total) * 100) : 0}%` }} />
                </span>
                <span className="bpt">{t('board.lane.done', { n, m: total })}</span>
              </div>
            )}
            {open &&
              columns.map((col) => (
                <div key={col.id} className="bcell" data-column={col.id} data-lane={lane?.key ?? ''}>
                  <ul className="bcards">
                    {lane?.cards.filter((c) => c.column === col.id).map((card) => <li key={keyOf(card)}>{cell(card, col, lane)}</li>)}
                  </ul>
                  {li === 0 && <button className="badd" onClick={() => onAdd(col.id)}>{t('board.col.add')}</button>}
                </div>
              ))}
          </Fragment>
        );
      })}
    </div>
  );
}
