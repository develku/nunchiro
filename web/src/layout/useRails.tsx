// Layout: the icon bars, sidebars and folds (split out of App.tsx, needs 183).
import { roomOfTab } from '../room/room';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type Dispatch, type SetStateAction } from 'react';
import { isOpen as paneOpen, show as paneShow, showYou, tabOf as paneTabOf, toggle as paneToggle, usePane } from '../pane/store';
import { BrowserSpaces } from '../pane/browser/view/BrowserView';
import { YOU_SPACE } from '../pane/browser/view/spaces';
import { add as addSplit } from '../split/store';
import { forgetView } from '../board/views';
import type { Key, T } from '../i18n';
import { measureDom, type DragSource, type Landing } from './DragLayer';
import { BAR_W, compactOf, drop as dropOnBar, freeSlot, HISTORY, icons as barIcons, maxWidth, PSEUDO, refuses, SIDEBAR_MIN, SIDEBAR_STEP, SIDEBAR_W, slotOf, toggleBarsAuto, where, withTree, without, WIDGET_LABEL, type Bars, type Side } from './bars';
import { IconBar, type IconInfo } from './IconBar';
import { Sidebar } from './Sidebars';
import { useArrange } from './useArrange';
import { DOCKS, useFold } from './fold';
import { apply, find, kindOf, leaves, TITLE, type Dir, type Kind, type Layout, type Node, type Op } from './model';
import { renderWidget, type WindowCtx } from './windows';
import { useNest } from './nest';
import { count, LayoutStore } from './store';
import type { Decision, Session } from '../types';
import type { CoreClient } from '../api';
import { openDiff } from '../diff/Diff';
import type { OverlayKind } from '../chrome/Overlay';
import { hasBoard } from '../board/useBoardRail';
import type { Settings } from '../settings';
import { docT, tipError } from '../errors';
import { leadOf, placeOf, roomOfPlace, useTeam } from '../lead/lead'; // ticket 990 (owner 11-17)
import { focusTeam, showTeamTab, useTeamAt } from '../lead/team';
import { teamWaiting } from '../tree/decisions';
import { TeamView } from '../lead/TeamView';
import { onOpenSchedules, showSchedTab, useSchedAt, useSchedulesFeed } from '../schedule/schedules'; // ticket 993
import { openBrowserTab, useBrowserTab } from '../pane/browser/view/centreTab'; // ticket 997 L1
import { SchedulesView } from '../schedule/SchedulesView';
import { onOpenHistory, showHistTab, useHistAt } from '../history/history'; // ticket 1022
import { HistoryView } from '../history/HistoryView';

// The CLI's reply (useCoreLink, `nunchiro layout`) stays English; the window shows t('leftovers.signalsLeft') (ticket 528).
export const SIGNALS_LEFT = 'only signals remain: tree rows, AGENTS dots, tab dots and the menu bar count';

/** True when `op` would take the last answer strip out of the layout (needs 26, 31: say so first). */
export function removesStrip(l: Layout, op: Op) {
  try {
    return count(l, 'waiting') > 0 && op.op !== 'undo' && count(apply(l, op), 'waiting') === 0;
  } catch {
    return false;
  }
}

const TIP_KEY: Record<string, Key> = Object.fromEntries(['tree', 'diff', 'terminal', 'artifacts'].map((k) => [k, `shell.tip.${k}` as Key]));

type Set<T> = Dispatch<SetStateAction<T>>;
type FoldDeps = { layout: Layout; editing: boolean; settings: Settings; active: string | null; bars: Bars };
type Deps = {
  store: LayoutStore;
  layout: Layout;
  editing: boolean;
  bars: Bars;
  layoutSeen: boolean;
  setSettings: Set<Settings>;
  open: (id: string) => void;
  finish: () => Promise<void>;
  arrange: ReturnType<typeof useArrange>;
  runOp: (op: Op, confirmed?: boolean) => Promise<void>;
  paneSession: Session | null;
  paneState: ReturnType<typeof usePane>;
  showWidget: (w: string, toggleIt?: boolean) => void;
  fold: ReturnType<typeof useFold>;
  foldOf: (w: string) => string | undefined;
  toggleBoard: () => void;
  showDecisions: { current: () => void };
  t: T;
  /** v25f: Settings or the Board open in the modal over the workspace. */
  overlay: OverlayKind;
  toggleSettings: () => void;
  current: Session | null;
  nest: ReturnType<typeof useNest>;
  windowCtx: () => WindowCtx;
  /** Ticket 990 (owner 11-17): for the Team icon and view (windowCtx is not built yet while this hook runs). */
  core: CoreClient;
  sessions: Session[];
  /** Inventory N012: `sessions` as Decisions lists them (tree/decisions.ts `withoutFront`); the Team icon and view count these. */
  deciding: Session[];
  filesSession: Session | null;
  /** The project the centre shows (its tab strip), when no session is in front. */
  project?: string | null;
  owner: Decision[];
  /** The active tab: a Team tab (a room tab) names its place when no session is in front (look 1117 v4 N6). */
  active?: string | null;
  /** Widgets with something waiting inside (a pending decision): their icon gets a dot. */
  waiting: (w: string) => boolean;
};

