// V2-8a (WTDIALOGS: Draft 1 "One-click+"): the window's worktree actions over the core's `worktree` op. Create is
// one field (text, a GitHub PR or issue URL, or empty) that closes on Enter and leaves a progress row; a clean remove
// has no dialog and a toast offers Undo (re-added from the kept branch); a dirty remove asks in a sheet with Cancel
// first and "Discard and remove" only (no commit, stash or move: v1b B3). Rename is the label only, inline in the row.
// PR creation is never run by the app: Diff's one button (ticket 373) only asks the session's agent, when pressed.
import { PLAIN } from '../plainText';
import { useCallback, useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKey, type ReactNode } from 'react';
import { CoreRefusal, PR_REFUSALS } from '../api';
import { ErrorDetails, plainError, tipError, rawError } from '../errors';
import { lastAccount, likeNew } from '../NewSession';
import { AGENTS_OFF, isOff, leadAgent, modelChoices, MODELS_OFF, useCustomModels } from '../settings/agents/newDefaults';
import { DEFAULT_AGENT } from '../settings/onboarding/state';
import { currentFeature, defineSetting, useFeatureSetting } from '../settings/useFeatureSetting';
import type { Account, BranchRef, CoreClient, WorktreeBaseReply, WorktreeCleaned, WorktreeLoss, WorktreeOp, WorktreeReply, WorktreeStale } from '../api';
import type { Command } from '../keys';
import { TidyPanel } from './Tidy';
import { AlertSheet } from './Dialogs';
import { copyText } from '../terminal/clipboard';
import { openInEditor } from '../files/open'; // ticket 375
import { basename, listedFact, listedName, type ListedWorktree, type WorktreeFact } from '../tree';
import { agentState, noCheckout, type Session } from '../types';
import { push as pushUndo } from '../undo/store';
import type { SetupStatus } from '../approval/types';
import { enT, plural, type T } from './state';
import { sessionName } from '../Sidebar';
import { askHand } from '../bots/bots';

/** A PR refusal in the window's words; ticket 403 item 14: the stale one ends in `: <branch>` (no branch holds a `:`). */
const prRefusal = (message: string, t: T) => {
  const at = message.lastIndexOf(': ');
  const text = at < 0 ? message : message.slice(0, at);
  if (Object.hasOwn(PR_REFUSALS, message)) return t(PR_REFUSALS[message]);
  return Object.hasOwn(PR_REFUSALS, text) ? `${t(PR_REFUSALS[text])} (${message.slice(at + 2)})` : plainError(t, message);
};
/** How often the list (and its counts) is read again while nothing else asks; each read runs `git status` per worktree. */
const REFRESH_MS = 30_000;
const TOAST_MS = 10_000;
/** A folder removed outside Nunchiro fades this long, then its record is cleaned up (git metadata is kept). */
export const GONE_MS = 5_000;

type Undo = { project: string; path: string; branch: string; label: string };
export type Toast = { id: number; text: string; undo?: Undo | Undo[]; details?: string };
/** V2.5-61 B8: the rect of the worktree button a create was opened from; the card sits under it. */
export type Anchor = { top: number; bottom: number; left: number; right: number };
export type Ask = { kind: 'create'; project: string; anchor?: Anchor } | { kind: 'tidy'; project: string | null } | { kind: 'dirty'; path: string; name: string; branch: string; loss: WorktreeLoss }
  // Ticket 991 A3: a remove with running sessions asks once to stop them (named) and remove.
  | { kind: 'live'; path: string; name: string; live: { id: string; name: string }[] };

export interface Worktrees {
  list: ListedWorktree[];
  sessions: Session[];
  facts: ReadonlyMap<string, WorktreeFact>;
  /** Creates sent and not answered yet: a progress row each, under their project. */
  creating: { key: number; project: string; name: string }[];
  /** The worktree row last focused or clicked: what the palette's worktree commands act on. */
  selected: string | null;
  select: (path: string | null) => void;
  renaming: string | null;
  setRenaming: (path: string | null) => void;
  /** V2.5-55: the main-folder session row whose name is being edited inline (a session id). */
  renamingSession: string | null;
  setRenamingSession: (id: string | null) => void;
  /** Q7 point 4: main-folder sessions the user settled: their row folds into "N done" until they work or ask again. */
  settled: ReadonlySet<string>;
  settle: (id: string) => void;
  /** Undo of `settle`: the row comes back out of "N done". */
  unsettle: (id: string) => void;
  ask: Ask | null;
  setAsk: (a: Ask | null) => void;
  toast: Toast | null;
  dismiss: () => void;
  create: (project: string, from: string, advanced?: { base: string; branch: string }) => Promise<ListedWorktree | undefined>;
  core: CoreClient;
  accounts: () => Promise<{ accounts: Account[] }>;
  /** V2.5-61 B8: the project's branches for the create dialog (the core's read-only `branches` op). Ticket 374: with `base`,
   * what a create with no base starts from (`origin/main`); null is the current branch. Ticket 410: `complete` is false when
   * the core cut the list (over 500 refs, or names unsafe to show), so a name missing from it may still be a branch. */
  branches: (project: string) => Promise<{ refs: BranchRef[]; base: string | null; complete: boolean }>;
  start: (project: string, path: string, kind: 'claude' | 'codex', model: string | null, account: string | null, failed?: string) => Promise<Session>;
  /** Ticket 259: waits while the new worktree's setup tab runs (with "Agent waits for setup" on); false when setup failed or
   *  did not run, after a toast that leaves the agent start to the user; false, with no toast, once `cancelled` says so. */
  setupGate: (path: string, cancelled?: () => boolean) => Promise<boolean>;
  prompt: (id: string, text: string) => Promise<unknown>;
  remove: (path: string, confirm?: WorktreeLoss) => void;
  /** Ticket 991 A3: stops the sessions a `live` ask named, then removes as `remove` does. */
  stopAndRemove: (path: string, ids: string[]) => Promise<void>;
  /** V2-8g: the clean remove of each path, one after the other; one toast, one Undo; resolves to the ones kept. */
  tidy: (paths: string[]) => Promise<Map<string, WorktreeLoss>>;
  rename: (path: string, label: string) => Promise<string | null>;
  /** Ticket 990: hands a worktree to its project's lead (`lead`, a teammate id) or takes it back (''). */
  team: (path: string, lead: string) => Promise<unknown>;
  /** Reads the list again now (ticket 990: a team line in the room says a worktree was made or removed elsewhere). */
  refresh: () => void;
  open: (path: string) => Promise<Session | null>;
  /** Ticket 1130 C2: the default agent in a new auto-named worktree of `project`, as the create dialog starts one (create,
   *  the setup wait, start); with no agent on, the create dialog opens instead. Failures are toasts. */
  startNew: (project: string) => Promise<void>;
  /** Ticket 375: opens a folder in the editor chosen in Settings; a refusal is a toast. */
  editor: (path: string) => void;
  undo: () => void;
}

// Ticket 259: how often and how long start-an-agent asks whether the setup tab finished.
const SETUP_POLL_MS = 1000;
const SETUP_WAIT_MS = 30 * 60_000;
const prNumber = (url: string) => Number(/\/pull\/(\d+)$/.exec(url)?.[1] ?? 0);

/** The core's `text_slug` (worktree_clean.rs), for the preview: ASCII text is lowercase words joined by "-" (48 at most);
 *  text with a letter or digit of another script keeps its script, as a title's name does (40 characters at most). Eighth
 *  look (A): a Korean task previewed nothing and was named "wt-xxxx". */
export function textSlug(text: string): string {
  if (!/[^\x00-\x7f]/.test(text.replace(/[^\p{L}\p{N}]/gu, ''))) return text.replace(/[^A-Za-z0-9]+/g, '-').toLowerCase().replace(/^-/, '').slice(0, 48).replace(/-$/, '');
  const words = text.normalize('NFC').replace(/[A-Z]/g, (c) => c.toLowerCase()).split(/[^\p{L}\p{N}]+/u).filter(Boolean).join('-');
  return [...words].slice(0, 40).join('').replace(/-$/, '');
}

