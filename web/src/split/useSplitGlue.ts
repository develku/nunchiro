// Splits: the window's split glue (split out of App.tsx, needs 183).
import { docT, errorNote, notePlain, type Note } from '../errors';
import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import { CoreClient, type Account } from '../api';
import { startShell } from '../pane/SidePane';
import { focusAtOpen } from '../Terminal';
import { gridOf, setGrid } from '../pane/store';
import type { Choice } from './Chooser';
import { add as addSplit, CHOOSER, prune as pruneSplits, remove as removeSplit, replace as replaceSplit, sessionOf, splitSessions, splitsOf, useSplits, type Split } from './store';
import { measureDom } from '../layout/DragLayer';
import { where, without, WIDGET_LABEL, type Bars } from '../layout/bars';
import { useArrange } from '../layout/useArrange';
import { defaultZone, type Dir, type Layout, type Op } from '../layout/model';
import { LayoutStore } from '../layout/store';
import type { AgentKind, Session } from '../types';
import { agentName } from '../chat/conversation';
import { lastAccount, likeNew } from '../NewSession';
import { agentOff } from '../settings/agents/newDefaults';
import { ACCOUNTS_CHANGED } from '../tree';
import { closeable, closeEnded } from '../chrome/closeEnded';
import type { Settings } from '../settings';

type Deps = {
  core: CoreClient;
  connected: boolean;
  sessions: Session[];
  byId: Map<string, Session>;
  ordered: Session[];
  current: Session | null;
  snapped: { current: boolean };
  setTabs: Dispatch<SetStateAction<string[]>>;
  setActive: Dispatch<SetStateAction<string | null>>;
  settings: Settings;
  paneSession: Session | null;
  setPaneNote: (note: Note) => void;
  composer: { current: HTMLTextAreaElement | null };
  layout: Layout;
  store: LayoutStore;
  bars: Bars;
  arrange: ReturnType<typeof useArrange>;
};

/** SPLITS: the window's splits beside the chat: their sessions (out of the tab strip), the accounts a split start reads,
 *  and split, pick, pin and close (SPLITKEYS). */
