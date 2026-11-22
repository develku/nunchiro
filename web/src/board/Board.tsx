// Board widget (▦, spec-v1b B4; ticket 16). Polls `board_snapshot` every second while visible. While the pointer or
// focus is inside, the shown board is frozen like the tree (needs 26): arrivals count as "new N" until it leaves.
import { sideChatGone } from '../tree';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CoreClient } from '../api';
import { composing } from '../keys';
import type { Session } from '../types';
import { CardEditor, type CardDraft } from './CardEditor';
import { ColumnEditor } from './ColumnEditor';
import { useCardDrag } from './drag';
import { dropNeighborsForIndex } from './drop';
import { actionable, arrange, columnTitle, keyOf, link, remember, loadPrefs, movable, placeCard, savePrefs, SETTINGS, withColumn, type BoardSettings, type Card, type Column, type Snapshot } from './model';
import { CardView, type CardCtx } from './CardView';
import { LaneGrid } from './Columns';
import { CliLine, ColourKey, Coordinator, SearchField, Strip } from './Strip';
import { ViewOptions } from './ViewOptions';
import { cardCount, WatchCard, WatchGrid } from './WatchGrid';
import { WatchDetail } from './WatchDetail';
import { BUCKETS, bucketOf, byRecent, watchLaneKey, type Bucket } from './watch';
import { coordinator, lanes as laneList, matchesQuery, passes } from './tasks';
import { CENTRE, loadView, MODES, saveView, type View } from './views';
import { EditPanel, Pencil } from './EditPanel';
import { ListView } from './ListView';
import { ProjectSelect } from './ProjectSelect';
import './board.css';
import { push as pushUndo } from '../undo/store';
import { makeT, type Key } from '../i18n';
import { openLink } from '../terminal/links';
import { openExternal, webUrl } from '../sandbox/link';
import { shareBoard } from './useBoardRail';
import { CARD_EVENT, registerBoard, type CardEvent, type CardOp } from './cardMenu';
import { lineError, rawError } from '../errors';

/** V2-14e: `t` as App makes it; a Board placed without one shows English. */
export type T = (key: Key, args?: Record<string, string | number>) => string;
const ENGLISH: T = makeT('en', 'en');

/** Zone ids of the two bars' sidebars (App passes the side). */
const BAR_SIDES = ['left', 'right'];

