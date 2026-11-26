// A bot offers a new bot (the core's `OwnerAsk::Bot`, asked with `nunchiro bot offer`): who offers, the name, the one
// sentence and what the bot counted. Nothing is made before the yes; the yes makes the bot in the offering bot's place.
// The card is the role card's (lead/RoleCard.tsx), with the offering bot's own face at its head.
import { useState } from 'react';
import { plain } from '../chat/pending';
import { ErrorLine, rawError } from '../errors';
import { Avatar, hue } from '../lead/LeadHead';
import { refreshTeam, useTeamNow } from '../lead/lead';
import type { Answer } from '../queue/answer';
import { basename } from '../tree';
import type { OnAnswer, T } from '../tree/DecisionLine';
import type { Decision } from '../types';
import { Face } from './Face';
import '../notes/notes.css';
import '../lead/lead.css';
import './bots.css';

export function BotOfferCard({ d, home, onAnswer, t }: { d: Decision; home?: string; onAnswer: OnAnswer; t: T }) {
  const ask = d.owner?.type === 'bot' ? d.owner : null;
  const team = useTeamNow();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  if (!ask) return null;
  const project = ask.place === (home ?? team.home) ? '' : ask.place;
  const from = (team.bots ?? []).find((b) => b.name === ask.from && (b.seat.kind === 'lead' ? b.seat.project : (b.v1?.project ?? '')) === project);
  const title = t('bots.offer.title', { from: plain(ask.from) });
  const send = async (a: Answer) => {
    setErr('');
    setBusy(true);
    try {
      await onAnswer(d, a, a.type === 'allow_once');
      if (a.type === 'allow_once') void refreshTeam();
    } catch (e) {
      setErr(rawError(e));
      setBusy(false);
    }
  };
  return (
    <div className="deccard hosted mcard rcard" role="group" aria-label={title} data-item={d.id} data-bot-offer={ask.name}>
      <div className="mc-head">
        {from ? <Face t={t} face={from.face} name={from.name} eyes="rest" size={20} /> : <Avatar letter={ask.from} label={ask.from} c={hue(ask.from)} face={null} small />}
        <b>{title}</b>
      </div>
      <div className="rc-role">
        <Avatar letter={ask.name} label={ask.name} c={hue(ask.name)} face={null} />
        <div className="rc-words">
          <b>{plain(ask.name)}</b>
          <p>{plain(ask.job)}</p>
          <small>{plain(ask.why)}</small>
        </div>
        {project && (
          <div className="rc-pills">
            <span className="rc-pill">{t('bots.offer.in', { project: basename(project) })}</span>
          </div>
        )}
      </div>
      <ErrorLine t={t} error={err} className="dc-hint err" />
      <div className="dc-btns mc-btns">
        <button type="button" className="b y" data-act="create-bot" disabled={busy} onClick={() => void send({ type: 'allow_once' })}>
          {t('bots.offer.create')}
        </button>
        <button type="button" className="b" data-act="not-now" disabled={busy} onClick={() => void send({ type: 'deny' })}>
          {t('lead.roleCard.notNow')}
        </button>
        <span className="mc-quiet">{t('bots.offer.quiet')}</span>
      </div>
    </div>
  );
}
