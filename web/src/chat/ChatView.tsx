// Chat view of one session tab (spec v1b B1, R8-final frame 1): a virtualised list over the chat feed. Needs 26:
// once the user scrolls up, nothing that arrives moves what they see; a "new ↓" chip offers the way back down.
import { Icon } from '../icons/Icon';
import { claimReturn, seenCursor, STOP_RETURN_EVENT, stoppedAt } from './stopped';
import { claimControls } from './commandRecord';
import { useVirtualizer, type VirtualItem } from '@tanstack/react-virtual';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react';
import type { Boot } from '../api';
import { Tr, type T } from '../i18n';
import { ErrorDetails, plainError, rawError } from '../errors';
import { agentState, status as stateOf, type Session } from '../types';

/** Agent sessions have a transcript: a running one has a live chat and a side pane, an ended or closed one shows its chat read-only (V1A-59). */
// Q10: an agent on an SSH machine has no chat here (a chat page is local-only): its tab shows its terminal, as a shell's.
export const hasTranscript = (s: Session | null | undefined): boolean => !!s && s.kind !== 'shell' && !s.machine;
const isLive = (s: Session | null | undefined): s is Session => !!s && hasTranscript(s) && agentState(s) === 'running'; // ticket 286: read-only once the agent ends
import { chatFeed, type ChatEvent, type ChatFeed, type Page, type PageKind } from './feed';
import { buildRows, mergeEvents, viewRows } from './model';
import { cycleView, useView, VIEW_LABEL } from './view'; // CHROME
import { PlanStrip } from './PlanStrip'; // needs 168
import { matches, Pending } from './pending'; // v1b-12; ticket 212
import { publishPrompts, recallable } from './promptHistory'; // ticket 371
import { baseName } from '../files/open';
import { elapsed, Open, RowView } from './Rows';
import { PR_CHIP_EVENT, PrChip, type PrChipData } from './PrChip'; // v2-8b
import { useWarm } from '../warm';
import { blocked, show as paneShow } from '../pane/store';
import { doneJump, useJump } from '../search/jump'; // v2-7
import { agentName, chain, handOff, type Member } from './conversation'; // v2-3b
import { RowIcon } from '../tree/RowIcon'; // v25-design-chat: the tree's working arc
import './chat.css';
import './handoff.css'; // v2-3b
import { keyText } from '../keys';
import { freshSeats } from '../lead/lead';
import { FirstChat } from '../bots/FirstChat';

interface State {
  generation: number | null;
  events: ChatEvent[];
  /** Exclusive cursor of the next older page; null when history is complete. */
  before: number | null;
  banner: ChatEvent | null;
  skipped: number;
  error: string | null;
  /** Ticket 480: the failure was an older page's read, not the live feed. */
  older?: boolean;
  /** Ticket 212 (A5): the core's reason for having no transcript to read, from the latest page. */
  noTranscript: string | null;
}
type Action = { type: 'page'; page: Page; kind: PageKind } | { type: 'older'; page: Page } | { type: 'error'; error: string; older?: boolean };

/** What a session's chat list keeps across an unmount (a tab cold for 30 s, warm.ts): pages loaded, expanded rows, where the reader was (need 26). */
interface Kept {
  state: State;
  open: Set<string>;
  follow: boolean;
  anchor: { key: number; offset: number } | null;
  lastKey: number | undefined;
  /** Measured row sizes, so the restored anchor lands where it was instead of on 36 px estimates. */
  sizes: VirtualItem[];
}
/** Oldest dropped first: a window that cycles through many sessions does not keep every transcript it ever showed. */
const KEPT_MAX = 8;
const kept = new Map<string, Kept>();

const EMPTY: State = { generation: null, events: [], before: null, banner: null, skipped: 0, error: null, noTranscript: null };

