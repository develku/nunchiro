// Shell: the tab strip's actions (split out of App.tsx, needs 183).
import { docT, errorNote, heldNote, lineError, notePlain, startOp, type Note } from '../errors';
import { agentName } from '../chat/conversation';
import { onContinue } from '../history/history';
import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { useSeatFollow } from '../lead/lead';
import { CoreClient } from '../api';
import { rememberSideChats } from '../chat/SideChat';
import { replace as replaceSplit, sessionOf, useSplits } from '../split/store';
import { sessionName } from '../Sidebar';
import { restartable, restarting, restartRequest } from './restart';
import { getDraft, setDraft } from '../composer-drafts';
import { forgetClosed, noteClosed, takeClosed, useClosed, type Closed } from './closedTabs';
import { show as paneShow } from '../pane/store';
import { queueBrowserGo } from '../tree/browserGo';
import { openBrowserTab } from '../pane/browser/view/centreTab';
import { isMine } from '../pane/browser/view/tabs';
import { YOU_SPACE } from '../pane/browser/view/spaces';
import { SESSION_OPEN } from '../tree';
import { push as pushUndo } from '../undo/store';
import type { Session } from '../types';
import { baseName, fileOfTab, fileTabId, OPEN_EVENT, unsavedTabs, type OpenDetail } from '../files/open';
import { importedOfTab, importedTabId, importedTitle, isImportedTab, OPEN_EVENT as IMPORT_OPEN } from '../firstrun/imported';
import type { Settings } from '../settings';
import type { useSideChats } from '../chat/useSideChats';
import type { T } from '../i18n';
import { CYCLE_ORDER } from '../features/small-rows-values'; // ticket 270 G31
import { currentFeature, useFeatureSetting } from '../settings/useFeatureSetting';
import { ASK_CLOSE_RUNNING } from './closeAsk';

type Set<T> = Dispatch<SetStateAction<T>>;
type Deps = {
  core: CoreClient;
  tabs: string[];
  /** Ticket 570: the tabs of the selected project, in the strip's order; `tabs` also holds the other projects'. */
  visible: string[];
  setTabs: Set<string[]>;
  active: string | null;
  setActive: Set<string | null>;
  byId: Map<string, Session>;
  current: Session | null;
  setSettings: Set<Settings>;
  setPaneNote: (note: Note) => void;
  sideChats: string[];
  setSideChats: Set<string[]>;
  setHandoff: ReturnType<typeof useSideChats>['setHandoff'];
  splitState: ReturnType<typeof useSplits>;
  /** Closes the Settings/Board modal: a tab opened from inside it would otherwise show behind it. */
  closeOverlay: () => void;
  t: T;
};

/** The window's tab strip actions: open, close (one Undo), resume, the Files open events, move and rename, a tab following
 *  its session to the one that replaced it, and a tab added without leaving the view. The tab list itself is App's. */
const WALK_IDLE_MS = 1500;

