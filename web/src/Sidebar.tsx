// Tree C and AGENTS, each a layout widget (v1a-07b; default zones put the tree above AGENTS on the left). Tree rows
// never move while the pointer or keyboard focus is inside: the structure is frozen on entry and only bars, counts
// and dots update until it leaves (needs 49). Arrivals wait as a chip on the head row, answered rows stay dimmed.
// AGENTS puts running sessions first and holds its order the same way (V1A-59). A waiting session with no pending item is not in the head count
// (it counts rows, see buildTree) but still shows on the group bar and the AGENTS dot (needs 39).
import { ErrorDetails, tipError } from './errors';
import { createPortal } from 'react-dom';
import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKey, type ReactNode } from 'react';
import { basename, buildTree, withNames, withoutClosedHeads, byUrgency, cleanable, EXPAND_ALL, failedIn, foldGroup, expandedList, groupFolded, leaves, place, rowState, sameKeys, urgencyOf, withListed, listedName, type Group, type Machine, type ProjectGroup, type RowState, type Worktree, type WorktreeFact } from './tree';
import { asks, decisionLines, type Item, type Line } from './tree/decisions'; // V2-8e
import { DecisionRow, type OnAnswer } from './tree/DecisionLine'; // V2-8e
import { CleanupLine, HeadName, WtRow } from './tree/RowIcon';
import { Gather, placeOf, Strip, stripSessions, urgentQueue, useHidden, type Tone } from './tree/strip'; // ticket 388
import { DoneBars, DonePopover, JustRow } from './tree/DoneBars'; // ticket 1022 (replaces ticket 294's "N done" fold)
import { ended, finishedAt, isJust, isToday, JUST_MS, nextMidnight, noteEnds } from './tree/finished';
import { makeT, type Lang } from './i18n';
import { enT, plural, type ProjectTree, type T } from './tree/state';
import { RenameField, type Worktrees } from './tree/worktrees'; // V2-8a
import './tree/tree.css';
import { SubViews, type SubViewsCtx } from './tree/SubViews';
import { PastChats } from './tree/PastChats'; // ticket 392
import { KidCount, Kids, useKids, type Nest } from './tree/kids'; // V2-CF4
import { CacheTimer } from './tree/CacheTimer'; // ticket 257
import { KidPeek, type Peek } from './tree/KidPeek'; // needs 169
import { Icon } from './icons/Icon';
import { useHeadHold } from './tree/headHold'; // TREEHEAD-FREEZE
import { foldOf, navKey as keyKind, navMove, ROW, rove, treeRows } from './tree/keynav'; // V2.5-61
import { agentState, noCheckout, shownStatus, status, withResumed, type Decision, type Session, type TreeState } from './types';
import type { CoreClient } from './api';
import { askAddProject, askNew, askStop } from './NewSession'; // v1a-59
import { ProjectIcon, ProjectTools } from './tree/ProjectTools'; // V2.5-15
import { push as pushUndo } from './undo/store';
import { useProjectDrag } from './tree/dragProject'; // needs 171

/** needs 49: with no pointer move or key inside the sidebar for this long, pending changes apply (a parked pointer must not freeze waiting items forever). */
const IDLE_MS = 5000;

/** V2-9a: the context menu, the palette and the group dialogs are opened from the tree and ride on its freeze: moving into one is not leaving. */
const overlay = (n: EventTarget | null) => n instanceof Element && !!n.closest('.cmenu, .palette');

import { leadOf, leadSeatMate, useTeam } from './lead/lead'; // ticket 990
import { useAcpNames } from './lead/level';
import { askLeader } from './lead/LeaderDialog';
import { HomeGroup, homeMates } from './lead/HomeGroup';
export { sessionName } from './sessionNames'; // ticket 491: the naming rule moved there, shared with the card and strip
import { sessionName } from './sessionNames';
const base = (p: string) => p.replace(/\/+$/, '').split('/').pop() || p;
const withoutNotes = (session: Session): Session => ({ ...session, pending: asks(session.pending) });


interface Props {
  sessions: Session[];
  order: string[];
  current: string | null;
  collapsed: string[];
  onToggle: (project: string) => void;
  onOpen: (id: string) => void;
  /** Ticket 570: a click on a project's name shows that project's tabs. True when it had some; false, the click opens its main session as before. */
  onSelect?: (project: string) => boolean;
  /** Ticket 570: the project whose tabs the strip shows. */
  selected?: string | null;
  /** Ticket 570: the key that shows a project, as the chip it wears while ⌃ is held. */
  keyOf?: (project: string) => string;
  /** Ticket 377: the key that opens a session's tab, as the chip its row wears while ⌘ is held; empty when the session is not in the visible project's first nine tabs. */
  tabKeyOf?: (sessionId: string) => string;
  onAction: (d: Decision) => void;
  /** v1a-08: signal only shows the group bar and counts, not what is asked. */
  signal?: boolean;
  /** v1b-18: board decision items (kind `board`), placed by project. */
  board?: Decision[];
  /** V2-9a: groups, pins and fold state from tree.toml. */
  projects: ProjectTree;
  /** TREEROWS: what V2-8a and V2-8b know about each worktree, by path (PR state, folder gone, new). Empty today. */
  facts?: ReadonlyMap<string, WorktreeFact>;
  /** Opens Tidy for a project; without this callback, managed worktrees use the worktree dialog state. */
  onCleanUp?: (project: string) => void;
  /** V2-8a: the core's worktree list and the row actions (rename inline, remove, open, the progress rows). */
  wt?: Worktrees;
  /** V2-8e: answers from a decision row or its peek (one per item, see `answerOnce`). Absent, rows offer details only. */
  onAnswer?: OnAnswer;
  /** V2-8e: details, a row click or Enter: jump to the session's panel and its decision card. */
  onDetails?: (d: Decision) => void;
  /** D5b lane B: widgets nested under a project row as sub-views. Absent, the tree shows none. */
  subviews?: SubViewsCtx;
  /** V2-14c: the window text for the chosen language; absent, English. */
  t?: T;
  /** V2-CF4: the core client, for the session's sub-agent rows. Absent, none are shown. */
  core?: CoreClient;
}


