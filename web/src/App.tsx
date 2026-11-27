// Window shell (spec Window (v1a), R8 final): left icon bar | left sidebar | centre | right icon bar.
import { lineError, OwnWords, rawError, type Note } from './errors';
import { PermissionSheet } from './approval/PermissionSheet';
import { usePluginCommands } from './plugins/commands';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { CoreClient, type Boot } from './api';
import { hasTranscript } from './chat/ChatView'; // v1b-03
import { bindCore } from './artifacts/host'; // v1b-06
import { select, setDock, useDock } from './artifacts/store'; // v1b-06; `dock` is the request "open Preview" (AGENTVIEW: the session's pane)
import { useAutoOpen } from './pane/auto';
import { show as paneShow, usePane } from './pane/store';
import { Overlay as SplitOverlay } from './split/Overlay';
import { add as addSplit, CHOOSER } from './split/store';
import { useBoardSeen } from './board/seen'; // v1b-16
import { Hints } from './Hints';
import { CopyMode } from './terminal/copymode';
import { plainText } from './terminal/save'; // v1a-68
import { label, merge, setLiveBindings, type Command } from './keys';
import { PrefixHelp } from './PrefixHelp'; // v1a-57
import { Palette } from './Palette';
import { QuickOpen } from './files/QuickOpen';
import { useRegistry } from './features/registry';
import { Tooltip } from './Tooltip'; // v1a-65
import { ContextMenu } from './menu/ContextMenu'; // V2-6a
import { useTheme } from './themes/apply';
import { MigrationToast } from './settings/migration/MigrationToast'; // needs 150
import { CoreKept } from './chrome/CoreKept'; // F24
import { CloseNotice, QuitDialog } from './settings/lifetime/QuitDialog';
import { CommandError, parse, tokenize } from './layout/command';
import { DragLayer, measureDom } from './layout/DragLayer';
import { EditStrip } from './layout/EditStrip';
import { drop as dropOnBar, freeSlot, open as openOnBar, toggle as toggleOnBar, where, type Side } from './layout/bars';
import { Icon } from './icons/Icon';
import { Library } from './layout/Library';
import { useArrange } from './layout/useArrange';
import { LayoutView, type WidgetCtx } from './layout/LayoutView';
import { find, isLeaf, kindOf, type Item, type Kind, type Op } from './layout/model';
import { renderWidget, type WindowCtx } from './layout/windows'; // v1b-28
/* layout-b */ import { useNest } from './layout/nest'; /* end layout-b */
import { count, LayoutStore } from './layout/store';
import { orderSessions, sessionName, Tree } from './Sidebar';
import { setNameScope } from './sessionNames';
import { buildTree, withNames, withoutClosedHeads } from './tree'; // V2-9a
import { alsoInDecisions, asks, hasCard, scopeToPlace, withMerges, withoutFront } from './tree/decisions';
import { ProjectDialogs } from './tree/Dialogs';
import { useWorktrees, WorktreeLayer } from './tree/worktrees'; // V2-8a
import { leadSeatMate, useTeam } from './lead/lead'; // ticket 990
import { LeaderDialog } from './lead/LeaderDialog'; // ticket 990
import { BotsView } from './bots/BotsView'; // ticket 1168
import { askNewBot, onOpenBots } from './bots/bots';
import { HandBot } from './bots/HandBot';
import { NewBot } from './bots/NewBot';
import { useProjectTree } from './tree/state';
import { useDiffStat } from './chrome/SessionFacts'; // CHROME
import { agentState, type BoardDecision, type Decision, type Session } from './types';
import { DecisionsWidget } from './decisions/DecisionsWidget'; // V2-8e
import { focusCard } from './chat/DecisionCard'; // ticket 1030
import { useTitleBar } from './chrome/useTitleBar';
import { answerOnce, withNote } from './queue/answer'; // V2-8e
import type { OnAnswer } from './tree/DecisionLine'; // V2-8e
// v1a-08: answer strip, notification level, queue presence
import { useQueueConnect } from './queue/connect';
import { BOARD_LEVEL, useNotifications } from './queue/notify'; // v1b-18: BOARD_LEVEL
import { Strip, waitingOrder } from './queue/Strip';
import { useWaitingFlag } from './queue/useWaitingFlag'; // ticket 197
import { useBoardItems } from './queue/board'; // v1b-18
import { everStarted, markStarted } from './firstrun/ever';
import { NEW_EVENT, NewSession, quickStartNoted, StopAsk } from './NewSession'; // v1a-59
import { PairSheet } from './pairing/PairSheet'; // V2.5-15
// v1b-11: Diff (±) widget
import { DIFF_OPEN } from './diff/Diff';
const NO_FOCUS = { n: 0 };
// v1b-09: Files tree (▤ dock and `files` widget) and read-only file tabs
import { FilesTree } from './files/FilesTree';
import { fileOfTab } from './files/open';
import { Search } from './search/Search'; // v1b-10
// v1b-05: composer image chips and chat thumbnails
import { useImages } from './images/attach';
import { fileOf, imageOpener, imageScope, nameOf } from './images/Thumbnail';
import { setLinkNote } from './terminal/links'; // ticket 375
import { useLifetime } from './settings/lifetime/useLifetime'; // needs 183
import { useAgentsSheet, useAppSettings } from './settings/useAppSettings'; // needs 183
import { useFirstSessionMark } from './settings/onboarding/state';
import { loadOverlay, Overlay, saveOverlay, type OverlayKind } from './chrome/Overlay'; // v25f
import { SettingsView } from './SettingsView';
import { useMachineWake } from './settings/machines/wake';
import { fieldCommand } from './settings';
import { CENTRE } from './board/views';
import { useSessionStart } from './tree/useSessionStart'; // needs 183
import { useSideChats } from './chat/useSideChats'; // needs 183
import { useTabs } from './chrome/useTabs'; // needs 183
import { jumpChip, useHeldKeys } from './chrome/useHeldKeys'; // ticket 377
import { useProjectTabs } from './chrome/useProjectTabs'; // ticket 570
import { isViewTab } from './schedule/schedules'; // ticket 571, 993
import { load as loadWindow, save as saveWindow } from './chrome/windowState'; // v25-shell-chrome
import { useDecisionJump } from './decisions/useDecisionJump'; // needs 183
import { useGlobalKeys, useKeySink } from './chrome/useGlobalKeys'; // needs 183
import { usePaneMode } from './layout/usePaneMode'; // needs 183
import { useBoardRail } from './board/useBoardRail'; // needs 183
import { removesStrip, useRailFold, useRails } from './layout/useRails'; // needs 183
import { useSplitGlue } from './split/useSplitGlue'; // needs 183
import { useCoreLink, useTurnCue } from './chrome/useCoreLink'; // needs 183
import { useComposerSend } from './chat/useComposerSend'; // needs 183
import { ComposerWidget, insertQuote } from './chat/ComposerWidget'; // needs 183
import { CentreView, place } from './chrome/CentreView'; // needs 183
import { StatusBar } from './chrome/StatusBar'; // needs 183
import { buildCommands } from './chrome/commands'; // needs 183
export { emitQueueFocus } from './decisions/useDecisionJump';
import './pane/browser/view/browser-view.css'; // ticket 379: the startup failure uses its failed-load surface
import { useCacheTrack } from './tree/CacheTimer'; // ticket 257
import './pr/pr.css'; // V2.5-8: the PR view dialog (PrChip.tsx is loaded by node tests, so the sheet loads here)

