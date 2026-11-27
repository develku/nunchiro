// V2-8e (DECISIONW): the "Decisions" widget lists every session's pending decisions, oldest first, grouped by session.
// Each group is the existing DecisionCard, hosted (chat/DecisionCard.tsx owns the answer, risky and focus rules). The
// widget header is the sidebar's (NODUP): this body only counts.
import { useEffect, useRef, useState } from 'react';
import { accountName } from '../api';
import { DecisionCard } from '../chat/DecisionCard';
import { plain } from '../chat/pending';
import { whoOf, type Answer } from '../queue/answer';
import { asks, loopLine, loopWords, waitingCount } from '../tree/decisions';
import { tEn, type OnAnswer, type T } from '../tree/DecisionLine';
import { age, basename } from '../tree';
import { withResumed, type Decision, type Session } from '../types';
import './decisions.css';
import { ErrorLine, rawError } from '../errors';
import type { CoreClient } from '../api';
import { MergeCard } from '../notes/MergeCard';
import { RoleCard } from '../lead/RoleCard';
import { BotOfferCard } from '../bots/BotOfferCard';
import { GoalCard } from '../lead/GoalCard';
import { OutboxCard } from '../lead/OutboxCard';
import { ScheduleCard } from '../schedule/ScheduleCard';
import { CapCard } from '../lead/CapCard';
import { PermissionSheet } from '../approval/PermissionSheet';

/** A jump from a decision row: the session to show first, and a number that changes with each jump. */
export interface Ask {
  to: string;
  n: number;
}

interface Props {
  sessions: Session[];
  onAnswer: OnAnswer;
  /** The focus request of a jump, until it is used once. */
  ask: Ask | null;
  onBack: () => void;
  onFocused: () => void;
  onAnswered: () => void;
  /** V2-14f: the window's catalogue lookup; English when the caller passes none. */
  t?: T;
  /** Needs 225: the snapshot's owner items; the widget shows the agents' Codex reset asks among them. */
  owner?: Decision[];
  /** Ticket 990 slice h: the merge card keeps its lessons as notes before the yes. */
  core: CoreClient;
  /** The Home folder: a teammate seat elsewhere names its project on its card (every project's lead is "Lead"). */
  home?: string;
  /** Ticket 1030: the session in front; what it still lists here is also on the card above its composer. */
  front?: string | null;
}

const oldest = (s: Session) => Math.min(...asks(s.pending).map((d) => d.observed_at));

/** In a zone the widget may sit on a hidden tab: show it, as the jump asks to see this widget where it is. */
function reveal(el: HTMLElement | null) {
  const wg = el?.closest<HTMLElement>('.wg');
  if (!wg?.hidden) return;
  const i = [...(wg.parentElement?.querySelectorAll(':scope > .wg') ?? [])].indexOf(wg);
  wg.parentElement?.querySelectorAll<HTMLElement>('[role="tab"]')[i]?.click();
}

/** Needs 225: an agent's ask to use one Codex reset ticket (an owner item, answered in this window only). Allow spends
 *  one through the owner's own codex; Deny spends nothing. Both are logged on the Usage page. */
