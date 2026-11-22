// V2-9a: the window's copy of tree.toml. The core owns the file; every edit is one request whose reply is the whole
// tree, so the tree is not kept in localStorage and a second window sees an edit at its next load. Only the unread flags
// (needs 170 (1)) are: a per-viewer convenience.
import { plainError, rawError } from '../errors';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CoreClient } from '../api';
import { makeT, type Key } from '../i18n';
import { isChild, isViewed, turnEnds } from '../queue/turns';
import { EMPTY_TREE, TREE_SET } from '../tree';
import { agentState, type Session, type TreeEdit, type TreeState } from '../types';

/** V2-14c: how a tree surface gets `t` (made from `settings.language`); a caller that passes none shows English. */
export type T = (key: Key, args?: Record<string, string | number>) => string;
export const enT: T = makeT('en', 'en');
/** This slice's `<base>.one` / `<base>.other` pairs, by base (V2-14h: one dialect across every slice). */
export type Plural = Extract<Key, `${'tree' | 'dialog' | 'import'}.${string}.one`> extends `${infer B}.one` ? B : never;
export const plural = (t: T, base: Plural, n: number) => t(`${base}.${n === 1 ? 'one' : 'other'}`, { n });

/** The small dialogs a group action opens (the palette command picks the project: the active session's). */
export type Ask = { kind: 'create' | 'rename' | 'move' | 'name' | 'remove'; project: string; group?: string };

