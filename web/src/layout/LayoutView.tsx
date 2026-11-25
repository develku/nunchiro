// Renders the layout tree as nested flex zones. Splits get live gutters; in edit mode
// every zone gets a dashed outline with a grip, its name, minimum size and a remove button.
import { Icon } from '../icons/Icon';
import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { isRequired, REQUIRED } from './bars';
import { glyph } from './icons';
import { resizing } from './resizing';
import type { T } from '../i18n';
import { words } from './store';
import { defaultZone, edgeSize, find, isLeaf, kindOf, leaves, minOf, pinOf, TITLE, zoomHidden, type Item, type Kind, type Layout, type Leaf, type Node, type Split } from './model';

export interface WidgetCtx {
  zone: Leaf;
  tab: number;
  /** First widget of its kind in the layout: it keeps the ids other code and tests look for. */
  first: boolean;
}

interface Props {
  layout: Layout;
  editing: boolean;
  selected: string | null;
  /** `shown` is the zone's shown tab (the per-zone pick, else `active`): one helper for both sides. */
  hidden: (n: Node, shown?: (z: Leaf) => number) => boolean;
  /** Zone shown full size (view state only); null shows the whole layout. */
  zoom?: string | null;
  zoomNote?: string;
  /** v1a-43: the zone pane mode has focused (outlined); null when pane mode is off. */
  paneFocus?: string | null;
  /** UXFIX (c): counts the times a session or settings is opened; a zone that stacks the terminal with a board then shows the terminal. */
  reveal?: number;
  render: (item: Item, ctx: WidgetCtx) => ReactNode;
  onSelect: (id: string) => void;
  onResize: (id: string, size: number) => void;
  onRemove: (zone: string, tab: number) => void;
  onGrab: (e: ReactPointerEvent, zone: string, tab: number) => void;
}

// Content-height widgets: in a column they take what they need unless a size is set.
const AUTO = new Set(['waiting', 'composer']);
const auto = (n: Node, parent: Split) => parent.split === 'column' && isLeaf(n) && n.size === undefined && AUTO.has(kindOf(n.widgets[n.active ?? 0]));

/** A zone's name in the window (its header, Remove, tab list and, ticket 528, the drag preview): the zone that follows the
 * open session says Chat; a built-in zone is named after its widget; never the layout.toml id unless nothing else names it. */
export const zoneLabel = (z: Leaf, active: number, t: T) =>
  z.id === REQUIRED && kindOf(z.widgets[active]) === REQUIRED ? TITLE[REQUIRED] : kindOf(z.widgets[active]) === 'terminal' && !pinOf(z.widgets[active]) ? t('shell.zone.chat') : (TITLE[z.id as Kind] ?? z.id);

/** Ticket 811: a resize handle is named after what its zone shows (the active widget, as the zone header), never the zone id
 *  (layout data, possibly the user's own word); a split of zones takes a generic word. */
const handleName = (n: Node, t: T) => {
  if (!isLeaf(n)) return t('a11y.layout.group');
  const w = n.widgets[Math.min(n.active ?? 0, n.widgets.length - 1)];
  return kindOf(w) === 'terminal' && !pinOf(w) ? t('shell.zone.chat') : TITLE[kindOf(w)];
};

