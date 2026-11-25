// One icon bar (LAYOUT D5b, ICONBAR): a column of icon-size slots, like a phone's home screen. An icon sits in any slot,
// empty slots stay empty, and a slot cut off by a short window puts its icon behind the ⋯ button. In edit mode every
// icon drags to any slot (an occupied slot swaps) and shows ✕ (the tree, Decisions, Settings and Layout show none:
// they move but never leave, needs 162); Alt+arrows and Delete are the keyboard path (WCAG 2.5.7).
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { BAR_MAX, BAR_STEP, BAR_W, FIXED, isRequired, SLOTS, WIDGET_LABEL, type Compact, type Side, type Slot } from './bars';
import type { T } from '../i18n';
import { useNeedsYou } from '../board/useBoardRail';
import { Icon as Oct } from '../icons/Icon';
import { Icon, glyph } from './icons';
import { resizing } from './resizing';
import './rails.css';

export { glyph } from './icons';
export { Icon };

/** The command an icon runs: its tooltip shows that command's key, and Hints tags the icon with it. Ticket 1099: every
 *  bar icon has one, so each can be bound on Settings > Keyboard and found in the palette. */
const HINT: Record<string, string> = { tree: 'sidebar.left.toggle', files: 'files.show', search: 'search.open', diff: 'diff.open', preview: 'preview.toggle', terminal: 'pane.toggle', board: 'board.toggle', artifacts: 'artifacts.toggle', settings: 'settings.open', layout: 'layout.edit', history: 'history.open', decisions: 'decisions.open', schedules: 'schedules.open', team: 'room.open', context: 'context.open', pr: 'pr.list' };

const MOVE = 6; // ticket 1076: 4 px (the tab drag's) let a hand wobble on the Settings gear start a drag that ate the click
/** Ticket 1041: a slot's height with its gap, the mockup's 32 px button and 4 px gap (rails.css `.ib .slot`). */
const SLOT_H = 32 + 4;
/** Ticket 1052: a slot with a label under its icon (rails.css `.ib[data-compact] .slot`). */
const SLOT_LABELLED = 44 + 4;
/** The bar's padding (4 top, 8 bottom) plus the hide / show button at its top with its gap (rails.css `.ib .sidebtn`). */
const PAD = 12 + 36;
/** Ticket 1047: with auto-hide on, the pointer this close to the window edge (px) brings the bar back (the title bar's 6 px), and it leaves this long after the pointer does. */
const EDGE = 6;
const LEAVE_MS = 300;

/** What the window says about one icon. */
export interface IconInfo {
  pressed: boolean;
  folded: boolean;
  /** Replaces the icon's name (Layout reads "Editing layout · Done" while editing). */
  name?: string;
  tip: string;
  /** Something inside the widget waits for the user (a pending decision): a dot at the icon's top right, whatever else the icon shows. */
  waiting?: boolean;
  /** Ticket 990: an icon the window adds for the moment (Team, while the place has a lead): no menu, no drag. */
  injected?: boolean;
  /** Items in it that need the user (Team's tasks): a count on the icon, said in its name as `countSay`. */
  count?: number;
  countSay?: string;
  /** Ticket 993: something in it failed (a scheduled run): a dot in the broken red, named by these words. */
  failed?: string;
}

interface Props {
  side: Side;
  slots: Slot[];
  info: (w: string) => IconInfo;
  editing: boolean;
  onClick: (w: string) => void;
  onRemove: (w: string) => void;
  /** An icon pressed and moved past a few pixels: a drag in edit mode, a hint on how to start outside it. */
  onGrab: (w: string) => void;
  /** Alt+arrows and Delete in edit mode. */
  onKey: (e: ReactKeyboardEvent, w: string) => void;
  /** The icon being dragged (its slot shows empty while it is held). */
  dragging?: string | null;
  /** This side's sidebar is open, and the button at the bar's top toggles it. */
  sideOpen: boolean;
  onToggleSide: () => void;
  /** Ticket 1047: auto-hide is on: the bar floats over the content and shows only at its window edge or while focus is in it. */
  auto?: boolean;
  /** Ticket 1052: the bar's width (shared by both bars), the label step it gives, and a new width (null: the default). */
  width: number;
  compact: Compact;
  onWidth: (w: number | null) => void;
  /** Ticket 1093: the window's auto-hide toggle (the left bar's foot, above Settings): pressed while auto-hide is on. */
  onAutoHide?: () => void;
  autoOn?: boolean;
  /** The window's catalogue lookup. */
  t: T;
}

