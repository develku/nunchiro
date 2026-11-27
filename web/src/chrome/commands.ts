// Shell: the command list (split out of App.tsx, needs 183).
import { errorNote, notePlain, tipError, type Note } from '../errors';
import { CoreClient } from '../api';
import { sideChatShown } from '../chat/SideChat';
import { hasTranscript } from '../chat/ChatView';
import { threadText } from '../chat/thread';
import { showShell } from '../pane/SidePane';
import { isOpen as paneOpen, maximise as paneMax, show as paneShow, tabOf as paneTab, toggle as paneToggle, usePane } from '../pane/store';
import { add as addSplit, splitsOf } from '../split/store';
import { CARD_OPS, cardCan, runCard } from '../board/cardMenu';
import { editScrollback } from '../terminal/editor';
import { insertPaths } from '../images/nativeDrop'; // ticket 375
import { sessionPath } from '../chat/pending';
import type { Command } from '../keys';
import { splitSessions } from '../split/store'; // ticket 1069
import { DEFAULTS, FIELDS, settingsCommandTitle } from '../settings';
import { HISTORY, PSEUDO, refuses, toggleBars, toggleBarsAuto, where } from '../layout/bars';
import { useArrange } from '../layout/useArrange';
import type { Dir } from '../layout/model';
import { sessionName } from '../Sidebar';
import { listedName } from '../tree';
import { projectCommands } from '../tree/commands';
import { leaderCommands } from '../lead/LeaderDialog'; // ticket 990
import { leadOf, type Team } from '../lead/lead';
import { useWorktrees, worktreeCommands } from '../tree/worktrees';
import { cycleView } from '../chat/view';
import { useProjectTree } from '../tree/state';
import { terminals } from '../Terminal';
import { copyLater, copyText } from '../terminal/clipboard';
import { closeTab as closeBrowserTab, hasStrip, newTab as newBrowserTab, stepTab } from '../pane/browser/view/tabs';
import { findIn } from '../terminal/search';
import { run as runUndo } from '../undo/store';
import type { Decision, Session } from '../types';
import type { useNotifications } from '../queue/notify';
import { waitingOrder } from '../queue/Strip';
import { useBoardItems } from '../queue/board';
import { AGENTS, agentName, handOff } from '../chat/conversation';
import { askNew, quickStartNoted } from '../NewSession';
import { isRoomTab, roomOfTab } from '../room/room';
import { closeTeamTab } from '../lead/team';
import { closeSchedTab, NEW_SCHEDULE, openSchedules, SCHED_TAB } from '../schedule/schedules';
import { closeHistTab, HIST_TAB, openHistory } from '../history/history';
import { BROWSER_TAB, closeBrowserTab as closeCentreBrowser, openBrowserTab } from '../pane/browser/view/centreTab'; // ticket 997 L1
import { agentOff } from '../settings/agents/newDefaults';
import { openDiff } from '../diff/Diff';
import { openPrList } from '../pr/PrView'; // ticket 373
import { copyBuildInfo } from '../features/about';
import type { OverlayKind } from './Overlay';
import { checkNow, rcUpdates } from './rcUpdate';
import { focusSettingsSearch } from '../settings/shell/search';
import { base } from './CentreView';
import { paletteState, sameNameTell } from './paletteState';
import { restartable } from './restart';
import { closeable, closeEnded, stoppable } from './closeEnded';
import { ended } from '../tree/finished'; // ticket 1063
import { entriesOf } from '../tree/Tidy';
import { status } from '../types';
import type { Dispatch, SetStateAction, RefObject } from 'react';
import type { useTabs } from './useTabs';
import type { useDecisionJump } from '../decisions/useDecisionJump';
import type { useRails, useRailFold } from '../layout/useRails';
import type { useBoardRail } from '../board/useBoardRail';
import type { useSplitGlue } from '../split/useSplitGlue';
import type { useComposerSend } from '../chat/useComposerSend';
import type { useSideChats } from '../chat/useSideChats';
import type { useSessionStart } from '../tree/useSessionStart';
import type { usePaneMode } from '../layout/usePaneMode';
import type { useLifetime } from '../settings/lifetime/useLifetime';
import type { useAppSettings } from '../settings/useAppSettings';
import type { useKeySink } from './useGlobalKeys';
import type { Bars } from '../layout/bars';
import { askNewBot } from '../bots/bots';
import { openKnock } from '../queue/Knock';
import { isDirect, setDirect } from '../terminal/direct';

async function detach() {
  if (!('__TAURI_INTERNALS__' in window)) return;
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  await getCurrentWindow().close();
}

