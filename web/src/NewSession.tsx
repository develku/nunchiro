// V1A-59: start and stop sessions from the window. v25-new-tab (ticket 290, needs 209): "New session" is a popover under the
// tab strip's "+" (Orca's tab "+" menu, lifted in structure: a combobox search over a listbox, the input keeps focus and the
// arrows move `aria-activedescendant`), not a dialog. The folder is the current project; a project name typed in the search
// switches it; the first message is typed in the composer once the session is open. Stop goes through `close`, and a running
// agent asks once first.
import { PLAIN } from './plainText';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKey, type ReactNode, useLayoutEffect } from 'react';
import { accountName, CoreRefusal, type Account, type AcpRow, type CoreClient } from './api';
import { basename, isAccountTab, TREE_SET } from './tree';
import { chordOf, label, merge, type Bindings } from './keys';
import { pickFolder } from './pickFolder';
import { FILE_ACCESS, FolderAccess } from './PermissionNeeded';
import { makeT, type Lang, type T } from './i18n';
import { ErrorDetails, errorNote, heldNote, isLowMemory, notePlain, plainError, startOp, type Note, rawError } from './errors';
import { agentName } from './chat/conversation';
import { sessionName } from './Sidebar';
import type { WithLog } from './picker/Picker';
import type { AgentKind, Session } from './types';
import { setPendingStart, startText, takePendingStart } from './board/startFromCard';
import { setDraft } from './composer-drafts';
import { listDir } from './files/api';
import { openFileAt } from './files/open';
import { openBrowserTab } from './pane/browser/view/centreTab'; // ticket 997 L1
import { YOU_SPACE } from './pane/browser/view/spaces';
import { openAgents } from './settings/agents/open';
import { Icon } from './icons/Icon';
import { askFresh, askLeader } from './lead/LeaderDialog';
import { leadOf, useTeam } from './lead/lead';
import { AgentLogo } from './tree/AgentLogo';
import { Icon as WidgetIcon } from './layout/icons';
import { queueBrowserGo } from './tree/browserGo';
import { useClosed } from './chrome/closedTabs';
import { currentFeature, useFeatureSetting } from './settings/useFeatureSetting';
import { DEFAULT_AGENT } from './settings/onboarding/state';
import { AGENTS_OFF, agentOff, isOff, leadAgent, MODELS_OFF, newDefaults } from './settings/agents/newDefaults';
import { efforts } from './picker/catalog';
import './tree/newtab.css';
import './search/search.css'; // Q7 point 1: the place choice is the Search scope toggle (.sscopes)

/** Any widget asks the window for these (AGENTS and the tree are rendered outside App's props). */
export const NEW_EVENT = 'nunchiro:session.new';
export const STOP_EVENT = 'nunchiro:session.stop';
export const ADD_EVENT = 'nunchiro:project.add'; // the Add project chooser: ProjectDialogs is always mounted, the Sidebar can be hidden
/** Ticket 472: `agent` is the row to put first (onboarding's signed-in or found agent), so Enter starts it; without it
 *  the list keeps its own order (the default agent, else the one used last). */
/** Ticket 980: `machine` is an SSH alias; the session then starts on that machine and `project` is a folder there. */
/** Ticket 991 (A8): `go` starts `agent` as soon as the folder is known, through the popover's own start (its errors show there). */
/** Look 1117 v7 (S2-2): `worktree` is an existing worktree of `project` (a worktree row's "Create a new session…"): the
 *  popover opens with it chosen and the session starts in its folder. */
export const askNew = (project?: string, agent?: AgentKind, machine?: string, go?: boolean, worktree?: { path: string; name: string }) => window.dispatchEvent(new CustomEvent(NEW_EVENT, { detail: { project, agent, machine, go, worktree } }));
export const askAddProject = () => window.dispatchEvent(new Event(ADD_EVENT));
export const askStop = (id: string) => window.dispatchEvent(new CustomEvent(STOP_EVENT, { detail: { id } }));

/** Projects in session order, newest use first, each once. An account's Login or Logout tab sits in the account's config
 * folder (`<data>/accounts/<agent>/<id>`): that folder is no project (Settings > Accounts owns it, as the tree does). */
export const knownProjects = (ordered: Session[]) => [...new Set([...ordered].reverse().filter((s) => !isAccountTab(s)).map((s) => s.project))];

/** Model and effort as V1A-10's `startLike`: what Settings > Agents set for this project (ticket 223), else the current
 * session's when it is this agent, else those of the newest session of this agent in the folder, else the agent's own. */