export function LayoutView(p: Props) {
  const t = words();
  const [live, setLive] = useState<{ id: string; size: number } | null>(null);
  // A picked tab holds only while the zone keeps the same number of widgets: a widget stacked since is the one to show.
  const [tabs, setTabs] = useState<Record<string, { i: number; n: number }>>({});
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) return void (mounted.current = true);
    setTabs((t) => ({ ...t, ...Object.fromEntries(leaves(p.layout.root).flatMap((z) => (z.widgets.length > 1 && z.widgets.some((w) => kindOf(w) === 'terminal') ? [[z.id, { i: z.widgets.findIndex((w) => kindOf(w) === 'terminal'), n: z.widgets.length }]] : []))) }));
  }, [p.reveal]);
  const seen = new Set<string>();
  const zoomOut = zoomHidden(p.layout, p.zoom ?? null);
  const activeTab = (z: Leaf) => Math.min((tabs[z.id]?.n === z.widgets.length ? tabs[z.id].i : undefined) ?? z.active ?? 0, z.widgets.length - 1);
  const centre = find(p.layout.root, defaultZone(p.layout));
  const boardActive = !!centre && isLeaf(centre) && !p.hidden(centre, activeTab) && !zoomOut(centre) && kindOf(centre.widgets[activeTab(centre)]) === 'board';
  const hide = (n: Node) => p.hidden(n, activeTab) || zoomOut(n);
  const zoomed = !!p.zoom && !!find(p.layout.root, p.zoom);

  const leaf = (z: Leaf, style: CSSProperties) => {
    const active = activeTab(z);
    const min = minOf(z);
    // rc2b-fb (coordinator item 11): the zone that follows the open session shows its chat, so it says Chat, not its id.
    // A built-in zone is named after its widget. Ticket 511: spoken names use this too, never the layout.toml id.
    const zoneName = zoneLabel(z, active, t);
    const firsts = z.widgets.map((w) => {
      const k = kindOf(w);
      const first = !seen.has(k);
      seen.add(k);
      return first;
    });
    return (
      <section key={z.id} className="lz" data-hint-kind="pane" data-zone-id={z.id} data-node-id={z.id} data-selected={p.editing && p.selected === z.id} data-pane-focus={p.paneFocus === z.id} tabIndex={-1} style={style} hidden={hide(z)} onPointerDownCapture={() => p.editing && p.onSelect(z.id)}>
        {p.editing && (
          // In flow above the zone's content while editing, so it never covers a title, a strip line or a button.
          <div className="zl" onPointerDown={(e) => p.onGrab(e, z.id, active)} title={t('rest.layout.dragZone')}>
            <span className="grip" aria-hidden>
              ⋮⋮
            </span>
            <b>{zoneName}</b>
            <span>
              {z.widgets
                .map((w) => TITLE[kindOf(w)])
                .filter((t) => t.toLowerCase() !== z.id)
                .join(' · ')}
            </span>
            {pinOf(z.widgets[active]) && <span className="pin">📌 {pinOf(z.widgets[active])}</span>}
            <span className="dim">
              {t('rest.layout.min', { w: min.w, h: min.h })}
            </span>
            {z.widgets.some((w) => kindOf(w) === 'waiting') && <span className="zwarn">{t('rest.layout.waitingWarn')}</span>}
            {!isRequired(z.widgets[active]) && (
              <button aria-label={t('rest.layout.removeFrom', { name: TITLE[kindOf(z.widgets[active])], zone: zoneName })} onPointerDown={(e) => e.stopPropagation()} onClick={() => p.onRemove(z.id, active + 1)}>
                <Icon name="x" size={12} />
              </button>
            )}
          </div>
        )}
        {z.widgets.length > 1 && (
          // v25-shell-chrome (ticket 284 item 1): the Terminal / Board strip is gone; Board and Terminal are reached from their icons.
          // The tabs stay in the DOM, hidden, because the Board icon (board/useBoardRail.ts) and a Decisions jump bring a tab up through them.
          <div className="ztabs" role="tablist" aria-label={t('rest.layout.zone', { zone: zoneName })} hidden={z.widgets.every((w) => kindOf(w) === 'terminal' || kindOf(w) === 'board')}>
            {z.widgets.map((w, i) => (
              <button key={i} role="tab" aria-selected={i === active} onClick={() => setTabs((t) => ({ ...t, [z.id]: { i, n: z.widgets.length } }))}>
                {TITLE[kindOf(w)]}
                {pinOf(w) && <span className="pin">📌 {pinOf(w)}</span>}
              </button>
            ))}
          </div>
        )}
        {z.widgets.map((w, i) => (
          <div key={`${i}:${w}`} className="wg" data-widget={kindOf(w)} hidden={i !== active || (boardActive && kindOf(w) === 'composer')}>
            {/* The Tree component has no title row of its own (its sidebar header names it); in a zone it gets the
                same .ph row as Files or Diff (needs 157 (2), round 2). */}
            {kindOf(w) === REQUIRED && (
              <div className="ph">
                {glyph(REQUIRED)} {TITLE[REQUIRED]}
              </div>
            )}
            {p.render(w, { zone: z, tab: i, first: firsts[i] })}
          </div>
        ))}
        {p.editing && <div className="zedit" aria-hidden />}
      </section>
    );
  };

  const node = (n: Node, style: CSSProperties): ReactNode => {
    if (isLeaf(n)) return leaf(n, style);
    const row = n.split === 'row';
    const fill = n.children.map((c) => (c.id === live?.id || hide(c) ? false : c.size === undefined && !auto(c, n)));
    // One shown child always takes the rest, or a larger window (or a folded panel, V1A-60) would leave a gap.
    if (!fill.some(Boolean)) fill[n.children.findLastIndex((c) => !hide(c))] = true;
    const kids: ReactNode[] = [];
    n.children.forEach((c, i) => {
      const size = c.id === live?.id ? live.size : c.size;
      const min = minOf(c)[row ? 'w' : 'h'];
      const flex = zoomed || fill[i] ? '1 1 0' : size !== undefined ? `0 0 ${size}px` : '0 0 auto';
      kids.push(node(c, { flex, [row ? 'minWidth' : 'minHeight']: auto(c, n) ? 0 : min }));
      if (i < n.children.length - 1 && !zoomed) kids.push(<Gutter key={`g${c.id}`} parent={n} i={i} live={setLive} commit={p.onResize} />);
    });
    return (
      <div key={n.id} className="lz-split" data-split={n.split} data-node-id={n.id} style={style} hidden={hide(n)}>
        {kids}
      </div>
    );
  };

  return (
    <div className="layout" data-editing={p.editing} data-resizing={live ? 'true' : undefined}>
      {node(p.layout.root, { flex: '1 1 0' })}
      <div data-live="zoom" role="status">
        {zoomed && <div className="zoom-note">{p.zoomNote}</div>}
      </div>
    </div>
  );
}