type Set<T> = Dispatch<SetStateAction<T>>;
const SIDE: Record<Dir, string> = { left: 'to the left', right: 'to the right', up: 'above', down: 'below' }; // ticket 991 A10: not "to the down"
type Deps = Pick<ReturnType<typeof useTabs>, 'open' | 'resume' | 'cycle' | 'setRenaming' | 'closeTab' | 'closeTabs' | 'shift' | 'lastTab' | 'reopen' | 'canReopen'> &
  Pick<ReturnType<typeof useDecisionJump>, 'jump' | 'back' | 'onAction'> &
  Pick<ReturnType<typeof useRails>, 'openCmd' | 'otherBar' | 'removeIcon' | 'toggleSide' | 'stepSidebarW'> &
  Pick<ReturnType<typeof useRailFold>, 'foldKey' | 'fold' | 'foldOf'> &
  Pick<ReturnType<typeof useBoardRail>, 'toggleBoard'> &
  Pick<ReturnType<typeof useSplitGlue>, 'splitRef'> &
  Pick<ReturnType<typeof useComposerSend>, 'steerNow' | 'backgroundSend'> &
  Pick<ReturnType<typeof useSideChats>, 'openSideChat' | 'sideChats'> &
  Pick<ReturnType<typeof useSessionStart>, 'stop'> &
  Pick<ReturnType<typeof usePaneMode>, 'focusedZone' | 'paneApi'> &
  Pick<ReturnType<typeof useLifetime>, 'setQuit'> &
  Pick<ReturnType<typeof useAppSettings>, 't' | 'setSettings' | 'update' | 'setSettingsFocus'> &
  Pick<ReturnType<typeof useKeySink>, 'toSink'> & {
    ordered: Session[];
    board: ReturnType<typeof useBoardItems>;
    ownerList: Decision[];
    current: Session | null;
    setPalette: (on: boolean) => void;
    setQuickOpen: (on: boolean) => void;
    setOverlay: Set<OverlayKind>; // v25f: Settings and the Board open in the modal
    overlay: OverlayKind;
    setActive: Set<string | null>;
    setHints: (h: false | 'open' | 'copy') => void;
    openStarted: (s: Session) => void; // App's: lists a session this window just started, then opens its tab
    setArmed: (on: boolean) => void;
    setHelpNow: (on: false | 'prefix' | 'all') => void;
    setCopyId: (id: string | null) => void;
    active: string | null;
    editing: boolean;
    setZoom: Set<string | null>;
    sessions: Session[];
    tabs: string[];
    /** Ticket 570: shows a project and its own active tab. */
    selectProject: (project: string) => boolean;
    /** The project whose tabs the strip shows: where a new session starts when the shown tab has no project (a file or imported tab, or none). */
    selected: string | null;
    lastNext: { current: string | null };
    setTermComposer: Set<Record<string, boolean>>;
    setComposerHidden: Set<boolean>;
    composer: RefObject<HTMLTextAreaElement | null>;
    bars: Bars;
    paneSession: Session | null;
    paneState: ReturnType<typeof usePane>;
    setSearchFocus: Set<number>;
    setSessionsAsk: Set<{ n: number; only?: string }>;
    core: CoreClient;
    setPaneNote: (note: Note) => void;
    arrange: ReturnType<typeof useArrange>;
    finish: () => Promise<void>;
    setMessage: (m: { text: string; error: boolean } | null) => void;
    pt: ReturnType<typeof useProjectTree>;
    wt: ReturnType<typeof useWorktrees>;
    projectList: { project: string }[];
    team: Team; // ticket 990
    notify: Pick<ReturnType<typeof useNotifications>, 'setLevel'>; // ticket 1099: the header chip's level as commands
  };

