// Answer strip content (spec Window (v1a) Waiting placement, needs 77): nothing while nothing waits; then one card
// line, the focused item else the oldest, and "+N" for the rest. Arrivals never take focus. While the pointer or
// focus is on the strip its line is frozen: new items wait as "new N" and an answered card keeps its line, so nothing
// under the pointer moves.
// With the strip off (or signal only) a tree row opens one card here, for that click only. As in R8, a card
// shows "Open" until it has focus; its answer buttons and keys work only while it has focus, so a stray
// click on a line that just arrived can never answer it.
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { CoreClient } from '../api';
import type { Strip as Mode } from '../settings';
import { CHECK_MS, checking, kindKey, withResumed, type Decision, type Session } from '../types';
import { answerOnce, plan, summary, withNote, type Act } from './answer';
import { boardWho, resolveBoard } from './board'; // v1b-18
import { BOARD_LEVEL, NotifyLevel, type Level } from './notify'; // v1b-18
import { tEn } from '../i18n';
import { useHtmlLangT } from '../i18n/lib/useHtmlLangT';
import { sessionName } from '../Sidebar';
import { openExternal } from '../sandbox/link'; // v1b-18
import { PermissionSheet } from '../approval/PermissionSheet'; // v1a-23
import './queue.css';
import { lineError, rawError } from '../errors';
import { words } from '../layout/store';

const base = (p: string) => p.replace(/\/+$/, '').split('/').pop() || p;
/** Ticket 473: two unlabeled sessions of one agent in one project read apart. Ticket 491: by the one rule the tab, tree,
 * palette and card use (sessionNames.ts: a number by place among the project's open same-name sessions), not a number among
 * the askers only, so the strip's "New Claude session 2" is the tab's too. */
const name = (s: Session | undefined, d: Decision) => {
  if (d.board) return boardWho(d.board); // v1b-18: board
  return s ? sessionName(s) : words()('decisions.someSession');
};

// `queue.focus` can fire while the settings tab hides the strip; the strip picks it up when it mounts.
let request: { id: string; at: number } | null = null;
const listeners = new Set<(id: string) => void>();
window.addEventListener('nunchiro:queue.focus', (e) => {
  const id = (e as CustomEvent<{ id: string }>).detail.id;
  request = { id, at: Date.now() };
  listeners.forEach((f) => f(id));
});

interface Props {
  mode: Mode;
  sessions: Session[];
  core: CoreClient;
  hint: string;
  /** Opens the item's session tab and focuses its card (the tree row's action). */
  onOpen: (d: Decision) => void;
  /** v1b-18: board decision items (kind `board`), queued with the session items. */
  board?: Decision[];
  /** v1b-18: the board decisions' notification level and its setter. */
  boardLevel?: { level: Level; set: (l: Level) => void };
  /** v1a-23: what sessions asked the owner to do (kind `owner`), queued with the session items. */
  owner?: Decision[];
}

/** The strip's order, which waiting.next walks too: oldest first, with stale flags after the items that need an
 * answer, so a flag never pushes one into "+N". */
export const waitingOrder = (sessions: Session[], board: Decision[], owner: Decision[]) =>
  [...sessions.flatMap((s) => s.pending), ...board, ...owner] // v1b-18: board; v1a-23: owner
    .sort((a, b) => Number(a.kind === 'stale') - Number(b.kind === 'stale') || a.observed_at - b.observed_at);