/** `zone`: the id of the zone the widget sits in; its saved view (lane key, filters, fields, density) is kept under it. */
export function Board({ core, sessions, onOpen, t = ENGLISH, zone = CENTRE }: { core: CoreClient; sessions: Session[]; onOpen: (id: string) => void; t?: T; zone?: string }) {
  const [live, setLive] = useState<Snapshot | null>(null);
  const [view, setView] = useState<View>(() => loadView(zone));
  const [viewZone, setViewZone] = useState(zone);
  if (viewZone !== zone) (setViewZone(zone), setView(loadView(zone)));
  const [editing, setEditing] = useState(false);
  const [held, setHeld] = useState<Snapshot | null>(null);
  const [prefs, setPrefs] = useState(loadPrefs);
  const [editor, setEditor] = useState<{ card: Card | null; column: string } | null>(null);
  const [columnsOpen, setColumnsOpen] = useState(false);
  const [message, setMessage] = useState('');
  // V2.5-69: the card whose detail is open in place (the watch view), by key.
  const [detail, setDetail] = useState<string | null>(null);
  const [cli, setCli] = useState(false);
  // C7b: the search query is this window's, not part of the saved view.
  const [query, setQuery] = useState('');
  // A refused or unanswered board_undo leaves Undo disabled for this window, saying why (a reload retries).
  const [undoOff, setUndoOff] = useState(false);
  const cliId = useId();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const root = useRef<HTMLElement>(null);
  const inside = useRef({ pointer: false, focus: false });
  const liveRef = useRef(live);
  liveRef.current = live;
  const shown = held ?? live;
  const addCard = () => setEditor({ card: null, column: shown?.columns[0]?.id ?? '' });

  useEffect(() => savePrefs(prefs), [prefs]);
  useEffect(() => saveView(viewZone, view), [viewZone, view]);
  useEffect(() => {
    if (live) setPrefs((p) => (remember(p.order, live) === p.order ? p : { ...p, order: remember(p.order, live) }));
  }, [live]);
  const request = useCallback(async (r: { op: string; [k: string]: unknown }) => ((await core.request(r)) as { board: Snapshot }).board, [core]);
  /** A reply to this window's own action is shown at once, held or not. */
  const gen = useRef(0);
  const apply = useCallback((s: Snapshot) => {
    gen.current++;
    setLive(s);
    setHeld((h) => (h ? s : null));
  }, []);
  // Only the newest action's reply is shown: an older one arriving late would put a moved card back for a moment.
  const acts = useRef(0);
  const act = useCallback(
    async (r: { op: string; [k: string]: unknown }) => {
      const mine = ++acts.current;
      gen.current++;
      const latest = (s: Snapshot) => mine === acts.current && apply(s);
      try {
        latest(await request(r));
        setMessage('');
      } catch (e) {
        const text = rawError(e);
        setMessage(lineError(t, e));
        // A refused write shows the board as it is now.
        await request({ op: 'board_snapshot' }).then(latest, () => {});
        throw new Error(text);
      }
    },
    [apply, request, t],
  );

  useEffect(() => {
    const tick = () => {
      // No request while the widget is hidden (another tab of its zone, a folded zone, a hidden window).
      if (document.visibilityState !== 'visible' || !root.current?.offsetParent) return;
      // A poll sent before this window's own action must not undo it on screen.
      const at = gen.current;
      request({ op: 'board_snapshot' }).then((s) => at === gen.current && setLive(s), () => {});
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [request]);

  // board_seen is sent by useBoardSeen in App, so it works with no Board placed; the next poll shows it.

  const hold = () => setHeld((h) => h ?? liveRef.current);
  const release = () => !inside.current.pointer && !inside.current.focus && setHeld(null);
  // pointerleave is not sent when the element under the pointer is removed (a closed dialog), so while held
  // any pointer move outside the board also counts as leaving.
  useEffect(() => {
    if (!held) return;
    const move = (e: PointerEvent) => {
      if (!inside.current.pointer || root.current?.contains(e.target as Node)) return;
      inside.current.pointer = false;
      if (!inside.current.focus) setHeld(null);
    };
    window.addEventListener('pointermove', move);
    return () => window.removeEventListener('pointermove', move);
  }, [held]);
  // Held updates the user would see: new cards and cards that changed column, among those the filter shows.
  const fresh = held && live ? live.cards.filter((c) => (prefs.project === null || c.project === prefs.project) && held.cards.find((h) => keyOf(h) === keyOf(c))?.column !== c.column).length : 0;
  // An invalid board.toml is shown at once, held or not.
  const error = live?.error ?? null;

  // V2.5-37: the filter chips narrow the snapshot before it is arranged, so drops and keys count only what is shown.
  const tick = Math.floor(Date.now() / 1000) * 1000; // the poll re-renders each second
  // While held (needs 26) the chips judge the board as it was: the clock and session states freeze with it.
  const frozen = useRef<{ now: number; sessions: Session[] } | null>(null);
  if (!held) frozen.current = null;
  else frozen.current ??= { now: tick, sessions };
  const now = frozen.current?.now ?? tick;
  const judged = frozen.current?.sessions ?? sessions;
  // First match wins, as `find` did; one pass per snapshot of sessions instead of a scan per card in each memo below.
  const judgedById = useMemo(() => judged.reduce((m, s) => (m.has(s.id) ? m : m.set(s.id, s)), new Map<string, Session>()), [judged]);
  const judgedOf = useCallback((c: Card) => (c.session_id == null ? undefined : judgedById.get(c.session_id)), [judgedById]);
  const settings = shown?.settings ?? SETTINGS;
  const threshold = settings.stale_minutes;
  const filtered = useMemo(() => {
    if (!shown) return null;
    const col = (c: Card) => shown.columns.find((x) => x.id === c.column) ?? shown.columns[0];
    const session = judgedOf;
    return { ...shown, cards: shown.cards.filter((c) => !gone(session(c)) && passes(c, view.filters, col(c), shown.columns, session(c), now, threshold) && matchesQuery(c, query)) };
  }, [shown, view.filters, judgedOf, now, threshold, query]);
  const lists = useMemo(() => (filtered ? arrange(filtered, prefs.order, prefs.project) : new Map<string, Card[]>()), [filtered, prefs.order, prefs.project]);
  // A card whose column is gone is listed under the first column (arrange); the lanes place it there too.
  // The rail's badge counts the whole board; it reads this snapshot instead of polling beside the widget.
  // `narrowed` is judged on the live board (what the chips and search leave of it), not on a held one, so a hold alone never says "all boards".
  const liveShown = useMemo(() => {
    if (!live) return null;
    const col = (c: Card) => live.columns.find((x) => x.id === c.column) ?? live.columns[0];
    return live.cards.filter((c) => (prefs.project === null || c.project === prefs.project) && !gone(judgedOf(c)) && passes(c, view.filters, col(c), live.columns, judgedOf(c), now, threshold) && matchesQuery(c, query));
  }, [live, prefs.project, view.filters, judgedOf, now, threshold, query]);
  useEffect(() => void (live && liveShown && shareBoard(live, liveShown)), [live, liveShown]);
  const lanes = useMemo(() => laneList([...lists].flatMap(([col, cards]) => cards.map((c) => (c.column === col ? c : { ...c, column: col }))), view.lane), [lists, view.lane]);
  const roles = useMemo(() => [...new Set([...(live?.cards ?? []).flatMap((c) => (c.attachments ?? []).map((a) => a.role)), ...view.filters.role].filter(Boolean))].sort(), [live, view.filters.role]);
  const coord = coordinator(sessions, prefs.project);
  const projects = useMemo(() => [...new Set([...(live?.cards ?? []).map((c) => c.project).filter((p): p is string => !!p), ...(prefs.project ? [prefs.project] : [])])].sort(), [live, prefs.project]);

  // V2.5-69 (ticket 289): the watch view. Columns derive from state; a lane per project only when more than one project shows.
  const watching = view.mode === 'watch' && view.density !== 'list';
  const watchBuckets: Bucket[] = view.showIdle ? [...BUCKETS, 'idle'] : BUCKETS;
  const bucketFor = useCallback((c: Card) => bucketOf(c, shown?.columns ?? [], judgedOf(c)), [shown, judgedOf]);
  const watchLanes = useMemo(() => {
    const cards = byRecent([...lists.values()].flat()).filter((c) => watchBuckets.includes(bucketFor(c)));
    const projects = new Set(cards.map((c) => c.project).filter(Boolean)).size;
    return laneList(cards, watchLaneKey(view.watchLanes, projects));
  }, [lists, view.watchLanes, view.showIdle, bucketFor]); // eslint-disable-line react-hooks/exhaustive-deps
  const watchCounts = useMemo(() => {
    const n = new Map<Bucket, number>();
    for (const lane of watchLanes) for (const c of lane.cards) n.set(bucketFor(c), (n.get(bucketFor(c)) ?? 0) + 1);
    return n;
  }, [watchLanes, bucketFor]);
  // Ticket 991 B16: an idle session not drawn is not missing work; the line under the grid says the rule and the count.
  const idleHidden = watching && !view.showIdle ? [...lists.values()].flat().filter((c) => bucketFor(c) === 'idle').length : 0;
  const detailCard = detail ? (live?.cards.find((c) => keyOf(c) === detail) ?? null) : null;
  useEffect(() => {
    if (detail && live && !detailCard) setDetail(null); // the card is gone (deleted, or its source ended)
  }, [detail, live, detailCard]);

  const focusAfter = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!focusAfter.current) return;
    const card = root.current?.querySelector<HTMLElement>(`[data-card="${CSS.escape(focusAfter.current)}"]`);
    (card?.matches('[tabindex="0"], button') ? card : card?.querySelector<HTMLElement>('[tabindex]'))?.focus(); // a Done card with facts focuses its inner button; a list row is a button
    focusAfter.current = null;
  });

  /**
   * Drag and keyboard both land here: a card dropped at `index` among the cards shown in `column`. The chips may hide
   * cards, so the drop is turned into its shown neighbours and placed in the unfiltered board: hidden cards keep their place.
   */
  const place = useCallback(
    (card: Card, column: string, index: number) => {
      if (!filtered || !shown) return;
      const key = keyOf(card);
      const { beforeTaskId, afterTaskId } = dropNeighborsForIndex((lists.get(column) ?? []).map(keyOf), key, index);
      setPrefs((p) => {
        const all = (arrange(shown, p.order, p.project).get(column) ?? []).map(keyOf).filter((k) => k !== key);
        // Right above the card it was dropped before (a hidden card between stays above): Alt+Up passes exactly one card.
        const at = afterTaskId !== null ? all.indexOf(afterTaskId) : beforeTaskId !== null ? all.indexOf(beforeTaskId) + 1 : all.length;
        return { ...p, order: placeCard(shown, p.order, p.project, key, column, at) };
      });
      if (column === card.column) return;
      apply(withColumn(shown, key, column));
      void act({ op: 'board_move', source: card.source, id: card.id, column }).catch(() => {});
    },
    [filtered, shown, lists, apply, act],
  );
  const laneOf = useCallback((key: string) => lanes.find((l) => l.cards.some((c) => keyOf(c) === key))?.key ?? '', [lanes]);
  /**
   * A drop lands at `index` among one lane's cards in `column`; the order is column-wide, so it is the neighbour's place
   * there. A card's lane comes from its own fields, so a drop into another lane's row ends its own lane's cell.
   */
  const dropAt = useCallback(
    (card: Card, column: string, index: number, lane: string) => {
      const key = keyOf(card);
      const own = laneOf(key);
      if (lane !== own) index = Infinity;
      const all = (lists.get(column) ?? []).map(keyOf).filter((k) => k !== key);
      const cell = (lanes.find((l) => l.key === own)?.cards ?? []).filter((c) => c.column === column).map(keyOf).filter((k) => k !== key);
      const at = index < cell.length ? all.indexOf(cell[index]) : cell.length ? all.indexOf(cell[cell.length - 1]) + 1 : all.length;
      place(card, column, at);
    },
    [lists, lanes, laneOf, place],
  );
  const drag = useCardDrag(root, dropAt);

  const onKey = (e: React.KeyboardEvent, card: Card, column: Column) => {
    if (composing(e.nativeEvent)) return;
    if (!e.altKey) {
      if ((e.code === 'Enter' || e.code === 'Space') && actionable(card)) (e.preventDefault(), open(card));
      return;
    }
    const by = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] }[e.code];
    if (!by || !movable(card)) return;
    e.preventDefault();
    e.stopPropagation();
    moveBy(card, column, by[0], by[1]);
  };
  /** Alt+arrows and the card menu's next/prev: a column sideways keeps the card's row, up and down pass one neighbour. */
  const moveBy = (card: Card, column: Column, dx: number, dy: number) => {
    const cols = shown!.columns;
    const ci = cols.findIndex((c) => c.id === column.id);
    const to = cols[ci + dx];
    if (!to) return;
    // Within the card's own lane cell: up and down step past its neighbours there, left and right keep its row.
    const key = keyOf(card);
    const lane = laneOf(key);
    const cell = (lanes.find((l) => l.key === lane)?.cards ?? []).filter((c) => c.column === column.id).map(keyOf);
    const i = cell.indexOf(key);
    const index = i + dy;
    if (index < 0 || (dy && index >= cell.length)) return;
    focusAfter.current = key;
    dropAt(card, to.id, index, lane);
  };
  const closeDetail = useCallback(() => {
    focusAfter.current = detail;
    setDetail(null);
  }, [detail]);
  const open = (card: Card) => {
    if (watching) return setDetail(keyOf(card)); // V2.5-69: the detail opens in place; "Open session" inside it jumps
    // rc2b-fb (needs 190 (2)): a finished task opens its history and receipt in place; Edit stays in the card menu.
    if (card.source === 'manual' && shown?.columns.find((c) => c.id === card.column)?.states.includes('done')) ctx.onToggle(card);
    else if (card.source === 'manual') setEditor({ card, column: card.column });
    else if (card.session_id) onOpen(card.session_id);
    else if (link(card)) void openLink(link(card)!);
  };

  // needs 171 (r7): the card menu. A key is looked up among the shown cards and must still be in the live board (one
  // deleted meanwhile does nothing); `can` decides what the menu greys and what the event may run.
  const prs = useRef(new Map<string, string>());
  const setPr = useCallback((key: string, url: string | null) => void (url ? prs.current.set(key, url) : prs.current.delete(key)), []);
  const find = (key: string) => {
    const card = lanes.flatMap((l) => l.cards).find((c) => keyOf(c) === key);
    return card && liveRef.current?.cards.some((c) => keyOf(c) === key) ? card : null;
  };
  const can = (card: Card, op: CardOp) => {
    const cols = shown?.columns ?? [];
    const ci = cols.findIndex((c) => c.id === card.column);
    if (op === 'open') return watching || actionable(card);
    if (op === 'edit' || op === 'delete') return card.source === 'manual';
    if (op === 'pr') return !!webUrl(prs.current.get(keyOf(card)));
    return movable(card) && ci >= 0 && !!cols[ci + (op === 'next' ? 1 : -1)];
  };
  const runOp = (card: Card, op: CardOp) => {
    const column = shown!.columns.find((c) => c.id === card.column)!;
    if (op === 'open') open(card);
    else if (op === 'edit') setEditor({ card, column: card.column });
    else if (op === 'pr') void openExternal(webUrl(prs.current.get(keyOf(card)))!);
    else if (op === 'delete') void remove(card).catch(() => {});
    else ((focusAfter.current = keyOf(card)), moveBy(card, column, op === 'next' ? 1 : -1, 0));
  };
  const menu = useRef({ find, can, runOp });
  menu.current = { find, can, runOp };
  useEffect(() => {
    const off = registerBoard((key, op) => {
      const card = menu.current.find(key);
      return !!card && menu.current.can(card, op);
    });
    const onCard = (e: Event) => {
      const { op, key } = (e as CustomEvent<CardEvent>).detail ?? {};
      const card = typeof key === 'string' ? menu.current.find(key) : null;
      if (!card) return; // another placed Board may hold it; a stale key does nothing
      e.stopImmediatePropagation(); // one Board acts
      if (menu.current.can(card, op)) menu.current.runOp(card, op);
    };
    window.addEventListener(CARD_EVENT, onCard);
    return () => (off(), window.removeEventListener(CARD_EVENT, onCard));
  }, []);

  const save = (card: Card | null) => (d: CardDraft) => act({ op: 'board_put', id: card?.id ?? null, ...d });
  /** V2-6a: deleting runs at once; Undo (Q9 ko-J12-1: core `board_undo` on the deleted id) restores the card whole, at its old place in the order. */
  const remove = async (card: Card) => {
    const key = keyOf(card);
    const at = prefs.order.indexOf(key);
    await act({ op: 'board_delete', id: card.id });
    pushUndo({
      label: t('board.deletedCard', { title: card.title }),
      undo: async () => {
        apply(await request({ op: 'board_undo', id: card.id }));
        if (at >= 0) setPrefs((p) => ({ ...p, order: p.order.filter((k) => k !== key).toSpliced(Math.min(at, p.order.length), 0, key) }));
      },
    });
  };
  const putColumns = (columns: Column[]) => act({ op: 'board_columns_put', revision: shown?.revision ?? '', columns });
  // V2.5-38: board.toml `[settings]`, same revision rule as the columns.
  const putSettings = (next: BoardSettings) => act({ op: 'board_settings_put', revision: shown?.revision ?? '', ...next });
  const ctx: CardCtx = { columns: shown?.columns ?? [], cards: live?.cards ?? [], now, onUndo: (card) => {
      const sent = act({ op: 'board_undo', id: card.id });
      // A reply that comes after the 3 s below and says yes turns Undo back on; a refusal leaves it off with its reason.
      sent.then(() => setUndoOff(false), () => {});
      // Every frame with an id gets a reply since f268e65b; a reply the core still holds (or a lost socket) must not
      // leave Undo live, so no answer in 3 s counts as refused too.
      return Promise.race([sent, new Promise<void>((_, no) => setTimeout(() => no(new Error('no reply')), 3000))]).catch(() => setUndoOff(true));
    },
    undoOff,
    open: expanded,
    openSession: onOpen,
    setPr,
    coordinator: coord?.session.id ?? null,
    fields: view.fields,
    threshold,
    onToggle: (card) => setExpanded((s) => (s.has(keyOf(card)) ? new Set([...s].filter((k) => k !== keyOf(card))) : new Set([...s, keyOf(card)]))),
  };
  const counts = new Map([...lists].map(([id, cards]) => [id, cards.length]));
  // Ticket 407: the header counts the cards the columns draw (the watch view leaves Idle out unless asked), from the same list.
  const drawn = watching ? watchLanes.reduce((n, l) => n + l.cards.length, 0) : [...lists.values()].reduce((n, cards) => n + cards.length, 0);
  // V2.5-38: the pencil opens the edit panel (draft B); the panel sits beside the board, or over a narrow list.
  const pencil = (
    <button type="button" className="bpen" aria-label={t('board.edit.open')} title={t('board.edit.open')} aria-pressed={editing} disabled={!shown} onClick={() => setEditing(!editing)}>
      <Pencil />
    </button>
  );
  const panel = editing && shown && <EditPanel t={t} columns={shown.columns} onPut={putColumns} view={view} onView={setView} roles={roles} settings={settings} onSettings={putSettings} onClose={() => setEditing(false)} />;

  const handlers = {
    onPointerEnter: () => ((inside.current.pointer = true), hold()),
    onPointerLeave: () => ((inside.current.pointer = false), release()),
    onFocus: () => ((inside.current.focus = true), hold()),
    onBlur: (e: React.FocusEvent) => {
      if (e.currentTarget.contains(e.relatedTarget as Node)) return;
      // A moved card loses focus while it is re-mounted and gets it back in the same commit; look after that.
      setTimeout(() => {
        if (root.current?.contains(document.activeElement)) return;
        inside.current.focus = false;
        release();
      }, 0);
    },
  };
  if (view.density === 'list') {
    // Draft B's right-bar widget: a one-line header (Board, the active filters, the pencil), the list, the saved view.
    const on = [view.filters.you && t('board.filter.you'), view.filters.role.length > 0 && t('board.filter.roleIs', { role: view.filters.role.join(', ') }), view.filters.stale && t('board.filter.stale'), view.filters.missing && t('board.filter.missing'), view.filters.hideIdle && t('board.filter.hideIdle')].filter((x): x is string => !!x);
    return (
      <section ref={root} className="board bnarrow" aria-label={t('board.region')} data-held={held ? 'true' : 'false'} data-zone={viewZone} {...handlers}>
        <div className="ph bhead">
          {/* In a bar's sidebar the sidebar header already names the Board: one title, as in draft B. */}
          {!BAR_SIDES.includes(viewZone) && (
            <>
              <svg className="bglyph" viewBox="0 0 24 24" aria-hidden>
                <g fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16M15 4v16M5.5 8h1.5M11 8h2M17 8h1.5M11 12h2" /></g>
              </svg>
              <span className="bsummary">{t('board.region')}</span>
            </>
          )}
          {on.map((x) => (
            <span key={x} className="bfc" data-on>
              {x}
            </span>
          ))}
          <SearchField t={t} value={query} onChange={setQuery} />
          <span className="bmsg" role="alert" title={error ?? message}>
            {error ? t('board.keptLast', { error: lineError(t, error) }) : message}
          </span>
          {pencil}
        </div>
        {panel || (shown && <ListView t={t} columns={shown.columns} lanes={lanes} sessions={sessions} onOpen={open} onKey={onKey} />)}
        <div className="bepfoot">{t('board.view.saved', { view: [...on, t('board.density.list'), view.lane === 'none' ? t('board.view.noLanes') : t('board.view.lanes', { key: t(`board.lane.by.${view.lane}`) })].join(' · ') })}</div>
        {editor && shown && <CardEditor t={t} card={editor.card} columns={shown.columns} column={editor.column} sessions={sessions} onSave={save(editor.card)} onDelete={() => remove(editor.card!)} onClose={() => setEditor(null)} />}
      </section>
    );
  }
  return (
    <section
      ref={root}
      className="board"
      aria-label={t('board.region')}
      data-held={held ? 'true' : 'false'}
      data-zone={viewZone}
      data-mode={watching ? MODES[0] : MODES[1]}
      {...handlers}
    >
      <div className="ph bhead">
        <span className="bsummary">{t('board.region')} <span className="dim">· {cardCount(t, drawn)}</span></span>
        <SearchField t={t} value={query} onChange={setQuery} />
        <ProjectSelect t={t} projects={projects} value={prefs.project} onChange={(project) => setPrefs({ ...prefs, project })} />
        <span className="bnew" role="status">
          {fresh > 0 ? t('board.fresh', { n: fresh }) : ''}
        </span>
        <span className="bmsg" role="alert" title={error ?? message}>
          {error ? t('board.keptLast', { error: lineError(t, error) }) : message}
        </span>
        {!watching && <ColourKey t={t} />}
        {!watching && coord && <Coordinator t={t} coord={coord} open={cli} onToggle={() => setCli(!cli)} cli={cliId} onOpen={onOpen} />}
        <button className="btn" onClick={addCard} disabled={!shown}>
          {t('board.addCard')}
        </button>
        {!watching && (
          <button className="btn" onClick={() => setColumnsOpen(true)} disabled={!shown}>
            {t('board.columns')}
          </button>
        )}
        <ViewOptions t={t} mode={view.mode} lanes={view.watchLanes} showIdle={view.showIdle} filters={view.filters} onMode={(mode) => (setDetail(null), setView({ ...view, mode }))} onLanes={(watchLanes) => setView({ ...view, watchLanes })} onIdle={(showIdle) => setView({ ...view, showIdle })} onFilters={(filters) => setView({ ...view, filters })} />
        {!watching && pencil}
      </div>
      {!watching && coord && cli && <CliLine t={t} id={cliId} />}
      {!watching && <Strip t={t} first={shown?.columns[0] ? columnTitle(t, shown.columns[0]) : ''} threshold={threshold} lane={view.lane} filters={view.filters} roles={roles} onLane={(lane) => setView({ ...view, lane })} onFilters={(filters) => setView({ ...view, filters })} onAddCard={addCard} />}
      <div className="bsplit">
      {watching && shown && (
        <WatchGrid
          t={t}
          buckets={watchBuckets}
          lanes={watchLanes}
          counts={watchCounts}
          bucketOf={bucketFor}
          cell={(card, bucket) => {
            const session = sessions.find((s) => s.id === card.session_id);
            return (
              <WatchCard
                t={t}
                core={core}
                card={card}
                session={session}
                bucket={bucket}
                open={detail === keyOf(card)}
                ctx={ctx}
                showProject={view.watchLanes === 'none' || watchLanes.length < 2 || watchLanes[0]?.kind === 'all'}
                onOpen={() => open(card)}
                onKeyDown={(e) => {
                  if (composing(e.nativeEvent) || e.altKey || e.metaKey || e.ctrlKey) return;
                  if (e.code === 'Enter' || e.code === 'Space') (e.preventDefault(), open(card));
                }}
              />
            );
          }}
        />
      )}
      {watching && detailCard && shown && (
        <WatchDetail
          key={keyOf(detailCard)}
          t={t}
          core={core}
          card={detailCard}
          session={sessions.find((s) => s.id === detailCard.session_id)}
          sessions={sessions}
          bucket={bucketFor(detailCard)}
          now={now}
          onClose={closeDetail}
          onOpenSession={onOpen}
          onEdit={detailCard.source === 'manual' ? () => setEditor({ card: detailCard, column: detailCard.column }) : undefined}
        />
      )}
      {!watching && shown && (
        <LaneGrid
          t={t}
          columns={shown.columns}
          lanes={lanes}
          counts={counts}
          onAdd={(column) => setEditor({ card: null, column })}
          cell={(card, col, lane) => {
            return <CardView t={t} core={core} card={card} column={col} projectLane={lane?.kind === 'project' || lane?.kind === 'fallback'} ctx={ctx} session={sessions.find((s) => s.id === card.session_id)} done={col.states.includes('done')} dragging={drag.key === keyOf(card)} onClick={() => !drag.consumeClick() && open(card)} onKeyDown={(e) => onKey(e, card, col)} onPointerDown={(e) => movable(card) && drag.start(e, card)} />;
          }}
        />
      )}
      {!watching && panel}
      </div>
      {idleHidden > 0 && <div className="bepfoot">{t('board.watch.idleHidden', { n: idleHidden })}</div>}
      {drag.layer}
      {editor && shown && (
        <CardEditor
          t={t}
          card={editor.card}
          columns={shown.columns}
          column={editor.column}
          sessions={sessions}
          onSave={save(editor.card)}
          onDelete={() => remove(editor.card!)}
          onClose={() => setEditor(null)}
        />
      )}
      {!watching && columnsOpen && shown && <ColumnEditor t={t} columns={shown.columns} onPut={putColumns} onClose={() => setColumnsOpen(false)} />}
    </section>
  );
}

/** N10 (look 1117): a card of an ended side chat is not on the Board. */
const gone = (s: Session | undefined) => !!s && sideChatGone(s);
