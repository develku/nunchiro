// Shell: the window's link to the core and the turn-end cue (split out of App.tsx, needs 183).
import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { CoreClient } from '../api';
import { warmUsage } from '../usage/UsagePage';
import { isPaneShell } from '../pane/store';
import { failures, isChild, turnEnds } from '../queue/turns';
import { splitSessions } from '../split/store';
import { parse } from '../layout/command';
import { measureDom } from '../layout/DragLayer';
import { LayoutStore } from '../layout/store';
import { agentState, status, type BoardDecision, type Decision, type Session } from '../types';
import { quietFor, useNotifications } from '../queue/notify';
import { cue } from '../sound';
import { removesStrip, SIGNALS_LEFT } from '../layout/useRails';
import type { Settings } from '../settings';
import { fileOfTab } from '../files/open';
import { isImportedTab } from '../firstrun/imported';
import { rawError } from '../errors';
import { isRestart, restarting } from './restart';
import { commandClosed } from './closedTabs';

type Set<T> = Dispatch<SetStateAction<T>>;
type Deps = {
  /** Session ids this window has shown (restored from the last run, chrome/windowState.ts). */
  seen: { current: globalThis.Set<string> };
  core: CoreClient;
  store: LayoutStore;
  connected: boolean;
  setConnected: (up: boolean) => void;
  snapped: { current: boolean };
  setSessions: Set<Session[]>;
  setFirstSnapshot: Set<Session[] | null>; // the first list this window ever got; set once (ticket 305)
  setBoardList: (list: BoardDecision[]) => void;
  setOwnerList: (list: Decision[]) => void;
  settings: Settings;
  setSettings: Set<Settings>;
  setTabs: Set<string[]>;
  setActive: Set<string | null>;
  /** Ticket 570: the shown project and whether a tab is in its strip (a tab of no known project counts as in it). */
  shown: { current: { selected: string | null; inStrip: (id: string) => boolean } };
};

/** The window's link to the core: the connection and its snapshots (new live sessions open as tabs once), the
 *  layout.toml answers and `nunchiro layout` commands, which window takes them, and the front heartbeat (V2-8c). */
