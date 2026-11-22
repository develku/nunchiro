// V2.5-37 (draft B): the task card's parts: ref link, role + assignee chips, stale badge, history with undo.
import { useState, type MouseEvent } from 'react';
import { openFileAt } from '../files/open';
import { Icon } from '../icons/Icon';
import { openExternal, webUrl } from '../sandbox/link';
import { columnTitle, type Attachment, type Card, type Column } from './model';
import type { T } from './Board';
import { shortId } from './tasks';

const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();

/**
 * A ticket path opens in a file tab of the card's session (its first live attached one, else the coordinator, which
 * wrote the card: needs 154); a URL opens in the user's browser.
 */
export function RefLink({ t, card, fallback }: { t: T; card: Card; fallback: string | null }) {
  const ref = card.ref!;
  const url = /^https?:\/\//i.test(ref) ? webUrl(ref) : null;
  const root = card.session_id ?? card.attachments?.find((a) => a.label !== null)?.session_id ?? fallback;
  const usable = url !== null || (!/^[a-z]+:/i.test(ref) && root !== null);
  const go = (e: MouseEvent) => {
    e.preventDefault();
    stop(e);
    if (url) void openExternal(url);
    else if (root) openFileAt(root, ref.replace(/^\.?\//, ''));
  };
  // Draft B shows the ref short ("tickets/183"): a URL's last two path parts, a long path cut from the left.
  const short = url ? new URL(url).pathname.split('/').filter(Boolean).slice(-2).join('/') || url : ref.length > 40 ? `…${ref.slice(-39)}` : ref;
  return (
    <a
      className="bref"
      href={url ?? '#'}
      title={usable || /^https?:/i.test(ref) ? ref : t('board.task.refNoSession', { ref })}
      aria-label={ref}
      aria-disabled={!usable || undefined}
      onPointerDown={stop}
      onKeyDown={(e) => stop(e)}
      onClick={usable ? go : (e) => (e.preventDefault(), stop(e))}
    >
      {short}
    </a>
  );
}

/** "waits on #id" chips; the target card's title is the tooltip. The columns card and (look v35 b S3-3) the watch card. */
export function WaitsOn({ t, ids, cards }: { t: T; ids: string[]; cards: Card[] }) {
  return ids.map((id) => (
    <span key={id} className="bwo" title={cards.find((c) => c.source === 'manual' && c.id === id)?.title}>
      {t('board.task.waitsOn', { id: shortId(id) })}
    </span>
  ));
}

/** working ●, your turn ◆, idle ○: a shape and a word per state, never colour alone. */
const DOT = { working: ['w', '●', 'board.task.working'], needs_decision: ['y', '◆', 'board.task.yourTurn'] } as const;
const IDLE = ['o', '○', 'board.task.idle'] as const;
const GONE = 'gone'; // a data token, not a word

export function Chips({ t, attachments, onOpen }: { t: T; attachments: Attachment[]; onOpen: (id: string) => void }) {
  return (
    <span className="bmt">
      {attachments.map((a) => {
        const [tone, shape, word] = a.label === null ? (['o', '○', 'board.task.gone'] as const) : a.state === 'working' || a.state === 'needs_decision' ? DOT[a.state] : IDLE;
        const inner = (
          <>
            <b>{a.role || '—'}</b>
            <span data-tone={tone}>
              {a.label ?? ''} {shape} {t(word)}
            </span>
          </>
        );
        // needs 171: a live chip opens its session; a gone one (label null) is plain text. Neither falls through to the card.
        return a.label === null ? (
          <span key={a.session_id} className="bra" data-state={a.state ?? GONE} title={`${a.role || '—'} · ${t(word)}`}>
            {inner}
          </span>
        ) : (
          <button key={a.session_id} type="button" className="bra" data-state={a.state ?? GONE} title={t('board.card.openSession', { label: `${a.role || '—'} · ${a.label}` })} onPointerDown={stop} onKeyDown={(e) => stop(e)} onClick={(e) => (stop(e), onOpen(a.session_id))}>
            {inner}
          </button>
        );
      })}
    </span>
  );
}

export function Stale({ t, minutes }: { t: T; minutes: number }) {
  const text = t('board.task.stale', { n: minutes });
  return (
    <span className="bstale" role="img" aria-label={text} title={t('board.task.staleHint')}>
      <Icon name="clock" size={11} />
      <span aria-hidden>{text}</span>
    </span>
  );
}

const MOVED = { undo: 'board.hist.undone', move: 'board.hist.moved' } as const;
const hm = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });

/** Newest first: who, when, from -> to; a refused write in red with its reason; "Undo last change" under it. */
export function History({ t, card, columns, off, onUndo }: { t: T; card: Card; columns: Column[]; off: boolean; onUndo: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const name = (id: string | null) => {
    const c = id === null ? undefined : columns.find((x) => x.id === id);
    return c ? columnTitle(t, c) : (id ?? '');
  };
  const who = (actor: string) => (actor === 'owner' ? t('board.hist.you') : actor);
  const rows = [...(card.history ?? [])].reverse();
  // The change undo would take back: the newest one that changed the card (draft B marks it).
  const last = card.can_undo ? rows.findIndex((h) => h.kind !== 'refused') : -1;
  const what = (h: (typeof rows)[number]) =>
    h.kind === 'create'
      ? t('board.hist.created', { to: name(h.to) })
      : h.kind === 'edit'
        ? t('board.hist.edited')
        : h.kind === 'refused'
          ? t('board.hist.refused', { from: name(h.from ?? card.column), to: name(h.to), reason: h.reason ?? '' })
          : t(h.kind === 'undo' ? MOVED.undo : MOVED.move, { from: name(h.from), to: name(h.to) });
  return (
    <div className="bhist" role="group" aria-label={t('board.hist.label')} onPointerDown={stop} onClick={stop} onKeyDown={(e) => stop(e)}>
      <ol>
        {rows.map((h, i) => (
          <li key={`${h.at}-${i}`} data-kind={h.kind} data-last={i === last || undefined}>
            <time dateTime={new Date(h.at).toISOString()}>{hm(h.at)}</time>
            <span>
              <b>{who(h.actor)}</b> {what(h)}
            </span>
          </li>
        ))}
      </ol>
      <button
        type="button"
        className="bundo"
        disabled={!card.can_undo || busy || off}
        title={off ? t('board.hist.unavailable') : card.can_undo ? t('board.hist.undoHint') : t('board.hist.nothing')}
        onClick={() => {
          setBusy(true);
          void onUndo().finally(() => setBusy(false));
        }}
      >
        <svg viewBox="0 0 24 24" aria-hidden><path d="M9 14L4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
        {t('board.hist.undo')}
      </button>
    </div>
  );
}