/** The palette's and the keys' command list (each command's id, title, enabled state and run). App memoises it. */
export function buildCommands({ resume, ordered, board, ownerList, current, t, openSideChat, setPalette, setQuickOpen, setOverlay, overlay, open, openStarted, setActive, setSettings, setHints, toSink, setArmed, setHelpNow, setCopyId, active, editing, setZoom, focusedZone, paneApi, sessions, stop, cycle, setRenaming, closeTab, tabs, selectProject, selected, closeTabs, reopen, canReopen, shift, jump, back, lastTab, lastNext, onAction, setQuit, sideChats, setTermComposer, setComposerHidden, composer, steerNow, backgroundSend, openCmd, otherBar, removeIcon, stepSidebarW, bars, paneSession, paneState, foldKey, toggleBoard, setSearchFocus, setSessionsAsk, core, setPaneNote, fold, toggleSide, foldOf, arrange, update, finish, setMessage, splitRef, setSettingsFocus, pt, wt, projectList, team, notify }: Deps): Command[] {
  const waiting = () => waitingOrder(ordered, board, ownerList); // V1A-60b: board and owner items too, in the strip's order
  // Why Restart or Close is off for a session: said in the palette's row (for the current one) and under the item in a row's menu.
  // Look 1117 v13 (A NEW-S3-B): an agent with a conversation resumes it (the composer's button says Resume); a shell restarts.
  const restartTitle = (s?: Session | null) => t(s && s.kind !== 'shell' && s.agent_session_id && restartable(s) ? 'shell.chrome.resumeSession' : 'shell.chrome.restartSession');
  const restartWhy = (s?: Session | null) => (s?.state === 'running' && !s.side_chat ? t('exitWidgets.restartWhy') : s?.folder_gone ? t('walk5.composer.folderGone', { name: sessionName(s) }) : undefined);
  // ⌘W on a Room tab: a place with a lead has its Team view there, which goes back to the side; a plain Room stays (the note says why).
  const closeRoomTab = (folder: string) => {
    const place = team.home && folder === team.home ? '' : folder;
    return leadOf(team, place) ? closeTeamTab(place) : setPaneNote(t('walk7.roomStays'));
  };
  const closeWhy = (s?: Session | null) => (!s ? t('palette.why.noSession') : s.state === 'closed' ? t('look8.closeWhy.done') : s.state === 'running' && !closeable(s) ? t('exitWidgets.closeWhy') : undefined);
  // Eighth look (A): with no browser tab strip on screen these did nothing and were listed as if they would ("Close
  // browser tab" first for "close"). Read when asked, not when built: the list is not redrawn when the strip mounts.
  const strip = (c: Command): Command => Object.defineProperty({ ...c, why: t('look8.noBrowser') }, 'enabled', { get: hasStrip, enumerable: true });
  const tell = sameNameTell(ordered, sessionName, t); // look 1117 v11 A S3-12: two rows of one name tell which is which
  const list: Command[] = [
    ...(sideChatShown(current) ? [{ id: 'session.side-chat', title: t('settings.keys.cmd.sideChat'), run: () => void openSideChat(current) }] : []),
    { id: 'palette.open', title: 'Open command palette', run: () => (setQuickOpen(false), setPalette(true)) }, // ticket 821 round 2: never stacked on the finder
    { id: 'chat.cycleView', title: 'Cycle the chat view', run: cycleView }, // was a chat-local Ctrl+O listener (needs 166)
    { id: 'settings.open', title: 'Open settings', run: () => setOverlay((o) => (o === 'settings' ? null : 'settings')) }, // v25f: ⌘, toggles the modal
    // Ticket 516: ⌘F while Settings is open (keys.ts SETTINGS_ONLY); from the palette it opens Settings, whose box takes the focus.
    { id: 'settings.search', title: 'Search settings', run: () => (overlay === 'settings' ? focusSettingsSearch() : setOverlay('settings')) },
    // Ticket 610: an agent signs in on its Providers card; "sign in" or "로그인" in the palette found nothing that leads there.
    { id: 'providers.signin', title: t('walk5.signIn'), run: () => (setSettings((s) => ({ ...s, settingsPage: 'providers' })), setOverlay('settings')) },
    { id: 'firstrun.open', title: 'First run', run: () => (setSettings((s) => ({ ...s, settingsPage: 'onboarding' })), setOverlay('settings')) }, // ticket 305
    // v1a-39: one terminal font size for every terminal, saved as the Appearance setting (10-20, default 12)
    { id: 'font.bigger', title: 'Terminal font bigger', run: () => setSettings((s) => ({ ...s, termFontSize: Math.min(20, s.termFontSize + 1) })) },
    { id: 'font.smaller', title: 'Terminal font smaller', run: () => setSettings((s) => ({ ...s, termFontSize: Math.max(10, s.termFontSize - 1) })) },
    { id: 'font.reset', title: 'Terminal font default size', run: () => setSettings((s) => ({ ...s, termFontSize: DEFAULTS.termFontSize })) },
    // Ticket 1071: the whole window's zoom, 0.5-2.0 in steps of 0.1 (rounded, so ten steps land on 2 exactly).
    ...([['zoom.in', 0.1], ['zoom.out', -0.1], ['zoom.reset', 0]] as const).map(([id, d]): Command => ({
      id,
      title: t(`settings.kbd.cmd.${id}`),
      run: () => setSettings((s) => ({ ...s, uiZoom: d ? Math.min(2, Math.max(0.5, Math.round((s.uiZoom + d) * 10) / 10)) : DEFAULTS.uiZoom })),
    })),
    { id: 'hints.show', title: 'Show hints', run: () => setHints('open') },
    { id: 'keys.help', title: 'Show the keys you can press next', run: () => (toSink(), setArmed(true), setHelpNow('prefix')) }, // v1a-57
    { id: 'keys.sheet', title: t('coh.cmd.keysSheet'), run: () => (toSink(), setArmed(true), setHelpNow('all')) }, // ticket 1099: ⌘/ lists every key
    { id: 'hints.copy', title: 'Copy a URL, path or git hash from the terminal (hints)', run: () => setHints('copy') }, // v1a-37
    { id: 'terminal.copy', title: 'Copy mode (select terminal text with the keyboard)', run: () => current && terminals.has(current.id) && (toSink(), setCopyId(current.id)) }, // v1a-42
    { id: 'terminal.find', title: 'Find in the terminal', run: () => active && findIn(active) }, // v1a-35
    {
      id: 'zone.zoom',
      title: 'Zoom or restore the focused zone',
      enabled: !editing,
      run: () => setZoom((z) => (z ? null : focusedZone())),
    },
    { id: 'pane.mode', title: 'Pane mode: move, swap and resize zones from the keyboard', enabled: !editing, run: () => paneApi.current.enter() }, // v1a-43
    // Unbound direct chords for the same actions (bind them in Settings > Keys).
    ...(['left', 'down', 'up', 'right'] as Dir[]).flatMap((d): Command[] => [
      { id: `pane.focus.${d}`, title: `Focus the zone ${SIDE[d]}`, enabled: !editing, run: () => paneApi.current.focus(d) },
      { id: `pane.swap.${d}`, title: `Swap this zone with the one ${SIDE[d]}`, enabled: !editing, run: () => paneApi.current.swap(d) },
    ]),
    // v1a-10: a new session like the current one (agent, project), launched with its model and effort.
    // v1a-59: agent and folder, the current session's preselected (its model and effort as V1A-10 did).
    // Look 1117 v7 (S2-2): from a worktree row's menu the argument is that row's folder (menu/surfaces.ts TAKES_WORKTREE): the
    // popover opens with the worktree chosen. It opened on the project's main checkout, and the session started there.
    {
      id: 'session.new',
      title: t('settings.keys.cmd.new'),
      run: (arg) => {
        const l = arg ? wt.list.find((x) => x.path === arg && !x.missing) : undefined;
        if (l) askNew(l.project, undefined, undefined, undefined, { path: l.path, name: listedName(l, sessions) });
        else askNew(current?.project ?? selected ?? undefined);
      },
    },
    // v25-new-tab (ticket 290): the New tab popover's rows as commands, so each has a key (Settings > Keys can rebind them).
    // A session in the current session's project; the browser opens beside a running agent session.
    // Ticket 358: an agent turned off is absent here; quickStart holds for a list read before the switch.
    ...(['shell', 'claude', 'codex'] as const).filter((kind) => !agentOff(kind)).map((kind): Command => ({
      id: kind === 'shell' ? 'session.new.terminal' : `session.new.${kind}`,
      title: t(kind === 'shell' ? 'newtab.cmd.terminal' : kind === 'claude' ? 'newtab.cmd.claude' : 'newtab.cmd.codex'),
      // Ticket 610: on the Room tab (no session tab) it starts in the selected project instead of greying out unexplained.
      enabled: !!(current ?? selected),
      run: () => (current || selected) && quickStartNoted(core, ordered, current, kind, current?.project ?? selected ?? undefined, openStarted, setPaneNote, t),
    })),
    // Ticket 328: My browser's tabs; they act while its strip is on screen (`strip`).
    strip({ id: 'browser.tab.next', title: 'Next browser tab', run: () => hasStrip() && stepTab(1) }),
    strip({ id: 'browser.tab.prev', title: 'Previous browser tab', run: () => hasStrip() && stepTab(-1) }),
    strip({ id: 'browser.tab.close', title: 'Close browser tab', run: () => hasStrip() && closeBrowserTab() }),
    strip({ id: 'browser.tab.new', title: 'New browser tab', run: () => hasStrip() && newBrowserTab() }),
    { id: 'tab.new.browser', title: t('newtab.cmd.browser'), run: openBrowserTab }, // ticket 997 L1 (A6): the owner's own browser as a centre tab
    // Look 1117 v5 (A): an idle shell has no turn to stop: Stop would close it, which is Close session (one action, one name).
    { id: 'session.stop', title: t('settings.keys.cmd.stop'), enabled: stoppable(current), enabledFor: ({ session }) => stoppable(session ? sessions.find((s) => s.id === session) : current), run: () => current && stop(current.id) },
    { id: 'session.next', title: t('settings.keys.cmd.next'), run: () => cycle(1) },
    { id: 'session.prev', title: t('settings.keys.cmd.prev'), run: () => cycle(-1) },
    { id: 'tab.rename', title: t('settings.keys.cmd.rename'), enabled: !!current, run: () => current && setRenaming({ id: current.id, error: '' }) }, // v1a-41
    { id: 'tab.close', title: t('settings.keys.cmd.close'), enabled: !!active || !!overlay, run: () => (overlay ? setOverlay(null) : isRoomTab(active) ? closeRoomTab(roomOfTab(active)!) : active === SCHED_TAB ? closeSchedTab() : active === HIST_TAB ? closeHistTab() : active === BROWSER_TAB ? closeCentreBrowser() : active && closeTab(active)) }, // v25f: with a modal open, ⌘W closes the modal, never the tab hidden behind it // needs 171: acts on the right-clicked tab (the menu makes it active first), else the active one
    // Absent (not greyed) with one tab. One Undo restores them all.
    ...(tabs.length > 1 ? [{ id: 'tab.close.others', title: t('settings.keys.cmd.closeOthers'), run: () => active && closeTabs(tabs.filter((id) => id !== active)) }] : []),
    // v25-tab-menu-close (ticket 215 B20): the right-clicked tab is the active one when these run. Greyed (not absent) when nothing would close.
    {
      id: 'tab.close.right',
      title: t('tabmenu.closeRight'),
      enabled: !!active && tabs.indexOf(active) < tabs.length - 1,
      why: t(active ? 'palette.why.lastTab' : 'palette.why.noSession'), // look 1117 v12 A-S3-F: says why, not "Not available here"
      enabledFor: ({ session }) => { const i = tabs.indexOf(session ?? active ?? ''); return i >= 0 && i < tabs.length - 1; },
      run: () => active && closeTabs(tabs.slice(tabs.indexOf(active) + 1)),
    },
    { id: 'tab.close.all', title: t('tabmenu.closeAll'), enabled: tabs.length > 0, enabledFor: () => tabs.length > 0, run: () => closeTabs(tabs) },
    // ticket 299: the closed tabs of this window, newest first (chrome/closedTabs.ts); disabled with its reason when none was closed.
    { id: 'tab.reopen', title: t('reopen.cmd'), enabled: canReopen, enabledFor: () => canReopen, why: canReopen ? undefined : t('reopen.none'), run: () => void reopen() },
    { id: 'tab.move.left', title: t('settings.keys.cmd.moveLeft'), run: () => shift(-1) },
    { id: 'tab.move.right', title: t('settings.keys.cmd.moveRight'), run: () => shift(1) },
    { id: 'decision.back', title: 'Back to the session before a decision jump', enabled: !!jump, run: back }, // V2-8e
    { id: 'session.last', title: t('settings.keys.cmd.last'), run: () => { const b = lastTab.current.before; if (b && tabs.includes(b)) setActive(b); } }, // v1a-37: a closed one is skipped
    ...Array.from({ length: 9 }, (_, i) => ({
      id: `session.jump.${i + 1}`,
      title: t('settings.keys.cmd.jump', { n: i + 1 }),
      ...(i === 0 ? { group: t('settings.keys.cmd.jumpAll') } : {}),
      run: () => tabs[i] && setActive(tabs[i]),
    })),
    // Ticket 570: the tree's projects in the order shown; each keeps its own tabs and its own active tab.
    ...Array.from({ length: 9 }, (_, i) => ({
      id: `project.jump.${i + 1}`,
      title: t('settings.keys.cmd.projectJump', { n: i + 1 }),
      ...(i === 0 ? { group: t('settings.keys.cmd.projectJumpAll') } : {}),
      run: () => projectList[i] && selectProject(projectList[i].project),
    })),
    {
      id: 'waiting.next',
      title: 'Next waiting item',
      run: () => {
        const items = waiting();
        if (!items.length) return;
        // From the item it last brought up while that is still in view (a board or owner item has no session tab),
        // else from the active session's item.
        const last = items.findIndex((d) => d.id === lastNext.current && (!d.session_id || d.session_id === active));
        const d = items[((last >= 0 ? last : items.findIndex((d) => d.session_id === active)) + 1) % items.length];
        lastNext.current = d.id;
        onAction(d);
      },
    },
    { id: 'quit.all', title: 'Quit and stop all agents', run: () => setQuit({ busy: false, error: '' }) },
    // v2-3b: as the picker's lower group; the chip waits for Enter.
    ...AGENTS.filter((k) => !agentOff(k)).map((k) => ({ id: `handoff.${k}`, title: `Hand off to ${agentName(k)}`, enabled: !!current && current.state === 'running' && current.kind !== 'shell' && current.kind !== k && !current.side_chat && !sideChats.includes(current.id), run: () => current && handOff(current.id, k) })),
    { id: 'window.detach', title: 'Detach window (agents keep running)', run: () => void detach() },
    { id: 'composer.toggle', title: 'Hide or show the composer (terminal-only view)', run: () => (current && !hasTranscript(current) ? setTermComposer((m) => ({ ...m, [current.id]: !m[current.id] })) : setComposerHidden((h) => !h)) },
    // v25-sendkeys: the composer's two Enters; from the palette they work on what is in the box now.
    { id: 'composer.steerNow', title: 'Send the composer’s text now (Claude takes it at its next step; other agents stop the running turn)', enabled: !!current, run: () => composer.current && void steerNow(composer.current, current) },
    { id: 'composer.backgroundSend', title: 'Send as new session, stay here', enabled: !!composer.current, run: () => composer.current && void backgroundSend(composer.current, current) },
    // v1b-09: focus.tree reaches the Files tree too; files.show toggles the ▤ dock
    {
      id: 'focus.tree',
      title: 'Focus the tree',
      run: () => {
        // The Files tree counts too; with neither on screen, the Tree opens first.
        const target = () => document.querySelector<HTMLElement>('.ftree [tabindex="0"], .tree button');
        if (target()) return target()!.focus();
        openCmd('tree')();
        setTimeout(() => target()?.focus(), 0);
      },
    },
    { id: 'files.show', title: 'Show or hide Files', run: openCmd('files', true) },
    { id: 'files.quickOpen', title: 'Go to file', run: () => (setPalette(false), setQuickOpen(true)) }, // ticket 821
    // v1a-65, D5b: the widget's icon goes to the other bar (the same move as Alt+Left or Right on its icon in Layout).
    { id: 'files.dock.side', title: 'Move Files to other side', run: () => otherBar('files') },
    { id: 'search.dock.side', title: 'Move Search to other side', run: () => otherBar('search') },
    // system5 (ticket 196): the rail icon's right-click menu (data-menu="icon", data-menu-arg = the widget). A required widget cannot be hidden;
    // Settings, Layout and Browser are not widgets, so they cannot open as a split.
    { id: 'icon.hide', title: t('shell.menu.iconHide'), enabled: false, enabledFor: ({ arg }) => !!arg && !!where(bars, arg) && !refuses(arg, 'remove', t), run: (arg) => arg && removeIcon(arg) },
    { id: 'icon.move', title: t('shell.menu.iconMove'), enabled: false, enabledFor: ({ arg }) => !!arg && !!where(bars, arg), run: (arg) => arg && otherBar(arg) },
    { id: 'icon.split', title: t('shell.menu.iconSplit'), enabled: false, enabledFor: ({ arg }) => !!arg && !!current && !PSEUDO.includes(arg) && arg !== HISTORY, run: (arg) => current && arg && void addSplit(current.id, 'right', arg) },
    // v1a-48: the icons without a command get one, so each icon's hint key is its shortcut's key.
    { id: 'artifacts.toggle', title: 'Show or hide Artifacts', run: openCmd('artifacts', true) },
    { id: 'preview.toggle', title: 'Show or hide Preview (the side pane’s Preview tab)', enabled: !!paneSession, run: () => paneSession && (paneOpen(paneState, paneSession.id) && paneTab(paneState, paneSession.id) === 'preview' ? paneToggle(paneSession.id) : paneShow(paneSession.id, 'preview')) },
    { id: 'board.toggle', title: 'Show or hide the board', run: () => (foldKey.board ? fold.unfold(foldKey.board) : toggleBoard()) }, // v25f: a folded Board zone first, else the modal
    // needs 171 (board r7): the card menu's items. Only a card or list row carries the key (data-menu-arg), so the palette greys them;
    // the placed Board says which ones the card can take and runs them (board/cardMenu.ts).
    ...CARD_OPS.map((op) => ({ id: `board.card.${op}`, title: t(`board.menu.${op}`), enabled: false, enabledFor: ({ arg }: { arg?: string }) => cardCan(arg, op), why: op === 'next' ? t('board.watch.move.nextWhy') : op === 'prev' ? t('board.watch.move.prevWhy') : undefined, run: runCard(op) })),
    { id: 'search.open', title: 'Search the focused session’s folder', run: () => (openCmd('search')(), setSearchFocus((n) => n + 1)) }, // v1b-10; v1a-60 unfolds
    { id: 'search.sessions', title: 'Search sessions (the chats of every session started in Nunchiro)', run: () => (openCmd('search')(), setSessionsAsk((a) => ({ n: a.n + 1 }))) }, // v2-7
    // Q7 point 15: the same Sessions search, scoped to the current chat; and the whole chat as text on the clipboard.
    { id: 'chat.find', title: 'Find in this chat', enabled: !!current && hasTranscript(current), run: () => current && (openCmd('search')(), setSessionsAsk((a) => ({ n: a.n + 1, only: current.id }))) },
    { id: 'chat.copyThread', title: 'Copy the whole chat', enabled: !!current && hasTranscript(current), run: () => { if (!current) return; const text = threadText(core, current, t); void Promise.all([text, copyLater(text)]).then(([, ok]) => { if (!ok) throw new Error('the clipboard refused the text'); }).then(() => setPaneNote(t('mw.copied')), (e) => setPaneNote(errorNote(t('err.note.copyThread', { error: notePlain(t, e) }), e))); } },
    { id: 'knock.open', title: t('settings.kbd.cmd.knock.open'), enabled: !!current, run: () => current && openKnock(current.id) },
    { id: 'focus.composer', title: 'Focus the composer', run: () => (setComposerHidden(false), current && !hasTranscript(current) && setTermComposer((m) => ({ ...m, [current.id]: true })), setTimeout(() => composer.current?.focus(), 0)) },
    // Type in terminal: the session whose terminal shows (the side pane's, else the tab's); its terminal takes the focus.
    { id: 'terminal.direct', title: t('settings.kbd.cmd.terminal.direct'), enabled: !!(paneSession ?? current) && ['claude', 'codex'].includes((paneSession ?? current)!.kind), run: () => { const s = paneSession ?? current; if (!s) return; setDirect(core, s.id, !isDirect(s.id)); if (paneSession) paneShow(paneSession.id, 'pty', true); else terminals.get(s.id)?.focus(); } },
    { id: 'focus.terminal', title: t('settings.kbd.cmd.focus.terminal'), /* look 1117 v3: the row menu showed it in English */ run: () => (paneSession ? paneShow(paneSession.id, 'pty', true) : active && terminals.get(active)?.focus()) },
    { id: 'terminal.clear', title: 'Clear the terminal (window copy only)', enabled: !!active, run: () => active && terminals.get(active)?.clear() }, // v1a-38
    // v1a-38b: the core writes the file and starts the editor session, which takes the focus.
    {
      id: 'terminal.edit',
      title: 'Open the scrollback in $EDITOR',
      enabled: !!current,
      run: () =>
        current &&
        void editScrollback(core, current.id).then(
          (r) => (open(r.session.id), setPaneNote(r.truncated ? 'Scrollback opened: only its newest 1 MiB was kept' : '')),
          (e) => setPaneNote(errorNote(t('err.note.scrollback', { error: notePlain(t, e) }), e)),
        ),
    },
    // v25-shell-chrome (ticket 283): the shared Sidebar width, a step at a time (keyboard-first, needs 25).
    { id: 'sidebars.wider', title: t('shell.chrome.sidebarsWider'), run: () => stepSidebarW(1) },
    { id: 'sidebars.narrower', title: t('shell.chrome.sidebarsNarrower'), run: () => stepSidebarW(-1) },
    // Look 1117 v7 (S2-1): Restart is for an ended session (`restartable`). On a running one it is listed off; the palette's
    // row says why, and so do the row and tab menus (the item's tooltip, and the status line when it is pressed: it was
    // greyed with no reason and read as a dead item).
    // v25-shell-chrome (ticket 282 item 2): an ended session's tab is read-only; this starts it again (the tab follows the new session).
    // Ticket 286 item 2 (lane J) reuses this entry point (`resume` in useTabs, `restartable` in chrome/restart.ts).
    { id: 'session.restart', title: restartTitle(current), titleFor: ({ session }) => restartTitle(session ? sessions.find((x) => x.id === session) : current), enabled: !!current && restartable(current), why: restartWhy(current), whyFor: ({ session }) => restartWhy(session ? sessions.find((x) => x.id === session) : current), enabledFor: ({ session }) => { const s = session ? sessions.find((x) => x.id === session) : current; return !!s && restartable(s); }, run: () => current && restartable(current) && void resume(current) },
    // v25-exit-widgets (ticket 286 item 2, needs 207): Stop is for a running session; an ended one is closed here (Undo for 10 s).
    { id: 'session.close', title: t('exitWidgets.closeSession'), enabled: !!current && closeable(current), why: closeWhy(current), whyFor: ({ session }) => closeWhy(session ? sessions.find((x) => x.id === session) : current), enabledFor: ({ session }) => { const s = session ? sessions.find((x) => x.id === session) : current; return !!s && closeable(s); }, run: () => current && closeable(current) && void closeEnded(core, current, t, setPaneNote) },
    // Real-app 11-10 defect J (r2): as the bar's hide / show button, through the same toggleSide: a folded side hides, never unfolds first.
    { id: 'sidebar.left.toggle', title: 'Show or hide the left sidebar', run: () => toggleSide('left') },
    { id: 'sidebar.right.toggle', title: t('shell.chrome.sidebarRightToggle'), run: () => toggleSide('right') },
    { id: 'bars.toggle', title: t('shell.chrome.barsToggle'), run: () => setSettings((s) => ({ ...s, bars: toggleBars(s.bars) })) }, // v25f F13
    { id: 'bars.autohide', title: t('shell.chrome.autoHideBars'), run: () => setSettings((s) => ({ ...s, bars: toggleBarsAuto(s.bars) })) }, // ticket 1047
    // v1b-11: `diff.open <path>` for other widgets; from the palette or a key it opens the list.
    { id: 'diff.open', title: t('settings.kbd.cmd.diff.open'), run: (path?: string) => (foldOf('diff') && fold.unfold(foldOf('diff')!), openDiff(path)) },
    { id: 'pr.list', title: t('prChecks.openList'), run: () => openPrList(t) }, // ticket 373: no chip or session needed
    // system4: the path and message menus hand their `data-menu-arg` here (a string: clipboard or opener only). Run without one (palette) they do nothing.
    { id: 'path.copy', title: t('shell.menu.pathCopy'), enabled: false, enabledFor: ({ arg }) => !!arg, run: (arg) => arg && void copyText(arg) },
    { id: 'path.reveal', title: t('shell.menu.pathReveal'), enabled: false, enabledFor: ({ arg }) => !!arg && arg.startsWith('/') && '__TAURI_INTERNALS__' in window, run: (arg) => arg && arg.startsWith('/') && '__TAURI_INTERNALS__' in window && void import('@tauri-apps/plugin-opener').then((o) => o.revealItemInDir(arg)).catch(() => {}) },
    // Ticket 375: a Files row's path into the composer as @path (relative to the session's folder when inside it); never sends.
    { id: 'file.mention', title: t('files.addToChat'), enabled: false, enabledFor: ({ arg }) => !!arg && !!current, run: (arg) => { if (!arg || !current) return; setComposerHidden(false); if (!hasTranscript(current)) setTermComposer((m) => ({ ...m, [current.id]: true })); setTimeout(() => { const box = composer.current?.closest<HTMLElement>('.cbox'); if (box) insertPaths(box, [sessionPath(arg, current.cwd) ?? arg]); }, 0); } },
    { id: 'message.copy', title: t('shell.menu.messageCopy'), enabled: false, enabledFor: ({ arg }) => !!arg, run: (arg) => arg && void copyText(arg) },
    { id: 'layout.edit', title: 'Edit layout', run: () => arrange.begin() },
    { id: 'titlebar.show', title: 'Show title bar', run: () => update({ titleBar: 'always' }) }, // D5b A33
    { id: 'layout.done', title: 'Finish editing the layout (Done)', enabled: editing, why: t('palette.why.notEditing'), run: () => void finish() },
    { id: 'layout.cancel', title: 'Cancel layout edit', enabled: editing, why: t('palette.why.notEditing'), run: () => arrange.cancel() },
    { id: 'layout.reset', title: 'Reset layout', run: () => void arrange.resetAll() },
    { id: 'layout.undo', title: 'Undo layout change', run: () => void arrange.undo().catch((e: Error) => setMessage({ text: tipError(t, e), error: true })) },
    { id: 'undo.last', title: 'Undo last action', run: () => void runUndo() }, // V2-6a
    // AGENTVIEW: the current agent session's side pane (⌘J, the Right bar's Terminal icon).
    { id: 'pane.toggle', title: 'Show or hide the side pane (PTY, shells, browser, preview)', enabled: !!paneSession, run: () => paneSession && paneToggle(paneSession.id) },
    { id: 'pane.maximize', title: 'Maximize or restore the side pane', enabled: !!paneSession && paneOpen(paneState, paneSession.id), run: () => paneSession && paneOpen(paneState, paneSession.id) && paneMax(paneSession.id) },
    { id: 'split.right', title: 'Split right', run: () => splitRef.current.split('right') }, // SPLITKEYS
    { id: 'split.down', title: 'Split down', run: () => splitRef.current.split('down') },
    { id: 'split.left', title: 'Split left', run: () => splitRef.current.split('left') },
    { id: 'split.up', title: 'Split up', run: () => splitRef.current.split('up') },
    // Look 1117 v12 (A S3-B): with no split open it did nothing and was listed as if it would; off, with its reason. Read when
    // asked (as `strip`): opening a split does not rebuild the list.
    // Ticket 1069: the tab drag's menu and palette way. From the tab menu (its data-menu-arg) the menu's tab moves into a split
    // of the view shown before the menu made it active; from the palette the tab shown before this one moves beside this one.
    ...(['right', 'down'] as const).map((side) => {
      const pair = (arg?: string) => {
        const before = lastTab.current.before;
        const moved = arg ?? before;
        const host = moved === active ? before : active;
        const ok = (id: string | null): id is string => !!id && tabs.includes(id) && sessions.some((s) => s.id === id);
        return ok(moved) && ok(host) && moved !== host && !splitSessions().includes(moved) ? { moved, host } : null;
      };
      return {
        id: `tab.split.${side}`,
        title: side === 'right' ? 'Move tab to split right' : 'Move tab to split below',
        get enabled() {
          return !!pair();
        },
        enabledFor: ({ arg }: { arg?: string }) => !!pair(arg),
        run: (arg?: string) => {
          const p = pair(arg);
          if (p) addSplit(p.host, side, `session:${p.moved}`, true);
        },
      };
    }),
    Object.defineProperty({ id: 'split.close', title: 'Close the focused split', why: t('look8.noSplit'), run: () => splitRef.current.close() }, 'enabled', { get: () => !!current && splitsOf(current.id).length > 0, enumerable: true }),
    { id: 'pane.shell.new', title: 'New shell in the side pane (this session’s folder)', enabled: !!paneSession, run: () => {
      if (paneSession) showShell(core, paneSession, sessions, setPaneNote); // ticket 1130 C4
    } },
    { id: 'about.copy', title: t('about.copyBuild'), run: () => void copyBuildInfo() }, // ticket 262: the About page's support line
    // G2: only in a build that updates itself. A newer build shows in the status bar; nothing newer or a failure (ticket 377) is a short note.
    ...(rcUpdates() ? [{ id: 'rc.update.check', title: t('rc.update.check'), run: () => {
      const note = (text: Note) => (setPaneNote(text), typeof text === 'string' && setTimeout(() => setPaneNote(''), 4000)); // a failure stays (476)
      void checkNow().then((v) => void (!v && note(t('rc.update.none'))), (e: string) => void note(errorNote(t('rc.update.checkFailed', { error: notePlain(t, e) }), e)));
    } }] : []),
    // v1a-57 (needs 69): every setting from the palette, opening its page focused on the field.
    ...FIELDS.map((f) => ({
      id: `settings.${f.page}.${f.key}`,
      title: settingsCommandTitle(t, f.key),
      run: () => (setSettings((s) => ({ ...s, settingsPage: f.page })), setOverlay('settings'), setSettingsFocus((d) => ({ key: f.key, n: (d?.n ?? 0) + 1 }))),
    })),
    ...projectCommands(pt, current, sessions, t, team.teammates.some((m) => !m.project) ? team.home : ''), // V2-9a: group.*, project.pin, tree.expand-all, projects.pick
    // A row menu offers "Hand to a bot…" only once there is a bot: with none, the tree's menus are as they were.
    ...worktreeCommands(wt, current, projectList[0]?.project ?? null, t).map((c) => (c.id === 'worktree.hand' && !team.teammates.length ? { ...c, menu: false } : c)), // V2-8a; rc2b-fb: with the window's language
    ...leaderCommands(pt, current, team, t), // ticket 990: Add a leader to this project…
    // Ticket 473: translated; Palette's rank reads `name`, not the title's shape.
    ...ordered.map((s) => ({ id: `session.open.${s.id}`, title: t('palette.goTo', { name: sessionName(s), project: base(s.project) }) + tell(s), name: sessionName(s), state: paletteState(s), branch: wt.list.find((l) => l.path === s.cwd)?.branch || undefined, run: () => open(s.id) })),
    // Ticket 1063: a project's finished work leaves in one go. Ended sessions close (each with its Undo; a failed one keeps its
    // row), then the Tidy panel's merged, empty and gone worktrees go (branch kept, Undo). A worktree with uncommitted files
    // or unpushed commits is never touched: the note names it. The head menu hands the project (TAKES_PROJECT); the palette takes the current one.
    { id: 'tree.clear-finished', title: t('tree.cmd.clearFinished'), enabled: !!current, why: t('palette.why.noProject'), enabledFor: ({ arg }) => !!arg || !!current, run: (arg?: string) => {
      const project = arg ?? current?.project;
      if (!project) return;
      const mine = sessions.filter((s) => s.project === project && !s.machine);
      const closing = mine.filter((s) => ended(s) && closeable(s) && status(s) !== 'failed');
      const entries = entriesOf(t, wt.list.filter((l) => l.project === project), wt.facts, mine.map((s) => (closing.includes(s) ? { ...s, state: 'closed' as const } : s)));
      // Rule 4 (1063): unpushed commits are kept too, though Tidy's commits-only remove would keep the branch.
      const held = entries.filter((e) => e.kind === 'dirty' || (e.l.facts?.unpushed ?? 0) > 0);
      const kept = held.map((e) => listedName(e.l, sessions));
      if (kept.length) setPaneNote(t('tree.clearKept', { names: kept.join(', ') }));
      void Promise.all(closing.map((s) => closeEnded(core, s, t, setPaneNote))).then(() => wt.tidy(entries.filter((e) => !held.includes(e)).map((e) => e.l.path)));
    } },
    { id: 'history.open', title: t('history.open'), run: () => openHistory() }, // ticket 1073: History without its icon
    // Ticket 1099 (feature cohesion): the places that had no palette row, each opened the way its icon or page opens it.
    ...(['usage', 'team', 'assistants'] as const).map((page): Command => ({ id: `${page}.page`, title: t(`coh.cmd.${page}Page`), run: () => (setSettings((s) => ({ ...s, settingsPage: page })), setOverlay('settings')) })),
    { id: 'bots.open', title: t('bots.cmd.open'), run: () => setOverlay('bots') }, // ticket 1168
    { id: 'bots.new', title: t('bots.cmd.new'), run: askNewBot },
    { id: 'decisions.open', title: t('coh.cmd.decisions'), run: openCmd('decisions') }, // the Outbox's cards are in Decisions
    { id: 'schedules.open', title: t('coh.cmd.schedules'), run: () => openSchedules() },
    { id: 'schedules.new', title: t('coh.cmd.scheduleNew'), run: () => openSchedules(NEW_SCHEDULE) },
    { id: 'context.open', title: t('coh.cmd.context'), run: openCmd('context') }, // was only in the Layout library
    // Ids and titles say "alerts", not "notifications" or "mute": those words find Settings > Notifications first (palette-names.spec).
    ...([['all', 'all'], ['waiting', 'waiting'], ['off', 'muted']] as const).map(([word, level]): Command => ({ id: `notify.session.${word}`, title: t(`coh.cmd.alerts.${word}`), enabled: !!current, why: t('palette.why.noSession'), run: () => current && notify.setLevel(current.id, level) })),
  ];
  return list;
}
