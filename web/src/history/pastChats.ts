// Ticket 392: a project's past Claude and Codex conversations found on disk (read-only, needs 137): the core lists only
// transcripts recorded in exactly this folder, and only for a project its tree holds; opening one imports that one id
// (the import gate stays as it is) and opens the existing read-only tab. Round 2 (bounds): one request, one core scan,
// for every local project; asked once the window has drawn.
// Ticket 1073: the tree's "Past conversations" fold is gone; History lists these rows beside the finished sessions.
import { useEffect, useSyncExternalStore } from 'react';
import type { CoreClient } from '../api';
import { openImported } from '../firstrun/imported';

/** `id` is `<agent>:<conversation id>`; the part after the colon is what a session's `agent_session_id` holds. */
export type Past = { id: string; agent: 'claude' | 'codex'; title: string; modified_ms: number; imported: boolean; ran?: boolean };
export const conversationOf = (p: Past) => p.id.slice(p.id.indexOf(':') + 1);
/** `p` is conversation `id`: Claude's file stem is the id; Codex's (`rollout-<time>-<uuid>`) ends with it. */
export const isConversation = (p: Past, ids: ReadonlySet<string>) => {
  const c = conversationOf(p);
  return ids.has(c) || (c.length > 36 && ids.has(c.slice(-36)));
};
/** Ticket 1073: every `agent_session_id` a snapshot of this window showed. A closed session leaves the snapshot, and the
 *  listing fetched before its close still has its conversation unmarked: this keeps it Nunchiro's in this window. */
export const seenRan = new Set<string>();

const MAX_PROJECTS = 200; // the core's cap on one listing

// One store for the window: the last lists (per project) and at most one ask in flight. A refusal, busy or real, keeps
// the last lists. Ticket 402: `answered` is the set and connection of the last answer; the set is asked again when it
// changes or a new connection has drawn.
let lists: Record<string, Past[]> = {};
let answered: { key: string; on: number } | null = null;
let flying = false;
let next: { core: CoreClient; projects: string[] } | null = null; // the newest wanted set
let version = 0;
const subs = new Set<() => void>();
const subscribe = (f: () => void) => (subs.add(f), () => void subs.delete(f));

function pump() {
  if (flying || !next) return;
  const { core, projects } = next;
  const key = projects.join('\n');
  // Not in the connect burst: only once this connection's first snapshot is drawn.
  if (!core.snapped || core.snapped !== core.opened) return;
  if (answered?.key === key && answered.on === core.snapped) return;
  const on = core.snapped;
  flying = true;
  core
    .request({ op: 'import_list', projects })
    .then(
      (r) => void (lists = (r as { projects: Record<string, Past[]> }).projects),
      () => {},
    )
    .finally(() => {
      answered = { key, on };
      flying = false;
      version++;
      for (const f of subs) f();
      pump(); // the newest wanted set, if it changed while this one was asked
    });
}

/** The on-disk conversations of `projects` (this Mac's), by project; asked again when the set or the connection changes. */
export function usePastChats(core: CoreClient, projects: string[]) {
  // shortcut: past MAX_PROJECTS local projects the rest are not asked; page the ask if a tree ever holds that many.
  const key = [...new Set(projects)].sort().slice(0, MAX_PROJECTS).join('\n');
  useSyncExternalStore(subscribe, () => version);
  useEffect(() => void ((next = { core, projects: key ? key.split('\n') : [] }), pump()), [core, key, core.snapped]); // eslint-disable-line react-hooks/exhaustive-deps
  return lists;
}

/** Imports `p` once (the gate stays as it is), then opens its read-only tab. Throws what the core refused. */
export async function openPast(core: CoreClient, p: Past) {
  if (!p.imported) {
    await core.request({ op: 'import_add', ids: [p.id] });
    p.imported = true;
  }
  openImported(p.id, p.title);
}