export function useTabs({ core, tabs, visible, setTabs, active, setActive, byId, current, setSettings, setPaneNote, sideChats, setSideChats, setHandoff, splitState, closeOverlay, t }: Deps) {
  // v1a-41: the tab being renamed (`error` is the visible refusal) and the announcement of the last move.
  const [renaming, setRenaming] = useState<{ id: string; error: string } | null>(null);
  const [moved, setMoved] = useState('');
  const dragTab = useRef<string | null>(null);
  const lastTab = useRef<{ now: string | null; before: string | null }>({ now: null, before: null });
  const [shown, setShown] = useState(0); // UXFIX (c): LayoutView's reveal key, bumped when a session or Settings is opened (not on every tab switch)
  const open = useCallback((id: string) => {
    closeOverlay();
    setTabs((t) => (t.includes(id) ? t : [...t, id]));
    setActive(id);
    setShown((n) => n + 1);
  }, []);
  // Look 1117 v4 (home S3): one tab per teammate seat. A seat opened again (a new session) takes the place of its ended
  // seat's tab, so a lead never shows two "claude · Lead" tabs.
  useEffect(() => {
    const live = new Set(tabs.flatMap((id) => (byId.get(id)?.teammate && byId.get(id)?.state === 'running' ? [byId.get(id)!.teammate!] : [])));
    const gone = tabs.filter((id) => {
      const s = byId.get(id);
      return !!s?.teammate && s.state !== 'running' && live.has(s.teammate);
    });
    if (gone.length) setTabs((t) => t.filter((id) => !gone.includes(id)));
  }, [tabs, byId]); // eslint-disable-line react-hooks/exhaustive-deps
  // One close path (needs 171): the tab's close button, middle-click, Cmd+W on a file tab and the menu all land here. Closing
  // only closes the tab (the session keeps running). The Undo store holds one pending Undo, so Close other tabs closes its
  // tabs in one call and one Undo puts them all back, each at its index.
  const closeTabs = (ids: string[]) => {
    // Ticket 820: a file tab with unsaved edits stays open and says why, as its Reload and Edit buttons do.
    const unsaved = ids.filter((id) => unsavedTabs.has(id));
    if (unsaved.length) {
      ids = ids.filter((id) => !unsavedTabs.has(id));
      setActive(unsaved[0]);
      setPaneNote(t('rest.pf.fv.keepEdits'));
    }
    const gone = ids.map((id) => ({ id, at: tabs.indexOf(id) })).filter((g) => g.at >= 0).sort((x, y) => x.at - y.at);
    if (!gone.length) return;
    const was = gone.some((g) => g.id === active);
    const nameOf = (id: string) => {
      const s = byId.get(id);
      return fileOfTab(id) ? baseName(fileOfTab(id)!.path) : isImportedTab(id) ? (importedTitle(importedOfTab(id)!) || t('import.untitled')) : s ? sessionName(s) : id.slice(0, 6);
    };
    setTabs((t) => t.filter((x) => !ids.includes(x)));
    // ticket 299: ⇧⌘T reopens newest first; a batch goes in right to left, so its leftmost tab comes back first and each returns to its own slot.
    noteClosed(...gone.map((g): Closed => ({ tab: g.id, at: g.at, session: byId.get(g.id) })).reverse());
    if (was) setActive(visible.filter((x) => !ids.includes(x))[Math.max(0, visible.indexOf(gone[0].id) - 1)] ?? null); // the neighbour in the strip, never another project's tab
    pushUndo({
      label: gone.length === 1 ? t('mw.tabs.closedOne', { name: nameOf(gone[0].id) }) : t('mw.tabs.closed.other', { n: gone.length }),
      undo: () => {
        forgetClosed(gone.map((g) => g.id));
        setTabs((t) => gone.reduce((r, g) => (r.includes(g.id) ? r : r.toSpliced(Math.min(g.at, r.length), 0, g.id)), t));
        if (gone.length === 1 || was) setActive(gone[0].id);
      },
    });
  };
  // Ticket 338 (owner 11-09): a single close on a running session asks first when the General row is on; off (the default) it closes at
  // once. Read at call time (`now`, `currentFeature`): the palette's commands are memoised. A close of several tabs never asks: one Undo restores them.
  const [closing, setClosing] = useState<{ id: string; back: HTMLElement | null } | null>(null);
  const closeTab = (id: string) => {
    if (!currentFeature(ASK_CLOSE_RUNNING) || now.current.byId.get(id)?.state !== 'running') return closeTabs([id]);
    setClosing((c) => (c && now.current.byId.has(c.id) ? c : { id, back: document.activeElement as HTMLElement | null }));
  };
  const answerClose = (close: boolean) => {
    if (!closing) return;
    closing.back?.focus();
    if (close) closeTabs([closing.id]);
    setClosing(null);
  };
  // v1a-59: a closed or exited agent resumes into a new session id; its tab follows. v25-shell-chrome (ticket 282 item 2): Restart session (chrome/restart.ts) keeps the agent, folder, model and
  // effort; a shell has no conversation, so it starts a fresh one in the same folder with the same label.
  const [resuming, setResuming] = useState(false);
  const resumeBusy = useRef(false); // the palette's memoised command can hold an older render's `resuming`
  /** `anyway`: a low-memory hold's Start anyway, the same restart past the hold. */
  const resume = async (s: Session, anyway = false) => {
    if (resumeBusy.current) return;
    resumeBusy.current = true;
    setResuming(true);
    try {
      restarting.set(s.id, restartRequest(s));
      const reply = (await core.request(startOp({ op: 'start', session: restartRequest(s) }, anyway))) as { session?: Session };
      if (reply.session) {
        const next = reply.session.id;
        setDraft(next, getDraft(s.id)); // ticket 371 item 17: before the box meets the new id; text a refused send or the queue gave back is in this draft too
        setTabs((t) => (t.includes(s.id) ? t.map((x) => (x === s.id ? next : x)) : [...t, next]).filter((x, i, a) => a.indexOf(x) === i));
        setActive(next);
      }
    } catch (e) {
      const held = heldNote(t, e, agentName(s.kind, s.acp_agent), () => void resume(s, true));
      setPaneNote(held ? { ...(held as Exclude<Note, string>), session: s.id } : errorNote(t('shell.chrome.notRestarted', { error: notePlain(t, e) }), e, s.id));
    } finally {
      restarting.delete(s.id);
      resumeBusy.current = false;
      setResuming(false);
    }
  };
  // end v1a-59
  useEffect(() => onContinue((x) => void resume(x))); // ticket 1022: History's Continue, with this render's resume
  // v25-reopen-tab (ticket 299): ⇧⌘T walks back through the closed tabs, newest first. Closing a tab leaves its session running, so
  // a session still running just gets its tab back; an agent that ended resumes its conversation by its saved id. Look 1117 v10 (A):
  // any other ended session the core still has (a shell, an agent with no conversation) comes back as its own ended tab with its
  // Restart button, not as a second session of the same name; only one the core forgot starts again as Restart session does.
  // The tab returns to its old slot while that slot exists, else at the end. An entry that cannot come back is skipped.
  const closed = useClosed();
  // The palette's command list is memoised, so `reopen` may be an older render's: it reads the tabs and sessions as they are now.
  const now = useRef({ tabs, byId });
  now.current = { tabs, byId };
  const putBack = (id: string, at: number) => {
    setTabs((t) => (t.includes(id) ? t : t.toSpliced(Math.min(at, t.length), 0, id)));
    open(id);
  };
  const bring = async (e: Closed, anyway = false): Promise<boolean> => {
    const { tabs, byId } = now.current;
    if ('browser' in e) {
      // Ticket 997 L1: a page of the owner's own browser comes back in its centre tab (the "you" space was never a session).
      if (isMine(e.browser)) return (openBrowserTab(), queueBrowserGo(YOU_SPACE, e.url), true);
      const s = byId.get(e.browser);
      if (!s || s.state !== 'running' || s.kind === 'shell') return false;
      open(s.id);
      paneShow(s.id, 'browser', true);
      queueBrowserGo(s.id, e.url);
      return true;
    }
    if (tabs.includes(e.tab)) return false;
    const s = byId.get(e.tab);
    if ((!s && !e.session) || (s && (s.state === 'running' || !s.agent_session_id))) return (putBack(e.tab, e.at), true);
    const gone: Session = s ?? { ...e.session!, state: 'exited' };
    if (!restartable(gone)) return false;
    try {
      restarting.set(gone.id, restartRequest(gone));
      const reply = (await core.request(startOp({ op: 'start', session: restartRequest(gone) }, anyway))) as { session?: Session };
      if (!reply.session) throw new Error('the core started no session');
      putBack(reply.session.id, e.at);
    } catch (x) {
      noteClosed(e);
      // Start anyway takes the entry back off the closed list, as ⇧⌘T would, and brings it past the hold.
      const held = heldNote(t, x, agentName(gone.kind, gone.acp_agent), () => void (forgetClosed([e.tab]), bring(e, true)));
      setPaneNote(held ? { ...(held as Exclude<Note, string>), session: gone.id } : errorNote(t('shell.chrome.notRestarted', { error: notePlain(t, x) }), x, gone.id));
    } finally {
      restarting.delete(gone.id);
    }
    return true;
  };
  const reopen = async () => {
    for (let e = takeClosed(); e; e = takeClosed()) if (await bring(e)) return;
  };
  // v1b-09: the Files tree follows the focused session (a file tab keeps its own session's tree); `files.open` events
  // open read-only tabs, optionally at a line (Search, ticket 10).
  const [lastSession, setLastSession] = useState<string | null>(null);
  const [jumps, setJumps] = useState<Record<string, { line: number; at: number }>>({});
  useEffect(() => void (current && setLastSession(current.id)), [current]);
  const filesSession = current ?? byId.get(fileOfTab(active)?.root ?? lastSession ?? '') ?? null;
  useEffect(() => {
    const onOpen = (e: Event) => {
      const { root, path, line } = (e as CustomEvent<OpenDetail>).detail;
      const id = fileTabId({ root, path });
      open(id);
      if (line) setJumps((j) => ({ ...j, [id]: { line, at: Date.now() } }));
    };
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_EVENT, onOpen);
  }, [open]);
  // Ticket 204: a first-run import hit or imported row opens its conversation read-only in a tab (a second click focuses it);
  // the first-run list closes so the tab shows.
  useEffect(() => {
    const on = (e: Event) => open(importedTabId((e as CustomEvent<{ id: string }>).detail.id));
    window.addEventListener(IMPORT_OPEN, on);
    return () => window.removeEventListener(IMPORT_OPEN, on);
  }, [open]);
  // Ticket 178: Settings > Accounts opens a session that blocks an account remove.
  useEffect(() => {
    const on = (e: Event) => open((e as CustomEvent<{ id: string }>).detail.id);
    window.addEventListener(SESSION_OPEN, on);
    return () => window.removeEventListener(SESSION_OPEN, on);
  }, [open]);
  useEffect(() => {
    const t = lastTab.current;
    if (active !== t.now) Object.assign(t, { before: t.now, now: active });
  }, [active]);
  // v1a-41: a session tab's move also moves it in settings.order (the one saved order): the tabs' sessions take
  // the slots they held in the order, in their new sequence. File and Settings tabs move in the strip only.
  const moveTab = (id: string, to: number) => {
    const from = visible.indexOf(id);
    if (from < 0 || to < 0 || to >= visible.length || to === from) return;
    const shown = [...visible];
    shown.splice(to, 0, ...shown.splice(from, 1));
    // The strip's tabs take the slots they held in the flat list; the other projects' tabs stay where they are.
    const slots = new Set(visible);
    let n = 0;
    const next = tabs.map((t) => (slots.has(t) ? shown[n++] : t));
    setTabs(next);
    const live = shown.filter((t) => byId.has(t));
    setSettings((st) => {
      const slots = new Set(live);
      const order = [...st.order, ...live.filter((t) => !st.order.includes(t))];
      let k = 0;
      return { ...st, order: order.map((t) => (slots.has(t) ? live[k++] : t)) };
    });
    const s = byId.get(id);
    const name = fileOfTab(id) ? baseName(fileOfTab(id)!.path) : isImportedTab(id) ? (importedTitle(importedOfTab(id)!) || t('import.untitled')) : s ? sessionName(s) : id.slice(0, 6);
    setMoved(`Moved ${name} to ${to + 1} of ${shown.length}`);
  };
  const shift = (step: number) => active && moveTab(active, visible.indexOf(active) + step);
  const focusTab = (id: string) => setTimeout(() => document.querySelector<HTMLElement>(`.tab[data-tab="${id}"]`)?.focus(), 0);
  const rename = async (id: string, text: string) => {
    const label = text.trim();
    if (new TextEncoder().encode(label).length > 256) return setRenaming({ id, error: 'Name is over 256 bytes (Korean letters count 3 each)' });
    try {
      await core.label(id, label);
      setRenaming(null);
      focusTab(id);
    } catch (e) {
      // Only while this field is still open: a field closed by blur must not come back.
      setRenaming((r) => (r?.id === id ? { id, error: lineError(docT(), e) } : r));
    }
  };
  // Ticket 270 (G31): in `mru` order next/previous walks the tabs by last focus, newest first. `recent` is per window, in
  // memory; a run of presses walks one frozen copy (else each press would only swap the two newest), and the walk ends
  // on ⌘ release, the window losing focus, a short idle (the prefix form has no ⌘ to release, so it would keep an old list)
  // or any other focus change, which then records where the walk stopped.
  const [cycleOrder] = useFeatureSetting(CYCLE_ORDER);
  const recent = useRef<string[]>([]);
  const walk = useRef<{ list: string[]; at: number } | null>(null);
  const walkIdle = useRef<ReturnType<typeof setTimeout>>(undefined);
  const touch = (id: string) => (recent.current = [id, ...recent.current.filter((x) => x !== id)]);
  const endWalk = () => {
    const w = walk.current;
    walk.current = null;
    if (w) touch(w.list[w.at]);
  };
  useEffect(() => {
    const w = walk.current;
    if (w && w.list[w.at] === active) return;
    endWalk();
    if (active) touch(active);
  }, [active]);
  useEffect(() => {
    const up = (e: KeyboardEvent) => e.key === 'Meta' && endWalk();
    window.addEventListener('keyup', up, true); // capture: a terminal's keyup handler cannot hide the release
    window.addEventListener('blur', endWalk);
    return () => {
      window.removeEventListener('keyup', up, true);
      window.removeEventListener('blur', endWalk);
    };
  }, []);
  const cycle = (step: number) => {
    if (!visible.length) return;
    if (cycleOrder === 'mru') {
      const fresh = [...recent.current.filter((t) => visible.includes(t)), ...visible.filter((t) => !recent.current.includes(t))];
      const list = walk.current ? walk.current.list.filter((t) => visible.includes(t)) : fresh;
      const i = active ? list.indexOf(active) : -1;
      const at = (i + step + list.length) % list.length;
      walk.current = { list, at };
      clearTimeout(walkIdle.current);
      walkIdle.current = setTimeout(endWalk, WALK_IDLE_MS);
      return setActive(list[at]);
    }
    const i = active ? visible.indexOf(active) : -1;
    setActive(visible[(i + step + visible.length) % visible.length]);
  };
  // v1a-10, v2-3b: a tab follows its session to the one that replaced it (a Codex model switch, a handoff).
  const follow = (old: string, next: string, modelReplacement = false) => {
    // Only a model replacement carries launch policy; a cross-agent handoff uses its own mode.
    if (modelReplacement && sideChats.includes(old)) {
      setSideChats((ids) => rememberSideChats([...ids, next]));
      setHandoff((h) => h?.fork?.id === old ? { ...h, fork: { ...h.fork, id: next } } : h);
      for (const [parent, splits] of Object.entries(splitState)) {
        for (const sp of splits) if (sessionOf(sp.what) === old) replaceSplit(parent, sp.id, `session:${next}`);
      }
    }
    // W35 Fable review MUST 2: a model replacement (a Codex switch, a fast mode restart) keeps the box's draft, as the
    // window's own restart does (above); before the box meets the new id.
    if (modelReplacement) setDraft(next, getDraft(old));
    setTabs((t) => t.map((x) => (x === old ? next : x)).filter((x, i, a) => a.indexOf(x) === i));
    setActive((a) => (a === old ? next : a));
  };
  // A session started without leaving the current view joins the tabs (a repeat is not doubled).
  const addTab = (id: string) => setTabs((tabs) => (tabs.includes(id) ? tabs : [...tabs, id]));
  // Sixth look: a seat replaced for another level takes its tab along (lead.ts `useSeatFollow`).
  const all = useMemo(() => [...byId.values()], [byId]);
  useSeatFollow(all, tabs, follow);
  return { open, recent, shown, reopen, canReopen: closed.length > 0, closeTabs, closeTab, closing, answerClose, resuming, resume, filesSession, jumps, lastTab, moveTab, shift, focusTab, rename, cycle, renaming, setRenaming, moved, dragTab, follow, addTab };
}