function reduce(s: State, a: Action): State {
  if (a.type === 'error') return { ...s, error: a.error, older: a.older };
  const p = a.page;
  // Fail closed on a schema this window was not built for: show nothing rather than misread it.
  if (p.schema_version !== 1) return { ...s, error: `chat schema ${p.schema_version} is not supported by this window` };
  if (a.type === 'older') {
    if (p.generation !== s.generation) return s;
    return { ...s, events: mergeEvents(s.events, p.events), before: p.before };
  }
  const last = s.events.length ? s.events[s.events.length - 1].cursor : null;
  // A reconnect page that starts past what we hold may hide a gap: start over from it.
  const gap = a.kind === 'open' && last !== null && p.before !== null && p.events.length > 0 && p.events[0].cursor > last + 1;
  if (a.kind === 'reset' || s.generation === null || p.generation !== s.generation || gap)
    return { generation: p.generation, events: p.events, before: p.before, banner: p.banner, skipped: p.skipped, error: null, noTranscript: p.no_transcript ?? null };
  return { ...s, events: mergeEvents(s.events, p.events), banner: p.banner ?? s.banner, skipped: p.skipped, error: null, noTranscript: p.no_transcript ?? null };
}

/** `catchUp` runs before rows change: see ChatList. */
function useChat(feed: ChatFeed, session: string, catchUp: () => void) {
  const [state, dispatchNow] = useReducer(reduce, session, (id): State => (kept.has(id) ? { ...kept.get(id)!.state, error: null } : EMPTY));
  const dispatch = useCallback((a: Action) => (catchUp(), dispatchNow(a)), [catchUp]);
  useEffect(
    () =>
      feed.open(session, {
        page: (page, kind) => dispatch({ type: 'page', page, kind }),
        error: (error) => dispatch({ type: 'error', error }),
      }),
    [feed, session, dispatch],
  );
  const loading = useRef(false);
  const older = useCallback(() => {
    if (loading.current || state.before === null) return;
    loading.current = true;
    feed
      .older(session, state.before)
      .then((page) => dispatch({ type: 'older', page }))
      // Retry resubscribes and clears it; the next scroll asks for the page again.
      .catch((e: Error) => dispatch({ type: 'error', error: rawError(e), older: true }))
      .finally(() => (loading.current = false));
  }, [feed, session, state.before, dispatch]);
  return { state, older };
}

/** v25-design-chat (needs 140 motion): the working row. Mounted when the turn starts and dropped when it ends, so each
 * turn counts from 0. Ticket 1094: keyed by the turn's start, so a turn that follows another between two snapshots
 * counts from its own start too, never from the first turn the row saw. */
// q67 look (new 7): counts from the core's turn start (`attention.working_since`), the moment the tree row's time counts
// from, so a tab opened mid-turn does not start again at 0 beside a row that says "2 min". A start the window's clock has
// not reached (an older core's 0, another machine's clock) counts from when this list saw the turn.
function Working({ t, since }: { t: T; since?: number }) {
  const [start] = useState(() => (since && since <= Date.now() ? since : Date.now()));
  const [now, setNow] = useState(Date.now); // not `start`: a list drawn mid-turn shows the turn's time at once
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const s = Math.floor((now - start) / 1000);
  return (
    <div className="wline">
      <RowIcon kind="work" />
      {/* The live region says "Working" once; the ticking time is for the eye only, not announced every second. */}
      <span className="sr">{t('chat.v25.working')}</span>
      <span className="wtime" aria-hidden>{s < 1 ? t('chat.v25.working') : t('chat.v25.workingFor', { time: elapsed(s) })}</span>
    </div>
  );
}

/** Pixels from the end that still count as "at the bottom" (rounding and sub-pixel scroll positions). */
const BOTTOM = 8;
/** Quiet time after the last tool result before the PR chip is fetched again. */
const PR_CHIP_DELAY = 2000;

