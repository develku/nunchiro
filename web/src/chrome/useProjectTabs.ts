// Ticket 570: tabs belong to the selected project (herdr, Orca). `tabs` stays one flat list and every tab stays mounted, so a
// terminal keeps running while its project is not shown (Orca's store keeps a tab list and an active tab per worktree, and keeps
// the other worktrees' terminals alive in the same way). This derives the tabs the strip shows, remembers each project's own
// active tab, and switches projects.
import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { fileOfTab } from '../files/open';
import { isImportedTab } from '../firstrun/imported';
import { isRoomTab, roomOfTab } from '../room/room';
import { isAccountTab } from '../tree';
import type { Session } from '../types';

type Saved = { selected: string | null; activeBy: Record<string, string>; tabProj: Record<string, string> };

/** An account's Login or Logout tab runs in the account folder, which is never a tree project (tree.ts isAccountTab): left
 *  there, its tab could not be reached, so it is a tab of no project, as an imported chat. */
const accountTab = (id: string, byId: Map<string, Session>) => ((s) => !!s && isAccountTab(s))(byId.get(id));

/** A session tab is in its session's project, a file tab in its session's. Anything else (an imported chat, an account's login
 *  tab) is in the project recorded when it opened, or in none yet. */
export const projectOf = (id: string, byId: Map<string, Session>, tabProj: Record<string, string>): string | null =>
  roomOfTab(id) ?? // ticket 571: a project's Room tab is its project's
  (accountTab(id, byId)
    ? (tabProj[id] !== byId.get(id)!.project && tabProj[id]) || null // ticket 774: a state saved before ticket 720 filed it under its account folder
    : ((byId.get(id) ?? byId.get(fileOfTab(id)?.root ?? ''))?.project ?? tabProj[id] ?? null));

export function useProjectTabs({ tabs, active, setActive, byId, projects, ready, saved }: { tabs: string[]; active: string | null; setActive: Dispatch<SetStateAction<string | null>>; byId: Map<string, Session>; projects: string[]; ready: boolean; saved: Saved | null }) {
  const [selected, setSelected] = useState<string | null>(saved?.selected ?? null);
  const [activeBy, setActiveBy] = useState<Record<string, string>>(saved?.activeBy ?? {});
  const [tabProj, setTabProj] = useState<Record<string, string>>(saved?.tabProj ?? {});
  const of = useCallback((id: string) => projectOf(id, byId, tabProj), [byId, tabProj]);
  // A tab of no project yet is shown with the selected one until the snapshot says otherwise.
  const visible = useMemo(() => tabs.filter((id) => ((p) => p === null || p === selected)(of(id))), [tabs, selected, of]);
  // The shown tab decides the project (a notification, a decision jump, the tree and a new session all just set `active`).
  const p = active ? of(active) : null;
  useEffect(() => {
    if (p && p !== selected) setSelected(p);
    else if (!selected && !active && ready && projects[0]) setSelected(projects[0]); // a first run, or an old state that held no project
  }, [p, selected, active, ready, projects]);
  useEffect(() => void (active && p && activeBy[p] !== active && setActiveBy((m) => ({ ...m, [p]: active }))), [active, p, activeBy]);
  // After the first snapshot: every tab's project is kept (a restart then shows the right strip before the snapshot arrives), and a
  // file or imported tab with no project of its own goes to the selected one, or to the first project. A session tab the window
  // started a moment ago is not stamped: its session is not in the snapshot yet, and the snapshot will give it its own project.
  useEffect(() => {
    const home = selected ?? projects[0];
    if (!ready) return;
    const next = Object.fromEntries(tabs.flatMap((id) => ((p) => (p ? [[id, p]] : []))(of(id) ?? (fileOfTab(id) || isImportedTab(id) || accountTab(id, byId) ? home : null))));
    if (JSON.stringify(next) !== JSON.stringify(tabProj)) setTabProj(next);
  }, [tabs, ready, selected, projects, of, tabProj, byId]);
  // The palette's command list is memoised, so `select` reads the tabs as they are now.
  const now = useRef({ tabs, of, activeBy });
  now.current = { tabs, of, activeBy };
  /** Shows a project and restores the tab it had open (none, when it has no tab). Returns whether it had one. */
  const select = useCallback(
    (project: string) => {
      const { tabs, of, activeBy } = now.current;
      const mine = tabs.filter((id) => of(id) === project);
      setSelected(project);
      setActive(mine.length ? (activeBy[project] && (mine.includes(activeBy[project]) || isRoomTab(activeBy[project])) ? activeBy[project] : mine[0]) : null);
      return mine.length > 0;
    },
    [setActive],
  );
  return { selected, visible, activeBy, tabProj, select, projectOf: of };
}