export function useWorktrees(core: CoreClient, connected: boolean, sessions: Session[], onStarted?: (s: Session) => void, t: T = enT): Worktrees {
  const [list, setList] = useState<ListedWorktree[]>([]);
  const [loaded, setLoaded] = useState(false); // the first full list has come: only then is a folder known to be unmanaged
  const [prs, setPrs] = useState<ReadonlyMap<string, NonNullable<WorktreeFact['pr']>>>(new Map());
  const [creating, setCreating] = useState<Worktrees['creating']>([]);
  const [selected, select] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renamingSession, setRenamingSession] = useState<string | null>(null);
  // Look 1117 v3 (item 13): kept across a relaunch, in this window's storage as the unread marks are.
  const [settled, setSettled] = useState<ReadonlySet<string>>(() => {
    try {
      const v = JSON.parse(localStorage.getItem(SETTLED_KEY) ?? '[]');
      return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
    } catch {
      return new Set(); // storage blocked or the value is bad: memory only
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(SETTLED_KEY, JSON.stringify([...settled]));
    } catch {
      // memory only
    }
  }, [settled]);
  const settle = useCallback((id: string) => setSettled((s) => new Set([...s, id])), []);
  const unsettle = useCallback((id: string) => setSettled((s) => new Set([...s].filter((x) => x !== id))), []);
  // A settled session that works or asks again comes back to its own row (and leaves the set, so its next finish stays out).
  // Before the first snapshot the list is empty: nothing is pruned then, or a relaunch would drop every settled row.
  useEffect(() => setSettled((s) => {
    if (!sessions.length) return s;
    const keep = [...s].filter((id) => sessions.some((x) => x.id === id && !x.attention.working && !x.attention.waiting));
    return keep.length === s.size ? s : new Set(keep);
  }), [sessions]);
  const [ask, setAsk] = useState<Ask | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const tr = useRef(t); // the toasts say their words when they happen, in the language then chosen
  tr.current = t;
  const seq = useRef(0);
  const shown = useRef(new Set<number>());
  const opened = useRef(Date.now());
  const say = useCallback((text: string, undo?: Undo | Undo[], details?: string) => setToast({ id: ++seq.current, text, undo, details }), []);
  const take = useCallback(
    (r: WorktreeReply, scope?: string | null) => {
      // Same content keeps the same array: the tree re-reads its rows only when something changed. A reply scoped to one
      // project (create, restore) lists only that project: the others keep their rows until the next full list.
      if (r.worktrees && !scope) setLoaded(true);
      if (r.worktrees)
        setList((old) => {
          const next = scope ? [...old.filter((l) => l.project !== scope), ...r.worktrees!] : r.worktrees!;
          return JSON.stringify(old) === JSON.stringify(next) ? old : next;
        });
      // V2-8a auto-clean: one toast per removal this window had not shown (older ones predate this window).
      for (const c of (r.cleaned ?? []) as WorktreeCleaned[]) {
        if (shown.current.has(c.id)) continue;
        shown.current.add(c.id);
        if (c.at_ms >= opened.current - REFRESH_MS) say(tr.current('dialog.worktree.autoCleaned', { name: c.label || c.branch }), c);
      }
      return r;
    },
    [say],
  );
  const op = useCallback((o: WorktreeOp) => core.worktree(o).then((r) => take(r, 'project' in o ? o.project : null)), [core, take]);
  const refresh = useCallback(() => void op({ operation: 'list' }).catch(() => {}), [op]);
  // Ticket 991 (Q7 point 1): a session in a worktree that takes its title may have named the worktree's generated branch;
  // the core does that in the list this asks for, so the row, the header and the palette show the new name at once.
  const cwds = sessions.map((s) => `${s.cwd}\n${s.state}\n${s.cwd === s.project ? '' : s.label}`).join('\n');
  useEffect(() => {
    if (!connected) return;
    refresh();
    const t = window.setInterval(refresh, REFRESH_MS);
    return () => window.clearInterval(t);
  }, [connected, refresh, cwds]);

  // V2-CF3: a folder `session start --worktree` made has no record: the core adopts it (the record only), so its row
  // gets Rename and Remove. Once per folder; the core refuses anything that is not a worktree of the project.
  const adopting = useRef(new Set<string>());
  useEffect(() => {
    if (!connected || !loaded) return;
    const known = new Set(list.map((l) => l.path));
    const todo = sessions.filter((s) => s.cwd !== s.project && !s.machine && !known.has(s.cwd) && !adopting.current.has(s.cwd));
    for (const s of todo) {
      adopting.current.add(s.cwd);
      void op({ operation: 'adopt', project: s.project, path: s.cwd }).catch(() => {});
    }
  }, [connected, loaded, sessions, list, op]);

  // V2-8b chip data (local transcripts, no network): a worktree whose agent's PR merged reads "Merged - remove".
  const key = list.map((l) => l.path).join('\n') + cwds;
  // Ticket 373: every listed folder with no chip asks for its branch's own PR (an outside one too; live PR status on,
  // cached per branch in the core), re-read with the list's 30 s refresh, and the row takes its state and failed checks.
  useEffect(() => {
    if (!connected) return;
    let live = true;
    const read = () => {
      const paths = new Set(list.map((l) => l.path));
      const asked = sessions.filter((s) => paths.has(s.cwd));
      void Promise.all(
        asked.map((s) =>
          core.request({ op: 'pr_chip', id: s.id }).then(
            (r) => [s.cwd, (r as { chip?: { state: string; url: string } | null }).chip] as const,
            () => [s.cwd, null] as const,
          ),
        ),
      ).then(async (rows) => {
        type Pr = NonNullable<WorktreeFact['pr']>;
        const next = new Map<string, Pr>();
        for (const [cwd, chip] of rows) if (chip) next.set(cwd, { number: prNumber(chip.url), state: chip.state as Pr['state'] });
        const rest = [...paths].filter((p) => !next.has(p));
        const found = await Promise.all(rest.map((p) => core.prBranch(p).then((pr) => [p, pr] as const, () => [p, null] as const)));
        for (const [p, pr] of found) if (pr) next.set(p, { number: pr.number, state: pr.state, ...(pr.failed.length ? { failed: pr.failed.map((c) => c.name).join(', ') } : {}) });
        if (live) setPrs(next);
      });
    };
    read();
    const timer = window.setInterval(read, REFRESH_MS);
    return () => void ((live = false), window.clearInterval(timer));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, key]);

  // A folder gone outside the app: its row fades (the gone row), then the record is cleaned up. No dialog.
  const cleaning = useRef(new Set<string>());
  useEffect(() => {
    const gone = list.filter((l) => l.missing && !cleaning.current.has(l.path));
    if (!gone.length) return;
    const t = window.setTimeout(() => {
      for (const l of gone) {
        cleaning.current.add(l.path);
        // Record only: the core refuses if the folder is back meanwhile.
        void op({ operation: 'forget', path: l.path }).catch(() => cleaning.current.delete(l.path));
      }
    }, GONE_MS);
    return () => window.clearTimeout(t);
  }, [list, op]);

  useEffect(() => {
    if (!toast || toast.details) return; // ticket 476: a failure stays until × closes it, so its Details can be read
    const t = window.setTimeout(() => setToast((x) => (x === toast ? null : x)), TOAST_MS);
    return () => window.clearTimeout(t);
  }, [toast]);

  const facts = new Map<string, WorktreeFact>(list.map((l) => [l.path, { ...listedFact(l), pr: prs.get(l.path) }]));
  const byPath = (path: string) => list.find((l) => l.path === path);
  const create: Worktrees['create'] = (project, from, advanced) => {
    const key = ++seq.current;
    const name = advanced?.branch || from.trim() || t('dialog.worktree.newName');
    setCreating((c) => [...c, { key, project, name }]);
    // Ticket 374: no base unless Advanced has one: the core starts from origin's default branch (fetched first).
    return op({ operation: 'create', project, from, branch: advanced?.branch || null, base: advanced?.base || '' })
      // Create appends its record under the worktree lock; the reply preserves that order.
      .then((r) => {
        const made = r.worktrees?.at(-1) as (ListedWorktree & WorktreeStale) | undefined;
        if (made?.stale_base) say(t('wtbase.stale', { branch: made.stale_base }));
        if (made?.shared_failed?.length) say(t('wtFiles.failed', { paths: made.shared_failed.join('; ') })); // ticket 253
        return made;
      })
      .catch((e: Error) => { say(t('dialog.worktree.createFailed', { error: prRefusal(rawError(e), t) }), undefined, rawError(e)); return undefined; })
      .finally(() => setCreating((c) => c.filter((x) => x.key !== key)));
  };
  const remove: Worktrees['remove'] = (path, confirm) => {
    const l = byPath(path);
    if (!l) return;
    op({ operation: 'remove', path, confirm }).then(
      (r) => {
        if (r.loss) return setAsk({ kind: 'dirty', path, name: listedName(l, sessions), branch: l.branch, loss: r.loss });
        setAsk((a) => (a?.kind === 'dirty' && a.path === path ? null : a));
        // A detached folder (a session's) has no branch to re-add from: no Undo.
        if (!l.missing) say(t(l.branch ? 'dialog.worktree.removedKept' : 'dialog.worktree.removed', { name: listedName(l, sessions) }), l.branch ? { project: l.project, path: l.path, branch: l.branch, label: l.label } : undefined);
      },
      (e: Error) => {
        setAsk((a) => (a?.kind === 'dirty' && a.path === path ? null : a));
        // Ticket 991 A3: refused for running sessions (in the folder or below it): ask once to stop them and remove.
        const live = sessions.filter((s) => s.state === 'running' && (s.cwd === path || s.cwd.startsWith(`${path}/`)));
        if (rawError(e).includes('close live worktree sessions first') && live.length)
          return setAsk({ kind: 'live', path, name: listedName(l, sessions), live: live.map((s) => ({ id: s.id, name: sessionName(s) })) });
        say(t('dialog.worktree.removeFailed', { name: listedName(l, sessions), error: plainError(t, e) }), undefined, rawError(e));
      },
    );
  };
  // V2-8g: never forced. A refused remove is resent once with the loss it named only when that is commits alone, on the
  // branch kept (a squash- or rebase-merged branch: auto-clean excuses the same case); uncommitted or git-ignored files
  // are never confirmed here. Resolves to the paths the core kept, with what it found, so the panel can offer them a decision.
  const tidy: Worktrees['tidy'] = async (paths) => {
    const done: Undo[] = [];
    const kept = new Map<string, WorktreeLoss>();
    let gone = 0;
    let failed = 0;
    for (const path of paths) {
      const l = byPath(path);
      if (!l) continue;
      if (l.missing) {
        // The record of a folder that is gone: the core refuses if the folder is back meanwhile.
        await op({ operation: 'forget', path }).then(() => void gone++, () => void failed++);
        continue;
      }
      let r = await op({ operation: 'remove', path }).catch(() => null);
      const loss = r?.loss;
      if (loss && loss.uncommitted_total === 0 && loss.ignored_total === 0 && loss.kept_on === l.branch) r = await op({ operation: 'remove', path, confirm: loss }).catch(() => null);
      if (!r) failed++;
      else if (r.loss) kept.set(path, r.loss);
      else done.push({ project: l.project, path: l.path, branch: l.branch, label: l.label });
    }
    const why = new Set([...kept.values()].map((k) => t(k.uncommitted_total > 0 ? 'dialog.tidy.whyFiles' : k.ignored_total > 0 ? 'dialog.tidy.whyIgnored' : 'dialog.tidy.commitsOnly')));
    const text = [
      done.length ? plural(t, 'dialog.tidy.done', done.length) : '',
      gone ? plural(t, done.length ? 'dialog.tidy.goneCleaned' : 'dialog.tidy.cleaned', gone) : '',
      kept.size ? t('dialog.tidy.left', { n: kept.size, why: [...why].join(', ') }) : '',
      failed ? t('dialog.tidy.failed', { n: failed }) : '',
    ].filter(Boolean);
    if (text.length) say(text.join(' · '), done.length ? done : undefined);
    return kept;
  };
  const undo = async () => {
    const all = ([] as Undo[]).concat(toast?.undo ?? []);
    if (!all.length) return;
    setToast(null);
    const back: Undo[] = [];
    let refused = '';
    for (const u of all) await op({ operation: 'restore', project: u.project, path: u.path, branch: u.branch, label: u.label }).then(() => void back.push(u), (e: Error) => void (refused = rawError(e)));
    if (back.length) say(back.length === 1 ? t('dialog.worktree.restored', { name: back[0].label || back[0].branch }) : t('dialog.worktree.restoredMany', { n: back.length }));
    else say(t('dialog.worktree.nothingToUndo', { error: plainError(t, refused) }), undefined, refused);
  };
  const api: Worktrees = {
    list,
    sessions,
    facts,
    creating,
    selected,
    select,
    renaming,
    setRenaming,
    renamingSession,
    setRenamingSession,
    settled,
    settle,
    unsettle,
    ask,
    setAsk,
    toast,
    dismiss: () => setToast(null),
    create,
    // Not through `op`: its reply carries no worktrees, which `take` would read as this project having none.
    branches: (project) =>
      core.worktree({ operation: 'branches', project }).then((r) => ({ refs: r.branches ?? [], base: (r as WorktreeBaseReply).default_base ?? null, complete: !r.branches_truncated && !r.branches_dropped })),
    core,
    editor: (path) => void openInEditor(core, path).catch((e) => say(t('files.editorFailed', { error: plainError(t, rawError(e)) }), undefined, rawError(e))),
    accounts: () => core.accounts(),
    start: async (project, path, kind, model, account, failed) => {
      if (failed) await core.request({ op: 'close', id: failed });
      const reply = await core.request({ op: 'start', folder: path, session: { kind, project, ...likeNew(null, [], kind, project), ...(model ? { model, effort: null } : {}), resume: null, ...(account ? { account } : {}) } }) as { session: Session };
      if (reply.session.state === 'running') onStarted?.(reply.session);
      return reply.session;
    },
    setupGate: async (path, cancelled) => {
      const until = Date.now() + SETUP_WAIT_MS;
      for (;;) {
        if (cancelled?.()) return false;
        // An older core or a folder it does not know: nothing to wait for.
        const agent = await core.request({ op: 'setup_status', path }).then((r) => (r as { status: SetupStatus }).status.agent, () => 'start' as const);
        if (agent === 'start') return true;
        if (agent === 'user' || Date.now() > until) return (say(t('setupScripts.agentLeft')), false);
        await new Promise((r) => window.setTimeout(r, SETUP_POLL_MS));
      }
    },
    prompt: async (id, text) => {
      try { await core.request({ op: 'agent_prompt', id, text }); }
      // Even a refusal can follow text and Enter reaching the PTY before the final store write fails.
      catch { say(t('dialog.worktree.promptUncertain')); }
    },
    remove,
    stopAndRemove: async (path, ids) => {
      const l = byPath(path);
      const failed = await Promise.all(ids.map((id) => core.request({ op: 'close', id }).then(() => null, (e: Error) => e))).then((r) => r.find(Boolean));
      setAsk(null);
      if (failed) return say(t('dialog.worktree.removeFailed', { name: l ? listedName(l, sessions) : basename(path), error: plainError(t, failed) }), undefined, rawError(failed));
      remove(path);
    },
    tidy,
    rename: (path, label) => op({ operation: 'rename', path, label }).then(() => null, (e: Error) => tipError(t, e)), // shown as the field's tooltip
    team: (path, lead) => op({ operation: 'team', path, label: lead }), // ticket 990
    refresh,
    open: (path) =>
      core.worktree({ operation: 'open', path }).then(
        (r) => (r.session && onStarted?.(r.session), r.session ?? null),
        (e: Error) => (say(t('dialog.worktree.openFailed', { error: plainError(t, e) }), undefined, rawError(e)), null),
      ),
    startNew: async (project) => {
      const kind = leadAgent(currentFeature(DEFAULT_AGENT), sessions);
      if (kind !== 'claude' && kind !== 'codex') return setAsk({ kind: 'create', project });
      const made = await api.create(project, '');
      if (!made || !(await api.setupGate(made.path))) return;
      try {
        const accounts = await core.accounts().then((r) => r.accounts, () => [] as Account[]);
        const s = await api.start(project, made.path, kind, null, lastAccount(sessions, kind, project, accounts));
        if (s.state !== 'running') throw new CoreRefusal(s.problem?.cause ?? t('dialog.worktree.notRunning'));
      } catch (e) {
        say(t('dialog.worktree.startFailed', { error: plainError(t, e) }), undefined, rawError(e));
      }
    },
    undo,
  };
  return api;
}

