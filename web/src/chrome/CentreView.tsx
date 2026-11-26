// Shell: the centre view (the terminal widget) (split out of App.tsx, needs 183).
import { PLAIN } from '../plainText';
import { useCallback, useEffect, useRef, useState, type ReactNode, type Dispatch, type SetStateAction, type RefObject } from 'react';
import { CoreClient, type Boot } from '../api';
import { SideChat, sideChatShown } from '../chat/SideChat';
import { ChatPanes, hasTranscript } from '../chat/ChatView';
import { TeamOpen } from '../chat/Rows';
import { SidePane } from '../pane/SidePane';
import { SplitHost } from '../split/SplitHost';
import { add as addSplit, ptyInSplit, remove as removeSplit, replace as replaceSplit, sessionOf, splitsOf } from '../split/store';
import { Preview, tabHit, type TabHit } from '../split/Overlay';
import { createPortal } from 'react-dom';
import { label, merge } from '../keys';
import { jumpChip } from './useHeldKeys';
import { PermissionNeeded } from '../PermissionNeeded';
import { HolderLine } from '../queue/HolderLine';
import { ProblemCard } from '../chat/ProblemCard';
import { LimitBand } from '../chat/LimitBand'; // ticket 372
import { useTheme } from '../themes/apply';
import { where } from '../layout/bars';
import { Icon } from '../icons/Icon';
import { renderWidget, type WindowCtx } from '../layout/windows';
import { sessionName } from '../Sidebar';
import { ownBranch } from '../tree';
import { TerminalView } from '../Terminal';
import { SessionFacts, useDiffStat } from './SessionFacts';
import { ChromeIcon } from './icons';
import { AgentLogo } from '../tree/AgentLogo';
import { RowIcon } from '../tree/RowIcon';
import { noCheckout, shownStatus, statusKey, type Session } from '../types';
import { NotifyLevel, useNotifications } from '../queue/notify';
import { Landing } from '../firstrun/Landing';
import { chain, tabStatus } from '../chat/conversation';
import { askNew } from '../NewSession';
import { openDiff } from '../diff/Diff';
import { FileView } from '../files/FileView';
import { baseName, fileOfTab, isFileTab } from '../files/open';
import { importedOfTab, importedTitle, isImportedTab } from '../firstrun/imported';
import { ImportedChat } from '../firstrun/ImportedChat';
import { useTabs } from './useTabs';
import { RoomView } from '../room/RoomView'; // ticket 571
import { isRoomTab, roomOfTab, roomTabId, useRoom } from '../room/room';
import { leadOf, leadSeatMate, placeOfMate, seatOf, useTeam, workingFor } from '../lead/lead'; // ticket 990
import { TeamChip, TeamLine } from '../lead/LeadHead';
import { Face } from '../bots/Face'; // ticket 1168
import { eyesOf } from '../bots/bots';
import { FreshButton, FreshToast } from '../lead/LeaderDialog';
import { useDigest } from '../lead/HomeParts';
import { useTasks, withMerges } from '../lead/tasks';
import { closeTeamTab, focusTeam, onShowTeamTab, showTeamTab, useTeamAt } from '../lead/team'; // owner 11-17
import { TeamView } from '../lead/TeamView';
import { closeSchedTab, onShowSchedTab, SCHED_TAB, useSchedAt } from '../schedule/schedules'; // ticket 993
import { SchedulesView } from '../schedule/SchedulesView';
import { closeHistTab, HIST_TAB, onShowHistTab, useHistAt } from '../history/history'; // ticket 1022
import { HistoryView } from '../history/HistoryView';
import { BROWSER_TAB, closeBrowserTab, onShowBrowserTab, useBrowserTab } from '../pane/browser/view/centreTab'; // ticket 997 L1
import { BrowserSpaces } from '../pane/browser/view/BrowserView';
import { YOU_SPACE } from '../pane/browser/view/spaces';
import { Icon as WidgetIcon } from '../layout/icons';
import { teamWaiting } from '../tree/decisions';
import { LevelChip } from '../lead/level'; // ticket 992
import { kindOf } from '../layout/model';
import { useScrollKeep } from './scrollKeep';
import { useSplitGlue } from '../split/useSplitGlue';
import { insertQuote } from '../chat/ComposerWidget';
import type { Key, T } from '../i18n';
import type { Bars } from '../layout/bars';
import type { Settings } from '../settings';

export const base = (p: string) => p.replace(/\/+$/, '').split('/').pop() || p;

/** needs 130 (header_no_uuid): the project and place the session header and the composer chip show, never a folder name
 *  or a raw id. A session in a worktree folder reads that worktree's branch (its repo project, not the folder); one in a
 *  `session start --worktree` folder, named by the session's id on its made-up `nunchiro/<folder>` branch, reads the session's own name. */
export const place = (list: { project: string; path: string; branch: string }[], s: Session, main = 'main') => {
  const w = list.find((l) => l.path === s.cwd);
  // Q6 C13: `main` is the tree's own word for the checkout (t('tree.main')), so the header and the tree agree.
  // Look 1117 v7 (S2-3): a folder under no repository has no checkout: no place, and `placeText` then says the project alone
  // (a plain folder read "plain-folder / main", as if it were on a branch named main).
  return w ? { project: base(w.project), place: ownBranch(w) || sessionName(s) } : { project: base(s.project), place: s.cwd === s.project ? (noCheckout(s) ? '' : main) : sessionName(s) };
};

/** WCAG 1.4.1: your turn, broken and limited carry the tree rows' hand, x-circle and clock, not only a colour (ticket 293 round 3). */
const markGlyph = (st: string) => (st === 'waiting' ? <RowIcon kind="hand" /> : st === 'failed' ? <RowIcon kind="fail" /> : st === 'limited' ? <RowIcon kind="limit" /> : null);

/** The tab's name as a text field: Enter saves (not while an IME composes), Escape or leaving cancels. */
function RenameField({ t, name, initial, error, onSave, onCancel }: { t: T; name: string; initial: string; error: string; onSave: (text: string) => void; onCancel: (focusBack: boolean) => void }) {
  const [text, setText] = useState(initial);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => void (input.current?.focus(), input.current?.select()), []);
  return (
    <span className="rename">
      <input {...PLAIN}
        ref={input}
        value={text}
        aria-label={t('rest.st.rename', { name })}
        aria-invalid={!!error}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => onCancel(false)}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          if (e.key === 'Enter') onSave(text);
          if (e.key === 'Escape') onCancel(true);
        }}
      />
      {error && (
        <span className="terr" role="alert">
          {error}
        </span>
      )}
    </span>
  );
}

