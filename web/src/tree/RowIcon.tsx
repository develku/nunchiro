// TREEROWS: the row icons (GitHub-style outline, stroke 2, round caps, currentColor) and the row pieces that render
// without the sidebar's state, so a spec can render them node side. Paths are the approved mockup's (v2-8a-d).
import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { age, type RowState } from '../tree';
import { enT, type T } from './state';
import { isLevel, LevelMark, pairShort, seatText, type Pair } from '../lead/level';
import { useReported } from '../chat/ContextRing';
import type { Session } from '../types';
import { isCut } from '../Tooltip';
import { CacheTimer } from './CacheTimer'; // ticket 257

export const ICONS = ['hand', 'ask', 'fail', 'work', 'pr', 'merge', 'new', 'gone', 'stale', 'idle', 'limit', 'done', 'rest'] as const;
export type IconKind = (typeof ICONS)[number];

// Ticket 462 (owner 11-12, supersedes TREEROWS 10-27 for these): hand, ask, stale and idle are the approved 388 mockup's
// <symbol>s (docs/design/m3-1110/388.html: hand, question, sync, dashed) as written there.
const PATHS: Record<IconKind, ReactNode> = {
  hand: <path d="M18 11V6a2 2 0 0 0-4 0M14 10V4a2 2 0 0 0-4 0v2M10 10.5V6a2 2 0 0 0-4 0v8M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.9-6-2.3l-3.6-3.6a2 2 0 0 1 2.8-2.8L7 15" />,
  ask: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01" />
    </>
  ),
  fail: (
    <>
      <circle cx="12" cy="12" r="9.5" />
      <path d="M15.2 8.8l-6.4 6.4M8.8 8.8l6.4 6.4" />
    </>
  ),
  work: (
    <>
      <circle cx="12" cy="12" r="8.5" opacity=".25" />
      <circle className="arc" cx="12" cy="12" r="8.5" pathLength="100" strokeDasharray="28 100" />
    </>
  ),
  pr: (
    <>
      <circle cx="6" cy="5.5" r="2.3" />
      <circle cx="6" cy="18.5" r="2.3" />
      <circle cx="18" cy="18.5" r="2.3" />
      <path d="M6 7.8v8.4" />
      <path d="M18 16.2V9.5a3 3 0 0 0-3-3h-3.5" />
      <path d="M13.8 4 11.3 6.5 13.8 9" />
    </>
  ),
  merge: (
    <>
      <circle cx="6" cy="5" r="2.3" />
      <circle cx="6" cy="19" r="2.3" />
      <circle cx="18" cy="12" r="2.3" />
      <path d="M6 7.3v9.4" />
      <path d="M6 8c0 2.6 3.4 4 9.7 4" />
    </>
  ),
  // The grey branch icon: a new worktree, and (added by this lane) a finished or idle one.
  new: (
    <>
      <circle cx="6" cy="5" r="2.3" />
      <circle cx="6" cy="19" r="2.3" />
      <circle cx="18" cy="7" r="2.3" />
      <path d="M6 7.3v9.4" />
      <path d="M18 9.3c0 4.2-6.5 4-11.2 7.6" />
    </>
  ),
  gone: <path strokeDasharray="3 2.6" d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
  // No output for a while: the mockup's sync arrow.
  stale: <path d="M21 12a9 9 0 1 1-9-9c2.5 0 4.9 1 6.7 2.7L21 8M21 3v5h-5" />,
  // A live session doing nothing: the mockup's dashed circle. A finished one that still shows (`RowState.rest`) is `done`.
  idle: <circle cx="12" cy="12" r="9" strokeDasharray="3 3.1" />,
  // Ticket 372: a usage limit, the 372 mockup's clock (option A).
  limit: (
    <>
      <circle cx="12" cy="12" r="9.5" />
      <path d="M12 7v5l3.5 2" />
    </>
  ),
  // Look 1117 v11 A-S3-6: a finished row that still shows, a check circle; the branch stays the worktree's own.
  done: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M8.5 12.5l2.5 2.5 4.5-5" />
    </>
  ),
  // Ticket 1022 (mockup tree-done-1121 4b): a finished session in the hollow bars' popover and in History, the idle ring.
  rest: <circle cx="12" cy="12" r="8" />,
};

