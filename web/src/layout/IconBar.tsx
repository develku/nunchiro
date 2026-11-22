// One icon bar (LAYOUT D5b, ICONBAR): a column of icon-size slots, like a phone's home screen. An icon sits in any slot,
// empty slots stay empty, and a slot cut off by a short window puts its icon behind the ⋯ button. In edit mode every
// icon drags to any slot (an occupied slot swaps) and shows ✕ (the tree, Decisions, Settings and Layout show none:
// they move but never leave, needs 162); Alt+arrows and Delete are the keyboard path (WCAG 2.5.7).
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { FIXED, isRequired, SLOTS, WIDGET_LABEL, type Side, type Slot } from './bars';
import type { T } from '../i18n';
import { useNeedsYou } from '../board/useBoardRail';
import { Icon as Oct } from '../icons/Icon';
import { Icon, glyph } from './icons';
import './rails.css';

export { glyph } from './icons';
export { Icon };

/** The command whose binding gives an icon its hint key (hintLabels.ts ICONS). */
const HINT: Record<string, string> = { tree: 'sidebar.left.toggle', files: 'files.show', search: 'search.open', diff: 'diff.open', preview: 'preview.toggle', terminal: 'pane.toggle', board: 'board.toggle', artifacts: 'artifacts.toggle', settings: 'settings.open', layout: 'layout.edit' };

const MOVE = 4;
/** Ticket 1041: a slot's height with its gap, the mockup's 32 px button and 4 px gap (rails.css `.ib .slot`). */
const SLOT_H = 32 + 4;
/** The bar's padding (4 top, 8 bottom) plus the hide / show button at its top with its gap (rails.css `.ib .sidebtn`). */
const PAD = 12 + 36;

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
  /** The window's catalogue lookup. */
  t: T;
}

/** A panel with a rail at one side (Lucide's PanelLeft / PanelRight shape, ISC, as in MonoCode's title bar): the hide / show button. */
function PanelIcon({ side }: { side: Side }) {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d={side === 'left' ? 'M9 3v18' : 'M15 3v18'} />
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
    const measure = () => setCap(Math.max(1, Math.floor((el.clientHeight - PAD) / SLOT_H)));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
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

  const sideKey = `shell.chrome.${p.sideOpen ? 'hide' : 'show'}${p.side === 'left' ? 'Left' : 'Right'}` as const;
  return (
    <nav ref={nav} className={`ib ${p.side === 'left' ? 'l' : 'r'}`} aria-label={label} data-bar={p.side} data-hint-region={p.side} data-editing={p.editing}>
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
      {p.slots.slice(0, shown).map((w, i) => (
        <div className={`slot${w && p.dragging !== w ? '' : ' empty'}`} data-slot={i} key={i}>
          {w && item(w)}
        </div>
      ))}
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
    </nav>
  );
}