/** needs 170 (1): this window's unread flags, a per-viewer convenience kept under this key (a JSON array of session ids). */
export const UNREAD_KEY = 'nunchiro.tree.unread.v1';
const UNREAD_CAP = 500;
/** The stored value as ids: strings only, newest `UNREAD_CAP` kept; anything else (a corrupt or foreign value) is empty. */
export function parseUnread(raw: string | null): string[] {
  try {
    const v = JSON.parse(raw ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(-UNREAD_CAP) : [];
  } catch {
    return [];
  }
}

export interface ProjectTree {
  core: CoreClient;
  tree: TreeState;
  /** Projects with an unread session (derived from `unreadSessions`; the status picker reads it). */
  unread: ReadonlySet<string>;
  /** needs 170 (1): sessions whose turn ended, or that exited by themselves, while the user was not looking at them. */
  unreadSessions: ReadonlySet<string>;
  /** Resolves to the core's refusal text, or null when the edit is on disk. */
  edit: (e: TreeEdit) => Promise<string | null>;
  /** A refused edit or a failed load, shown in the sidebar until dismissed, retried or the next edit that goes through. */
  notice: { text: string; retry: boolean; /** Ticket 476: the raw reason, under Details. */ details?: string } | null;
  reload: () => void;
  dismiss: () => void;
  ask: Ask | null;
  setAsk: (a: Ask | null) => void;
  /** The project whose row was right-clicked: the menu's labels follow it until the next click or key. */
  menuProject: string | null;
  setMenuProject: (p: string | null) => void;
  picking: boolean;
  setPicking: (p: boolean) => void;
}

export function useProjectTree(core: CoreClient, connected: boolean, sessions: Session[], current: string | null, t: T = enT): ProjectTree {
  const [tree, setTree] = useState<TreeState>(EMPTY_TREE);
  const [ask, setAsk] = useState<Ask | null>(null);
  const [picking, setPicking] = useState(false);
  const [menuProject, setMenuProject] = useState<string | null>(null);
  useEffect(() => {
    // Capture: a right-click's pointerdown clears the last one before its contextmenu sets the new one. Not a press in the
    // open menu: an item shown for this row only (ticket 990's lead.add) would vanish under the pointer between its
    // pointerdown and its click, and the click would land on the item below. Its commands run on the row's own argument.
    const inMenu = (e: Event) => (e.type === 'keydown' ? !!document.querySelector('.cmenu') : !!(e.target as Element | null)?.closest?.('.cmenu'));
    const clear = (e: Event) => inMenu(e) || setMenuProject(null);
    window.addEventListener('pointerdown', clear, true);
    window.addEventListener('keydown', clear, true);
    return () => (window.removeEventListener('pointerdown', clear, true), window.removeEventListener('keydown', clear, true));
  }, []);
  const tr = useRef(t);
  tr.current = t;
  const [unreadSessions, setUnreadSessions] = useState<ReadonlySet<string>>(() => {
    try {
      return new Set(parseUnread(localStorage.getItem(UNREAD_KEY)));
    } catch {
      return new Set(); // storage blocked: the flags live in memory for this window
    }
  });
  const seen = useRef({ working: new Map<string, boolean>(), state: new Map<string, string>(), before: sessions });
  const cur = useRef(current);
  cur.current = current;

  const [notice, setNotice] = useState<ProjectTree['notice']>(null);
  const reload = useCallback(() => void core.tree().then((t) => (setTree(t), setNotice(null)), () => setNotice({ text: tr.current('tree.loadFailed'), retry: true })), [core]);
  useEffect(() => {
    if (connected) reload();
  }, [reload, connected]);
  // Look 1117 v10 N5: the core files a project as added when its last live session closes (sessions.rs
  // keep_project_head), so the tree is read again when a project has no live session left.
  const live = [...new Set(sessions.filter((s) => s.state !== 'closed').map((s) => s.project))].sort().join('\n');
  const wasLive = useRef(live);
  useEffect(() => {
    const now = new Set(live.split('\n'));
    if (connected && wasLive.current.split('\n').some((p) => p && !now.has(p))) reload();
    wasLive.current = live;
  }, [live, connected, reload]);
  const asking = useRef(ask);
  asking.current = ask;

  // Needs 170 (1): a session whose turn ends, or that exits by itself, while nobody is looking at it (`isViewed`) is unread
  // until it is viewed. A side chat never is. The first snapshot after a (re)connect is a first sight, not a transition
  // (the list in hand before it is the old core's); every snapshot prunes the flags to the ids it lists, except an empty
  // one, which may be the list before any snapshot.
  useEffect(() => {
    const m = seen.current;
    if (!connected) return void ((m.before = sessions), m.working.clear(), m.state.clear());
    if (sessions === m.before) return;
    const ends = turnEnds(m.working, sessions);
    const add = sessions.filter((s) => !isChild(s) && (ends.includes(s.id) || (s.kind !== 'shell' && m.state.get(s.id) === 'running' && agentState(s) === 'exited'))).map((s) => s.id);
    for (const s of sessions) (m.working.set(s.id, s.attention.working), m.state.set(s.id, agentState(s)));
    const listed = new Set(sessions.map((s) => s.id));
    setUnreadSessions((u) => settle(u, add, sessions.length ? listed : null, cur.current));
  }, [sessions, connected]);
  // The seen rule: re-read when the current tab changes and when the window gains or loses focus or visibility.
  const see = useCallback(() => setUnreadSessions((u) => settle(u, [], null, cur.current)), []);
  useEffect(see, [current, see]);
  useEffect(() => {
    window.addEventListener('focus', see);
    window.addEventListener('blur', see);
    document.addEventListener('visibilitychange', see);
    return () => (window.removeEventListener('focus', see), window.removeEventListener('blur', see), document.removeEventListener('visibilitychange', see));
  }, [see]);
  useEffect(() => {
    try {
      localStorage.setItem(UNREAD_KEY, JSON.stringify([...unreadSessions]));
    } catch {
      // Storage blocked: unread for this window only.
    }
  }, [unreadSessions]);
  const projectsOf = useRef<ReadonlySet<string>>(new Set());
  const unread = useMemo(() => {
    const next = new Set(sessions.filter((s) => unreadSessions.has(s.id)).map((s) => s.project));
    const same = next.size === projectsOf.current.size && [...next].every((p) => projectsOf.current.has(p));
    return same ? projectsOf.current : (projectsOf.current = next);
  }, [sessions, unreadSessions]);

  const edit = useCallback(
    (e: TreeEdit) =>
      core.treeEdit(e).then(
        (t) => (setTree(t), setNotice(null), null),
        (err: Error) => {
          // The name dialog shows its own refusal; either way the window goes back to what the core holds.
          const own = asking.current?.kind === 'create' || asking.current?.kind === 'rename' || asking.current?.kind === 'name' || asking.current?.kind === 'remove';
          void core.tree().then(setTree, () => {}).finally(() => setNotice(own ? null : { text: plainError(tr.current, err), retry: false, details: rawError(err) }));
          return rawError(err); // the dialog turns it into plain words, the raw text under Details (476, 534)
        },
      ),
    [core],
  );
  useEffect(() => {
    const set = (e: Event) => setTree((e as CustomEvent<TreeState>).detail);
    window.addEventListener(TREE_SET, set);
    return () => window.removeEventListener(TREE_SET, set);
  }, []);
  const dismiss = useCallback(() => setNotice(null), []);
  return { core, tree, unread, unreadSessions, edit, notice, reload, dismiss, ask, setAsk, menuProject, setMenuProject, picking, setPicking };
}

/** Adds `add`, keeps only `listed` ids (null: keep all), and drops every session the user is looking at; same set back when nothing changed. */
function settle(u: ReadonlySet<string>, add: string[], listed: ReadonlySet<string> | null, current: string | null): ReadonlySet<string> {
  const next = [...new Set([...u, ...add])].filter((id) => (!listed || listed.has(id)) && !isViewed(id, current)).slice(-UNREAD_CAP);
  return next.length === u.size && next.every((id) => u.has(id)) ? u : new Set(next);
}

/** V2.5-30: `parent` is the session that started this one (core `Session.parent`); absent when the owner started it. */
export type Linked = Session & { parent?: string };

/**
 * V2.5-30 (needs 145): child sessions by parent id, to any depth. A link counts only when its parent is listed and not
 * closed, and the chain above it never comes back to it: a closed coordinator's workers stay at top level, a cycle is
 * cut whole. Closed sessions (kept in the list for undo) nest nowhere.
 */
export function sessionKids(all: readonly Linked[]): Map<string, Linked[]> {
  const sessions = all.filter((s) => s.state !== 'closed');
  const listed = new Set(sessions.map((s) => s.id));
  const parentOf = new Map(sessions.flatMap((s) => (s.parent ? [[s.id, s.parent] as const] : [])));
  const out = new Map<string, Linked[]>();
  for (const s of sessions) {
    const p = parentOf.get(s.id);
    if (!p || !listed.has(p)) continue;
    // ponytail: a walk up per session, O(n * depth); fine for a window's session list.
    const seen = new Set([s.id]);
    let up: string | undefined = p;
    while (up !== undefined && !seen.has(up)) (seen.add(up), (up = parentOf.get(up)));
    if (up === s.id) continue;
    out.set(p, [...(out.get(p) ?? []), s]);
  }
  return out;
}
