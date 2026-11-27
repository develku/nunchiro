// The knock (mockup docs/design/draft-hold/index.html, panels 1-3): a message from another sender (a lead, another agent,
// the core) waits for a gap in this session (crates/nunchiro-core: the gap rule). Its sender's face sits at the right end of
// the session's tree row; hover shows the message and why it waits, a click offers Send now, Attach to my next prompt and
// Later. No sound and no notification, and the row's state colour is the session's, never the knock's.
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import type { CoreClient } from '../api';
import type { T } from '../i18n';
import type { Session, SendRow } from '../types';
import { sessionName } from '../Sidebar';
import { Face } from '../bots/Face';
import type { BotFace } from '../bots/bots';
import type { Team } from '../lead/lead';
import { notePlain } from '../errors';
import './knock.css';
import { noteWrite } from '../chat/nunchiroWrites';
import { getDraft } from '../composer-drafts';

/** Another sender's queued row of `s`, with why it waits (`send_waits`). */
export type Knock = SendRow & { wait?: string };
export const knocksOf = (s: Session): Knock[] =>
  (s.send_queue ?? []).filter((r) => r.status === 'queued' && r.sender !== 'user').map((r) => ({ ...r, wait: s.send_waits?.[r.id] }));

// The chat names the sender of a delivered message, so it needs the sessions the tree has (the tree hands them here).
let known: Session[] = [];
const subs = new Set<() => void>();
export const setKnown = (list: Session[]) => {
  if (list === known) return;
  known = list;
  subs.forEach((f) => f());
};
const useKnown = () => useSyncExternalStore((f) => (subs.add(f), () => void subs.delete(f)), () => known);

type Who = { name: string; face?: BotFace; glyph?: string };
/** How a sender shows: a bot's face, the core's app glyph, a schedule's clock, else the first letter of its name. */
export function whoSent(sender: string, sessions: Session[], team: Team | null): Who {
  if (sender === 'core') return { name: 'Nunchiro', glyph: 'N' };
  if (sender.startsWith('schedule')) return { name: 'Schedule', glyph: '◷' };
  if (sender.startsWith('widget:')) return { name: sender.slice(7) };
  const s = sessions.find((x) => x.id === sender || x.resumed_from?.includes(sender));
  if (!s) return { name: 'Another session' };
  const bot = s.teammate ? team?.bots?.find((b) => b.id === s.teammate) : undefined;
  const mate = s.teammate ? team?.teammates.find((m) => m.id === s.teammate) : undefined;
  return { name: bot?.name ?? mate?.name ?? sessionName(s), face: bot?.face };
}

export function SenderFace({ who, t, size = 16 }: { who: Who; t: T; size?: number }) {
  if (who.face) return <Face t={t} face={who.face} name={who.name} eyes="rest" size={size} />;
  return (
    <span className="kglyph" style={{ '--s': `${size}px` } as React.CSSProperties} aria-hidden="true">
      {who.glyph ?? (who.name.trim()[0] ?? '?').toUpperCase()}
    </span>
  );
}

const PREVIEW = 300;
const WHY = ['typing', 'turn', 'direct', 'terminal_text', 'later', 'attached'];
const whyOf = (t: T, wait?: string) => t(`knock.why.${wait && WHY.includes(wait) ? wait : 'turn'}` as 'knock.why.turn');
const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

// `knock.open` opens the first knock of the session in front (the palette and its key).
const openers = new Set<(id: string) => void>();
export const openKnock = (id: string) => openers.forEach((f) => f(id));

type Open = { row: Knock; anchor: HTMLElement; acts: boolean };

/** The faces at a tree row's end: three at most, then "+n". A sibling of the row (a row is a button). */
export function Knocks({ session, sessions, team, core, t }: { session: Session; sessions: Session[]; team: Team | null; core: CoreClient; t: T }) {
  const rows = knocksOf(session);
  const [open, setOpen] = useState<Open | null>(null);
  const box = useRef<HTMLSpanElement>(null);
  const leave = useRef(0);
  useEffect(() => {
    const f = (id: string) => {
      const first = box.current?.querySelector<HTMLElement>('.knock');
      if (id === session.id && first && rows[0]) setOpen({ row: rows[0], anchor: first, acts: true });
    };
    openers.add(f);
    return () => void openers.delete(f);
  });
  // The row went (sent, canceled): its popover goes with it.
  const live = open && rows.find((r) => r.id === open.row.id);
  if (!rows.length) return null;
  const shown = rows.slice(0, 3);
  return (
    <span className="knocks" ref={box} onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
      {shown.map((r) => {
        const who = whoSent(r.sender, sessions, team);
        return (
          <button
            key={r.id}
            type="button"
            className="knock"
            data-later={r.wait === 'later' || undefined}
            aria-label={t(r.wait === 'later' ? 'knock.later' : 'knock.label', { name: who.name })}
            aria-haspopup="dialog"
            aria-expanded={open?.row.id === r.id && open.acts}
            onPointerEnter={(e) => (window.clearTimeout(leave.current), !open?.acts && setOpen({ row: r, anchor: e.currentTarget, acts: false }))}
            onPointerLeave={() => (leave.current = window.setTimeout(() => setOpen((o) => (o?.acts ? o : null)), 150))}
            onClick={(e) => setOpen({ row: r, anchor: e.currentTarget, acts: true })}
          >
            <SenderFace who={who} t={t} />
          </button>
        );
      })}
      {rows.length > 3 && (
        <b className="kmore" aria-label={t('knock.more', { n: rows.length - 3 })}>
          +{rows.length - 3}
        </b>
      )}
      {open && live && <KnockPopover row={live} who={whoSent(live.sender, sessions, team)} anchor={open.anchor} acts={open.acts} session={session.id} core={core} t={t} onClose={(back) => (setOpen(null), back && open.anchor.focus())} />}
    </span>
  );
}

