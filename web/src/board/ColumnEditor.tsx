// Column edits (add, rename, reorder, delete, "needs decision", states taken). Each change writes board.toml at
// once through `board_columns_put`; the core edits only the changed column's bytes. V2.5-38: the same editor sits in
// the board's edit panel (`embedded`: a section, not a dialog) and rows reorder by dragging their handle too.
import { PLAIN } from '../plainText';
import { useState } from 'react';
import { imeEnter } from './CardEditor';
import { columnTitle, freshColumnId, STATES, type Column, type State } from './model';
import type { T } from './Board';
import { lineError } from '../errors';

const bytes = (s: string) => new TextEncoder().encode(s).length;
/** Class names and roles (data, not words): the editor as a dialog, or as a section of the edit panel. */
const AS_DIALOG = { className: 'bedit bcoled', role: 'dialog' } as const;
const AS_SECTION = { className: 'bcoled bepcols' } as const;
const TODO_MARK = 'todo'; // the To do column claims no state

const Section = (p: React.HTMLAttributes<HTMLElement>) => <section {...p} />;
const Div = (p: React.HTMLAttributes<HTMLDivElement>) => <div {...p} />;

export function ColumnEditor({ t, columns, onPut, onClose, embedded = false }: { t: T; columns: Column[]; onPut: (c: Column[]) => Promise<void>; onClose: () => void; embedded?: boolean }) {
  const [titles, setTitles] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [dragged, setDragged] = useState<number | null>(null);
  // Draft B: in the edit panel a row is one line (handle, mark, title, states); "Claimed states…" opens the rest.
  const [more, setMore] = useState(false);
  const [last, setLast] = useState(0);
  const detail = !embedded || more;
  const put = async (next: Column[]) => {
    setError('');
    try {
      await onPut(next);
      setTitles({});
    } catch (e) {
      setError(lineError(t, e));
    }
  };
  const change = (i: number, patch: Partial<Column>) => void put(columns.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const rename = (i: number) => {
    const title = titles[columns[i].id];
    if (title === undefined || title === columns[i].title) return;
    if (!title.trim() || bytes(title) > 256) return setError(t('board.cols.errTitle'));
    if (columns.some((c, j) => j !== i && c.title.trim() === title.trim())) return setError(t('board.cols.errSame', { title: title.trim() }));
    change(i, { title });
  };
  /** needs 172: only Enter saves a title; Esc and leaving the field put the saved one back (module-local choice a). */
  const revert = (id: string) =>
    setTitles((cur) => {
      const next = { ...cur };
      delete next[id];
      return next;
    });
  const titleKey = (e: React.KeyboardEvent, i: number) => {
    if (imeEnter(e)) return;
    if (e.key === 'Enter') (e.preventDefault(), rename(i));
    // An unsaved title is reverted and the editor stays; with nothing to revert Esc closes it as before.
    else if (e.key === 'Escape' && titles[columns[i].id] !== undefined) (e.preventDefault(), e.stopPropagation(), revert(columns[i].id));
    // The keyboard path to reorder, folded rows included (their arrow buttons sit under "Claimed states…").
    else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      const by = e.key === 'ArrowUp' ? -1 : 1;
      if (columns[i + by]) move(i, by);
    }
  };
  // A state belongs to one column: taking it here releases it elsewhere.
  const take = (i: number, s: State, on: boolean) =>
    void put(columns.map((c, j) => (j === i ? { ...c, states: on ? STATES.filter((x) => x === s || c.states.includes(x)) : c.states.filter((x) => x !== s) } : { ...c, states: on ? c.states.filter((x) => x !== s) : c.states })));
  const move = (i: number, by: number) => {
    const next = [...columns];
    [next[i], next[i + by]] = [next[i + by], next[i]];
    void put(next);
  };
  const [over, setOver] = useState<number | null>(null);
  /**
   * A row's handle dragged onto another row takes its place; the rest keep their order. Pointer events, like the card
   * drag (drag.tsx): WebKit, the app's engine, is where HTML drag and drop is least dependable.
   */
  const grab = (from: number) => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    setDragged(from);
    const rowAt = (x: number, y: number) => {
      const row = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-column-row]');
      const i = row ? columns.findIndex((c) => c.id === row.dataset.columnRow) : -1;
      return i < 0 ? null : i;
    };
    const move = (m: PointerEvent) => setOver(rowAt(m.clientX, m.clientY));
    const up = (u: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      const to = u.type === 'pointercancel' ? null : rowAt(u.clientX, u.clientY);
      setDragged(null);
      setOver(null);
      if (to === null || to === from) return;
      const next = columns.filter((_, j) => j !== from);
      next.splice(to, 0, columns[from]);
      void put(next);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up); // a cancelled drag writes nothing
  };
  const Shell = embedded ? Section : Div;
  return (
    <Shell {...(embedded ? AS_SECTION : AS_DIALOG)} aria-label={embedded ? undefined : t('board.columns')} onKeyDown={embedded ? undefined : (e: React.KeyboardEvent) => e.key === 'Escape' && !imeEnter(e) && (e.stopPropagation(), onClose())}>
      {!embedded && (
        <div className="brow">
          <b>{t('board.columns')}</b>
          <span className="dim">{t('board.cols.written')}</span>
          <span className="sp" />
          <button className="btn" onClick={onClose}>
            {t('board.cols.close')}
          </button>
        </div>
      )}
      <ol>
        {columns.map((c, i) => (
          <li key={c.id} data-column-row={c.id} data-dragging={dragged === i || undefined} data-drop={dragged !== null && over === i && dragged !== i ? 'true' : undefined}>
            <span className="bgrip" title={t('board.cols.drag', { n: i + 1 })} aria-hidden onPointerDown={grab(i)}>
              ⋮⋮
            </span>
            <i className="bsw" data-state={c.states[0] ?? TODO_MARK} aria-hidden />
            <input {...PLAIN}
              aria-label={t('board.cols.titleOf', { n: i + 1 })}
              value={titles[c.id] ?? columnTitle(t, c)}
              onChange={(e) => setTitles({ ...titles, [c.id]: e.target.value })}
              onFocus={() => setLast(i)}
              onBlur={() => revert(c.id)}
              onKeyDown={(e) => titleKey(e, i)}
              aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
            />
            {!detail && <span className="bslug">{[c.states.map((s) => t(`board.state.${s}`)).join(', '), i === 0 && t('board.edit.newCards')].filter(Boolean).join(' · ')}</span>}
            {detail && <>
            <label title={t('board.cols.decisionHint')}>
              <input type="checkbox" checked={c.needs_decision} onChange={(e) => change(i, { needs_decision: e.target.checked })} /> {t('board.cols.decision')}
            </label>
            <span className="bstates" role="group" aria-label={t('board.cols.statesOf', { n: i + 1 })}>
              <span className="dim">{t('board.cols.takes')}</span>
              {STATES.map((s) => (
                <label key={s}>
                  <input type="checkbox" checked={c.states.includes(s)} onChange={(e) => take(i, s, e.target.checked)} /> {t(`board.state.${s}`)}
                </label>
              ))}
            </span>
            <button className="btn" aria-label={t('board.cols.moveLeft', { n: i + 1 })} disabled={i === 0} onClick={() => move(i, -1)}>
              ←
            </button>
            <button className="btn" aria-label={t('board.cols.moveRight', { n: i + 1 })} disabled={i === columns.length - 1} onClick={() => move(i, 1)}>
              →
            </button>
            <button className="btn" aria-label={t('board.cols.delete', { n: i + 1 })} disabled={columns.length === 1} title={columns.length === 1 ? t('board.cols.keepOne') : undefined} onClick={() => void put(columns.filter((_, j) => j !== i))}>
              ✕
            </button>
            </>}
          </li>
        ))}
      </ol>
      <div className="brow">
        <button className="btn" disabled={columns.length >= 64} onClick={() => void put([...columns, { id: freshColumnId(columns), title: `Column ${columns.length + 1}`, states: [], needs_decision: false }])}>
          {t('board.cols.add')}
        </button>
        {embedded && (
          <>
            <button className="btn" onClick={(e) => e.currentTarget.closest('.bepcols')?.querySelector<HTMLInputElement>(`[data-column-row="${CSS.escape(columns[Math.min(last, columns.length - 1)]?.id ?? '')}"] > input`)?.select()}>
              {t('board.edit.rename')}
            </button>
            <button className="btn" aria-expanded={more} onClick={() => setMore(!more)}>
              {t('board.edit.states')}
            </button>
          </>
        )}
        {error && (
          <span className="berr" role="alert">
            {error}
          </span>
        )}
      </div>
    </Shell>
  );
}