export function useCoreLink({ seen, core, store, connected, setConnected, snapped, setSessions, setFirstSnapshot, setBoardList, setOwnerList, settings, setSettings, setTabs, setActive, shown }: Deps) {
  const hadSessions = useRef(false); // an earlier snapshot listed sessions
  const linkHad = useRef(false); // a snapshot since the link last came up listed sessions
  const byCommand = useRef(new Set<string>()); // ticket 1013 F6: command-closed sessions whose tab went once
  const orderRef = useRef<string[]>([]); // v1a-41: startup tabs open in the saved session order
  orderRef.current = settings.order;
  // Until the core's first layout.toml answer (a layout, none, or an error) the store holds the default, which has no
  // tree zone: reconciling then would put the Tree on the Left bar for a moment, pushing an icon off a full bar.
  const [layoutSeen, setLayoutSeen] = useState(false);

  useEffect(() => {
    core.onStatus = (up) => {
      if (!up) snapped.current = linkHad.current = false;
      setConnected(up);
    };
    core.onSnapshot = (list, board, owner) => {
      snapped.current = true;
      setSessions(list);
      setFirstSnapshot((f) => f ?? list); // batched with setSessions: the first-run choice reads this very list
      setBoardList(board); // v1b-18
      setOwnerList(owner); // v1a-23
      // Ticket 991: sessions first seen together keep the snapshot's order, which is the order they were started in
      // (sessions.rs `started_order`). They were ordered by pid, and pids wrap around (seen under load: the newest of
      // three tabs came first). As before, one with no process (ended before this window saw it) comes after those that
      // run. A session already in the saved order (settings.order) comes first, in that order (v1a-41).
      const rank = (id: string) => orderRef.current.indexOf(id) < 0 ? Infinity : orderRef.current.indexOf(id);
      // v25-shell-chrome (ticket 282): tabs of sessions the core no longer knows go; the rest were restored with the window.
      // Ticket 1013 F6: a session a command closed (not the window's own Close) loses its tab at once, as one the core
      // forgot; once only, so the owner may open it again from its tree row.
      const first = commandClosed(byCommand.current, list);
      const known = new Set(list.filter((s) => !first.has(s.id)).map((s) => s.id));
      // Exam 1 Home S2-1: a resumed session (Run now on a resumable lead) runs under a new id that lists the old one in
      // `resumed_from`; its tab moves there in place and stays shown, as the Room maps it (withResumed). Pruned, the
      // tab came back unshown at the end and the pane read "No session open".
      const heir = new Map(list.flatMap((s) => (s.resumed_from ?? []).filter((old) => !known.has(old)).map((old) => [old, s.id] as const)));
      if (heir.size) {
        setTabs((t) => (t.some((id) => heir.has(id)) ? t.map((id) => heir.get(id) ?? id).filter((x, i, a) => a.indexOf(x) === i) : t));
        setActive((a) => (a && heir.get(a)) ?? a);
      }
      // Look 1117 v7 (S3-2): not the tab of a session being restarted: the reply puts the new session in its slot.
      const gone = (id: string) => !known.has(id) && !fileOfTab(id) && !isImportedTab(id) && !restarting.has(id);
      // An empty list after a non-empty one, before the link has listed any session since it came back, is a core
      // restarting: keep the tabs; the next non-empty snapshot prunes as usual (v25-chrome-fu, ticket 297 item 12). On a
      // link that listed sessions it is the last ones gone (look 1117 v14 A E1: Remove project left bare-id tabs).
      if (list.length || !hadSessions.current || linkHad.current) {
        // Ticket 448: when the shown tab goes, the one before it is shown (as a close does), not the empty landing over the tabs left.
        setTabs((t) => {
          if (!t.some(gone)) return t;
          const kept = t.filter((id) => !gone(id));
          // Ticket 570: the neighbour is in the shown project's strip; with none left the strip is empty, the project stays.
          const { inStrip } = shown.current;
          setActive((a) => (a && gone(a) ? (kept.filter(inStrip)[Math.max(0, t.slice(0, t.indexOf(a)).filter((id) => !gone(id) && inStrip(id)).length - 1)] ?? null) : a));
          return kept;
        });
      }
      if (list.length) hadSessions.current = linkHad.current = true;
      const fresh = list.filter((s) => !seen.current.has(s.id)).sort((a, b) => (rank(a.id) === rank(b.id) ? Number(a.pid == null) - Number(b.pid == null) : rank(a.id) - rank(b.id)));
      if (!fresh.length) return;
      fresh.forEach((s) => seen.current.add(s.id));
      setSettings((st) => ({ ...st, order: [...st.order.filter((id) => list.some((s) => s.id === id)), ...fresh.map((s) => s.id).filter((id) => !st.order.includes(id))] }));
      // Live sessions open as tabs once; a closed tab stays closed until the user opens it again.
      // Ticket 990: what a teammate's seat starts (a lead's workers and their reviewers) opens no tab by itself: the
      // person talks to the lead, and reaches a sub-bot from its tree row or the lead's band (seen in the real app: one
      // two-task job filled the strip with five tabs). With no teammate nothing changes.
      const byId = new Map(list.map((s) => [s.id, s]));
      const ofSeat = (s: Session) => {
        for (let up = s.parent && byId.get(s.parent), n = 0; up && n < 8; up = up.parent ? byId.get(up.parent) : undefined, n++) if (up.teammate) return true;
        return false;
      };
      // Nor a restart's own new session, seen here before its reply: it takes the old tab's slot there (chrome/restart.ts).
      const open = fresh.filter((s) => s.state === 'running' && !s.side_chat && !isPaneShell(s.id) && !splitSessions().includes(s.id) && !ofSeat(s) && !isRestart(s)).map((s) => s.id);
      setTabs((t) => [...t, ...open.filter((id) => !t.includes(id))]);
      // Ticket 570: with nothing shown, a session that starts elsewhere gets its tab but does not move the window to its project.
      const { selected } = shown.current;
      setActive((a) => a ?? open.find((id) => !selected || list.find((s) => s.id === id)?.project === selected) ?? null);
    };
    core.onLayout = (f) => (store.fromFile(f), setLayoutSeen(true));
    // `nunchiro layout ...`: run as typed, saved before the answer, so the CLI returns after the file is written.
    core.onLayoutCommand = async (seq, args, file) => {
      try {
        store.fromFile(file);
        setLayoutSeen(true);
        if (store.editing) throw new Error('this window is editing the layout: press Done or Cancel there first');
        const op = parse(args, undefined, store.current);
        const strip = removesStrip(store.current, op);
        const text = await store.run(op, measureDom);
        await core.layoutDone(seq, { text: strip ? `${text}\nanswer strip removed: ${SIGNALS_LEFT}; nunchiro layout add waiting brings it back` : text });
      } catch (e) {
        await core.layoutDone(seq, { error: rawError(e) }).catch(() => {});
      }
    };
    core.connect();
    return () => core.close();
  }, [core, store]);

  // The window the user last worked in takes `nunchiro layout` commands (the core falls back to the newest).
  // Usage numbers for the page's first open (see `warmUsage`); late, so the window's start has the core to itself.
  useEffect(() => {
    if (!connected) return;
    const timer = setTimeout(() => void warmUsage(core), 10_000);
    return () => clearTimeout(timer);
  }, [core, connected]);
  useEffect(() => {
    if (!connected) return;
    let last = 0;
    const mark = () => {
      if (Date.now() - last < 500) return;
      last = Date.now();
      void core.layoutFocus().catch(() => {});
    };
    if (document.hasFocus()) mark();
    const now = () => ((last = 0), mark());
    window.addEventListener('focus', now);
    window.addEventListener('pointerdown', now, true);
    window.addEventListener('keydown', mark, true);
    return () => {
      window.removeEventListener('focus', now);
      window.removeEventListener('pointerdown', now, true);
      window.removeEventListener('keydown', mark, true);
    };
  }, [core, connected]);
  // V2-8c: tells the core whether this window is in front (live PR status polls only then); every 30 s while it is,
  // since the core counts a heartbeat older than 90 s as not in front.
  useEffect(() => {
    if (!connected) return;
    CoreClient.main = core;
    const beat = () => void core.prLive({ op: 'pr_front', front: document.visibilityState === 'visible' && document.hasFocus() }).catch(() => {});
    beat();
    const timer = setInterval(() => document.hasFocus() && beat(), 30_000);
    window.addEventListener('focus', beat);
    window.addEventListener('blur', beat);
    document.addEventListener('visibilitychange', beat);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', beat);
      window.removeEventListener('blur', beat);
      document.removeEventListener('visibilitychange', beat);
    };
  }, [core, connected]);
  return { layoutSeen };
}

