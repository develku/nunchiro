// Ticket 373: the Diff header's one git button. Nothing runs until it is pressed; a press sends one fixed prompt to the
// session's agent through `agent_prompt`, and the agent does the git work (the app adds no commit, push or PR op).
//
// `ladder` is ported from T3 Code's resolveQuickAction (apps/web/src/components/GitActionsControl.logic.ts:187-337,
// MIT, Copyright (c) 2026 T3 Tools Inc.): T3's rungs and hints, with each run_action kind turned into a fixed prompt.
// Not ported: T3's dialog, file exclusion, message field and "Publish repository" (no remote is a disabled reason
// here). T3's default-branch confirmation (:339) is a disabled reason here too: one press must never push to it.
// Disabled reasons for the session (shell, agent not running, blocked, working) follow Orca's
// src/shared/source-control-primary-action-decision.ts:21 (behaviour only).
import type { Key } from '../i18n';
import type { Session } from '../types';

/** Mirrors crates/nunchiro-core/src/diff/mod.rs `GitFacts`. */
export type GitFacts = {
  branch: string | null;
  dirty: boolean;
  upstream: boolean;
  ahead: number;
  behind: number;
  ahead_of_default: number | null;
  is_default: boolean;
  has_remote: boolean;
  /** Ticket 393: an upstream is set but cannot be read as an exact ref: no push or PR, a commit still. */
  upstream_unknown: boolean;
  gh: boolean;
  /** The commit HEAD names; the Push strip shows it and sends it back (git_write.rs). Absent from an older core. */
  head?: string | null;
  /** Where the app's Push sends the branch; null with `push_why` saying why there is none. */
  push_to?: PushTo | null;
  push_why?: string | null;
};
/** Mirrors crates/nunchiro-core/src/git_write.rs `PushTo`. */
export type PushTo = { remote: string; branch: string; ahead: number; upstream: boolean; key: string };

/** What a press asks for; `null` sends nothing. */
export type Ask = 'commit' | 'commit_push' | 'commit_push_pr' | 'push' | 'push_pr' | 'create_pr' | 'pull';
export type Action = { label: Key; ask: Ask | null; why?: Key };

const PROMPT: Record<Ask, Key> = {
  commit: 'gitActions.prompt.commit',
  commit_push: 'gitActions.prompt.commitPush',
  commit_push_pr: 'gitActions.prompt.commitPushPr',
  push: 'gitActions.prompt.push',
  push_pr: 'gitActions.prompt.pushPr',
  create_pr: 'gitActions.prompt.createPr',
  pull: 'gitActions.prompt.pull',
};
export const promptKey = (ask: Ask): Key => PROMPT[ask];

const off = (label: Key, why: Key): Action => ({ label, ask: null, why });
const COMMIT: Key = 'gitActions.label.commit';

/** T3's ladder over the folder's git state; `openPr`: the app knows of an open PR for this session. */
export function ladder(g: GitFacts, openPr: boolean): Action {
  if (g.branch === null) return off(COMMIT, 'gitActions.why.detached');
  // Ticket 393: where a push lands is unknown, so only what needs no upstream is offered.
  if (g.upstream_unknown) return g.dirty ? { label: COMMIT, ask: 'commit', why: 'gitActions.why.unknown' } : off('gitActions.label.push', 'gitActions.why.unknown');
  // With no upstream (an app worktree starts from a sha), local commits count against the default branch.
  const isAhead = (g.upstream ? g.ahead : g.ahead_of_default ?? 0) > 0;
  const isBehind = g.behind > 0;
  // A PR needs gh (option A): the rung stops short of it and says why.
  const noGh = (a: Action, short: Action): Action => (g.gh ? a : { ...short, why: 'gitActions.why.noGh' });
  if (g.dirty) {
    if (!g.upstream && !g.has_remote) return { label: COMMIT, ask: 'commit' };
    if (openPr) return { label: 'gitActions.label.commitPush', ask: 'commit_push' };
    return noGh({ label: 'gitActions.label.commitPushPr', ask: 'commit_push_pr' }, { label: 'gitActions.label.commitPush', ask: 'commit_push' });
  }
  if (!g.upstream) {
    if (!g.has_remote) return off('gitActions.label.push', 'gitActions.why.noRemote');
    if (!isAhead) return openPr ? off(COMMIT, 'gitActions.why.upToDate') : off('gitActions.label.push', 'gitActions.why.noCommits');
    if (openPr) return { label: 'gitActions.label.push', ask: 'push' };
    return noGh({ label: 'gitActions.label.pushPr', ask: 'push_pr' }, { label: 'gitActions.label.push', ask: 'push' });
  }
  if (isAhead && isBehind) return off('gitActions.label.sync', 'gitActions.why.diverged');
  if (isBehind) return { label: 'gitActions.label.pull', ask: 'pull' };
  if (isAhead) {
    if (openPr) return { label: 'gitActions.label.push', ask: 'push' };
    return noGh({ label: 'gitActions.label.pushPr', ask: 'push_pr' }, { label: 'gitActions.label.push', ask: 'push' });
  }
  if (openPr) return off(COMMIT, 'gitActions.why.upToDate');
  if ((g.ahead_of_default ?? 0) > 0) return g.gh ? { label: 'gitActions.label.createPr', ask: 'create_pr' } : off('gitActions.label.createPr', 'gitActions.why.noGh');
  return off(COMMIT, 'gitActions.why.upToDate');
}

