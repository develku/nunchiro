// Ticket 993 rule 4: a lead proposes a schedule, or a change to one (`nunchiro schedule propose | change`). The card
// is built from the proposal's own fields: who, when in words and the model its level starts (ticket 994) on one line; the task under it, three lines
// until "Show all"; who asked; two buttons. Nothing is stored before the yes, which is given only here, as the
// confirmed allow. The core's one sentence (`owner.line`) is the card's accessible summary.
// Eighth look (Home S2-B): a scheduled run that failed is a card here too (`change` failed): who and when, the reason,
// "Run again" and "Dismiss"; its name opens the Schedules widget on that row.
// Ticket 1002 lane 4 (mockup frame 3): when the run before failed too (the row's run log; a skip is no run), the card
// says "failed twice" and offers Pause schedule and Keep it on instead.
import { useLayoutEffect, useRef, useState } from 'react';
import type { CoreClient } from '../api';
import { plain } from '../chat/pending';
import { ErrorLine, knownOrRaw, OwnWords } from '../errors';
import type { Key } from '../i18n';
import { Icon } from '../icons/Icon';
import { useTeam } from '../lead/lead';
import { LevelMark, slotText, useLevels } from '../lead/level';
import { whoOf, type Answer } from '../queue/answer';
import type { OnAnswer, T } from '../tree/DecisionLine';
import type { Decision, Session } from '../types';
import { failedRunCard, levelOf, nextExact, openSchedules, refreshSchedules, scheduleOp, useScheduleList, whenWords } from './schedules';
import '../notes/notes.css';
import '../lead/lead.css';
import './schedule.css';

