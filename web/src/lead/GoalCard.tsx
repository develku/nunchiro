// Home view change 4 (docs/design/leader-room/home-view-1117.html): the Home lead asks to give a project's lead a goal.
// Nothing reaches the project before Send: then the core writes it into that project's room, marked as from Home and
// approved by the user, and wakes its lead. Not now tells the Home lead.
import { useState } from 'react';
import { plain } from '../chat/pending';
import { ErrorLine, rawError } from '../errors';
import type { Answer } from '../queue/answer';
import { basename } from '../tree';
import type { OnAnswer, T } from '../tree/DecisionLine';
import type { Decision } from '../types';
import { Avatar, hue } from './LeadHead';
import '../notes/notes.css';
import './lead.css';

export function GoalCard({ d, onAnswer, t }: { d: Decision; onAnswer: OnAnswer; t: T }) {
  const ask = d.owner?.type === 'goal' ? d.owner : null;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  if (!ask) return null;
  const project = plain(basename(ask.place));
  const send = async (a: Answer) => {
    setErr('');
    setBusy(true);
    try {
      await onAnswer(d, a, a.type === 'allow_once');
    } catch (e) {
      setErr(rawError(e));
      setBusy(false);
    }
  };
  return (
    <div className="deccard hosted mcard rcard" role="group" aria-label={t('home.goalCard.title', { project })} data-item={d.id} data-goal>
      <div className="mc-head">
        <Avatar letter={ask.from} label={ask.from} c={hue(ask.from)} face={null} small />
        <b>{t('home.goalCard.title', { project })}</b>
      </div>
      <div className="rc-words">
        <p>{t('home.goalCard.ask', { from: plain(ask.from), project })}</p>
        <blockquote>{plain(ask.text)}</blockquote>
      </div>
      <ErrorLine t={t} error={err} className="dc-hint err" />
      <div className="dc-btns mc-btns">
        {/* Seventh look (Home S3): the composer's arrow is "Send" too; this one's name says what it sends. */}
        <button type="button" className="b y" data-act="send-goal" aria-label={`${t('home.goalCard.send')} · ${t('home.goalCard.title', { project })}`} disabled={busy} onClick={() => void send({ type: 'allow_once' })}>
          {t('home.goalCard.send')}
        </button>
        <button type="button" className="b" data-act="not-now" disabled={busy} onClick={() => void send({ type: 'deny' })}>
          {t('lead.roleCard.notNow')}
        </button>
        <span className="mc-quiet">{t('home.goalCard.quiet', { project })}</span>
      </div>
    </div>
  );
}
