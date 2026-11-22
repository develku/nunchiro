// v25-shell-chrome (ticket 282 item 2): which sessions "Restart session" (tab menu, palette) applies to and what it starts.
// Ticket 286 item 2 (lane v25-term-lifecycle) reuses this with `useTabs().resume`.
import { canRestart, restartStart } from '../PermissionNeeded';
import type { Session } from '../types';

/** An ended session (exited, closed, resumable after a core restart) that starts again: a shell always, an agent that has a
 *  conversation id (what the old Resume buttons did), else by the rule PermissionNeeded's Restart uses (agent, folder, model, effort).
 *  A side chat is not restarted from here. */
export const restartable = (s: Session) => !s.side_chat && s.state !== 'running' && !s.folder_gone /* look 1117 v10 Home S3-8: no folder to start in */ && (s.kind === 'shell' || !!s.agent_session_id || canRestart(s));

/** The `start` request that restarts `s`: a shell starts fresh in the same folder with the same label; an agent with a
 *  conversation id resumes it (as the Resume buttons did); any other agent as PermissionNeeded restarts it. */
export const restartRequest = (s: Session) =>
  // Ticket 991 (A1): the session's own folder. With the project here, a worktree's shell came back in the main checkout
  // under the worktree's name. The core files a start in a recorded worktree under the worktree's project (ticket 990).
  s.kind === 'shell' ? { kind: s.kind, project: s.cwd, label: s.label, resume: null } : s.agent_session_id ? { ...restartStart(s), resume: s.agent_session_id } : restartStart(s);

/** Look 1117 v7 (S3-2): restarts whose reply has not come yet: the ended session's id and the start it asked for. The
 *  new session can reach the window in a snapshot first; then it is no session "started elsewhere" (its tab would open
 *  at the strip's end beside the old one, and a resumed agent's old tab would go with its row), it is this restart's:
 *  the old tab keeps its slot until the reply puts the new session in it (useTabs `resume`, `bring`). */
export const restarting = new Map<string, { kind: Session['kind']; project: string; label: string; resume: string | null }>();
/** `s` is what a restart in flight asked for: its conversation when it resumes one, else its kind, folder and name. */
export const isRestart = (s: Session) => [...restarting.values()].some((r) => r.kind === s.kind && (r.resume ? r.resume === s.agent_session_id : r.project === s.cwd && r.label === s.label));