/** Ticket 467: the last "Start an agent here" choice and its agent, kept with the window's other feature values; first use is off. */
const START_AGENT = defineSetting<{ on: boolean; agent?: 'claude' | 'codex' }>('worktree.start_agent', { on: false }, (v) => {
  const o = v as { on?: unknown; agent?: unknown } | null;
  if (typeof o?.on !== 'boolean') return undefined;
  return { on: o.on, agent: o.agent === 'claude' || o.agent === 'codex' ? o.agent : undefined };
});

/** A field's Enter during an IME composition belongs to the composition (macOS reports keyCode 229). */
const typing = (e: ReactKey) => e.nativeEvent.isComposing || e.keyCode === 229;

/** A listed ref's branch name, as the core split it: a remote ref's name after its known remote (`team/up/x` is `x`). */
const shortName = (r: BranchRef) => r.branch;
/** Ticket 410: what the Advanced base field offers: every local and remote branch, never a remote's `HEAD` pointer. */
const baseRefs = (refs: BranchRef[]) => refs.filter((r) => !(r.remote && r.branch === 'HEAD'));
/** Ticket 410: a typed base the core may take: empty (origin's default), `HEAD` (the 374 mock's way back to the current
 * branch), or a listed branch by its listed or full ref name. `complete` false (a cut list) or no list read: not judged. */
