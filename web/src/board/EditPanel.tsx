// V2.5-38 (ticket 186, draft B): the pencil's edit panel beside the board. Columns and the Done column's proof write
// board.toml through `board_columns_put` (the ColumnEditor path, revision checked); the stale threshold and turn-end
// nudge are board.toml `[settings]`; card fields, lane key, filters and density are this widget's saved view (views.ts).
import { PLAIN } from '../plainText';
import { useEffect, useId, useState } from 'react';
import { ColumnEditor } from './ColumnEditor';
import { DONE_DAYS, LANE_KEYS, minutes, type BoardSettings, type Column } from './model';
import { DENSITIES, FIELDS, type View } from './views';
import type { T } from './Board';
import './edit.css';
import { lineError } from '../errors';

export function Pencil() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <g fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
        <path d="M15 5l3 3" />
      </g>
    </svg>
  );
}

export function EditPanel({ t, columns, onPut, view, onView, roles, settings, onSettings, onClose }: {
  t: T;
  columns: Column[];
  onPut: (c: Column[]) => Promise<void>;
  view: View;
  onView: (v: View) => void;
  roles: string[];
  settings: BoardSettings;
  /** Writes board.toml `[settings]` (`board_settings_put`). */
  onSettings: (s: BoardSettings) => Promise<void>;
  onClose: () => void;
}) {
  const ids = { lane: useId(), filters: useId(), fields: useId(), density: useId(), stale: useId() };
  const done = columns.findIndex((c) => c.states.includes('done'));
  const [min, setMin] = useState(String(settings.stale_minutes));
  const [error, setError] = useState('');
  useEffect(() => setMin(String(settings.stale_minutes)), [settings.stale_minutes]);
  const save = async (next: BoardSettings) => {
    setError('');
    try {
      await onSettings(next);
    } catch (e) {
      setError(lineError(t, e));
    }
  };
  const commitMin = () => {
    const n = minutes(min);
    if (n === null) return setError(t('board.edit.errMin'));
    if (n !== settings.stale_minutes) void save({ ...settings, stale_minutes: n });
    else setError('');
  };
  const filters = view.filters;
  const role = (r: string) => onView({ ...view, filters: { ...filters, role: filters.role.includes(r) ? filters.role.filter((x) => x !== r) : [...filters.role, r] } });
  return (
    <aside className="bep" role="dialog" aria-label={t('board.edit.title')} onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), onClose())}>
      <div className="beph">
        <Pencil />
        {t('board.edit.title')}
        <span className="bsp" />
        <button type="button" className="bepb" onClick={onClose}>
          {t('board.edit.done')}
        </button>
      </div>
      <div className="bepbody">
        <div className="beg">
          <h4>{t('board.edit.columns')}</h4>
          <ColumnEditor t={t} columns={columns} onPut={onPut} onClose={onClose} embedded />
        </div>
        {done >= 0 && (
          <div className="beg">
            <h4>{t('board.edit.doneCol')}</h4>
            <label className="berow">
              {t('board.edit.proof')}
              <input type="checkbox" role="switch" className="stog" checked={!!columns[done].proof} onChange={(e) => void onPut(columns.map((c, i) => (i === done ? { ...c, proof: e.target.checked } : c))).catch(() => {})} />
            </label>
          </div>
        )}
        <div className="beg" role="group" aria-labelledby={ids.fields}>
          <h4 id={ids.fields}>{t('board.edit.fields')}</h4>
          <div className="berow bewrap">
            {FIELDS.map((f) => (
              <label key={f}>
                <input type="checkbox" checked={view.fields[f]} onChange={(e) => onView({ ...view, fields: { ...view.fields, [f]: e.target.checked } })} /> {t(`board.field.${f}`)}
              </label>
            ))}
          </div>
        </div>
        <div className="beg">
          <h4 id={ids.lane}>{t('board.edit.lane')}</h4>
          <div className="berow">
            <span className="bseg" role="group" aria-labelledby={ids.lane}>
              {LANE_KEYS.map((k) => (
                <button key={k} type="button" aria-pressed={view.lane === k} onClick={() => onView({ ...view, lane: k })}>
                  {t(`board.lane.by.${k}`)}
                </button>
              ))}
            </span>
          </div>
          <div className="berow dim">{t('board.edit.laneHint')}</div>
        </div>
        <div className="beg">
          <h4 id={ids.filters}>{t('board.edit.filters')}</h4>
          <div className="berow bewrap" role="group" aria-labelledby={ids.filters}>
            <button type="button" className="bfc" aria-pressed={filters.you} onClick={() => onView({ ...view, filters: { ...filters, you: !filters.you } })}>
              {t('board.filter.you')}
            </button>
            <button type="button" className="bfc" aria-pressed={filters.hideIdle} onClick={() => onView({ ...view, filters: { ...filters, hideIdle: !filters.hideIdle } })}>
              {t('board.filter.hideIdle')}
            </button>
            {[...new Set([...roles, ...filters.role])].map((r) => (
              <button key={r} type="button" className="bfc" aria-pressed={filters.role.includes(r)} onClick={() => role(r)}>
                {t('board.filter.roleIs', { role: r })}
              </button>
            ))}
            {roles.length === 0 && filters.role.length === 0 && <span className="dim">{t('board.filter.noRoles')}</span>}
          </div>
        </div>
        <div className="beg">
          <h4 id={ids.density}>{t('board.edit.density')}</h4>
          <div className="berow">
            <span className="bseg" role="group" aria-labelledby={ids.density}>
              {DENSITIES.map((d) => (
                <button key={d} type="button" aria-pressed={view.density === d} onClick={() => onView({ ...view, density: d })}>
                  {t(`board.density.${d}`)}
                </button>
              ))}
            </span>
          </div>
        </div>
        <div className="beg">
          <h4>{t('board.edit.staleNudge')}</h4>
          <label className="berow" htmlFor={ids.stale}>
            {t('board.edit.staleMin')}
            <input {...PLAIN}
              id={ids.stale}
              className="bnum"
              inputMode="numeric"
              value={min}
              aria-invalid={error === t('board.edit.errMin') || undefined}
              onChange={(e) => setMin(e.target.value)}
              onBlur={commitMin}
              onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && (e.preventDefault(), commitMin())}
            />
          </label>
          <label className="berow">
            {t('board.edit.nudge')}
            <input type="checkbox" role="switch" className="stog" checked={settings.turn_end_nudge} onChange={(e) => void save({ ...settings, turn_end_nudge: e.target.checked })} />
          </label>
          <label className="berow">
            {t('board.edit.doneDays')}
            <select value={settings.done_days} onChange={(e) => void save({ ...settings, done_days: Number(e.target.value) as BoardSettings['done_days'] })}>
              {DONE_DAYS.map((n) => (
                <option key={n} value={n}>{t(`board.edit.doneDays.${n}`)}</option>
              ))}
            </select>
          </label>
          {error && (
            <div className="berr" role="alert">
              {error}
            </div>
          )}
        </div>
      </div>
      <div className="bepfoot">{t('board.edit.foot')}</div>
    </aside>
  );
}
