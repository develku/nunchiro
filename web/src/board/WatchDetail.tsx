// V2.5-69 (ticket 289, needs 208): a card's detail in place on the Board, beside the grid. What the card is, what was
// done, what came of it (receipt, pull request: V2.5-34h), how long, which agent, which worktree. "Open session" is the one
// way from here to the session tab. Esc or Close puts focus back on the card.
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import type { CoreClient } from '../api';
import { Icon } from '../icons/Icon';
import { composing } from '../keys';
import { sessionName } from '../Sidebar';
import { status, type Session } from '../types';
import type { T } from './Board';
import { startCard } from './CardEditor';
import { DoneFacts } from './DoneFacts';
import { keyOf, type Card } from './model';
import { base, unmark } from './tasks';
import { DETAIL_MIN, DETAIL_W, GRID_MIN, loadDetailWidth, morph, saveDetailWidth, type Bucket } from './watch';
import { agentOf, ago, bucketWord, usePrChip, useSummary } from './WatchGrid';

/** Two corner brackets pointing out (maximise) or in (restore): drawn here as strokes, there is no Octicon for them in the set. */
const Corners = ({ out }: { out: boolean }) => (
  <svg className="oi" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false">
    <path d={out ? 'M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4' : 'M6 2v4H2M14 6h-4V2M10 14v-4h4M2 10h4v4'} />
  </svg>
);

/** One step of the edge's arrow keys. */
const STEP = 24;