export const isBase = (typed: string, refs: BranchRef[] | null, complete: boolean) =>
  !typed || typed === 'HEAD' || !refs || !complete || baseRefs(refs).some((r) => r.name === typed || typed === `refs/${r.remote ? 'remotes' : 'heads'}/${r.name}`);

/** Cmd+N: one field; Enter creates and closes, Option+Enter shows Advanced (base, branch name), Esc cancels.
 * V2.5-61 B8: as the name is typed, up to 8 existing branches containing it are listed under the field (row shape after
 * T3 Code's WorktreeBaseBranchPicker: the name, then one muted tag). An exact match is offered first and selected, so
 * Enter creates on that branch; a branch in a worktree is tagged and never chosen. */
function CreateDialog({ t, project, anchor, wt, onClose }: { t: T; project: string; anchor?: Anchor; wt: Worktrees; onClose: () => void }) {
  const [from, setFrom] = useState('');
  // Read once; any failure (a thrown call too) leaves the dialog as it was (no list, no error).
  const [refs, setRefs] = useState<BranchRef[]>([]);
  const [defaultBase, setDefaultBase] = useState<string | null>(null);
  /** Ticket 410: the list the base is checked against; null until read (or when the read failed: nothing is refused). */
  const [known, setKnown] = useState<{ refs: BranchRef[]; complete: boolean } | null>(null);
  /** The read itself, so a Create pressed before it answers waits for it rather than skipping the check. */
  const reading = useRef<Promise<{ refs: BranchRef[]; complete: boolean } | null>>(Promise.resolve(null));
  useEffect(() => {
    const read = Promise.resolve().then(() => wt.branches(project));
    reading.current = read.then((r) => ({ refs: r.refs, complete: r.complete }), () => null);
    void read.then((r) => (setRefs(r.refs), setDefaultBase(r.base), setKnown({ refs: r.refs, complete: r.complete })), () => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project]);
  const [listOpen, setListOpen] = useState(true);
  /** The option moved to with the arrows; `null` is the default (the offered exact match, if any). */
  const [active, setActive] = useState<number | null>(null);
  const listId = useId();
  const [remembered, remember] = useFeatureSetting(START_AGENT);
  const [agentsOff] = useFeatureSetting(AGENTS_OFF); // ticket 358
  const agents = (['claude', 'codex'] as const).filter(a => !agentsOff.includes(a));
  // 467: a remembered "on" opens Advanced too, so the choice is in view and a plain Enter never starts an unseen agent.
  const [startAgent, setStartAgent] = useState(() => remembered.on && agents.length > 0);
  const [advanced, setAdvanced] = useState(startAgent);
  const [base, setBase] = useState('');
  /** Ticket 410 (374 mock, newwt): the base field's own branch list, open while that field is typed in. */
  const [baseOpen, setBaseOpen] = useState(false);
  const [baseActive, setBaseActive] = useState<number | null>(null);
  const [baseError, setBaseError] = useState('');
  const baseListId = useId();
  const baseErrorId = useId();
  const [branch, setBranch] = useState('');
  // Same start value as the New session window (leadAgent), until the person picks; derived, so a setting that loads late still counts.
  const [defaultAgent] = useFeatureSetting(DEFAULT_AGENT);
  const lead = leadAgent(defaultAgent === 'claude' || defaultAgent === 'codex' ? defaultAgent : '', wt.sessions); // only these two start here
  const [pickedKind, setKind] = useState<'claude' | 'codex' | null>(() => (remembered.agent && agents.includes(remembered.agent) ? remembered.agent : null));
  const kind = pickedKind ?? (lead === 'claude' || lead === 'codex' ? lead : agents[0] ?? 'claude');
  const [model, setModel] = useState<string | null>(null);
  const [modelOpen, setModelOpen] = useState(false);
  const [off] = useFeatureSetting(MODELS_OFF); // ticket 357
  const modelOptions = modelChoices(kind, useCustomModels(wt.core)); // ticket 358
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [picked, setPicked] = useState<{ kind: string; label: string | null } | null>(null);
  const [created, setCreated] = useState<ListedWorktree>();
  const [started, setStarted] = useState<Session>();
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [details, setDetails] = useState('');
  const [uncertain, setUncertain] = useState(false);
  // Q9 es-J13-1: the setup wait (up to 30 min) is a start in flight that Cancel, Esc and a click outside still end.
  const [gating, setGating] = useState(false);
  const flight = useRef(false);
  const modelButton = useRef<HTMLButtonElement>(null);
  const card = useRef<HTMLDivElement>(null);
  /** Ticket 410 round 2 (F2): set when the card closes (Cancel, Esc, a click outside, unmount); a submit waiting for the
   * branch read stops there, so a cancelled card never creates. */
  const closed = useRef(false);
  useEffect(() => {
    closed.current = false;
    return () => void (closed.current = true);
  }, []);
  const cancel = () => ((closed.current = true), onClose());
  const close = useRef(cancel);
  close.current = () => void ((!flight.current || gating) && cancel());
  useEffect(() => {
    if (startAgent) void wt.accounts().then(r => setAccounts(r.accounts), () => setAccounts([]));
    // Read once when the choice opens, like New Session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startAgent]);
  const choices = accounts.filter(a => a.agent === kind);
  const account = choices.length < 2 ? null : picked?.kind === kind ? picked.label : lastAccount(wt.sessions, kind, project, accounts);
  const submit = async (existing?: BranchRef) => {
    if (flight.current || uncertain) return;
    // Ticket 410: a base that is not one of the project's branches is refused here, with the reason, before Create.
    // Round 2 (F1): a retry of start after the worktree exists is not judged again.
    if (!existing && !created && advanced && baseValue && baseValue !== 'HEAD') {
      // A second Enter while the read is awaited must not create twice: hold the flight for the wait.
      let k = known;
      if (!k) {
        flight.current = true;
        k = await reading.current;
        flight.current = false;
        if (closed.current) return; // round 2 (F2): cancelled while the read was awaited
      }
      if (!isBase(baseValue, k?.refs ?? null, k?.complete ?? false)) {
        setBaseError(t('tree.wtbase.notBranch', { base: baseValue }));
        baseField.current?.focus();
        return;
      }
    }
    // Round 2 (F1): the highlighted branch the preview names is the base; the field shows it from here on.
    if (baseChosen) (setBase(baseChosen.name), setBaseOpen(false));
    // An existing branch is checked out as it is; a remote one becomes a local branch at the remote commit.
    remember({ on: startAgent, agent: startAgent ? kind : remembered.agent });
    const advancedFields = existing
      ? { branch: shortName(existing), base: existing.remote ? `refs/remotes/${existing.name}` : '' }
      : advanced ? { base: baseValue, branch: branch.trim() } : undefined;
    if (!startAgent) {
      onClose();
      void wt.create(project, from, advancedFields);
      return;
    }
    setPicked({ kind, label: account });
    flight.current = true;
    setBusy(true);
    setError('');
    setDetails('');
    try {
      const worktree = created ?? await wt.create(project, from, advancedFields);
      if (!worktree) return;
      setCreated(worktree);
      setGating(true);
      const ready = await wt.setupGate(worktree.path, () => closed.current);
      setGating(false);
      if (closed.current) return;
      if (!ready) return onClose();
      const session = await wt.start(project, worktree.path, kind, model, account, started?.id);
      setStarted(session);
      if (session.state !== 'running') throw new CoreRefusal(session.problem?.cause ?? t('dialog.worktree.notRunning'));
      if (session.cwd !== worktree.path || session.project !== project) {
        setUncertain(true);
        setError(t('dialog.worktree.wrongFolder'));
        return;
      }
      if (prompt.trim()) {
        await wt.prompt(session.id, prompt);
      }
      onClose();
    } catch (e) {
      // A lost start reply may follow a successful launch: never blindly repeat it.
      const unknown = !(e instanceof CoreRefusal);
      setUncertain(unknown);
      setError(t(unknown ? 'dialog.worktree.unknown' : 'dialog.worktree.startFailed', { error: plainError(t, e) }));
      setDetails(rawError(e));
    } finally {
      flight.current = false;
      setBusy(false);
    }
  };
  // Mirror the core's display name only; PR resolution and random names remain creation-time decisions.
  // Rust str::trim uses Unicode White_Space; JS trim instead removes BOM and keeps NEL.
  const text = from.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '');
  const github = /^https:\/\/github\.com\/[A-Za-z0-9_][A-Za-z0-9._-]*\/[A-Za-z0-9_][A-Za-z0-9._-]*\/(pull|issues?)\/(\d{1,9})$/.exec(text);
  const preview = (advanced && branch.trim()) || (github ? `${github[1] === 'pull' ? 'pr' : 'issue'}-${Number(github[2])}` : textSlug(text));
  // Ticket 410: as the base is typed, up to 8 branches containing it (an exact one first); the highlighted one is the base.
  const bq = base.trim().toLowerCase();
  const baseExact = (r: BranchRef) => r.name === base.trim();
  const baseMatches = advanced && bq ? baseRefs(refs).filter((r) => r.name.toLowerCase().includes(bq)).sort((a, b) => Number(baseExact(b)) - Number(baseExact(a))).slice(0, 8) : [];
  const baseShown = baseOpen && baseMatches.length > 0;
  const baseSel = baseShown ? Math.min(baseActive ?? 0, baseMatches.length - 1) : null;
  const baseChosen = baseSel === null ? undefined : baseMatches[baseSel];
  const baseValue = baseChosen?.name ?? base.trim();
  // Ticket 374: the base the core will use: Advanced's, else origin's default (fetched first), else the current branch.
  const typedBase = advanced && baseValue;
  const previewBase = typedBase || defaultBase || t('dialog.worktree.previewCurrent');
  const isPr = github?.[1] === 'pull';
  const fetchedFirst = !typedBase && !!defaultBase && !isPr;
  const q = text.toLowerCase();
  const exact = (r: BranchRef) => shortName(r) === text || r.name === text;
  // A remote ref whose branch name a local branch already has is left out: create would check out the local one.
  const locals = new Set(refs.filter((r) => !r.remote).map((r) => r.name));
  // 467: also with Advanced open while Base and Branch name are empty, so nothing typed there is ever ignored.
  const matches = q && (!advanced || (!base.trim() && !branch.trim())) ? refs.filter((r) => (!r.remote || !locals.has(shortName(r))) && r.name.toLowerCase().includes(q)).sort((a, b) => Number(exact(b)) - Number(exact(a))).slice(0, 8) : [];
  // A local branch of that name wins over a remote one; one in a worktree is offered as nothing.
  const local = matches.find((r) => !r.remote && r.name === text);
  const offered = local ? (local.in_worktree ? undefined : local) : matches.find((r) => r.remote && exact(r));
  const shown = listOpen && matches.length > 0;
  const sel = !shown ? null : (active ?? (offered ? matches.indexOf(offered) : null));
  const chosen = sel === null ? undefined : matches[sel];
  const move = (step: 1 | -1) => {
    const n = matches.length;
    const at = sel ?? (step > 0 ? -1 : n);
    for (let i = 1; i <= n; i++) {
      const j = (((at + step * i) % n) + n) % n;
      if (!matches[j].in_worktree) return setActive(j);
    }
  };
  const input = useRef<HTMLInputElement>(null);
  const baseField = useRef<HTMLInputElement>(null);
  const back = useRef<Element | null>(document.activeElement);
  // The card follows its button when the window resizes. The button is drawn only while its row is hovered or has focus
  // inside (not while this dialog has focus), so the always-drawn row is read and the button moves with it.
  const [at, setAt] = useState(anchor);
  useEffect(() => {
    const row = anchor && back.current?.parentElement;
    if (!row) return;
    const start = row.getBoundingClientRect();
    const follow = () => {
      const r = row.getBoundingClientRect();
      const [dx, dy] = [r.left - start.left, r.top - start.top];
      setAt({ top: anchor.top + dy, bottom: anchor.bottom + dy, left: anchor.left + dx, right: anchor.right + dx });
    };
    window.addEventListener('resize', follow);
    return () => window.removeEventListener('resize', follow);
    // Read once at open: the anchor and opener do not change while the card is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    input.current?.focus();
    const prev = back.current as HTMLElement | null;
    return () => {
      // A head's worktree button is drawn only while its row is hovered or has focus inside: a drawn control of that
      // row takes focus first, so the button is drawn again and can take it back.
      if (prev && !prev.getClientRects().length) [...(prev.parentElement?.querySelectorAll('button') ?? [])].find((b) => b.getClientRects().length)?.focus();
      prev?.focus?.();
    };
  }, []);
  // 467: Advanced opened by a remembered choice keeps focus in the name field; only opening it by hand moves to Base.
  const advancedAtOpen = useRef(advanced);
  useEffect(() => void (advanced && !advancedAtOpen.current && baseField.current?.focus()), [advanced]);
  // Ticket 294 (1): a click outside the card, or Esc after focus left it, closes it; never while a start is in flight (the setup wait excepted, see `close`). The
  // opener's own press is left to it (it only asks for the card again). The card's own Esc (field list, Esc in a field) is
  // handled first and marks the event, so it does not close twice.
  useEffect(() => {
    const opener = back.current === document.body ? null : back.current;
    const away = (e: PointerEvent) => !card.current?.contains(e.target as Node) && !opener?.contains?.(e.target as Node) && close.current();
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && !e.defaultPrevented && !e.isComposing && close.current();
    document.addEventListener('pointerdown', away, true);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('pointerdown', away, true);
      document.removeEventListener('keydown', esc);
    };
  }, []);
  const key = (e: ReactKey) => {
    if (typing(e)) return;
    const inField = e.target === input.current;
    const inBase = e.target === baseField.current;
    if (baseShown && inBase && e.key === 'Escape') (e.preventDefault(), setBaseOpen(false));
    else if (baseShown && inBase && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      const n = baseMatches.length;
      setBaseActive(((baseSel ?? 0) + (e.key === 'ArrowDown' ? 1 : n - 1)) % n);
    } else if (shown && inField && e.key === 'Escape') (e.preventDefault(), setListOpen(false));
    else if (shown && inField && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) (e.preventDefault(), move(e.key === 'ArrowDown' ? 1 : -1));
    else if (chosen && inField && e.key === 'Enter' && !e.altKey) (e.preventDefault(), void submit(chosen));
    else if (e.key === 'Escape' && (!flight.current || gating)) (e.preventDefault(), cancel());
    else if (e.key === 'Tab') {
      const fields = [...e.currentTarget.querySelectorAll<HTMLElement>('input:not(:disabled),button:not(:disabled),textarea:not(:disabled)')];
      const index = fields.indexOf(document.activeElement as HTMLElement);
      e.preventDefault();
      fields[(index + (e.shiftKey ? -1 : 1) + fields.length) % fields.length]?.focus();
    } else if (e.key === 'Enter' && e.altKey && !advanced) (e.preventDefault(), setAdvanced(true));
    else if (e.key === 'Enter' && e.target instanceof HTMLInputElement) {
      e.preventDefault();
      if (e.target.type !== 'checkbox' && e.target.type !== 'radio') void submit();
    }
  };
  const field = PLAIN;
  return (
    <div
      ref={card}
      className={`palette gname wtdlg wtnew${at ? ' anchored' : ''}`}
      style={at && ({ '--wt-top': `${Math.round(at.bottom)}px`, '--wt-left': `${Math.round(at.left)}px` } as CSSProperties)} // whole pixels: the 32 px head's tools can sit on a half pixel
      role="dialog"
      aria-modal="true"
      aria-label={t('dialog.worktree.title')}
      onKeyDown={key}
      // Round 2 (F1): while the base list is open, a press on a button, box or radio keeps focus in the base field, so
      // the list does not fold away and move the control from under the pointer before the click lands. A text field
      // still takes focus (the blur then fills the base field).
      onMouseDown={(e) => {
        const el = e.target as HTMLElement;
        if (baseShown && !el.closest('.wtrefs') && el !== baseField.current && !el.closest('textarea, input[type="text"], input:not([type])')) e.preventDefault();
      }}
      aria-busy={busy}
    >
      <div className="wtfld">
        <input {...PLAIN} disabled={busy || !!created} ref={input} aria-label={t('dialog.worktree.nameLabel')} placeholder={t('dialog.worktree.placeholder', { project: basename(project) })} maxLength={2048} value={from} onChange={(e) => (setFrom(e.target.value), setActive(null), setListOpen(true))} aria-controls={shown ? listId : undefined} aria-activedescendant={sel === null ? undefined : `${listId}-${sel}`} {...field} />
      </div>
      {shown && (
        <ul className="wtrefs" id={listId} role="listbox" aria-label={t('dialog.worktree.branches')}>
          {matches.map((r, i) => (
            <li key={`${r.remote}:${r.name}`} id={`${listId}-${i}`} role="option" aria-selected={i === sel} aria-disabled={r.in_worktree} title={r.name} onMouseDown={(e) => e.preventDefault()} onClick={() => !r.in_worktree && void submit(r)}>
              <span className="wtrefname">{r === offered ? t('dialog.worktree.useExisting', { name: r.name }) : r.name}</span>
              {r.in_worktree && <span className="wttag">{t('dialog.worktree.inWorktree')}</span>}
            </li>
          ))}
        </ul>
      )}
      <p className="wthint wtpreview" role="status" aria-live="polite">
        {chosen ? t('dialog.worktree.previewExisting', { name: chosen.name }) : preview ? <>{t('dialog.worktree.previewCreates')} <code>{preview}</code> {t('dialog.worktree.previewFrom', { base: previewBase })}{fetchedFirst && <> {t('wtbase.fetchedFirst')}</>}{isPr && <> · {t('dialog.worktree.previewPr')}</>}</> : t('dialog.worktree.previewAuto')}
      </p>
      <p className="wthint wthintrow">
        <button type="button" className="wtadvanced" aria-expanded={advanced} onClick={() => setAdvanced(true)}>
          <span className="wtkbd">⌥↵</span> {t('dialog.worktree.hintAdvancedOpen')}
        </button>
        {/* Ticket 294 (1): Cancel is always there, on the hint's line so the card keeps its height (the start-agent part has its own beside Create and start). */}
        {!(advanced && startAgent) && (
          <button className="wtcancel" type="button" disabled={busy && !gating} onClick={cancel}>{t('dialog.cancel')}</button>
        )}
      </p>
      {advanced && (
        <>
          <div className="wtfld">
            <input {...PLAIN}
              disabled={busy || !!created}
              ref={baseField}
              aria-label={t('dialog.worktree.base')}
              placeholder={t(defaultBase ? 'wtbase.basePlaceholder' : 'dialog.worktree.basePlaceholder')}
              value={base}
              onChange={(e) => (setBase(e.target.value), setBaseActive(null), setBaseOpen(true), setBaseError(''))}
              // Round 2 (F1): what the preview named is the base. Leaving the field (Tab, or a press on Create and start)
              // with a branch highlighted fills the field with it; Esc closed the list first when the typed text is meant.
              onBlur={() => (baseChosen && setBase(baseChosen.name), setBaseOpen(false))}
              aria-controls={baseShown ? baseListId : undefined}
              aria-activedescendant={baseSel === null ? undefined : `${baseListId}-${baseSel}`}
              aria-invalid={!!baseError || undefined}
              aria-describedby={baseError ? baseErrorId : undefined}
              {...field}
            />
          </div>
          {baseShown && (
            <ul className="wtrefs" id={baseListId} role="listbox" aria-label={t('dialog.worktree.branches')}>
              {baseMatches.map((r, i) => (
                <li key={`${r.remote}:${r.name}`} id={`${baseListId}-${i}`} role="option" aria-selected={i === baseSel} title={r.name} onMouseDown={(e) => e.preventDefault()} onClick={() => (setBase(r.name), setBaseOpen(false), setBaseError(''))}>
                  <span className="wtrefname">{r.name}</span>
                  {r.in_worktree && <span className="wttag">{t('dialog.worktree.inWorktree')}</span>}
                </li>
              ))}
            </ul>
          )}
          {baseError && <p className="conflict wtbaseerr" id={baseErrorId} role="alert">{baseError}</p>}
          <div className="wtfld">
            <input {...PLAIN} disabled={busy || !!created} aria-label={t('dialog.worktree.branch')} placeholder={t('dialog.worktree.branchPlaceholder')} value={branch} onChange={(e) => setBranch(e.target.value)} {...field} />
          </div>
          {agents.length > 0 ? <label className="wtstart"><input type="checkbox" checked={startAgent} disabled={busy || !!created} onChange={e => setStartAgent(e.target.checked)} /> {t('dialog.worktree.startAgent')}</label> : <div className="wtstart">{t('providersManage.allOff')}</div>}
          {startAgent && <div className="wtstartfields">
            <fieldset disabled={busy || !!created}>
              <legend>{t('dialog.worktree.agent')}</legend>
              {agents.map(agent => <label key={agent}><input type="radio" name="wt-agent" checked={kind === agent} onChange={() => { setKind(agent); setModel(null); setModelOpen(false); }} /> {agent === 'claude' ? 'Claude' : 'Codex'}</label>)}
            </fieldset>
            <button ref={modelButton} className="btn" disabled={busy || !!created} type="button" aria-label={t('dialog.worktree.model')} aria-haspopup="listbox" aria-expanded={modelOpen} onClick={() => setModelOpen(!modelOpen)}>{t('dialog.worktree.model')} · {modelOptions.find(m => m.value === model)?.label}</button>
            {modelOpen && <div className="wtmodels" role="listbox" aria-label={t('dialog.worktree.model')} onKeyDown={e => {
              if (e.key === 'Escape') { e.stopPropagation(); setModelOpen(false); modelButton.current?.focus(); }
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                const buttons = [...e.currentTarget.querySelectorAll('button')];
                const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
                buttons[(at + (e.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length]?.focus();
              }
            }}>{modelOptions.filter(m => !isOff(off, kind, m.value)).map(m => <button type="button" role="option" aria-selected={model === m.value} className="btn" key={m.value ?? ''} onClick={() => { setModel(m.value); setModelOpen(false); modelButton.current?.focus(); }}>{m.label}</button>)}</div>}
            {choices.length >= 2 && <fieldset disabled={busy || !!created}>
              <legend>{t('dialog.worktree.account')}</legend>
              {choices.map(a => <label key={a.id}><input type="radio" name="wt-account" checked={account === (a.default ? null : a.label)} onChange={() => setPicked({ kind, label: a.default ? null : a.label })} /> {a.label}</label>)}
            </fieldset>}
            <label className="wtfld">{t('dialog.worktree.prompt')}<textarea {...PLAIN} aria-label={t('dialog.worktree.prompt')} disabled={busy || uncertain} value={prompt} onChange={e => setPrompt(e.target.value)} maxLength={65536} rows={3} /></label>
            {error && (
              <div className="conflict" role="alert">
                {error}
                <ErrorDetails t={t} details={details} />
              </div>
            )}
            {created && <p className="wthint">{t('dialog.worktree.kept', { name: created.branch })}</p>}
            <div className="wtstartacts">
              <button className="btn" type="button" disabled={busy && !gating} onClick={cancel}>{t('dialog.cancel')}</button>
              <button className="btn" type="button" disabled={busy || uncertain} onClick={() => void submit()}>{t(busy ? 'dialog.worktree.starting' : created ? 'dialog.worktree.retryStart' : 'dialog.worktree.createStart')}</button>
            </div>
          </div>}
        </>
      )}
    </div>
  );
}

/** A remove that asks: what it costs, Cancel first (default focus); the only other action goes ahead. Focus stays inside.
 *  Look 1117 v11 A S3-2: the Remove-project dialog's centred sheet, so one kind of question has one look. */
function RemoveSheet({ t, title, action, onAct, onClose, children }: { t: T; title: string; action: string; onAct: () => void; onClose: () => void; children: ReactNode }) {
  const [busy, setBusy] = useState(false);
  return (
    <AlertSheet label={title} className="wtdirty" onClose={onClose}>
      <div className="wtlist">{children}</div>
      <p className="rmacts">
        <button className="btn" onClick={onClose}>
          {t('dialog.cancel')}
        </button>
        <button className="btn x" disabled={busy} onClick={() => (setBusy(true), onAct())}>
          {action}
        </button>
      </p>
    </AlertSheet>
  );
}

/** Ticket 991 A3: the running sessions a remove would stop, named. */
function LiveSheet({ t, ask, onStop, onClose }: { t: T; ask: Extract<Ask, { kind: 'live' }>; onStop: () => void; onClose: () => void }) {
  return (
    <RemoveSheet t={t} title={t('dialog.stopRemove.title', { name: ask.name })} action={plural(t, 'dialog.stopRemove.action', ask.live.length)} onAct={onStop} onClose={onClose}>
      <section aria-label={t('dialog.stopRemove.label')}>
        <p className="wtcap">{t('dialog.stopRemove.label')}</p>
        <ul>
          {ask.live.map((s) => (
            <li key={s.id}>{s.name}</li>
          ))}
        </ul>
      </section>
    </RemoveSheet>
  );
}

/** A dirty remove: what is lost; the only action discards. */
function DirtySheet({ t, ask, onDiscard, onClose }: { t: T; ask: Extract<Ask, { kind: 'dirty' }>; onDiscard: () => void; onClose: () => void }) {
  const { uncommitted, unpushed, uncommitted_total: files, unpushed_total: commits, kept_on, ignored, ignored_total: hidden } = ask.loss;
  const more = (shown: number, total: number) => total > shown && <li className="dim">{t('dialog.discard.more', { n: total - shown })}</li>;
  return (
    <RemoveSheet t={t} title={t('dialog.discard.title', { name: ask.name })} action={t('dialog.discard.action')} onAct={onDiscard} onClose={onClose}>
      {files > 0 && (
        <section aria-label={t('dialog.discard.lostLabel')}>
          {/* Coordinator 11-11: a change too large to read whole is counted (at least), never listed. */}
          {ask.loss.too_large ? (
            <p className="wtcap">{t('dialog.discard.tooLarge', { n: files })}</p>
          ) : (
            <>
              <p className="wtcap">{plural(t, 'dialog.discard.lost', files)}</p>
              <ul>
                {uncommitted.map((f) => (
                  <li key={f}>{f}</li>
                ))}
                {more(uncommitted.length, files)}
              </ul>
            </>
          )}
        </section>
      )}
      {hidden > 0 && (
        <section aria-label={t('dialog.discard.ignoredLabel')}>
          <p className="wtcap">{plural(t, 'dialog.discard.ignored', hidden)}</p>
          <ul>
            {ignored.map((f) => (
              <li key={f}>{f}</li>
            ))}
            {more(ignored.length, hidden)}
          </ul>
        </section>
      )}
      {/* Ticket 253: a shared link is listed, not lost: the project keeps its file. */}
      {!!ask.loss.linked?.length && (
        <section aria-label={t('wtFiles.linkedLabel')}>
          <p className="wtcap">{t('wtFiles.linked')}</p>
          <ul>
            {ask.loss.linked.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        </section>
      )}
      {commits > 0 && (
        <section aria-label={t('dialog.discard.unpushedLabel')}>
          <p className="wtcap">{kept_on ? t(commits === 1 ? 'dialog.discard.unpushedOn.one' : 'dialog.discard.unpushedOn.other', { branch: kept_on, n: commits }) : plural(t, 'dialog.discard.detached', commits)}</p>
          <ul>
            {unpushed.map((c) => (
              <li key={c}>{c}</li>
            ))}
            {more(unpushed.length, commits)}
          </ul>
        </section>
      )}
    </RemoveSheet>
  );
}

/** The one toast: announced, Undo by button or Cmd+Z while it shows. */
function ToastView({ t, toast, onUndo, onDismiss }: { t: T; toast: Toast | null; onUndo: () => void; onDismiss: () => void }) {
  useEffect(() => {
    if (!toast?.undo) return;
    const z = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.code !== 'KeyZ' || !e.metaKey || e.shiftKey || e.altKey || e.ctrlKey) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest('input, textarea, [contenteditable], .xterm')) return; // their own undo
      e.preventDefault();
      onUndo();
    };
    window.addEventListener('keydown', z);
    return () => window.removeEventListener('keydown', z);
  }, [toast, onUndo]);
  return (
    <div role="status" aria-live="polite" className="wtoast" style={{ position: 'fixed', left: '50%', bottom: 16, transform: 'translateX(-50%)', zIndex: 30 }}>
      {toast && (
        <span className="wtbar glass">
          <span className="wtmsg">
            {toast.text}
            <ErrorDetails t={t} details={toast.details} />
          </span>
          {toast.undo && (
            <button className="wtundo" onClick={onUndo}>
              {t('dialog.undo')}
            </button>
          )}
          <button className="wtdismiss" aria-label={t('tree.dismiss')} onClick={onDismiss}>
            ×
          </button>
        </span>
      )}
    </div>
  );
}