export function likeNew(current: Session | null, ordered: Session[], kind: AgentKind, project: string) {
  const s = (current?.kind === kind ? current : [...ordered].reverse().find((x) => x.kind === kind && x.project === project)) as WithLog | undefined;
  const set = newDefaults(kind, project);
  // Ticket 357: a model turned off is not inherited from an earlier session; a stored default keeps working until changed.
  const off = isOff(currentFeature(MODELS_OFF), kind, s?.model);
  const model = set.model ?? (off ? null : (s?.model ?? null));
  const effort = set.effort ?? (set.model || off ? null : (s?.effort ?? null));
  // An inherited effort may not exist on a model from the settings.
  return { model, effort: efforts(kind, model).some((e) => e.value === effort) ? effort : null, ...(set.args ? { args: set.args } : {}) };
}

/** Ticket 322: the account the owner picked for new sessions of this agent (ticket 358: signed out, it falls back to the CLI's
 * own login; an unknown state keeps it); else V2-2b: the account last used in this project by this agent, while it is still
 * listed; else "Your own" (null). */
export function lastAccount(ordered: Session[], kind: AgentKind, project: string, accounts: Account[]) {
  const picked = accounts.find((a) => a.agent === kind && a.session_default);
  if (picked) return picked.default || picked.signed_in === 'no' ? null : picked.label;
  const last = [...ordered].reverse().find((s) => s.kind === kind && s.project === project)?.account;
  return accounts.some((a) => !a.default && a.agent === kind && a.label === last) ? (last ?? null) : null;
}

/** The keys' own start (New terminal, Claude, Codex): a session of this kind in the current session's project, with that
 * project's last account and the current model and effort, as the popover's rows start it. Returns the session or throws. */
/** Ticket 610: with no session tab open (the Room tab), `project` is the selected project's and the session starts there. */
/** `wait`: a start held for low memory waits and starts by itself (the status bar lists it); nothing is returned then. */
export async function quickStart(core: CoreClient, ordered: Session[], current: Session | null, kind: 'shell' | 'claude' | 'codex', project = current?.project, anyway = false, wait = false) {
  if (agentOff(kind) || !project) return; // ticket 358: its key does nothing and says nothing
  const agent = kind !== 'shell';
  const accounts = agent ? await core.accounts().then((r) => r.accounts, () => [] as Account[]) : [];
  const account = agent ? lastAccount(ordered, kind, project, accounts) : null;
  const like = agent ? likeNew(current, ordered, kind, project) : { model: null, effort: null };
  const reply = (await core.request(startOp({ op: 'start', session: { kind, project, ...like, resume: null, ...(account ? { account } : {}) } }, anyway, wait))) as { session?: Session };
  return reply.session;
}

/** quickStart from the tree's +, the keys and the palette: the started session opens; a refusal is the status bar's note.
 *  A start held for low memory waits and starts by itself (the status bar's waiting item); a core that refuses it instead
 *  (another version) gets the note with Start anyway, which runs the same start past it. */
export function quickStartNoted(core: CoreClient, ordered: Session[], current: Session | null, kind: 'shell' | 'claude' | 'codex', project: string | undefined, opened: (s: Session) => void, setNote: (n: Note) => void, t: T, anyway = false) {
  void quickStart(core, ordered, current, kind, project, anyway, !anyway).then(
    (s) => s && opened(s),
    (e) => setNote(heldNote(t, e, agentName(kind), () => quickStartNoted(core, ordered, current, kind, project, opened, setNote, t, true)) ?? errorNote(t('err.note.notStarted', { error: notePlain(t, e) }), e)),
  );
}

/** The catalogue for <html lang>, which App sets from the language setting; redone when it changes. */
function useHtmlLangT(): T {
  const [lang, setLang] = useState(() => document.documentElement.lang);
  useEffect(() => {
    const ob = new MutationObserver(() => setLang(document.documentElement.lang));
    ob.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
    return () => ob.disconnect();
  }, []);
  return useMemo(() => makeT((lang || 'en') as Lang, navigator.language), [lang]);
}