export function ScheduleCard({ d, sessions, core, onAnswer, t }: { d: Decision; sessions: Session[]; core: CoreClient; onAnswer: OnAnswer; t: T }) {
  const ask = d.owner?.type === 'schedule' ? d.owner : null;
  const team = useTeam(core, true);
  const { table } = useLevels(core, ask?.run.kind === 'acp');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [all, setAll] = useState(false);
  // The toggle shows only for a task that does not fit its three lines.
  const [cut, setCut] = useState(false);
  const words = useRef<HTMLParagraphElement>(null);
  const failed = failedRunCard(d);
  const row = useScheduleList()?.find((s) => s.id === failed?.schedule);
  const twice = row?.last?.result === 'failed' && row.earlier?.find((l) => l.result !== 'skipped' && l.result !== 'held')?.result === 'failed';
  // A failed run's card says why it failed where a proposal has its task (on a streak, the run's own reason: the
  // card's has the core's English "second time in a row" on it, and the title says it).
  const task = failed ? knownOrRaw(t, twice ? (row?.last?.reason ?? failed.reason) : failed.reason) : plain(ask?.run.task ?? '').trim();
  useLayoutEffect(() => {
    const el = words.current;
    if (el && !all) setCut(el.scrollHeight > el.clientHeight + 1);
  }, [task, all]);
  if (!ask) return null;
  const send = async (a: Answer) => {
    setErr(null);
    setBusy(true);
    try {
      // Look 1117 v12/v13 Home S3-4: Run again as the card's yes queued the run and its failure came back as the same
      // card, with no word. It is the row's Run now: a good run takes the card away, a failed one says so here.
      if (failed && a.type === 'allow_once') await scheduleOp(core, { op: 'schedule_run_now', id: failed.schedule });
      else await onAnswer(d, a, !!failed || a.type === 'allow_once'); // a failed run's card: both answers are the user's own (the core's shape)
    } catch (e) {
      if (failed && a.type === 'allow_once') void refreshSchedules(core); // the row's runs say whether it is a streak now
      setErr(failed && a.type === 'allow_once' ? new OwnWords(t('look8.card.notAgain', { reason: knownOrRaw(t, e) })) : e);
      setBusy(false);
    }
  };
  const pause = async () => {
    setErr(null);
    setBusy(true);
    try {
      await scheduleOp(core, { op: 'schedule_pause', id: failed!.schedule, paused: true }); // the core drops the card
    } catch (e) {
      setErr(e);
      setBusy(false);
    }
  };
  // A trigger's third answer: switch the trigger off, then this card's Not now.
  const triggerOff = async () => {
    setErr(null);
    setBusy(true);
    try {
      await core.request({ op: 'trigger', action: { do: 'pause', name: ask.id, paused: true } });
      await onAnswer(d, { type: 'deny' }, true);
    } catch (e) {
      setErr(e);
      setBusy(false);
    }
  };
  const next = twice && row ? nextExact(t, row) : '';
  const title = twice ? t('look8.card.failedTwice') : ask.change === 'failed' ? t('look8.card.failedTitle') : t(`schedule.card.title.${ask.change}` as Key);
  // A trigger's card names a trigger, not a row of the Schedules list.
  const trigger = ask.change === 'trigger';
  const rowId = trigger ? undefined : failed?.schedule || ask.id;
  const mate = team.teammates.find((m) => m.id === ask.run.teammate);
  const level = failed ? undefined : levelOf(ask.run, mate);
  const asker = failed ? undefined : sessions.find((s) => s.id === d.session_id); // a failed run's `session_id` is its schedule's id
  return (
    <div className="deccard hosted mcard rcard" role="group" aria-label={`${title}: ${plain(ask.line)}`} data-item={d.id} data-schedule-card={ask.change}>
      <div className="mc-head">
        <Icon name="clock" size={14} />
        <b>{title}</b>
      </div>
      <p className="sched-line">
        {/* A card about a stored schedule (a failed run, a change): its name opens the widget on that row, so two
            schedules of one teammate are told apart (eighth look, Home). */}
        {rowId ? (
          <button type="button" className="sched-cname" aria-label={t('look8.card.openRow', { name: plain(ask.run.label) })} data-tip={t('look8.card.openRow', { name: plain(ask.run.label) })} onClick={() => openSchedules(rowId)}>
            <b>{plain(failed?.name ?? ask.run.label)}</b>
          </button>
        ) : (
          <b>{plain(ask.run.label)}</b>
        )}{' '}
        · {trigger ? `${t('schedule.card.fromTrigger', { name: ask.id ?? '' })} · ${ask.run.kind} · ${ask.run.project.split('/').filter(Boolean).at(-1) ?? ask.run.project}` : whenWords(t, ask.when)}
        {level && (
          <>
            {' · '}
            <LevelMark t={t} level={level} text={slotText(t, table, mate ?? ask.run, level)} />
          </>
        )}
      </p>
      {task && (
        <p ref={words} className="sched-ctask" data-all={all || undefined}>
          {task}
        </p>
      )}
      {task && (cut || all) && (
        <button type="button" className="sched-more" aria-expanded={all} onClick={() => setAll(!all)}>
          {t(all ? 'schedule.card.showLess' : 'schedule.card.showAll')}
        </button>
      )}
      {next && <small className="sched-by">{t('look8.card.runsAgain', { when: next })}</small>}
      {asker && <small className="sched-by">{t('schedule.card.askedBy', { name: plain(whoOf(asker)) })}</small>}
      <ErrorLine t={t} error={err} className="dc-hint err" />
      <div className="dc-btns mc-btns">
        {twice ? (
          <>
            <button type="button" className="b y" data-act="pause" disabled={busy} onClick={() => void pause()}>
              {t('look8.card.pause')}
            </button>
            <button type="button" className="b" data-act="keep" disabled={busy} onClick={() => void send({ type: 'deny' })}>
              {t('look8.card.keepOn')}
            </button>
          </>
        ) : (
          <>
            <button type="button" className="b y" data-act={ask.change} disabled={busy} onClick={() => void send({ type: 'allow_once' })}>
              {ask.change === 'failed' ? t('look8.card.runAgain') : t(`schedule.card.${ask.change}` as Key)}
            </button>
            <button type="button" className="b" data-act={failed ? 'dismiss' : 'not-now'} disabled={busy} onClick={() => void send({ type: 'deny' })}>
              {t(failed ? 'own.ans.dismiss' : 'lead.roleCard.notNow')}
            </button>
            {trigger && (
              <button type="button" className="b" data-act="trigger-off" disabled={busy} onClick={() => void triggerOff()}>
                {t('schedule.card.triggerOff')}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
