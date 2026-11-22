// Ticket 990 slice i (mockup docs/design/leader-room/team-j.html ④, lower card): a lead proposes a new role for the
// user's roles. The yes adds it to every project's roles, so it is given only here, as the confirmed allow.
import { useState } from 'react';
import { plain } from '../chat/pending';
import { ErrorLine, rawError } from '../errors';
import type { Answer } from '../queue/answer';
import type { OnAnswer, T } from '../tree/DecisionLine';
import type { Decision } from '../types';
import { Avatar, hue } from './LeadHead';
import '../notes/notes.css';
import './lead.css';

export function RoleCard({ d, onAnswer, t }: { d: Decision; onAnswer: OnAnswer; t: T }) {
  const ask = d.owner?.type === 'role' ? d.owner : null;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  if (!ask) return null;
  const { role } = ask;
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
  const kind = role.kind === 'codex' ? 'Codex' : 'Claude'; // program names, not words
  return (
    <div className="deccard hosted mcard rcard" role="group" aria-label={t('lead.roleCard.title')} data-item={d.id}>
      <div className="mc-head">
        <Avatar letter={role.name} label={role.name} c={hue(role.name)} face={null} small />
        <b>{t('lead.roleCard.title')}</b>
      </div>
      <div className="rc-role">
        <Avatar letter={role.name} label={role.name} c={hue(role.name)} face={null} />
        <div className="rc-words">
          <b>{plain(role.name)}</b>
          <p>{plain(role.job)}</p>
          {ask.why && <small>{plain(ask.why)}</small>}
        </div>
        <div className="rc-pills">
          <span className="rc-pill">{role.model ? `${kind} ${plain(role.model)}` : kind}</span>
          {!role.writes && <span className="rc-pill">{t('lead.roleCard.readOnly')}</span>}
        </div>
      </div>
      <ErrorLine t={t} error={err} className="dc-hint err" />
      <div className="dc-btns mc-btns">
        <button type="button" className="b y" data-act="add-role" disabled={busy} onClick={() => void send({ type: 'allow_once' })}>
          {t('lead.roleCard.add')}
        </button>
        <button type="button" className="b" data-act="not-now" disabled={busy} onClick={() => void send({ type: 'deny' })}>
          {t('lead.roleCard.notNow')}
        </button>
        <span className="mc-quiet">{t('lead.roleCard.quiet')}</span>
      </div>
    </div>
  );
}