export function WorktreeLayer({ wt, t = enT }: { wt: Worktrees; t?: T }) {
  const ask = wt.ask;
  return (
    <>
      {ask?.kind === 'create' && <CreateDialog t={t} project={ask.project} anchor={ask.anchor} wt={wt} onClose={() => wt.setAsk(null)} />}
 {/* Keyed on the loss: a changed list is a new sheet, with Cancel focused again. */}
      {ask?.kind === 'live' && <LiveSheet key={ask.path} t={t} ask={ask} onStop={() => void wt.stopAndRemove(ask.path, ask.live.map((s) => s.id))} onClose={() => wt.setAsk(null)} />}
      {ask?.kind === 'dirty' && <DirtySheet key={JSON.stringify(ask.loss)} t={t} ask={ask} onDiscard={() => wt.remove(ask.path, ask.loss)} onClose={() => wt.setAsk(null)} />}
      {ask?.kind === 'tidy' && <TidyPanel t={t} list={wt.list} facts={wt.facts} sessions={wt.sessions} project={ask.project} onRemove={wt.tidy} onResolve={(path) => wt.remove(path)} onOpen={(path) => void wt.open(path)} onClose={() => wt.setAsk(null)} />}
      <ToastView t={t} toast={wt.toast} onUndo={wt.undo} onDismiss={wt.dismiss} />
    </>
  );
}

