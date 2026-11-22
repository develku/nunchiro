// D5b lane B: nesting a widget under a project as a sub-view. One hook holds the window side of it (the drop, the Tree-icon
// picker, the sub-view rows' toggle and ✕) so App.tsx only wires it in. Every change is a step of the arrange trail.
import { useState, type ReactNode } from 'react';
import { docT } from '../errors';
import type { SubViewsCtx } from '../tree/SubViews';
import { nestUnder, nestKey, refuses, setOpen, unnest, where, WIDGET_LABEL, type Bars } from './bars';
import type { Landing } from './DragLayer';
import { kindOf } from './model';
import { ProjectPicker } from './ProjectPicker';
import type { useArrange } from './useArrange';
import { renderScoped, type WindowCtx } from './windows';

interface In {
  bars: Bars;
  editing: boolean;
  arrange: ReturnType<typeof useArrange>;
  setBars: (f: (b: Bars) => Bars) => void;
  /** The tree's projects: folder path and shown name. */
  projects: { path: string; name: string }[];
  ctx: () => WindowCtx;
}

export function useNest({ bars, editing, arrange, setBars, projects, ctx }: In) {
  const [picking, setPicking] = useState<string | null>(null);
  const nameOf = (path: string) => projects.find((p) => p.path === path)?.name ?? path.split('/').pop() ?? path;

  /** `w` nested under `path`, open; false when it is refused (the reason is a notice, never a step). */
  const add = (w: string, path: string, then: (b: Bars) => Bars = (b) => b) => {
    const reason = refuses(w, 'nest', docT());
    if (reason) return arrange.notify(reason);
    const kind = kindOf(w);
    const next = nestUnder(bars, path, kind);
    if (!next) return arrange.notify(`${WIDGET_LABEL(kind)} is already a view of ${nameOf(path)}`);
    void arrange.commit(`${WIDGET_LABEL(kind)} view added under ${nameOf(path)}`, { bars: then(next) });
  };
  const remove = (path: string, kind: string) => {
    void arrange.commit(`${WIDGET_LABEL(kind)} view removed from ${nameOf(path)}`, { bars: unnest(bars, path, kind) });
  };

  const subviews: SubViewsCtx = {
    nest: bars.nest,
    open: bars.open,
    editing,
    title: WIDGET_LABEL,
    render: (project, kind) => renderScoped(kind, project, ctx()),
    // Opening or folding a view is a view state, not a step of the trail.
    onToggle: (project, kind) => setBars((b) => setOpen(b, project, kind, !b.open[nestKey(project, kind)])),
    onRemove: remove,
  };
  const picker: ReactNode = picking && (
    <ProjectPicker
      title={WIDGET_LABEL(picking)}
      projects={projects}
      onCancel={() => setPicking(null)}
      onPick={(path) => {
        setPicking(null);
        // The pick opens the tree sidebar on the side where the Tree sits.
        add(picking, path, (b) => {
          const side = where(b, 'tree');
          return side ? { ...b, active: { ...b.active, [side]: 'tree' } } : b;
        });
      }}
    />
  );
  /** A drop on a project row (nest) or on the Tree icon (ask which project). */
  const land = (w: string, l: Extract<Landing, { type: 'nest' | 'picker' }>) => (l.type === 'nest' ? add(w, l.path) : setPicking(w));
  return { subviews, picker, land, add };
}