type Set<T> = Dispatch<SetStateAction<T>>;
type Props = { pin?: string } & Pick<ReturnType<typeof useTabs>, 'renaming' | 'setRenaming' | 'focusTab' | 'closeTab' | 'dragTab' | 'moveTab' | 'rename' | 'moved' | 'jumps'> &
  Pick<ReturnType<typeof useSplitGlue>, 'pickSplit' | 'pinSplit' | 'closeSplit' | 'splitState'> & {
    t: T;
    projectCount: number;
    tabs: string[];
    /** Ticket 570: the strip's tabs (the selected project's); `tabs` is every project's and all of them stay mounted. */
    shown: string[];
    /** Ticket 570: the shown project, where `+` starts a session when the active tab has none. */
    project: string | null;
    byId: Map<string, Session>;
    sessions: Session[];
    /** Inventory N012: `sessions` as Decisions lists them (tree/decisions.ts `withoutFront`); the Team chip and tab badge count these. */
    deciding: Session[];
    active: string | null;
    setActive: Set<string | null>;
    current: Session | null;
    core: CoreClient;
    placeText: (s: Session) => string;
    openSideChat: (source: Session) => Promise<void>;
    headStat: ReturnType<typeof useDiffStat>;
    bars: Bars;
    notify: ReturnType<typeof useNotifications>;
    sideChats: string[];
    connected: boolean;
    setTabs: Set<string[]>;
    open: (id: string) => void;
    windowCtx: () => WindowCtx;
    boot: Boot;
    stripShows: string | null;
    composerView: (first: boolean, pin?: string) => ReactNode;
    settings: Settings;
    bindings: ReturnType<typeof merge>;
    run: (id: string) => void;
    termTheme: ReturnType<typeof useTheme>;
    paneSession: Session | null;
    composer: RefObject<HTMLTextAreaElement | null>;
    pinned: (pin: string) => Session | null;
  };

/** Ticket 1145 round 3: focus a shown chat may take: on nothing, or still on what opened it (a tree row, a tab, the chat).
 *  WebKit (the app's own view) does not focus a clicked button: the click focuses its pane zone (`.lz`, tabindex -1)
 *  instead, which counts as nothing. */
const openerHolds = (el: Element | null) =>
  !el || el === document.body || el.matches('section.lz') || (!!el.closest('.tree, [role="tablist"], .chat, .cbox') && !el.closest('.peek, .kidpeek, [role="menu"], [role="dialog"], [role="listbox"], input, [contenteditable="true"], [contenteditable=""]'));

/** The terminal widget: the session tab strip, the session head and the session's panes (chat, terminal,
 *  file and imported tabs, splits, side pane); with a pin, that one session's terminal. */