/** V1A-59: rows Clear done hid, kept in this window's storage; a broken store hides nothing. */
// Mirrors the core's CLOSE_UNDO_MS (sessions.rs); the core does not expose it. undo-pause.spec.ts fails when they differ.
const CLOSE_UNDO_MS = 10_000;
const CLEARED = 'nunchiro.agentsCleared.v1';
const loadCleared = (): string[] => {
  try {
    const v = JSON.parse(localStorage.getItem(CLEARED) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
};
const done = (s: Session) => s.state === 'closed' || agentState(s) === 'exited'; // ticket 286: an ended agent is done

/** V1A-59: running sessions first, then the rest, each in spawn order. */
export const agentsOrder = (sessions: Session[], order: string[]) => {
  const o = orderSessions(sessions, order);
  return [...o.filter((s) => s.state === 'running'), ...o.filter((s) => s.state !== 'running')];
};

/** The catalogue for <html lang>, which App sets from the language setting (useAppSettings); redone when it changes. */
function useHtmlLangT(): T {
  const [lang, setLang] = useState(() => document.documentElement.lang);
  useEffect(() => {
    const ob = new MutationObserver(() => setLang(document.documentElement.lang));
    ob.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
    return () => ob.disconnect();
  }, []);
  return useMemo(() => makeT((lang || 'en') as Lang, navigator.language), [lang]);
}

export function Agents(p: Pick<Props, 'sessions' | 'order' | 'current' | 'onOpen'> & { core?: CoreClient }) {
  const list = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [below, setBelow] = useState(0);
  const [cleared, setCleared] = useState(loadCleared);
  // needs 49: while the pointer or focus is in the list, rows keep the order they had on entry; new ones append.
  const [held, setHeld] = useState<string[] | null>(null);
  const inside = useRef({ pointer: false, focus: false });
  const t = useHtmlLangT(); // the Agents zone gets no catalogue from the window (windows.tsx); <html lang> is the window's language
  const live = agentsOrder(p.sessions, p.order).filter((s) => !cleared.includes(s.id));
  const byId = new Map(live.map((s) => [s.id, s]));
  const ordered = held ? [...held.filter((id) => byId.has(id)).map((id) => byId.get(id)!), ...live.filter((s) => !held.includes(s.id))] : live;
  const hold = () => setHeld((h) => h ?? ordered.map((s) => s.id));
  const section = useRef<HTMLElement>(null);
  const release = () => {
    // A focused row or button removed under the focus (Stop, Clear done) sends no blur: ask where focus is now.
    inside.current.focus = !!section.current?.contains(document.activeElement);
    if (!inside.current.pointer && !inside.current.focus) setHeld(null);
  };
  const target = p.current ?? ordered.at(-1)?.id;
  const keep = (next: string[]) => {
    setCleared(next);
    try {
      localStorage.setItem(CLEARED, JSON.stringify(next));
    } catch {
      // Storage blocked: cleared for this window only.
    }
  };
  const clear = () => {
    // Only rows still present: ids of sessions the core forgot drop out of the store.
    const hidden = p.sessions.filter(done).map((s) => s.id).filter((id) => !cleared.includes(id));
    if (!hidden.length) return;
    keep([...cleared.filter((id) => p.sessions.some((s) => s.id === id)), ...p.sessions.filter(done).map((s) => s.id)]);
    pushUndo({ label: `Cleared ${hidden.length} done session${hidden.length === 1 ? '' : 's'}`, undo: () => keep(cleared) }); // V2-6a
  };
  // V2-6d: a stopped or done row closes at once; the core keeps it 10 s for the status line's Undo.
  const close = (s: Session, core: CoreClient) => {
    const deadline = Date.now() + CLOSE_UNDO_MS; // taken before the request, so never later than the core's own window
    return core.request({ op: 'close', id: s.id }).then(
      () => pushUndo({ label: `Closed ${sessionName(s)}`, undo: () => core.request({ op: 'close_undo', id: s.id }), deadline }),
      () => {}, // shortcut: a refused close only keeps its row (no message line here); show the reason if users miss it
    );
  };
  // V1A-58: rows cut off at the list's bottom edge show as "+N", so a short zone never hides them silently. Counted
  // once a frame, however many scroll or resize events arrive.
  const frame = useRef(0);
  const count = () => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      const l = list.current;
      if (!l) return;
      const bottom = l.getBoundingClientRect().bottom;
      setBelow([...l.querySelectorAll('.ar')].filter((e) => e.getBoundingClientRect().bottom > bottom + 0.5).length);
    });
  };
  const reveal = useRef(() => {});
  reveal.current = () => {
    if (target) list.current?.querySelector(`[data-agent="${CSS.escape(target)}"]`)?.scrollIntoView({ block: 'nearest' });
    count();
  };
  useEffect(() => reveal.current(), [target, ordered.length]);
  // A resize only recounts: it must not snap back a list the user scrolled away. The content box changes with any
  // row's height, the list box with the zone's.
  useEffect(() => {
    const ro = new ResizeObserver(count);
    if (list.current) ro.observe(list.current);
    if (content.current) ro.observe(content.current);
    const away = () => ((inside.current = { pointer: false, focus: false }), setHeld(null));
    // WebKit sends no pointerleave once the hovered node (Clear done, Stop) is removed: entering anything outside ends it.
    const over = (e: PointerEvent) => inside.current.pointer && !section.current?.contains(e.target as Node) && ((inside.current.pointer = false), release());
    window.addEventListener('blur', away);
    document.addEventListener('pointerover', over);
    return () => (ro.disconnect(), cancelAnimationFrame(frame.current), window.removeEventListener('blur', away), document.removeEventListener('pointerover', over));
  }, []);
  const anyDone = live.some(done);
  const core = p.core;
  return (
    <section
      ref={section}
      className="agents"
      aria-label={t('mw.agents.title')}
      onPointerEnter={() => ((inside.current.pointer = true), hold())}
      onPointerLeave={() => ((inside.current.pointer = false), release())}
      onFocus={() => ((inside.current.focus = true), hold())}
      onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && ((inside.current.focus = false), release())}
    >
      <div className="ph">
        <span className="grip" aria-hidden>
          ⋮⋮
        </span>
        {t('mw.agents.title')}
        <span className="r">
          {t('tree.agentsCount', { running: live.filter((s) => agentState(s) === 'running').length, total: live.length })}
          {below > 0 && (
            <>
              {' · '}
              <span className="amore" title={t('mw.agents.more', { n: below })}>
                +{below}
              </span>
            </>
          )}
          {anyDone && (
            <button className="aclear" title={t('mw.agents.clearTip')} onClick={clear}>
              {t('mw.agents.clear')}
            </button>
          )}
        </span>
      </div>
      <div className="alist" ref={list} onScroll={count}>
        <div ref={content}>
          {ordered.map((s) => (
            <div key={s.id} className="arow">
              <button className="ar" aria-current={s.id === p.current} onClick={() => p.onOpen(s.id)} data-agent={s.id} data-menu="agents" data-menu-session={s.id} data-hint-kind="agent" data-hint-session={s.id} data-tip={`${sessionName(s)} · ${basename(s.project)}`} data-tip-clip="">
                <i className="st" data-s={shownStatus(s)} data-problem={s.problem?.case /* V2-5b */} />
                <span className="n">{sessionName(s)}</span>
                <span className="s">
                  {base(s.project)} · {s.account && `${s.account} · ` /* V2-2b */}
                  {t(`mw.status.${shownStatus(s)}`)}
                  <CacheTimer ids={[s.id]} t={t} /> {/* ticket 257 */}
                </span>
              </button>
              {s.state === 'running' ? (
                <button className="astop" aria-label={t('mw.agents.stop', { name: sessionName(s) })} title={t('mw.agents.stopTip')} onClick={() => askStop(s.id)}>
                  <Icon name="square-fill" size={12} />
                </button>
              ) : (
                core && (
                  <button className="astop" aria-label={t('mw.agents.close', { name: sessionName(s) })} title={t('mw.agents.closeTip')} onClick={() => void close(s, core)}>
                    <Icon name="x" size={12} />
                  </button>
                )
              )}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

export function Tree(p: Props) {
  const t = p.t ?? enT;
  const [toolError, setToolError] = useState('');
  // V2-CF4: one read per running session, window only; a shell or a silent ACP agent contributes none. `now` is that
  // read's own clock, so a child's "working 1m" moves with it and not on a timer of its own.
  const { map: kids, now: kidsNow } = useKids(p.core as CoreClient, !!p.core, p.sessions);
  // Which sessions' children are open. Folded is the default, and a row opens or folds every session it draws.
  const [kidsOpen, setKidsOpen] = useState<ReadonlySet<string>>(new Set());
  const toggleKids = (ids: string[]) =>
    setKidsOpen((s) => {
      const n = new Set(s);
      const all = ids.every((id) => n.has(id));
      for (const id of ids) all ? n.delete(id) : n.add(id);
      return n;
    });
  // needs 169: the one sub-agent output panel (a transcript child's own rows, read only), and the status line it may leave.
  const [peek, setPeek] = useState<Peek | null>(null);
  const [kidNote, setKidNote] = useState('');
  const openKid = (session: string, k: Nest) => (setKidNote(''), setPeek({ session, kid: k }));
  // The panel belongs to its parent's row: it closes when that session is gone or no longer running.
  const peekGone = peek && !p.sessions.some((s) => s.id === peek.session && s.state === 'running');
  const flat = (list: Nest[]): Nest[] => list.flatMap((k) => [k, ...flat(k.kids ?? [])]);
  const peekKid = peek && (flat(kids.get(peek.session) ?? []).find((k) => k.id === peek.kid.id) ?? peek.kid); // its state word follows the row
  /** The row's own session children, while open, right under it (option A: nothing extra while folded). */
  const kidsUnder = (sessions: Session[]) =>
    sessions.map((s) => <Kids key={`kids-${s.id}`} id={s.id} kids={kids.get(s.id) ?? []} open={kidsOpen.has(s.id)} now={kidsNow} onOpen={(k) => openKid(s.id, k)} t={t} />);
  /** The row's `↳ N`, at its right end; the words are in the label and the tooltip only. */
  const kidsCount = (sessions: Session[], name: string, over = false) => {
    const list = sessions.flatMap((s) => kids.get(s.id) ?? []);
    const ids = sessions.map((s) => s.id);
    return list.length ? <KidCount ids={ids} name={name} kids={list} open={ids.every((id) => kidsOpen.has(id))} onToggle={() => toggleKids(ids)} over={over} t={t} /> : null;
  };
  const listed = p.wt?.list;
  // Ticket 990 slice d: while a Home teammate exists, the Home folder's sessions sit in the Home group, not as a project.
  const team = useTeam(p.core as CoreClient, !!p.core);
  useAcpNames(p.core, p.sessions.some((s) => s.kind === 'acp' && !!s.level)); // ticket 994
  // A store that throws (private window, blocked site data) must not take the window down: the suggestion shows, off for this run only.
  const [leadOff, setLeadOff] = useState(() => { try { return localStorage.getItem(LEAD_OFF) === '1'; } catch { return false; } });
  // Ticket 1032: the group itself shows with no Home teammate too (its "Set up" row); the folder stays a project head until one exists.
  const homeOn = !!team.home && homeMates(team).length > 0;
  const treeSessions = useMemo(() => (homeOn ? p.sessions.filter((s) => s.project !== team.home) : p.sessions), [homeOn, team.home, p.sessions]);
  // Look 1117 v11 C NC6: with no Home teammate the Home folder is a project head; it reads "Home", never its folder's "home".
  const homeWord = t('assistants.title');
  const named = useMemo(() => (team.home ? { ...p.projects.tree, names: { [team.home]: homeWord, ...p.projects.tree.names } } : p.projects.tree), [team.home, p.projects.tree, homeWord]);
  const live = useMemo(() => withNames(withListed(withoutClosedHeads(buildTree(treeSessions, p.order, p.board, p.projects.tree.added), p.projects.tree), listed ?? []), named), [treeSessions, p.order, p.board, p.projects.tree, listed, named]); // v1b-18: board; V2-8a: listed worktrees
  const facts = p.wt?.facts ?? p.facts;
  const [held, setHeld] = useState<{ tree: Machine[]; items: Map<string, Decision[]>; pt: TreeState } | null>(null);
  // V2-8a: a worktree created, renamed or removed is the user's own act: the held rows take it at once.
  // The core adopting a session's own worktree (V2-CF3) is not the user's act: the row waits like the session does.
  const before = useRef(listed);
  useEffect(() => {
    const old = before.current;
    before.current = listed;
    const kept = (old ?? []).every((o) => listed?.some((l) => JSON.stringify(l) === JSON.stringify(o)));
    const added = (listed ?? []).filter((l) => !old?.some((o) => o.path === l.path));
    if (kept && added.length && added.every((l) => p.sessions.some((x) => x.cwd === l.path))) return;
    setHeld((h) => h && { ...h, tree: live });
  }, [listed]); // eslint-disable-line react-hooks/exhaustive-deps
  const [leaving, setLeaving] = useState(false);
  const pointer = useRef(false);
  const focus = useRef(false);
  const timer = useRef<number>(0);
  const idle = useRef<number>(0);
  const hold = () => {
    window.clearTimeout(timer.current);
    setLeaving(false);
    successor.current = null; // a re-freeze cancels a pending focus move
    window.clearTimeout(idle.current);
    idle.current = window.setTimeout(() => drop.current(true, true), IDLE_MS);
    if (!held) setHeld({ tree: live, items: new Map(live.flatMap((m) => m.groups.map((g) => [g.project, g.items] as const))), pt: p.projects.tree });
  };
  // Pending changes apply ~150 ms after leaving: answered rows fade out first, new ones fade in as they mount.
  const release = () => {
    // Ticket 625: a focused button that unmounts (the row's "Just deny") fires no blur, so the flag would hold the tree
    // frozen for good once the pointer leave had cleared the idle bound. Read where focus really is.
    if (focus.current && !aside.current?.contains(document.activeElement) && !overlay(document.activeElement)) focus.current = false;
    if (!held || pointer.current || focus.current) return;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return setHeld(null);
    setLeaving(true);
    timer.current = window.setTimeout(() => (setHeld(null), setLeaving(false)), 150);
  };
  // Every way the pointer or focus can be lost without a leave/blur event also releases: window blur, page hidden,
  // pointercancel, the pointer leaving the window, and the idle bound above.
  const drop = useRef((_focusToo: boolean, _keepFocus?: boolean) => {});
  drop.current = (focusToo, keepFocus) => {
    window.clearTimeout(idle.current);
    pointer.current = false;
    if (focusToo) focus.current = false;
    if (keepFocus) successor.current = successorOfFocus(aside.current);
    release();
  };
  // needs 49 / v1a-28: when the idle release removes the answered row that holds focus, focus moves to a neighbor
  // instead of falling to body. The move is silent: it neither re-freezes the tree nor touches the live region.
  const aside = useRef<HTMLElement>(null);
  const successor = useRef<{ item?: string; project: string; from?: string } | null>(null);
  const moving = useRef(false);
  useEffect(() => {
    const to = successor.current;
    if (held || !to) return;
    successor.current = null;
    // The tree's own zone section (clicked empty space) is no choice among the rows, like body; another zone's is.
    const f = document.activeElement;
    // Since needs 213 the answered session's row stays (idle), whether or not React remounts it: focus still on that row moves too.
    const stays = !!to.from && f?.closest<HTMLElement>('.row.wt2')?.dataset.menuSession === to.from;
    if (f && f !== document.body && !stays && !(f.matches('.lz') && aside.current && f.contains(aside.current))) return; // the user already put focus somewhere
    const grp = [...(aside.current?.querySelectorAll<HTMLElement>('.grp') ?? [])].find((g) => g.dataset.project === to.project);
    const el = (to.item && grp?.querySelector<HTMLElement>(`.q[data-item="${CSS.escape(to.item)}"]`)?.closest('.sess')?.querySelector<HTMLElement>('.row.wt2, .q[tabindex]')) || grp?.querySelector<HTMLElement>('.head .n');
    moving.current = true;
    el?.focus();
    moving.current = false;
  }, [held]);
  useEffect(() => {
    const away = () => drop.current(true);
    const gone = () => drop.current(false);
    const out = (e: PointerEvent) => e.relatedTarget === null && gone();
    const hidden = () => document.visibilityState === 'hidden' && away();
    window.addEventListener('blur', away);
    document.addEventListener('visibilitychange', hidden);
    window.addEventListener('pointerout', out);
    document.documentElement.addEventListener('mouseleave', gone);
    return () => {
      window.removeEventListener('blur', away);
      document.removeEventListener('visibilitychange', hidden);
      window.removeEventListener('pointerout', out);
      document.documentElement.removeEventListener('mouseleave', gone);
      window.clearTimeout(timer.current);
      window.clearTimeout(idle.current);
    };
  }, []);
  // Ticket 28 (5): an overlay (menu, palette, group dialog) rides on the freeze while it is open. When the last one closes, the
  // pointer and focus are read afresh: with neither in the tree the pending changes apply now, not after the idle bound.
  useEffect(() => {
    if (!held) return;
    let seen = false;
    let wait = 0;
    const ob = new MutationObserver(() => {
      if (document.querySelector('.cmenu, .palette')) return void (seen = true);
      if (!seen) return;
      seen = false;
      window.clearTimeout(wait);
      wait = window.setTimeout(() => {
        pointer.current = !!aside.current?.matches(':hover');
        focus.current = !!aside.current?.contains(document.activeElement);
        release();
      }, 0); // after the dialog's cleanup has put focus back
    });
    ob.observe(document.body, { childList: true, subtree: true });
    return () => (ob.disconnect(), window.clearTimeout(wait));
  }, [!held]); // eslint-disable-line react-hooks/exhaustive-deps
  const byId = withResumed(new Map(p.sessions.map((s) => [s.id, s])), p.sessions); // a resumed lead's merge card names its old id (look v13 B N13-S3-3)
  // Ticket 286 item 2: closing the session whose row holds focus ends the hold: the row goes (focus moves to its neighbour) and a
  // session that ended meanwhile shows. Without it the closed row stayed, with the tree frozen, until the idle bound.
  useEffect(() => {
    if (!held) return;
    const id = document.activeElement?.closest<HTMLElement>('.row.wt2')?.dataset.menuSession;
    if (id && !byId.has(id)) drop.current(true, true);
  }, [p.sessions, held]); // eslint-disable-line react-hooks/exhaustive-deps
  const liveGroup = new Map(live.flatMap((m) => m.groups.map((g) => [g.project, g] as const)));
  const shown = held?.tree ?? live;
  const [openWt, setOpenWt] = useState<Set<string>>(new Set());
  // Groups, pins and folds hold still with the rows (a dissolve prunes fold keys, which would move them); the user's own
  // fold clicks below update the held copy as well, so they apply at once.
  const tree = held?.pt ?? p.projects.tree;
  const setFolds = (folded: string[]) => setHeld((h) => h && { ...h, pt: { ...h.pt, folded } });
  // needs 171: a project dragged onto a group head is the user's own edit: the held rows take the core's answer at once.
  const ownEdit = useRef(false);
  useEffect(() => {
    if (!ownEdit.current) return;
    ownEdit.current = false;
    setHeld((h) => h && { ...h, pt: p.projects.tree });
  }, [p.projects.tree]); // eslint-disable-line react-hooks/exhaustive-deps
  // F15: a project added (folder picked) or removed is the user's own act too: the held rows take it at once.
  const added = p.projects.tree.added?.join('\n') ?? '';
  useEffect(() => setHeld((h) => h && { ...h, tree: live, pt: p.projects.tree }), [added]); // eslint-disable-line react-hooks/exhaustive-deps
  const pdrag = useProjectDrag(p.projects, t, () => (ownEdit.current = true));

  // Expand all: opens groups (one level; Alt also opens the clean-up folds) and the next press puts the prior
  // folding back. The prior folding lives in this window's memory only.
  // A refused edit puts the core's tree back; the held copy follows it.
  const notice = p.projects.notice;
  useEffect(() => {
    if (notice) setFolds(p.projects.tree.folded);
  }, [notice]);
  const prior = useRef<{ folded: string[]; wt: Set<string> } | null>(null);
  // Ticket 28 (3): the collapsed projects an Alt press opened. Window memory like `openWt`: the saved collapse list is not touched
  // (App's `onToggle` flips one project from its own copy, so several in a row would overwrite each other), and the next press clears it.
  const [deepOpen, setDeepOpen] = useState<ReadonlySet<string>>(new Set());
  const expandAll = useRef((_deep: boolean) => {});
  expandAll.current = (deep) => {
    const open = expandedList(tree);
    const now = prior.current;
    if (now && sameKeys(tree.folded, open)) {
      setFolds(now.folded);
      void p.projects.edit({ op: 'fold_set', folded: now.folded });
      setOpenWt(now.wt);
      setDeepOpen(new Set());
      prior.current = null;
      return;
    }
    // From the core's own list: the held copy may predate the first tree_get reply.
    prior.current = { folded: p.projects.tree.folded, wt: openWt };
    setFolds(open);
    void p.projects.edit({ op: 'fold_set', folded: open });
    if (deep) {
      setOpenWt(new Set(live.flatMap((m) => m.groups.filter((g) => cleanable(g, facts ?? new Map()).length).map((g) => g.project))));
      setDeepOpen(new Set(live.flatMap((m) => m.groups.map((g) => g.project)).filter((project) => p.collapsed.includes(project))));
    }
  };
  useEffect(() => {
    const on = (e: Event) => expandAll.current(!!(e as CustomEvent<{ deep?: boolean }>).detail?.deep);
    window.addEventListener(EXPAND_ALL, on);
    return () => window.removeEventListener(EXPAND_ALL, on);
  }, []);
  const expanded = !!prior.current && sameKeys(tree.folded, expandedList(tree));

  // V2-8a: a managed worktree's row: F2 or a click on the selected row's name renames its label inline; Backspace or
  // Delete removes it; a row with no session is selected by a click and opened by a double-click or Enter.
  const managed = (path: string) => p.wt?.list.find((l) => l.path === path);
  const pressed = useRef(false);
  const nameTimer = useRef(0);
  // The row comes back once the editor unmounts: focus it after that commit.
  const refocusTo = useRef<string | null>(null);
  const refocus = (path: string) => void (refocusTo.current = `[data-wt="${CSS.escape(path)}"] button`);
  // V2.5-55: a main-folder session row has no worktree path; its button carries the session id.
  const refocusSession = (id: string) => void (refocusTo.current = `button.row.wt2[data-menu-session="${CSS.escape(id)}"]`);
  useEffect(() => {
    const sel = refocusTo.current;
    const el = sel && aside.current?.querySelector<HTMLElement>(sel);
    if (el) ((refocusTo.current = null), el.focus());
  });
  // V2.5-55: F2 on a focused main-folder row renames its session inline. The app's global keys run on window in the capture phase
  // and own F2 there (the tab's rename, keys.ts), so a row's onKeyDown never sees it: this listener is added when the tree mounts,
  // before the app's (which re-registers on each render), and answers first.
  const wtLive = useRef(p.wt);
  wtLive.current = p.wt;
  useEffect(() => {
    const onF2 = (e: KeyboardEvent) => {
      if (e.key !== 'F2' || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      const a = document.activeElement;
      const id = a instanceof HTMLElement && aside.current?.contains(a) && a.matches('button.row.wt2[data-menu="treerow"]') ? a.dataset.menuSession : undefined;
      if (id) (e.preventDefault(), e.stopImmediatePropagation(), wtLive.current?.setRenamingSession(id));
    };
    window.addEventListener('keydown', onF2, true);
    return () => window.removeEventListener('keydown', onF2, true);
  }, []);
  // V2-8e: a decision's details jump to its session's card; a board item (no session) opens its strip card.
  // A stale flag or a background note is a row state, not a decision (asks()): its row opens the session like any quiet row.
  const details = (d: Item) => (d.session_id && !asks([d]).length ? p.onOpen(d.session_id) : d.session_id && p.onDetails ? p.onDetails(d) : p.onAction(d));
  const noAnswer: OnAnswer = () => null;
  // needs 171: "+N" is a button that shows the rows it counts in place; the key is the project or group it sits under. Not stored.
  const [moreOpen, setMoreOpen] = useState<ReadonlySet<string>>(new Set());
  // Ticket 1022: a project's finished main-folder sessions (failed ones keep their row): those in their 10 minutes, and
  // those of today after them (the head's hollow bars). A row the owner moved to done has no 10 minutes.
  const settled = (s: Session) => !!p.wt?.settled.has(s.id);
  const finishedOf = (main: Session[], now: number) => {
    const quiet = main.map((s) => byId.get(s.id) ?? s).filter((s) => (ended(s) || settled(s)) && status(s) !== 'failed');
    const justs = quiet.filter((s) => !settled(s) && isJust(s, now));
    return { justs, today: quiet.filter((s) => !justs.includes(s) && isToday(s, now)) };
  };
  // Ticket 1022: the project whose hollow bars' popover is open, and the bars it hangs from.
  const [donePop, setDonePop] = useState<{ project: string; anchor: HTMLButtonElement } | null>(null);
  // Ticket 1022: a finished session's end is noted as this window sees it; the tree draws again when a "just finished"
  // row's 10 minutes end, and each minute while one shows (its "N min").
  noteEnds(p.sessions, (s) => ended(s) || !!p.wt?.settled.has(s.id), !!p.core?.snapped);
  const [, setTick] = useState(0);
  const nextEnd = Math.min(nextMidnight(Date.now()), ...p.sessions.map((s) => (finishedAt(s) ?? -Infinity) + JUST_MS).filter((at) => at > Date.now()));
  const justShown = p.sessions.some((s) => isJust(s, Date.now()));
  useEffect(() => {
    const timer = window.setTimeout(() => setTick((n) => n + 1), Math.max(0, Math.min(nextEnd - Date.now(), justShown ? 60_000 : Infinity)));
    return () => window.clearTimeout(timer);
  });
  const headHold = useHeadHold();
  const moreBtn = (key: string, n: number, word: string) => {
    const open = moreOpen.has(key);
    return (
      <button type="button" className="more on" data-hint-quiet data-more={n} aria-expanded={open} onClick={() => setMoreOpen((s) => toggle(s as Set<string>, key))}>
        {open ? t('tree.showFewer') : word}
      </button>
    );
  };
  // Ticket 388 (replaces the needs 171 pills): a strip colour, the gathered strip and "]" / "[" go to one session. Only the folders
  // on the way open, in this window only, and the ones the app opened for the step before fold back (folds the user made stay).
  const [auto, setAuto] = useState<{ project?: string; group?: string }>({});
  const target = useRef<{ id: string; how: 'open' | 'focus'; tone?: Tone; at: number } | null>(null);
  const liveSessions = live.flatMap((m) => m.groups.flatMap((g) => [...g.main, ...g.worktrees.flatMap((w) => w.sessions)]));
  const go = (s: Session, how: 'open' | 'focus', tone?: Tone) => {
    const g = live.flatMap((m) => m.groups).find((x) => [...x.main, ...x.worktrees.flatMap((w) => w.sessions)].some((y) => y.id === s.id));
    if (!g) return;
    const group = tree.groups.find((x) => x.projects.includes(g.project))?.name;
    setAuto({ project: p.collapsed.includes(g.project) && !deepOpen.has(g.project) ? g.project : undefined, group: group && groupFolded(tree, group) ? group : undefined });
    target.current = { id: s.id, how, tone, at: Date.now() };
    if (how === 'open') p.onOpen(s.id);
  };
  // The same colour clicked again goes to its next session.
  const lastPick = useRef<{ key: string; i: number } | null>(null);
  const pick = (key: string) => (tone: Tone, list: Session[]) => {
    const k = `${key}:${tone}`;
    const i = lastPick.current?.key === k ? (lastPick.current.i + 1) % list.length : 0;
    lastPick.current = { key: k, i };
    go(list[i], 'open', tone);
  };
  const queue = urgentQueue(liveSessions);
  const walked = useRef<string | null>(null);
  const stepTo = (dir: 1 | -1) => {
    const at = queue.findIndex((s) => s.id === walked.current);
    return queue[at < 0 ? (dir > 0 ? 0 : queue.length - 1) : (at + dir + queue.length) % queue.length];
  };
  const nextUp = queue.length ? sessionName(stepTo(1)) : undefined;
  /** "]" and "[" walk the urgent queue while the sidebar has focus: the path opens and focus lands on the row. */
  const bracket = (e: ReactKey<HTMLElement>) => {
    // keyCode 229: WebKit's keydown right after compositionend (the IME's last key), not a "]" the user meant for the tree.
    if ((e.key !== ']' && e.key !== '[') || e.metaKey || e.ctrlKey || e.altKey || e.nativeEvent.isComposing || e.keyCode === 229 || !queue.length) return;
    // Keys from a dialog or menu portalled out of the tree still bubble here through React: they are not the tree's.
    if ((e.target as Element).closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="dialog"], [role="menu"], .cmenu')) return;
    e.preventDefault();
    const s = stepTo(e.key === ']' ? 1 : -1);
    walked.current = s.id;
    go(s, 'focus');
  };
  /** needs 170 (1): the tip line of an unread session on this row. */
  const unreadLine = (sessions: Session[]) => (sessions.some((s) => p.projects.unreadSessions.has(s.id)) ? t('tree.status.unreadTip') : undefined);
  const lineRow = (l: Line, head: boolean, row?: (details: () => void) => ReactNode, folded = false) => (
    <DecisionRow key={`line:${l.key}`} t={t} line={l} head={head} folded={folded} session={byId.get(l.session)} onAnswer={p.onAnswer ?? noAnswer} onDetails={details} row={row} />
  );
  // F2 routes by the focused element (useGlobalKeys). WebKit (the app's webview) does not focus a button on a mouse click, so a
  // press on the row itself focuses it: F2 then renames the row, not the tab. Not a touch: its compat mouse events focus the row
  // after the pointer has left, which the row's tooltip (WtRow `hot`) relies on. A script focus in pointerdown comes before the
  // browser sees the mouse, so it would count as keyboard focus (:focus-visible: the ring and ⋯ over the row's time).
  const focusRow = (e: { target: EventTarget; pointerType: string }) => e.pointerType !== 'touch' && (e.target as Element).closest<HTMLElement>('.row.wt2')?.focus({ focusVisible: false });
  // `pre`: under a folded group the row is the only one for its project, so it names the project too (mockup ③ "lumen · rehfix").
  const wtRow = (w: Worktree, state: ReturnType<typeof rowState>, sessions: Session[], sid: string | undefined, lines: Line[] = [], folded = false, pre?: string) => {
    const l = managed(w.path);
    const wt = p.wt;
    // V2.5-55 (needs 178 B1): a working or waiting main-folder session's own row (path `main:<id>`): its menu is `treerow`, F2 renames it.
    const main = w.path.startsWith('main:') && !!sid && !!wt && !l ? sid : undefined;
    const name = main && sessions[0] ? sessionName(sessions[0]) : w.name; // the live label: a rename shows at once, even while the tree holds still
    // Seventh look (B S3): a Claude and a Codex session named by the same first message read alike in the tree; each then
    // says its agent first, in the tab's own words ("codex · Read app.py…"). Words only: a row's icon stays its state.
    // Eighth look (B6-S3-3): "alike" is what a row can show. Two first messages that start with the same words ("Use no
    // connector or MCP tool. Run…" / "…Reply…") are cut to the same text, so names that share their first 20 characters count.
    const one = main ? sessions[0] : undefined;
    if (one?.label && p.sessions.some((o) => o.id !== one.id && o.project === one.project && o.kind !== one.kind && o.state !== 'closed' && sessionName(o).slice(0, 20) === name.slice(0, 20))) pre ??= one.kind;
    const selected = sessions.some((s) => s.id === p.current) || (!sessions.length && !!l && wt?.selected === l.path); // a row with a session shows the active session, not a focus selection
    const count = asks(lines[0]?.items ?? []).length; // N12-S2-4: a background note is no ask to count
    const pr = facts?.get(w.path)?.pr?.number;
    const make = (onOpen: () => void) => <WtRow name={name} pre={pre} state={pr ? { ...state, pr } : state} sessionId={sid} jumpKey={sid ? p.tabKeyOf?.(sid) : undefined} selected={selected} count={count > 1 ? count : undefined} since={state.at || undefined} onOpen={onOpen} seat={sessions.length === 1 ? sessions[0] : undefined} cacheIds={sessions.map((s) => s.id)} menu={l && wt ? 'worktree' : main ? 'treerow' : undefined} menuTitle={l && wt ? t('tree.rowMenuTitle', { name }) : main ? t('tree.sessionMenuTitle', { name }) : undefined} t={t} />;
    const openIt = () => (sid ? p.onOpen(sid) : l && !l.missing && void wt?.open(l.path));
    // V2-CF4: the count rides on the row's right end. The row is a button, so the count is its sibling in the wrap.
    const kidsOn = kidsCount(sessions, w.name, true);
    // V2-CF3: the row's menu from a visible, labelled control (a right-click is not the only way in); Q6 A14: every row with a menu.
    const more = (
      <button
        className="wtmore"
        data-hint-skip // ticket 389: hidden until hover; the right-click menu
        aria-label={t('tree.actionsFor', { name: main ? name : w.name })}
        aria-haspopup="menu"
        onClick={(e) => {
          const b = e.currentTarget.getBoundingClientRect();
          e.currentTarget.parentElement?.querySelector('.row.wt2')?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: b.left, clientY: b.bottom }));
        }}
      >
        ⋯
      </button>
    );
    const wrap = (row: ReactNode) =>
      !l || !wt ? (
        // A row that is no managed worktree clears the selection: the menu and palette then act on its own project.
        <span className="wtwrap" onFocusCapture={() => wt?.select(null)} onContextMenu={() => wt?.select(null)} onPointerDown={focusRow}>
          {row}
          {kidsOn}
          {main && more}
        </span>
      ) : (
        <span
          className="wtwrap"
          data-wt={l.path}
          onFocus={() => !sid && wt.select(l.path)} // a row with a session is the active session's: no selection to change
          onContextMenu={() => wt.select(l.path)} // the menu's row actions act on the selected worktree
          onPointerDown={(e) => {
            pressed.current = selected || document.activeElement?.closest('[data-wt]') === aside.current?.querySelector(`[data-wt="${CSS.escape(l.path)}"]`);
            focusRow(e);
          }}
          onKeyDown={(e) => {
            if (e.key === 'F2') (e.preventDefault(), wt.setRenaming(l.path));
            else if ((e.key === 'Backspace' || e.key === 'Delete') && !e.metaKey && !e.altKey && !e.ctrlKey) (e.preventDefault(), wt.remove(l.path));
          }}
          onClickCapture={(e) => {
            if ((e.target as Element).closest('.wtmore')) return;
            if (e.detail === 0) {
              // Enter or Space on the row
              if (!sid) (e.stopPropagation(), openIt());
              return;
            }
            if (e.detail >= 2) return window.clearTimeout(nameTimer.current);
            if (!sid) wt.select(l.path);
            // A row with a session opens it on a click (adopted session folders too); its label is renamed by F2 or the menu.
            if (!sid && (e.target as Element).closest('.n') && pressed.current) {
              e.stopPropagation();
              nameTimer.current = window.setTimeout(() => wt.setRenaming(l.path), 400);
            } else if (!sid) e.stopPropagation();
          }}
          onDoubleClick={() => (window.clearTimeout(nameTimer.current), openIt())}
        >
          {row}
          {kidsOn}
          {more}
        </span>
      );
    if (main && p.core && wt?.renamingSession === main) {
      const core = p.core;
      return (
        <RenameField
          key={w.path}
          t={t}
          initial={name}
          field={t('tree.sessionLabelField')}
          hint={t('tree.sessionLabelHint')}
          onSave={async (label) => {
            if (!label) return t('tree.sessionNeedsName');
            try {
              await core.label(main, label);
              return null;
            } catch (e) {
              return tipError(t, e); // the field's tooltip (476)
            }
          }}
          onClose={() => (wt.setRenamingSession(null), refocusSession(main))}
        />
      );
    }
    if (l && wt?.renaming === l.path)
      return <RenameField key={w.path} t={t} initial={listedName(l, wt.sessions)} onSave={(label) => wt.rename(l.path, label)} onClose={() => (wt.setRenaming(null), refocus(l.path))} />;
    // V2-CF4: the session's sub-agents fold under its row; nothing is drawn for a session the core reports none for.
    const under = !folded && kidsUnder(sessions);
    // V2-8e: a your-turn row carries its decision line. Look 1117 v3: a click on the row opens its session, as on any row;
    // the line's ⓘ, Enter and 2 are the jump to the card.
    if (lines.length && !p.signal)
      return (
        <Fragment key={w.path}>
          {lineRow(lines[0], false, () => wrap(make(openIt)), folded)}
          {lines.slice(1).map((x) => lineRow(x, true, undefined, folded))}
          {under}
        </Fragment>
      );
    return (
      <Fragment key={w.path}>
        {wrap(make(() => sid && p.onOpen(sid)))}
        {under}
      </Fragment>
    );
  };
  const foldedState = (worktree: Worktree, session: Session) => {
    const clean = withoutNotes(session);
    return rowState(worktree, [clean], status(clean) === 'failed' ? undefined : facts?.get(worktree.path), undefined, undefined, t);
  };
  type FoldedRow = { group: Group; session: Session; worktree: Worktree; state: RowState } | { group: Group; line: Line };
  const foldedRows = (groups: Group[]): FoldedRow[] => {
    const rows: FoldedRow[] = [];
    for (const group of groups) {
      const sessions = [...group.main, ...group.worktrees.flatMap((w) => w.sessions)];
      for (const session of sessions) {
        const worktree = group.worktrees.find((w) => w.path === session.cwd) ?? { path: session.cwd, name: sessionName(session), sessions: [session] };
        const state = foldedState(worktree, session);
        if (state.tone === 'you' || state.kind === 'fail') rows.push({ group, session, worktree, state });
      }
      // Board decisions have no session row, but must stay reachable under a folded group too.
      for (const line of decisionLines(asks(group.items), null).lines) if (!rows.some((r) => 'session' in r && r.session.id === (byId.get(line.session)?.id ?? line.session))) rows.push({ group, line }); // a line whose asker has no row here stands alone
    }
    return rows.sort((a, b) => Number('state' in b && b.state.kind === 'fail') - Number('state' in a && a.state.kind === 'fail'));
  };
  const renderFolded = (rows: FoldedRow[], key: string) => (
    <>
      {rows.slice(0, moreOpen.has(key) ? rows.length : 2).map((r) => {
        const lines = decisionLines(asks(liveGroup.get(r.group.project)?.items ?? []), held ? asks(held.items.get(r.group.project) ?? []) : null).lines;
        const session = 'session' in r ? byId.get(r.session.id) ?? r.session : null;
        const row = 'session' in r && session
          ? wtRow({ ...r.worktree, name: sessionName(r.session) }, foldedState(r.worktree, session), [session], session.id, lines.filter((l) => (byId.get(l.session)?.id ?? l.session) === session.id), true, r.group.name)
          : 'line' in r ? lineRow(lines.find((l) => l.key === r.line.key) ?? r.line, true, undefined, true) : null;
        const key = 'session' in r ? r.session.id : r.line.key;
        return <div key={key} className="grp" data-project={r.group.name}>{row}</div>;
      })}
      {rows.length > 2 && moreBtn(key, rows.length - 2, t(rows.slice(2).some((r) => 'state' in r && r.state.kind === 'fail') ? 'tree.more' : 'tree.moreWaiting', { n: rows.length - 2 }))}
    </>
  );
  const renderProject = (frozenGroup: Group) => {
              const g: Group = liveGroup.get(frozenGroup.project) ?? frozenGroup;
              // A2 (look 1117): a hold keeps the order, never a worktree row whose folder and sessions are both gone.
              const structure = held ? { ...frozenGroup, worktrees: frozenGroup.worktrees.filter((w) => g.worktrees.some((x) => x.path === w.path) || w.sessions.some((s) => byId.has(s.id))) } : g;
              const collapsed = p.collapsed.includes(g.project) && !deepOpen.has(g.project) && auto.project !== g.project;
              // V2-8e: one decision line per asking session, on its row; a main-folder or project-level one under the header.
              const { lines, fresh } = decisionLines(liveGroup.get(g.project)?.items ?? [], held ? (held.items.get(g.project) ?? []) : null);
              const folded = collapsed;
              const mainId = structure.main[0]?.id ?? structure.worktrees[0]?.sessions[0]?.id;
              const cleanOpen = openWt.has(g.project);
              const mainLive = structure.main.map((s) => byId.get(s.id) ?? s);
              // needs 92 (ticket 180, RC gap 3): a working or waiting main-folder session gets its own row (blue arc, or orange
              // your-turn with its line under it, needs 95); the head stands for the folder, not for it. Which sessions get one
              // is read at freeze, like the worktree rows (needs 49). An idle one has none (V2-CF4).
              // Ticket 294 (4, needs 213; replaces "an idle one has none"): an expanded project shows every live main-folder session
              // (idle ones too); the finished ones are `mainQuiet`. Ticket 1022: they leave the tree (a 10-minute "just
              // finished" row, then the head's history mark); they never had a strip bar, so the strip is as it was.
              // Real-app 11-10 defect 4: a failed agent ended too, but it needs you, so it keeps its own row outside the fold.
              const workIds = new Set(structure.main.filter((s) => !(ended(s) || p.wt?.settled.has(s.id)) || status(s) === 'failed').map((s) => s.id));
              const mainQuiet = mainLive.filter((s) => !workIds.has(s.id));
              const all = [...mainLive, ...structure.worktrees.flatMap((w) => w.sessions.map((s) => byId.get(s.id) ?? s))];
              const failed = failedIn([g]);
              // From the live group, not the frozen structure: the strip updates while the rows hold still (needs 49), and holds with the head's counts.
              const stripOf = stripSessions({ main: g.main.filter((s) => !p.wt?.settled.has(s.id)).map((s) => byId.get(s.id) ?? s) /* item 13: a row moved to done is no idle bar */, worktrees: g.worktrees.map((w) => ({ ...w, sessions: w.sessions.map((s) => byId.get(s.id) ?? s) })) }, facts);
              // Ticket 419 (after 372): a limited session counts with waiting here too, as its group head's label counts it.
              const limited = stripOf.filter((s) => status(s) === 'limited').length;
              const counts = t('tree.counts', { running: all.filter((s) => agentState(s) === 'running').length, working: g.counts.working, waiting: g.counts.waiting + limited, attention: g.counts.attention });
              const shown = headHold.shown(g.project, { waiting: g.counts.waiting, failed, fresh, strip: stripOf }); // TREEHEAD-FREEZE: what the head drew when the hover or focus began
              // TREEROWS: one row per worktree. The order is the one at freeze (frozen sessions); the state shown is live.
              const now = Date.now();
              const { justs, today } = finishedOf(structure.main, now);
              const mainRows = structure.main
                .filter((s) => workIds.has(s.id))
                .map((s) => ({ path: `main:${s.id}`, name: sessionName(s), sessions: [s] }));
              const wtOf = new Map([...mainRows, ...structure.worktrees].flatMap((w) => w.sessions.map((s) => [s.id, w.path] as const)));
              const rowOf = (l: Line) => wtOf.get(byId.get(l.session)?.id ?? l.session); // a resumed asker's old id finds its row
              const linesOf = (w: Worktree) => lines.filter((l) => rowOf(l) === w.path);
              const headLines = lines.filter((l) => !rowOf(l));
              const wtRows = [...mainRows, ...structure.worktrees].map((w) => {
                const fact = facts?.get(w.path);
                // Held, the row keeps its place but takes the live sessions of its folder: a shell restarted there names it (verify look, ticket 991 A7).
                const sessions = (g.worktrees.find((x) => x.path === w.path) ?? w).sessions.map((s) => byId.get(s.id) ?? s);
                const order = rowState(w, w.sessions, fact, now, unreadLine(w.sessions.map((s) => byId.get(s.id) ?? s)), t);
                // needs 49: while held, a row whose line still shows keeps its frozen look (an answered row's tone flip moved its line 1px).
                return { w, sessions, order, state: held && linesOf(w).length ? order : rowState(w, sessions, fact, now, unreadLine(sessions), t) };
              });
              const ordered = byUrgency(wtRows.map((r) => ({ ...r, state: r.order })));
              // Owner 11-17: the lead's row is the project's first row, whatever the urgency order says; the rest keep that order.
              const leads = (r: (typeof wtRows)[number]) => (r.sessions.some((s) => leadSeatMate(s, team)) ? 0 : 1);
              const shownWt = ordered.filter((r) => !leaves(r.state)).map((r) => wtRows.find((x) => x.w === r.w)!).sort((a, b) => leads(a) - leads(b));
              const gone = ordered.filter((r) => leaves(r.state)).map((r) => wtRows.find((x) => x.w === r.w)!);
              // A waiting main-folder row sits with the header's lines, so the needs 49 cap (two, then "+N") still holds for it.
              const atHead = (r: (typeof shownWt)[number]) => linesOf(r.w).length > 0 && (folded || mainRows.includes(r.w));
              const units: ({ line: Line } | { r: (typeof shownWt)[number] })[] = [...headLines.map((line) => ({ line })), ...shownWt.filter(atHead).map((r) => ({ r }))];
              const more = units.slice(2).reduce((n, u) => n + ('line' in u ? u.line.items.length : linesOf(u.r.w).reduce((m, l) => m + l.items.length, 0)), 0);
              const open = (sessions: Session[]) => (sessions.find((s) => status(s) === 'waiting') ?? sessions.find((s) => status(s) === 'failed') ?? sessions.find((s) => status(s) === 'working') ?? sessions.find((s) => agentState(s) === 'running') ?? sessions[0])?.id;
              return (
                <div key={g.project} className="grp" data-urgency={g.urgency} data-project={g.name} role="group" aria-label={t('tree.projectLabel', { name: g.name, urgency: t(`mw.status.${g.urgency}`) })}>
                  <div className="row head" data-project-path={g.project} onPointerDown={(e) => pdrag.start(e, g.project, g.name)} {...headHold.bind(g.project, { waiting: g.counts.waiting, failed, fresh, strip: stripOf })} onContextMenu={() => (p.projects.setMenuProject(g.project), p.wt?.select(null))} aria-current={structure.main.some((s) => s.id === p.current) ? 'true' : undefined} data-selected={p.selected === g.project ? '' : undefined}>
                    <button className="chev" data-hint-quiet aria-expanded={!collapsed} aria-label={t(collapsed ? 'tree.expand' : 'tree.collapse', { name: g.name })} onClick={() => (auto.project === g.project ? setAuto((a) => ({ ...a, project: undefined })) : deepOpen.has(g.project) ? setDeepOpen((s) => toggle(s as Set<string>, g.project)) : p.onToggle(g.project))}>
                      <Icon name={folded ? 'chevron-right' : 'chevron-down'} size={10} />
                    </button>
                    <HeadName name={g.name} path={g.project} data-hint-kind="project" data-menu={`project${mainId ? '' : '-empty'}${mainId && all.some((s) => s.machine) ? '-remote' : ''}${tree.groups.some((tg) => tg.projects.includes(g.project)) ? '' : '-loose'}`} data-menu-session={mainId} data-menu-project={g.project} data-menu-title={g.name} onClick={() => (p.onSelect?.(g.project) ? undefined : mainId ? p.onOpen(mainId) : askNew(g.project))}>
                      {p.core && <ProjectIcon core={p.core} project={g.project} />}
                      <b>{g.name}</b>
                    </HeadName>
                    {tree.pins.includes(g.project) && (
                      <span className="pin-mark" role="img" aria-label={t('tree.pinned')} title={t('tree.pinned')}>
                        ⊤
                      </span>
                    )}
                    <span className="r" role="group" aria-label={counts} title={counts} />
                    {p.keyOf?.(g.project) && <kbd className="kbd pjkey" aria-hidden>{p.keyOf(g.project)}</kbd>}
                    {/* ko/ v2-8a-groups.html G2: a muted "main" after the counts when the main folder has a session */}
                    {/* Look 1117 v7 (S2-3): not for a folder under no repository (it has no checkout, and "main" read as its branch); v13 Home S3-5: nor one gone from disk */}
                    {structure.main.some((s) => !noCheckout(s)) && <span className="d">{t('tree.main')}</span>}
                    {/* One persistent live region: it exists empty before the text changes, so "new N" is announced. The group header's serves a folded group only: open, the project's own chip says it (ticket 28 (4)). After "main", as the mockup's "1 new" mark. */}
                    {!p.signal && (
                      <span className="chip" role="status" aria-live="polite" aria-label={fresh > 0 ? plural(t, 'tree.newWaiting', fresh) : undefined} data-shown={shown.fresh !== fresh ? (shown.fresh > 0 ? t('tree.newChip', { n: shown.fresh }) : '') : undefined}>
                        {fresh > 0 ? t('tree.newChip', { n: fresh }) : ''}
                      </span>
                    )}
                    {!p.signal && today.length > 0 && <DoneBars n={today.length} open={donePop?.project === g.project} onClick={(el) => setDonePop((d) => (d?.project === g.project ? null : { project: g.project, anchor: el }))} t={t} />}
                    <Strip sessions={shown.strip ?? stripOf} dim={!collapsed} next={nextUp} onPick={pick(`p:${g.project}`)} t={t} />
                    {/* V2-CF4: a main-folder session has no row of its own, so the head row is its session row and `↳ N`
                        is that row's right end, after the name and "main" (option A: "fix-queue claude ↳ 3"). */}
                    {!p.signal && kidsCount(mainQuiet, g.name)}
                    {/* V2.5-15: Open in editor and Set icon, hover buttons like "+" */}
                    {p.core && <ProjectTools core={p.core} project={g.project} name={g.name} onError={setToolError} t={t} />}
                    {/* F15: an added project with no session leaves the tree the way it came: its own remove */}
                    {!all.length && tree.added?.includes(g.project) && (
                      <button className="ptool pdrop" aria-label={t('tree.removeAdded', { name: g.name })} title={t('tree.removeAdded', { name: g.name })} onClick={() => void p.projects.edit({ op: 'add', project: g.project, added: false })} />
                    )}
                    {/* v1a-59: start a session in this project */}
                    <button className="padd" aria-label={t('tree.newSession', { name: g.name })} title={t('tree.newSession', { name: g.name })} onClick={() => askNew(g.project, undefined, all.find((x) => x.machine)?.machine)} />
                    {/* UXFIX (a): the same New worktree flow as the project menu */}
                    {p.wt && (
                      <button className="padd wtadd" aria-label={t('tree.newWorktree', { name: g.name })} title={t('tree.newWorktree', { name: g.name })} onClick={(e) => { e.currentTarget.focus(); const r = e.currentTarget.getBoundingClientRect(); p.wt?.setAsk({ kind: 'create', project: g.project, anchor: { top: r.top, bottom: r.bottom, left: r.left, right: r.right } }); }}>
                        <Icon name="git-branch" size={14} />
                        <span className="vh">{t('tree.worktreeAdd')}</span>
                      </button>
                    )}
                  </div>
                  {/* V2-8e: a waiting main-folder session's row with its line, or a project-level decision, sits right under the header. Folding hides only quiet
                      rows: your-turn rows and their lines stay (HIDEROWS). Under the header, and folded, at most two show
                      and the rest count as "+N" (the V2-9 waiting-row rule). */}
                  {!p.signal && units.slice(0, moreOpen.has(`project:${g.project}`) ? units.length : 2).map((u) => 'line' in u ? lineRow(u.line, true, undefined, folded) : wtRow(u.r.w, u.r.state, u.r.sessions, open(u.r.sessions), linesOf(u.r.w), folded))}
                  {!p.signal && more > 0 && moreBtn(`project:${g.project}`, more, t(folded ? 'tree.moreWaiting' : 'tree.more', { n: more }))}
                  {!folded && (
                    <>
                      {/* V2-CF4: the main folder has no worktree row of its own: its sessions' children sit here. */}
                      {kidsUnder(mainQuiet)}
                      {/* Ticket 1022 (owner, mockup 5; lead first, owner 11-17): the lead's row, then main-folder rows (a
                          just-finished one last among them), then worktree rows, then the clean-up fold; each part in urgency order. */}
                      {shownWt.filter((r) => !atHead(r) && leads(r) === 0).map((r) => wtRow(r.w, r.state, r.sessions, open(r.sessions), linesOf(r.w)))}
                      {shownWt.filter((r) => !atHead(r) && leads(r) === 1 && mainRows.includes(r.w)).map((r) => wtRow(r.w, r.state, r.sessions, open(r.sessions), linesOf(r.w)))}
                      {!p.signal && justs.map((s) => <JustRow key={`just:${s.id}`} s={s} now={now} t={t} onOpen={() => p.onOpen(s.id)} />)}
                      {shownWt.filter((r) => !atHead(r) && leads(r) === 1 && !mainRows.includes(r.w)).map((r) => wtRow(r.w, r.state, r.sessions, open(r.sessions), linesOf(r.w)))}
                      {p.wt?.creating
                        .filter((c) => c.project === g.project)
                        .map((c) => (
                          <span key={`creating-${c.key}`} className="row wt2 idle creating light-run" role="status" aria-label={t('tree.creatingLabel', { name: c.name })}>
                            <span className="n">{c.name}</span> <span className="dim">{t('tree.creating')}</span>
                          </span>
                        ))}
                      <CleanupLine
                        t={t}
                        items={gone.map((r) => ({ key: r.w.path, name: r.w.name, state: r.state, sessionId: open(r.sessions), onOpen: () => open(r.sessions) && p.onOpen(open(r.sessions)!) }))}
                        open={cleanOpen}
                        onToggle={(o) => setOpenWt((s) => (o === s.has(g.project) ? s : toggle(s, g.project)))}
                        onCleanUp={p.onCleanUp ? () => p.onCleanUp!(g.project) : p.wt ? () => p.wt!.setAsk({ kind: 'tidy', project: g.project }) : undefined}
                      />
                      {/* Owner 11-17: with two or more agents at work and no leader, one quiet line says a leader can run them; closed once, it never shows again. */}
                      {!leadOff && g.project !== team.home && !leadOf(team, g.project) && all.filter((s) => s.kind !== 'shell' && !s.machine && agentState(s) === 'running').length >= 2 && (
                        <div className="lead-suggest" data-lead-suggest data-hint-quiet>
                          <span>{t('lead.suggest', { n: all.filter((s) => s.kind !== 'shell' && agentState(s) === 'running').length })}</span>
                          <button className="btn" onClick={() => askLeader(g.project)}>
                            {t('lead.suggestAdd')}
                          </button>
                          <button className="x" aria-label={t('lead.suggestOff')} title={t('lead.suggestOff')} onClick={() => { try { localStorage.setItem(LEAD_OFF, '1'); } catch { /* memory only */ } setLeadOff(true); }}>
                            <Icon name="x" size={12} />
                          </button>
                        </div>
                      )}
                      <SubViews project={g.project} name={g.name} ctx={p.subviews} t={t} />
                      {/* 392: this folder's past Claude and Codex conversations, read-only; this Mac's projects only */}
                      {p.core && !all.some((s) => s.machine) && <PastChats core={p.core} project={g.project} live={live} t={t} />}
                    </>
                  )}
                  {donePop?.project === g.project && p.core && (
                    <DonePopover core={p.core} anchor={donePop.anchor} name={g.name} project={g.project} sessions={today} t={t} onOpen={p.onOpen} onClose={(back) => (setDonePop(null), back && donePop.anchor.focus())} />
                  )}
                </div>
              );
  };

  // V2.5-61 (ticket 194): arrows walk the drawn rows, Left and Right fold, Enter on a project head folds it (other rows'
  // Enter is their own click). Keys from a field, a menu, a popover or a row's own buttons are not rows: they pass.
  const nav = useRef<HTMLElement>(null);
  const roving = useRef<Element | null>(null);
  useEffect(() => void (nav.current && (roving.current = rove(nav.current, roving.current))));
  // Ticket 388: after the folders on the way have opened, the target row is drawn: bring it into view and mark it.
  useEffect(() => {
    const to = target.current;
    if (to && Date.now() - to.at > 2000) return void (target.current = null); // never drawn (the session went): no late jump
    const el = to && nav.current && placeOf(nav.current, to.id);
    if (!to || !el) return;
    target.current = null;
    el.scrollIntoView({ block: 'nearest' });
    if (to.how === 'focus') {
      // Ticket 462: the walk's own quiet mark (tree.css `[data-walk]`), until focus leaves the row.
      el.dataset.walk = '';
      el.addEventListener('blur', () => delete el.dataset.walk, { once: true });
      return el.focus();
    }
    el.dataset.pulse = to.tone;
    window.setTimeout(() => delete el.dataset.pulse, 1000);
  });
  const hidden = useHidden(nav, queue);
  const scrollTo = (id: string) => nav.current && placeOf(nav.current, id)?.scrollIntoView({ block: 'nearest' });
  const navKey = (e: ReactKey<HTMLElement>) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.nativeEvent.isComposing) return;
    const { els, rows } = treeRows(e.currentTarget);
    const at = els.indexOf(e.target as HTMLElement);
    if (at < 0) return;
    const kind = keyKind(e.key);
    if (kind === 'enter') return void (els[at].matches('.row.head > button.n') && (e.preventDefault(), foldOf(els[at])?.toggle()));
    if (kind !== 'move') return;
    e.preventDefault(); // the keys never scroll the tree under the row
    const m = navMove(rows, at, e.key);
    if (m && 'focus' in m) els[m.focus].focus();
    else if (m) foldOf(els[m.toggle])?.toggle();
  };

  const edit = p.projects.edit;
  const toggleFold = (key: string, present: boolean) => (setFolds(present ? tree.folded.filter((k) => k !== key) : [...tree.folded, key]), void edit({ op: 'fold', key, folded: !present }));
  const renderPlaced = (pg: ProjectGroup) => {
    const name = pg.name ?? '';
    const folded = pg.name !== null && groupFolded(tree, pg.name) && auto.group !== pg.name;
    const groups = [...pg.pinned, ...pg.open];
    const inner = folded ? !p.signal && renderFolded(foldedRows(groups), `group:${name}`) : groups.map((g) => renderProject(g));
    if (pg.name === null) return <div key="~ungrouped">{inner}</div>;
    const members = new Set(groups.map((g) => g.project));
    const mine = [...members].map((m) => liveGroup.get(m)).filter((g): g is Group => !!g);
    const liveItems = mine.flatMap((g) => g.items).sort((a, b) => a.observed_at - b.observed_at);
    const frozenItems = held ? [...members].flatMap((m) => held.items.get(m) ?? []).sort((a, b) => a.observed_at - b.observed_at) : null;
    const { fresh } = decisionLines(asks(liveItems), frozenItems && asks(frozenItems));
    // The header's bar and counts follow the live projects while the rows hold still (needs 49).
    const sessions = mine.flatMap((g) => [...g.main, ...g.worktrees.flatMap((w) => w.sessions)]).map(withoutNotes);
    const states = sessions.map(status);
    const waiting = asks(liveItems).length + sessions.filter((s) => s.attention.waiting && !s.pending.length).length;
    const urgency = urgencyOf(waiting ? [...states, 'waiting'] : states);
    const counts = t('tree.countsGroup', { working: sessions.filter((s) => shownStatus(s) === 'working').length, waiting: waiting + states.filter((s) => s === 'limited').length, attention: states.filter((s) => s === 'failed' || s === 'stale').length });
    // FIDELITY BAR (needs 130, mockup ③; open too, needs 196): a group head carries its project rows' strips merged, in the same
    // urgency order and cap as a project's, so the group reads at a glance without opening it.
    // Ticket 388: one bar per session of its projects, no cap (3 or more of a colour are one bar and the number).
    const foldClick = () => (auto.group === name ? setAuto((a) => ({ ...a, group: undefined })) : toggleFold(foldGroup(name), folded));
    const first = groups[0];
    const mainId = first?.main[0]?.id ?? first?.worktrees[0]?.sessions[0]?.id;
    return (
      <div key={`g:${name}`} className="pgrp" data-folded={folded || undefined} data-urgency={urgency} data-group={name} role="group" aria-label={t('tree.projectLabel', { name, urgency })}>
        <div className="row ghead" data-hot={pdrag.drag?.over === name ? '' : undefined} onContextMenu={() => first && p.projects.setMenuProject(first.project)} data-menu={mainId ? 'group' : undefined} data-menu-session={mainId}>
          <button className="chev" aria-expanded={!folded} aria-label={t(folded ? 'tree.expandGroup' : 'tree.collapseGroup', { name })} onClick={foldClick}>
            <Icon name={folded ? 'chevron-right' : 'chevron-down'} size={10} />
          </button>
          <button className="n" onClick={foldClick} title={t('tree.groupTitle', { name, projects: plural(t, 'tree.projects', members.size) })}>
            <b>{name}</b>
          </button>
          <span className="r" role="group" aria-label={counts} title={counts}>
            {!p.signal && (
              <span className="chip" role="status" aria-live="polite" aria-label={folded && fresh > 0 ? plural(t, 'tree.newWaiting', fresh) : undefined}>
                {folded && fresh > 0 ? t('tree.newChipGroup', { n: fresh }) : ''}
              </span>
            )}
          </span>
          {/* Mockup ③ ".d": how many projects the folded group holds, where a project head shows "main". */}
          {folded && <span className="d">{plural(t, 'tree.projects', members.size)}</span>}
          {/* Ticket 1022: a group head sums its projects' finished sessions of today. */}
          {!p.signal && ((n) => n > 0 && <DoneBars n={n} t={t} />)(mine.reduce((n, g) => n + finishedOf(g.main, Date.now()).today.length, 0))}
          <Strip sessions={mine.flatMap((g) => stripSessions(g, facts))} dim={!folded} next={nextUp} onPick={pick(`g:${name}`)} t={t} />
          {pdrag.drag?.over === name && <span className="droplabel" role="status">{t('tree.drag.over', { group: name })}</span>}
        </div>
        {/* needs 130: the folded body contains only the shared waiting-row budget. */}
        <div className="gbody">
          {inner}
        </div>
      </div>
    );
  };

  const homeGroup = (core: CoreClient) => <HomeGroup t={t} core={core} team={team} sessions={p.sessions} current={p.current} onOpen={p.onOpen} />;
  return (
    <aside
      ref={aside}
      className="dock l"
      aria-label={t('tree.root')}
      data-held={held ? 'true' : 'false'}
      data-leaving={leaving ? 'true' : undefined}
      onPointerEnter={() => ((pointer.current = true), hold())}
      onPointerMove={() => ((pointer.current = true), hold())}
      onPointerLeave={(e) => !overlay(e.relatedTarget) && drop.current(false)}
      onPointerCancel={() => drop.current(false)}
      onKeyDown={(e) => ((focus.current = true), hold(), bracket(e))}
      onFocus={() => !moving.current && ((focus.current = true), hold())}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node) && !overlay(e.relatedTarget)) {
          focus.current = false;
          release();
        }
      }}
    >
      <div className="ph">
        <span className="grip" aria-hidden>
          ⋮⋮
        </span>
        <span className="pht">
          <span>{t('tree.projectsTitle')}</span>
        </span>
        <span className="r">
          <button className="btn p addproj" title={t('tree.addProjectHint')} onClick={askAddProject}>
            {t('tree.addProject')}
          </button>
          <button className="xall" data-hint-quiet aria-pressed={expanded} title={t('tree.expandAllHint')} onClick={(e) => expandAll.current(e.altKey)}>
            {t(expanded ? 'tree.restore' : 'tree.expandAll')}
          </button>
        </span>
      </div>
      {pdrag.drag && createPortal(<div className="pdrag glass" aria-hidden style={{ left: pdrag.drag.x + 10, top: pdrag.drag.y + 10 }}>{pdrag.drag.name}</div>, document.body)}
      {toolError && (
        <div className="gname">
          <p className="err" role="alert">
            {toolError}{' '}
            <button className="btn" onClick={() => setToolError('')}>
              {t('tree.dismiss')}
            </button>
          </p>
        </div>
      )}
      {kidNote && (
        <div className="gname">
          <p role="status" data-kid-note="">
            {kidNote}{' '}
            <button className="btn" onClick={() => setKidNote('')}>
              {t('tree.dismiss')}
            </button>
          </p>
        </div>
      )}
      {peek && !peekGone && p.core && (
        <KidPeek
          core={p.core}
          peek={peek}
          kid={peekKid!}
          onClose={() => setPeek(null)}
          onParent={(note) => (setPeek(null), setKidNote(note))}
          t={t}
        />
      )}
      {notice && (
        <div className="gname">
          <div className="err" role="alert">
            {notice.text}{' '}
            <button
              className="btn"
              onClick={(e) => {
                // The button goes away under the focus and sends no blur: blur it, or the sidebar keeps holding the old tree.
                if (notice.retry) e.currentTarget.blur();
                // Retry asks for the tree now: the hold (pointer over the sidebar) must not keep the old one up to the idle bound.
                if (notice.retry) setHeld(null);
                (notice.retry ? p.projects.reload : p.projects.dismiss)();
              }}
            >
              {t(notice.retry ? 'tree.retry' : 'tree.dismiss')}
            </button>
            <ErrorDetails t={t} details={notice.details} />
          </div>
        </div>
      )}
      <nav ref={nav} className="tree" aria-label={t('tree.projectsTitle')} onKeyDown={navKey} onFocus={(e) => e.target.matches(ROW) && (roving.current = rove(e.currentTarget, e.target))}>
        <Gather side="top" at={hidden.top} sessions={liveSessions} onScroll={scrollTo} onPick={pick('top')} t={t} />
        {shown.length === 0 && (
          <p className="empty">
            {t('tree.empty')}{' '}
            <button className="btn" onClick={askAddProject}>
              {t('tree.newSessionAction')}
            </button>
          </p>
        )}
        {team.home && p.core && !shown.some((m) => m.name === 'this Mac') && homeGroup(p.core)}
        {shown.map((m) => (
          <div key={m.name} role="group" aria-label={m.name === 'this Mac' ? t('tree.thisMac') : m.name}>
            <div className="mach">{m.name === 'this Mac' ? t('tree.thisMac') : m.name}</div>
            {m.name === 'this Mac' && team.home && p.core && homeGroup(p.core)}
            {place(m.groups, tree).map(renderPlaced)}
          </div>
        ))}
        <Gather side="bottom" at={hidden.bottom} sessions={liveSessions} onScroll={scrollTo} onPick={pick('bottom')} t={t} />
      </nav>
    </aside>
  );
}

