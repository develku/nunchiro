// V2.5-37 (draft B): the header's state key and coordinator indicator with its CLI verbs line, and the strip
// under it: lane key segmented control and the filter chips.
import { PLAIN } from '../plainText';
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Icon } from '../icons/Icon';
import { composing } from '../keys';
import { RowIcon } from '../tree/RowIcon';
import type { Session } from '../types';
import { sessionName } from '../Sidebar';
import { LANE_KEYS, type Filters, type LaneKey } from './model';
import type { T } from './Board';
import { STALE_MIN } from './tasks';

/**
 * V2.5-82: the key names a state by its cue (the hand, the clock and the x-circle the cards and tree rows draw) and paints
 * the cue in the live theme's token, so a theme that repaints your turn or stale never makes the words wrong.
 */
export function ColourKey({ t }: { t: T }) {
  return (
    <span className="bkey" role="group" aria-label={t('board.legend.label')}>
      <span data-k="you"><i aria-hidden><RowIcon kind="hand" /></i>{t('board.task.yourTurn')}</span>
      <span data-k="stale"><i aria-hidden><Icon name="clock" size={12} /></i>{t('board.word.stale')}</span>
      <span data-k="bad"><i aria-hidden><RowIcon kind="fail" /></i>{t('board.list.broken')}</span>
    </span>
  );
}

/** A chip's close mark. In a span so the window's 24px floor for icon-only buttons (chrome.css) leaves the chip as tall as its neighbours. */
const XMark = () => (
  <span aria-hidden>
    <Icon name="x" size={12} />
  </span>
);

/** C7b: the board search field. Esc clears and keeps focus in the field; the clear button clears and returns focus to it. */
export function SearchField({ t, value, onChange }: { t: T; value: string; onChange: (q: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const clear = () => (onChange(''), input.current?.focus());
  return (
    <span className="bsearch field-box">
      <input {...PLAIN}
        ref={input}
        type="text"
        value={value}
        aria-label={t('board.search.label')}
        placeholder={t('board.search.placeholder')}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== 'Escape' || composing(e.nativeEvent) || !value) return;
          e.preventDefault();
          e.stopPropagation();
          clear();
        }}
      />
      {value && (
        <button type="button" className="bsclear" aria-label={t('board.search.clear')} title={t('board.search.clear')} onClick={clear}>
          <Icon name="x" size={12} />
        </button>
      )}
    </span>
  );
}

const SLOT = '\u0000'; // where the name sits in the translated label

export function Coordinator({ t, coord, open, onToggle, cli, onOpen }: { t: T; coord: { session: Session; children: number }; open: boolean; onToggle: () => void; cli: string; onOpen: (id: string) => void }) {
  // needs 171: the name is a button that opens the coordinator session; the words around it stay the translation's.
  const name = sessionName(coord.session);
  const [before, after = ''] = t('board.coord.label', { label: SLOT }).split(SLOT);
  return (
    <span className="bcoord" title={t('board.coord.hint')}>
      {before}
      <button type="button" className="bcoordn" onClick={() => onOpen(coord.session.id)}>
        {name}
      </button>
      {after} <i>{t('board.coord.children', { n: coord.children })}</i>
      <button type="button" className="bclib" aria-expanded={open} aria-controls={cli} onClick={onToggle}>
        {t('board.coord.cli')}
      </button>
    </span>
  );
}

/** `nunchiro board list|create|move|done|note|self` (ticket 183's verbs, 289's create and note): commands, not words, so never translated. */
const VERBS = ['nunchiro board list', 'create', 'move', 'done', 'note', 'self'];
/** `bare`: only the verbs (the view-options menu has its own sentence before them). */
export function CliLine({ t, id, bare = false }: { t: T; id: string; bare?: boolean }) {
  return (
    <div className="bcli" id={id}>
      {!bare && t('board.coord.writes')}
      {VERBS.map((v) => (
        <code key={v}>{v}</code>
      ))}
      {!bare && <span>{t('board.coord.noImport')}</span>}
    </div>
  );
}