/** v1a-60: side panels fold to their icon bar while the main zone is under MAIN_MIN_COLS columns; a panel's icon and
 *  command show a folded one again. */
export function useRailFold({ layout, editing, settings, active, bars }: FoldDeps) {
  // v1a-60: side panels fold to their icon bar while the main zone is under MAIN_MIN_COLS columns (view state).
  const bodyRef = useRef<HTMLDivElement>(null);
  const fold = useFold(bodyRef, layout, editing, { size: settings.termFontSize, family: settings.termFont }, active, hasBoard);
  /** The folded node that `has` picks out, or undefined. */
  const foldedNode = (has: (n: Node) => boolean) =>
    fold.folded.find((k) => {
      const n = find(layout.root, k);
      return !!n && has(n);
    });
  const foldKey = {
    board: foldedNode(hasBoard),
    left: fold.folded.find((k) => k === DOCKS.left),
    right: fold.folded.find((k) => k === DOCKS.right),
  };
  /** The names a fold shows: a zone of several widgets gives each one (485: the status bar joins them in the window language). */
  const foldName = (k: string): string[] => {
    if (k === DOCKS.left || k === DOCKS.right) return [WIDGET_LABEL(bars.active[k === DOCKS.left ? 'left' : 'right'] ?? '')];
    const n = find(layout.root, k);
    return n ? [...new Set(leaves(n).map((z) => TITLE[kindOf(z.widgets[z.active ?? 0])]))] : [k];
  };
  // A sidebar's widget changing is the user's newest panel: it opens unfolded (before paint), whatever path opened it.
  // Only the side whose widget changed: the other side's fold stays (real-app 11-10 defect 2: Diff to Decisions unfolded the Tree).
  const openKey = `${bars.active.left}|${bars.active.right}`;
  const opened = useRef(bars.active);
  useLayoutEffect(() => {
    const was = opened.current;
    opened.current = bars.active;
    for (const sd of ['left', 'right'] as const) if (bars.active[sd] && bars.active[sd] !== was[sd] && foldKey[sd]) fold.unfold(foldKey[sd]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openKey]);
  /** The folded sidebar key of the bar widget that is open on its side (V1A-60), if any. */
  const foldOf = (w: string) => {
    if (kindOf(w) === 'board' && !Object.values(bars.active).includes(w)) return foldKey.board; // the board is a zone (centre tab or edge), folded like one; V2.5-38: in a sidebar, that side's fold
    const sd = where(bars, w);
    return sd && bars.active[sd] === w ? foldKey[sd] : undefined;
  };
  return { bodyRef, fold, foldKey, foldName, foldOf };
}

/** The icon bars and sidebars (LAYOUT D5b): one Tree (needs 157 (2)), a bar icon's click, the arrangement steps of the
 *  trail, the drag and the peek split, and each side's sidebar. */
export function useRails({ store, layout, editing, bars, layoutSeen, setSettings, open, finish, arrange, runOp, paneSession, paneState, showWidget, fold, foldOf, toggleBoard, showDecisions, t, overlay, toggleSettings, current, nest, windowCtx, waiting, core, sessions, deciding, filesSession, owner, active, project }: Deps) {
  const [drag, setDrag] = useState<DragSource | null>(null);
  const [peek, setPeek] = useState<string | null>(null); // PEEKSPLIT: the bar icon dragged outside edit mode
  // Ticket 990 (owner 11-17): the Team view of the focused place's lead. Its icon is not kept in the arrangement: it joins the right
  // bar's first free slot while the place has a lead (never in Layout edit), and the view covers that side's sidebar while open.
  const teamList = useTeam(core, true);
  const teamOf = current ?? filesSession;
  // N6 (look 1117 v4): with the Team tab in front no session is current; the tab names its place (after a relaunch too).
  const tabRoom = roomOfTab(active ?? null);
  // Eighth look (Home S3): after a relaunch a view tab (Schedules) was in front and no session was current, so the bar
  // had no Team icon and Home's "Needs you" could not be reached while the lead was "resumable". With no session the
  // place is the shown project's; when that has no lead, the Home lead's view (it is about every place). The lead is
  // the teammate, running or not.
  // Look 1117 v13 (A NEW-S3-D, Home S3-3): one rule for the icon and the view: the place here when it has a lead, else
  // the Home lead's. A session's place without a lead hid the icon although Home had one.
  const shownPlace = project == null ? null : project === teamList.home ? '' : project;
  const here = (tabRoom !== null ? (tabRoom === teamList.home ? '' : tabRoom) : teamOf ? placeOf(teamOf, teamList) : null) ?? shownPlace;
  const teamPlace = here !== null && leadOf(teamList, here) ? here : leadOf(teamList, '') ? '' : null;
  const teamLead = teamPlace === null ? null : leadOf(teamList, teamPlace);
  const teamFolder = teamLead ? roomOfPlace(teamPlace!, teamList) : null;
  const [teamAt, putTeam] = useTeamAt(teamLead ? teamPlace : null);
  const teamNeeds = teamWaiting(deciding, owner, teamFolder, teamPlace === ''); // q67 look (new 2): the one shared count, for this place
  const teamSide = !!teamLead && !teamAt.tab && !!teamAt.open && !editing;
  const teamIcon = !!teamLead && !editing;
  // Ticket 993: the Schedules widget, as the Team view: its icon joins the right bar's next free slot (after Team; never in
  // Layout edit), and it covers that side's sidebar while open there. One of the two at a time: the one opened last stays.
  const schedules = useSchedulesFeed(core);
  const schedFailed = !!schedules?.some((x) => x.last?.result === 'failed');
  const [schedAt, putSched] = useSchedAt();
  const [browserTab] = useBrowserTab(); // ticket 997 L1
  const schedSide = !schedAt.tab && !!schedAt.open && !editing;
  useEffect(() => onOpenSchedules(() => (schedAt.tab ? showSchedTab() : putSched({ open: true }))), [schedAt.tab, putSched]);
  // Ticket 1022: the History widget, the same way. Ticket 1073: its icon is placed on a bar (bars.ts HISTORY), not added here.
  const [histAt, putHist] = useHistAt();
  const histSide = !histAt.tab && !!histAt.open && !editing;
  useEffect(() => onOpenHistory(() => (histAt.tab ? showHistTab() : putHist({ open: true }))), [histAt.tab, putHist]);
  const overSide = teamSide || schedSide || histSide;
  const closeOver = () => (teamSide && putTeam({ open: false }), schedSide && putSched({ open: false }), histSide && putHist({ open: false }));
  const overWas = useRef({ team: teamSide, sched: schedSide, hist: histSide });
  useEffect(() => {
    // One of them at a time: the one opened last stays (two open at load: the later in this order).
    const was = overWas.current;
    const now = { team: teamSide, sched: schedSide, hist: histSide };
    overWas.current = now;
    const on = (['team', 'sched', 'hist'] as const).filter((k) => now[k]);
    if (on.length < 2) return;
    const keep = on.find((k) => !was[k]) ?? on.at(-1);
    for (const k of on) if (k !== keep) ({ team: putTeam, sched: putSched, hist: putHist })[k]({ open: false });
  }, [teamSide, schedSide, histSide]); // eslint-disable-line react-hooks/exhaustive-deps
  const rightSlots = (() => {
    const add = [...(teamIcon ? ['team'] : []), ...(editing ? [] : ['schedules'])];
    return bars.right.map((w, i) => (w === null && i < bars.right.length - 1 && add.length ? add.shift()! : w));
  })();
  // needs 157 (2): the Tree is in one place, on a bar or in a zone. A tree zone wins over the bar icon (a move, never a
  // copy); a hand-edited layout.toml with more keeps the first and says so; with none anywhere it is back on the Left bar.
  const [moved1, setMoved1] = useState('');
  const zoneTrees = count(layout, 'tree');
  const treeOnBar = !!where(bars, 'tree');
  useEffect(() => {
    if (!layoutSeen) return;
    setSettings((s) => {
      const onBar = !!where(s.bars, 'tree');
      if (zoneTrees > 0 && onBar) return { ...s, bars: without(s.bars, 'tree') };
      return zoneTrees === 0 && !onBar ? { ...s, bars: withTree(s.bars) } : s;
    });
  }, [layoutSeen, zoneTrees, treeOnBar]);
  useEffect(() => {
    const extra = leaves(store.saved.root).flatMap((z) => z.widgets.flatMap((w, i) => (kindOf(w) === 'tree' ? [{ op: 'remove' as const, zone: z.id, tab: i + 1 }] : []))).slice(1);
    if (store.fileError || store.editing || !extra.length) return;
    // Pure first, then one write: a write per removal would re-run this effect mid-way. Last first, so the zones and
    // tabs named before each removal stay where they are.
    const n = extra.length;
    try {
      const one = extra.reverse().reduce((l, op) => apply(l, op), store.saved);
      store.set(one, 'one Tree').then(
        () => setMoved1(docT()('own.layout.trees', { n: n + 1, removed: n })),
        (e: Error) => setMoved1(docT()('err.layoutTrees', { n: n + 1, error: tipError(docT(), e) })),
      );
    } catch (e) {
      setMoved1(docT()('err.layoutTrees', { n: n + 1, error: tipError(docT(), e) }));
    }
  }, [store, store.saved, store.fileError, store.editing]);
  // Ticket 288: the user's own Browser gives way to an agent session's pane (its Browser tab has the same switcher) and to any
  // widget opened on a bar.
  const youWas = paneState.you;
  useEffect(() => {
    if (youWas && paneSession) showYou(false);
  }, [youWas, paneSession?.id]);
  const barsOpen = `${bars.active.left}|${bars.active.right}`;
  useEffect(() => showYou(false), [barsOpen]);
  // Another widget opened on the right closes the Team view there (one sidebar widget at a time); the first run is the load.
  const barsWas = useRef(barsOpen);
  useEffect(() => {
    if (barsWas.current !== barsOpen && overSide && bars.active.right) closeOver();
    barsWas.current = barsOpen;
  }, [barsOpen]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => void (overSide && showYou(false)), [overSide]);
  useEffect(() => void (paneState.you && overSide && closeOver()), [paneState.you]); // eslint-disable-line react-hooks/exhaustive-deps
  // Real-app 11-10 defect 17: Terminal is lit for the PTY or a shell in the pane, not for Browser or Preview there.
  const paneTab = paneSession && paneOpen(paneState, paneSession.id) ? paneTabOf(paneState, paneSession.id) : null;
  // Ticket 352: with no agent session the user's own browser is drawn in its bar's sidebar, over the widget open there. That
  // widget is not lit while it is covered, and its icon brings it back (it used to close the sidebar and the browser with it).
  const youSide = paneState.you && !paneSession ? where(bars, 'browser') : null;
  const pressed = (w: string) => (w === 'team' ? teamSide : w === 'schedules' ? schedSide : w === 'history' ? histSide : kindOf(w) === 'terminal' ? !!paneTab && (typeof paneTab !== 'string' || paneTab === 'pty') : w === 'browser' ? paneState.you || paneTab === 'browser' : kindOf(w) === 'board' ? overlay === 'board' || count(layout, 'board') > 0 || Object.values(bars.active).includes(w) : (() => { const sd = where(bars, w); return !!sd && bars.active[sd] === w && sd !== youSide; })());
  /** Ticket 288 item 2 (needs 213): the Terminal icon with no session focused opens a shell in the project the window shows
   *  (the last session's; with none at all, in $HOME: the core fills an empty project for a shell, v25f F14 — never the New tab
   *  popover). The started session opens as a tab. Real-app 11-10 defect M: an ended session focused is never restarted from
   *  here (a resume replaced its tab); its tab's Restart / Resume stay the way to start it. Ticket 1037: the press still opens
   *  a new shell in its project (it said "has ended" and opened nothing: after an app restart every session is resumable). */
  const starting = useRef(false); // a second click while the first start is in flight starts nothing more
  const startTerminal = () => {
    if (starting.current) return;
    const c = windowCtx();
    const request = { kind: 'shell' as const, project: c.filesSession?.project ?? '', resume: null };
    starting.current = true;
    c.core
      .request({ op: 'start', session: request })
      .then(
        (r) => (r as { session?: Session }).session && open((r as { session: Session }).session.id),
        (e) => arrange.notify(t('exitWidgets.notStarted', { error: tipError(t, e) })),
      )
      .finally(() => (starting.current = false));
  };
  // Ticket 1020: a press on the modal's shade closes Settings (chrome/Overlay.tsx) before the click lands on the icon under it.
  const pressInSettings = useRef(false);
  useEffect(() => {
    const press = () => (pressInSettings.current = overlay === 'settings');
    window.addEventListener('pointerdown', press, true);
    return () => window.removeEventListener('pointerdown', press, true);
  }, [overlay]);
  /** A bar icon's click (A02, A03, A04): open that widget in its sidebar, collapse it when it is the open one; Settings and Board open the modal (v25f). */
  const iconClick = (w: string) => {
    if (w === 'settings') return toggleSettings();
    if (w === 'layout') return editing ? void finish() : arrange.begin();
    // Ticket 1020, as VS Code's activity bar: a widget behind the Settings modal comes to the front on its icon's click,
    // and only a click while it is in front hides it.
    if (overlay === 'settings' || pressInSettings.current) {
      pressInSettings.current = false;
      if (overlay === 'settings') toggleSettings();
      if (pressed(w)) return;
    }
    if (w === 'team') return teamAt.tab ? showTeamTab(teamFolder!) : teamSide ? putTeam({ open: false }) : (putTeam({ open: true }), focusTeam());
    if (w === 'schedules') return schedAt.tab ? showSchedTab() : schedSide ? putSched({ open: false }) : (putSched({ open: true }), requestAnimationFrame(() => document.querySelector<HTMLElement>('.schedv button')?.focus()));
    if (w === 'history') return histAt.tab ? showHistTab() : histSide ? putHist({ open: false }) : (putHist({ open: true }), requestAnimationFrame(() => document.querySelector<HTMLElement>('.histv-q input')?.focus()));
    // rc2b-fb (coordinator item 10, needs 172: never a silent click): with no live agent session the icon says why.
    // rc2b-fb3 item 5: the side pane lives in the terminal widget; a zone showing another tab (Board) hid it, so the
    // icons first bring the session's terminal to the front (open bumps LayoutView's reveal). A hidden pane counts as closed.
    // v25-shell-chrome (ticket 284 item 4): the pane has no tab strip, so the Terminal icon is also the way back to the PTY from Browser or Preview.
    if (kindOf(w) === 'terminal') return void (paneSession ? (document.querySelector('.spane')?.checkVisibility() ? (paneTabOf(paneState, paneSession.id) === 'pty' ? paneToggle(paneSession.id) : paneShow(paneSession.id, 'pty')) : (open(paneSession.id), paneShow(paneSession.id, 'pty'))) : current?.state === 'running' ? (open(current.id), arrange.notify(t('shell.terminalIcon.inCentre'))) : startTerminal());
    if (w === 'browser') return void (paneSession ? (showYou(false), document.querySelector('.spane')?.checkVisibility() && paneTab === 'browser' ? paneToggle(paneSession.id) : (open(paneSession.id), paneShow(paneSession.id, 'browser'))) : browserTab ? openBrowserTab() : showYou(!paneState.you)); // v25 placement item 4; ticket 997 L1: while My browser is a centre tab the icon brings that tab (one place per space); ticket 288: with no agent session it is the user's own browser; defect 17: a second press closes it, as Terminal's does
    const key = foldOf(w);
    if (key) return fold.unfold(key); // a Board zone the user placed and the fold hid comes back first
    // V2.5-38: a board placed in its bar's sidebar collapses there like any bar widget; otherwise the Board modal (v25f).
    if (kindOf(w) === 'board' && !Object.values(bars.active).includes(w)) return toggleBoard();
    const sd = where(bars, w);
    if (sd === 'right' && overSide && bars.active.right === w) return closeOver(); // it was under the Team view (or Schedules)
    if (kindOf(w) === 'diff' && sd && bars.active[sd] !== w) return openDiff();
    if (sd && sd === youSide && bars.active[sd] === w) return showYou(false);
    const opening = !pressed(w);
    showWidget(w, true);
    // rc2b-fb (coordinator item 8): the Search icon opens the panel with its field focused, as the palette's Search does.
    if (kindOf(w) === 'search' && opening) requestAnimationFrame(() => requestAnimationFrame(() => document.querySelector<HTMLInputElement>('.spanel .sscope:not([hidden]) input[type="search"]')?.focus()));
  };
  /** The commands of a widget open it (never collapse it), unfolding a folded sidebar. */
  const openCmd = (w: string, toggleIt = false) => () => {
    const key = foldOf(w);
    if (key) return fold.unfold(key);
    if (where(bars, w) === 'right' && overSide && bars.active.right === w) closeOver(); // look v10 N10-S2-1: it was under the Team view (or Schedules), as iconClick
    showWidget(w, toggleIt);
  };
  showDecisions.current = openCmd('decisions');
  const barTip = (w: string) => (TIP_KEY[w] ? t(TIP_KEY[w]) : WIDGET_LABEL(w));
  // LAYOUT D5b: arrangement changes. Every one is a step of the trail (undo toast, ⌘Z); the rules (the tree
  // stays, terminal / composer / answer strip stay in the main area) refuse with a reason.
  const moveIcon = (w: string, side: Side, index: number, zone?: Op) => {
    const reason = refuses(w, 'bar', t);
    if (reason) return arrange.notify(reason);
    // A widget lives in one place: one in a zone leaves it for the bar.
    const op: Op | undefined = zone ?? (!where(bars, w) && kindOf(w) !== 'terminal' && count(layout, kindOf(w) as Kind) > 0 ? { op: 'remove', kind: kindOf(w) as Kind } : undefined);
    const next = dropOnBar(bars, w, side, index);
    if (!next) return arrange.notify('No free slot: remove an icon or move one first');
    void arrange.commit(`${WIDGET_LABEL(w)} moved to the ${side} bar`, { bars: next, zone: op && (() => store.run(op, measureDom)) });
  };
  const removeIcon = (w: string) => {
    const reason = refuses(w, 'remove', t);
    if (reason) return arrange.notify(reason);
    const sd = where(bars, w);
    if (kindOf(w) === 'board' && sd) forgetView(sd); // V2.5-38: placed again, it starts from the bar's default view
    void arrange.commit(`${WIDGET_LABEL(w)} removed from its bar`, { bars: without(bars, w) });
  };
  const otherBar = (w: string) => {
    const sd = where(bars, w);
    if (!sd) return showWidget(w);
    const to: Side = sd === 'left' ? 'right' : 'left';
    // The same slot on the other bar (an occupied one swaps), else its first free one.
    const at = bars[to][slotOf(bars, w)!.index] === null ? slotOf(bars, w)!.index : (freeSlot(bars, to)?.index ?? slotOf(bars, w)!.index);
    moveIcon(w, to, at);
  };
  const lastOpen = useRef<Record<Side, string | null>>({ left: 'tree', right: null });
  useEffect(() => void (['left', 'right'] as Side[]).forEach((sd) => bars.active[sd] && (lastOpen.current[sd] = bars.active[sd])), [bars]);
  // One place hides and shows a side, whatever the route (the bar's button, the palette command, its key). Owner 11-21
  // (lane w43-tree; replaces real-app 11-10 defect J's "hide the folded side, show it folded again"): a side V1A-60 folded
  // away for a narrow window draws nothing, so its button reads "Show" and a press unfolds it, as its icon does. At
  // 1000 px the button did nothing one could see, twice.
  /** The fold key of a side whose sidebar is open but folded away, if any. */
  const foldedSide = (sd: Side) => (bars.active[sd] ? foldOf(bars.active[sd]) : undefined);
  // Ticket 399: a notice about one session (it has ended) never sits over another one.
  const toastSession = arrange.toast?.session;
  useLayoutEffect(() => void (toastSession && toastSession !== current?.id && arrange.dismiss()), [toastSession, current?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggleSide = (sd: Side) => {
    if (sd === 'right' && overSide) {
      closeOver();
      if (!bars.active.right) return;
    }
    const key = foldedSide(sd);
    if (key && !(sd === 'right' && overSide)) return fold.unfold(key); // an over view (Team, Schedules, History) shows: Hide hides
    setSettings((st) => {
      const was = lastOpen.current[sd];
      const next = st.bars.active[sd] ? null : was && st.bars[sd].includes(was) ? was : (barIcons(st.bars, sd).find((w) => kindOf(w) !== 'board' && !PSEUDO.includes(w) && w !== HISTORY) ?? null);
      return { ...st, bars: { ...st.bars, active: { ...st.bars.active, [sd]: next } } };
    });
  };
  // v25-shell-chrome (ticket 283): the Sidebar widths and (ticket 1052) the Icon bar width live in the arrangement (`Bars.sidebarW`, `barW`), so
  // every layout keeps its own; changing them is not an arrangement step (no undo trail, no dirty mark). Ticket 997 L2 (rule A7):
  // each widget its own (`Bars.widgetW`); the side's older `sidebarW` is the width of a widget not resized since.
  /** The widget a side's sidebar shows (the order `sidebar` draws them in), or null. */
  const shownOn = (sd: Side, b = bars): string | null =>
    sd === 'right' && teamSide ? 'team' : sd === 'right' && schedSide ? 'schedules' : sd === 'right' && histSide ? 'history' : paneState.you && where(b, 'browser') === sd && !paneSession ? 'browser' : b.active[sd];
  const widthOf = (sd: Side, b = bars) => b.widgetW?.[shownOn(sd, b) ?? ''] ?? b.sidebarW?.[sd] ?? SIDEBAR_W;
  /** The width the other side's sidebar asks for, 0 when it is closed (the user's own Browser, ticket 288, counts as open). */
  const otherW = (sd: Side, b = bars) => {
    const o: Side = sd === 'left' ? 'right' : 'left';
    // Real-app 11-10: a side V1A-60 folded draws nothing, so it takes no room (it is still active).
    return (b.active[o] && !fold.folded.includes(DOCKS[o])) || (o === 'right' && overSide) || (paneState.you && where(b, 'browser') === o && !paneSession) ? Math.min(widthOf(o, b), maxWidth(window.innerWidth)) : 0;
  };
  const sidebarW = (sd: Side, b = bars) => Math.min(widthOf(sd, b), maxWidth(window.innerWidth, otherW(sd, b)));
  /** `b` with the widget shown on side `sd` at width `w` (null: the default back); `b` as it is when that side shows none. */
  const withWidth = (b: Bars, sd: Side, w: number | null): Bars => {
    const id = shownOn(sd, b);
    if (!id) return b;
    // null stores the default, not a missing key: a missing key would fall back to the side's older width.
    const v = w === null ? SIDEBAR_W : Math.round(Math.min(maxWidth(window.innerWidth, otherW(sd, b)), Math.max(SIDEBAR_MIN, w)));
    return { ...b, widgetW: { ...b.widgetW, [id]: v } };
  };
  const setSidebarW = (sd: Side) => (w: number | null) => setSettings((st) => ({ ...st, bars: withWidth(st.bars, sd, w) }));
  /** The palette's Sidebars wider / narrower: the widget shown on each side one step. */
  const stepSidebarW = (dir: 1 | -1) =>
    setSettings((st) => ({ ...st, bars: (['left', 'right'] as Side[]).reduce((b, sd) => withWidth(b, sd, sidebarW(sd, st.bars) + dir * SIDEBAR_STEP), st.bars) }));
  /** The default width is stored as absent, so a bar dragged back to it is today's bar again. */
  const setBarW = (w: number | null) =>
    setSettings((st) => {
      const { barW: _old, ...rest } = st.bars;
      return { ...st, bars: w === null || w <= BAR_W ? rest : { ...rest, barW: w } };
    });
  /** A drag under the minimum closes the side; it reopens at the width it had before the drag. */
  const closeSide = (sd: Side, restore: number) =>
    setSettings((st) => ({ ...st, bars: { ...withWidth(st.bars, sd, restore), active: { ...st.bars.active, [sd]: null } } }));
  /** A drag released: on a bar, the remove area, a main zone, or somewhere it is refused. */
  const land = (l: Landing, src: DragSource) => {
    const w = src.widget;
    if (l.type === 'nest' || l.type === 'picker') return nest.land(w, l); // layout-b
    if (l.type === 'refuse') return arrange.notify(l.reason);
    if (l.type === 'bar') return moveIcon(w, l.side, l.index, 'from' in src ? { op: 'remove', zone: src.from, tab: src.tab + 1 } : undefined);
    if (l.type === 'remove') return removeIcon(w);
    if (l.error) return arrange.notify(l.error);
    // A widget lives in one place: a bar widget placed in the main area leaves its bar in the same step.
    if (kindOf(w) === 'board' && where(bars, w)) forgetView(where(bars, w)!); // V2.5-38: it leaves its bar
    if (where(bars, w) && !('from' in src)) void arrange.commit(`${WIDGET_LABEL(w)} moved to the main area`, { zone: () => store.run(l.op, measureDom), bars: without(bars, w) });
    else void runOp(l.op);
  };
  const iconKey = (e: ReactKeyboardEvent, w: string) => {
    const sd = where(bars, w);
    if (!sd) return;
    const i = slotOf(bars, w)!.index;
    const refocus = () => setTimeout(() => document.querySelector<HTMLElement>(`[data-icon="${CSS.escape(w)}"] .ai`)?.focus(), 50);
    if (e.altKey && e.key.startsWith('Arrow')) {
      e.preventDefault();
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        const j = i + (e.key === 'ArrowUp' ? -1 : 1);
        if (j < 0 || j >= bars[sd].length) return;
        moveIcon(w, sd, j); // the next slot: an empty one takes it, an occupied one swaps
      } else {
        const to: Side = e.key === 'ArrowLeft' ? 'left' : 'right';
        if (to === sd) return;
        moveIcon(w, to, i); // the same slot of the other bar (an occupied one swaps)
      }
      refocus();
    } else if (e.key === 'Delete') {
      e.preventDefault();
      removeIcon(w);
    }
  };
  // rc2b-fb (needs 104/106: Settings is a wide centre view): while it is open, a composer zone has no session to write to; one
  // dragged to a size kept that band empty under Settings, so it steps aside until Settings closes (Layout edit shows it).
  const hidden = (n: Node) => fold.folded.includes(n.id);
  const grab = (source: DragSource) => (e: { button: number; preventDefault: () => void }) => {
    if (e.button !== 0) return;
    e.preventDefault();
    // PEEKSPLIT: outside edit mode a bar icon drags onto the session view as a split (bars move only in Layout, A09).
    if (!editing) return 'bar' in source ? setPeek(source.widget) : arrange.notify('Turn on Layout to move icons');
    setDrag(source);
  };
  const dropSplit = useCallback((side: Dir) => peek && current && void addSplit(current.id, side, peek), [peek, current]);
  const say = arrange.notify;
  const barHint = useCallback(() => say('Turn on Layout to move icons'), [say]);
  const endPeek = useCallback(() => setPeek(null), []);
  /** The open widget of a side, in its sidebar (V2.5-38: the Board too, once placed there; its view is the side's). */
  const sidebar = (sd: Side) => {
    if (sd === 'right' && teamSide)
      return (
        <Sidebar side={sd} widget="team" width={sidebarW(sd)} other={otherW(sd)} onWidth={setSidebarW(sd)} onClose={(restore) => (setSidebarW(sd)(restore), putTeam({ open: false }))} t={t}>
          <TeamView core={core} t={t} folder={teamFolder} sessions={deciding} open={open} wt={windowCtx().wt} owner={owner} decide={windowCtx().decide} where="side" />
        </Sidebar>
      );
    if (sd === 'right' && schedSide)
      return (
        <Sidebar side={sd} widget="schedules" width={sidebarW(sd)} other={otherW(sd)} onWidth={setSidebarW(sd)} onClose={(restore) => (setSidebarW(sd)(restore), putSched({ open: false }))} t={t}>
          <SchedulesView core={core} t={t} sessions={sessions} open={open} where="side" />
        </Sidebar>
      );
    if (sd === 'right' && histSide)
      return (
        <Sidebar side={sd} widget="history" width={sidebarW(sd)} other={otherW(sd)} onWidth={setSidebarW(sd)} onClose={(restore) => (setSidebarW(sd)(restore), putHist({ open: false }))} t={t}>
          <HistoryView core={core} t={t} sessions={sessions} open={open} where="side" settled={windowCtx().wt?.settled} places={windowCtx().wt?.list} projects={windowCtx().projects} />
        </Sidebar>
      );
    // Ticket 288: the user's own Browser takes the side of its icon until closed (or another widget opens there).
    if (paneState.you && where(bars, 'browser') === sd && !paneSession)
      return (
        <Sidebar side={sd} widget="browser" width={sidebarW(sd)} other={otherW(sd)} onWidth={setSidebarW(sd)} onClose={(restore) => (setSidebarW(sd)(restore), showYou(false))} t={t}>
          <BrowserSpaces initial={YOU_SPACE} sessions={windowCtx().sessions} insert={windowCtx().notes?.insert} to={windowCtx().notes?.name} t={t} />
        </Sidebar>
      );
    const w = bars.active[sd];
    if (!w || !bars[sd].includes(w)) return null;
    return (
      <Sidebar side={sd} widget={w} width={sidebarW(sd)} other={otherW(sd)} onWidth={setSidebarW(sd)} onClose={(restore) => closeSide(sd, restore)} t={t}>
        {renderWidget(w, true, windowCtx(), sd, () => closeSide(sd, sidebarW(sd)))}
      </Sidebar>
    );
  };
  const iconInfo = (w: string): IconInfo => {
    // Ticket 1041: the bar has no labels, so while editing Layout's tint and its name in the tooltip ("Editing layout · Done") say it.
    if (w === 'layout') return { pressed: editing, folded: false, name: editing ? t('shell.layout.editing') : WIDGET_LABEL('layout'), tip: editing ? t('shell.layout.editing') : t('shell.tip.layout') };
    if (w === 'settings') return { pressed: overlay === 'settings', folded: false, tip: WIDGET_LABEL('settings') };
    if (w === 'team') return { pressed: teamSide, folded: false, tip: t('lead.team.open'), injected: true, count: teamNeeds, countSay: t('lead.tasks.needs', { n: teamNeeds }) };
    if (w === 'schedules') return { pressed: schedSide, folded: false, tip: WIDGET_LABEL(w), injected: true, failed: schedFailed ? t('schedule.iconFailed') : undefined };
    if (w === 'history') return { pressed: histSide, folded: false, tip: WIDGET_LABEL(w) };
    return { pressed: pressed(w), folded: !!foldOf(w), tip: barTip(w), waiting: waiting(w) };
  };
  const iconBar = (sd: Side) => (
    <IconBar
      side={sd}
      slots={sd === 'right' ? rightSlots : bars[sd]}
      info={iconInfo}
      editing={editing}
      auto={bars.barsAuto === true && !editing /* ticket 1047: Layout edit needs the bars in place */}
      dragging={drag && 'bar' in drag ? drag.widget : null}
      onClick={iconClick}
      onRemove={removeIcon}
      onGrab={(w) => grab({ widget: w, bar: sd })({ button: 0, preventDefault: () => {} })}
      onKey={iconKey}
      width={bars.barW ?? BAR_W}
      compact={compactOf(bars.barW ?? BAR_W)}
      onWidth={setBarW}
      onAutoHide={sd === 'left' ? () => setSettings((st) => ({ ...st, bars: toggleBarsAuto(st.bars) })) : undefined /* ticket 1093: the Settings switch's setting */}
      autoOn={bars.barsAuto === true}
      sideOpen={(!!bars.active[sd] && !foldedSide(sd)) || (sd === 'right' && overSide)}
      t={t}
      onToggleSide={() => toggleSide(sd)}
    />
  );
  return { moved1, openCmd, moveIcon, removeIcon, otherBar, toggleSide, land, hidden, grab, drag, setDrag, peek, dropSplit, barHint, endPeek, sidebar, iconBar, stepSidebarW };
}
