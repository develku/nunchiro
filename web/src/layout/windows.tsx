// Window views of the widget registry (v1b-28): what each kind renders inside its zone. Kept apart from
// registry.tsx because these import the widget components (and their CSS), which the pure layout specs cannot load.
// A kind missing here is a type error, so a new widget is its registry entry plus one line here.
import type { ReactNode } from 'react';
import type { Boot, CoreClient } from '../api';
import type { T } from '../i18n'; // V2-14h
import { Artifacts } from '../artifacts-widget/Artifacts'; // v1b-13
import { Preview } from '../artifacts/Preview'; // v1b-06
import { Board } from '../board/Board'; // v1b-16
import { DiffDock } from '../diff/Diff'; // v1b-11
import { sessionName } from '../Sidebar';
import type { Decision, Session } from '../types';
import { UserWidget } from '../widgets/UserWidget'; // v1b-19
import { RoomPane } from '../room/RoomPane'; // ticket 990
import { ContextWidget } from './ContextWidget'; // ticket 1048
import type { RoomWorktrees } from '../room/RoomView';
import { isUserKind, kindOf, pinOf, type Item, type Kind } from './model';

/** What the window already has, handed to every widget view. App-built views come as functions. */
export interface WindowCtx {
  boot: Boot;
  core: CoreClient;
  sessions: Session[];
  current: Session | null;
  /** The session a pin names, if it is open. */
  pinned: (pin: string) => Session | null;
  open: (id: string) => void;
  diff: { path?: string; files?: string[]; n: number };
  /** The session the Files tree shows (focused, else the last one). */
  filesSession: Session | null;
  tree: () => ReactNode;
  strip: (first: boolean) => ReactNode;
  terminal: (pin?: string) => ReactNode;
  composer: (first: boolean, pin?: string) => ReactNode;
  /** The Files tree: of the focused session, or of the session given (a project's sub-view; null shows nothing). */
  files: (s?: Session | null) => ReactNode;
  search: (s: Session | null) => ReactNode;
  decisions: () => ReactNode; // V2-8e
  /** V2-14h: the window's catalogue lookup, handed to every widget that takes one. */
  t: T;
  /** Ticket 374: puts text in the focused session's composer as a quote (never sends); absent while it is disabled. */
  quote?: (text: string) => void;
  /** Ticket 1038: where My browser's notes go, the session in front, else the window's last focused running agent session
   *  (it is opened, then the notes are quoted into its composer, never sent); null with none. */
  notes?: { name: string; insert: (text: string) => void } | null;
  /** Ticket 990: the managed worktrees and their facts (the room's colour bars, the leader's band and hand-over). */
  /** Ticket 990 (owner 11-17): the owner decisions (a lead's merge card puts its task under "needs you") and how to show one in Decisions. */
  owner: Decision[];
  /** Ticket 1073: this Mac's projects in the tree (none with a machine's session), whose on-disk conversations History lists. */
  projects?: string[];
  decide: (id: string) => void;
  wt?: RoomWorktrees & { team: (path: string, lead: string) => Promise<unknown>; open: (path: string) => Promise<Session | null>; refresh: () => void; settled: ReadonlySet<string> };
}
/** One placement: its pin, whether it is the first of its kind, and the session it follows (pinned or focused). */
interface At {
  pin?: string;
  first: boolean;
  session: Session | null;
  /** V2.5-38: the zone the widget sits in (a layout zone id, or a bar side); the board keeps its saved view there. */
  zone?: string;
  /** Ticket 1084: what removes the host of this widget (zone tab, split, sidebar); the Preview draws its close button from it. */
  close?: () => void;
}

const WINDOWS: Record<Kind, (c: WindowCtx, at: At) => ReactNode> = {
  tree: (c) => c.tree(),
  waiting: (c, at) => c.strip(at.first),
  terminal: (c, at) => c.terminal(at.pin),
  composer: (c, at) => c.composer(at.first, at.pin),
  // v1b-11: a placed Diff follows the focused session, or its pinned one.
  diff: (c, { session: s }) => <DiffDock core={c.core} session={s?.id ?? null} label={s ? sessionName(s) : ''} owner={s} focus={c.diff} t={c.t} machine={s?.machine} browser={c.boot.browser} quote={s && s.id === c.current?.id ? c.quote : undefined} />, // ticket 373: owner
  files: (c) => c.files(), // v1b-09
  preview: (_, at) => <Preview session={at.session?.id ?? null} label={at.session ? sessionName(at.session) : ''} onClose={at.close} />, // v1b-06; V2-10c: label; 1084: onClose
  search: (c, at) => c.search(at.pin ? at.session : c.filesSession), // v1b-10
  // v1b-13: follows the focused session, or its pinned one
  artifacts: (c, { session: s }) => <Artifacts boot={c.boot} core={c.core} session={s?.id ?? null} label={s ? sessionName(s) : ''} t={c.t} />,
  decisions: (c) => c.decisions(), // V2-8e
  board: (c, at) => <Board core={c.core} sessions={c.sessions} onOpen={c.open} t={c.t} zone={at.zone} />, // v1b-16; V2-14h; V2.5-38: zone
  room: (c, at) => <RoomPane core={c.core} t={c.t} session={at.session} sessions={c.sessions} open={c.open} wt={c.wt} />, // ticket 990
  context: (c, at) => <ContextWidget core={c.core} session={at.session} t={c.t} />, // ticket 1048
};

export function renderWidget(item: Item, first: boolean, c: WindowCtx, zone?: string, close?: () => void): ReactNode {
  const pin = pinOf(item);
  const kind = kindOf(item);
  // N28 (look 1117 v3): a file tab is no session; Diff keeps the session the file belongs to.
  const at = { pin, first, session: pin ? c.pinned(pin) : (c.current ?? (kind === 'diff' ? c.filesSession : null)), zone, close };
  // v1b-19: user widgets (`widget:<name>`) follow the pinned or focused session like the terminal.
  if (isUserKind(kind)) return <UserWidget core={c.core} name={kind.slice('widget:'.length)} session={at.session} />;
  return Object.hasOwn(WINDOWS, kind) ? WINDOWS[kind](c, at) : null;
}

/** D5b lane B (B04): a widget nested under `project`, scoped to it. Files and Search start at the project's main folder,
 *  Board shows its cards. Diff, Preview and Artifacts are not project-scoped: they follow the
 *  focused session as in a sidebar. */
export function renderScoped(kind: string, project: string, c: WindowCtx): ReactNode {
  const mine = c.sessions.filter((s) => s.project === project);
  const root = mine.find((s) => s.cwd === project) ?? mine[0] ?? null;
  if (kind === 'files') return c.files(root);
  if (kind === 'search') return c.search(root);
  return renderWidget(kind, true, { ...c, sessions: mine, core: kind === 'board' ? onlyProject(c.core, project) : c.core });
}
/** The board is one list for every project and the Board widget has no project prop, so its snapshots are cut here. */
function onlyProject(core: CoreClient, project: string): CoreClient {
  const scoped = Object.create(core) as CoreClient;
  scoped.request = async (r) => {
    const reply = (await core.request(r)) as { board?: { cards: { project: string | null }[] } };
    return reply?.board ? { ...reply, board: { ...reply.board, cards: reply.board.cards.filter((x) => x.project === project) } } : reply;
  };
  return scoped;
}