// v1b-12: `boot` and the session's decisions, for the diff cards' Accept/Reject.
function ChatList({ boot, feed, session, shown, readOnly, head, main, t }: { t: T; boot: Boot; feed: ChatFeed; session: Session; shown: boolean; readOnly: boolean; head?: ReactNode; main?: boolean }) {
  const scroller = useRef<HTMLDivElement>(null);
  const lastTop = useRef(0);
  const lastHeight = useRef(0);
  // V1A-50: a scroll event fires a frame after the scroll. Rows that change in between would be placed from the
  // position of the last event (the anchor below, and the list's own size adjustments) and undo the user's scroll,
  // so a scroll not yet reported is reported first.
  const catchUp = useCallback(() => {
    const el = scroller.current;
    if (el && el.scrollTop !== lastTop.current) el.dispatchEvent(new Event('scroll'));
  }, []);
  const { state, older } = useChat(feed, session.id, catchUp);
  const built = useMemo(() => buildRows(state.events), [state.events]);
  useEffect(() => publishPrompts(session.id, built), [session.id, built]); // ticket 371: the composer's Up and Down read these
  useEffect(() => claimControls(session.id, built), [session.id, built]); // ticket 1019: the picker's own commands
  const view = useView(); // CHROME: Verbose shows `built` as is; Normal and Thinking fold each turn
  const asking = session.pending.filter((d) => d.kind === 'permission').length; // sixth look: a command whose request waits has not run
  const shownRows = useMemo(() => viewRows(built, view, asking), [built, view, asking]);
  useEffect(() => void (state.events.length && seenCursor(session.id, state.events[state.events.length - 1].cursor)), [session.id, state.events]);
  // N27: the user's own Stop before any output: Claude writes no record, so the message it stopped reads as interrupted.
  const stop = stoppedAt(session.id);
  const tail = shownRows[shownRows.length - 1];
  const rows = stop !== undefined && (tail?.kind === 'user' || tail?.kind === 'wakes') && tail.key <= stop && !session.attention.working ? [...shownRows, { kind: 'interrupted' as const, key: tail.key + 0.5 }] : shownRows;
  const stopped = rows !== shownRows && tail?.kind === 'user' ? tail : null;
  useEffect(() => {
    const text = stopped && claimReturn(session.id, stopped.key) ? recallable(stopped.text) : '';
    if (text) window.dispatchEvent(new CustomEvent(STOP_RETURN_EVENT, { detail: { id: session.id, text } }));
  }, [session.id, stopped?.key]); // eslint-disable-line react-hooks/exhaustive-deps
  // v2-8b: one fetch when the chat opens, then one 2 s after the last tool result (the core reads up to 20 chat pages per
  // fetch). The timer exists only after a result arrived; a late reply of an older fetch is dropped.
  const results = useMemo(() => state.events.filter((e) => e.data.kind === 'tool_result').length, [state.events]);
  const [prChip, setPrChip] = useState<PrChipData | null>(null);
  const seen = useRef({ session: session.id, results });
  useEffect(() => {
    let live = true;
    const fetch = () => feed.prChip(session.id).then((c) => live && setPrChip(c), () => {});
    const first = seen.current.session !== session.id || seen.current.results === results;
    seen.current = { session: session.id, results };
    const timer = first ? undefined : setTimeout(fetch, PR_CHIP_DELAY);
    if (first) fetch();
    // A PR the Diff panel created for this session: read the chip now.
    const changed = (e: Event) => (e as CustomEvent<{ session: string }>).detail?.session === session.id && fetch();
    window.addEventListener(PR_CHIP_EVENT, changed);
    return () => {
      live = false;
      clearTimeout(timer);
      window.removeEventListener(PR_CHIP_EVENT, changed);
    };
  }, [feed, session.id, results]);
  // Ticket 212 (A9): the queue keeps `working` set while a PermissionRequest or question waits, so a pending decision
  // would read "Working for 1m". A decision that needs the person shows no timer; the tree mark, the header status and the Decisions widget say it (needs 205).
  const asks = main && !readOnly && session.state === 'running' && session.pending.some((d) => d.kind !== 'stale' && d.kind !== 'background');
  // Look 1117 v13 B N13-S3-1: a turn blocked in `agent ask --wait` waits for an answer, as the tab and header say: no timer either.
  const working = main && !readOnly && session.attention.working && !session.attention.asking && session.state === 'running' && !asks;
  const pending = useMemo(() => ({ session, boot, matched: matches(built, session.pending) }), [session, boot, built]);
  const was = kept.get(session.id);
  const follow = useRef(was?.follow ?? true);
  const anchor = useRef<{ key: number; offset: number } | null>(was?.anchor ?? null);
  const [unseen, setUnseen] = useState(false);
  // v2-7: a Search hit to show; older pages load until its event is in, then its row is scrolled to and marked.
  const jump = useJump(session.id);
  const [marked, setMarked] = useState<number | null>(null);
  const [open, setOpen] = useState<Set<string>>(() => new Set(was?.open));
  const openCtx = useMemo(
    () => ({
      has: (k: string) => open.has(k),
      toggle: (k: string) =>
        setOpen((o) => {
          const n = new Set(o);
          if (!n.delete(k)) n.add(k);
          return n;
        }),
    }),
    [open],
  );

  const v = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    // Hover actions overlay the next row; measurements refine this one-line estimate for wrapped text.
    estimateSize: () => 36,
    getItemKey: (i) => rows[i].key,
    overscan: 8,
    initialMeasurementsCache: was?.sizes,
  });

  /** The first row at the top edge and how far into it the view starts: what must stay put. */
  const remember = () => {
    const el = scroller.current;
    if (!el) return;
    const top = el.scrollTop;
    // All measurements, not the rendered range: right after a prepend that range still describes the old offset.
    const all = v.measurementsCache;
    let lo = 0;
    let hi = all.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (all[mid].end > top) hi = mid;
      else lo = mid + 1;
    }
    const item = all[lo];
    anchor.current = item && item.end > top ? { key: item.key as number, offset: top - item.start } : null;
  };

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM;
    // Growth below never changes scrollTop, so only the user moving up leaves follow mode. The list's own correction
    // for rows measured above the view also lowers scrollTop, but always with a new content height (V1A-60b).
    if (atBottom) {
      follow.current = true;
      setUnseen(false);
    } else if (el.scrollTop < lastTop.current && el.scrollHeight === lastHeight.current) follow.current = false;
    lastTop.current = el.scrollTop;
    lastHeight.current = el.scrollHeight;
    remember();
    if (el.scrollTop < 400) older();
  };

  const total = v.getTotalSize();
  const prevLast = useRef<number | undefined>(was?.lastKey);
  const placed = useRef(rows);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    // Rows change only through the feed, which reports a pending scroll first (catchUp). A re-measure alone (same rows,
    // positions already consistent with scrollTop) reports it here, or the anchor below would undo it.
    if (placed.current === rows) catchUp();
    placed.current = rows;
    // Something new at the bottom (an older page prepends at the top and does not count).
    const lastKey = rows[rows.length - 1]?.key;
    const grew = prevLast.current !== undefined && lastKey !== prevLast.current;
    prevLast.current = lastKey;
    if (follow.current) {
      el.scrollTop = el.scrollHeight;
      lastTop.current = el.scrollTop;
      lastHeight.current = el.scrollHeight;
      return;
    }
    if (grew) setUnseen(true);
    const a = anchor.current;
    if (!a) return;
    // Older pages and re-measured rows above shift positions: keep the anchor row where it was.
    let i = rows.findIndex((r) => r.key === a.key);
    if (i < 0) i = rows.findLastIndex((r) => r.key <= a.key);
    const m = i >= 0 ? v.measurementsCache[i] : undefined;
    if (!m) return;
    const want = m.start + a.offset;
    if (Math.abs(el.scrollTop - want) >= 1) {
      el.scrollTop = want;
      lastTop.current = el.scrollTop;
      lastHeight.current = el.scrollHeight;
    }
  }, [rows, total, v, catchUp, working]);

  // The frame that first shows the newest row inside the view after this chat opened: the long-chat open figure reads this mark (scripts/measure/measurelib.py chat_open).
  // Checked once a frame for 5 s at most (a reader scrolled up in a kept chat never shows it).
  const drawn = useRef(false);
  const lastIndex = rows.length - 1;
  useEffect(() => {
    if (drawn.current || !shown || lastIndex < 0) return;
    const until = performance.now() + 5000;
    const look = () => {
      const el = scroller.current;
      const a = el?.getBoundingClientRect();
      const b = el?.querySelector(`.crow[data-index="${lastIndex}"]`)?.getBoundingClientRect();
      if (a && b && b.bottom > a.top && b.top < a.bottom) {
        drawn.current = true;
        performance.mark(`nunchiro:chat-drawn ${session.id}`);
      } else if (performance.now() < until) frame = requestAnimationFrame(look);
    };
    let frame = requestAnimationFrame(look);
    return () => cancelAnimationFrame(frame);
  }, [shown, lastIndex, session.id]);

  // v2-7
  useEffect(() => {
    if (!jump || state.generation === null || !shown) return;
    if ((state.events[0]?.cursor ?? 1) > jump.cursor && state.before !== null) return older();
    // Cards follow the reply visually; resolve the source cursor before looking in display order.
    const hit = built.findLast((r) => r.key <= jump.cursor);
    const i = hit ? rows.findIndex((r) => r.key === hit.key || (r.kind === 'summary' && r.rows.some((step) => step.key === hit.key))) : -1;
    if (i >= 0) {
      follow.current = false;
      anchor.current = null;
      v.scrollToIndex(i, { align: 'center' });
      // The list reads its offset from scroll events, which WebKit delivers a frame late. A row measured in between is
      // then corrected from the old offset (near the bottom) and undoes the jump, and the list never retries. Tell it now.
      scroller.current?.dispatchEvent(new Event('scroll'));
      setMarked(rows[i].key);
    }
    doneJump(session.id, jump);
  }, [jump, state, built, rows, v, older, shown, session.id]);

  // The latest of everything kept, written on unmount (the cleanup must not close over a stale render).
  const now = useRef({ state, open, v });
  now.current = { state, open, v };
  useEffect(() => {
    const id = session.id;
    return () => {
      const c = now.current;
      // follow, anchor and prevLast change without a render (onScroll), so they are read here, not at render time.
      kept.delete(id);
      kept.set(id, { state: c.state, open: c.open, follow: follow.current, anchor: anchor.current, lastKey: prevLast.current, sizes: c.v.measurementsCache });
      if (kept.size > KEPT_MAX) kept.delete(kept.keys().next().value!);
    };
  }, [session.id]);

  // The box changes height (the answer strip appears or goes, V1A-60b): a chat that follows stays at the bottom.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (!follow.current) return;
      el.scrollTop = el.scrollHeight;
      lastTop.current = el.scrollTop;
      lastHeight.current = el.scrollHeight;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const toBottom = () => {
    follow.current = true;
    setUnseen(false);
    v.scrollToIndex(rows.length - 1, { align: 'end' });
    requestAnimationFrame(() => scroller.current && (scroller.current.scrollTop = scroller.current.scrollHeight));
  };

  // Ticket 603: a session that failed before any turn (its agent is not installed) has no version to warn about. Ticket 605:
  // after a core restart that session reads `exited`, so any ended session with no row drops the band.
  const banner = state.banner?.data.kind === 'version_banner' && !(session.state !== 'running' && rows.length === 0) ? state.banner.data : null;
  // v25-empty: a live session with no messages shows the empty-state block above the composer. An ended session keeps
  // the plain sentence: it invites no typing. A working turn clears the block at once: the first message is in flight.
  const emptyChat = main && !readOnly && state.generation !== null && rows.length === 0 && !banner && !session.attention.working;
  // Ticket 212 (A5): a session that works but has no transcript to read says why, instead of an empty chat. A fresh
  // session that has not been asked anything yet keeps the start screen above: it has no transcript either, by design.
  const notranscript = main && !readOnly && session.state === 'running' && session.attention.working && state.generation !== null && rows.length === 0 && !banner && state.noTranscript !== null;
  return (
    <Tr.Provider value={t}>
    <div className="chat" data-off={shown ? undefined : ''} data-readonly={readOnly ? '' : undefined} inert={!shown} aria-hidden={!shown} data-session={session.id}>
      {banner && (
        <div className="vbanner" role="status">
          <span>
            <b>
              {banner.agent} {banner.version}
            </b>{' '}
            {t('chat.banner.tail', { extra: state.skipped ? ` · ${t('chat.skipped')}` : '' })}
          </span>
          {!readOnly && (
            <button className="btn p" onClick={() => paneShow(session.id, 'pty', true)}>
              {t('chat.openTerminal')}
            </button>
          )}
        </div>
      )}
      <PrChip chip={prChip} now={Date.now()} from={{ id: session.id, shell: session.kind === 'shell' }} t={t} />
      {main && (
      <div className="cview">
        {!banner && state.skipped > 0 && <span className="skipped dim">{t('chat.skipped')}</span>}
        {/* Ticket 473: a session with no transcript has nothing to view in another way, so the view switch is not shown. */}
        {built.length > 0 && (
          <button className="btn" aria-label={t('chat.view.aria', { view: t(VIEW_LABEL[view]) })} data-tip={t('chat.view.tip', { key: keyText('chat.cycleView') })} onClick={cycleView}>
            {/* b2-S3-2 (look 1117 v4f): a list mark says this is how the transcript is shown, not a permission mode. */}
            <Icon name="list-unordered" size={12} />
            {t(VIEW_LABEL[view])}
          </button>
        )}
      </div>
      )}
      {head /* v2-3b */}
      {!main && !banner && state.skipped > 0 && <div className="skipped dim">{t('chat.skipped')}</div>}
      {state.error && (
        <div className="chaterr light-bad light-edge" role="alert">
          <span>{t(state.older ? 'err.olderNotLoaded' : 'chat.error', { error: plainError(t, state.error) })}</span>
          <button className="btn" onClick={() => feed.retry(session.id)}>
            {t('chat.retry')}
          </button>
          {!readOnly && (
            <button className="btn" onClick={() => paneShow(session.id, 'pty', true)}>
              {t('chat.terminal')}
            </button>
          )}
          <ErrorDetails t={t} details={state.error} />
        </div>
      )}
      <div className="cscroll" ref={scroller} onScroll={onScroll}>
        {emptyChat && (
          <div className="empty">
            <div className="ehead">
              {/* Verify look 11-16 (A9, C7): an agent that asks before anything else (Claude's folder-trust question)
                  left "What should we build?" over a composer that could not send; a teammate's seat is asked what
                  it should do, not what to build in its folder. */}
              <h3>{stateOf(session) === 'waiting' ? t('chat.empty.waitTitle', { name: session.label || t('chat.theAgent') }) : session.teammate ? t('chat.empty.seatTitle', { name: session.label || t('chat.theAgent') }) : t('chat.empty.title', { project: baseName(session.project) })}</h3>
              {/* Ticket 1097: the terminal at the side opens only for what the card above the composer cannot answer (pane/store.ts blocked). */}
              {/* Ticket 1130 B-L3: a conversation "New conversation" just opened says what it keeps (the mockup's quiet line). */}
              <p>{stateOf(session) !== 'waiting' && freshSeats.has(session.id) ? t('lead.newConvSame', { name: session.label || t('chat.theAgent') }) : t(stateOf(session) !== 'waiting' ? 'chat.empty.hint' : session.pending.some((d) => d.kind === 'question' || d.kind === 'permission') && !blocked(session) ? 'chat.empty.waitCard' : 'chat.empty.waitHint')}</p>
            </div>
          </div>
        )}
        {/* An ended session invites no typing: it keeps the plain sentence. Ticket 603: not when the problem card above says why
            it failed ("the transcript shows here once written" is never true for an agent that did not start). */}
        {!emptyChat && readOnly && state.generation !== null && rows.length === 0 && !banner && !(session.state === 'failed' && session.problem) && (
          <div className="empty ro">{t('chat.empty', { name: session.label || t('chat.theAgent') })}</div>
        )}
        <Open.Provider value={openCtx}>
          <Pending.Provider value={pending}>{/* v1b-12 */}
          <div className="clist" role="feed" aria-label={t('chat.feed')} aria-busy={state.generation === null} style={{ height: total }}>
            {v.getVirtualItems().map((it) => (
              <div key={it.key} ref={v.measureElement} data-index={it.index} data-key={it.key} data-hit={it.key === marked ? '' : undefined /* v2-7 */} className="crow" role="article" style={{ transform: `translateY(${it.start}px)` }}>
                <div className="cin">
                  <RowView row={rows[it.index]} session={session.id} messageId={`${state.generation}:${rows[it.index].key}`} /* v1b-06 */ />
                </div>
              </div>
            ))}
          </div>
          </Pending.Provider>{/* v1b-12 */}
        </Open.Provider>
      {/* A new bot's first chat: its SOUL card and its seat card follow the last row (bots/FirstChat.tsx). */}
      {main && !readOnly && session.teammate && <FirstChat t={t} session={session} working={session.attention.working} />}
      {/* Always present, so a screen reader hears the row that appears in it (a live region added with its text is often skipped). */}
      <div className="wlive" role="status">
        {working && !emptyChat && <Working key={session.attention.working_since ?? 0} t={t} since={session.attention.working_since} />}
      </div>
      {notranscript && (
        <div className="wline notrans" role="status">
          {t('chat.noTranscript', { reason: state.noTranscript! })}
        </div>
      )}
      </div>
      <PlanStrip events={state.events} session={session.id} /> {/* needs 168: above the composer, in the chat column */}
      {unseen && (
        <button className="newchip" onClick={toBottom}>
          {t('chat.newBelow')}
        </button>
      )}
    </div>
    </Tr.Provider>
  );
}

