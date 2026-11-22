// V2.5-69 (ticket 289, needs 208): the Board's view-options menu. The toolbar keeps search, project and + Card; the lane
// choice, the filters, the Idle column, the colour key and the agent CLI hint live here. A WAI-ARIA menu button: the first
// item takes focus on open, arrows move (wrapping), Home and End jump, Esc closes back to the button, a press outside closes.
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Icon } from '../icons/Icon';
import type { T } from './Board';
import { CliLine, ColourKey } from './Strip';
import type { Filters } from './model';
import type { Mode, WatchLanes } from './views';

const ITEMS = '[role="menuitemradio"], [role="menuitemcheckbox"]';

export function ViewOptions({ t, mode, lanes, showIdle, filters, onMode, onLanes, onIdle, onFilters }: { t: T; mode: Mode; lanes: WatchLanes; showIdle: boolean; filters: Filters; onMode: (m: Mode) => void; onLanes: (l: WatchLanes) => void; onIdle: (on: boolean) => void; onFilters: (f: Filters) => void }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const cli = useId();
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const items = () => [...(list.current?.querySelectorAll<HTMLElement>(ITEMS) ?? [])];
  useEffect(() => {
    if (!open) return;
    items()[0]?.focus();
    const outside = (e: PointerEvent) => !list.current?.contains(e.target as Node) && !button.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener('pointerdown', outside, true);
    return () => window.removeEventListener('pointerdown', outside, true);
  }, [open]);
  const onKey = (e: KeyboardEvent) => {
    const all = items();
    const at = all.indexOf(document.activeElement as HTMLElement);
    const to = { ArrowDown: (at + 1) % all.length, ArrowUp: (at - 1 + all.length) % all.length, Home: 0, End: all.length - 1 }[e.key];
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      button.current?.focus();
    } else if (to !== undefined && all.length) {
      e.preventDefault();
      all[to].focus();
    }
  };
  const radio = (name: string, on: boolean, set: () => void) => (
    <button key={name} type="button" role="menuitemradio" tabIndex={-1} aria-checked={on} onClick={set}>
      {name}
    </button>
  );
  const check = (name: string, on: boolean, set: () => void) => (
    <button key={name} type="button" role="menuitemcheckbox" tabIndex={-1} aria-checked={on} onClick={set}>
      {name}
    </button>
  );
  const watch = mode === 'watch';
  return (
    <span className="bvo">
      <button ref={button} type="button" className="btn" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(!open)}>
        {t('board.watch.options')} <Icon name="triangle-down" size={12} />
      </button>
      {open && (
        <div ref={list} id={id} className="bvomenu" role="menu" aria-label={t('board.watch.options')} onKeyDown={onKey}>
          {radio(t('board.watch.opt.watch'), watch, () => onMode('watch'))}
          {radio(t('board.watch.opt.columns'), !watch, () => onMode('columns'))}
          {watch && (
            <>
              <hr />
              {radio(t('board.watch.opt.lanesAuto'), lanes === 'auto', () => onLanes('auto'))}
              {radio(t('board.watch.opt.lanesProject'), lanes === 'project', () => onLanes('project'))}
              {radio(t('board.watch.opt.lanesNone'), lanes === 'none', () => onLanes('none'))}
              <hr />
              {check(t('board.watch.opt.you'), filters.you, () => onFilters({ ...filters, you: !filters.you }))}
              {check(t('board.watch.opt.stale'), filters.stale, () => onFilters({ ...filters, stale: !filters.stale }))}
              {check(t('board.watch.opt.missing'), filters.missing, () => onFilters({ ...filters, missing: !filters.missing }))}
              {check(t('board.watch.opt.idle'), showIdle, () => onIdle(!showIdle))}
              <hr />
              <ColourKey t={t} />
              <div className="bvocli" id={cli}>
                {t('board.watch.opt.cli')} <CliLine t={t} id={`${cli}-verbs`} bare />
              </div>
            </>
          )}
        </div>
      )}
    </span>
  );
}
