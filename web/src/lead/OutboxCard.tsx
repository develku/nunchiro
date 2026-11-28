// Ticket 1002 lane 2 (docs/design/home-chief-of-staff-1120.html frame 2; owner decision 11-20): the Home lead's Outbox
// card. One outward tool call per card, every argument shown (the core refuses any it would not show), bound by the
// core's hash. Send starts a 10 s Undo, as a mail app's undo send; then the core lets the Home lead make exactly that
// call once. Open by hand builds a new message (or event) from the same arguments instead; Discard is No. "New
// recipient" is the core's word (no earlier yes to that domain); the source line is the chief's own and says so.
import { useEffect, useState } from 'react';
import { plain } from '../chat/pending';
import { ErrorLine, rawError } from '../errors';
import type { Key } from '../i18n';
import type { Answer } from '../queue/answer';
import { age } from '../tree';
import type { OnAnswer, T } from '../tree/DecisionLine';
import type { Decision } from '../types';
import { Avatar, hue } from './LeadHead';
import '../notes/notes.css';
import './lead.css';
import './outbox.css';

const DAY_MS = 24 * 60 * 60 * 1000;
const UNDO_MS = 10_000; // outbox.rs UNDO_MS
// Shown in this order; the core refuses any other key (outbox.rs `check`). Bodies go in the text block.
const FIELDS = ['to', 'cc', 'bcc', 'subject', 'summary', 'startTime', 'endTime', 'timeZone', 'location', 'calendarId', 'replyThreadId'];
const BODIES = ['body', 'description'];
const opOf = (tool: string) => tool.split('__').pop() ?? tool;
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
type File = { path: string; text?: string };
// A command card (outbox.rs `COMMAND`): the exact line Send runs once, and the text of each file it names as the core
// read it, the program's too when it is a script (a binary program is bound by its hash only). No Open by hand.
const files = (v: unknown): File[] => (Array.isArray(v) ? v.filter((f): f is File => typeof f?.path === 'string' && typeof f.text === 'string') : []);

export function OutboxCard({ d, onAnswer, t }: { d: Decision; onAnswer: OnAnswer; t: T }) {
  const ask = d.owner?.type === 'outward' ? d.owner : null;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [now, setNow] = useState(Date.now());
  const yes = ask?.yes_at;
  useEffect(() => {
    if (!yes) return;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [yes]);
  if (!ask) return null;
  const op = opOf(ask.tool);
  const event = op === 'create_event';
  const command = ask.tool === 'Bash';
  const a = ask.args;
  const to = list(a.to);
  const subject = plain(String(a.subject ?? a.summary ?? ''));
  const name = plain(to.join(', '));
  const title = command ? t('outbox.card.titleCommand') : event ? t('outbox.card.titleEvent', { subject }) : t(a.replyThreadId || /^re:/i.test(subject) ? 'outbox.card.titleReply' : 'outbox.card.titleMail', { name });
  const left = Math.max(1, Math.ceil((DAY_MS - (Date.now() - d.observed_at)) / 3_600_000));
  const undoLeft = yes ? Math.max(0, Math.ceil((UNDO_MS - (now - yes)) / 1000)) : 0;
  const isNew = (addr: string) => !!ask.new_domains?.includes(addr.split('@').pop()?.toLowerCase() ?? '');
  const send = async (answer: Answer) => {
    setErr('');
    setBusy(true);
    try {
      await onAnswer(d, answer, answer.type !== 'deny');
    } catch (e) {
      setErr(rawError(e));
    }
    setBusy(false);
  };
  const value = (v: unknown) => {
    if (Array.isArray(v))
      return list(v).map((addr, i) => (
        <span key={i} className="obx-addr">
          {i > 0 && ', '}
          {plain(addr)}
          {isNew(addr) && <span className="obx-new">{t('outbox.card.newRecipient')}</span>}
        </span>
      ));
    return plain(String(v));
  };
  const body = BODIES.map((k) => a[k]).find((v) => typeof v === 'string') as string | undefined;
  return (
    <div className="deccard hosted mcard rcard obx" role="group" aria-label={title} data-item={d.id} data-outbox={op}>
      <div className="mc-head">
        <Avatar letter={ask.from} label={ask.from} c={hue(ask.from)} face={null} small />
        <b>{title}</b>
        <span className="obx-kind">{t(command ? 'outbox.card.kindCommand' : event ? 'outbox.card.kindEvent' : 'outbox.card.kindMail')}</span>
      </div>
      {command && (
        <>
          <dl className="obx-fields">
            <div className="obx-row">
              <dt>{t('outbox.field.command')}</dt>
              <dd>
                <code>{plain(String(a.command ?? ''))}</code>
              </dd>
            </div>
          </dl>
          {files(a.files).map((f, i) => (
            <div key={`${i}:${f.path}`}>
              <p className="obx-why">{t('outbox.card.file', { path: plain(f.path) })}</p>
              <div className="obx-body" tabIndex={0}>
                {plain(f.text ?? '')}
              </div>
              <p className="obx-why">{t('outbox.card.lines', { n: plain(f.text ?? '').split('\n').length })}</p>
            </div>
          ))}
        </>
      )}
      <dl className="obx-fields">
        {FIELDS.filter((k) => k in a).map((k) => (
          <div key={k} className="obx-row">
            <dt>{t(`outbox.field.${k}` as Key)}</dt>
            <dd>{value(a[k])}</dd>
          </div>
        ))}
      </dl>
      {!command && body && (
        <>
          {/* Fable lane 2 review S3: the box shows its scrollbar and how long the text is, so a short first screen never
              reads as the whole mail. */}
          <div className="obx-body" tabIndex={0}>
            {plain(body)}
          </div>
          <p className="obx-why">{t('outbox.card.lines', { n: plain(body).split('\n').length })}</p>
        </>
      )}
      <p className="obx-why">
        {[ask.source && t('outbox.card.source', { source: plain(ask.source) }), age(t, Date.now() - d.observed_at), t('outbox.card.expires', { n: left })].filter(Boolean).join(' · ')}
      </p>
      <ErrorLine t={t} error={err} className="dc-hint err" />
      <div className="dc-btns mc-btns">
        {yes ? (
          <>
            <span className="obx-sending" role="status">
              {t('outbox.card.sending', { n: undoLeft })}
            </span>
            <button type="button" className="b y" data-act="undo-outbox" disabled={busy || undoLeft === 0} onClick={() => void send({ type: 'deny' })}>
              {t('outbox.card.undo')}
            </button>
          </>
        ) : (
          <>
            <button type="button" className="b y" data-act="send-outbox" aria-label={`${t(command ? 'outbox.card.run' : event ? 'outbox.card.create' : 'outbox.card.send')} · ${title}`} disabled={busy} onClick={() => void send({ type: 'allow_once' })}>
              {t(command ? 'outbox.card.run' : event ? 'outbox.card.create' : 'outbox.card.send')}
            </button>
            {!command && (
              <button type="button" className="b" data-act="open-outbox" disabled={busy} onClick={() => void send({ type: 'choose', index: 1 })}>
                {t(event ? 'outbox.card.openCalendar' : 'outbox.card.open')}
              </button>
            )}
            <button type="button" className="b" data-act="discard" disabled={busy} onClick={() => void send({ type: 'deny' })}>
              {t('outbox.card.discard')}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
