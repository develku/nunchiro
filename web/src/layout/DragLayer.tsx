// Drag from a library card (a widget), a bar icon (`bar`) or a zone's grip (move). Over a bar the drop is an insertion
// line (or a refusal with its reason); over the library's remove area an icon leaves its bar; over a main zone a
// five-way compass (top, left, centre, right, bottom) aims the drop and an outline previews it: it names the result
// (add as a tab; split above, below, left, right; new zone at a window edge) and the sizes after Done
// (no command echo, needs 153). Releasing lands the drop; Escape cancels. Bar and remove-area targets come from bars.ts `targetAt` (A36).
import { useEffect, useLayoutEffect, useState } from 'react';
import type { T } from '../i18n';
import { useHtmlLangT } from '../i18n/lib/useHtmlLangT';
import { zoneLabel } from './LayoutView';
import { PSEUDO, refuses, targetAt, WIDGET_LABEL, type BarDrop, type Side } from './bars';
import { apply, edgeSize, find, isLeaf, kindOf, MIN, minOf, pinOf, TITLE, type Dir, type Item, type Layout, type Measure, type Op } from './model';
import { rawError } from '../errors';

/** `blocked`: a reason the widget cannot be placed anywhere yet (a user widget still waiting for approval, A22). */
export type DragSource = ({ widget: Item } | { from: string; tab: number; widget: Item } | { widget: Item; bar: Side }) & { blocked?: string };
/** What a release does. */
export type Landing = { type: 'zone'; op: Op; error: string | null } | { type: 'bar'; side: Side; index: number } | { type: 'remove' } | { type: 'refuse'; reason: string } | { type: 'nest'; path: string } | { type: 'picker' };

const BAND = 20;
const measureDom: Measure = (id) => {
  const r = document.querySelector(`[data-node-id="${CSS.escape(id)}"]`)?.getBoundingClientRect();
  return r ? { w: r.width, h: r.height } : undefined;
};
export { measureDom };

type Rect = { x: number; y: number; w: number; h: number };
type Drop = { landing: Landing; hot?: Element; hotSel?: string; rect: Rect; what: string; sizes: string; error: string | null; arm?: Dir | 'centre'; caption?: string; ins?: Rect; zone?: Rect };

const box = (r: DOMRect): Rect => ({ x: r.left, y: r.top, w: r.width, h: r.height });
// Ticket 528: captions and preview lines from the catalogue. A zone is named as its header names it (LayoutView `zoneLabel`,
// ticket 511), never by its layout.toml id; the reasons from bars.ts `refuses` and model.ts `apply` are theirs.
const caption = (t: T, d: Dir | 'centre') => t(`leftovers.drag.cap.${d}` as const);

/** A drop on a bar or the remove area (a refusal carries its reason). */
function barHit(t: Exclude<BarDrop, { kind: 'split' }>, src: DragSource, w: T): Drop {
  const rect = box(t.el.getBoundingClientRect());
  const title = TITLE[kindOf(src.widget)] ?? src.widget;
  if (t.kind === 'project' || t.kind === 'tree-icon') {
    // D5b lane B: a project row nests the widget there; the Tree icon asks which project. Only a library card or a bar icon nests.
    const reason = 'from' in src ? w('leftovers.drag.moveFirst') : refuses(src.widget, 'nest', w);
    const landing: Landing = reason ? { type: 'refuse', reason } : t.kind === 'project' ? { type: 'nest', path: t.path } : { type: 'picker' };
    return { landing, rect, what: t.kind === 'project' ? w('leftovers.drag.subView') : w('leftovers.drag.chooseProject'), sizes: '', error: reason, hot: reason ? undefined : t.el, hotSel: t.kind === 'project' ? `[data-project-path="${CSS.escape(t.path)}"]` : undefined };
  }
  if (t.kind === 'remove') {
    // A required widget says why first, wherever it came from (the Tree from its zone too, needs 157 (2)).
    const reason = refuses(src.widget, 'remove', w) ?? ('bar' in src ? null : w('leftovers.drag.onlyBarIcon'));
    return { landing: reason ? { type: 'refuse', reason } : { type: 'remove' }, rect, what: 'bar' in src ? w('leftovers.drag.removeFrom', { name: title }) : w('leftovers.drag.remove'), sizes: '', error: reason };
  }
  const reason = refuses(src.widget, 'bar', w);
  // ICONBAR: the target is the slot under the pointer; the preview is that slot (an occupied one swaps).
  return {
    landing: reason ? { type: 'refuse', reason } : { type: 'bar', side: t.side as Side, index: t.index },
    rect,
    what: w(`leftovers.drag.barSlot.${t.side as Side}` as const, { name: title, n: t.index + 1 }),
    sizes: '',
    error: reason,
    ins: rect,
  };
}

