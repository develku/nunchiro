// A side's sidebar (LAYOUT D5b): one widget at a time, named in its header. Collapsed sides render nothing.
// v25-fix-layout (the owner finding 23): its inner edge drags to resize (pointer capture), arrows step it, double-click puts the
// default back. v25-shell-chrome (ticket 283), v25f F12: each sidebar has its own width, kept with the layout (`Bars.sidebarW`,
// useRails owns the values); a drag past half the minimum closes the sidebar (as VS Code) and it reopens at the width it had before the drag.
import { useSyncExternalStore, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { maxWidth, SIDEBAR_MIN, SIDEBAR_STEP, WIDGET_LABEL, type Side } from './bars';
import type { T } from '../i18n';
import { glyph } from './icons';
import './rails.css';
import '../widgets-7a.css'; // ticket 1041 lane 7a: quiet controls and state edges inside Board, Decisions, Schedules, History, Team

export { SIDEBAR_MAX, SIDEBAR_MIN, SIDEBAR_W, maxWidth } from './bars';
/** How far under the minimum a drag goes before the sidebar closes: half the minimum, so narrowing to the minimum never closes it by accident. */
const CLOSE_UNDER = SIDEBAR_MIN / 2;

const useWindowWidth = () =>
  useSyncExternalStore(
    (f) => (window.addEventListener('resize', f), () => window.removeEventListener('resize', f)),
    () => window.innerWidth,
  );

interface Props {
  side: Side;
  widget: string;
  /** This side's width (px). */
  width: number;
  /** The other side's sidebar width (px), 0 when it is closed: the two leave room for the chat. */
  other: number;
  /** A new width for this side; null puts the default back. */
  onWidth: (w: number | null) => void;
  /** The drag went under the minimum: close this side; `restore` is the width to reopen at. */
  onClose: (restore: number) => void;
  t: T;
  children: ReactNode;
}

export function Sidebar({ side, widget, width, other, onWidth, onClose, t, children }: Props) {
  // A width kept from a wider window is drawn within this one's limit (the stored value stays).
  const max = maxWidth(useWindowWidth(), other);
  const w = Math.min(width, max);
  const name = side === 'left' ? 'left' : 'right';
  const drag = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget;
    const x0 = e.clientX;
    const w0 = w;
    el.setPointerCapture(e.pointerId);
    document.documentElement.toggleAttribute('data-resizing', true); // look 1117 v3: a drag selects no text across the window
    const stop = () => ((el.onpointermove = null), (el.onpointerup = null), (el.onpointercancel = null), document.documentElement.toggleAttribute('data-resizing', false));
    el.onpointermove = (ev) => {
      const raw = w0 + (side === 'left' ? ev.clientX - x0 : x0 - ev.clientX);
      if (raw < SIDEBAR_MIN - CLOSE_UNDER) return (stop(), onClose(w0));
      onWidth(raw);
    };
    el.onpointerup = el.onpointercancel = stop;
  };
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    const grow = side === 'left' ? 'ArrowRight' : 'ArrowLeft';
    const shrink = side === 'left' ? 'ArrowLeft' : 'ArrowRight';
    const dx = e.key === grow ? SIDEBAR_STEP : e.key === shrink ? -SIDEBAR_STEP : 0;
    if (dx) (e.preventDefault(), onWidth(w + dx));
  };
  return (
    <aside className={`sbar ${side === 'left' ? 'l' : 'r'}`} data-hint-region={side} aria-label={t(`rest.layout.sidebar.${name}`)} data-side={side} data-widget={widget} style={{ width: w, position: 'relative' }}>
      <div className="sbh">
        <span aria-hidden>{glyph(widget)}</span> <b>{WIDGET_LABEL(widget)}</b>
      </div>
      <div className="sbb">{children}</div>
      <div
        className="sdiv"
        data-side={side}
        role="separator"
        aria-orientation="vertical"
        aria-label={t(`rest.layout.resizeSidebar.${name}`)}
        aria-valuenow={w}
        aria-valuemin={SIDEBAR_MIN}
        aria-valuemax={max}
        tabIndex={0}
        title={t('shell.chrome.sidebarEdgeTitle')}
        onPointerDown={drag}
        onKeyDown={key}
        onDoubleClick={() => onWidth(null)}
      />
    </aside>
  );
}