/** Drag or arrow keys resize the zone before the gutter, or the one after when only it has a fixed size. */
function Gutter({ parent, i, live, commit }: { parent: Split; i: number; live: (v: { id: string; size: number } | null) => void; commit: (id: string, size: number) => void }) {
  const row = parent.split === 'row';
  const [a, b] = [parent.children[i], parent.children[i + 1]];
  const fixed = (n: Node) => n.size !== undefined || auto(n, parent);
  const target = fixed(a) || !fixed(b) ? a : b;
  const sign = target === a ? 1 : -1;
  const measure = () => {
    const r = document.querySelector(`[data-node-id="${CSS.escape(target.id)}"]`)?.getBoundingClientRect();
    return r ? (row ? r.width : r.height) : (target.size ?? 0);
  };
  const min = minOf(target)[row ? 'w' : 'h'];
  const clamp = (v: number) => Math.max(min, Math.round(v));
  return (
    <div
      className="gutter" data-split={parent.split}
      role="separator"
      tabIndex={0}
      aria-orientation={row ? 'vertical' : 'horizontal'}
      aria-label={words()('rest.layout.resize', { zone: handleName(target, words()) })}
      // shortcut: a zone that shares the rest reports its minimum as the value; measure it when a screen reader needs the true size
      aria-valuenow={Math.round(target.size ?? min)}
      aria-valuemin={min}
      onPointerDown={(e) => {
        e.preventDefault();
        const size = measure();
        const d = { start: row ? e.clientX : e.clientY, from: size, size };
        resizing(
          e.currentTarget,
          e.pointerId,
          (ev) => {
            d.size = clamp(d.from + sign * ((row ? ev.clientX : ev.clientY) - d.start));
            live({ id: target.id, size: d.size });
          },
          () => {
            live(null);
            if (d.size !== d.from) commit(target.id, d.size);
          },
        );
      }}
      // As the sidebar divider (Sidebars.tsx): a double-click returns the zone to the size it is added with. ponytail: the 'resize' op
      // cannot unset a size, so a dragged content-height zone (answer strip, composer) goes to the band size; add an op in layout/model.ts if that matters.
      onDoubleClick={() => commit(target.id, clamp(edgeSize(leaves(target)[0].widgets[0], row ? 'left' : 'up')))}
      onKeyDown={(e) => {
        const step = { ArrowLeft: -16, ArrowUp: -16, ArrowRight: 16, ArrowDown: 16 }[e.key];
        if (step === undefined || (row ? /Up|Down/ : /Left|Right/).test(e.key)) return;
        e.preventDefault();
        commit(target.id, clamp(measure() + sign * step));
      }}
    >
      <span className="grip" aria-hidden />
    </div>
  );
}
