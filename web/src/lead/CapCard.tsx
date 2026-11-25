// Ticket 1113 reuses this proposal card for owner-only session closes.
// Ticket 1099 panel 4 (mockup docs/design/cohesion-1099/mockup.html#p4): a lead asks to change its place's live seats
// (`nunchiro task ask-cap`). Laid out as the schedule proposal's card: the place and the change on one line, the lead's
// reason in three lines until "Show all", who asked, the change's word as the yes and Not now. Only the yes sets the cap,
// the same one Settings > Team > How this place works sets.
import { useLayoutEffect, useRef, useState } from 'react';
import { plain } from '../chat/pending';
import { ErrorLine } from '../errors';
import { Icon } from '../icons/Icon';
import { whoOf, type Answer } from '../queue/answer';
import { basename } from '../tree';
import type { OnAnswer, T } from '../tree/DecisionLine';
import type { Decision, Session } from '../types';
import '../notes/notes.css';
import './lead.css';
import '../schedule/schedule.css';

export function CapCard({ d, sessions, onAnswer, t }: { d: Decision; sessions: Session[]; onAnswer: OnAnswer; t: T }) {
  const ask = d.owner?.type === 'cap' || d.owner?.type === 'session_close' ? d.owner : null;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [all, setAll] = useState(false);
  const [cut, setCut] = useState(false); // the toggle shows only for a reason that does not fit its three lines
  const words = useRef<HTMLParagraphElement>(null);
  const why = plain(ask?.why ?? '').trim();
  useLayoutEffect(() => {
    const el = words.current;
    if (el && !all) setCut(el.scrollHeight > el.clientHeight + 1);
  }, [why, all]);
  if (!ask) return null;
  const send = async (a: Answer) => {
    setErr(null);
    setBusy(true);
    try {
      await onAnswer(d, a, a.type === 'allow_once');
    } catch (e) {
      setErr(e);
      setBusy(false);
    }
  };
  const asker = sessions.find((s) => s.id === d.session_id);
  const askedBy = asker ? plain(whoOf(asker)) : ask.type === 'session_close' ? plain(ask.from ?? '') : '';
  const title = ask.type === 'session_close' ? t('sessionClose.title', { label: plain(ask.label) }) : t('coh.cap.title');
  return (
    <div className="deccard hosted mcard rcard" role="group" aria-label={`${title}: ${plain(d.text)}`} data-item={d.id} data-cap-card={ask.type === 'cap' ? ask.cap : undefined} data-session-close-card={ask.type === 'session_close' ? ask.target : undefined}>
      <div className="mc-head">
        <Icon name={ask.type === 'cap' ? 'people' : 'x'} size={14} />
        <b>{title}{ask.type === 'session_close' && <> · {plain(basename(ask.place))}</>}</b>
      </div>
      {ask.type === 'cap' && <p className="sched-line">
        <b>{plain(basename(ask.place))}</b>
        {t('coh.cap.line', { from: ask.was, to: ask.cap })}
      </p>}
      {why && (
        <p ref={words} className="sched-ctask" data-all={all || undefined}>
          {why}
        </p>
      )}
      {why && (cut || all) && (
        <button type="button" className="sched-more" aria-expanded={all} onClick={() => setAll(!all)}>
          {t(all ? 'schedule.card.showLess' : 'schedule.card.showAll')}
        </button>
      )}
      {askedBy && <small className="sched-by">{t('schedule.card.askedBy', { name: askedBy })}</small>}
      <ErrorLine t={t} error={err} className="dc-hint err" />
      <div className="dc-btns mc-btns">
        <button type="button" className="b y" data-act={ask.type === 'cap' ? 'change-cap' : 'close-session'} disabled={busy} onClick={() => void send({ type: 'allow_once' })}>
          {ask.type === 'cap' ? t('coh.cap.yes', { n: ask.cap }) : t('sessionClose.yes')}
        </button>
        <button type="button" className="b" data-act="not-now" disabled={busy} onClick={() => void send({ type: 'deny' })}>
          {t('lead.roleCard.notNow')}
        </button>
      </div>
    </div>
  );
}
