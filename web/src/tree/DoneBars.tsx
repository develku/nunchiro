// Ticket 1022 (mockup docs/design/tree-done-1121, 4b; replaces ticket 294's "N done" fold): finished main-folder sessions
// leave the tree. For 10 minutes one stays as a row whose rail is a hollow bar fading out; after that it is counted by
// hollow bars on its project head, left of the colour strip and by the strip's rule 3 (1 or 2 bars, then one bar and the
// number). The bars open a popover of the latest five, with "View all in History". No green, no check mark (owner).
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { useSummary } from '../board/WatchGrid';
import type { CoreClient } from '../api';
import { age } from '../tree';
import { openHistory } from '../history/history';
import { sessionName } from '../sessionNames';
import { status, type Session } from '../types';
import { RowIcon, type IconKind } from './RowIcon';
import { byEnd, endedAt, endText, finishedAt, JUST_MS } from './finished';
import type { T } from './state';
import './done.css';

/** A finished session's icon in the popover and History: the idle ring; a failed one keeps the fail icon. */
export const endIcon = (s: Session): IconKind => (status(s) === 'failed' ? 'fail' : 'rest');
const SHOWN = 5;

/** A head's hollow bars for its finished sessions today: a button that opens the popover (a group head's only shows). */
export function DoneBars({ n, open, onClick, t }: { n: number; open?: boolean; onClick?: (el: HTMLButtonElement) => void; t: T }) {
  const bars = n >= 3 ? <><i /><span className="num">{n}</span></> : Array.from({ length: n }, (_, i) => <i key={i} />);
  if (!onClick)
    return (
      <span className="dbar" data-done-bars={n} data-tip={t('history.tip', { n })} role="img" aria-label={t('history.tip', { n })}>
        {bars}
      </span>
    );
  return (
    <button type="button" className="dbar" data-done-bars={n} data-tip={t('history.tip', { n })} aria-expanded={open} aria-haspopup="dialog" aria-label={t('history.chip', { n })} onPointerDown={(e) => e.stopPropagation()} onClick={(e) => (e.stopPropagation(), onClick(e.currentTarget))}>
      {bars}
    </button>
  );
}

/** A session that finished less than 10 minutes ago: its rail a hollow bar that fades out over those minutes, its name dimmed. */
export function JustRow({ s, now, t, onOpen }: { s: Session; now: number; t: T; onOpen: () => void }) {
  const name = sessionName(s);
  const gone = Math.min(1, (now - (finishedAt(s) ?? now)) / JUST_MS);
  const said = t('history.just', { age: age(t, now - (finishedAt(s) ?? now)) });
  return (
    <button type="button" className="row wt2 just" data-just={s.id} data-menu="treerow" data-menu-session={s.id} data-menu-title={name} data-hint-kind="agent" data-hint-session={s.id} data-tip={said} aria-label={`${name}, ${said}`} style={{ '--fade': (0.85 - 0.6 * gone).toFixed(2) } as CSSProperties} onClick={onOpen}>
      <span className="n">
        <span className="nm wordcut">{name}</span>
      </span>
    </button>
  );
}

function Item({ core, s, now, t, onOpen }: { core: CoreClient; s: Session; now: number; t: T; onOpen: () => void }) {
  // The one line is the session's last answer as the core's chat gives it (board/watch.ts summaryOf), else its label.
  const said = useSummary(core, s.id, String(s.completion_seq ?? 0));
  const name = sessionName(s);
  const at = endedAt(s);
  return (
    <button type="button" className="dpop-it" data-done-item={s.id} data-menu="treerow" data-menu-session={s.id} data-menu-title={name} onClick={onOpen}>
      <span className="ic" data-kind={endIcon(s)}>
        <RowIcon kind={endIcon(s)} />
      </span>
      <span className="dpop-tx">
        <span className="dpop-l1">
          {/* Inventory N008 (ticket 1025's mockup): a session the user stopped says so, in History's word (HistoryView `end`). */}
          <b>{name}</b> <span className="tm">{[at === null ? '' : endText(at, now), s.state === 'closed' && status(s) !== 'failed' ? t('history.stopped') : ''].filter(Boolean).join(' · ')}</span>
        </span>
        <span className="dpop-sub">{said ?? s.label ?? name}</span>
      </span>
    </button>
  );
}

/** The mark's popover: the project's latest five finished sessions and "View all in History". */
export function DonePopover({ core, anchor, name, project, sessions, t, onOpen, onClose }: { core: CoreClient; anchor: HTMLElement; name: string; project: string; sessions: Session[]; t: T; onOpen: (id: string) => void; onClose: (back: boolean) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState({ left: 0, top: 0 });
  useLayoutEffect(() => {
    const r = anchor.getBoundingClientRect();
    const w = box.current?.offsetWidth ?? 0;
    setAt({ left: Math.max(8, Math.min(r.left - 120, window.innerWidth - w - 8)), top: r.bottom + 4 });
    box.current?.querySelector<HTMLElement>('button')?.focus();
  }, [anchor]);
  useEffect(() => {
    const away = (e: PointerEvent) => !box.current?.contains(e.target as Node) && !anchor.contains(e.target as Node) && onClose(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && (e.stopPropagation(), onClose(true));
    document.addEventListener('pointerdown', away, true);
    document.addEventListener('keydown', esc, true);
    return () => (document.removeEventListener('pointerdown', away, true), document.removeEventListener('keydown', esc, true));
  }, [anchor, onClose]);
  const now = Date.now();
  const list = [...sessions].sort(byEnd).slice(0, SHOWN);
  const head = t('history.popHead', { name, n: sessions.length });
  return createPortal(
    <div ref={box} className="dpop glass" role="dialog" aria-label={head} style={{ left: at.left, top: at.top }} data-done-pop>
      <div className="dpop-h">
        <span>{head}</span>
        <span>{t('history.today')}</span>
      </div>
      {list.map((s) => (
        <Item key={s.id} core={core} s={s} now={now} t={t} onOpen={() => (onClose(false), onOpen(s.id))} />
      ))}
      <button type="button" className="dpop-ft" onClick={() => (onClose(false), openHistory(project))}>
        {t('history.viewAll')} →
      </button>
    </div>,
    document.body,
  );
}