function hit(x: number, y: number, src: DragSource, layout: Layout, t: T): Drop | null {
  const d = hitAt(x, y, src, layout, t);
  if (!d || !src.blocked || (d.landing.type === 'refuse' || d.landing.type === 'remove')) return d;
  return { ...d, hot: undefined, hotSel: undefined, landing: { type: 'refuse', reason: src.blocked }, error: src.blocked };
}
function hitAt(x: number, y: number, src: DragSource, layout: Layout, t: T): Drop | null {
  const bar = targetAt(x, y, { w: src.widget, fromBar: 'bar' in src });
  if (bar && bar.kind !== 'split') return barHit(bar, src, t); // the split target answers only drags outside edit mode
  const root = document.querySelector('.layout')?.getBoundingClientRect();
  if (!root || x < root.left || x > root.right || y < root.top || y > root.bottom) return null;
  const kind = kindOf(src.widget);
  // Settings, Layout and Browser are bar icons, not widgets: no zone takes them. Before this check a drag that crossed
  // the main area read MIN of a kind that has none and the window crashed blank (v25-fix-layout, the owner finding 2).
  if (PSEUDO.includes(src.widget)) {
    const reason = t('leftovers.drag.staysOnBar', { name: WIDGET_LABEL(src.widget) });
    return { landing: { type: 'refuse', reason }, rect: box(root), what: t('leftovers.drag.mainArea'), sizes: '', error: reason };
  }
  const place = (to: { op: 'split'; dir: Dir; zone: string } | { op: 'stack'; zone: string } | { op: 'edge'; dir: Dir }): Op =>
    'from' in src ? { op: 'move', from: src.from, ...(src.tab ? { tab: src.tab + 1 } : {}), to } : to.op === 'edge' ? { op: 'edge', dir: to.dir, widget: src.widget } : to.op === 'stack' ? { op: 'stack', widget: src.widget, zone: to.zone } : { op: 'split', dir: to.dir, widget: src.widget, zone: to.zone };
  const check = (op: Op) => {
    try {
      apply(layout, op, measureDom);
      return null;
    } catch (e) {
      return rawError(e);
    }
  };
  const edge: Dir | null = x - root.left < BAND ? 'left' : root.right - x < BAND ? 'right' : y - root.top < BAND ? 'up' : root.bottom - y < BAND ? 'down' : null;
  if (edge) {
    const side = edge === 'left' || edge === 'right';
    const size = edgeSize(src.widget, edge);
    const op = place({ op: 'edge', dir: edge });
    const rect = edge === 'left' ? { x: root.left, y: root.top, w: size, h: root.height } : edge === 'right' ? { x: root.right - size, y: root.top, w: size, h: root.height } : edge === 'up' ? { x: root.left, y: root.top, w: root.width, h: size } : { x: root.left, y: root.bottom - size, w: root.width, h: size };
    const error = check(op);
    return { landing: { type: 'zone', op, error }, rect, what: t(`leftovers.drag.edge.${edge}` as const), sizes: t(side ? 'leftovers.drag.sizes.wide' : 'leftovers.drag.sizes.high', { size, min: MIN[kind][side ? 'w' : 'h'] }), error, arm: edge, caption: caption(t, edge) };
  }
  const el = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-zone-id]');
  const id = el?.dataset.zoneId;
  const zone = id ? find(layout.root, id) : undefined;
  if (!el || !zone || !isLeaf(zone)) return null;
  const r = el.getBoundingClientRect();
  const name = zoneLabel(zone, Math.min(zone.active ?? 0, zone.widgets.length - 1), t);
  const rx = (x - r.left) / r.width;
  const ry = (y - r.top) / r.height;
  if (rx > 0.3 && rx < 0.7 && ry > 0.3 && ry < 0.7) {
    const op = place({ op: 'stack', zone: zone.id });
    const error = check(op);
    return { landing: { type: 'zone', op, error }, rect: box(r), what: t('leftovers.drag.stack', { zone: name }), sizes: t('leftovers.drag.sizes.stack', { w: Math.round(r.width), h: Math.round(r.height) }), error, arm: 'centre', caption: caption(t, 'centre'), zone: box(r) };
  }
  const dir: Dir = ([['left', rx], ['right', 1 - rx], ['up', ry], ['down', 1 - ry]] as [Dir, number][]).sort((a, b) => a[1] - b[1])[0][0];
  const row = dir === 'left' || dir === 'right';
  const half = Math.floor((row ? r.width : r.height) / 2);
  const rect = dir === 'left' ? { x: r.left, y: r.top, w: half, h: r.height } : dir === 'right' ? { x: r.right - half, y: r.top, w: half, h: r.height } : dir === 'up' ? { x: r.left, y: r.top, w: r.width, h: half } : { x: r.left, y: r.bottom - half, w: r.width, h: half };
  const op = place({ op: 'split', dir, zone: zone.id });
  const a = row ? 'w' : 'h';
  const error = check(op);
  return { landing: { type: 'zone', op, error }, rect, what: t(`leftovers.drag.split.${dir}` as const, { zone: name }), sizes: t('leftovers.drag.sizes.split', { zone: name, half, name: TITLE[kind], zoneMin: minOf(zone)[a], min: MIN[kind][a] }), error, arm: dir, caption: caption(t, dir), zone: box(r) };
}