export function WatchDetail({ t, core, card, session, sessions, bucket, now, onClose, onOpenSession, onEdit }: { t: T; core: CoreClient; card: Card; session?: Session; sessions: Session[]; bucket: Bucket; now: number; onClose: () => void; onOpenSession: (id: string) => void; onEdit?: () => void }) {
  const panel = useRef<HTMLElement>(null);
  // Ticket 297 item 3: the width is dragged (or keyed) from the edge and kept in this window; maximise is for this open only.
  const [width, setWidth] = useState<number | null>(loadDetailWidth);
  const [max, setMax] = useState(false);
  const pr = usePrChip(core, card);
  // The agent is the card's own session, else the first attached one that still exists.
  // Look 1117 v5 (B-S2-1): a task card's own session_id is the session that made it, not its agent (agentOf).
  const own = card.source === 'manual' ? null : card.session_id;
  const agent = (card.source === 'manual' ? undefined : session) ?? sessions.find((s) => card.attachments?.some((a) => a.session_id === s.id) || s.id === own);
  const role = card.attachments?.find((a) => a.session_id === agent?.id)?.role;
  const sid = agent?.id ?? agentOf(card);
  const title = card.source === 'session' && session ? sessionName(session) : card.title;
  const receipt = card.receipt;
  // Ticket 289 item 3: what was done is the coordinator's note (the REPORT task line) when there is one, else the agent's last
  // message; a receipt's result follows either.
  const summary = useSummary(core, sid, `${card.updated_at}:${agent ? status(agent) : ''}`);
  const done = [unmark(card.note ?? '') || unmark(summary ?? ''), receipt && `${receipt.result}`].filter(Boolean).join(' · ');
  const since = now - (card.last_moved_at ?? card.updated_at);
  const created = card.history?.find((h) => h.kind === 'create')?.at;
  const cwd = agent?.cwd;
  const key = keyOf(card);
  // Closing is the opening played back: the panel is the old state, the card the new one.
  const close = useCallback(() => morph(panel.current, onClose, () => document.querySelector<HTMLElement>(`.wcard[data-card="${CSS.escape(key)}"]`)), [onClose, key]);
  /** The widest the panel may be: the grid beside it keeps its room. */
  const room = () => panel.current!.parentElement!.getBoundingClientRect().width - GRID_MIN - 1;
  const size = (w: number) => {
    const next = Math.round(Math.min(room(), Math.max(DETAIL_MIN, w)));
    setWidth(next);
    saveDetailWidth(next);
  };
  const reset = () => (setWidth(null), saveDetailWidth(null));
  const drag = (e: PointerEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    // From the press, not from the pointer's distance to the edge: a press a pixel off the middle does not make the panel jump.
    const w0 = panel.current!.getBoundingClientRect().width;
    const x0 = e.clientX;
    el.setPointerCapture(e.pointerId);
    el.onpointermove = (ev) => size(w0 + x0 - ev.clientX);
    el.onpointerup = () => ((el.onpointermove = null), (el.onpointerup = null));
  };
  const nudge = (e: KeyboardEvent<HTMLDivElement>) => {
    const dx = e.key === 'ArrowLeft' ? STEP : e.key === 'ArrowRight' ? -STEP : 0;
    if (dx) (e.preventDefault(), size(panel.current!.getBoundingClientRect().width + dx));
  };
  // The panel takes the first Esc in it, whatever inside has focus (a click leaves focus on the page in WebKit).
  useEffect(() => {
    const esc = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape' || composing(e) || e.defaultPrevented) return;
      if (document.querySelector('[role="menu"]')) return; // an open menu takes its own Esc
      e.preventDefault();
      close();
    };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [close]);
  const row = (name: string, body: React.ReactNode) => (
    <div className="wdr">
      <span className="wdk">{name}</span>
      <span className="wdv">{body}</span>
    </div>
  );
  const fit = t(max ? 'board.watch.restore' : 'board.watch.maximise');
  return (
    <>
      {!max && <div className="wdiv" role="separator" aria-orientation="vertical" aria-label={t('board.watch.resize')} aria-valuenow={width ?? DETAIL_W} aria-valuemin={DETAIL_MIN} tabIndex={0} title={t('board.watch.resizeTip')} onPointerDown={drag} onKeyDown={nudge} onDoubleClick={reset} />}
      <aside ref={panel} className="wdetail" role="complementary" aria-label={t('board.watch.detail')} data-detail={key} data-max={max ? '' : undefined} data-sized={width ? '' : undefined} style={width && !max ? { width } : undefined}>
        <header className="wdh">
          <h2 title={title}>{title}</h2>
          <button type="button" className="wdx" aria-label={fit} title={fit} onClick={() => setMax(!max)}>
            <Corners out={!max} />
          </button>
          <button type="button" className="wdx" aria-label={t('board.watch.close')} title={t('board.watch.close')} onClick={close}>
            <Icon name="x" />
          </button>
        </header>
        <div className="wdb">
          {row(t('board.watch.row.status'), <>{bucketWord(t, bucket)}{agent && ` · ${t(`mw.status.${status(agent)}`)}`}</>)}
          {row(t('board.watch.row.done'), done || <span className="dim">{t('board.watch.noSummary')}</span>)}
          {row(
            t('board.watch.row.outcome'),
            receipt || pr ? (
              <>
                {receipt && (
                  <span className="wor" title={receipt.sha}>
                    {receipt.sha !== '-' && <><span className="mono">{receipt.sha.slice(0, 7)}</span> · </>}
                    {receipt.command} · {receipt.result}
                  </span>
                )}
                {pr && <DoneFacts t={t} core={core} chip={pr.chip} number={pr.number} updatedAt={card.updated_at} />}
              </>
            ) : (
              <span className="dim">{t('board.watch.noOutcome')}</span>
            ),
          )}
          {row(t('board.watch.row.duration'), <>{t('board.watch.inBucket', { time: ago(t, since), bucket: bucketWord(t, bucket) })}{created ? ` · ${ago(t, now - created) === t('board.watch.ago.now') ? t('board.watch.createdNow') : t('board.watch.created', { time: ago(t, now - created) })}` : ''}</>)}
          {row(
            t('board.watch.row.agent'),
            agent ? (
              <>
                {sessionName(agent)} · {agent.kind}
                {role ? ` · ${role}` : ''}
              </>
            ) : (
              <span className="dim">{t('board.watch.noAgent')}</span>
            ),
          )}
          {row(
            t('board.watch.row.worktree'),
            cwd ? (
              <span title={cwd}>
                <span className="mono">{base(cwd)}</span>
                {agent && cwd !== agent.project ? ` · ${t('board.watch.isWorktree')}` : ''}
              </span>
            ) : (
              <span className="dim">{t('board.watch.noWorktree')}</span>
            ),
          )}
          {card.project && row(t('board.watch.row.project'), <span title={card.project}>{base(card.project)}</span>)}
        </div>
        <footer className="wdf">
          {sid && (
            <button type="button" className="bdbtn" onClick={() => onOpenSession(sid)}>
              {t('board.watch.openSession')}
            </button>
          )}
          {/* Ticket 991 B16: a task card not done starts its session from here too, not only from inside Edit card. */}
          {card.source === 'manual' && bucket !== 'done' && (
            <button type="button" className="bdbtn" title={t('board.start.hint')} onClick={() => startCard(card)}>
              {agent ? t('board.start.another') : t('board.start.button')}
            </button>
          )}
          {onEdit && (
            <button type="button" className="bdbtn" onClick={onEdit}>
              {t('board.watch.edit')}
            </button>
          )}
        </footer>
      </aside>
    </>
  );
}
