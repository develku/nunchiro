// Ticket 993 (owner 11-18): the Schedules widget. One component, in the right sidebar or as a centre tab (schedules.ts
// keeps which); its layout follows its own width, as the Team view's: narrow, a row is three lines; wide, one line in
// columns. A row: an on/off switch, who runs it (with its level's bars and the model they start, ticket 994), the task, when in words, the next run and the
// last run's dot. Pressing a row opens its detail in place (the whole task, the last run, the run log, Run now, Edit, Remove); "+"
// and Edit open the form (ScheduleForm.tsx) above the list. V2.5-11's Settings page is gone.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CoreClient } from '../api';
import { ErrorLine, knownOrRaw } from '../errors';
import type { Key, T } from '../i18n';
import { Icon } from '../icons/Icon';
import { useTeam } from '../lead/lead';
import { agentKey, LevelMark, pairShort, slotPair, slotText, useLevels } from '../lead/level';
import { RowIcon } from '../tree/RowIcon';
import type { Session } from '../types';
import { ScheduleForm } from './ScheduleForm';
import { WidenMark } from '../history/HistoryView';
import { dayWords, levelOf, nameOf, NEW_SCHEDULE, nextExact, nextWords, onOpenSchedules, ranOnce, refreshSchedules, scheduleList, scheduleOp, showSchedTab, sorted, takeWanted, taskShown, useSchedAt, useScheduleList, whenWords, type Schedule } from './schedules';
import '../lead/lead.css';
import './schedule.css';

/** At this width of its own a row is one line in columns. */
const WIDE = 720;
type Dot = 'working' | 'done' | 'waiting' | 'failed' | 'idle';
const dotOf = (s: Schedule): Dot | null => (!s.last ? null : !s.last.result ? 'working' : s.last.result === 'finished' ? 'done' : s.last.result === 'needs_you' ? 'waiting' : s.last.result === 'skipped' || s.last.result === 'held' ? 'idle' : 'failed');