export function DragLayer({ source, layout, onDrop, onEnd }: { source: DragSource; layout: Layout; onDrop: (l: Landing) => void; onEnd: () => void }) {
  const t = useHtmlLangT();
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const drop = at ? hit(at.x, at.y, source, layout, t) : null;

  // The target's own element carries the highlight (the tree row, the Tree icon), so the tree needs no drag state.
  // A tree update can re-create the row under the pointer: the mark follows it to the live element.
  const hot = drop?.hot;
  const hotSel = drop?.hotSel;
  useEffect(() => {
    if (!hot) return;
    let el: Element = hot;
    const mark = () => {
      if (!el.isConnected && hotSel) el = document.querySelector(hotSel) ?? el;
      el.setAttribute('data-hot', '');
    };
    mark();
    const watch = new MutationObserver(mark);
    watch.observe(document.body, { childList: true, subtree: true });
    return () => {
      watch.disconnect();
      hot.removeAttribute('data-hot');
      el.removeAttribute('data-hot');
    };
  }, [hot, hotSel]);

  // Layout effect: listening starts before the next pointer event, so a quick drag and release is not lost.
  useLayoutEffect(() => {
    const move = (e: PointerEvent) => setAt({ x: e.clientX, y: e.clientY });
    const up = (e: PointerEvent) => {
      const d = hit(e.clientX, e.clientY, source, layout, t);
      if (d) onDrop(d.landing);
      onEnd();
    };
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onEnd();
    // A cancelled pointer (the system took it, the window lost it) ends the drag like a release, without a drop.
    const cancel = () => onEnd();
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('keydown', key);
    };
  }, [source, layout, onDrop, onEnd, t]);

  const kind = kindOf(source.widget);
  const pin = pinOf(source.widget);
  const ARMS: (Dir | 'centre')[] = ['up', 'left', 'centre', 'right', 'down'];
  return (
    <div className="dragl" aria-hidden={!drop}>
      {at && (
        <div className="ghost" style={{ left: at.x + 10, top: at.y + 10 }}>
          {TITLE[kind] ?? source.widget.replace(/^widget:/, '')}
        </div>
      )}
      {drop?.zone && (
        <div className="compass" aria-hidden style={{ left: drop.zone.x + drop.zone.w / 2 - 54, top: drop.zone.y + drop.zone.h / 2 - 54 }}>
          {ARMS.map((a) => (
            <i key={a} data-arm={a} data-on={drop.arm === a} data-error={drop.arm === a && !!drop.error} />
          ))}
        </div>
      )}
      {drop?.ins && <div className="ins" style={{ left: drop.ins.x, top: drop.ins.y, width: drop.ins.w, height: drop.ins.h }} />}
      {drop && (
        <div className="dropprev" data-error={!!drop.error} data-dir={drop.arm} data-kind={drop.landing.type} style={{ left: drop.rect.x, top: drop.rect.y, width: drop.rect.w, height: drop.rect.h }}>
          <div className="dropl" role="status">
            <b>
              {drop.caption ? `${drop.caption} · ` : ''}
              {TITLE[kind] ?? source.widget.replace(/^widget:/, '')} · {drop.what}
            </b>
            {(drop.error ?? drop.sizes) && <span>{drop.error ?? drop.sizes}</span>}
            {drop.landing.type === 'zone' && <span>{pin ? t('rest.layout.pinned', { name: pin }) : t('rest.layout.follows')}</span>}
          </div>
        </div>
      )}
    </div>
  );
}