/** Mounted per open agent tab: its chat (kept, hidden, for 30 s after it was shown, then dropped; pages, expanded rows and place are kept in `kept`). An
 * ended session has no terminal: its chat is all there is, read-only, and App disables the composer with a reason (V1A-59). */
function ChatPane({ boot, session, active, all, t }: { t: T; boot: Boot; session: Session; active: boolean; all: Session[] }) {
  const live = isLive(session);
  const warm = useWarm(active);
  const shown = active;
  const links = chain(session, all);
  const earlier = links.at(-2);
  const why = useId(); // Ticket 412: a disabled control names its reason to screen readers too (aria-describedby to a hidden span), not only in its tooltip.
  // v2-3b: the chain "Claude 14 turns › Codex"; an earlier link hands the conversation back (on Enter, to that same
  // session). The session switched from stays above the divider, read-only.
  const head = earlier && (
    <>
      <nav className="conv-chain" aria-label={t('chat.chain.nav')}>
        {links.map((x, i) =>
          i < links.length - 1 ? (
            <span key={x.id}>
              {/* Ticket 39: a link of this session's own agent is not a hand-off (the core refuses one). */}
              <button
                type="button"
                disabled={!live || x.kind === session.kind}
                title={x.kind === session.kind ? t('chat.chain.same') : t('chat.chain.back', { agent: agentName(x.kind) })}
                aria-describedby={x.kind === session.kind ? why : undefined}
                onClick={() => handOff(session.id, x.kind)}
              >
                {t('chat.chain.turns', { agent: agentName(x.kind), n: (x as Member & { completion_seq?: number }).completion_seq ?? 0 })}
              </button>{' '}
              ›
            </span>
          ) : (
            <span key={x.id} aria-current="page">
              {agentName(x.kind)}
            </span>
          ),
        )}
        {links.slice(0, -1).some((x) => x.kind === session.kind) && (
          <span id={why} hidden>
            {t('chat.chain.same')}
          </span>
        )}
      </nav>
      <div className="conv-earlier">
        <ChatList boot={boot} feed={chatFeed(boot)} session={earlier} shown={shown} readOnly t={t} />
      </div>
      <div className="conv-div" role="separator">
        {t('chat.chain.switched', { agent: agentName(session.kind) })}
      </div>
    </>
  );
  return (
    <>
      {warm && <ChatList boot={boot} feed={chatFeed(boot)} session={session} shown={shown} readOnly={!live} head={head} main t={t} />}
    </>
  );
}

/** One ChatPane per open tab whose session has a transcript (07a's pane mounts this beside its terminals). */
export function ChatPanes({ boot, sessions, active, all = [], t }: { t: T; boot: Boot; sessions: (Session | undefined)[]; active: string | null; all?: Session[] }) {
  return sessions.filter((s): s is Session => hasTranscript(s)).map((s) => <ChatPane key={s.id} boot={boot} session={s} active={active === s.id} all={all} t={t} />);
}

