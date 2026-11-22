// Ticket 993 rule 3: the Schedules widget's short form, for "+" and for Edit (a save replaces the schedule in the
// core's one write, so its id changes). Who: a teammate, or a new session with its agent, folder and name (V2.5-11's
// form). What: the task. When: once, every day, weekdays or weekly. Level: a teammate's seat opens at it for this
// task; a new schedule starts at the first level, an edited one keeps what it has. Ticket 994: each level reads as the
// model and effort it starts for that teammate; a lead (its seat keeps its own level) and a teammate on an agent whose
// levels are all the same get no choice, only what the seat opens with. No cron field.
import { PLAIN } from '../plainText';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { CoreClient } from '../api';
import { ErrorLine } from '../errors';
import type { T } from '../i18n';
import type { Team } from '../lead/lead';
import { agentKey, LEVELS, LevelMark, oneLevel, RuleText, slotText, useLevels, type Level } from '../lead/level';
import { AGENTS_OFF } from '../settings/agents/newDefaults';
import { openSetting } from '../settings/agents/open';
import { Seg, Select, Why, WhyFix } from '../settings/shell/Row';
import { useFeatureSetting } from '../settings/useFeatureSetting';
import { basename, isAccountTab } from '../tree';
import type { Session } from '../types';
import { dayName, daysOf, firstDay, levelOf, localDay, modeOf, scheduleOp, splitAt, type Mode, type Schedule } from './schedules';
import { leaveTypedField } from '../keepTyped';

type Kind = 'claude' | 'codex';
const KINDS: [Kind, string][] = [
  ['claude', 'Claude'],
  ['codex', 'Codex'],
];
/** The Who value of a new session, and the project picker's value for a typed folder (ticket 991 C4). */
const NEW = 'new';
const OTHER = '\u0000other';
/** Monday first, as the Weekdays segment reads. */
const WEEK = [1, 2, 3, 4, 5, 6, 0];