export function useSplitGlue({ core, connected, sessions, byId, ordered, current, snapped, setTabs, setActive, settings, paneSession, setPaneNote, composer, layout, store, bars, arrange }: Deps) {
  // SPLITS: a session started for a split lives there, not also as a window tab; a closed session's splits are dropped.
  const splitState = useSplits();
  // SPLITS: the account list (each account's sign-in is probed, seconds) is read once per connection, so a split's
  // agent start does not wait for the probes; a split start uses this list (startFor).
  const accountsP = useRef<Promise<Account[]> | null>(null);
  const readAccounts = (share = false) => (accountsP.current = core.accounts(share).then((r) => r.accounts, () => ((accountsP.current = null), []))); // a failure is not kept
  useEffect(() => void (accountsP.current = connected ? readAccounts(true) : null), [core, connected]);
  useEffect(() => {
    const again = () => void readAccounts();
    window.addEventListener(ACCOUNTS_CHANGED, again);
    return () => window.removeEventListener(ACCOUNTS_CHANGED, again);
  }, [core]);
  const splitIds = splitSessions(splitState).join();
  useEffect(() => {
    const ids = new Set(splitIds.split(',').filter(Boolean));
    setTabs((t) => t.filter((id) => !ids.has(id)));
    setActive((a) => (a && ids.has(a) ? (Object.entries(splitState).find(([, l]) => l.some((x) => sessionOf(x.what) === a))?.[0] ?? null) : a));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [splitIds]);
  // Look 1117 v9 (A S3-2): a split's shell is for this split only, so it leaves no Closed row in the tree's done fold:
  // the core keeps a closed shell's row, and a close of that Closed row drops it (as Close session on a done row).
  const endShell = (id: string) => void core.request({ op: 'close', id }).then(() => core.request({ op: 'close', id })).catch(() => {});
  useEffect(() => {
    if (!snapped.current || !sessions.length) return;
    // A closed session's splits go, and the shells started for them end with it (an agent started for one stays a session).
    // Only for a session the snapshot shows closed: one merely missing from a list (a reconnect) never ends a live shell.
    for (const { session, started, moved } of pruneSplits(sessions)) {
      if (byId.get(session)?.state === 'closed')
        for (const id of started) if (byId.get(id)?.kind === 'shell' && byId.get(id)?.state === 'running') endShell(id);
      // Ticket 1069: a session moved in from the strip outlives its host's splits and gets its tab back.
      const back = moved.filter((id) => byId.has(id) && byId.get(id)?.state !== 'closed');
      if (back.length) setTabs((t) => [...t, ...back.filter((id) => !t.includes(id))]);
    }
  }, [sessions, core]);
  // SPLITS: a session started in `s`'s folder for a split: a shell, or an agent with the New Session defaults (its model
  // and effort, as NewSession's `like`). Returns the session, or null after saying why it did not start.
  const startFor = async (s: Session, kind: AgentKind): Promise<Session | null> => {
    const list = accountsP.current ?? readAccounts();
    try {
      // The account as New Session prefills it: the one last used in this project by this agent, when it has 2+.
      const accounts = kind === 'shell' ? [] : await list;
      const account = accounts.filter((a) => a.agent === kind).length < 2 ? null : lastAccount(ordered, kind, s.project, accounts);
      // Ticket 810: a shell gets no label, so it reads as the catalogue's untitled terminal (an English "split shell N" did).
      const extra = kind === 'shell' ? {} : { ...likeNew(s, ordered, kind, s.project), ...(account ? { account } : {}) };
      const reply = (await core.request({ op: 'start', session: { kind, project: s.cwd, ...extra, resume: null } })) as { session?: Session };
      return reply.session ?? null;
    } catch (e) {
      setPaneNote(errorNote(kind === 'shell' ? docT()('err.note.shellNotStarted', { error: notePlain(docT(), e) }) : docT()('err.note.agentNotStarted', { agent: agentName(kind), error: notePlain(docT(), e) }), e));
      return null;
    }
  };
  // Look 1117 A S2-3: a shell opened in a split takes the focus (given at its open), so "Close the focused split" and the
  // keys reach it; the chooser it replaced had it, and it fell to the page.
  const focusShell = (n: Session) => n.kind === 'shell' && focusAtOpen.add(n.id);
  /** SPLITKEYS: split the focused pane. A side-pane terminal splits its terminal area (a new shell beside it); anything
   *  else gets a split beside the chat, opening what the setting "Open in a new split" says. */
  const splitPane = (side: Dir) => {
    const t = document.activeElement?.closest<HTMLElement>('[data-side-pane] .term[data-session]');
    if (t && paneSession && (side === 'right' || side === 'down')) {
      const dir = side === 'right' ? 'h' : 'v';
      const a = t.dataset.session!;
      const g = gridOf(paneSession.id);
      if (g && (g.a === a || g.b === a)) return setGrid(paneSession.id, { ...g, dir });
      return void startShell(core, paneSession, (b) => setGrid(paneSession.id, { dir, a, b })).then((e) => e && setPaneNote(e));
    }
    // Ticket 610: on the Room tab (or with no tab) there is no session to split beside; say so instead of doing nothing.
    if (!current) return setPaneNote(docT()('walk5.splitNeedsSession'));
    const how = settings.newSplit;
    if (how === 'chooser') return void addSplit(current.id, side, CHOOSER);
    const at = current;
    // Ticket 358: never an agent turned off; the other one, else a shell.
    const agent = at.kind === 'shell' || agentOff(at.kind) ? ((['claude', 'codex'] as const).find((k) => !agentOff(k)) ?? 'shell') : at.kind;
    void startFor(at, how === 'terminal' ? 'shell' : agent).then((n) => n && (addSplit(at.id, side, `session:${n.id}`), focusShell(n)));
  };
  const pickSplit = (sp: Split, c: Choice) => {
    const at = current;
    if (!at) return;
    if (c !== 'claude' && c !== 'codex' && c !== 'shell') return replaceSplit(at.id, sp.id, c);
    void startFor(at, c).then((n) => {
      if (!n) return;
      if (splitsOf(at.id).some((x) => x.id === sp.id)) return (replaceSplit(at.id, sp.id, `session:${n.id}`), focusShell(n));
      endWithSplit(n); // the split closed while the session started
    });
  };
  /** Look 1117 v11 A S3-9: one rule for what a closed split held, whatever its kind. "Close split" closes what runs in it, as
   *  closing a pane does in iTerm, tmux and herdr: a shell leaves no row, an agent closes with the status line's Undo (its
   *  conversation stays resumable in the tree), a Side chat ends. A session mid-turn or asking is not cut off: it stays as a
   *  window tab, as Close session refuses it. */
  const endWithSplit = (s: Session) => {
    if (s.state === 'running' && !s.side_chat && !closeable(s)) setTabs((t) => (t.includes(s.id) ? t : [...t, s.id]));
    else if (s.kind === 'shell') endShell(s.id);
    else if (s.side_chat) void core.request({ op: 'close', id: s.id }).catch(() => {});
    else if (s.state !== 'closed') void closeEnded(core, s, docT(), setPaneNote);
  };
  /** ✕ (or split.close). */
  const closeSplit = (sp: Split) => {
    if (!current) return;
    removeSplit(current.id, sp.id);
    const id = sessionOf(sp.what);
    const started = id ? byId.get(id) : undefined;
    // Ticket 1069: a session moved in from the strip goes back there; only a split's own session closes with it.
    if (started && sp.tab && started.state !== 'closed') setTabs((t) => (t.includes(started.id) ? t : [...t, started.id]));
    else if (started) endWithSplit(started);
    composer.current?.focus(); // at once: a deferred focus would take it from a split the next key opens
  };
  /** 📌: the widget joins the layout beside the zone that holds the split, for every session (one step of the trail, ⌘Z undoes it). */
  const pinSplit = (sp: Split) => {
    const at = current;
    if (!at) return;
    const op: Op = { op: 'split', dir: sp.side, widget: sp.what, zone: document.querySelector('[data-split-host]')?.closest<HTMLElement>('[data-zone-id]')?.dataset.zoneId ?? defaultZone(layout) };
    // A widget lives in one place: a bar widget placed in the main area leaves its bar in the same step (as a drag does).
    void arrange.commit(`${WIDGET_LABEL(sp.what)} kept in the layout`, { zone: () => store.run(op, measureDom), bars: where(bars, sp.what) ? without(bars, sp.what) : undefined }).then((ok) => ok && removeSplit(at.id, sp.id));
  };
  const splitRef = useRef({ split: splitPane, close: () => {} });
  splitRef.current = {
    split: splitPane,
    close: () => {
      const id = document.activeElement?.closest<HTMLElement>('[data-split-id]')?.dataset.splitId;
      const sp = current && splitsOf(current.id).find((x) => x.id === id);
      if (sp) closeSplit(sp);
    },
  };
  return { splitState, accountsP, readAccounts, pickSplit, closeSplit, pinSplit, splitRef };
}
