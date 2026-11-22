// One card: session cards show the session's state in a word and a dot shape (never colour alone). V2.5-37 (draft B):
// a task card also shows its #id, ref link, role + assignee chips, "waits on", the stale badge, the receipt line and,
// expanded, its history with "Undo last change".
import { useEffect, useState, type KeyboardEvent, type PointerEvent } from 'react';
import type { CoreClient } from '../api';
import { pullUrl, type PrChipData } from '../chat/PrChip';
import { sessionName } from '../Sidebar';
import { RowIcon, type IconKind } from '../tree/RowIcon';
import { status, type Session } from '../types';
import { actionable, columnTitle, hostOf, keyOf, link, type Card, type Column } from './model';
import type { T } from './Board';
import { DoneFacts } from './DoneFacts';
import { Chips, History, RefLink, Stale, WaitsOn } from './CardParts';
import { base, broken, ownerMoved, receiptMissing, shortId, staleMinutes, taskDot, unmark, yourTurn } from './tasks';
import type { Field } from './views';

/** The task card's dot. Your turn and broken are the tree rows' hand and x-circle, not a colour alone (WCAG 1.4.1, ticket 293 round 3). */
const GLYPH: Record<string, IconKind> = { you: 'hand', needs_decision: 'hand', bad: 'fail' };
export function Bdot({ s }: { s: string }) {
  const g = GLYPH[s];
  return (
    <i className="bdot" data-s={s} data-g={g} aria-hidden>
      {g && <RowIcon kind={g} />}
    </i>
  );
}

const DOT = { working: 'working', needs_decision: 'waiting', review: 'idle', done: 'done' } as const;
const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();

export interface CardCtx {
  columns: Column[];
  /** Every card on the board, for "waits on" ids and titles. */
  cards: Card[];
  now: number;
  onUndo: (card: Card) => Promise<void>;
  /** The core refused or did not answer board_undo: Undo is disabled with its reason. */
  undoOff: boolean;
  /** Expanded cards by key, kept by the board so a card that moves cell stays open. */
  open: ReadonlySet<string>;
  onToggle: (card: Card) => void;
  /** Opens a session (the Done detail's "Open session"). */
  openSession: (id: string) => void;
  /** r7: the card's PR url as this card found it, for the card menu's "Open pull request". */
  setPr: (key: string, url: string | null) => void;
  /** The coordinator session: the folder a ref path opens in when no session is attached. */
  coordinator: string | null;
  /** V2.5-38: the card fields this widget's view shows, and board.toml's stale threshold in minutes. */
  fields: Record<Field, boolean>;
  threshold: number;
}