/** The asks the app runs itself, behind its own confirm (git_write.rs); every other ask goes to the agent. */
const APP_ASKS: readonly Ask[] = ['push', 'push_pr', 'create_pr'];
/** How a press of an ask both can do goes: the app runs it, or the agent is asked. The last pick is kept. */
export type Way = 'app' | 'agent';
export const WAY_KEY = 'nunchiro.diffGitWay';
export function storedWay(): Way {
  try {
    return localStorage.getItem(WAY_KEY) === 'agent' ? 'agent' : 'app';
  } catch {
    return 'app';
  }
}
export function keepWay(w: Way) {
  try {
    localStorage.setItem(WAY_KEY, w);
  } catch {
    // Per-window convenience only.
  }
}

/** The app's own path: the ladder's rung when the app runs it, else null. The session's state does not matter (no agent
 *  is asked), so it works while the agent works, waits, or in a terminal session; the default branch stays off. */
export function appAction(git: GitFacts | null, openPr: boolean): Action | null {
  if (!git) return null;
  const next = ladder(git, openPr);
  if (!next.ask || !APP_ASKS.includes(next.ask)) return null;
  if (git.is_default) return { label: next.label, ask: null, why: 'gitActions.why.defaultBranch' };
  if (!git.push_to || !git.head) return { label: next.label, ask: null, why: 'gitActions.why.noPushRemote' };
  return next;
}

/** The agent path's label for an ask the app also runs. */
export const ASK_AGENT: Partial<Record<Ask, Key>> = {
  push: 'gitActions.label.askPush',
  push_pr: 'gitActions.label.askPushPr',
  create_pr: 'gitActions.label.askCreatePr',
};

/** A session with an agent that can be asked now or later (not a terminal, not ended). */
export const agentLive = (s: Session) => s.kind !== 'shell' && s.state === 'running' && !s.agent_ended;

/** The button for `s`: the session's own state first, then the default-branch guard, then the ladder. `git` null:
 *  the core could not read git's state. Kinds that do not take a pending answer (core delivery.rs `blocked`). */
export function gitAction(s: Session, git: GitFacts | null, openPr: boolean): Action {
  if (s.kind === 'shell') return off(COMMIT, 'gitActions.why.shell');
  if (s.state !== 'running' || s.agent_ended) return off(COMMIT, 'gitActions.why.notRunning');
  if (s.pending.some((d) => d.kind === 'permission' || d.kind === 'question' || d.kind === 'dialog')) return off(COMMIT, 'gitActions.why.blocked');
  if (!git) return off(COMMIT, 'gitActions.why.unknown');
  const next = ladder(git, openPr);
  // The guard sits after the ladder so the label still says what the state is, and before every send.
  if (git.is_default) return { label: next.label, ask: null, why: 'gitActions.why.defaultBranch' };
  if (s.attention.working) return { label: next.label, ask: null, why: 'gitActions.why.working' };
  return next;
}