/** A host that looks like a web address and not a file name (`notes.md` is a file). ponytail: a short extension list, not a TLD table. */
const FILE_EXT = /\.(md|txt|json|toml|ya?ml|lock|rs|py|sh|css|html?|[jt]sx?|mjs|cjs|log|png|jpe?g|svg|pdf)$/i;
export const looksLikeUrl = (q: string) => /^https?:\/\/\S+$/i.test(q) || /^localhost(:\d+)?(\/\S*)?$/i.test(q) || (/^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?(\/\S*)?$/i.test(q) && !FILE_EXT.test(q.split('/')[0]));
const urlOf = (q: string) => (/^https?:\/\//i.test(q) ? q : `http://${q}`);

type Entry = {
  id: string;
  name: string;
  detail?: string;
  /** The detail is a sentence, not a path: it wraps instead of being cut (look 1117 v5 es, the Leader row). */
  wrap?: boolean;
  tag?: string;
  icon: ReactNode;
  /** The keymap command this row stands for; its first binding is drawn and pressing any binding closes the popover. */
  keyId?: string;
  /** A key that is no command (Enter on the row that takes it). */
  kbd?: string;
  disabled?: string;
  title?: string;
  menu?: { surface: string; session?: string; arg?: string };
  run: () => void | Promise<void>;
};

const MAX_EACH = 6;
const FOLDER_ROW = 'choose-folder';
const WIDTH = 360; // the popover's width (newtab.css)

/** Where it hangs: under the tab strip's "+" (found in the page, as the opener is outside this file's props); with no "+" on
 * screen (a window with no tab strip) it sits where the old sheet did, high and centred. */
function where(a: HTMLElement | null) {
  if (!a || !a.getClientRects().length) return { top: 72, left: Math.max(8, (window.innerWidth - WIDTH) / 2) };
  const r = a.getBoundingClientRect();
  return { top: r.bottom + 4, left: Math.max(8, Math.min(r.left, window.innerWidth - WIDTH - 8)) };
}

export function NewSession({ core, ordered, current, project, machine, prefer, go, worktree, soleProject, home, bindings, onStarted, onNote, onClose, onReopen, onWorktree }: { worktree?: { path: string; name: string }; home?: string; onWorktree?: (path: string) => void; core: CoreClient; ordered: Session[]; current: Session | null; project?: string; machine?: string; prefer?: AgentKind; go?: boolean; soleProject?: string; bindings?: Bindings; onStarted: (s: Session, background?: boolean) => void; onNote?: (note: Note) => void; onClose: () => void; onReopen?: () => void }) {
  const t = useHtmlLangT();
  const keymap = useMemo(() => merge(bindings ?? {}), [bindings]);
  const closed = useClosed();
  const [defaultAgent] = useFeatureSetting(DEFAULT_AGENT);
  const [agentsOff] = useFeatureSetting(AGENTS_OFF);
  const projects = knownProjects(ordered);
  // Ticket 225: a card's "Start session…" left its title, note and project here; taken once, so a later open is plain.
  const [card] = useState(takePendingStart);
  // Ticket 469: `projects` comes from sessions only; with none, the tree's one project (added, no session yet) is the folder.
  const [folder, setFolder] = useState(project ?? card?.project ?? current?.project ?? projects[0] ?? soleProject ?? '');
  const [query, setQuery] = useState('');
  const [at, setAt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [details, setDetails] = useState(''); // ticket 476: the raw reason, under Details
  const [held, setHeld] = useState<{ line: string; run: () => void } | null>(null); // a low-memory hold's line and its Start anyway
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [listed, setListed] = useState(false); // the account list came back (or failed): a `go` start picks its account then
  const [acp, setAcp] = useState<AcpRow[]>([]);
  const [files, setFiles] = useState<string[]>([]);
  // Q7 point 1: start in the project's checkout, or in a new worktree of it (the core's worktree create, as the tree's card).
  // Look 1117 v7 (S2-2): or in the worktree the popover was asked for (`given`), while the folder is still its project.
  const [picked, setPlace] = useState<'given' | 'here' | 'worktree'>(worktree ? 'given' : 'here');
  const made = useRef<{ project: string; path: string } | null>(null); // a worktree made for a start that then failed: a retry reuses it
  const path = folder.trim();
  const given = worktree && path === project ? worktree : undefined;
  const place = picked === 'given' && !given ? 'here' : picked;
  const places = [...(given ? (['given'] as const) : []), 'here', 'worktree'] as const;
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const back = useRef<Element | null>(document.activeElement);
  const anchor = useRef<HTMLElement | null>(document.querySelector<HTMLElement>('.tadd'));
  const [pos, setPos] = useState(() => where(anchor.current));
  // V2-2b / V2-4b: listed once per opening (each added account's sign-in is probed; ACP rows come from agents.toml).
  useEffect(() => {
    core.accounts().then(
      (r) => (setAccounts(r.accounts), setListed(true)),
      () => (setAccounts([]), setListed(true)),
    );
    core.acpAgents().then(
      (r) => setAcp(r.acp.filter((x) => x.acp && x.state === 'approved')),
      () => setAcp([]),
    );
  }, [core]);
  // Files of the folder: its top level, read through a session that runs there. ponytail: one level, no walk; deeper
  // files are the Search panel's (files_search). A folder with no session has no root to read through: no file rows.
  const rootSession = ordered.find((s) => s.project === path && s.state === 'running' && !isAccountTab(s))?.id ?? ordered.find((s) => s.project === path && !isAccountTab(s))?.id;
  useEffect(() => {
    setFiles([]);
    if (!rootSession) return;
    let live = true;
    listDir(core, rootSession, '').then(
      (list) => live && setFiles(list.filter((e) => e.kind === 'file').map((e) => e.name)),
      () => {},
    );
    return () => void (live = false);
  }, [core, rootSession]);

  useEffect(() => {
    const place = () => setPos(where(anchor.current));
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, []);
  useEffect(() => {
    input.current?.focus();
    if (project === '') void chooseFolder(); // UXFIX (a): "+ Project" starts at the folder picker
    // Focus goes back where it was. Opened with the pointer on the "+", that is the "+" itself: WebKit does not focus a button
    // on a click, so `back` would be the zone around it.
    const prev = anchor.current?.matches(':hover') ? anchor.current : back.current;
    return () => {
      setPendingStart(null); // a card start set while open is not kept
      const to = prev && prev !== document.body && document.contains(prev) ? prev : anchor.current;
      // Later than the click that closed it: the browser moves focus to the pressed spot after the press is dispatched. Only
      // from nowhere: focus the user or the new session already took stays.
      window.setTimeout(() => {
        const f = document.activeElement;
        if (!f || f === document.body || f.matches('.lz')) (to as HTMLElement | null)?.focus?.();
      }, 0);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const say = (key: Parameters<T>[0], args?: Record<string, string | number>) => (setDetails(''), setError(t(key, args)));
  // F15: a picked or typed folder is a project in the tree now, whether or not an agent starts in it (walk 8: a typed
  // one was not, so Add project > Browse folder > a typed path added nothing once the popover closed).
  // A typed path that is not a folder: the core refuses the add (ticket 702) and the popover says why.
  // Walk 11: a refused folder goes back to the one before it, so the list never reads "in <missing folder>" and every
  // start there fails again.
  const takeFolder = (dir: string) => {
    const before = folder;
    setFolder(dir);
    setQuery('');
    setError('');
    if (machine) return; // a folder on the machine: this Mac's tree has nothing to add
    core.treeEdit({ op: 'add', project: dir, added: true }).then(
      (tree) => window.dispatchEvent(new CustomEvent(TREE_SET, { detail: tree })),
      (e) => (setFolder((now) => (now === dir ? before : now)), setError(t('err.note.notAdded', { error: plainError(t, e) })), setDetails(rawError(e))),
    );
  };
  const chooseFolder = async () => {
    try {
      const picked = await pickFolder();
      if (picked) takeFolder(picked);
    } catch {
      say('newtab.pickerFailed');
    }
    input.current?.focus();
  };
  const finish = (s: Session | undefined) => {
    onClose();
    if (!s) return;
    onStarted(s);
    // Ticket 225: started from a card: the card's words wait in the new session's composer (typed there, not sent) and it
    // becomes the card's worker, once; a refusal is said, never retried.
    if (card) {
      setDraft(s.id, startText(card));
      void core
        .request({ op: 'board_task_put', id: card.cardId, attachments: [...card.attachments, { session_id: s.id, role: 'worker' }] })
        .catch((e) => onNote?.(errorNote(t('err.note.cardAttach', { error: notePlain(t, e) }), e)));
    }
  };
  const start = async (kind: AgentKind, opts: { acp?: string; account?: string | null; anyway?: boolean } = {}) => {
    if (!path && kind !== 'shell') return say('newtab.pickFolder'); // v25f F10: a shell needs no folder (the core starts it in $HOME)
    if (busy) return;
    setBusy(true);
    setError('');
    setDetails('');
    setHeld(null);
    try {
      // Ticket 980: on a machine the remote core starts it with its own accounts, model and effort (this Mac's do not apply there).
      const like = !machine && (kind === 'claude' || kind === 'codex') ? likeNew(current, ordered, kind, path) : { model: null, effort: null };
      const account = machine ? null : opts.account !== undefined ? opts.account : kind === 'claude' || kind === 'codex' ? lastAccount(ordered, kind, path, accounts) : null;
      const session = { kind, project: path, ...like, resume: null, ...(account ? { account } : {}), ...(opts.acp ? { args: [opts.acp] } : {}) };
      const wt = place === 'worktree' && canWorktree ? await newWorktree(path) : place === 'given' && given && !machine ? given.path : null;
      if (place === 'worktree' && canWorktree && !wt) return setBusy(false);
      // A start held for low memory waits and starts by itself (this Mac's hold), unless the card's words wait for it here.
      const request = startOp({ op: 'start', session, ...(wt ? { folder: wt } : {}) }, opts.anyway, !card && !machine);
      const reply = (await core.request(machine ? { op: 'remote', machine, request } : request)) as { session?: Session };
      // The remote core's row does not name its machine; the tab and the tree know it by this.
      finish(reply.session && machine ? { ...reply.session, machine } : reply.session);
    } catch (e) {
      const m = rawError(e);
      if (m.startsWith(FILE_ACCESS)) setError(m); // F15: said with the permission steps below
      // Held for low memory: the plain line and Start anyway (this Mac's hold only; another machine's core says its own).
      else if (isLowMemory(m) && !machine) {
        const line = plainError(t, m);
        setError(line);
        setDetails(m);
        setHeld({ line, run: () => void start(kind, { ...opts, anyway: true }) });
      }
      else (say('newtab.error', { error: plainError(t, m) }), setDetails(m));
      setBusy(false);
    }
  };

  /** Q7 point 1: a new worktree of `project` (the core's auto name, Settings > Git prefix included), once its setup scripts
   *  let an agent start (the tree's create card waits the same way). Its path, or null after saying why. The core names
   *  the branch after the session's first prompt, only while it was never pushed (docs/areas/tree.md). */
  const newWorktree = async (project: string): Promise<string | null> => {
    if (made.current?.project !== project) {
      const r = await core.worktree({ operation: 'create', project, from: '', branch: null, base: '' });
      const at = r.worktrees?.at(-1)?.path;
      if (!at) throw new CoreRefusal('worktree create returned no worktree');
      made.current = { project, path: at };
      onWorktree?.(at);
    }
    const at = made.current.path;
    for (const until = Date.now() + 30 * 60_000; ; ) {
      const agent = await core.request({ op: 'setup_status', path: at }).then((r) => (r as { status: { agent: string } }).status.agent, () => 'start');
      if (agent === 'start') return at;
      if (agent === 'user' || Date.now() > until) return (say('setupScripts.agentLeft'), null);
      await new Promise((r) => window.setTimeout(r, 1000));
    }
  };

  // Ticket 991 (A8): asked with `go`, the asked-for agent starts once the folder is known (a Browse folder pick sets it later).
  const went = useRef(false);
  useEffect(() => {
    if (!go || !prefer || agentOff(prefer) || !path || !listed || went.current) return;
    went.current = true;
    void start(prefer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [go, prefer, path, listed]);

  // Ticket 997 L1 (A6): the browser rows open the owner's own browser as a centre tab, as `tab.new.browser`; an agent's page stays in its side pane.
  const q = query.trim().toLowerCase();
  const has = (...x: (string | undefined)[]) => !q || x.some((v) => v?.toLowerCase().includes(q));
  const team = useTeam(core, true);
  // Home is no git folder: it has no worktree to start in (look 1117 v3).
  const canWorktree = !!path && !machine && path !== (home || team.home);
  const entries = useMemo(() => {
    const out: Entry[] = [];
    const name = sessionName;
    const agentIcon = (s: Session) => (s.kind === 'shell' ? <Icon name="terminal" size={14} /> : <AgentLogo kind={s.kind} name={s.acp_agent ?? undefined} />);
    if (q) {
      const sessions = [...ordered].reverse().filter((s) => !isAccountTab(s) && has(name(s), basename(s.project)));
      for (const s of sessions.filter((x) => x.state === 'running').slice(0, MAX_EACH))
        out.push({ id: `tab:${s.id}`, name: name(s), detail: basename(s.project), tag: t('newtab.tab'), icon: agentIcon(s), menu: { surface: 'tree', session: s.id }, run: () => (onClose(), onStarted(s)) });
      for (const s of sessions.filter((x) => x.state !== 'running').slice(0, MAX_EACH))
        out.push({ id: `old:${s.id}`, name: name(s), detail: basename(s.project), tag: t('newtab.history'), icon: agentIcon(s), menu: { surface: 'tree', session: s.id }, run: () => (onClose(), onStarted(s)) });
    }
    const act = (e: Entry) => has(e.name) && out.push(e);
    if (!path) act({ id: FOLDER_ROW, name: t('newtab.chooseFolder'), icon: <Icon name="file-directory" size={14} />, kbd: 'Enter', run: chooseFolder });
    act({ id: 'terminal', name: t('newtab.terminal'), icon: <Icon name="terminal" size={14} />, keyId: 'session.new.terminal', run: () => start('shell') });
    act({
      id: 'browser',
      name: t('newtab.browser'),
      icon: <WidgetIcon kind="browser" size={14} /> /* q67 look Q6-2: the globe of the right bar's Browser */,
      keyId: 'tab.new.browser',
      run: () => (openBrowserTab(), onClose()), // ticket 997 L1 (A6): a full centre tab of the owner's own space
    });
    for (const [kind, agent] of [['claude', 'Claude'], ['codex', 'Codex']] as const) {
      if (agentsOff.includes(kind)) continue;
      const choices = accounts.filter((a) => a.agent === kind);
      const last = lastAccount(ordered, kind, path, accounts);
      if (choices.length < 2) act({ id: kind, name: agent, icon: <AgentLogo kind={kind} />, keyId: `session.new.${kind}`, run: () => start(kind) });
      // Two or more accounts for this agent ("Your own" counts): one row each, the one last used in this folder first.
      else
        [...choices]
          .sort((x, y) => Number((y.default ? null : y.label) === last) - Number((x.default ? null : x.label) === last))
          .forEach((a, i) => {
            const l = a.default ? null : a.label;
            const text = t('newtab.agentAs', { agent, account: accountName(t, a) });
            if (has(text, agent)) out.push({ id: `${kind}:${a.id}`, name: text, detail: a.signed_in === 'no' ? t('newtab.signedOut') : undefined, icon: <AgentLogo kind={kind} />, keyId: i === 0 ? `session.new.${kind}` : undefined, run: () => start(kind, { account: l }) });
          });
    }
    // Owner 11-17: the leader is offered where agents are started, while this place has none (the palette and the project menu
    // were the only ways in). It opens the same Add a leader dialog.
    if (path && !machine && path !== team.home && !leadOf(team, path)) act({ id: 'lead', name: t('lead.newtab'), detail: t('lead.newtabHint'), wrap: true, icon: <Icon name="people" size={14} />, run: () => (onClose(), askLeader(path)) });
    // Ticket 1096: with a lead, a fresh conversation for it (the palette's and the project menu's lead.fresh).
    if (path && !machine && leadOf(team, path === team.home ? '' : path)) act({ id: 'lead-fresh', name: t('lead.fresh'), detail: t('lead.freshHint'), wrap: true, icon: <Icon name="people" size={14} />, run: () => (onClose(), askFresh(team, path)) });
    for (const r of acp) act({ id: `acp:${r.name}`, name: r.label, tag: t('newtab.acp'), icon: <AgentLogo kind="acp" name={r.label} />, run: () => start('acp', { acp: r.name }) });
    // ticket 299: the closed tabs of this window; with none, the row says so and does nothing (look 1117 v12 C-V13: on the row, not only in a tooltip).
    act({ id: 'reopen', name: t('reopen.cmd'), icon: <Icon name="clock" size={14} />, keyId: 'tab.reopen', disabled: closed.length ? undefined : t('reopen.none'), detail: closed.length ? undefined : t('reopen.none'), wrap: true, run: () => (onClose(), onReopen?.()) });
    // Ticket 1099: no ⌘, chip, which opens Settings on its last page; the row says where it goes instead (Providers).
    act({ id: 'settings', name: t('newtab.settings'), detail: t('coh.newtab.settingsWhere'), icon: <Icon name="gear" size={14} />, run: () => (onClose(), openAgents()) });
    if (q) {
      for (const p of projects.filter((x) => x !== path && has(basename(x), x)).slice(0, MAX_EACH))
        out.push({ id: `project:${p}`, name: basename(p), detail: p, tag: t('newtab.project'), icon: <Icon name="file-directory" size={14} />, run: () => (setFolder(p), setQuery(''), setError('')) });
      for (const f of files.filter((x) => has(x)).slice(0, MAX_EACH))
        out.push({ id: `file:${f}`, name: f, detail: basename(path), tag: t('newtab.file'), icon: <Icon name="code" size={14} />, menu: { surface: 'path', arg: `${path}/${f}` }, run: () => { onClose(); if (rootSession) openFileAt(rootSession, f); } });
      const raw = query.trim();
      if (looksLikeUrl(raw))
        out.push({
          id: 'url',
          name: raw,
          tag: t('newtab.url'),
          icon: <WidgetIcon kind="browser" size={14} /> /* q67 look Q6-2: the globe of the right bar's Browser */,
          run: () => {
            openBrowserTab();
            queueBrowserGo(YOU_SPACE, urlOf(raw));
            onClose();
          },
        });
      if (raw.startsWith('/') && raw.length > 1) out.push({ id: 'folder', name: raw, tag: t('newtab.folder'), icon: <Icon name="file-directory" size={14} />, run: () => takeFolder(raw) });
    }
    // Ticket 305: the default agent's row comes first, so Enter starts it; its account rows are `<agent>:<id>`.
    // Ticket 223: unset means the agent used last (final.html "마지막에 쓴 것").
    // Ticket 358: neither may name an agent that is off.
    // Ticket 472: an asked-for agent (onboarding's "Start a session") goes first, unless it is off.
    const lead = prefer && !agentOff(prefer) ? prefer : leadAgent(defaultAgent, ordered);
    // Ticket 370: no agent can start without a folder, so with none Choose folder goes above it and takes Enter.
    for (const id of [lead, path ? undefined : FOLDER_ROW]) {
      const first = id ? out.findIndex((e) => e.id === id || e.id.startsWith(`${id}:`)) : -1;
      if (!q && first > 0) out.unshift(...out.splice(first, 1));
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, ordered, current, accounts, acp, files, path, projects.join('\n'), t, busy, closed.length, defaultAgent, agentsOff, prefer, place, team, machine]);

  const sel = entries.length ? Math.min(at, entries.length - 1) : -1;
  useEffect(() => void root.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' }), [sel, entries.length]);
  const pick = (e: Entry | undefined) => {
    if (!e || e.disabled || busy) return;
    void e.run();
  };
  // Outside press closes it; the "+" itself is left to its own click (which asks again and so toggles), and so is a menu.
  // Added once and reading the latest through a ref: a listener re-added on each render is missed by a key whose dispatch
  // committed a render first (useGlobalKeys has the same note), and a row's shortcut is exactly such a key.
  const latest = useRef({ entries, keymap, onClose });
  latest.current = { entries, keymap, onClose };
  // A layout effect: attached in the commit that shows the popover. A passive one waits for after the paint (a popover opened from
  // the palette renders in a timeout, not a discrete event), and a press in that window was lost, leaving it open behind the pointer.
  useLayoutEffect(() => {
    const away = (e: PointerEvent) => {
      const el = e.target as Element | null;
      if (!root.current?.contains(el) && !anchor.current?.contains(el) && !el?.closest?.('[role="menu"]')) latest.current.onClose();
    };
    // A hover tooltip (or a menu) takes an Esc and marks it; Esc with focus in the popover is the popover's all the same.
    // It marks the Esc handled so an Overlay behind it (the Board) does not close with it.
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && !e.isComposing && (!e.defaultPrevented || !!root.current?.contains(document.activeElement)) && (e.preventDefault(), latest.current.onClose());
    // A row's own shortcut does its job (the window's key handler runs it); the popover has no reason to stay.
    const chord = (e: KeyboardEvent) => {
      const c = chordOf(e);
      const { entries: rows, keymap: map } = latest.current;
      if (rows.some((x) => x.keyId && map[x.keyId]?.includes(c))) latest.current.onClose();
    };
    // The chooser's Browse folder asks for this popover again, and an ask while open closes it: gone before that (from the palette nothing pressed outside).
    const adding = () => latest.current.onClose();
    document.addEventListener('pointerdown', away, true);
    document.addEventListener('keydown', esc);
    window.addEventListener('keydown', chord, true);
    window.addEventListener(ADD_EVENT, adding);
    return () => {
      window.removeEventListener(ADD_EVENT, adding);
      document.removeEventListener('pointerdown', away, true);
      document.removeEventListener('keydown', esc);
      window.removeEventListener('keydown', chord, true);
    };
  }, []);
  const keyDown = (e: ReactKey<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    const n = entries.length;
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && n) (e.preventDefault(), setAt((sel + (e.key === 'ArrowDown' ? 1 : -1) + n) % n));
    else if ((e.key === 'Home' || e.key === 'End') && !query && n) (e.preventDefault(), setAt(e.key === 'Home' ? 0 : n - 1));
    else if (e.key === 'Enter') (e.preventDefault(), pick(entries[sel]));
  };
  const optionId = (i: number) => `newtab-opt-${i}`;
  return (
    <div ref={root} className="newtab" role="dialog" aria-label={t('newtab.title')} aria-busy={busy || undefined} style={pos}>
      <input {...PLAIN}
        ref={input}
        className="nt-search"
        role="combobox"
        aria-expanded={entries.length > 0}
        aria-controls="newtab-list"
        aria-autocomplete="list"
        aria-activedescendant={sel >= 0 ? optionId(sel) : undefined}
        aria-label={t('newtab.search')}
        placeholder={t('newtab.searchPlaceholder')}
        value={query}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        readOnly={busy}
        onChange={(e) => (setQuery(e.target.value), setAt(0), setError(''))}
        onKeyDown={keyDown}
      />
      {path ? (
        <div className="nt-in" title={path}>
          {/* look 1117: the Home folder is "Home", as in the tree and the header, not its folder name */}
          {machine ? t('newtab.inOn', { name: basename(path), machine }) : t('newtab.in', { name: home && path === home ? t('assistants.title') : basename(path) })}
        </div>
      ) : (
        <div className="nt-in">{t('newtab.pickFolder')}</div>
      )}
      {canWorktree && (
        <div className="sscopes nt-place" role="radiogroup" aria-label={t('newtab.place')}>
          {places.map((k, i) => (
            <button key={k} type="button" role="radio" aria-checked={place === k} tabIndex={place === k ? 0 : -1} disabled={busy} title={k === 'worktree' ? t('newtab.placeWorktreeTip') : k === 'given' ? given?.path : undefined} onClick={() => setPlace(k)} onKeyDown={(e) => (e.key === 'ArrowLeft' || e.key === 'ArrowRight') && (e.preventDefault(), setPlace(places[(i + (e.key === 'ArrowRight' ? 1 : places.length - 1)) % places.length]))}>
              {k === 'given' ? given?.name : t(k === 'here' ? 'newtab.placeHere' : 'newtab.placeWorktree')}
            </button>
          ))}
        </div>
      )}
      {agentsOff.length === 2 && <div className="nt-in">{t('providersManage.allOff')}</div>}
      <div id="newtab-list" role="listbox" aria-label={t('newtab.title')} className="nt-list">
        {entries.map((e, i) => (
          <div
            key={e.id}
            id={optionId(i)}
            role="option"
            className="nt-row"
            data-wrap={e.wrap || undefined}
            aria-selected={i === sel}
            aria-disabled={e.disabled ? true : undefined}
            aria-keyshortcuts={e.keyId && keymap[e.keyId]?.[0]}
            title={e.title ?? [e.name, e.detail].filter(Boolean).join(' · ')}
            data-menu={e.menu?.surface}
            data-menu-session={e.menu?.session}
            data-menu-arg={e.menu?.arg}
            data-menu-title={e.menu ? e.name : undefined}
            onPointerMove={() => i !== sel && setAt(i)}
            onClick={() => pick(e)}
          >
            <span className="nt-ico">{e.icon}</span>
            <span className="nt-name">{e.name}</span>
            {e.detail && <span className="nt-detail">{e.detail}</span>}
            {e.tag && <span className="nt-tag">{e.tag}</span>}
            {e.keyId && keymap[e.keyId]?.[0] && <span className="kbd" aria-hidden="true">{label(keymap[e.keyId][0], keymap)}</span>}
            {e.kbd && <span className="kbd" aria-hidden="true">{e.kbd}</span>}
          </div>
        ))}
      </div>
      <div role="status" className="nt-status">
        {q && !entries.length ? t('newtab.empty') : ''}
      </div>
      {error.startsWith(FILE_ACCESS) ? (
        <FolderAccess reason={error} />
      ) : (
        error && (
          <span className="conflict nt-error" role="alert">
            {error}
            {held?.line === error && (
              <span className="held-act">
                <button type="button" className="btn" data-tip={t('err.startAnyway.tip')} onClick={held.run}>
                  {t('err.startAnyway')}
                </button>
              </span>
            )}
            <ErrorDetails t={t} details={details} />
          </span>
        )
      )}
    </div>
  );
}

/** Stop through `close`: a running agent asks once ("Stop?"), anything else stops at once. */
export const needsAsk = (s: Session) => s.state === 'running' && s.kind !== 'shell';

/** `words` replaces the Stop wording for another one-question confirm (ticket 338: closing a running session's tab). */
export function StopAsk({ name, error, onCancel, onStop, words }: { name: string; error: string; onCancel: () => void; onStop: () => void; words?: { title: string; text: string; cancel: string; stop: string } }) {
  const t = useHtmlLangT();
  const w = words ?? { title: t('stopAsk.title', { name }), text: t('stopAsk.text'), cancel: t('stopAsk.cancel'), stop: t('stopAsk.stop') };
  return (
    <div className="wnotice" role="alertdialog" aria-label={w.title} aria-describedby="stop-text" onKeyDown={(e) => (e.stopPropagation(), e.key === 'Escape' && onCancel())}>
      <b>{w.title}</b>
      <p id="stop-text">{w.text}</p>
      {error && (
        <span className="conflict" role="alert">
          {plainError(t, error)}
          <ErrorDetails t={t} details={error} />
        </span>
      )}
      <div className="row">
        <button className="btn" autoFocus onClick={onCancel}>
          {w.cancel}
        </button>
        <button className="btn p" onClick={onStop}>
          {w.stop}
        </button>
      </div>
    </div>
  );
}