export function ScheduleForm({ core, t, team, sessions, edit, onDone, onCancel }: { core: CoreClient; t: T; team: Team; sessions: Session[]; edit: Schedule | null; onDone: () => void; onCancel: () => void }) {
  // Ticket 358: an agent turned off is not offered; a schedule already saved keeps its agent.
  const [agentsOff] = useFeatureSetting(AGENTS_OFF);
  // The folders the core takes: a project is known from a session in it (ticket 991 C4); another folder is typed.
  // By name, the Home folder last (the snapshot's order is not the tree's). Look v9 Home S3-7b: a project whose folder
  // is gone (an ended session there says so, `folder_gone`) is not offered, so the form never starts on it.
  const removed = new Set(sessions.filter((s) => s.folder_gone && s.cwd === s.project).map((s) => s.project));
  const projects = [...new Set(sessions.filter((s) => !isAccountTab(s) && !s.side_chat && !removed.has(s.project)).map((s) => s.project))].sort((a, b) => Number(a === team.home) - Number(b === team.home) || basename(a).localeCompare(basename(b)));
  const own = edit && !edit.run.teammate ? edit.run : null; // the edited schedule's own session
  const [who, setWho] = useState<string | null>(edit ? (edit.run.teammate ? `team:${edit.run.teammate}` : NEW) : null);
  // A new form starts on the first teammate that leads no place (a lead plans; its teammates do the timed jobs); one that
  // is gone (or a list not read yet) reads as a new session.
  const first = team.teammates.find((m) => !m.lead) ?? team.teammates[0];
  const mate = team.teammates.find((m) => `team:${m.id}` === (who ?? `team:${first?.id}`));
  // Look v12 Home S2: an edited schedule whose teammate was removed keeps its own target (that teammate's id, folder and
  // name: a teammate of the same name added later takes it over), never a new session in another project.
  const gone = !mate && edit?.run.teammate && who === `team:${edit.run.teammate}` ? edit.run : null;
  const [picked, setKind] = useState<Kind>((own?.kind as Kind) ?? 'claude');
  const kinds = KINDS.filter(([k]) => !agentsOff.includes(k) || k === own?.kind);
  const kind = kinds.some(([k]) => k === picked) ? picked : (kinds[0]?.[0] ?? picked);
  const [project, setProject] = useState(own?.project ?? projects[0] ?? '');
  const [typed, setTyped] = useState(own ? !projects.includes(own.project) : !projects.length);
  const [label, setLabel] = useState(own?.label ?? '');
  const [task, setTask] = useState(edit?.run.task ?? '');
  // Look 1117 v13 Home S3: an edit starts on the level its row shows (`levelOf`: none stored reads as Sonnet), never on none.
  const [level, setLevel] = useState<'' | Level>(edit ? (levelOf(edit.run, mate) ?? '') : 'light');
  const levels = !!mate && !mate.model; // a custom model has no levels
  const { table } = useLevels(core, mate?.kind === 'acp');
  const choice = levels && !mate.lead && !oneLevel(table, agentKey(mate.kind, mate.agent));
  // null: an edited schedule on a set of days the form has no segment for; it keeps them until a segment is picked.
  const [mode, setMode] = useState<Mode | null>(edit ? modeOf(edit) : 'daily');
  const [weekday, setWeekday] = useState(edit?.days?.length === 1 ? edit.days[0] : 1);
  const [day0, time0] = splitAt(edit?.at ?? '21:00');
  // Ticket 991 C2: the date and time boxes are not controlled: a re-render wrote the last reported value back over what
  // WebKit showed but had not reported yet, so the time jumped. Submit reads the boxes.
  const timeBox = useRef<HTMLInputElement>(null);
  const dateBox = useRef<HTMLInputElement>(null);
  const [at, setAt] = useState(time0);
  const [date, setDate] = useState(day0 || firstDay(time0));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  // "+" and Edit: the form comes into view and its first field takes the focus (the list may be scrolled far below it).
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => (form.current?.scrollIntoView({ block: 'nearest' }), form.current?.querySelector('select')?.focus()), []);
  const placeName = (p: string) => (team.home && p === team.home ? t('team.home') : basename(p));
  // Teammates by place: Home first, then each project.
  const places = [...new Set(team.teammates.map((m) => m.project ?? ''))].sort((a, b) => Number(!!a) - Number(!!b));
  const noAgent = !mate && !kinds.length;
  const ready = (mate || gone ? !!task.trim() : !!project.trim()) && !!at && (mode !== 'once' || !!date) && !noAgent;

  const submit = async () => {
    if (!ready || busy) return;
    const words = task.trim() ? { task: task.trim() } : {};
    // The core replaces a teammate's agent, folder and name with the teammate's own.
    const run = gone
      ? { ...gone, ...words }
      : mate
      ? { kind: mate.kind, project: mate.project ?? team.home, label: mate.name, teammate: mate.id, ...(choice && level ? { level } : {}), ...words }
      : { kind, project: project.trim(), label: label.trim(), ...(own?.kind === kind ? { model: own.model, effort: own.effort } : {}), ...words };
    const time = timeBox.current?.value || at;
    const days = mode ? daysOf(mode, weekday) : edit?.days;
    setBusy(true);
    setError(null);
    try {
      await scheduleOp(core, { op: 'schedule_add', run, at: mode === 'once' ? `${dateBox.current?.value || date} ${time}` : time, daily: mode !== 'once', ...(days ? { days } : {}), ...(edit ? { replace: edit.id } : {}) });
      onDone();
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  };
  const field = (name: string, control: ReactNode) => (
    <div className="sched-f">
      <span className="sched-k" aria-hidden>
        {name}
      </span>
      <div className="sched-c">{control}</div>
    </div>
  );

  return (
    <form
      ref={form}
      className="sched-form"
      aria-label={edit ? t('team.edit') : t('schedule.add')}
      aria-busy={busy || undefined}
      noValidate // the core's plain line says a date has passed; the browser's own bubble would hide it
      onSubmit={(e) => (e.preventDefault(), void submit())}
      onKeyDown={(e) => e.key === 'Escape' && !e.nativeEvent.isComposing && (e.stopPropagation(), leaveTypedField() || onCancel())}
    >
      {field(
        t('schedule.who'),
        <>
          <Select label={t('schedule.who')} value={mate ? `team:${mate.id}` : gone ? `team:${gone.teammate}` : NEW} onChange={setWho}>
            {gone && <option value={`team:${gone.teammate}`}>{t('schedule.removedMate', { name: gone.label })}</option>}
            {places.map((p) => (
              <optgroup key={p} label={p ? basename(p) : t('team.home')}>
                {team.teammates
                  .filter((m) => (m.project ?? '') === p)
                  .map((m) => (
                    <option key={m.id} value={`team:${m.id}`}>
                      {m.name}
                    </option>
                  ))}
              </optgroup>
            ))}
            <option value={NEW}>{t('schedule.newSession')}</option>
          </Select>
          {/* Look 1117 v13 Home: a removed teammate's schedule runs in its own stored folder; the new-session fields
              below showed another project there. */}
          {gone && (
            <Select label={t('schedule.project')} value={gone.project} disabled onChange={() => {}}>
              <option value={gone.project} title={gone.project}>
                {placeName(gone.project)}
              </option>
            </Select>
          )}
          {!mate && !gone && (
            <>
              <Select label={t('schedule.kind')} value={kind} disabled={!kinds.length} describedBy={noAgent ? 'why-schedule-agents' : undefined} onChange={(v) => setKind(v as Kind)}>
                {kinds.map(([k, name]) => (
                  <option key={k} value={k}>
                    {name}
                  </option>
                ))}
              </Select>
              {/* Ticket 475: every agent off in Providers leaves nothing to schedule; the fix is that page's Use switch. */}
              {noAgent && <Why id="why-schedule-agents" reason={t('settingsWhy.agentsOff')} fix={<WhyFix label={t('settingsWhy.openProviders')} run={() => openSetting('providers', 'use', '[data-field="use"] input')} />} />}
              {!!projects.length && (
                <Select label={t('schedule.project')} value={typed ? OTHER : project} onChange={(v) => (v === OTHER ? (setTyped(true), setProject('')) : (setTyped(false), setProject(v)))}>
                  {projects.map((p) => (
                    <option key={p} value={p} title={p}>
                      {placeName(p)}
                    </option>
                  ))}
                  <option value={OTHER}>{t('schedule.projectOther')}</option>
                </Select>
              )}
              {typed && <input {...PLAIN} aria-label={t('schedule.projectPath')} placeholder={t('schedule.projectHint')} value={project} onChange={(e) => setProject(e.target.value)} />}
              <input {...PLAIN} aria-label={t('schedule.label')} placeholder={t('schedule.label')} value={label} onChange={(e) => setLabel(e.target.value)} />
            </>
          )}
        </>,
      )}
      {field(t('schedule.what'), <textarea {...PLAIN} rows={2} maxLength={4000} aria-label={t('schedule.what')} placeholder={t(mate || gone ? 'schedule.taskMate' : 'schedule.taskHint')} value={task} onChange={(e) => setTask(e.target.value)} />)}
      {field(
        t('schedule.col.when'),
        <>
          <Seg<Mode>
            name="sched-mode"
            label={t('schedule.col.when')}
            value={mode}
            options={[
              ['once', t('schedule.onceOnly')],
              ['daily', t('schedule.everyDay')],
              ['weekdays', t('schedule.weekdays')],
              ['weekly', t('schedule.weekly')],
            ]}
            onChange={setMode}
          />
          <span className="sched-at">
            {mode === 'weekly' && (
              <Select label={t('schedule.day')} value={String(weekday)} onChange={(v) => setWeekday(Number(v))}>
                {WEEK.map((d) => (
                  <option key={d} value={d}>
                    {dayName(d)}
                  </option>
                ))}
              </Select>
            )}
            {mode === 'once' && <input type="date" aria-label={t('schedule.date')} ref={dateBox} defaultValue={date} min={localDay(new Date())} max="9999-12-31" onChange={(e) => setDate(e.target.value)} />}
            <input type="time" aria-label={t('schedule.time')} ref={timeBox} defaultValue={at} onChange={(e) => setAt(e.target.value)} />
          </span>
        </>,
      )}
      <ErrorLine t={t} error={error} />
      {levels &&
        field(
          t('level.schedule'),
          choice ? (
            <Seg<Level> name="sched-level" label={t('level.schedule')} value={level || null} options={LEVELS.map((l): [Level, ReactNode] => [l, <LevelMark key={l} t={t} level={l} text={slotText(t, table, mate, l)} />])} onChange={setLevel} />
          ) : (
            <span className="sched-rule" data-rule title={t(mate.lead ? 'level.leadKeeps' : 'level.same')}>
              <RuleText t={t} table={table} m={mate} own />
            </span>
          ),
        )}
      <div className="sched-acts">
        <button type="submit" className="btn p" disabled={!ready} aria-busy={busy || undefined}>
          {edit ? t('team.save') : t('schedule.submit')}
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          {t('team.cancel')}
        </button>
      </div>
    </form>
  );
}