/** The surviving block to focus when the focused answered one goes: next, else previous, else the project head. */
function successorOfFocus(aside: HTMLElement | null) {
  const cur = document.activeElement as HTMLElement | null;
  const grp = cur?.closest<HTMLElement>('.grp');
  const block = cur?.closest<HTMLElement>('.sess');
  if (!aside || !cur || !grp || !block || !aside.contains(cur) || !block.querySelector('.q.answered')) return null;
  const all = [...grp.querySelectorAll<HTMLElement>('.sess')];
  const keep = all.filter((e) => !e.querySelector('.q.answered'));
  const at = all.indexOf(block);
  const next = keep.find((e) => all.indexOf(e) > at) ?? keep.reverse().find((e) => all.indexOf(e) < at);
  return { item: next?.querySelector<HTMLElement>('.q')?.dataset.item, project: grp.dataset.project!, from: cur.closest<HTMLElement>('.row.wt2')?.dataset.menuSession };
}

/** The "a leader can run these" line was closed once (this window's storage): it stays away. */
const LEAD_OFF = 'nunchiro.leadSuggestOff';

export function orderSessions(sessions: Session[], order: string[]) {
  const rank = new Map(order.map((id, i) => [id, i]));
  return [...sessions].sort((a, b) => (rank.get(a.id) ?? 1e9) - (rank.get(b.id) ?? 1e9));
}

function toggle(set: Set<string>, key: string) {
  const next = new Set(set);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}
