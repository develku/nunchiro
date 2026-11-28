// A project lead proposes a trigger (the core's `OwnerAsk::Trigger`, asked with `nunchiro trigger propose`): the
// trigger's line (name, what fires it, the agent and the task), the project, Add trigger and Not now. Nothing is added
// before the yes, which adds it asking first; the role card's frame (lead/RoleCard.tsx).
import { useState } from 'react';
import { plain } from '../chat/pending';
import { ErrorLine, rawError } from '../errors';
import type { Answer } from '../queue/answer';
import { basename } from '../tree';
import type { OnAnswer, T } from '../tree/DecisionLine';
import type { Decision } from '../types';
import '../lead/lead.css';

export function TriggerProposalCard({ d, onAnswer, t }: { d: Decision; onAnswer: OnAnswer; t: T }) {
  const ask = d.owner?.type === 'trigger' ? d.owner : null;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  if (!ask) return null;
  const title = t('trigger.proposal.title');
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
    <div className="deccard hosted mcard rcard" role="group" aria-label={title} data-item={d.id} data-trigger-proposal={ask.name}>
      <div className="mc-head">
        <b>{title}</b>
      </div>
      <div className="rc-words" data-trigger-line>
        <p>{plain(ask.line)}</p>
        <small>{t('trigger.proposal.asks', { project: basename(ask.run.project) })}</small>
      </div>
      <ErrorLine t={t} error={err} className="dc-hint err" />
      <div className="dc-btns mc-btns">
        <button type="button" className="b y" data-act="add-trigger" disabled={busy} onClick={() => void send({ type: 'allow_once' })}>
          {t('trigger.proposal.add')}
        </button>
        <button type="button" className="b" data-act="not-now" disabled={busy} onClick={() => void send({ type: 'deny' })}>
          {t('lead.roleCard.notNow')}
        </button>
      </div>
    </div>
  );
}