function ResetCard({ d, sessions, onAnswer, t }: { d: Decision; sessions: Session[]; onAnswer: OnAnswer; t: T }) {
  const [err, setErr] = useState('');
  const [done, setDone] = useState(false);
  if (d.owner?.type !== 'codex_reset') return null;
  const s = sessions.find((x) => x.id === d.session_id);
  const who = plain(s ? whoOf(s) : t('decisions.someSession'));
  const label = t('usage.reset.cardAsk', { who, account: plain(accountName(t, { default: d.owner.folder === null, label: d.owner.account })) });
  const send = (a: Answer) => {
    const p = onAnswer(d, a);
    if (!p) return;
    setDone(true);
    p.then(
      () => {},
      (e: Error) => (setErr(rawError(e)), setDone(false)),
    );
  };
  return (
    <div className="deccard hosted" role="group" aria-label={label}>
      <div className="dwh">
        <b>{who}</b>
        <span className="tm">{age(t, Date.now() - d.observed_at)}</span>
      </div>
      <div className="dc-item" data-item={d.id}>
        <p className="dc-what">{label}</p>
        {d.owner.reason && <p className="dc-why">{plain(d.owner.reason)}</p>}
        <ErrorLine t={t} error={err} className="dc-hint err" />
        <div className="dc-btns">
          <button type="button" className="b y" data-act="allow" disabled={done} onClick={() => send({ type: 'allow_once' })}>
            {t('decisions.allow')}
          </button>
          <button type="button" className="b d" data-act="deny" disabled={done} onClick={() => send({ type: 'deny' })}>
            {t('decisions.deny')}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Ticket 1004: a task that stalled (the core's own card): the task, the seat that checked in last and its last error or
 *  that nothing changed. Dismiss only: the core takes the card away when the task moves again or closes. */
function StallCard({ d, onAnswer, t }: { d: Decision; onAnswer: OnAnswer; t: T }) {
  const [err, setErr] = useState('');
  const [done, setDone] = useState(false);
  if (d.owner?.type !== 'stall') return null;
  const { seat, error } = d.owner;
  const title = t('stall.title', { title: plain(d.owner.title) });
  const dismiss = () => {
    const p = onAnswer(d, { type: 'deny' });
    if (!p) return;
    setDone(true);
    p.then(
      () => {},
      (e: Error) => (setErr(rawError(e)), setDone(false)),
    );
  };
  return (
    <div className="deccard hosted" role="group" aria-label={title} data-item={d.id} data-stall={d.owner.task}>
      <div className="dwh">
        <b>{plain(seat)}</b>
        <span className="tm">{age(t, Date.now() - d.observed_at)}</span>
      </div>
      <div className="dc-item">
        <p className="dc-what">{title}</p>
        <p className="dc-why">{error ? t('stall.error', { seat: plain(seat), error: plain(error) }) : t('stall.quiet', { seat: plain(seat) })}</p>
        <ErrorLine t={t} error={err} className="dc-hint err" />
        <div className="dc-btns">
          <button type="button" className="b" data-act="dismiss" disabled={done} onClick={dismiss}>
            {t('own.ans.dismiss')}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Ticket 1003: an open loop's card. Keep track or Close it is the user's yes (nothing is kept or closed before it); an
 *  overdue loop's card closes it or keeps it open. The whole row is on the card: what, its due date, where it came from. */
function LoopCard({ d, onAnswer, t }: { d: Decision; onAnswer: OnAnswer; t: T }) {
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  if (d.owner?.type !== 'loop') return null;
  const { change, row, from, why } = d.owner;
  const title = loopLine(d.owner, t);
  const words = plain(loopWords(row, t));
  const send = async (yes: boolean) => {
    setErr('');
    setBusy(true);
    try {
      await onAnswer(d, { type: yes ? 'allow_once' : 'deny' }, yes);
    } catch (e) {
      setErr(rawError(e));
      setBusy(false);
    }
  };
  return (
    <div className="deccard hosted mcard rcard" role="group" aria-label={title} data-item={d.id} data-loop={d.id}>
      <div className="mc-head">
        <b>{t(`loops.title.${change}`)}</b>
        <span className="tm">{age(t, Date.now() - d.observed_at)}</span>
      </div>
      <div className="rc-words">
        <p>{from && change === 'add' ? t('loops.card.heard', { from: plain(from), words }) : words}</p>
        {from && change === 'close' && why && <p>{t('loops.card.done', { from: plain(from), why: plain(why) })}</p>}
        <p className="mc-quiet">{[row.due ? t('loops.card.due', { date: row.due }) : '', t('loops.card.source', { source: plain(row.source) })].filter(Boolean).join(' · ')}</p>
      </div>
      <ErrorLine t={t} error={err} className="dc-hint err" />
      <div className="dc-btns mc-btns">
        <button type="button" className="b y" data-act="yes" disabled={busy} onClick={() => void send(true)}>
          {t(change === 'add' ? 'loops.act.keep' : change === 'close' ? 'loops.act.close' : 'loops.act.done')}
        </button>
        <button type="button" className="b" data-act="no" disabled={busy} onClick={() => void send(false)}>
          {t(change === 'overdue' ? 'loops.act.open' : 'lead.roleCard.notNow')}
        </button>
        <span className="mc-quiet">{t(`loops.quiet.${change}`)}</span>
      </div>
    </div>
  );
}

/** Ticket 1005: a teammate's memory file past the 6 KB its brief quotes (the core's own card): a yes asks the teammate to
 *  tidy it, Not now dismisses. Asked once per file, however often its seat starts. */
function TidyCard({ d, onAnswer, t }: { d: Decision; onAnswer: OnAnswer; t: T }) {
  const [err, setErr] = useState('');
  const [done, setDone] = useState(false);
  if (d.owner?.type !== 'tidy') return null;
  const name = plain(d.owner.name);
  const file = plain(d.owner.file);
  const title = t('tidy.title', { name, file });
  const send = (answer: Answer) => {
    const p = onAnswer(d, answer);
    if (!p) return;
    setDone(true);
    p.then(
      () => {},
      (e: Error) => (setErr(rawError(e)), setDone(false)),
    );
  };
  return (
    <div className="deccard hosted" role="group" aria-label={title} data-item={d.id} data-tidy={d.owner.teammate}>
      <div className="dwh">
        <b>{name}</b>
        <span className="tm">{age(t, Date.now() - d.observed_at)}</span>
      </div>
      <div className="dc-item">
        <p className="dc-what">{title}</p>
        <p className="dc-why">{t('tidy.why', { name, file })}</p>
        <ErrorLine t={t} error={err} className="dc-hint err" />
        <div className="dc-btns">
          <button type="button" className="b y" data-act="tidy" disabled={done} onClick={() => send({ type: 'allow_once' })}>
            {t('tidy.yes')}
          </button>
          <button type="button" className="b" data-act="not-now" disabled={done} onClick={() => send({ type: 'deny' })}>
            {t('lead.roleCard.notNow')}
          </button>
        </div>
      </div>
    </div>
  );
}

/** A repo setup script that waits for approval: a quiet card (no dot, not counted), whose Review opens the setup sheet.
 *  The sheet reads the script from the worktree and approves exactly what it shows. */
function SetupCard({ d, core, onAnswer, t }: { d: Decision; core: CoreClient; onAnswer: OnAnswer; t: T }) {
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState('');
  if (d.owner?.type !== 'setup') return null;
  // Not now drops the ask (the setup does not run); an ask whose worktree went outside Nunchiro has no other way out.
  const dismiss = () => {
    const p = onAnswer(d, { type: 'deny' });
    if (!p) return;
    setDone(true);
    p.then(
      () => {},
      (e: Error) => (setErr(rawError(e)), setDone(false)),
    );
  };
  const { path } = d.owner;
  const title = t('setupSheet.title', { name: plain(basename(path)) });
  return (
    <div className="deccard hosted" role="group" aria-label={title} data-item={d.id} data-setup={path}>
      <div className="dwh">
        <b>{t('field.setupScript')}</b>
        <span className="tm">{age(t, Date.now() - d.observed_at)}</span>
      </div>
      <div className="dc-item">
        <p className="dc-what" title={path}>
          {title}
        </p>
        <p className="dc-why">{t('setupSheet.kind')}</p>
        <ErrorLine t={t} error={err} className="dc-hint err" />
        <div className="dc-btns">
          <button type="button" className="b" data-act="review" disabled={done} onClick={() => setOpen(true)}>
            {t('rest.shell.strip.review')}
          </button>
          <button type="button" className="b" data-act="not-now" disabled={done} onClick={dismiss}>
            {t('lead.roleCard.notNow')}
          </button>
        </div>
      </div>
      {open && <PermissionSheet core={core} t={t} name={path} subject="setup" onClose={() => setOpen(false)} />}
    </div>
  );
}

export function DecisionsWidget({ sessions, onAnswer, ask, onBack, onFocused, onAnswered, t = tEn, owner = [], core, home, front }: Props) {
  const root = useRef<HTMLDivElement>(null);
  // A jump is used up whatever happens: the card of its session (if one is on screen) moves focus in its own timer,
  // which runs first (a child's effects run before its parent's); a session with nothing waiting has no card, and an
  // unused ask would send the session's next prompt's focus onto its Allow.
  useEffect(() => {
    if (!ask) return;
    reveal(root.current);
    const t = setTimeout(onFocused, 0);
    return () => clearTimeout(t);
  }, [ask?.n]); // eslint-disable-line react-hooks/exhaustive-deps
  const waiting = sessions.filter((s) => asks(s.pending).length).sort((a, b) => oldest(a) - oldest(b));
  const stalls = owner.filter((d) => d.owner?.type === 'stall'); // ticket 1004
  const tidies = owner.filter((d) => d.owner?.type === 'tidy'); // ticket 1005
  const resets = owner.filter((d) => d.owner?.type === 'codex_reset');
  const merges = owner.filter((d) => d.owner?.type === 'merge');
  const byId = withResumed(new Map(sessions.map((s) => [s.id, s])), sessions); // a merge card filed before its lead's Resume
  const roles = owner.filter((d) => d.owner?.type === 'role');
  const offers = owner.filter((d) => d.owner?.type === 'bot');
  const goals = owner.filter((d) => d.owner?.type === 'goal');
  const schedules = owner.filter((d) => d.owner?.type === 'schedule'); // ticket 993
  const outbox = owner.filter((d) => d.owner?.type === 'outward'); // ticket 1002 lane 2
  const loops = owner.filter((d) => d.owner?.type === 'loop'); // ticket 1003
  const caps = owner.filter((d) => d.owner?.type === 'cap' || d.owner?.type === 'session_close'); // ticket 1099 panel 4
  const setups = owner.filter((d) => d.owner?.type === 'setup');
  const count = waitingCount(sessions, owner);
  return (
    <div ref={root} className="dw" data-widget-body="decisions">
      {count === 0 && !setups.length ? (
        <p className="dw-empty">{t('decisions.none')}</p>
      ) : (
        <>
          {count > 0 && <p className="dw-count">{t('decisions.waiting', { count })}</p>}
          {merges.map((d) => (
            <MergeCard key={d.id} d={d} core={core} onAnswer={onAnswer} t={t} who={((s) => s && whoOf(s))(byId.get(d.session_id))} />
          ))}
          {roles.map((d) => (
            <RoleCard key={d.id} d={d} onAnswer={onAnswer} t={t} />
          ))}
          {offers.map((d) => (
            <BotOfferCard key={d.id} d={d} home={home} onAnswer={onAnswer} t={t} />
          ))}
          {goals.map((d) => (
            <GoalCard key={d.id} d={d} onAnswer={onAnswer} t={t} />
          ))}
          {outbox.map((d) => (
            <OutboxCard key={d.id} d={d} onAnswer={onAnswer} t={t} />
          ))}
          {loops.map((d) => (
            <LoopCard key={d.id} d={d} onAnswer={onAnswer} t={t} />
          ))}
          {schedules.map((d) => (
            <ScheduleCard key={d.id} d={d} sessions={sessions} core={core} onAnswer={onAnswer} t={t} />
          ))}
          {caps.map((d) => (
            <CapCard key={d.id} d={d} sessions={sessions} onAnswer={onAnswer} t={t} />
          ))}
          {resets.map((d) => (
            <ResetCard key={d.id} d={d} sessions={sessions} onAnswer={onAnswer} t={t} />
          ))}
          {stalls.map((d) => (
            <StallCard key={d.id} d={d} onAnswer={onAnswer} t={t} />
          ))}
          {tidies.map((d) => (
            <TidyCard key={d.id} d={d} onAnswer={onAnswer} t={t} />
          ))}
          {setups.map((d) => (
            <SetupCard key={d.id} d={d} core={core} onAnswer={onAnswer} t={t} />
          ))}
          {waiting.map((s) => (
            <DecisionCard key={s.id} session={s} onAnswer={onAnswer} onBack={onBack} hosted={{ age: age(t, Date.now() - oldest(s)), place: s.teammate && s.project !== home ? basename(s.project) : undefined }} focusAsk={ask?.to === s.id ? ask.n : undefined} onFocused={onFocused} onAnswered={onAnswered} t={t} note={s.id === front ? t('decisions.alsoInChat') : undefined} />
          ))}
        </>
      )}
    </div>
  );
}