/** The palette's worktree commands; the row ones act on the selected worktree row, else the active session's. */
export function worktreeCommands(wt: Worktrees, current: Session | null, firstProject: string | null, t: T = enT): Command[] {
  const path = wt.selected ?? current?.cwd ?? null;
  const l = path ? wt.list.find((x) => x.path === path) : undefined;
  const project = l?.project ?? current?.project ?? firstProject;
  // The menu says what Remove will ask about (mockup 05: "Remove worktree…").
  const changes = (l?.facts?.uncommitted ?? 0) + (l?.facts?.unpushed ?? 0);
  const isDone = (s: Session) => s.state === 'closed' || agentState(s) === 'exited' || wt.settled.has(s.id);
  const canSettle = (s: Session | null | undefined) => !!s && !isDone(s) && !s.attention.working && !s.attention.waiting;
  // Eighth look (A): an item with nothing to do on a row stays in the menu, drawn off, and says why (the one rule of the
  // row menu, the tab menu and the palette).
  // Look 1117 v11 (v10 N4): the palette's greyed worktree rows say why too, not "Not available here".
  const noWt = t('palette.why.noWorktree');
  const noSession = t('palette.why.noSession');
  const wtWhy = l?.missing ? t('palette.why.worktreeGone') : noWt;
  const wtAgent = !!project && !current?.machine && !(current && project === current.project && noCheckout(current));
  const sOf = (id?: string) => (id ? wt.sessions.find((x) => x.id === id) : current);
  const local = (s: Session | null | undefined) => !!s && !s.machine;
  const edPath = l && !l.missing ? l.path : current && !current.machine && path === current.cwd ? current.cwd : null;
  const settleWhy = (s: Session | null | undefined) => (!s || canSettle(s) ? undefined : t(isDone(s) ? 'look8.settleWhy.done' : 'look8.settleWhy.busy'));
  return [
    { id: 'worktree.create', title: t('dialog.worktree.cmd.new'), enabled: !!project, why: t('palette.why.noProject'), run: () => project && wt.setAsk({ kind: 'create', project }) },
    // Ticket 1130 C2: one chord, an agent in a new worktree. Off where no worktree can be made: no project, another
    // machine, or a folder under no repository (Home).
    { id: 'session.new.worktree', title: t('firstUse.cmd.worktreeAgent'), enabled: wtAgent, why: project ? t('firstUse.why.noRepo') : t('palette.why.noProject'), run: () => void (wtAgent && project && wt.startNew(project)) },
    { id: 'worktree.tidy', title: t('dialog.worktree.cmd.tidy'), run: () => wt.setAsk({ kind: 'tidy', project: project ?? null }) },
    { id: 'worktree.open', title: t('dialog.worktree.cmd.open'), enabled: !!l && !l.missing, why: wtWhy, run: () => l && void wt.open(l.path) },
    // "Hand to a bot…": the row's worktree goes to a bot the owner picks (bots/HandBot.tsx).
    { id: 'worktree.hand', title: t('bots.hand.cmd'), enabled: !!l && !l.missing, why: wtWhy, run: () => l && !l.missing && askHand(l.path) },
    { id: 'worktree.copy-path', title: t('dialog.worktree.cmd.copyPath'), enabled: !!l, why: noWt, run: () => l && void copyText(l.path) },
    { id: 'worktree.reveal', title: t('dialog.worktree.cmd.reveal'), enabled: !!l && !l.missing && '__TAURI_INTERNALS__' in window, why: l ? (l.missing ? wtWhy : undefined) : noWt, run: () => l && void import('@tauri-apps/plugin-opener').then((o) => o.revealItemInDir(l.path)).catch(() => {}) },
    // Ticket 375: the row's own folder (never the main checkout), in the editor chosen in Settings; never on another machine.
    { id: 'worktree.open-editor', title: t('files.openEditor'), enabled: !!edPath, why: wtWhy, enabledFor: ({ session }) => (session ? local(sOf(session)) : !!edPath), whyFor: ({ session }) => (session && sOf(session)?.machine ? t('files.editorRemote') : wtWhy), run: () => edPath && wt.editor(edPath) },
    { id: 'worktree.rename', title: t('dialog.worktree.cmd.rename'), enabled: !!l, why: noWt, run: () => l && wt.setRenaming(l.path) },
    // V2.5-55 (needs 178 B1): a main-folder session row's own items; they act on the active session (the menu makes the row's one active).
    { id: 'session.rename', title: t('tree.cmd.renameRow'), enabled: !!current, why: noSession, run: () => current && wt.setRenamingSession(current.id) },
    { id: 'session.copy-path', title: t('tree.cmd.copyPath'), enabled: !!current, why: noSession, run: () => current && void copyText(current.cwd) },
    // A row's menu reads `enabledFor` (ContextMenu ignores `enabled` on a session row): a session on another machine stays off.
    { id: 'session.open-editor', title: t('tree.cmd.openEditor'), enabled: !!current && !current.machine, why: current?.machine ? t('files.editorRemote') : noSession, enabledFor: ({ session }) => local(sOf(session)), whyFor: ({ session }) => (sOf(session)?.machine ? t('files.editorRemote') : noSession), run: () => current && !current.machine && wt.editor(current.cwd) },
    // Q7 point 4: a finished turn is put away; opening it from the menu or palette already marks it seen.
    // Seventh look (A S3-4, S3-8): the move says what it did and offers Undo, as Close session does; a row already under
    // "N done" (settled, or its agent ended) does not offer it again (a row's menu reads `enabledFor`).
    { id: 'session.settle', title: t('tree.cmd.settle'), enabled: canSettle(current), why: settleWhy(current), whyFor: ({ session }) => settleWhy(session ? wt.sessions.find((x) => x.id === session) : current), enabledFor: ({ session }) => canSettle(session ? wt.sessions.find((x) => x.id === session) : current), run: () => canSettle(current) && current && (wt.settle(current.id), pushUndo({ label: t('tree.settled', { name: sessionName(current) }), undo: () => wt.unsettle(current.id) })) },
    { id: 'worktree.remove', title: changes ? plural(t, 'dialog.worktree.cmd.removeAsks', changes) : t('dialog.worktree.cmd.remove'), enabled: !!l, why: noWt, run: () => l && wt.remove(l.path) },
  ];
}