export function CentreView({ pin, t, projectCount, tabs, shown: strip, project, byId, sessions, deciding, active, setActive, renaming, setRenaming, focusTab, closeTab, dragTab, moveTab, rename, moved, jumps, current, core, placeText, openSideChat, headStat, bars, notify, sideChats, connected, setTabs, open, windowCtx, boot, composerView, pickSplit, pinSplit, closeSplit, splitState, settings, bindings, run, termTheme, paneSession, composer, pinned }: Props) {
  // Ticket 571: the shown project's Room tab. The room is polled while the project is shown, so the tab's badge counts what
  // came for the person since the Room was last open.
  // Ticket 990: a lead's seat and the sessions of its team; with no lead teammate nothing below draws.
  const team = useTeam(core, connected);
  const wtc = windowCtx().wt;
  const leadMate = leadSeatMate(current, team);
  const seatMate = current?.teammate ? team.teammates.find((m) => m.id === current.teammate) : undefined;
  const seatLive = seatMate ? seatOf(sessions, seatMate.id) : null;
  // Ticket 1145 (after T3 Code ChatView.tsx, focus on thread show and on window focus): a chat session that shows (tree,
  // tab, start, a new conversation) takes its composer, and so does the window coming back with one in front. Arrow travel
  // in the strip keeps the strip; a shell keeps its terminal; nothing moves while an IME composition runs.
  const composing = useRef(false);
  const stay = useRef<string | null>(null);
  const chatShown = !pin && hasTranscript(current) ? current!.id : null;
  useEffect(() => {
    const on = (e: Event) => void (composing.current = e.type === 'compositionstart');
    document.addEventListener('compositionstart', on, true);
    document.addEventListener('compositionend', on, true);
    return () => (document.removeEventListener('compositionstart', on, true), document.removeEventListener('compositionend', on, true));
  }, []);
  useEffect(() => {
    const kept = stay.current === chatShown;
    stay.current = null;
    if (!chatShown || kept) return;
    // A frame later, after the opener's own focus moves (the waiting strip's Open focuses its card, a peek its box): only
    // focus still on an opener (a tree row, a tab, the chat) or on nothing moves to the composer.
    const frame = requestAnimationFrame(() => void (composing.current || (openerHolds(document.activeElement) && composer.current?.focus())));
    return () => cancelAnimationFrame(frame);
  }, [chatShown, composer]);
  useEffect(() => {
    if (!chatShown) return;
    let frame = 0;
    // The window gives focus back to its last element after this event: two frames, then only from nowhere (body). Narrower
    // than T3 Code's rule: a Tab walk out of the page and back fires this too, and the element it reached keeps its focus.
    const on = () => (cancelAnimationFrame(frame), (frame = requestAnimationFrame(() => (frame = requestAnimationFrame(() => void (composing.current || (document.activeElement && document.activeElement !== document.body) || composer.current?.focus()))))));
    window.addEventListener('focus', on);
    return () => (window.removeEventListener('focus', on), cancelAnimationFrame(frame));
  }, [chatShown, composer]);
  const forLead = current && !leadMate && wtc ? workingFor(current, team, sessions, wtc.list) : null;
  // Owner 11-17: in a place with a lead the project's last tab is the Team view, drawn only while it lives there (else it is in
  // the right sidebar); a place with no lead keeps its Room tab as before.
  const tabPlace = project === null ? null : team.home && project === team.home ? '' : project;
  const tabLead = tabPlace === null ? null : leadOf(team, tabPlace);
  const [tabAt] = useTeamAt(tabLead ? tabPlace : null);
  const [leadAt, putLead] = useTeamAt(leadMate ? placeOfMate(leadMate) : null);
  const teamTab = !!tabLead && !!tabAt.tab;
  const roomTab = !!project && (!tabLead || teamTab);
  const roomOpen = roomTab && isRoomTab(active) && roomOfTab(active) === project;
  const room = useRoom(core, pin ? null : project, connected, roomOpen);
  const leadFolder = leadMate ? (leadMate.project ?? team.home) || null : tabLead ? project : null;
  const owner = windowCtx().owner;
  const tasks = withMerges(useTasks(core, leadFolder, connected, sessions).tasks, owner);
  const digest = useDigest(core, connected && !!leadMate && !leadMate.project, sessions, owner); // Home view: the Home lead's chip
  const leadBot = leadMate ? team.bots?.find((b) => b.id === leadMate.id) : undefined; // ticket 1168
  const needsYou = teamWaiting(deciding, owner, leadFolder, !(leadMate ?? tabLead)?.project); // q67 look (new 2): the tab's badge and the chip say the Team view's number
  // An ask to show the Team tab ("Open as a tab", the chip, the icon) waits until the tab is drawn: the move is a settings write.
  const [wantTab, setWantTab] = useState<string | null>(null);
  useEffect(() => onShowTeamTab((folder) => folder === project && setWantTab(folder)), [project]);
  useEffect(() => {
    if (wantTab && teamTab && wantTab === project) (setActive(roomTabId(wantTab)), setWantTab(null));
  }, [wantTab, teamTab, project, setActive]);
  // "Back to the side" (or a stale active tab): the Team tab is gone, so the lead's seat (or the first tab) shows instead.
  const leadSeat = tabLead ? seatOf(sessions, tabLead.id)?.id : undefined;
  useEffect(() => {
    if (tabLead && !tabAt.tab && !wantTab && project && active === roomTabId(project)) setActive(leadSeat && strip.includes(leadSeat) ? leadSeat : (strip[0] ?? null));
  }, [tabLead, tabAt.tab, wantTab, project, active, leadSeat, strip, setActive]);
  // Ticket 993: the Schedules widget as a centre tab, the last one before the Room tab, in whichever project is shown.
  // As the Team tab: an ask to show it waits until the tab is drawn (the move is a settings write), and once the widget
  // is back in the side the tab is gone, so another tab shows.
  const [schedAt] = useSchedAt();
  const schedTab = !!schedAt.tab && !pin;
  const schedOpen = schedTab && active === SCHED_TAB;
  const [wantSched, setWantSched] = useState(false);
  useEffect(() => onShowSchedTab(() => setWantSched(true)), []);
  useEffect(() => {
    if (wantSched && schedTab) (setActive(SCHED_TAB), setWantSched(false));
    else if (!schedAt.tab && !wantSched && active === SCHED_TAB) setActive(strip[0] ?? null);
  }, [wantSched, schedTab, schedAt.tab, active, strip, setActive]);
  // Ticket 1022: the History widget as a centre tab, after the Schedules tab, shown as that one is.
  const [histAt] = useHistAt();
  const histTab = !!histAt.tab && !pin;
  const histOpen = histTab && active === HIST_TAB;
  const [wantHist, setWantHist] = useState(false);
  useEffect(() => onShowHistTab(() => setWantHist(true)), []);
  useEffect(() => {
    if (wantHist && histTab) (setActive(HIST_TAB), setWantHist(false));
    else if (!histAt.tab && !wantHist && active === HIST_TAB) setActive(strip[0] ?? null);
  }, [wantHist, histTab, histAt.tab, active, strip, setActive]);
  // Ticket 997 L1 (A6): My browser as a centre tab, the first after the session tabs, in whichever project is shown; drawn and
  // shown as the Schedules tab above.
  const [browserAt] = useBrowserTab();
  const browserTab = browserAt && !pin;
  const browserOpen = browserTab && active === BROWSER_TAB;
  const [wantBrowser, setWantBrowser] = useState(false);
  useEffect(() => onShowBrowserTab(() => setWantBrowser(true)), []);
  useEffect(() => {
    if (wantBrowser && browserTab) (setActive(BROWSER_TAB), setWantBrowser(false));
    else if (!browserAt && !wantBrowser && active === BROWSER_TAB) setActive(strip[0] ?? null);
  }, [wantBrowser, browserTab, browserAt, active, strip, setActive]);
  // The room split the old "Show room" switch kept beside the lead's seat: the Team view replaces it.
  useEffect(() => {
    if (leadMate && current) splitsOf(current.id).filter((x) => kindOf(x.what) === 'room').forEach((x) => removeSplit(current.id, x.id));
  }, [leadMate, current]);
  const openTeam = () => {
    const folder = leadFolder;
    if (!folder) return;
    if (leadAt.tab) return showTeamTab(folder);
    if (!leadAt.open) putLead({ open: true });
    focusTeam();
  };
  const paneEl = useRef<HTMLDivElement>(null);
  const stripEl = useRef<HTMLDivElement | null>(null);
  const activeNow = useRef(active);
  activeNow.current = active;
  // v25-tab-menu-close (C3): a new active tab scrolls into view in an overflowing strip; `nearest` leaves a visible one alone.
  // Only the strip scrolls: scrollIntoView also moved the strip's ancestors (an edit-mode layout), and the resize path runs often.
  const showActive = () => {
    const strip = stripEl.current;
    const id = activeNow.current;
    const box = id && strip?.querySelector(`[data-tab="${CSS.escape(id)}"]`)?.closest('.tabw');
    if (!strip || !box) return;
    const s = strip.getBoundingClientRect();
    const r = box.getBoundingClientRect();
    // The Room tab is pinned over the strip's end (look 1117 v5 A S3-2): another tab is in view only left of it.
    const room = box.querySelector('.rtab') ? null : strip.querySelector('.rtab')?.closest('.tabw');
    const end = room ? room.getBoundingClientRect().left : s.right;
    if (r.left < s.left) strip.scrollLeft -= s.left - r.left;
    else if (r.right > end) {
      const want = strip.scrollLeft + Math.min(r.right - end, r.left - s.left); // a tab wider than the strip shows its start
      // Look 1117 v11 B N11-S3-3: the strip scrolls by whole tabs, so the first tab in view starts whole (a part-scrolled one
      // read "hell · shell-1"). Near the strip's end no tab start may be in reach: then the one before it, when that leaves
      // only the active tab's Close room (24 px, no text) past the edge, under the end's fade.
      const starts = [...strip.querySelectorAll('.tabw')].map((w) => w.getBoundingClientRect().left - s.left + strip.scrollLeft);
      const next = starts.find((x) => x >= want - 1);
      const prev = Math.max(0, ...starts.filter((x) => x < want - 1));
      // Ticket 996: a tab that ends the strip scrolls it to its end; 68 px tabs put a start in that 24 px, and the end's "+N"
      // then counted the shown tab.
      // Ticket 1041: the tabs have gaps (4 px), so the tab before the pinned Room tab ends one gap short of the strip's end.
      const max = strip.scrollWidth - strip.clientWidth;
      const gap = parseFloat(getComputedStyle(strip).columnGap) || 0;
      strip.scrollLeft = next !== undefined && next <= max + 1 ? next : want >= max - 1 - gap ? max : want - prev <= 24 ? prev : want;
    }
  };
  // Seventh look (A S3-5): after a relaunch the tabs are drawn before their sessions are known (short ids), then get their
  // names and widen: the active tab left the view and nothing scrolled. The strip looks again when its tabs' sessions arrive.
  const known = strip.filter((id) => byId.has(id)).length;
  // Looks 1117 v5 to v8 (A S3-2): tabs cut off at the strip's end gave no sign (only the start faded, once scrolled).
  // Both ends are marked, from the first draw: after a scroll, a resize, and when the tabs or their names change.
  const markCut = () => {
    const el = stripEl.current;
    if (!el) return;
    el.toggleAttribute('data-cut-start', el.scrollLeft > 0);
    el.toggleAttribute('data-cut-end', el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
    // Look 1117 v10 (A): the end's fade alone went unseen; the fade before the pinned Room tab also counts the tabs it cuts ("+3").
    const room = el.querySelector('.rtab')?.closest('.tabw');
    const end = room ? room.getBoundingClientRect().left : el.getBoundingClientRect().right;
    const start = el.getBoundingClientRect().left;
    const tabs = [...el.querySelectorAll('.tabw')].filter((w) => w !== room).map((w) => w.getBoundingClientRect());
    const more = tabs.filter((r) => r.right > end + 1).length;
    const less = tabs.filter((r) => r.left < start - 1).length;
    // Look 1117 v11 (A4): also with no Room tab, and at the start: set on the header row, which the "+" button shares.
    el.parentElement?.style.setProperty('--cut-more', more ? `"+${more}"` : '""');
    el.parentElement?.style.setProperty('--cut-less', less ? `"+${less}"` : '""');
  };
  useEffect(() => (showActive(), markCut()), [active, known, strip.length]);
  // Real-app 11-10 defect 1: a strip made narrower (a sidebar opened or widened) scrolls the selected tab back into view too.
  const stripRo = useRef<ResizeObserver | null>(null);
  const stripRef = useCallback((el: HTMLDivElement | null) => {
    stripEl.current = el;
    stripRo.current?.disconnect();
    if (el) (stripRo.current = new ResizeObserver(() => (showActive(), markCut()))).observe(el);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useScrollKeep(paneEl); // ticket 282 item 1: the chat's place comes back with the window
  const paneTerm = (id: string, on: boolean, peek = false) => {
    const t = byId.get(id);
    if (!t) return null; // a session that left the snapshot between two renders
    return <TerminalView key={id} core={core} id={id} active={on} fontSize={settings.termFontSize} fontFamily={settings.termFont} theme={termTheme} connected={connected} name={sessionName(t)} kind={t.kind} copyOnSelect={settings.copyOnSelect} osc52={settings.osc52} peek={peek} />;
  };
  // needs 171: arrows move to the neighbour and activate it (wrap), Home/End the first/last. Ticket 571: the project's Room tab is
  // the last stop of the walk.
  const walk = [...strip, ...(browserTab ? [BROWSER_TAB] : []), ...(schedTab ? [SCHED_TAB] : []), ...(histTab ? [HIST_TAB] : []), ...(roomTab ? [roomTabId(project!)] : [])];
  const walkKey = (e: React.KeyboardEvent, id: string) => {
    if (e.key === 'Enter') return setActive(id);
    const at = walk.indexOf(id);
    const to = { ArrowRight: (at + 1) % walk.length, ArrowLeft: (at - 1 + walk.length) % walk.length, Home: 0, End: walk.length - 1 }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    stay.current = walk[to]; // ticket 1145: arrow travel keeps focus on the strip
    setActive(walk[to]);
    if (!strip.includes(walk[to])) setTimeout(() => stripEl.current?.querySelector<HTMLElement>(`[role="tab"][data-tab="${CSS.escape(walk[to])}"]`)?.focus(), 0); // a view tab (browser, Schedules, Room)
    else focusTab(walk[to]);
  };
  // Ticket 1069: a tab dragged to an edge of a session view becomes a split there; onto a split, it replaces what the split
  // shows (that session goes back to the strip); onto another tab, it moves there. Window pointer events, as the bar icon
  // drag (IconBar.tsx): the HTML5 drag the strip had is not proven in the app's WKWebView (needs 171 finding 2).
  // Ticket 1093: any tab, the shown one too: it goes into a split of the next session tab, which then shows. A tab the split
  // host cannot show (file, imported conversation, Browser, Schedules, History, Team) and a lone tab say why instead.
  const [tabHitNow, setTabHitNow] = useState<{ box: DOMRect; side?: TabHit['side']; refused?: Key } | null>(null);
  const sessionTab = (id: string) => byId.has(id) && !fileOfTab(id) && !isImportedTab(id);
  // The Room tab stays in the strip (each project has one); its split shows the Room widget beside the host.
  const splitWhat = (id: string) => (sessionTab(id) ? `session:${id}` : isRoomTab(id) && !teamTab ? 'room' : null);
  const nextHost = (id: string) => {
    const at = strip.indexOf(id); // -1 for a view tab: the first session tab
    return [...strip.slice(at + 1), ...strip.slice(0, Math.max(at, 0))].find((x) => x !== id && sessionTab(x)) ?? null;
  };
  const dropTab = (what: string, hit: TabHit) => {
    const tab = what.startsWith('session:') ? true : undefined;
    if (hit.side !== 'replace') addSplit(hit.host, hit.side, what, tab);
    else {
      const old = sessionOf(splitsOf(hit.host).find((s) => s.id === hit.split)?.what ?? '');
      replaceSplit(hit.host, hit.split, what, tab);
      if (old && byId.has(old) && byId.get(old)?.state !== 'closed') setTabs((t) => (t.includes(old) ? t : [...t, old]));
    }
    setActive(hit.host); // the shown tab left, or a view tab was shown: the host session shows with its new split
  };
  const grabTab = (e: React.PointerEvent, id: string) => {
    if (e.button !== 0 || renaming?.id === id || (e.target as Element).closest('button')) return; // Stop and Close only click
    const from = { x: e.clientX, y: e.clientY };
    const what = splitWhat(id);
    const hitAt = (ev: PointerEvent) => {
      const h = tabHit(ev.clientX, ev.clientY, id, nextHost(id));
      return h && (!what || 'refused' in h) ? { box: h.box, refused: (what ? 'rest.st.splitNeedsTab' : 'rest.st.splitNotThis') as Key } : h;
    };
    const move = (ev: PointerEvent) => {
      if (dragTab.current !== id && Math.hypot(ev.clientX - from.x, ev.clientY - from.y) < 4) return;
      dragTab.current = id;
      setTabHitNow(hitAt(ev));
    };
    const up = (ev: PointerEvent) => {
      const on = dragTab.current === id;
      end();
      if (!on) return;
      const hit = hitAt(ev);
      const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>('[role="tab"][data-tab]')?.dataset.tab;
      if (hit && what && 'host' in hit) dropTab(what, hit);
      else if (!hit && over && over !== id && strip.includes(over) && strip.includes(id)) moveTab(id, strip.indexOf(over));
    };
    const key = (ev: KeyboardEvent) => ev.key === 'Escape' && dragTab.current === id && (ev.preventDefault(), ev.stopPropagation(), end());
    const end = () => {
      dragTab.current = null;
      setTabHitNow(null);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', end);
      window.removeEventListener('keydown', key, true);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', end);
    window.addEventListener('keydown', key, true);
  };
  // Look 1117 v12 C-V8: with no tab of its own left, the centre names a project whose tabs the strip hides (the last opened).
  const elsewhere = active ? undefined : tabs.toReversed().map((id) => byId.get(id)).find((s) => s && !strip.includes(s.id) && s.project !== project);
  const terminalWidget = () => (
    <div className="centre">
      <div className="zh" data-hint-quiet data-tauri-drag-region={settings.titleBar === 'hidden' ? 'deep' : undefined /* v25f-title-hidden: the window's drag; tabs and + still click */}>
      <div className="tabs" ref={stripRef} role="tablist" aria-label={t('chrome.sessions')} onScroll={markCut}>
        {strip.map((id, at) => {
          const s = byId.get(id);
          const jumpKey = at < 9 ? jumpChip(bindings, 'session.jump', at + 1) : ''; // ticket 377: ⌘N opens strip[N-1], so the number is the tab's place
          const file = fileOfTab(id); // v1b-09: a file tab shows its name and ▤, no status dot
          const name = file ? baseName(file.path) : isImportedTab(id) ? (importedTitle(importedOfTab(id)!) || t('import.untitled')) : s ? sessionName(s) : id.slice(0, 6);
          // Ticket 473: an unlabeled session's name already names its agent. Ticket 996: the icon names a labeled one's kind, so
          // the label shows alone; the tooltip and the tab's accessible name keep "<agent> · <label>".
          const full = s?.label ? `${s.kind} · ${name}` : name;
          const st = s ? tabStatus(chain(s, sessions)) : 'idle'; // v2-3b: an earlier session of the conversation shows too
          return (
            // Real-app 11-10 defect 6: Stop and Close sit beside the role="tab" element, not inside it. WebKit's accessibility press on
            // a tab acts on the first native button inside it (VoiceOver's activate stopped the session), and the tab's name read the
            // buttons' names. `.tabw` is the drawn box and takes the pointer gestures; the tab inside it takes focus and keys.
            <div
              key={id}
              className={`tabw${!s ? '' : st === 'working' ? ' light-run' : st === 'waiting' ? ' light-you' : ''}` /* ticket 1041 C: the state as light */}
              role="presentation"
              data-menu={s ? 'tab' : 'tabx'} // V2-6a: session tabs get the session commands; file tabs only close and move (needs 171)
              data-menu-session={id} // the menu makes the right-clicked tab active before its command runs
              data-menu-arg={id} // ticket 1069: Move tab to split tells the menu's tab from the palette's (the tab shown before)
              data-tip={file ? file.path : full} // v1a-65: the full name or path when the name is cut off
              data-tip-clip=""
              onPointerDown={(e) => grabTab(e, id)}
              onClick={() => setActive(id)}
              onMouseDown={(e) => e.button === 1 && e.preventDefault() /* no autoscroll cursor */}
              onAuxClick={(e) => e.button === 1 && (e.preventDefault(), closeTab(id))}
              onDoubleClick={() => s && setRenaming({ id, error: '' })}
            >
              <div
                className="tab"
                data-hint-kind="tab"
                role="tab"
                aria-selected={active === id}
                data-tab={id}
                data-menu={s ? 'tab' : 'tabx'} // also here: the menu key opens on the focused tab and Esc hands focus back to it
                data-menu-session={id}
                data-menu-arg={id}
                tabIndex={active === id ? 0 : -1}
                onKeyDown={(e) => {
                  if (e.target === e.currentTarget) walkKey(e, id);
                }}
              >
                <span className="ticon" aria-hidden>
                  {/* Ticket 991 A17: a shell tab is a terminal, not a chat. q67 look Q6-2: an agent's tab shows the agent's own
                      mark, the one the "+" menu and the split chooser start it with (no recorded reason for the old bubble). */}
                  {file ? <ChromeIcon name="file" /> : s?.kind === 'shell' ? <Icon name="terminal" size={14} /> : s ? <AgentLogo kind={s.kind} name={s.acp_agent ?? undefined} /> : <ChromeIcon name="comment-discussion" />}
                </span>
                {s && (
                  <i className="tdot" data-s={st} aria-label={t(st === 'done' && s?.state === 'resumable' ? 'mw.status.resumable' : `mw.status.${st}`)} role="img">
                    {markGlyph(st)}
                  </i>
                )}
                {renaming?.id === id && s ? (
                  <RenameField
                    t={t}
                    name={name}
                    initial={s.label}
                    error={renaming.error}
                    onSave={(text) => void rename(id, text)}
                    onCancel={(back) => (setRenaming(null), back && focusTab(id))}
                  />
                ) : (
                  <>
                    {s?.label && <span className="sr">{s.kind} · </span>}
                    <span className="tname wordcut">{name /* ticket 1017: the label with its number when two read alike */}</span>
                  </>
                )}
                {s?.account && <span className="tacct">{s.account}</span> /* V2-2b: the account when not "Your own" */}
              </div>
              <button className="x" aria-label={t('chrome.closeTab', { name })} data-tip={t('chrome.closeTip')} data-tip-cmd="tab.close" onClick={(e) => (e.stopPropagation(), closeTab(id))}>
                <Icon name="x" size={12} />
              </button>
              {jumpKey && (
                <kbd className="kbd tkey" aria-hidden>
                  {jumpKey}
                </kbd>
              )}
            </div>
          );
        })}
        {browserTab && (
          <div className="tabw" role="presentation" data-tip={t('exitWidgets.myBrowser')} onPointerDown={(e) => grabTab(e, BROWSER_TAB)} onClick={() => setActive(BROWSER_TAB)} onAuxClick={(e) => e.button === 1 && (e.preventDefault(), closeBrowserTab())}>
            <div className="stab" role="tab" aria-selected={browserOpen} aria-label={t('exitWidgets.myBrowser')} data-browser-tab data-tab={BROWSER_TAB} tabIndex={browserOpen ? 0 : -1} onKeyDown={(e) => e.target === e.currentTarget && walkKey(e, BROWSER_TAB)}>
              <span className="ticon" aria-hidden>
                <WidgetIcon kind="browser" size={14} />
              </span>
              <span className="tname">{t('exitWidgets.myBrowser')}</span>
            </div>
            <button className="x" aria-label={t('chrome.closeTab', { name: t('exitWidgets.myBrowser') })} data-tip={t('chrome.closeTip')} data-tip-cmd="tab.close" onClick={(e) => (e.stopPropagation(), closeBrowserTab())}>
              <Icon name="x" size={12} />
            </button>
          </div>
        )}
        {schedTab && (
          <div className="tabw" role="presentation" data-tip={t('schedule.title')} onPointerDown={(e) => grabTab(e, SCHED_TAB)} onClick={() => setActive(SCHED_TAB)}>
            <div className="stab" role="tab" aria-selected={schedOpen} aria-label={t('schedule.title')} data-sched-tab data-tab={SCHED_TAB} tabIndex={schedOpen ? 0 : -1} onKeyDown={(e) => e.target === e.currentTarget && walkKey(e, SCHED_TAB)}>
              <span className="ticon" aria-hidden>
                <Icon name="clock" size={14} />
              </span>
              <span className="tname">{t('schedule.title')}</span>
            </div>
            <button className="x" aria-label={t('chrome.closeTab', { name: t('schedule.title') })} data-tip={t('chrome.closeTip')} data-tip-cmd="tab.close" onClick={(e) => (e.stopPropagation(), closeSchedTab())}>
              <Icon name="x" size={12} />
            </button>
          </div>
        )}
        {histTab && (
          <div className="tabw" role="presentation" data-tip={t('history.title')} onPointerDown={(e) => grabTab(e, HIST_TAB)} onClick={() => setActive(HIST_TAB)}>
            <div className="stab" role="tab" aria-selected={histOpen} aria-label={t('history.title')} data-hist-tab data-tab={HIST_TAB} tabIndex={histOpen ? 0 : -1} onKeyDown={(e) => e.target === e.currentTarget && walkKey(e, HIST_TAB)}>
              <span className="ticon" aria-hidden>
                <Icon name="history" size={14} />
              </span>
              <span className="tname">{t('history.title')}</span>
            </div>
            <button className="x" aria-label={t('chrome.closeTab', { name: t('history.title') })} data-tip={t('chrome.closeTip')} data-tip-cmd="tab.close" onClick={(e) => (e.stopPropagation(), closeHistTab())}>
              <Icon name="x" size={12} />
            </button>
          </div>
        )}
        {roomTab && project && (
          <div className="tabw" role="presentation" data-tip={teamTab ? t('shell.widget.team') : t('room.tab')} onPointerDown={(e) => grabTab(e, roomTabId(project))} onClick={() => setActive(roomTabId(project))}>
            <div
              className="rtab"
              role="tab"
              aria-selected={roomOpen}
              aria-label={teamTab ? (needsYou ? `${t('shell.widget.team')} · ${t('lead.tasks.needs', { n: needsYou })}` : t('shell.widget.team')) : room.unread ? t('room.tabUnread', { n: room.unread }) : t('room.tab')}
              data-room-tab
              data-team-tab={teamTab || undefined}
              data-tab={roomTabId(project)}
              tabIndex={roomOpen || !strip.includes(active ?? '') ? 0 : -1}
              onKeyDown={(e) => e.target === e.currentTarget && walkKey(e, roomTabId(project))}
            >
              <span className="ticon" aria-hidden>
                {teamTab ? <Icon name="people" size={14} /> : <ChromeIcon name="comment-discussion" />}
              </span>
              <span className="tname">{teamTab ? t('shell.widget.team') : t('room.tab')}</span>
              {(teamTab ? needsYou : room.unread) > 0 && <span className="room-badge" data-needs={teamTab || undefined}>{teamTab ? needsYou : room.unread}</span>}
            </div>
            {teamTab && (
              <button className="x" aria-label={t('chrome.closeTab', { name: t('shell.widget.team') })} data-tip={t('chrome.closeTip')} data-tip-cmd="tab.close" onClick={(e) => (e.stopPropagation(), closeTeamTab(tabPlace!))}>
                <Icon name="x" size={12} />
              </button>
            )}
          </div>
        )}
      </div>
        <button className="tadd" aria-label={t('chrome.newSession')} data-tip={t('chrome.newSession')} data-tip-cmd="session.new" onClick={() => askNew(current?.project ?? project ?? undefined)}>
          <ChromeIcon name="plus" />
        </button>
      </div>
      <span className="sr" data-live="tabs" role="status">
        {moved}
      </span>
      {forLead && <TeamLine t={t} core={core} mate={forLead} open={open} />}
      {current && (
        <div className="shead" data-hint-region="top">
          {/* Ticket 1041 (N048): the tab's mark; the state word is in the details after the name. */}
          <i className="st" data-s={shownStatus(current)} aria-hidden>
            {markGlyph(shownStatus(current))}
          </i>
          {/* Ticket 1168 (mockup bots-1166 panel 4): the lead's face, once, in the header only (never in a tree row, a tab or the chat). */}
          {leadMate && leadBot && <Face t={t} face={leadBot.face} name={leadMate.name} eyes={needsYou > 0 ? 'look' : eyesOf(sessions, leadMate.id)} size={22} />}
          <b data-tip={sessionName(current)} data-tip-clip>{sessionName(current)}</b>
          {leadMate && <span className="lead-tag">{t('lead.tag')}</span>}
          {/* Ticket 992: a seat's level, and the menu for the bot's next task. */}
          {current.teammate && current.level && <LevelChip t={t} core={core} session={current} />}
          <span className="dim">
            {/* Ticket 790: claude and codex are program names; shell is a word, so it takes the catalogue's. */}
            {placeText(current)} · {current.kind === 'shell' ? t('firstrun.shell') : current.kind} · {t(statusKey(current))}
          </span>
          {/* ticket 162: the agent CLIs update themselves (Claude Code 4 times in a week), and the core marks any version
              it has not been tested with; the line stays the same across updates, the exact version is in its tooltip. */}
          {current.untested && (
            <span className="dim" data-untested title={t('rest.st.untestedTip', { version: current.agent_version ?? t('rest.st.unknown') })}>
              · {t('rest.st.untested')}
            </span>
          )}
          {/* v1b-20: the newest send not typed by the user (a widget act or an agent CLI send), one line that
              shrinks into the header's free space before the notify select, so it shifts nothing (needs 26). */}
          {(() => {
            const log = (current as Session & { send_log?: { sender: string; at: number }[] }).send_log ?? [];
            const row = [...log].reverse().find((r) => r.sender !== 'user');
            // Ticket 990: a lead hears its workers all day (the room and the chat show each line); the header stays short.
            if (!row || leadMate) return null;
            const from = byId.get(row.sender);
            // Ticket 810: the Room's wake-up is logged with the receiver as its sender; it reads as the Room, not "sent by <itself>".
            const who = row.sender.startsWith('widget:') ? t('rest.st.widget', { name: row.sender.slice(7) }) : row.sender === current.id ? t('room.tab') : from ? sessionName(from) : t('rest.st.anAgent');
            return (
              <span className="dim sentby" data-sent-by={row.sender} title={t('rest.st.sentBy', { who })}>
                {t('rest.st.sentBy', { who })} · {new Date(row.at).toLocaleTimeString()}
              </span>
            );
          })()}
          {/* end v1b-20 */}
          {sideChatShown(current) && <button className="hbtn" data-tip={t('settings.keys.cmd.sideChat')} data-tip-cmd="session.side-chat" onClick={() => void openSideChat(current)}>{t('chat.side.title')}</button>}
          <span className="sp" />
          {leadMate && <TeamChip t={t} mate={leadMate} tasks={tasks} sessions={sessions} onOpen={openTeam} digest={digest} waiting={needsYou} faced={!!leadBot} />}
          {/* Ticket 1031: the PR chip, moved here from the status bar (a shell has no chat to carry it). */}
          <SessionFacts t={t} core={core} boot={boot} session={current} />
          {/* Ticket 1130 B-L3 (C5): "New conversation" on a teammate's seat (not on an older conversation of one whose seat runs elsewhere). */}
          {seatMate && !current.side_chat && (seatLive ?? current).id === current.id && <FreshButton t={t} mate={seatMate} seat={current} live={seatLive} />}
          {/* needs 130: the mockup's +a −b, then its Diff button, at the header's right. No change, no pill. */}
          {headStat && (
            // Q6 B18: the pill's scope (since the session's start commit) on hover too, as the Diff pane's scope radios and base line say theirs.
            <span className="hstat" aria-label={t('chat.header.changes', { add: headStat.add, del: headStat.del })} title={t('chat.header.changes', { add: headStat.add, del: headStat.del })}>
              <b className="add">+{headStat.add}</b> <b className="del">−{headStat.del}</b>
            </span>
          )}
          {/* needs 109 (ticket 180): one Diff control per screen; the bar's Diff icon is it while Diff is on a bar. */}
          {!where(bars, 'diff') && (
            <button className="hbtn" aria-label={t('chat.header.diff')} title={t('chat.header.diffTitle')} onClick={() => openDiff()}>
              {t('chat.header.diff')}
            </button>
          )}
          {/* v1a-08: per-session notification level */}
          <NotifyLevel t={t} session={current.id} label={sessionName(current)} level={notify.levels[current.id] ?? 'all'} onChange={notify.setLevel} />
        </div>
      )}
      {current && (current.side_chat || sideChats.includes(current.id)) && <SideChat id={current.id} t={t} />}
      {/* V2-5b: its own row above the pane, so it covers nothing */}
      <ProblemCard t={t} core={core} session={current ?? null} connected={connected} onReplaced={(old, next) => (setTabs((t) => t.map((x) => (x === old ? next.id : x)).filter((x, i, a) => a.indexOf(x) === i)), setActive((a) => (a === old ? next.id : a)))} onOpen={(s) => open(s.id)} />
      <LimitBand t={t} core={core} session={current ?? null} />
      <SplitHost
        t={t}
        session={current}
        all={sessions}
        widget={(w) => renderWidget(w, false, windowCtx())}
        term={(id) => paneTerm(id, true)}
        chat={(s) => <div className="side-chat-view">
          {(s.side_chat || sideChats.includes(s.id)) && <SideChat id={s.id} t={t} />}
          <div className="side-chat-body"><ChatPanes boot={boot} sessions={[s]} active={s.id} all={sessions} t={t} /></div>
        </div>}
        composer={(s) => composerView(false, s.id)}
        core={core}
        onPick={pickSplit}
        onPin={pinSplit}
        onClose={closeSplit}
      >
      <div className="sview">
      <div className="pane" role="tabpanel" ref={paneEl}>
        {/* AGENTVIEW: an agent's terminal lives in the side pane (PTY tab); only shells keep theirs here (SPLITS: or in a split). */}
        {tabs
          .filter((id) => byId.get(id)?.state === 'running' && !hasTranscript(byId.get(id)) && !ptyInSplit(id, splitState))
          .map((id) => paneTerm(id, active === id))}
        {current && <PermissionNeeded core={core} session={current} onReplaced={(old, next) => (setTabs((t) => t.map((x) => (x === old ? next.id : x)).filter((x, i, a) => a.indexOf(x) === i)), setActive((a) => (a === old ? next.id : a)))} />}
        {current && <HolderLine core={core} session={current} onReplaced={(old, next) => (setTabs((t) => t.map((x) => (x === old ? next.id : x)).filter((x, i, a) => a.indexOf(x) === i)), setActive((a) => (a === old ? next.id : a)))} />}
        {!active && (
          <div className="empty">
            <Landing t={t} line={projectCount === 0 ? t('landing.noProjects') : sessions.length === 0 ? t('landing.noSessions') : elsewhere && project ? t('landing.otherTabs', { project: base(project), other: base(elsewhere.project) }) : t('landing.noSessionOpen', { key: label(bindings['palette.open']?.[0] ?? '', bindings) })} other={elsewhere ? { name: base(elsewhere.project), show: () => setActive(elsewhere.id) } : undefined} keys={{ prefix: label(bindings.prefix?.[0] ?? '', bindings), palette: label(bindings['palette.open']?.[0] ?? '', bindings), hints: label(bindings['hints.show']?.[0] ?? 'prefix f', bindings) }} onKeySheet={() => run('keys.help')} onNewSession={projectCount === 0 ? undefined : () => run('session.new')} />
          </div>
        )}
        {/* v1b-03: the 채팅 | 터미널 switch and one chat per open agent tab, over its terminal (still mounted, same
            size); an ended agent session shows its chat read-only instead of the "not live" line. */}
        <TeamOpen.Provider value={openTeam}>
          <ChatPanes boot={boot} sessions={tabs.map((id) => byId.get(id))} active={active} all={sessions} t={t} />
        </TeamOpen.Provider>
        {/* v1a-59: an ended shell shows its last scrollback, input off; v1a-68: a closed shell's is kept in memory. */}
        {current && current.state !== 'running' && !hasTranscript(current) &&
          (current.state === 'closed' && current.kind !== 'shell' ? (
            <div className="empty">{t('rest.st.closedGone')}</div>
          ) : (
            <div className="roterm">
              <TerminalView key={current.id} core={core} id={current.id} active fontSize={settings.termFontSize} fontFamily={settings.termFont} theme={termTheme} connected={false} name={sessionName(current)} kind={current.kind} copyOnSelect={settings.copyOnSelect} osc52="deny" />
            </div>
          ))}
        {/* end v1b-03 */}
        {/* v1b-09: read-only file tabs stay mounted (scroll kept) and read only while visible */}
        {tabs.filter(isImportedTab).map((id) => (
          <ImportedChat key={id} core={core} id={importedOfTab(id)!} visible={active === id} />
        ))}
        {browserOpen && <BrowserSpaces initial={YOU_SPACE} sessions={sessions} insert={windowCtx().notes?.insert} to={windowCtx().notes?.name} t={t} />}
        {schedOpen && <SchedulesView core={core} t={t} sessions={sessions} open={open} where="tab" />}
        {histOpen && <HistoryView core={core} t={t} sessions={sessions} open={open} where="tab" settled={wtc?.settled} places={wtc?.list} projects={windowCtx().projects} />}
        {roomOpen && teamTab && <TeamView core={core} t={t} folder={project} sessions={sessions} open={open} wt={wtc} owner={owner} decide={windowCtx().decide} where="tab" term={(id) => paneTerm(id, true, true)} />}
        {roomOpen && !teamTab && <RoomView core={core} t={t} project={project} sessions={sessions} byId={byId} messages={room.messages} pins={room.pins} names={room.names} delivery={room.delivery} dropped={room.dropped} toggle={room.toggle} refresh={room.refresh} open={open} />}
        {tabs.filter(isFileTab).map((id) => {
          const f = fileOfTab(id)!;
          return <FileView key={id} core={core} file={f} cwd={byId.get(f.root)?.cwd} visible={active === id} jump={jumps[id]} />;
        })}
      </div>
      {paneSession && <SidePane core={core} session={paneSession} all={sessions} term={paneTerm} insert={insertQuote(composer)} t={t} />}
      </div>
      </SplitHost>
      <FreshToast t={t} />
      {tabHitNow && createPortal(<Preview box={tabHitNow.box} side={tabHitNow.side} refused={tabHitNow.refused} />, document.body)}
    </div>
  );

  // shortcut: a pinned terminal on a session that is also open as a tab gets a second xterm, and `terminals`
  // keeps the newer one (used by focus.terminal and bracketed paste); give TerminalView an owner key if it matters.
  const pinnedTerminal = (pin: string) => {
    const s = pinned(pin);
    return (
      <div className="centre">
        <div className="shead" data-hint-region="top">
          <span className="pin" title={t('rest.st.pinnedTip')}>
            📌 {pin}
          </span>
          {s ? <i className="st" data-s={shownStatus(s)} /> : null}
          <span className="dim">{s ? `${base(s.project)} · ${t(statusKey(s))}` : t('rest.st.notRunning')}</span>
        </div>
        <div className="pane">{s?.state === 'running' ? <TerminalView core={core} id={s.id} active fontSize={settings.termFontSize} fontFamily={settings.termFont} theme={termTheme} connected={connected} name={sessionName(s)} kind={s.kind} copyOnSelect={settings.copyOnSelect} osc52={settings.osc52} /> : <div className="empty">{t('rest.st.pinNotRunning', { name: pin })}</div>}</div>
      </div>
    );
  };
  return pin ? pinnedTerminal(pin) : terminalWidget();
}