/** The label under an icon at a compact step: the whole name, its first letter capitalised, or nothing. */
const shortLabel = (text: string, step: Compact) => (step === 'icon' ? null : step === 'letter' ? ([...text][0] ?? '').toLocaleUpperCase() : text);

/** A panel with a rail at one side (Lucide's PanelLeft / PanelRight shape, ISC, as in MonoCode's title bar): the hide / show button. */
function PanelIcon({ side }: { side: Side }) {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d={side === 'left' ? 'M9 3v18' : 'M15 3v18'} />
    </svg>
  );
}

/** A panel whose rail is dashed (Lucide's PanelLeftDashed shape, ISC): the bars come and go. */
function AutoHideIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M9 14v1M9 19v2M9 3v2M9 9v1" />
    </svg>
  );
}

export function IconBar(p: Props) {
  const down = useRef<{ x: number; y: number; w: string } | null>(null);
  /** The icon whose press became a drag: its release must not also count as a click (pointer capture sends it there). */
  const dragged = useRef<string | null>(null);
  const nav = useRef<HTMLElement>(null);
  /** V2.5-60 (ticket 219 B13): the cards that need the owner, on the Board icon; none at zero. */
  const { n: needs, narrowed } = useNeedsYou();
  const [cap, setCap] = useState(SLOTS);
  const [more, setMore] = useState(false);
  const [peek, setPeek] = useState(false);
  const peekNow = useRef(false);
  peekNow.current = peek;
  const [sizing, setSizing] = useState(false);
  const held = more || !!p.dragging || sizing; // a menu, a drag of the bar's own or of its edge keeps it out
  const x = useRef(-1); // the last pointer x; kept across effect runs so a menu closing under the pointer does not hide the bar
  useEffect(() => {
    const el = nav.current;
    if (!p.auto || !el) return setPeek(false);
    let timer = 0;
    const inZone = (w: number) => {
      const d = p.side === 'left' ? x.current : window.innerWidth - x.current;
      return x.current >= 0 && d >= 0 && d <= w;
    };
    const away = () => {
      clearTimeout(timer);
      timer = window.setTimeout(() => !held && !inZone(el.offsetWidth) && !el.contains(document.activeElement) && setPeek(false), LEAVE_MS);
    };
    const come = () => (clearTimeout(timer), setPeek(true));
    const move = (e: PointerEvent) => {
      x.current = e.clientX;
      inZone(peekNow.current ? el.offsetWidth : EDGE) ? come() : away();
    };
    window.addEventListener('pointermove', move);
    el.addEventListener('focusin', come);
    el.addEventListener('focusout', away);
    held ? come() : away();
    return () => (clearTimeout(timer), window.removeEventListener('pointermove', move), el.removeEventListener('focusin', come), el.removeEventListener('focusout', away));
  }, [p.auto, p.side, held]);
  const moreBtn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  // The menu pattern of menu/ContextMenu.tsx: focus goes in on open, arrows move (wrapping), Esc closes and focus returns to ⋯.
  useEffect(() => void (more && pop.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()), [more]);
  const popKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const list = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    const at = list.indexOf(document.activeElement as HTMLElement);
    const go = (i: number) => (e.preventDefault(), list[(i + list.length) % list.length]?.focus());
    if (e.key === 'ArrowDown') go(at + 1);
    else if (e.key === 'ArrowUp') go(at - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(-1);
    else if (e.key === 'Escape') (e.preventDefault(), e.stopPropagation(), setMore(false), moreBtn.current?.focus());
  };
  useLayoutEffect(() => {
    const el = nav.current;
    if (!el) return;
    const measure = () => setCap(Math.max(1, Math.floor((el.clientHeight - PAD - (p.onAutoHide ? SLOT_H : 0)) / (p.compact === 'icon' ? SLOT_H : SLOT_LABELLED))));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [p.compact, !!p.onAutoHide]);
  useEffect(() => {
    if (!more) return;
    const off = (e: Event) => !(e.target as Element).closest('.more, .pop') && setMore(false);
    document.addEventListener('pointerdown', off);
    return () => document.removeEventListener('pointerdown', off);
  }, [more]);
  // Slots past the bar's height are cut off; if any of them holds an icon the last visible slot becomes ⋯ (as in the mockup).
  const cut = p.slots.map((w, i) => [w, i] as const).filter(([w, i]) => w && i >= cap);
  const shown = cut.length ? Math.max(0, cap - 1) : Math.min(cap, SLOTS);
  const hidden = p.slots.map((w, i) => [w, i] as const).filter(([w, i]) => w && i >= shown) as [string, number][];
  const label = p.t(p.side === 'left' ? 'shell.rail.left' : 'shell.rail.right');

  const item = (w: string) => {
    const i = p.info(w);
    const base = i.name ?? WIDGET_LABEL(w);
    const n = w === 'board' ? needs : (i.count ?? 0);
    // The count is the whole board's; when the Board's chips or search show fewer, the label says which number this is.
    const count = !n ? '' : w === 'board' ? p.t(n === 1 ? 'board.rail.needsYou.one' : 'board.rail.needsYou.other', { n }) : (i.countSay ?? '');
    const say = n && narrowed && w === 'board' ? `${count} (${p.t('board.railChips.scope')})` : count;
    const name = n ? `${base} · ${say}` : base; // colour is not the only cue: the name and the tooltip say the count
    const key = i.folded;
    return (
      <div className="aiw" data-icon={w} data-dragging={p.dragging === w ? '' : undefined}>
        <button
          id={`icon-${w}`}
          className={`ai${w === 'layout' ? ' lay' : ''}${w === 'settings' ? ' gear' : ''}`}
          data-menu={i.injected ? undefined : 'icon'}
          data-menu-arg={i.injected ? undefined : w}
          data-hint-icon={HINT[w]}
          data-hint-kind={p.side}
          data-tip={[i.tip, n && say, i.waiting && p.t('shell.chrome.waiting'), i.failed].filter(Boolean).join(' · ')}
          aria-describedby={i.waiting || i.failed ? `wdot-${w}` : undefined}
          data-tip-cmd={HINT[w]}
          aria-label={key ? p.t('shell.rail.folded', { name }) : name}
          aria-pressed={i.pressed}
          data-folded={key ? '' : undefined}
          onClick={() => (dragged.current === w ? (dragged.current = null) : p.onClick(w))}
          onKeyDown={(e) => p.editing && p.onKey(e, w)}
          onPointerDown={(e) => {
            if (e.button !== 0 || i.injected) return;
            down.current = { x: e.clientX, y: e.clientY, w };
            dragged.current = null;
            // Panel finding (needs 149 item 2): a listener on the button missed a first move that already left the
            // icon (a flick), so no drag started. The window hears every move until the release. Not pointer
            // capture: in the app's WKWebView a captured press turned the next plain click into a tooltip only.
            const move = (ev: PointerEvent) => {
              const d = down.current;
              if (!d || d.w !== w || Math.hypot(ev.clientX - d.x, ev.clientY - d.y) < MOVE) return;
              end();
              dragged.current = w;
              p.onGrab(w);
            };
            const end = () => {
              down.current = null;
              window.removeEventListener('pointermove', move);
              window.removeEventListener('pointerup', end);
              window.removeEventListener('pointercancel', end);
            };
            window.addEventListener('pointermove', move);
            window.addEventListener('pointerup', end);
            window.addEventListener('pointercancel', end);
          }}
        >
          <span className="gl" aria-hidden>
            {glyph(w)}
          </span>
          {p.compact !== 'icon' && (
            <span className="al" aria-hidden>
              {shortLabel(base, p.compact)}
            </span>
          )}
          {n > 0 && (
            <i className="rcount" aria-hidden>
              {n > 9 ? '9+' : n}
            </i>
          )}
          {i.waiting && <i className="wdot" id={`wdot-${w}`} role="img" aria-label={p.t('shell.chrome.waiting')} />}
          {i.failed && !i.waiting && <i className="wdot" data-failed id={`wdot-${w}`} role="img" aria-label={i.failed} />}
        </button>
        {p.editing && !isRequired(w) && !FIXED.includes(w) && (
          <button className="rx" aria-label={p.t(p.side === 'left' ? 'shell.rail.removeLeft' : 'shell.rail.removeRight', { name: base })} onClick={() => p.onRemove(w)}>
            <Oct name="x" size={12} />
          </button>
        )}
      </div>
    );
  };

  const autoName = p.t('shell.chrome.autoHideBars');
  const autoBtn = p.onAutoHide && (
    <button key="autohide" className="autobtn" data-hint-skip aria-label={autoName} aria-pressed={!!p.autoOn} data-tip={autoName} data-tip-cmd="bars.autohide" onClick={p.onAutoHide}>
      <AutoHideIcon />
    </button>
  );
  const sideKey = `shell.chrome.${p.sideOpen ? 'hide' : 'show'}${p.side === 'left' ? 'Left' : 'Right'}` as const;
  return (
    <nav ref={nav} className={`ib ${p.side === 'left' ? 'l' : 'r'}`} aria-label={label} data-bar={p.side} data-auto={p.auto ? '' : undefined} data-reveal={p.auto ? peek : undefined} data-hint-region={p.side} data-editing={p.editing} data-compact={p.compact === 'icon' ? undefined : p.compact} style={p.width === BAR_W ? undefined : { width: p.width, ['--barw' as string]: `${p.width}px` }}>
      <button
        className="sidebtn"
        data-hint-skip // ticket 389: the bar's Tree or right icon does the same
        aria-label={p.t(sideKey)}
        aria-expanded={p.sideOpen}
        data-tip={p.t(sideKey)}
        data-tip-cmd={`sidebar.${p.side}.toggle`}
        onClick={p.onToggleSide}
      >
        <PanelIcon side={p.side} />
      </button>
      {p.slots.slice(0, shown).map((w, i) => [
        i === SLOTS - 1 && autoBtn, // above the foot slot (Settings by default)
        <div className={`slot${w && p.dragging !== w ? '' : ' empty'}`} data-slot={i} key={i}>
          {w && item(w)}
        </div>,
      ])}
      {shown < SLOTS && autoBtn}
      {hidden.length > 0 && (
        <div className="slotmore">
          <button ref={moreBtn} className="more" aria-label={p.t('shell.rail.more', { n: hidden.length })} aria-expanded={more} onClick={() => setMore((o) => !o)}>
            ⋯<i>{hidden.length}</i>
          </button>
          {more && (
            <div ref={pop} className="pop" role="menu" aria-label={p.t('shell.rail.moreMenu')} onKeyDown={popKey}>
              <div className="hd">{p.t('shell.rail.cutOff')}</div>
              {hidden.map(([w]) => (
                <button
                  key={w}
                  role="menuitem"
                  onClick={() => {
                    setMore(false);
                    p.onClick(w);
                  }}
                >
                  <Icon kind={w.startsWith('widget:') ? '' : w} size={14} />
                  {WIDGET_LABEL(w)}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      <BarEdge side={p.side} width={p.width} onWidth={p.onWidth} onSizing={setSizing} t={p.t} />
    </nav>
  );
}

/** The edge between an icon bar and its sidebar (ticket 283, back in 1052): drag or arrows widen and narrow both bars (the
 *  label steps follow), double-click or Home puts the default back. The default is also the narrowest. */
function BarEdge({ side, width, onWidth, onSizing, t }: { side: Side; width: number; onWidth: (w: number | null) => void; onSizing: (on: boolean) => void; t: T }) {
  const clamp = (v: number) => Math.min(BAR_MAX, Math.max(BAR_W, Math.round(v)));
  const drag = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget;
    const [x0, w0] = [e.clientX, width];
    onSizing(true);
    resizing(el, e.pointerId, (ev) => onWidth(clamp(w0 + (side === 'left' ? ev.clientX - x0 : x0 - ev.clientX))), () => onSizing(false));
  };
  const key = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const grow = side === 'left' ? 'ArrowRight' : 'ArrowLeft';
    const shrink = side === 'left' ? 'ArrowLeft' : 'ArrowRight';
    if (e.key === 'Home') return (e.preventDefault(), onWidth(null));
    const dx = e.key === grow ? BAR_STEP : e.key === shrink ? -BAR_STEP : 0;
    if (dx) (e.preventDefault(), onWidth(clamp(width + dx)));
  };
  return (
    <div
      className="bdiv"
      data-side={side}
      role="separator"
      aria-orientation="vertical"
      aria-label={t('shell.chrome.barEdge')}
      aria-valuenow={width}
      aria-valuemin={BAR_W}
      aria-valuemax={BAR_MAX}
      tabIndex={0}
      title={t('shell.chrome.barEdgeTitle', { width: BAR_W })}
      onPointerDown={drag}
      onKeyDown={key}
      onDoubleClick={() => onWidth(null)}
    />
  );
}