export function CardView({ t, core, card, session, column, projectLane = false, ctx, done = false, dragging, onClick, onKeyDown, onPointerDown }: { t: T; core: CoreClient; card: Card; session?: Session; column?: Column; /** The card sits in a project lane, which already names its project. */ projectLane?: boolean; ctx: CardCtx; /** The card sits in a column that takes the done state. */ done?: boolean; dragging: boolean; onClick: () => void; onKeyDown: (e: KeyboardEvent) => void; onPointerDown: (e: PointerEvent) => void }) {
  const [pr, setPr] = useState<PrChipData | null>(null);
  const open = ctx.open.has(keyOf(card));
  // A task card's PR comes from its first attached session (ticket 177's line), a session card's from itself.
  const prSession = card.source === 'session' ? card.session_id : card.source === 'manual' ? (card.attachments?.[0]?.session_id ?? null) : null;
  useEffect(() => {
    setPr(null);
    if (!prSession) return;
    let active = true;
    void core.request({ op: 'pr_chip', id: prSession }).then((reply) => {
      if (active) setPr((reply as { chip: PrChipData | null }).chip);
    }, () => {});
    return () => { active = false; };
  }, [core, prSession, card.updated_at]);
  const prUrl = pr && pullUrl(pr.url);
  const key = keyOf(card);
  const report = ctx.setPr;
  useEffect(() => report(key, prUrl || null), [report, key, prUrl]);
  const facts = done && pr && prUrl;
  // Look 1117 v4f (B-S2-1): a note an agent wrote in markdown reads as plain words, as the Board's other texts do.
  // Look 1117 v5 (B-S2-1): the core's words for the card (its note, else its task's outcome), not its title again.
  const own = unmark(card.note || card.text || '');
  const said = own === card.title ? '' : own;
  const note = said || (prUrl && ctx.fields.pr ? `${t('chat.pr.prefix')} #${prUrl.split('/').pop()}` : '');
  // V1A-58: a live session's card says what its header, tree and AGENTS row say (status()); the column holds the board's
  // own placement. Only a closed session falls back to the core's state word.
  const live = card.source === 'session' && session ? status(session) : null;
  const dot = live ?? (card.stale ? 'stale' : card.state && DOT[card.state]);
  const word = live ?? (card.state ? (card.stale ? t('board.word.stale') : t(`board.state.${card.state}`)) : card.source === 'integration' ? card.source_name : t('board.word.manual'));
  const title = card.source === 'session' && session ? sessionName(session) : card.title;
  const label = `${t('board.card.aria', { title, word: String(word) })}${card.project ? t('board.card.ariaProject', { project: base(card.project) }) : ''}${card.source === 'session' ? t('board.card.ariaOpens') : card.source === 'manual' ? t('board.card.ariaEdit') : ''}`;
  const task = card.source === 'manual';
  const stale = staleMinutes(card, column, ctx.now, ctx.threshold);
  const f = ctx.fields;
  const waits = f.waits ? (card.waits_on ?? []) : [];
  const missing = receiptMissing(card, ctx.columns);
  const body = (
    <>
      <span className="bt">
        {/* V2.5-82: a session waiting on you draws the your-turn hand the task card and the tree row draw, not a plain dot. */}
        {card.state && (dot === 'waiting' ? <Bdot s="you" /> : <i className="st" data-s={dot} aria-hidden />)}
        {task && <Bdot s={taskDot(card, session, column)} />}
        {task && <span className="bid" title={card.id}>#{shortId(card.id)} </span>}
        {/* Draft B: a task card leaves the project to its lane unless the view shows the "project" field (ticket 186). */}
        {card.project && (task ? ctx.fields.project : !(projectLane && card.source === 'session')) && <span className="btag" title={card.project}>{base(card.project)}</span>}
        <span className="btt">{title}</span>
        {card.source === 'session' && session && <span className="bid"> {session.kind}</span>}
      </span>
      {note && (said || !facts) && <span className="bnote" title={note}>{note}</span>}
      {card.source === 'session' ? (
        // Draft B: a session card says it is automatic, with its state as a chip (shape and word, never colour alone).
        <span className="bmt bmeta">
          <span className="bauto">{t('board.task.auto')}</span>
          <span className="bra">
            <b>—</b>
            <span data-tone={live === 'working' ? 'w' : live === 'waiting' ? 'y' : 'o'}>
              {live === 'working' ? '●' : live === 'waiting' ? '◆' : '○'} {word}
              {card.session_id && !session && t('board.card.sessionClosed')}
              {session?.folder_gone && t('board.card.folderGone')}
            </span>
          </span>
        </span>
      ) : (
        (!note || (card.session_id && !session)) && !task && <span className="bmeta dim">
          {word}
          {card.session_id && !session && t('board.card.sessionClosed')}
        </span>
      )}
    </>
  );
  const extras = (
    <>
      {((f.ref && card.ref) || waits.length > 0 || stale !== null) && (
        <span className="bmt">
          {f.ref && card.ref && <RefLink t={t} card={card} fallback={ctx.coordinator} />}
          <WaitsOn t={t} ids={waits} cards={ctx.cards} />
          {stale !== null && <Stale t={t} minutes={stale} />}
        </span>
      )}
      {f.role && !!card.attachments?.length && <Chips t={t} attachments={card.attachments} onOpen={ctx.openSession} />}
      {facts && f.pr && <DoneFacts t={t} core={core} chip={{ ...pr, url: prUrl }} number={prUrl.split('/').pop()!} updatedAt={card.updated_at} onOpenSession={prSession ? () => ctx.openSession(prSession) : undefined} />}
      {f.receipt && card.receipt && (
        <span className="brc" title={card.receipt.sha}>
          {card.receipt.sha !== '-' && `${card.receipt.sha.slice(0, 7)} · `}
          {card.receipt.command} · <b data-pass={broken(card) ? 'false' : 'true'}>{card.receipt.result}</b>
        </span>
      )}
      {f.receipt && !card.receipt && ownerMoved(card, column) && <span className="brc">{t('board.task.ownerMoved')}</span>}
      {missing && <span className="bmiss">{t('board.task.missing', { column: column ? columnTitle(t, column) : '', to: columnTitle(t, missing) })}</span>}
      {task && (
        <button type="button" className="bexp" aria-expanded={open} aria-label={t('board.hist.toggle', { title })} title={t('board.hist.toggle', { title })} onPointerDown={stop} onKeyDown={(e) => stop(e)} onClick={(e) => (stop(e), ctx.onToggle(card))}>
          <svg viewBox="0 0 10 10" aria-hidden><path d="M3.5 2l3 3-3 3" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>
        </button>
      )}
      {task && open && <History t={t} card={card} columns={ctx.columns} off={ctx.undoOff} onUndo={() => ctx.onUndo(card)} />}
    </>
  );
  const props = {
    className: 'bcard',
    'data-menu': 'board', // V2-6a
    'data-menu-session': session?.id,
    'data-card': key,
    'data-menu-arg': key, // r7: the card menu's commands get the card key (board/cardMenu.ts)
    'data-source': card.source,
    'data-state': live ?? card.state,
    'data-you': yourTurn(card, session) || undefined,
    'data-bad': broken(card, session) || undefined,
    'data-open': open || undefined,
    'data-dragging': dragging || undefined,
    // needs 172: a card with nothing to do on click is no button (no tab stop, no pointer).
    'data-inert': !actionable(card) || undefined,
    onClick,
    onKeyDown,
    onPointerDown,
  };
  // V2.5-34h: a card with buttons or links inside (PR facts, a task card's ref, chips and history) cannot be one
  // role=button (the accessibility tree drops the inner controls). So the card is a plain container; the title, note
  // and state are the one button (the tab stop), the rest are its siblings, and a click anywhere still opens the card.
  if (facts || task) {
    // tabIndex -1: the menu hands focus back to the card (its data-menu row) when it closes.
    return (
      <div {...props} tabIndex={-1}>
        <div className="bmain" role="button" tabIndex={0} aria-label={label}>{body}</div>
        {extras}
      </div>
    );
  }
  if (!actionable(card)) {
    return (
      <div {...props} aria-label={label}>
        {body}
        {extras}
      </div>
    );
  }
  const host = link(card) && hostOf(link(card)!);
  return (
    <div {...props} role="button" tabIndex={0} aria-label={host ? `${label}${t('board.card.ariaLink', { host })}` : label} title={host ? t('board.card.opensLink', { host }) : undefined}>
      {body}
      {extras}
    </div>
  );
}