export function SchedulesView({ core, t, sessions, open, where }: { core: CoreClient; t: T; sessions: Session[]; open: (id: string) => void; where: 'side' | 'tab' }) {
  const list = useScheduleList();
  const team = useTeam(core, true);
  const { table } = useLevels(core, !!list?.some((s) => s.run.kind === 'acp'));
  const [, put] = useSchedAt();
  const [shown, setShown] = useState<string | null>(null); // the row whose detail is open
  const [form, setForm] = useState<{ edit: Schedule | null; n: number } | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [, setMinute] = useState(0);
  const [wide, setWide] = useState(false);
  const ro = useRef<ResizeObserver | null>(null);
  const root = useCallback((el: HTMLDivElement | null) => {
    ro.current?.disconnect();
    if (el) (ro.current = new ResizeObserver(([e]) => setWide(e.contentRect.width >= WIDE))).observe(el);
  }, []);
  const addButton = useRef<HTMLButtonElement>(null);
  // Read on open (the window's feed reads when the core says the list changed: schedules.ts). The minute only moves
  // "in 3 h" on: it asks the core nothing.
  useEffect(() => {
    void refreshSchedules(core);
    const timer = setInterval(() => document.visibilityState === 'visible' && setMinute((n) => n + 1), 60_000);
    return () => clearInterval(timer);
  }, [core]);
  // A failed run pressed on Home names its row: its detail opens and comes into view.
  const want = useCallback(() => {
    const row = takeWanted();
    if (!row) return;
    if (row === NEW_SCHEDULE) return setForm((f) => ({ edit: null, n: (f?.n ?? 0) + 1 })); // ticket 1099: the palette's New schedule…
    setShown(row);
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`.schedv [data-schedule="${CSS.escape(row)}"] .sched-go`)?.focus());
  }, []);
  useEffect(() => (want(), onOpenSchedules(want)), [want]);
  useEffect(() => {
    if (!menu) return;
    document.querySelector<HTMLElement>('.schedv .lead-menu button')?.focus();
    const away = (e: PointerEvent) => !(e.target as Element).closest?.('.lead-menu, .lead-more') && setMenu(null);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && (setMenu(null), document.querySelector<HTMLElement>(`.schedv [data-schedule="${CSS.escape(menu)}"] .lead-more`)?.focus());
    document.addEventListener('pointerdown', away, true);
    document.addEventListener('keydown', esc);
    return () => (document.removeEventListener('pointerdown', away, true), document.removeEventListener('keydown', esc));
  }, [menu]);
  // A control is never disabled while a request runs (a disabled one drops the keyboard's focus): a second press waits.
  const act = async (request: { op: string; [k: string]: unknown }) => {
    if (busy) return false;
    setBusy(true);
    setError(null);
    try {
      await scheduleOp(core, request);
      return true;
    } catch (e) {
      // A refused Run now leaves its failure on the row (the dot and the reason). Eighth look (Home): the banner above
      // the list said it a second time, as "That did not work": the row's detail opens with the reason instead.
      const before = Date.now() - 5000;
      await refreshSchedules(core);
      const row = request.op === 'schedule_run_now' ? scheduleList().find((s) => s.id === request.id) : undefined;
      if (row?.last?.result === 'failed' && row.last.at >= before) setShown(row.id);
      else setError(e);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const move = where === 'side' ? () => (put({ tab: true }), showSchedTab()) : () => put({ open: true });
  const closeForm = () => (setForm(null), addButton.current?.focus());
  const edit = (s: Schedule) => (setMenu(null), setForm((f) => ({ edit: s, n: (f?.n ?? 0) + 1 })));
  const formOf = (f: NonNullable<typeof form>) => <ScheduleForm key={f.n} core={core} t={t} team={team} sessions={sessions} edit={f.edit} onDone={() => (setShown(null), closeForm())} onCancel={closeForm} />;
  const live = (id?: string) => !!id && sessions.some((x) => x.id === id);
  const rows = list ? sorted(list) : [];

  const row = (s: Schedule) => {
    // Eighth look (Home): Edit opened the form at the top of the list with the row's detail still open below. It
    // opens in the row's place, as Settings > Team does.
    if (form?.edit?.id === s.id) return <li key={s.id} className="sched-item" data-schedule={s.id}>{formOf(form)}</li>;
    const mate = s.run.teammate ? team.teammates.find((m) => m.id === s.run.teammate) : undefined;
    const name = nameOf(s);
    // Look v14 Home S3: a removed teammate's row says so, as its Edit form does (`home` is '' until the team list came).
    const gone = !!s.run.teammate && !mate && !!team.home;
    const when = whenWords(t, s);
    const level = levelOf(s.run, mate);
    const dot = dotOf(s);
    const last = s.last;
    const ran = last ? dayWords(t, last.at) : '';
    const reason = last?.reason ? knownOrRaw(t, last.reason) : '';
    const result = !last ? t('schedule.never') : !last.result ? t('schedule.running') : t(`schedule.result.${last.result}` as Key);
    const said = !last ? '' : !last.result ? `${t('schedule.lastRun')}: ${result}` : last.result === 'failed' || last.result === 'held' ? `${t('schedule.lastRun')} ${result}: ${reason || ran}` : `${t('schedule.lastRun')} ${result} · ${ran}`;
    const session = live(last?.session) ? last!.session! : null;
    const glyph = dot && (
      <i className="tdot" data-s={dot} aria-hidden>
        {dot === 'waiting' ? <RowIcon kind="hand" /> : dot === 'failed' ? <RowIcon kind="fail" /> : null}
      </i>
    );
    const isOpen = shown === s.id;
    // The row says the next run short ("in 2 d"); its exact day and time are the row's tooltip and read with the row.
    // A Once that ran (Home S2-C) is done, not paused: off, "ran", and the tooltip has when it ran.
    const ranAt = ranOnce(s);
    const off = !!s.paused || ranAt;
    const exact = nextExact(t, s);
    const next = ranAt ? `${t('schedule.lastRun')} · ${ran}` : exact && `${t('schedule.col.next')} · ${exact}`;
    return (
      <li key={s.id} className="sched-item" data-schedule={s.id} data-paused={off || undefined} data-ran={ranAt || undefined} data-last={dot ?? 'none'} data-open={isOpen || undefined}>
        <div className="sched-row">
          <input type="checkbox" role="switch" className="stog" checked={!off} aria-busy={busy || undefined} aria-label={t('schedule.switch', { name, when, state: t(off ? 'schedule.off' : 'schedule.on') })} onChange={() => (ranAt ? edit(s) : void act({ op: 'schedule_pause', id: s.id, paused: !s.paused }))} />
          <span className="sched-name">
            <button type="button" className="sched-go" aria-expanded={isOpen} aria-controls={isOpen ? `sched-d-${s.id}` : undefined} aria-describedby={`sched-w-${s.id}`} data-tip={next || undefined} data-tip-below onClick={() => (setRemoving(null), setShown(isOpen ? null : s.id))}>
              <b>{gone ? t('schedule.removedMate', { name }) : name}</b>
            </button>
            {level && <LevelMark t={t} level={level} text={slotText(t, table, mate ?? s.run, level)} short={pairShort(s.run.kind, slotPair(table, agentKey((mate ?? s.run).kind, mate?.agent), level), mate?.agent)} />}
            {/* Ticket 1002 (mockup frame 3): a switched-off row says how to switch it on; the switch does the same. */}
            {s.paused && !ranAt && (
              <button type="button" className="btn p sched-on" aria-label={`${t('schedule.turnOn')}: ${name}`} onClick={() => void act({ op: 'schedule_pause', id: s.id, paused: false })}>
                {t('schedule.turnOn')}
              </button>
            )}
          </span>
          <span className="sched-task" title={s.run.task}>
            {taskShown(s, rows)}
          </span>
          <span className="sched-l2" id={`sched-w-${s.id}`}>
            <span className="sched-when">{when}</span>
            <span className="sched-next">{nextWords(t, s)}</span>
            {next && <span className="sr">{next}</span>}
          </span>
          {session ? (
            <button type="button" className="sched-dot" aria-label={said} data-tip={said} onClick={() => open(session)}>
              {glyph}
            </button>
          ) : (
            <span className="sched-dot" role={dot ? 'img' : undefined} aria-label={dot ? said : undefined} data-tip={dot ? said : undefined}>
              {glyph}
            </span>
          )}
          {wide && (
            <>
              <button type="button" className="lead-more" aria-label={t('lead.band.actions', { name })} aria-haspopup="menu" aria-expanded={menu === s.id} onClick={() => setMenu(menu === s.id ? null : s.id)}>
                ⋯
              </button>
              {menu === s.id && (
                <div className="lead-menu" role="menu">
                  <button role="menuitem" onClick={() => (setMenu(null), void act({ op: 'schedule_run_now', id: s.id }))}>
                    {t('schedule.runNow')}
                  </button>
                  <button role="menuitem" onClick={() => edit(s)}>
                    {t('team.edit')}
                  </button>
                  <button role="menuitem" onClick={() => (setMenu(null), setShown(s.id), setRemoving(s.id))}>
                    {t('schedule.remove')}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
        {isOpen && (
          <div className="sched-detail" id={`sched-d-${s.id}`} role="group" aria-label={name}>
            {s.run.task && <p className="sched-whole">{s.run.task}</p>}
            <p className="sched-last">
              <span>{t('schedule.lastRun')}</span> {last ? `${ran} · ${result}${reason ? `: ${reason}` : ''}` : result}
            </p>
            {/* Ticket 1002 (mockup frame 3): the runs before the last one, newest first, as the core keeps them. */}
            {!!s.earlier?.length && (
              <div className="sched-log">
                <h4>{t('schedule.runLog')}</h4>
                <ul aria-label={t('schedule.runLog')}>
                  {s.earlier.map((l, i) => (
                    <li key={`${l.at}-${i}`} data-result={l.result ?? 'none'}>
                      <span className="sched-log-when">{dayWords(t, l.at)}</span>
                      <b>{l.result ? t(`schedule.result.${l.result}` as Key) : ''}</b>
                      <span>{l.reason ? knownOrRaw(t, l.reason) : ''}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {removing === s.id ? (
              // Keyed: a new element, so Cancel takes the focus (a button reused from the row of buttons would not).
              <div key="ask" className="sched-acts" role="group" aria-label={t('schedule.removeAsk')}>
                <span className="sched-ask">{t('schedule.removeAsk')}</span>
                <button type="button" className="btn sdel" onClick={() => void act({ op: 'schedule_remove', id: s.id }).then(() => setRemoving(null))}>
                  {t('schedule.remove')}
                </button>
                <button type="button" className="btn" autoFocus onClick={() => setRemoving(null)}>
                  {t('team.cancel')}
                </button>
              </div>
            ) : (
              <div key="acts" className="sched-acts">
                <button type="button" className="btn" onClick={() => void act({ op: 'schedule_run_now', id: s.id })}>
                  {t('schedule.runNow')}
                </button>
                <button type="button" className="btn" onClick={() => edit(s)}>
                  {t('team.edit')}
                </button>
                <button type="button" className="btn sdel" onClick={() => setRemoving(s.id)}>
                  {t('schedule.remove')}
                </button>
                {session && (
                  <button type="button" className="btn" onClick={() => open(session)}>
                    {t('schedule.openLast')}
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </li>
    );
  };

  return (
    <div className="schedv" ref={root} data-wide={wide || undefined} data-where={where} data-schedules>
      <div className="teamv-head schedv-head">
        {where === 'tab' && <b className="schedv-title">{t('schedule.title')}</b>}
        <button ref={addButton} type="button" className="teamv-move schedv-add" aria-label={t('schedule.add')} data-tip={t('schedule.add')} aria-expanded={!!form && !form.edit} onClick={() => (form && !form.edit ? closeForm() : setForm((f) => ({ edit: null, n: (f?.n ?? 0) + 1 })))}>
          <Icon name="plus" size={14} />
        </button>
        <button type="button" className="teamv-move" data-move={where === 'side' ? 'tab' : 'side'} aria-label={where === 'side' ? t('lead.team.toTab') : t('lead.team.toSide')} data-tip={where === 'side' ? t('lead.team.toTab') : t('lead.team.toSide')} onClick={move}>
          <WidenMark />
        </button>
      </div>
      <div className="schedv-body">
        <ErrorLine t={t} error={error} />
        {form && !rows.some((s) => s.id === form.edit?.id) && formOf(form)}
        {list && !rows.length && !form && (
          <div className="schedv-empty" role="status">
            <Icon name="clock" size={24} />
            <p>{t('schedule.none')}</p>
            <p>{t('schedule.noneHint')}</p>
            {/* Ticket 1099: the empty state's "Add one" is a button, not only words. */}
            <button type="button" className="btn" data-sched-empty-add onClick={() => setForm((f) => ({ edit: null, n: (f?.n ?? 0) + 1 }))}>
              {t('coh.schedule.add')}
            </button>
          </div>
        )}
        {rows.length > 0 && (
          <>
            {wide && (
              <div className="sched-row sched-heads" aria-hidden>
                <span />
                <span>{t('schedule.label')}</span>
                <span>{t('schedule.task')}</span>
                <span className="sched-l2">
                  <span>{t('schedule.col.when')}</span>
                  <span>{t('schedule.col.next')}</span>
                </span>
              </div>
            )}
            <ul className="sched-list" aria-label={t('schedule.title')}>
              {rows.map(row)}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