/** Tooltip warm-up: a hover tooltip that has shown (400 ms, tree.css) keeps the tree warm for a second, and the next row
 *  the pointer enters shows its own at once, as native tooltips do. One clock for every row of the window. */
const TIP_WAIT = 400;
let warmUntil = 0;

export function RowIcon({ kind }: { kind: IconKind }) {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" data-icon={kind}>
      {PATHS[kind]}
    </svg>
  );
}

export interface WtRowProps {
  name: string;
  /** Under a folded group the row also names its project (mockup ③ "lumen · rehfix"); only the session tail elides. */
  pre?: string;
  state: RowState;
  /** The session this row opens (and the menus act on). */
  sessionId?: string;
  selected?: boolean;
  /** A muted sub-row of the clean-up line. */
  sub?: boolean;
  /** V2-8e: several decisions pending from this row's session (details only, no allow-all). */
  count?: number;
  onOpen?: () => void;
  /** The context-menu surface (default `tree`); a managed worktree's row passes `worktree`. */
  menu?: string;
  /** Named in the context menu's header. */
  menuTitle?: string;
  /** A waiting row says how long it has waited, as ko/hiderows-r6.html draws it (`.row .tm`). */
  since?: number;
  /** Ticket 377: the key that opens this session's tab (`⌘2`); drawn only while ⌘ is held (`data-held-tab` on the root). */
  jumpKey?: string;
  /** Ticket 990: a tag after the name (a Home lead's "Lead") and a quiet word before the icon ("not running"). */
  tag?: string;
  note?: string;
  /** Ticket 992: a seat's session, for its level's bars at the row's quiet end; ticket 994: with the model and effort it
   *  runs after them. */
  seat?: Session;
  /** Ticket 257: the row's sessions, for the prompt-cache countdown (the one with the least time left). */
  cacheIds?: string[];
  t?: T;
}

/** needs 72: the element's text is wider than its box (an ellipsis is showing). */

/**
 * A project head's name button: its native tooltip is the folder path, led by the whole name when the head cuts it
 * (measured when the pointer or focus arrives). A name that fits keeps the path alone.
 */
export function HeadName({ name, path, children, ...rest }: { name: string; path: string } & ButtonHTMLAttributes<HTMLButtonElement>) {
  const [cut, setCut] = useState(false);
  const measure = (e: { currentTarget: HTMLElement }) => setCut(isCut(e.currentTarget.querySelector('b')) || isCut(e.currentTarget));
  return (
    <button {...rest} className="n" title={cut ? `${name}\n${path}` : path} onPointerEnter={measure} onFocus={measure}>
      {children}
    </button>
  );
}

/** Ticket 1041 (A+B+C, C): the row's state light by tone (light-glass.css): working travels along the bottom, your turn,
 *  broken and a limit light the row's left edge. Other tones have no light; their icon says the state. */
const LIGHT: Partial<Record<RowState['tone'], string>> = { run: 'light-run', you: 'light-you light-edge', bad: 'light-bad light-edge', warn: 'light-limited light-edge' };

/** One worktree row: its state light, name, optional `#53`, the 11 px state word (ticket 1041, owner 11-22: "needs you",
 *  "failed", "Limit"; a working row's word is its age), one icon; the tooltip and the label keep the whole words. */
