// A new bot's first chat (owner-approved mockup docs/design/bots-1166.html, panel 3, the right window): once the bot
// wrote its SOUL file the chat shows it on a card, "<name> wrote SOUL.md · 9 lines", with Read, Edit and Undo (Undo puts
// back the one sentence the bot was made with). A bot made from the Lead or Chief template is asked for its seat here,
// on a card of the same kind: nobody sits before the owner's press. Both cards last as long as the first chat does
// (the core's `first`, team/bots/first.rs): a bot made the earlier way, or in a later conversation, has neither.
import { useEffect, useRef, useState } from 'react';
import { ErrorLine, rawError } from '../errors';
import type { T } from '../i18n';
import { Icon } from '../icons/Icon';
import { PLAIN } from '../plainText';
import { askCore, knownPlaces, setTeam, useTeamNow, type Team } from '../lead/lead';
import { Select } from '../settings/shell/Row';
import { basename } from '../tree';
import type { Session } from '../types';
import { markFirstChat, type SoulReply } from './bots';
import './bots.css';

const SHOWN = 3; // the card's own lines; Read shows the rest

export function FirstChat({ t, session, working }: { t: T; session: Session; working: boolean }) {
  const id = session.teammate!;
  const team = useTeamNow();
  const bot = (team.bots ?? []).find((b) => b.id === id);
  const [soul, setSoul] = useState<SoulReply | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [full, setFull] = useState(false);
  const [error, setError] = useState('');
  const [project, setProject] = useState('');
  const card = useRef<HTMLDivElement>(null);
  const read = (more: Record<string, unknown> = {}) =>
    askCore<SoulReply>({ op: 'bot_soul', id, ...more }).then(
      (r) => (setSoul(r), setDraft(null), setError(''), markFirstChat(id, !!r.first)),
      (e) => setError(rawError(e)),
    );
  // Read when the chat opens and again each time a turn ends: the bot writes the file during a turn.
  useEffect(() => void (working || read()), [id, working]); // eslint-disable-line react-hooks/exhaustive-deps
  const first = soul?.first;
  const wrote = !!first?.wrote;
  useEffect(() => void (wrote && card.current?.scrollIntoView({ block: 'nearest' })), [wrote]);
  if (!bot || !soul || !first) return null;
  const lines = soul.text.trimEnd().split('\n');
  const seat = first.seat && bot.seat.kind === 'none' ? first.seat : null;
  const places = knownPlaces(team);
  const place = project || (bot.v1?.project && places.includes(bot.v1.project) ? bot.v1.project : (places[0] ?? ''));
  const sit = (to: { kind: 'none' } | { kind: 'chief' } | { kind: 'lead'; project: string }) =>
    askCore<Team>({ op: 'bot_seat', id, seat: to }).then(
      (got) => (setTeam(got), void read()),
      (e) => setError(rawError(e)),
    );
  if (!wrote && !seat) return null;
  return (
    <div className="cin bot-first">
      {seat && (
        <div className="bot-wrote" role="group" aria-label={t(seat === 'lead' ? 'bots.first.seatLead' : 'bots.first.seatChief', { name: bot.name })} data-first-seat={seat}>
          <div className="bw-h">
            <Icon name="person" size={16} />
            <b>{t(seat === 'lead' ? 'bots.first.seatLead' : 'bots.first.seatChief', { name: bot.name })}</b>
          </div>
          {seat === 'chief' ? (
            <p>{t('bots.first.seatChiefNote')}</p>
          ) : places.length ? (
            <Select label={t('bots.first.project')} value={place} onChange={setProject}>
              {places.map((p) => (
                <option key={p} value={p}>
                  {basename(p)}
                </option>
              ))}
            </Select>
          ) : (
            <p>{t('bots.first.noProject')}</p>
          )}
          {!wrote && <ErrorLine t={t} error={error} />}
          <div className="bw-acts">
            <button type="button" className="primary" data-first-sit disabled={seat === 'lead' && !place} onClick={() => void sit(seat === 'lead' ? { kind: 'lead', project: place } : { kind: 'chief' })}>
              {t(seat === 'lead' ? 'bots.first.sit' : 'bots.first.sitChief')}
            </button>
            <button type="button" data-first-not-now onClick={() => void sit({ kind: 'none' })}>
              {t('bots.first.notNow')}
            </button>
          </div>
        </div>
      )}
      {wrote && (
        <div ref={card} className="bot-wrote" role="group" aria-label={t('bots.first.wrote', { name: bot.name })} data-first-soul>
          <div className="bw-h">
            <Icon name="pencil" size={16} />
            <b>{t('bots.first.wrote', { name: bot.name })}</b>
            <span>· {t(lines.length === 1 ? 'bots.first.lines.one' : 'bots.first.lines.other', { n: lines.length })}</span>
          </div>
          {draft === null ? <pre>{(full ? lines : lines.slice(0, SHOWN)).join('\n')}</pre> : <textarea {...PLAIN} className="sinp" aria-label={t('bots.soul.label', { name: bot.name })} value={draft} autoFocus onChange={(e) => setDraft(e.target.value)} />}
          <ErrorLine t={t} error={error} />
          {draft === null ? (
            <div className="bw-acts">
              {lines.length > SHOWN && (
                <button type="button" data-first-read aria-expanded={full} onClick={() => setFull(!full)}>
                  {t(full ? 'bots.first.less' : 'bots.first.read')}
                </button>
              )}
              <button type="button" data-first-edit onClick={() => setDraft(soul.text)}>
                {t('bots.soul.edit')}
              </button>
              <button type="button" className="quiet" data-first-undo onClick={() => void read({ undo: true })}>
                {t('bots.first.undo')}
              </button>
            </div>
          ) : (
            <div className="bw-acts">
              <button type="button" className="primary" disabled={!draft.trim()} onClick={() => void read({ text: draft })}>
                {t('bots.soul.save')}
              </button>
              <button type="button" onClick={() => (setDraft(null), setError(''))}>
                {t('bots.soul.cancel')}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