function KnockPopover({ row, who, anchor, acts, session, core, t, onClose }: { row: Knock; who: Who; anchor: HTMLElement; acts: boolean; session: string; core: CoreClient; t: T; onClose: (back: boolean) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState({ left: 0, top: 0 });
  const [error, setError] = useState('');
  useLayoutEffect(() => {
    const r = anchor.getBoundingClientRect();
    const w = box.current?.offsetWidth ?? 0;
    setAt({ left: Math.max(8, Math.min(r.left - 12, window.innerWidth - w - 8)), top: r.bottom + 6 });
    if (acts) box.current?.querySelector<HTMLElement>('button')?.focus();
  }, [anchor, acts]);
  useEffect(() => {
    if (!acts) return;
    const away = (e: PointerEvent) => !box.current?.contains(e.target as Node) && !anchor.contains(e.target as Node) && onClose(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && (e.stopPropagation(), onClose(true));
    document.addEventListener('pointerdown', away, true);
    document.addEventListener('keydown', esc, true);
    return () => (document.removeEventListener('pointerdown', away, true), document.removeEventListener('keydown', esc, true));
  }, [anchor, acts, onClose]);
  const choose = (op: 'send_now' | 'send_attach' | 'send_later') =>
    core.request({ op, id: session, send: row.id }).then(
      () => {
        // ⌘Z in the composer while its text is as it is now detaches it again (nunchiroWrites.ts).
        if (op === 'send_attach') {
          const box = document.querySelector<HTMLTextAreaElement>(`.composer textarea[data-draft-for="${CSS.escape(session)}"]`);
          const text = box ? box.value : getDraft(session);
          noteWrite(session, { before: text, after: text, line: t('knock.putBack', { name: who.name }), undo: () => core.request({ op: 'send_detach', id: session, send: row.id }) });
        }
        onClose(true);
      },
      (e) => setError(t('knock.failed', { error: notePlain(t, e) })),
    );
  const text = row.content.length > PREVIEW ? `${row.content.slice(0, PREVIEW)}…` : row.content;
  return createPortal(
    <div ref={box} className="kpop glass" role={acts ? 'dialog' : 'tooltip'} aria-label={t('knock.from', { name: who.name })} style={{ left: at.left, top: at.top }} data-knock-pop={row.id}>
      <div className="kpop-h">
        <SenderFace who={who} t={t} size={24} />
        <span className="kpop-n">{who.name}</span>
        <small>{clock(row.at)}</small>
      </div>
      <div className="kpop-b">{text}</div>
      {!acts && (
        <div className="kpop-why">
          <span className="kdot" aria-hidden="true" />
          {whyOf(t, row.wait)}
        </div>
      )}
      {acts && (
        <div className="kpop-acts">
          <button type="button" onClick={() => void choose('send_now')}>
            <b>{t('knock.now')}</b>
            <small>⏎</small>
          </button>
          {row.wait !== 'attached' && (
            <button type="button" onClick={() => void choose('send_attach')}>
              {t('knock.attach')}
            </button>
          )}
          {row.wait !== 'later' && (
            <button type="button" onClick={() => void choose('send_later')}>
              {t('knock.laterBtn')}
            </button>
          )}
        </div>
      )}
      {error && (
        <p className="kpop-err" role="alert">
          {error}
        </p>
      )}
    </div>,
    document.body,
  );
}

/** The composer's chips: each message attached to the owner's next prompt, with × to detach it (it then waits as Later). */
export function AttachedChips({ session, team, core, t }: { session: Session; team: Team | null; core: CoreClient; t: T }) {
  const sessions = useKnown();
  const rows = knocksOf(session).filter((r) => r.wait === 'attached');
  if (!rows.length) return null;
  return (
    <div className="kchips">
      {rows.map((r) => {
        const who = whoSent(r.sender, sessions, team);
        return (
          <span key={r.id} className="kchip" data-attached={r.id}>
            <SenderFace who={who} t={t} />
            {t('knock.chip', { name: who.name })}
            <button type="button" className="kchip-x" aria-label={t('knock.detach', { name: who.name })} onClick={() => void core.request({ op: 'send_detach', id: session.id, send: r.id }).catch(() => {})}>
              ×
            </button>
          </span>
        );
      })}
    </div>
  );
}

/** A delivered message of another sender in the chat: its sender, read from the session's send log by the words. */
export function useSentBy(session: Session | null, text: string, team: Team | null): Who | null {
  const sessions = useKnown();
  if (!session) return null;
  const log = (session as Session & { send_log?: SendRow[] }).send_log ?? [];
  const words = text.trim();
  if (!words) return null;
  const row = log.find((r) => r.sender !== 'user' && r.status === 'delivered' && r.content.trim() === words);
  return row ? whoSent(row.sender, sessions, team) : null;
}

/** The plugin whose check changed the delivered message `text` (its send row keeps the plugin and the original). */
export function useChangedBy(session: Session | null, text: string): string | null {
  if (!session) return null;
  const log = (session as Session & { send_log?: SendRow[] }).send_log ?? [];
  const words = text.trim();
  return (words && log.find((r) => r.replaced && r.content.trim() === words)?.replaced?.plugin) || null;
}

// The composer's `typing`: at most once every 2 s per session; the core holds other senders' lines 5 s after the last.
const pinged = new Map<string, number>();
export function typingPing(core: CoreClient, s: Session | null) {
  if (!s || s.kind === 'shell' || s.kind === 'acp') return;
  const now = Date.now();
  if (now - (pinged.get(s.id) ?? 0) < 2000) return;
  pinged.set(s.id, now);
  void core.request({ op: 'typing', id: s.id }).catch(() => {});
}