export function WtRow({ name, pre, state, sessionId, selected, sub, count, onOpen, menu = 'tree', menuTitle, since, jumpKey, tag, note, seat, cacheIds, t = enT }: WtRowProps) {
  const [tap, setTap] = useState(false); // touch has no hover or focus ring: a tap shows the tooltip until the next tap elsewhere
  const [off, setOff] = useState(false); // Escape hides it until the pointer or focus comes back
  const [hot, setHot] = useState(false); // pointer or focus is on the row: Escape is listened for on the window, as the app's tooltip does
  const [warm, setWarm] = useState(false);
  const entered = useRef(0);
  const row = useRef<HTMLButtonElement>(null);
  const nm = useRef<HTMLSpanElement>(null);
  const [cut, setCut] = useState(false); // needs 72: the name is cut by the row's width, measured when the pointer or focus comes
  const measure = () => setCut(isCut(nm.current));
  const touched = useRef(false); // the last press was a touch: the first tap shows the tooltip, the next one opens
  useEffect(() => {
    if (!tap) return;
    const away = (e: PointerEvent) => !row.current?.contains(e.target as Node) && setTap(false);
    document.addEventListener('pointerdown', away, true);
    return () => document.removeEventListener('pointerdown', away, true);
  }, [tap]);
  useEffect(() => {
    if (!hot) return;
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && (setOff(true), setTap(false));
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [hot]);
  // The tip's words come from the tree model, not the catalogue yet. The row's own label hides its children, so the "!"
  // badge's meaning rides in it (ticket 412).
  const level = seat && isLevel(seat.level) ? seat.level : undefined;
  const effort = useReported(seat?.id, 'effort');
  const runs = level && seat ? seatText(t, seat, undefined, effort) : '';
  const tips = [...state.tip, state.skip, runs && t('level.runs', { pair: runs })].filter(Boolean).join('. ');
  const label = count ? t('tree.row.labelWaiting', { name, count, tips }) : t('tree.row.label', { name, tips });
  return (
    <button
      ref={row}
      className={`row wt2 ${state.tone}${sub ? ' sub' : LIGHT[state.tone] ? ` ${LIGHT[state.tone]}` : ''}`}
      data-kind={state.kind}
      data-skip={state.skip ? true : undefined}
      data-menu={sub ? undefined : menu}
      data-menu-session={sessionId}
      data-menu-title={menuTitle}
      data-hint-kind="agent"
      data-hint-session={sessionId}
      data-tap={tap || undefined}
      data-off={off || undefined}
      data-warm={warm || undefined}
      aria-current={selected ? 'true' : undefined}
      aria-label={label}
      onClick={() => (touched.current && !tap ? setTap(true) : onOpen?.())}
      onPointerDown={(e) => (touched.current = e.pointerType === 'touch')}
      onKeyDown={() => (touched.current = false)} // the click Enter or Space fires is a key press, not a second touch tap
      onPointerEnter={() => (measure(), setOff(false), setHot(true), setWarm(Date.now() < warmUntil), (entered.current = Date.now()))}
      // Look 1117 v3: the pointer leaving takes the tip with it, even while the row keeps the focus (a menu, the right bar).
      onPointerLeave={() => (setHot(false), setOff(true), setWarm(false), Date.now() - entered.current >= TIP_WAIT && (warmUntil = Date.now() + 1000))}
      onContextMenu={() => setOff(true)}
      onFocus={() => (measure(), setOff(false), setHot(true))}
      onBlur={() => (setHot(false), setOff(false))}
    >
      <span className="n">
        {pre && <span className="pre">{pre} · </span>}
        <span className="nm wordcut" ref={nm}>
          {name}
          {state.pr !== undefined && <i className="prn"> #{state.pr}</i>}
        </span>
        {tag && <span className="lead-tag">{tag}</span>}
        {state.skip && (
          <span className="skipm" role="img" aria-label={state.skip} title={state.skip}>
            !
          </span>
        )}
      </span>
      {/* Ticket 1041 (mockup polish-1121): a your-turn row shows its word, not its age ("asked 4 min ago" stays in the tip
          and the label); a working row's age is its word. */}
      {since !== undefined && state.tone !== 'you' && <span className="tm">{age(t, Date.now() - since)}</span>}
      {/* Ticket 1041: one 11 px state word slot; "Limit" was the only one before. The your-turn age stays beside it. */}
      {!sub && (state.tone === 'you' || state.tone === 'bad' || state.kind === 'limit') && <span className={`sw${state.kind === 'limit' ? ' tm lim' : ''}`} data-word={state.tone}>{t(state.tone === 'you' ? 'lead.state.needs' : state.tone === 'bad' ? 'tree.status.failed' : 'limit.row')}</span>}
      {note && <span className="tm">{note}</span>}
      {cacheIds && <CacheTimer ids={cacheIds} t={t} /> /* ticket 257 */}
      {count !== undefined && <span className="two">{count}</span>}
      {level && seat && <LevelMark t={t} level={level} text={runs} short={pairShort(seat.kind, seat as Pair, seat.acp_agent)} />}
      {/* Ticket 1041 (C): the working arc is the row's travelling light now, and an idle row is bare (owner 11-22: the
          dashed circle was a picture only; "idle" stays in the tip and the label). Every other state keeps its glyph. */}
      {state.kind !== 'work' && !(state.kind === 'idle' && !state.rest) && (
        <span className="ic">
          <RowIcon kind={state.kind === 'idle' && state.rest ? 'done' : state.kind} />
        </span>
      )}
      {jumpKey && (
        <kbd className="kbd tkey" aria-hidden>
          {jumpKey}
        </kbd>
      )}
      <span className="tip glass" aria-hidden="true">
        {/* needs 72: the whole name leads the tip when (and only when) the row cuts it; the state lines stay below it */}
        {cut && (
          <>
            <b className="full">{name}</b>
            <br />
          </>
        )}
        <b>{state.tip[0]}</b>
        {state.tip[1] && (
          <>
            <br />
            {state.tip[1]}
          </>
        )}
        {/* look 1117: the "!" mark's meaning, where the pointer's tip shows it */}
        {state.skip && (
          <>
            <br />
            {state.skip}
          </>
        )}
      </span>
    </button>
  );
}

/** "Ready to clean up (N)": a closed fold at the end of a project's rows. The button is drawn only when the parent passes `onCleanUp` (the sheet is V2-8a). */
export function CleanupLine({ items, open, onToggle, onCleanUp, t = enT }: { items: (WtRowProps & { key: string })[]; open: boolean; onToggle: (open: boolean) => void; onCleanUp?: () => void; t?: T }) {
  if (!items.length) return null;
  return (
    <details className="cleanup" open={open} onToggle={(e) => e.currentTarget.open !== open && onToggle(e.currentTarget.open)}>
      <summary>
        <span className="chev" aria-hidden="true">{open ? '▾' : '▸'}</span>
        <span>{t('tree.cleanup.summary', { n: items.length })}</span>
        {/* Keep the separator and action together on the single cleanup line (needs 130). */}
        {onCleanUp && (
          <span className="cua">
            {' · '}
            <button className="cu" onClick={(e) => (e.preventDefault(), e.stopPropagation(), onCleanUp())}>
              {t('tree.cleanup.action')}
            </button>
          </span>
        )}
      </summary>
      {items.map(({ key, ...r }) => (
        <WtRow key={key} t={t} {...r} sub />
      ))}
    </details>
  );
}

/** A project or group head's colour bar, folded or open (needs 196): one 3x12 segment per row, then `+N`. Decoration; the counts and the label carry the words. */
export function Bar({ tones, more }: { tones: RowState['tone'][]; more: number }) {
  if (!tones.length) return null;
  return (
    <span className="bar" aria-hidden="true">
      {tones.map((t, i) => (
        <i key={i} className="seg" data-tone={t} />
      ))}
      {more > 0 && <span className="plus">+{more}</span>}
    </span>
  );
}