/** The inline label editor in a worktree row: Enter saves, Esc cancels; the branch and folder are not renamed. The
 * row it replaces takes focus back (the caller's `onClose`). */
export function RenameField({ initial, onSave, onClose, t = enT, field = t('dialog.worktree.labelField'), hint = t('dialog.worktree.labelHint') }: { t?: T; initial: string; onSave: (label: string) => Promise<string | null>; onClose: () => void; field?: string; hint?: string }) {
  const [v, setV] = useState(initial);
  const [err, setErr] = useState('');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  return (
    <span className="row wt2 idle wtrename">
      <input {...PLAIN}
        ref={input}
        className="n"
        aria-label={field}
        aria-invalid={err ? true : undefined}
        title={err || hint}
        maxLength={256}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        value={v}
        onChange={(e) => (setV(e.target.value), setErr(''))}
        onBlur={onClose}
        onKeyDown={(e) => {
          if (typing(e)) return;
          e.stopPropagation();
          if (e.key === 'Escape') (e.preventDefault(), onClose());
          else if (e.key === 'Enter') {
            e.preventDefault();
            void onSave(v.trim()).then((refused) => (refused ? setErr(refused) : onClose()));
          }
        }}
      />
    </span>
  );
}

const SETTLED_KEY = 'nunchiro.settled.v1';