export function Strip({ t, first, threshold = STALE_MIN, lane, filters, roles, onLane, onFilters, onAddCard }: { t: T; first: string; threshold?: number; lane: LaneKey; filters: Filters; roles: string[]; onLane: (k: LaneKey) => void; onFilters: (f: Filters) => void; onAddCard: () => void }) {
  const chip = (key: 'you' | 'stale' | 'missing' | 'hideIdle', label: string) => (
    <button type="button" className="bfc" aria-pressed={filters[key]} onClick={() => onFilters({ ...filters, [key]: !filters[key] })}>
      {label}
      {filters[key] && <XMark />}
    </button>
  );
  const lanesId = useId();
  const menuId = useId();
  const [menu, setMenu] = useState(false);
  // WAI-ARIA menu button: the first item takes focus on open, arrows move (wrapping), Home/End jump, Esc closes back to
  // the button, a pointer-down outside closes.
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLSpanElement>(null);
  const items = () => [...(list.current?.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]') ?? [])];
  // The first item takes focus when the menu opens; a menu that opens with none holds focus itself until the first items
  // arrive (roles come from the polled board). Opening never checks where focus was: WebKit (Safari, the app's WKWebView)
  // does not focus a clicked button, so focus may still sit in a terminal or the composer (ticket 478).
  useEffect(() => {
    if (menu) (items()[0] ?? list.current)?.focus();
  }, [menu]);
  // Focus the user moved into the menu, or out of it by Tab, is left where it is: only the empty menu, the body or the
  // menu's own button gives way (ticket 297 item 9).
  useEffect(() => {
    const at = document.activeElement;
    if (menu && (!at || at === document.body || at === button.current || at === list.current)) items()[0]?.focus();
  }, [roles.length]);
  useEffect(() => {
    if (!menu) return;
    const outside = (e: PointerEvent) => !list.current?.contains(e.target as Node) && !button.current?.contains(e.target as Node) && setMenu(false);
    window.addEventListener('pointerdown', outside, true);
    return () => window.removeEventListener('pointerdown', outside, true);
  }, [menu]);
  const menuKey = (e: KeyboardEvent) => {
    const all = items();
    const at = all.indexOf(document.activeElement as HTMLElement);
    const to = { ArrowDown: (at + 1) % all.length, ArrowUp: (at - 1 + all.length) % all.length, Home: 0, End: all.length - 1 }[e.key];
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setMenu(false);
      button.current?.focus();
    } else if (to !== undefined && all.length) {
      e.preventDefault();
      all[to].focus();
    }
  };
  const toggleRole = (r: string) => onFilters({ ...filters, role: filters.role.includes(r) ? filters.role.filter((x) => x !== r) : [...filters.role, r] });
  return (
    <div className="bstrip">
      <span id={lanesId}>{t('board.lane.key')}</span>
      <span className="bseg" role="group" aria-labelledby={lanesId}>
        {LANE_KEYS.map((k) => (
          <button key={k} type="button" aria-pressed={lane === k} onClick={() => onLane(k)}>
            {t(`board.lane.by.${k}`)}
          </button>
        ))}
      </span>
      <span className="bflt">
        <svg viewBox="0 0 24 24" aria-hidden><path d="M3 5h18l-7 8v6l-4 2v-8z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" /></svg>
        {t('board.filter.label')}
      </span>
      {chip('you', t('board.filter.you'))}
      {filters.role.length > 0 && (
        // Draft B: one chip names the roles shown; its x clears them.
        <button type="button" className="bfc" aria-pressed="true" onClick={() => onFilters({ ...filters, role: [] })}>
          {t('board.filter.roleIs', { role: filters.role.join(', ') })}
          <XMark />
        </button>
      )}
      {chip('stale', t('board.filter.stale'))}
      {chip('missing', t('board.filter.missing'))}
      {chip('hideIdle', t('board.filter.hideIdle'))}
      <span className="bfadd-wrap">
        <button ref={button} type="button" className="bfc bfadd" aria-expanded={menu} aria-controls={menuId} aria-haspopup="menu" onClick={() => setMenu(!menu)}>
          {t('board.filter.add')}
        </button>
        {menu && (
          <span ref={list} className="bfmenu" role="menu" tabIndex={-1} id={menuId} aria-label={t('board.filter.role')} onKeyDown={menuKey}>
            {roles.length === 0 && (
              <>
                <span className="bfnone">{t('board.filter.noRoles')}</span>
                {/* Ticket 569: a role comes from a session started on a card, so the card editor (the board's own + Card) is the way in. */}
                <button type="button" onClick={() => (setMenu(false), onAddCard())}>
                  {t('board.addCard')}
                </button>
              </>
            )}
            {roles.map((r) => (
              <button key={r} type="button" role="menuitemcheckbox" tabIndex={-1} aria-checked={filters.role.includes(r)} onClick={() => toggleRole(r)}>
                {t('board.filter.roleIs', { role: r })}
              </button>
            ))}
          </span>
        )}
      </span>
      <span className="bsp" />
      <span className="bhint">{t('board.strip.hint', { column: first, n: threshold })}</span>
    </div>
  );
}