export function Strip({ mode, sessions, core, hint, onOpen, board = [], boardLevel, owner = [] }: Props) {
  const t = useHtmlLangT();
  const rawId = useId();
  const byId = useMemo(() => withResumed(new Map(sessions.map((s) => [s.id, s])), sessions), [sessions]); // a resumed asker's item keeps its old id
  const live = useMemo(() => waitingOrder(sessions, board, owner), [sessions, board, owner]);
  const liveById = useMemo(() => new Map(live.map((d) => [d.id, d])), [live]);
  const last = useRef(new Map<string, Decision>());
  live.forEach((d) => last.current.set(d.id, d));

  const [want, setWant] = useState<{ id: string; n: number; at: number; follow?: boolean } | null>(null);
  const [held, setHeld] = useState<{ shown: string[]; known: Set<string> } | null>(null);
  const [result, setResult] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  // v1a-23: the widget an owner item asks to approve, open in the permission sheet.
  const [sheet, setSheet] = useState<{ name: string; subject: 'widget' | 'source' | 'setup' } | null>(null);
  // V2-1b: when this window first saw each restored item; past CHECK_MS without fresh proof it offers its terminal.
  const restored = useRef(new Map<string, number>());
  const [, setLate] = useState(0);
  const now = Date.now();
  live.filter(checking).forEach((d) => restored.current.has(d.id) || restored.current.set(d.id, now));
  const firstDue = Math.min(...live.filter(checking).map((d) => (restored.current.get(d.id) ?? now) + CHECK_MS).filter((t) => t > now));
  useEffect(() => {
    if (!Number.isFinite(firstDue)) return;
    const t = setTimeout(() => setLate((n) => n + 1), firstDue - Date.now());
    return () => clearTimeout(t);
  }, [firstDue]);
  const pointer = useRef(false);
  const before = useRef<HTMLElement | null>(null);
  const root = useRef<HTMLDivElement>(null);

  let ids: string[] = [];
  const target = want && liveById.has(want.id) ? want.id : null;
  if (target) ids = [target];
  else if (mode === 'on') ids = live.slice(0, 1).map((d) => d.id);
  const shown = held?.shown ?? ids;
  const fresh = held ? live.filter((d) => !held.known.has(d.id)).length : 0;
  const more = mode === 'on' ? live.length - shown.filter((id) => liveById.has(id)).length - fresh : 0;

  // When the wanted card's item vanishes, note when: a redraw of the same prompt may re-file it (see below).
  // shortcut: read during render and timed by the next render (snapshots arrive every 100 ms while items
  // change); move to an effect with a timer if renders ever stop arriving during the 3 s.
  const gone = useRef<{ id: string; at: number } | null>(null);
  if (want && !liveById.has(want.id) && gone.current?.id !== want.id) gone.current = { id: want.id, at: Date.now() };
  const following = !!want && !liveById.has(want.id) && Date.now() - (gone.current?.at ?? 0) < 3000;
  const hold = () => {
    if (!held) setHeld({ shown: ids, known: new Set(live.map((d) => d.id)) });
  };
  const release = () => {
    // Focus is read from the DOM: a focused button removed with its line leaves focus on the body without
    // a blur event in Chromium, so a flag would keep the strip frozen.
    const active = document.activeElement;
    if (pointer.current || (active && active !== document.body && root.current?.contains(active))) return;
    setHeld(null);
    setResult({});
    // Strip off: the card was for that click only; strip on: the line goes back to the oldest item (V1A-60b). Not while
    // its prompt is being redrawn (see below).
    if (!following) setWant(null);
  };

  // A line removed from under the pointer can cost the strip its pointerleave (Chromium): while frozen, any
  // pointer move outside it counts as leaving.
  const releaseRef = useRef(release);
  releaseRef.current = release;
  useEffect(() => {
    if (!held) return;
    const move = (e: PointerEvent) => {
      if (pointer.current && !root.current?.contains(e.target as Node)) {
        pointer.current = false;
        releaseRef.current();
      }
    };
    document.addEventListener('pointermove', move);
    return () => document.removeEventListener('pointermove', move);
  }, [held]);
  useEffect(() => {
    const ask = (id: string) => {
      if (document.activeElement instanceof HTMLElement && !root.current?.contains(document.activeElement)) before.current = document.activeElement;
      setHeld(null);
      setWant((w) => ({ id, n: (w?.n ?? 0) + 1, at: Date.now() }));
    };
    listeners.add(ask);
    if (request && Date.now() - request.at < 2000) ask(request.id);
    request = null;
    return () => void listeners.delete(ask);
  }, []);
  // A card opens only on the user's click or key; focus it once it is drawn. A followed redraw keeps focus
  // only where it still is: if the user went back to typing, it stays there.
  useEffect(() => {
    if (!want) return;
    const active = document.activeElement;
    if (want.follow && active && active !== document.body && !root.current?.contains(active)) return;
    root.current?.querySelector<HTMLElement>(`.qcard[data-item="${CSS.escape(want.id)}"]`)?.focus();
  }, [want]);
  // Opening a tab for the first time fits its terminal; the PTY resize makes the agent redraw, and the core
  // may file the redrawn prompt under a new id. Follow the focused card to it: same session, kind and text,
  // within 3 s. A different prompt never inherits focus.
  useEffect(() => {
    if (!want || !following) return;
    const old = last.current.get(want.id);
    const next = old && live.find((d) => d.id !== old.id && d.session_id === old.session_id && d.kind === old.kind && summary(d) === summary(old));
    if (!next) return;
    setHeld((h) => h && { shown: h.shown.map((x) => (x === old.id ? next.id : x)), known: new Set([...h.known, next.id]) });
    setWant({ ...want, id: next.id, follow: true });
    // No dependency list on purpose: it must see every snapshot during the 3 s.
  });

  /** Leaves a card: strip off closes it (it goes with the strip's place, so no pointer or focus is left on
   * it to release); focus goes back to where the user was, and with the strip on the line returns to the oldest. */
  const leave = () => {
    if (mode !== 'on') {
      pointer.current = false;
      setHeld(null);
      setWant(null);
    }
    const back = before.current;
    before.current = null;
    if (back) back.focus();
    else if (root.current?.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
    // Focus may have dropped to the body with no blur event (its line was replaced first): release here too.
    release();
  };
  // Ticket 199: "+N" opens the next waiting item after the shown one (wrapping), as a tree row's click opens its card.
  const next = () => {
    const rest = live.filter((d) => !held || held.known.has(d.id));
    const d = rest[(rest.findIndex((x) => x.id === shown[0]) + 1) % rest.length];
    if (!d || d.id === shown[0]) return;
    setHeld(null);
    setWant((w) => ({ id: d.id, n: (w?.n ?? 0) + 1, at: Date.now() }));
  };
  const send = (d: Decision, a: Act) => {
    if (busy) return;
    // V2-8e: one answer per item across the strip, the tree rows, the peek and the card.
    const once = answerOnce(d.id, () => (d.board ? resolveBoard(core, d.board) : core.request({ op: 'answer', item: d.id, answer: withNote(d.id, a.answer), confirmed: false }))); // v1b-18
    if (!once) return;
    setBusy(d.id);
    once
      .then(() => {
        setResult((r) => ({ ...r, [d.id]: 'answered' }));
        // The ack can land after the user moved on to another card: only the answered card closes or
        // gives focus back.
        setWant((w) => (w?.id === d.id ? null : w));
        const active = document.activeElement as HTMLElement | null;
        // Its line may already be gone with the focused button, leaving focus on the body.
        const onIt = !active || active === document.body || !!root.current?.querySelector(`.qcard[data-item="${CSS.escape(d.id)}"]`)?.contains(active);
        if (onIt) leave();
      })
      .catch((e: Error) => setResult((r) => ({ ...r, [d.id]: rawError(e) })))
      .finally(() => setBusy(null));
  };

  const cards = shown.map((id) => {
    const d = liveById.get(id);
    const seen = d ?? last.current.get(id);
    if (!seen) return null;
    const s = byId.get(seen.session_id);
    if (!d)
      return (
        <div key={`gone-${id}`} className="qcard gone" data-gone={id}>
          <span className="who">{name(s, seen)}</span>
          <span className="what">{result[id] === 'answered' ? t('rest.shell.strip.answered') : t('rest.shell.strip.gone')}</span>
        </div>
      );
    const p = plan(d, s, t);
    const late = checking(d) && now - (restored.current.get(d.id) ?? now) >= CHECK_MS; // V2-1b
    if (late) p.note = t('own.ans.notProved');
    const text = d.board || d.owner ? d.text : summary(d); // v1b-18: a board question is plain text; v1a-23: so is an owner item
    const project = d.board ? d.board.project : s?.project; // v1b-18
    const error = result[id] && result[id] !== 'answered' ? result[id] : null;
    return (
      <div
        key={id}
        className="qcard"
        data-item={id}
        data-kind={d.kind}
        data-checking={checking(d) || undefined}
        tabIndex={0}
        onFocus={() => want?.id !== id && setWant({ id, n: want?.n ?? 0, at: Date.now() })}
        role="group"
        aria-label={`${name(s, d)}, ${project ? base(project) : ''}: ${t(kindKey[d.kind])}. ${text}`}
        onKeyDown={(e) => {
          // A key that belongs to an IME composition is the IME's, never an answer (keyCode 229 alone is not
          // composing: a Korean input source sends it for every key, 07a).
          if (e.nativeEvent.isComposing || e.metaKey || e.ctrlKey || e.altKey) return;
          // v1b-18: an open full-text panel closes first (the browser closes it on this Escape).
          if (e.code === 'Escape' && e.currentTarget.querySelector('.qfull:popover-open')) return;
          if (e.code === 'Escape') return e.preventDefault(), leave();
          const act = p.acts.find((a) => a.code === e.code);
          if (act) e.preventDefault(), send(d, act);
        }}
      >
        <span className="tg">{t(`a11y.chip.${d.kind}`)}</span>
        <span className="who">{name(s, d)}</span>
        <span className="what" title={d.text}>
          {text}
        </span>
        <span className="dim">{project ? base(project) : ''}</span>
        {p.terminal.length > 0 && (
          <span className="qterm" title={p.terminal.join('\n')}>
            {p.terminal.join(' · ')} · {t('rest.shell.strip.inTerminal')}
          </span>
        )}
        {(error ?? p.note) && (
          <span className={error ? 'note err' : 'note'} role={error ? 'alert' : undefined} title={error ?? undefined} aria-describedby={error ? `${rawId}${encodeURIComponent(id)}` : undefined}>
            {error ? lineError(t, error) : p.note}
          </span>
        )}
        {error && (
          <span hidden id={`${rawId}${encodeURIComponent(id)}`}>
            {error}
          </span>
        )}
        {/* Acts on press, before the card takes focus and swaps this for the answer buttons. */}
        <button className="btn qopen" onMouseDown={(e) => (e.preventDefault(), onOpen(d))} onClick={(e) => e.detail === 0 && onOpen(d)}>
          {late ? t('rest.shell.strip.openTerminal') : t('rest.shell.strip.open')}
        </button>
        <span className="qacts">
          {p.acts.map((a) => (
            <button key={a.label} className="btn" disabled={busy === id} onClick={() => send(d, a)}>
              {a.label}
            </button>
          ))}
          {/* v1a-23: the core approves only what the sheet shows, at the hash it shows. */}
          {d.owner?.type === 'approval' && (
            <button className="btn" onClick={() => d.owner?.type === 'approval' && setSheet({ name: d.owner.name, subject: d.owner.subject })}>
              {t('rest.shell.strip.review')}
            </button>
          )}
          {/* Ticket 259: the setup sheet reads the script from the worktree and approves exactly what it shows. */}
          {d.owner?.type === 'setup' && (
            <button className="btn" onClick={() => d.owner?.type === 'setup' && setSheet({ name: d.owner.path, subject: 'setup' })}>
              {t('rest.shell.strip.review')}
            </button>
          )}
          {/* v1b-18: the full question in the top layer, so nothing in the window moves; the link opens in the
              user's browser. */}
          {d.board && (
            <>
              <button className="btn" popoverTarget={`qfull-${id}`}>
                {t('rest.shell.strip.fullText')}
              </button>
              {d.board.url && (
                <button className="btn" onClick={() => void openExternal(d.board!.url!)}>
                  {t('rest.shell.strip.open')}
                </button>
              )}
            </>
          )}
        </span>
        {d.board && (
          <div className="qfull" id={`qfull-${id}`} popover="auto" role="dialog" aria-label={t('rest.shell.strip.fullQuestion', { name: name(s, d) })}>
            <div className="qfull-h">
              {name(s, d)}
              {project ? ` · ${base(project)}` : ''} · {d.board.title}
            </div>
            <p>{d.text}</p>
          </div>
        )}
      </div>
    );
  });

  return (
    <div
      ref={root}
      className="qstrip"
      data-empty={shown.length === 0 ? '' : undefined}
      onPointerEnter={() => ((pointer.current = true), hold())}
      onPointerLeave={() => ((pointer.current = false), release())}
      onFocus={hold}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) release();
      }}
    >
      {/* Strip on: drawn after the card on its one line (queue.css); the title is for screen readers only. */}
      <div className="sh">
        <span className={mode === 'on' ? 'sr' : undefined}>
          {t('shell.widget.waiting')}
          <span aria-live="polite">{live.length > 0 ? ` · ${live.length} · ${t('rest.shell.strip.keepsFocus')}` : ''}</span>
        </span>
        <span className="sp" />
        <span className="qnew">{fresh > 0 ? t('rest.shell.strip.new', { n: fresh }) : ''}</span>
        {more > 0 && (
          <button type="button" className="qmore" title={t('chat.strip.next')} aria-label={`+${more}, ${t('chat.strip.next')}`} onClick={next}>
            +{more}
          </button>
        )}
        {/* v1b-18 */}
        {boardLevel && board.length > 0 && <NotifyLevel t={tEn} session={BOARD_LEVEL} label={t('rest.shell.strip.boardDecisions')} level={boardLevel.level} onChange={(_, l) => boardLevel.set(l)} />}
        {shown.length > 0 && (
          <>
            <span className="kbd">{hint}</span>
            <span>{t('rest.shell.strip.toCard')}</span>
          </>
        )}
      </div>
      {shown.length > 0 && <div className="qcards">{cards}</div>}
      {/* v1a-23: outside the cards, so keys typed in the sheet never reach a card's answer keys. */}
      {sheet && <PermissionSheet core={core} name={sheet.name} subject={sheet.subject} onClose={() => setSheet(null)} onGranted={() => setSheet(null)} />}
    </div>
  );
}