type CueDeps = { connected: boolean; snapped: { current: boolean }; sessions: Session[]; active: string | null; notify: ReturnType<typeof useNotifications> };

/** The done sound and turn-end notification (v1a-38, needs 170 (2)). */
export function useTurnCue({ connected, snapped, sessions, active, notify }: CueDeps) {
  // v1a-38: a session ending on its own (running -> exited, waiting or not) plays the done sound at notify level
  // "all". Closed and resumable are the user's or a core stop's doing; a first sight is not a transition, and a
  // lost connection forgets what was seen (a core stop marks every shell exited), and nothing is recorded
  // until the first snapshot after a (re)connect, since the list in hand before it is the old core's.
  // Needs 170 (2): a turn end (working -> not working while running) cues too, and raises an OS notification; both only for
  // a session the user is not looking at (`quietFor`, ticket 316: a setting), that is not a side chat (`isChild`), at level "all".
  const lastState = useRef(new Map<string, string>());
  const lastWorking = useRef(new Map<string, boolean>());
  const lastStatus = useRef(new Map<string, string>());
  useEffect(() => {
    if (!connected || !snapped.current) return void (lastState.current.clear(), lastWorking.current.clear(), lastStatus.current.clear());
    const ends = turnEnds(lastWorking.current, sessions);
    const failed = failures(lastStatus.current, sessions);
    for (const s of sessions) {
      const exit = lastState.current.get(s.id) === 'running' && agentState(s) === 'exited'; // ticket 286: the agent's end
      const end = ends.includes(s.id);
      const level = notify.levels[s.id] ?? 'all';
      // Ticket 270 (G30): a session on a machine switched off in Settings > Alerts rings no done sound either.
      const heard = !quietFor(s.id, active) && !isChild(s) && notify.machineOn(s);
      // Ticket 372: a failure asks for the user (T3 plays its input sound), at levels all and waiting; never the done sound.
      if (failed.includes(s.id)) {
        if (heard && level !== 'muted') {
          cue('waiting');
          notify.failed(s);
        }
      } else if ((exit || end) && heard && level === 'all') {
        cue('done');
        if (end) notify.finished(s);
      }
      lastState.current.set(s.id, agentState(s));
      lastWorking.current.set(s.id, s.attention.working);
      lastStatus.current.set(s.id, status(s));
    }
  }, [sessions, notify.levels, notify.machineOn, connected]);
}