// Ticket 379: the shell's boot when it could not reach or replace the core. `failed` exists only on that boot. Ticket 425:
// `waiting` only on the one saying the core is still starting, no attempt having failed yet. Ticket 430: `failed` is a
// failure kind (main.rs `Failed`); the window shows only that kind's fixed message, never a raw reason.
type StandIn = { failed?: string; waiting?: boolean };
const FAIL_NOTE = {
  start: 'shell.boot.fail.start',
  cli: 'shell.boot.fail.cli',
  refused: 'shell.boot.fail.refused',
  timeout: 'shell.boot.fail.timeout',
} as const;
// Anything else (an older shell's raw reason) gets the generic start message.
const failNote = (kind: string) => (Object.hasOwn(FAIL_NOTE, kind) ? FAIL_NOTE[kind as keyof typeof FAIL_NOTE] : FAIL_NOTE.start);
const standIn = (boot?: Boot) => {
  const b = boot as (Boot & StandIn) | undefined;
  return b?.failed || b?.waiting ? { failed: b.failed, waiting: !!b.waiting } : null;
};

// The Browser pane's failed-load surface. A swap can outlast the shell's patience, so a boot arriving later replaces this.
// Ticket 425: while the core is only slow to start it says so, as a status: no "Can't load", no alert.
function BootStandIn({ first }: { first: StandIn }) {
  const { settings, t } = useAppSettings();
  useTheme(settings);
  const [shown, setShown] = useState(first);
  useEffect(() => {
    const heard = () => {
      const next = standIn(window.__NUNCHIRO__);
      if (next) setShown(next);
      else location.reload();
    };
    window.addEventListener('nunchiro:boot', heard);
    return () => window.removeEventListener('nunchiro:boot', heard);
  }, []);
  const failed = shown.failed;
  return (
    <div className="bview">
      <div className="bfail" role={failed ? 'alert' : 'status'} data-state={failed ? 'failed' : 'waiting'}>
        <div className="bfail-title">{failed ? t('browserPane.fail.other') : t('shell.boot.starting')}</div>
        <div className="bfail-note">{t(failed ? failNote(failed) : 'shell.boot.startingNote')}</div>
        <div className="bfail-acts">
          <button type="button" className="btn" onClick={() => location.reload()}>
            {t('browserPane.retry')}
          </button>
        </div>
      </div>
    </div>
  );
}

export function App({ core, boot }: { core: CoreClient; boot: Boot }) {
  const first = standIn(boot);
  return first ? <BootStandIn first={first} /> : <Shell core={core} boot={boot} />;
}

