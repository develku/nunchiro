// needs 171 (ticket 195): drag a project head onto a group head = the "Move to group..." edit (`project_move`), by pointer events
// (like layout/DragLayer.tsx) because native HTML5 drag events can stay silent in WKWebView. Only a project head starts a drag
// and only a group head takes a drop; row order is not draggable (needs 36, 92). Escape, a pointercancel or a drop elsewhere ends
// it with no edit, and nothing moves on screen until the core's snapshot says so.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { push as pushUndo } from '../undo/store';
import type { ProjectTree, T } from './state';

const THRESHOLD = 4; // px: less than this is a click on the head's own buttons
export type ProjectDrag = { name: string; x: number; y: number; over: string | null };

let live: ProjectTree | null = null;
/** The window's newest tree: an Undo runs seconds after the render whose closure made it. */
export const track = (pt: ProjectTree) => void (live = pt);

/**
 * The one move path: "Move to group..." (row menu and palette), "Remove from group" (`to` null) and a drag all send `project_move`
 * and offer the same Undo line. Undoing a move that emptied the old group makes the group again. The Undo puts the project back at its
 * old index in the old group (`project_move.index`); an Undo to no group has no index. A move to its own group appends, so it is a
 * no-op for the group's last project.
 */
export async function moveProject(pt: ProjectTree, t: T, project: string, name: string, to: string | null, onEdit?: () => void) {
  const old = pt.tree.groups.find((g) => g.projects.includes(project));
  const from = old?.name ?? null;
  const at = old?.projects.indexOf(project);
  if (old && to === from && at === old.projects.length - 1) return; // already last in its own group: the append changes nothing, so no edit and no Undo
  const back = async (group: string | null) => {
    onEdit?.();
    const tree = (live ?? pt).tree;
    // Moving a group's last project out drops the empty group in the core: undoing that makes the group again.
    const gone = group !== null && !tree.groups.some((g) => g.name === group);
    const err = await pt.edit(gone ? { op: 'group_create', name: group, project } : { op: 'project_move', project, group, ...(group !== null && { index: at }) });
    if (err !== null) throw new Error(err); // the Undo line says it; the refusal is also in the tree's notice
  };
  onEdit?.(); // the held rows take the user's own edit at once
  if ((await pt.edit({ op: 'project_move', project, group: to })) !== null) return;
  const label = to === null ? t('tree.move.removed', { name, group: from ?? '' }) : t('tree.drag.moved', { name, group: to });
  pushUndo({ label, undo: () => back(from) });
}

export function useProjectDrag(pt: ProjectTree, t: T, onEdit: () => void) {
  const [drag, setDrag] = useState<ProjectDrag | null>(null);
  const now = useRef({ pt, t, onEdit });
  now.current = { pt, t, onEdit };
  track(pt);
  const stop = useRef<(() => void) | null>(null);
  useEffect(() => () => stop.current?.(), []);

  const move = useCallback((project: string, name: string, to: string) => moveProject(now.current.pt, now.current.t, project, name, to, now.current.onEdit), []);

  const start = useCallback(
    (e: ReactPointerEvent, project: string, name: string) => {
      if (e.button !== 0 || !e.isPrimary || (e.target as HTMLElement).closest('input, textarea, select, [contenteditable]')) return;
      const [x0, y0] = [e.clientX, e.clientY];
      let on = false;
      let cancelled = false;
      let over: string | null = null;
      const target = (x: number, y: number) => {
        const g = document.elementFromPoint(x, y)?.closest('.ghead')?.closest<HTMLElement>('.pgrp')?.dataset.group ?? null;
        // Its own group is no target: the drop there would change nothing.
        return g !== null && !now.current.pt.tree.groups.some((m) => m.name === g && m.projects.includes(project)) ? g : null;
      };
      const onMove = (ev: PointerEvent) => {
        if (ev.buttons === 0) return end(); // the release happened outside the window, where no pointerup reaches us: nothing drops
        if (cancelled || (!on && Math.hypot(ev.clientX - x0, ev.clientY - y0) < THRESHOLD)) return;
        if (!on) document.body.classList.add('pdragging');
        on = true;
        over = target(ev.clientX, ev.clientY);
        setDrag({ name, x: ev.clientX, y: ev.clientY, over });
      };
      const end = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onCancel);
        window.removeEventListener('keydown', onKey);
        document.body.classList.remove('pdragging');
        setDrag(null);
        stop.current = null;
      };
      const onUp = () => {
        end();
        if (on) {
          // The release is not a click on the head's name or chevron.
          const swallow = (c: Event) => c.stopPropagation();
          window.addEventListener('click', swallow, { capture: true, once: true });
          window.setTimeout(() => window.removeEventListener('click', swallow, true), 50);
          if (!cancelled && over) void move(project, name, over);
        }
      };
      const onCancel = () => end();
      // Escape ends the drag at once but keeps listening for the release, so that it is swallowed as above.
      const onKey = (ev: KeyboardEvent) => {
        if (ev.key !== 'Escape' || cancelled) return;
        cancelled = true;
        setDrag(null);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onCancel);
      window.addEventListener('keydown', onKey);
      stop.current = end;
    },
    [move],
  );
  return { drag, start };
}