function Shell({ core, boot }: { core: CoreClient; boot: Boot }) {
  const { settings, setSettings, update, t, settingsFocus, setSettingsFocus } = useAppSettings(); // needs 183: settings, `t` and their page effects
  const [sessions, setSessions] = useState<Session[]>([]);
  const [firstSnapshot, setFirstSnapshot] = useState<Session[] | null>(null); // the list the first snapshot carried
  const snapped = useRef(false); // a snapshot has arrived on the current connection
  const [boardList, setBoardList] = useState<BoardDecision[]>([]); // v1b-18
  const [ownerList, setOwnerList] = useState<Decision[]>([]); // v1a-23
  const [connected, setConnected] = useState(false);
  // v25-shell-chrome (ticket 282 item 1): the window opens as it was left (tabs, the focused tab, the sessions it has shown).
  const restored = useRef(loadWindow());
  const shownRef = useRef<{ selected: string | null; inStrip: (id: string) => boolean }>({ selected: null, inStrip: () => true }); // ticket 570: read by useCoreLink, set once the project tabs are known
  const [tabs, setTabs] = useState<string[]>(restored.current?.tabs ?? []);
  const [active, setActive] = useState<string | null>(restored.current?.active ?? null);
  const seen = useRef(new Set(restored.current?.seen ?? []));
  const [composerHidden, setComposerHidden] = useState(false);
  // V2.5-34 (finding 17): a session that shows its terminal has no composer until the owner asks for one (Focus the composer, Hide or show the composer); per session.
  const [termComposer, setTermComposer] = useState<Record<string, boolean>>({});
  const [palette, setPalette] = useState(false);
  const [quickOpen, setQuickOpen] = useState(false); // ticket 821
  // v25f (D-20261108-10): Settings and the Board open in one modal over the workspace; the active tab stays as it is.
  const [overlay, setOverlay] = useState<OverlayKind>(loadOverlay);
  useEffect(() => saveOverlay(overlay), [overlay]); // a reload of this window keeps the modal open
  const openSettings = useCallback(() => setOverlay('settings'), []);
  // Ticket 1168: the Bots view, asked for from a Settings page, the lead's header or the palette; `botFirst` is the bot whose page it opens on.
  const [botFirst, setBotFirst] = useState<string | null>(null);
  useEffect(() => onOpenBots((id) => (setBotFirst(id ?? null), setOverlay('bots'))), []);
  const manageAccounts = useCallback(() => (setSettings((x) => ({ ...x, settingsPage: 'providers' })), setOverlay('settings')), []); // ticket 451
  const toggleSettings = () => setOverlay((o) => (o === 'settings' ? null : 'settings'));
  const [hints, setHints] = useState<false | 'open' | 'copy'>(false);
  // v1a-37: zoom is view state (the layout store is never written); `copied` is the short status after Hints copy.
  const [zoom, setZoom] = useState<string | null>(null);
  const [copied, setCopied] = useState<boolean | null>(null);
  const [copyId, setCopyId] = useState<string | null>(null); // v1a-42: the session whose terminal is in copy mode
  // v1a-43: pane mode (view state): the focused zone while on, and the status note (a refusal).
  const [pane, setPane] = useState<string | null>(null);
  const [paneNote, setPaneNote] = useState<Note>('');
  const lastNext = useRef<string | null>(null); // V1A-60b: the item waiting.next last brought up
  const [armed, setArmed] = useState(false);
  const { sink, before, toSink, fromSink } = useKeySink(); // the prefix's focus sink
  // v1a-57: `?` after the prefix shows the prefix help at once; ticket 1099: ⌘/ (keys.sheet) shows the whole sheet.
  const [helpNow, setHelpNow] = useState<false | 'prefix' | 'all'>(false);
  useEffect(() => void (armed || setHelpNow(false)), [armed]);
  const composer = useRef<HTMLTextAreaElement>(null);
  // v1b-11: open Diff (and the path it was opened at; `n` re-selects the same path on a second open).
  const [diff, setDiff] = useState<{ path?: string; files?: string[]; n: number } | null>(null);
  // v1a-07b: layout.toml through the core; edit mode, drawer, drag and the waiting-removal notice.
  const store = useMemo(() => new LayoutStore((l) => core.saveLayout(l)), [core]);
  useSyncExternalStore(store.subscribe, store.snapshot);
  const layout = store.current;
  // v25f: a saved layout whose centre held a Board tab lost it on load (store.boardMoved); the Board opens as the modal instead.
  useEffect(() => void (store.boardMoved && ((store.boardMoved = false), setOverlay('board'))), [layout, store]);
  // LAYOUT D5b: the icon bars. A widget's command opens it on its bar; one off every bar and out of the layout goes to
  // its usual side first (Files, Search left; the rest right). Arrangement changes are steps of one trail (useArrange).
  const dock = useDock();
  const bars = settings.bars;
  const showWidget = useCallback(
    (w: string, toggleIt = false) => {
      setSettings((s) => {
        if (where(s.bars, w)) return { ...s, bars: toggleIt ? toggleOnBar(s.bars, w) : openOnBar(s.bars, w) };
        if (count(store.current, kindOf(w) as Kind) > 0) return s;
        const side: Side = ['files', 'search', 'tree'].includes(kindOf(w)) ? 'left' : 'right';
        const at = freeSlot(s.bars, side);
        return at ? { ...s, bars: dropOnBar(s.bars, w, at.side, at.index) ?? s.bars } : s;
      });
    },
    [store],
  );
  useEffect(() => {
    const on = (e: Event) => {
      setDiff((d) => ({ ...(e as CustomEvent<{ path?: string; files?: string[] }>).detail, n: (d?.n ?? 0) + 1 }));
      showWidget('diff');
    };
    window.addEventListener(DIFF_OPEN, on);
    return () => window.removeEventListener(DIFF_OPEN, on);
  }, [showWidget]);
  // v1b-06: cards read through this window's core socket.
  bindCore(core);
  // end v1b-06
  const editing = store.editing;
  const [selected, setSelected] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [ask, setAsk] = useState<{ op: Op } | null>(null);
  const keepStrip = () => (setAsk(null), setTimeout(() => (askFrom.current as HTMLElement | null)?.focus?.(), 0));
  const askFrom = useRef<Element | null>(null); // where focus was when the "Remove the answer strip?" dialog opened
  // v1b-05: chips per session; chat thumbnails read through this core and these sessions' folders. A layout effect:
  // it runs after render and before any thumbnail's (passive) load effect of the same commit.
  const images = useImages(core);
  useLayoutEffect(() => void Object.assign(imageScope, { core, sessions }), [core, sessions]);
  useLayoutEffect(() => setLinkNote(setPaneNote), []); // ticket 375: a terminal path's refused Open in editor

  const arrange = useArrange(store, settings, update, setMessage);

  useMachineWake(core, connected);
  const { layoutSeen } = useCoreLink({ seen, core, store, connected, setConnected, snapped, setSessions, setFirstSnapshot, setBoardList, setOwnerList, settings, setSettings, setTabs, setActive, shown: shownRef });

  const runOp = useCallback(
    async (op: Op, confirmed = false) => {
      if (!confirmed && removesStrip(store.current, op)) return (askFrom.current = document.activeElement, setAsk({ op }));
      if (op.op === 'undo') return void arrange.undo().catch((e: Error) => setMessage({ text: lineError(t, e), error: true }));
      try {
        const text = await store.run(op, measureDom);
        arrange.zoneStep(text); // needs 153: no ":" command syntax shown
        setMessage(count(store.current, 'waiting') === 0 ? { text: t('leftovers.stripGone', { signals: t('leftovers.signalsLeft') }), error: false } : null);
      } catch (e) {
        setMessage({ text: lineError(t, e), error: true });
      }
    },
    [store, arrange, t],
  );
  const finish = useCallback(async () => {
    try {
      await store.done();
      arrange.ended();
      setMessage(null);
    } catch (e) {
      setMessage({ text: lineError(t, e), error: true });
    }
    setSelected(null);
  }, [store, arrange, t]);
  const runLine = (line: string) => {
    if (line === 'done') return void finish();
    if (line === 'cancel') return (arrange.cancel(), setMessage(null));
    if (line === 'reset') return void arrange.resetAll();
    try {
      void runOp(parse(tokenize(line), selected ?? undefined, store.current));
    } catch (e) {
      setMessage({ text: lineError(t, new OwnWords(e instanceof CommandError ? t(e.key, e.args) : rawError(e))), error: true }); // the command parser's refusals, in the window's language
    }
  };

  const { quit, setQuit, closeNotice, setCloseNotice, confirmQuit, closeWindow } = useLifetime(); // v1a-09

  const termTheme = useTheme(settings);

  const ordered = useMemo(() => orderSessions(sessions, settings.order), [sessions, settings.order]);
  setNameScope(ordered); // ticket 491: same-name sessions are numbered by this order, before any child names one
  const byId = useMemo(() => new Map(sessions.map((s) => [s.id, s])), [sessions]);
  // Ticket 259 (real-app look 11-15): a worktree the window made has no session row to carry the setup ask, and the default
  // layout has no strip, so the ask showed nowhere. But a sheet over the window at every launch reads as an
  // error, so it opens by itself only for a worktree this window just made; any other ask waits in Decisions (Review).
  const [setupAsk, setSetupAsk] = useState<string | null>(null);
  const setupSeen = useRef(new Set<string>()); // the effect is after `wt`, which knows what this window made
  const current = active ? byId.get(active) ?? null : null;
  // AGENTVIEW: the Terminal icon is the current agent session's side pane, not a sidebar.
  const paneSession = current && hasTranscript(current) && current.state === 'running' ? current : null;
  // Selecting an artifact asks for Preview (artifacts/store.ts `dock`): the session's side pane opens on its Preview tab
  // (owner RIGHTBAR: Preview has no bar of its own) and the request is spent.
  useEffect(() => {
    if (!dock) return;
    if (current && hasTranscript(current)) paneShow(current.id, 'preview');
    setDock(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dock]);
  useAutoOpen(sessions, active);
  // AGENTVIEW: a shell started by `+ Shell` lives in the pane, not also as a window tab (a new running session opens as one).
  const paneState = usePane();
  const paneShells = Object.values(paneState.shells).flat().join();
  useEffect(() => {
    const ids = new Set(paneShells.split(',').filter(Boolean));
    setTabs((t) => t.filter((id) => !ids.has(id)));
    setActive((a) => (a && ids.has(a) ? (Object.entries(paneState.shells).find(([, l]) => l.includes(a))?.[0] ?? null) : a));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneShells]);
  const { splitState, accountsP, readAccounts, pickSplit, closeSplit, pinSplit, splitRef } = useSplitGlue({ core, connected, sessions, byId, ordered, current, snapped, setTabs, setActive, settings, paneSession, setPaneNote, composer, layout, store, bars, arrange }); // SPLITS
  const pt = useProjectTree(core, connected, sessions, current?.id ?? null); // V2-9a: tree.toml
  // A session this window just started is listed before its tab opens: `current` is read from the list, and until the core's
  // next snapshot brought it, a key pressed in that gap (⌃⇧` right after ⇧⌘C) found no current session and did nothing.
  const openStarted = (s: Session) => (setSessions((all) => (all.some((x) => x.id === s.id) ? all : [...all, s])), open(s.id));
  const wt = useWorktrees(core, connected, sessions, openStarted, t); // V2-8a; ticket 476: toasts in the chosen language
  useEffect(() => {
    const d = ownerList.find((d) => d.owner?.type === 'setup' && wt.madeHere.includes(d.owner.path) && !byId.has(d.session_id) && !setupSeen.current.has(d.id));
    if (d?.owner?.type !== 'setup') return;
    setupSeen.current.add(d.id);
    setSetupAsk(d.owner.path);
  }, [ownerList, byId, wt.madeHere]);
  const team = useTeam(core, connected); // ticket 990: the teammates and leads, for the tree, the headers and the palette
  /** needs 130: "<project> / <place>" as the header and the composer chip read it (see `place`). */
  /** needs 130: the header's +a −b, the same read the status bar makes (ticket 62 keeps its own copy there). */
  const headStat = useDiffStat(core, current?.id, current?.machine);
  const placeText = (s: Session) => {
    if ((team.home && s.project === team.home) || team.teammates.some((m) => m.id === s.teammate && !m.project)) return t('assistants.title'); // ticket 990 (survey C13): the Home folder is no checkout, so no "main"
    const p = place(wt.list, s, t('tree.main'));
    return p.place ? `${p.project} / ${p.place}` : p.project;
  };
  // v1a-68 r4: a closed shell's text, read once from the view the core holds; none when the bound dropped it.
  const [closedText, setClosedText] = useState<{ id: string; text: string } | null>(null);
  const closedShell = current?.state === 'closed' && current.kind === 'shell' ? current.id : null;
  useEffect(() => {
    if (!closedShell) return;
    let live = true;
    void plainText(core, closedShell).then((text) => live && setClosedText(text === null ? null : { id: closedShell, text }));
    return () => {
      live = false;
    };
  }, [core, closedShell]);
  // v1b-06: a thumbnail of a readable file opens in Preview (the focused session's); bytes keep 05's viewer.
  useLayoutEffect(() => {
    imageOpener.open = (source) => {
      const f = fileOf(source);
      if (!f || !current) return false;
      select(current.id, { ...f, type: 'image', title: nameOf(source) });
      return true;
    };
  }, [current]);
  const bindings = merge(settings.bindings);
  setLiveBindings(bindings); // ticket 1099: help lines read the live keys (keys.ts keyText)

  const { handoff, setHandoff, sideChats, setSideChats, openSideChat } = useSideChats({ core, sessions, t, setPaneNote }); // v2-3b
  const board = useBoardItems(boardList, sessions); // v1b-18
  const projectList = useMemo(() => withNames(withoutClosedHeads(buildTree(sessions, settings.order, board, pt.tree.added), pt.tree), pt.tree).flatMap((m) => m.groups), [sessions, settings.order, board, pt.tree]);
  const pathsKey = projectList.map((g) => g.project).join('\n');
  const projectPaths = useMemo(() => (pathsKey ? pathsKey.split('\n') : []), [pathsKey]);
  const localKey = projectList.filter((g) => ![...g.main, ...g.worktrees.flatMap((w) => w.sessions)].some((s) => s.machine)).map((g) => g.project).join('\n');
  const localPaths = useMemo(() => (localKey ? localKey.split('\n') : []), [localKey]); // ticket 1073: History's on-disk conversations
  // Ticket 570: the strip shows the selected project's tabs; `tabs` stays the flat list of every project's (all stay mounted).
  useFirstSessionMark(sessions, projectPaths); // ticket 582: the first-session step stays done once an agent session started
  const pj = useProjectTabs({ tabs, active, setActive, byId, projects: projectPaths, ready: firstSnapshot !== null, saved: restored.current });
  shownRef.current = { selected: pj.selected, inStrip: (id) => ((p) => p === null || p === pj.selected)(pj.projectOf(id)) };
  useEffect(() => saveWindow({ tabs, active, seen: [...seen.current], selected: pj.selected, activeBy: pj.activeBy, tabProj: pj.tabProj }), [tabs, active, sessions, pj.selected, pj.activeBy, pj.tabProj]);
  const selectProject = useCallback((p: string) => (setOverlay(null), pj.select(p)), [pj.select]); // a modal over the workspace would hide the switch
  const { open, recent, shown, reopen, canReopen, closeTabs, closeTab, closing, answerClose, resuming, resume, filesSession, jumps, lastTab, moveTab, shift, focusTab, rename, cycle, renaming, setRenaming, moved, dragTab, follow, addTab } = useTabs({ core, tabs, visible: pj.visible, setTabs, active, setActive, byId, current, setSettings, setPaneNote, sideChats, setSideChats, setHandoff, splitState, closeOverlay: () => setOverlay(null), t });
  // Ticket 305: the first launch opens Settings > Onboarding, once. Decided on the first snapshot: a user who already has
  // sessions (webview data cleared, flag lost) gets the flag set and stays where they are.
  const firstDecided = useRef(false);
  useEffect(() => {
    if (!firstSnapshot || firstDecided.current) return;
    firstDecided.current = true;
    // Ticket 549: the first snapshot has drawn; scripts/measure/startup.py times launch to the app's stderr line.
    if ('__TAURI_INTERNALS__' in window) void import('@tauri-apps/api/core').then(({ invoke }) => invoke('startup_drawn')).catch(() => {});
    if (everStarted()) return;
    markStarted();
    if (firstSnapshot.length) return;
    setSettings((s) => ({ ...s, settingsPage: 'onboarding' }));
    setOverlay('settings');
  }, [firstSnapshot, setSettings]);
  // v1a-08: one OS notification per new item; clicking it opens that session's tab. The heartbeat lets
  // blocking hooks wait for an answer from this window.
  const notify = useNotifications(sessions, open, board, active);
  useTurnCue({ connected, snapped, sessions, active, notify }); // v1a-38, needs 170 (2)
  useCacheTrack(sessions); // ticket 257: the window's full list, always mounted (a scoped or hidden widget would miss stops)
  useQueueConnect(core, connected);
  useBoardSeen(core, current, connected); // v1b-16
  const { starting, setStarting, stopping, setStopping, stopSession, stop } = useSessionStart({ core, byId, setPaneNote }); // v1a-59
  // Ticket 991 C23: Settings opens over no other popover, and a New session asked while it is open closes it first (as ⌘W
  // acts on the modal before the tab behind it); the Board keeps its popover, its cards start sessions over it.
  useEffect(() => {
    if (overlay !== 'settings') return;
    setStarting(null);
    setPalette(false);
    setQuickOpen(false);
    const onNew = () => setOverlay((o) => (o === 'settings' ? null : o));
    window.addEventListener(NEW_EVENT, onNew);
    return () => window.removeEventListener(NEW_EVENT, onNew);
  }, [overlay, setStarting]);
  const agentSheet = useAgentsSheet({ setSettings, openSettings, setSettingsFocus }); // V2-4b
  const { pendingEnter, uncertainSend, pressRow, drafts, setDrafts, givenBack, setGivenBack, grow, stopAgent, send, steerNow, backgroundSend } = useComposerSend({ core, sessions, current, ordered, images, handoff, setHandoff, sideChats, follow, open, addTab, accountsP, readAccounts, t, setPaneNote, connected, snapped });
  /* layout-b */ const filesTree = (action?: ReactNode, only?: Session | null) => ( /* end layout-b */
    <FilesTree
      action={action}
      core={core}
      connected={connected}
      session={only === undefined ? filesSession : only /* layout-b */}
      expanded={settings.filesExpanded}
      onExpanded={(root, paths) => update({ filesExpanded: { ...settings.filesExpanded, [root]: paths } })}
      selected={fileOfTab(active)}
    />
  );
  // end v1b-09
  // v1b-10: Search searches the session the Files tree shows.
  const [searchFocus, setSearchFocus] = useState(0);
  const [sessionsAsk, setSessionsAsk] = useState<{ n: number; only?: string }>({ n: 0 }); // v2-7; Q7 point 15: `only` scopes it to one chat
  // v2-7: its Sessions scope searches every session and opens a hit's tab.
  const search = (s: Session | null, focus?: number, action?: ReactNode, ask?: { n: number; only?: string }) => <Search core={core} connected={connected} session={s} autoFocus={focus} action={action} sessions={sessions} onOpenSession={open} sessionsAsk={ask} />;
  // end v1b-10
  const { focusedZone, paneApi } = usePaneMode({ store, layout, editing, pane, setPane, paneNote, setPaneNote, setZoom, toSink, fromSink, before, active }); // v1a-43
  // Edit mode and a removed zone both end the zoom.
  useEffect(() => void ((editing || (zoom && !find(layout.root, zoom))) && setZoom(null)), [editing, zoom, layout]);
  useEffect(() => {
    if (copied === null) return;
    const t = setTimeout(() => setCopied(null), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  // v1a-42: copy mode ends when its session closes or another tab is shown (it swallows every key).
  useEffect(() => void (copyId && current?.id !== copyId && (fromSink(), setCopyId(null))), [copyId, current?.id]);
  const { onAction, onDetails, jump, setJump, back, showDecisions } = useDecisionJump({ open, active, tabs, setActive, sessions }); // V2-8e
  // V2-8e: every answer from a decision row, its peek or the card: one per item (answerOnce); an Outbox card's Undo is its second.
  const onAnswer: OnAnswer = useCallback((d, a, confirmed) => answerOnce(d.id, () => core.answer(d.id, withNote(d.id, a), confirmed), d.owner?.type === 'outward'), [core]);
  const front = current && !composerHidden && !isViewTab(active) && count(layout, 'composer') > 0 && (hasTranscript(current) || agentState(current) !== 'running' || termComposer[current.id]) ? current.id : null;
  const deciding = withoutFront(sessions, front); // ticket 1030: the front session answers on a card above its composer; Decisions drops its ordinary requests, the tree keeps its mark
  const pastePath = useCallback((p: string) => {
    setComposerHidden(false);
    setTimeout(() => {
      const el = composer.current;
      if (!el) return;
      el.focus();
      el.setRangeText(p, el.selectionStart, el.selectionEnd, 'end');
    }, 0);
  }, []);

  const { bodyRef, fold, foldKey, foldName, foldOf } = useRailFold({ layout, editing, settings, active, bars }); // v1a-60
  const { toggleBoard } = useBoardRail({ core, setOverlay }); // V2.5-54 A7; v25f: the Board modal
  // v1b-28: each kind's window view is its registry entry (layout/windows.tsx); this is what the window hands it.
  // Ticket 1038: My browser's notes go to the session in front, else the last focused one that still takes a message.
  const noteTo = connected ? [active, ...recent.current].map((id) => (id ? byId.get(id) : undefined)).find((s): s is Session => !!s && hasTranscript(s) && agentState(s) === 'running') ?? null : null;
  const windowCtx = (): WindowCtx => ({
      boot,
      core,
      sessions,
      current,
      pinned,
      open,
      diff: diff ?? NO_FOCUS,
      // Ticket 374: a Diff line note; only while the composer takes text (as its textarea's disabled rule).
      quote: connected && current && agentState(current) === 'running' && (hasTranscript(current) || termComposer[current.id]) ? (text) => (setComposerHidden(false), setTimeout(() => insertQuote(composer)(text), 0)) : undefined,
      notes: noteTo && { name: sessionName(noteTo), insert: (text) => (open(noteTo.id), setComposerHidden(false), setTimeout(() => insertQuote(composer)(text), 0)) },
      filesSession,
      t,
      wt: { list: wt.list, facts: wt.facts, team: wt.team, open: wt.open, refresh: wt.refresh, settled: wt.settled }, // ticket 990; 1022: History lists the settled ones
      owner: ownerList,
      projects: localPaths, // ticket 1073
      decide: (id) => {
        showDecisions.current();
        // The card is drawn after the sidebar opens: then it comes into view and takes focus (not its yes).
        requestAnimationFrame(() => requestAnimationFrame(() => {
          const card = document.querySelector<HTMLElement>(`.dw [data-item="${CSS.escape(id)}"]`);
          if (!card) return;
          card.tabIndex = -1;
          card.scrollIntoView({ block: 'nearest' });
          card.focus();
        }));
      },
      tree: () => (
        <Tree
          t={t}
          core={core} // V2-CF4
          sessions={sessions}
          order={settings.order}
          current={current?.id ?? null}
          collapsed={settings.collapsed}
          onToggle={(p) => update({ collapsed: settings.collapsed.includes(p) ? settings.collapsed.filter((x) => x !== p) : [...settings.collapsed, p] })}
          onOpen={open}
          onSelect={selectProject} // ticket 570
          onStartIn={(project, kind) => quickStartNoted(core, ordered, current, kind, project, openStarted, setPaneNote, t)} // ticket 1130 C1
          selected={pj.selected}
          keyOf={(project) => ((i) => (i >= 0 && i < 9 ? jumpChip(bindings, 'project.jump', i + 1) : ''))(projectPaths.indexOf(project))}
          tabKeyOf={(id) => ((i) => (i >= 0 && i < 9 ? jumpChip(bindings, 'session.jump', i + 1) : ''))(pj.visible.indexOf(id))} // ticket 377: only a session open in the visible project's first nine tabs
          onAction={onAction}
          onAnswer={onAnswer} // V2-8e
          onDetails={(d) => void (d.session_id === front && !alsoInDecisions(d) && focusCard(document.querySelector('.composer .deccard.docked')) || onDetails(d))} // V2-8e; ticket 1030: the session in front's card is above its composer
          signal={strip === 'signal'} // v1a-08
          // N25 (look 1117 v3): a board card whose task waits on a merge card names that merge in the tree, as the card does.
          board={treeItems} // v1b-18
          needYou={{ sessions: deciding, owner: ownerList }} // ticket 1067: the lead row's pill says the Team view's number
          projects={pt} // V2-9a
          wt={wt} // V2-8a
          subviews={nest.subviews /* layout-b */}
        />
      ),
      strip: stripWidget,
      terminal: centreView,
      composer: composerView,
      decisions: () => <DecisionsWidget t={t} core={core} home={team.home} {...scopeToPlace(leadSeatMate(current, team)?.project, deciding, ownerList)} front={front} onAnswer={onAnswer} ask={jump && !jump.asked ? { to: jump.to, n: jump.n } : null} onBack={back} onFocused={() => setJump((j) => j && { ...j, asked: true })} onAnswered={() => setJump(null)} />, // V2-8e: a jump grants focus once; an answer ends it
      files: (s) => filesTree(undefined, s), // layout-b: a project's sub-view names its session
      search: (s) => search(s, searchFocus, undefined, sessionsAsk),
    });
  /* layout-b */
  const nest = useNest({ bars, editing, arrange, setBars: (f) => setSettings((st) => ({ ...st, bars: f(st.bars) })), projects: projectList.map((g) => ({ path: g.project, name: g.name })), ctx: windowCtx });
  /* end layout-b */
  // v25-shell-chrome (ticket 283): a dot on the icon of a widget that holds something waiting: Decisions (a pending ask), Board (a board or owner item).
  const waitingOn = (w: string) => (kindOf(w) === 'decisions' ? deciding.some((s) => asks(s.pending).length > 0) || ownerList.some(hasCard) : kindOf(w) === 'board' ? waitingOrder(ordered, board, ownerList).some((d) => !d.session_id) : false);
  const { moved1, openCmd, moveIcon, removeIcon, otherBar, toggleSide, land, hidden, grab, drag, setDrag, peek, dropSplit, barHint, endPeek, sidebar, iconBar, stepSidebarW } = useRails({ waiting: waitingOn, store, layout, editing, bars, layoutSeen, setSettings, open, finish, arrange, runOp, paneSession, paneState, showWidget, fold, foldOf, toggleBoard, showDecisions, t, overlay, toggleSettings, current, nest, windowCtx, core, sessions, deciding, filesSession, owner: ownerList, active, project: pj.selected && projectPaths.includes(pj.selected) ? pj.selected : null /* look 1117 v13 A NEW-S3-D: a removed project stays selected */ });
  const { reveal, headRef, hint, setHint } = useTitleBar(settings, update, palette); // A30-A32, moved out with ticket 1030
  // Ticket 570 and 377 (F4): while the modifiers of a jump key are held for 200 ms, the tabs and tree rows show ⌘1-9 and the project rows ⌃1-9 (the real bindings).
  useHeldKeys(bindings);
  const registryVersion = useRegistry(); // ticket 170: a page registered later adds its palette entries
  const commands: Command[] = useMemo(
    () => buildCommands({ ordered, board, ownerList, current, t, openSideChat, setPalette, setQuickOpen, setOverlay, overlay, open, openStarted, setActive, setSettings, setHints, toSink, setArmed, setHelpNow, setCopyId, active, editing, setZoom, focusedZone, paneApi, sessions, stop, cycle, setRenaming, closeTab, tabs: pj.visible, selectProject, selected: pj.selected, closeTabs, reopen, canReopen, shift, jump, back, lastTab, lastNext, onAction, setQuit, sideChats, setTermComposer, setComposerHidden, composer, steerNow, backgroundSend, openCmd, otherBar, removeIcon, stepSidebarW, resume, bars, paneSession, paneState, foldKey, toggleBoard, setSearchFocus, setSessionsAsk, core, setPaneNote, fold, toggleSide, foldOf, arrange, update, finish, setMessage,  splitRef, setSettingsFocus, pt, wt, projectList, team, notify }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ordered, board, ownerList, tabs, pj.visible, pj.selected, projectPaths, canReopen, active, open, onAction, editing, layout, finish, runOp, store, current /* v1b-03 */, bars /* v1a-48 */, fold.folded.join('\n') /* v1a-60 */, diff, pt.tree, pt.menuProject, pt.edit, pt.setAsk, pt.setPicking, wt.list, wt.selected, sideChats, t, registryVersion /* ticket 170 */, overlay /* v25f */, team /* ticket 990 */],
  );
  const pluginCommands = usePluginCommands({ core, t, open: palette, current, composer, note: setPaneNote });
  const run = (id: string) => {
    const c = commands.find((c) => c.id === id);
    if (c && c.enabled !== false) c.run();
  };
  useWaitingFlag(ordered.reduce((n, s) => n + s.pending.length, 0) + board.length + ownerList.length, run); // ticket 197

  useGlobalKeys({ editing, palette, finish, arrange, setMessage, drag, settings, update, setPaneNote, hints, copyId, bindings, pane, paneApi, armed, setArmed, run, current, core, toSink, fromSink, inSettings: overlay === 'settings' });

  const strip = settings.strip;
  const showInputSourceBanner = boot.ctrlSpaceTaken && !settings.inputSourceChecked && (bindings.prefix ?? []).includes('Control+Space');
  // A pin names a session by id or by its shown name; it may be one that is not running yet.
  const pinned = (pin: string) => sessions.find((s) => s.id === pin || sessionName(s) === pin) ?? null;

  const centreView = (pin?: string) => <CentreView {...{ pin, t, projectCount: projectList.length, tabs, shown: pj.visible, project: pj.selected, byId, sessions, deciding, active, setActive, renaming, setRenaming, focusTab, closeTab, dragTab, moveTab, rename, moved, jumps, current, core, placeText, openSideChat, headStat, bars, notify, sideChats, connected, setTabs, open, windowCtx, boot, stripShows, composerView, pickSplit, pinSplit, closeSplit, splitState, settings, bindings, run, termTheme, paneSession, composer, pinned }} />;

  // needs 107, A22: no strip in the default layout; one the user places is drawn wherever it is (an old strip zone right above the
  // composer is dropped once by the layout store).
  // CHROME: the decision the answer strip shows (strip on and placed), so the chat's own line skips it.
  const stripShows = strip === 'on' && count(layout, 'waiting') > 0 ? waitingOrder(ordered, board, ownerList)[0]?.id ?? null : null;
  const stripWidget = (first: boolean) => (
      <section id={first ? 'waiting-strip' : undefined} className="strip" data-zone="strip" data-mode={strip} aria-label={t('shell.widget.waiting')}>
        {/* v1a-08: strip content */}
        <Strip mode={strip} sessions={ordered} core={core} hint={label(bindings['waiting.next']?.[0] ?? '', bindings)} onOpen={onAction} board={board} owner={ownerList} boardLevel={{ level: notify.levels[BOARD_LEVEL] ?? 'all', set: (l) => notify.setLevel(BOARD_LEVEL, l) }} />
      </section>
    );

  const treeItems = withMerges(board, ownerList, t); // N25: a merge card's line in its project's rows
  const composerView = (first: boolean, pin?: string) => <ComposerWidget {...{ first, pin, composerHidden: composerHidden || isViewTab(active) /* ticket 571: the Room has its own composer; ticket 993: Schedules has none */, pinned, current, termComposer, connected, images, pressRow, t, core, setPaneNote, bindings, handoff, setHandoff, sideChats, send, uncertainSend, pendingEnter, composer, givenBack, setGivenBack, setDrafts, drafts, grow, steerNow, backgroundSend, stopAgent, closedText, run, placeText, sessions, follow, resume, resuming, front, onAnswer, owner: ownerList }} />;

  const widget = (item: Item, ctx: WidgetCtx) => renderWidget(item, ctx.first, windowCtx(), ctx.zone.id, () => void runOp({ op: 'remove', zone: ctx.zone.id, tab: ctx.tab + 1 })); // V2.5-38: the board's view is per zone
  // end v1b-28
  const barsShown = !bars.barsHidden || editing; // v25f F13: Layout edit needs the bars, they are its drop targets

  return (
    <div className="win" data-titlebar={settings.titleBar} data-dragging={drag ? 'true' : undefined}>
      <Tooltip bindings={bindings} /* v1a-65 */ />
      <ContextMenu commands={commands} bindings={bindings} say={setPaneNote} activate={(id) => (addTab(id), setActive(id))} /* V2-6a; activating a row is not opening a tab, so the Board modal stays */ />
      {settings.titleBar !== 'hidden' && (
        <header className="title" ref={headRef} data-hint-region="top" data-tauri-drag-region data-autohide={settings.titleBar === 'auto' ? '' : undefined} data-reveal={reveal}>
          <button className="cmd" onClick={() => setPalette(true)} aria-label={t('mw.title.palette')}>
            <Icon name="search" size={14} /> {t('palette.placeholder')}
            <span className="sp" />
            <span className="kbd">{label(bindings['palette.open']?.[0] ?? '', bindings)}</span>
          </button>
        </header>
      )}
      {editing && (
        <EditStrip
          message={message}
          undo={arrange.steps}
          outside={store.outside}
          run={runLine}
          onDone={() => void finish()}
          onCancel={() => (arrange.cancel(), setMessage(null))}
          presets={arrange.menu(layout)}
          onSplit={current ? (side) => void finish().then(() => addSplit(current.id, side, CHOOSER)) : undefined} // v25 placement item 3
        />
      )}
      {showInputSourceBanner && (
        <div className="banner" role="alert">
          {t('rest.shell.inputSource.banner', { prefix: label('Control+Space', bindings) })}
          <button className="btn p" onClick={() => update({ inputSourceChecked: true, bindings: { ...settings.bindings, prefix: ['Control+KeyB'] } })}>
            {t('rest.shell.inputSource.useB')}
          </button>
          <button className="btn" onClick={() => update({ inputSourceChecked: true })}>
            {t('rest.shell.inputSource.keep')}
          </button>
        </div>
      )}
      <div className="body" ref={bodyRef}>
        {barsShown && iconBar('left')}
        {sidebar('left')}
        <LayoutView
          reveal={shown}
          layout={layout}
          editing={editing}
          selected={selected}
          hidden={hidden}
          zoom={editing ? null : zoom}
          paneFocus={pane}
          zoomNote={['Zoomed', label(bindings['zone.zoom']?.[0] ?? '', bindings)].filter(Boolean).join(' · ')}
          render={widget}
          onSelect={setSelected}
          onResize={(zone, size) => void runOp({ op: 'resize', zone, size })}
          onRemove={(zone, tab) => void runOp({ op: 'remove', zone, tab })}
          onGrab={(e, from, tab) => {
            const z = find(layout.root, from);
            if (z && isLeaf(z)) grab({ from, tab, widget: z.widgets[tab] })(e);
          }}
        />
        {sidebar('right')}
        {barsShown && iconBar('right')}
        {editing && (
          <Library
            t={t}
            core={core}
            bars={bars}
            layout={layout}
            onGrab={(e, kind, blocked) => grab({ widget: kind, blocked })(e)}
            onAdd={(kind) => {
              const at = freeSlot(bars, 'left');
              if (at) moveIcon(kind, at.side, at.index);
              else arrange.notify('No free slot: remove an icon or move one first');
            }}
            refused={(_kind, why) => arrange.notify(why)}
            onNest={nest.add /* layout-b */}
          />
        )}
      </div>
      <StatusBar {...{ current, t, core, sessions, ordered, open, store, editing, moved1, pane, paneNote, setPaneNote, fold, foldName, connected, manageAccounts, addTab }} />
      {arrange.toast && (
        <div className="toast" role="status" key={arrange.toast.n}>
          <span>{arrange.toast.text}</span>
          {arrange.toast.undo && (
            <>
              <button onClick={() => void arrange.undo().catch((e: Error) => setMessage({ text: lineError(t, e), error: true }))}>{t('mw.undo')}</button>
              <kbd className="kbd">⌘Z</kbd>
            </>
          )}
          <button aria-label={t('mw.dismiss')} onClick={arrange.dismiss}>
            ×
          </button>
        </div>
      )}
      <MigrationToast t={t} update={update} />
      <CoreKept t={t} /><CoreKept t={t} flag="coreForeign" />
      {hint && (
        <div className="titlehint" role="status">
          {t('mw.title.hidden')} · <span className="kbd">{label(bindings['palette.open']?.[0] ?? '', bindings)}</span> → {t('mw.title.show')}
          <button aria-label={t('mw.dismiss')} onClick={() => setHint(false)}>
            ×
          </button>
        </div>
      )}
      <div id="key-sink" ref={sink} tabIndex={-1} className="sr" aria-label={t('mw.keySink')} />
      {armed && (
        <div className="prefix-armed kbd" role="status">
          {label(bindings.prefix?.[0] ?? '', bindings)} …
        </div>
      )}
      {armed && <PrefixHelp bindings={bindings} commands={commands} delay={settings.prefixHelpDelay} now={!!helpNow} all={helpNow === 'all'} />}
      {nest.picker /* layout-b */}
      {peek && <SplitOverlay widget={peek} onDrop={dropSplit} onBar={barHint} onEnd={endPeek} />}
      {drag && (
        <DragLayer source={drag} layout={layout} onDrop={(l) => land(l, drag)} onEnd={() => setDrag(null)} />
      )}
      {ask && (
        // Esc = Keep, as StopAsk (NewSession.tsx) does; focus goes back to the button that asked. The Esc stays inside the dialog (Layout edit keeps going).
        <div className="wnotice" role="alertdialog" aria-label={t('rest.shell.stripRemove.title')} aria-describedby="wnotice-text" onKeyDown={(e) => (e.stopPropagation(), e.key === 'Escape' && keepStrip())}>
          <b>{t('rest.shell.stripRemove.title')}</b>
          <p id="wnotice-text">{t('rest.shell.stripRemove.body', { signals: t('leftovers.signalsLeft') })}</p>
          <div className="row">
            <button className="btn" autoFocus onClick={keepStrip}>
              {t('rest.shell.stripRemove.keep')}
            </button>
            <button className="btn p" onClick={() => (setAsk(null), void runOp(ask.op, true))}>
              {t('rest.shell.stripRemove.remove')}
            </button>
          </div>
        </div>
      )}
      {quit && <QuitDialog t={t} sessions={sessions} busy={quit.busy} error={quit.error} details={quit.details} onCancel={() => setQuit(null)} onConfirm={() => void confirmQuit()} />}
      {closeNotice && <CloseNotice t={t} fullQuit={`${label('Meta+Alt+KeyQ', bindings)} or the menu bar icon`} onClose={closeWindow} onCancel={() => setCloseNotice(false)} />}
      <ProjectDialogs core={core} t={t} pt={pt} wt={wt} projects={projectList} onOpen={open} />
      <WorktreeLayer t={t} wt={wt} />
      <LeaderDialog core={core} t={t} />
      {overlay && (
        <Overlay kind={overlay} label={overlay === 'settings' ? t('settings.region') : overlay === 'bots' ? t('bots.title') : t('board.region')} onClose={() => setOverlay(null)}>
          {overlay === 'bots' ? (
            <BotsView key={botFirst ?? ''} core={core} t={t} sessions={sessions} first={botFirst} open={open} onNew={askNewBot} />
          ) : overlay === 'settings' ? (
            <SettingsView core={core} settings={settings} commands={commands.filter((c) => !c.id.startsWith('session.open.') && !fieldCommand(c.id))} update={update} focus={settingsFocus} agent={agentSheet} toast={arrange.notify} hasProject={projectList.length > 0} projects={projectList.map((g) => g.project)} sessions={sessions} current={current} project={projectList[0] ? { path: projectList[0].project, name: projectList[0].name } : null} onClose={() => setOverlay(null)} />
          ) : (
            // A card's session opens as its tab; `open` closes the modal for it.
            renderWidget('board', true, { ...windowCtx(), open }, CENTRE)
          )}
        </Overlay>
      )}
      <NewBot core={core} t={t} projects={projectList.map((g) => g.project)} front={current?.project ?? null} open={open} />
      <HandBot core={core} t={t} list={wt.list} sessions={sessions} team={wt.team} open={open} />
      {palette && <Palette commands={[...commands, ...pluginCommands]} recent={recent.current.filter((id) => id !== active)} bindings={bindings} onClose={() => setPalette(false)} t={t} />}
      {quickOpen && <QuickOpen core={core} root={filesSession?.id ?? null} bindings={bindings} onClose={() => setQuickOpen(false)} t={t} />}
      <PairSheet core={core} /> {/* V2.5-15 */}
      {starting && <NewSession core={core} ordered={ordered} current={current} project={starting.project} machine={starting.machine} prefer={starting.agent} go={starting.go} worktree={starting.worktree} soleProject={projectList.length === 1 ? projectList[0].project : undefined} home={team.home || undefined} bindings={bindings} onStarted={(s, background) => (background ? addTab(s.id) : openStarted(s))} onNote={setPaneNote} onClose={() => setStarting(null)} onReopen={() => void reopen()} onWorktree={wt.made} /> /* v1a-59 */}
      {stopping && byId.get(stopping.id) && (
        <StopAsk name={sessionName(byId.get(stopping.id)!)} error={stopping.error} onCancel={() => setStopping(null)} onStop={() => void stopSession(stopping.id, true)} />
      )}
      {setupAsk && <PermissionSheet core={core} t={t} name={setupAsk} subject="setup" onClose={() => setSetupAsk(null)} onGranted={() => setSetupAsk(null)} />}
      {closing && byId.get(closing.id) && (
        <StopAsk name={sessionName(byId.get(closing.id)!)} error="" onCancel={() => answerClose(false)} onStop={() => answerClose(true)} words={{ title: t('closeAsk.title', { name: sessionName(byId.get(closing.id)!) }), text: t('closeAsk.text'), cancel: t('closeAsk.keep'), stop: t('closeAsk.close') }} />
      )}
      {hints && <Hints copy={hints === 'copy'} bindings={bindings} hintKeys={settings.hintKeys} jump={pj.visible} onStart={toSink} onDone={() => (fromSink(), setHints(false))} onPath={pastePath} onCopied={setCopied} t={t} onLetters={() => commands.find((c) => c.id === 'settings.keys.hintKeys')?.run()} />}
      {copyId && <CopyMode id={copyId} onDone={() => (fromSink(), setCopyId(null))} onCopied={setCopied} onSink={toSink} />}
      <div data-live="copied" role="status">
        {copied !== null && <div className="copied-note">{t(copied ? 'mw.copied' : 'about.copyFailed')}</div>}
      </div>
    </div>
  );
}
