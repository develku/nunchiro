// Ticket 990 slice h (team-j.html view ③): a lead asks to merge a reviewed task. The lessons its seats proposed are
// kept as notes only on the user's word, each in the scope chosen here, and before the yes: a branch the user drops
// leaves nothing behind. The yes is bound by the core to the reviewed revision, so it is the confirmed allow.
import { PLAIN } from '../plainText';
import { useEffect, useState } from 'react';
import type { CoreClient } from '../api';
import { plain } from '../chat/pending';
import { ErrorLine, rawError } from '../errors';
import { Icon } from '../icons/Icon';
import { StrokeIcon } from '../settings/shell/NavIcon';
import { DENY_NOTE_MAX, type Answer } from '../queue/answer';
import { Select } from '../settings/shell/Row';
import type { OnAnswer, T } from '../tree/DecisionLine';
import type { Decision } from '../types';
import { areaOf, noteOp, scopeWords, type Scope, type ScopeKind } from './notes';
import { Avatar, hue } from '../lead/LeadHead';
import type { Seat } from '../lead/tasks';
import './notes.css';

type Review = { revision: string; pass: boolean; name: string };

/** `who`: the name of the lead that asks (look v15 B: the card named only the task's seats). */
export function MergeCard({ d, core, onAnswer, t, who }: { d: Decision; core: CoreClient; onAnswer: OnAnswer; t: T; who?: string }) {
  const ask = d.owner?.type === 'merge' ? d.owner : null;
  const learned = ask?.learned ?? [];
  const [kinds, setKinds] = useState<ScopeKind[]>(() => learned.map(() => 'project'));
  const [dropped, setDropped] = useState<boolean[]>(() => learned.map(() => false));
  // A yes refused after its notes were kept is tried again without keeping them twice.
  const [kept, setKept] = useState<Set<number>>(new Set());
  const [review, setReview] = useState<Review | null>(null);
  const [seats, setSeats] = useState<Seat[]>([]);
  const [why, setWhy] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => {
    if (!ask) return;
    core.request({ op: 'task', operation: 'show', id: ask.task, project: ask.place }).then(
      (r) => {
        const task = (r as { tasks?: { review?: Review; seats?: Seat[] }[] }).tasks?.[0];
        setReview(task?.review ?? null);
        setSeats(task?.seats ?? []);
      },
      () => {}, // the card stands without the reviewer's name
    );
  }, [core, ask?.task, ask?.place]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!ask) return null;

  const scopeOf = (i: number): Scope => {
    const l = learned[i];
    if (kinds[i] === 'me') return { kind: 'me' };
    if (kinds[i] === 'role') return { kind: 'role', role: l.role };
    return { kind: 'project', project: ask.place, area: areaOf(l.cites) };
  };
  const keeping = learned.map((_, i) => i).filter((i) => !dropped[i]);
  const send = async (a: Answer, notes: number[]) => {
    setErr('');
    setBusy(true);
    try {
      for (const i of notes.filter((i) => !kept.has(i))) {
        await noteOp(core, { operation: 'keep', task: ask.task, lesson: i, scope: scopeOf(i) });
        setKept((k) => new Set(k).add(i));
      }
      await onAnswer(d, a, a.type === 'allow_once');
    } catch (e) {
      setErr(rawError(e));
      setBusy(false);
    }
  };
  const short = ask.revision.slice(0, 7);
  const by = review?.pass && review.revision === ask.revision ? review.name : '';
  const title = t('notes.merge.title', { title: plain(ask.title) });
  const yes = learned.length && keeping.length ? t(keeping.length === 1 ? 'notes.merge.keep.one' : 'notes.merge.keep.other', { n: keeping.length }) : t('notes.merge.merge');
  return (
    <div className="deccard hosted mcard" role="group" aria-label={title} data-item={d.id}>
      <div className="mc-head">
        {seats.length > 0 && (
          <span className="lead-stack">
            {[...new Map(seats.map((s) => [s.role, s])).values()].map((s) => (
              <Avatar key={s.session} letter={s.role} label={s.name} c={hue(s.session)} face={null} small />
            ))}
          </span>
        )}
        <b>{title}</b>
        <span className="mc-meta">{who && `${plain(who)} · `}{by ? t('notes.merge.reviewedBy', { rev: short, name: plain(by) }) : t('notes.merge.reviewed', { rev: short })}</span>
      </div>
      {learned.length > 0 && (
        <div className="mc-learned">
          <h4>{t('notes.merge.learned', { count: learned.length })}</h4>
          {learned.map((l, i) => {
            const area = areaOf(l.cites);
            return (
              <div key={i} className="mc-lesson" data-dropped={dropped[i] || undefined}>
                <div className="mc-words">
                  <p>{plain(l.text)}</p>
                  <small>
                    {t('notes.merge.from', { name: plain(l.name) })}
                    {l.cites && ` · ${t('notes.cites', { file: plain(l.cites) })}`}
                  </small>
                </div>
                {/* Look 1117 v11 B N11-S3-4: a closed choice; the three scopes stacked in the narrow sidebar read as an open menu. */}
                <Select label={t('notes.scope.label')} value={kinds[i]} onChange={(v) => setKinds((k) => k.map((x, j) => (j === i ? (v as ScopeKind) : x)))}>
                  <option value="project">{area ? t('notes.scope.projectArea', { project: t('notes.scope.project'), area: `${area}/` }) : t('notes.scope.project')}</option>
                  <option value="role">{scopeWords(t, { kind: 'role', role: l.role })}</option>
                  <option value="me">{t('notes.scope.me')}</option>
                </Select>
                <button type="button" className="btn mc-drop" aria-pressed={dropped[i]} aria-label={t(dropped[i] ? 'notes.merge.undrop' : 'notes.merge.drop', { text: plain(l.text) })} disabled={busy || kept.has(i)} onClick={() => setDropped((x) => x.map((v, j) => (j === i ? !v : v)))}>
                  {dropped[i] ? <StrokeIcon name="undo" size={14} /> : <Icon name="x" size={14} />}
                </button>
              </div>
            );
          })}
        </div>
      )}
      <ErrorLine t={t} error={err} className="dc-hint err" />
      {why !== null && (
        <input {...PLAIN}
          className="dc-note"
          autoFocus
          value={why}
          maxLength={DENY_NOTE_MAX}
          disabled={busy}
          placeholder={t('notes.merge.whyPh')}
          aria-label={t('notes.merge.why')}
          onChange={(e) => setWhy(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            if (e.key === 'Enter') e.preventDefault(), void send(why.trim() ? { type: 'deny_with', text: why.trim() } : { type: 'deny' }, []);
            if (e.key === 'Escape') e.preventDefault(), setWhy(null);
          }}
        />
      )}
      <div className="dc-btns mc-btns">
        <button type="button" className="b y" data-act="merge" disabled={busy} onClick={() => void send({ type: 'allow_once' }, keeping)}>
          {yes}
        </button>
        {learned.length > 0 && keeping.length > 0 && (
          <button type="button" className="b" data-act="merge-only" disabled={busy} onClick={() => void send({ type: 'allow_once' }, [])}>
            {t('notes.merge.only')}
          </button>
        )}
        <button type="button" className="b" data-act="not-yet" disabled={busy} onClick={() => (why === null ? setWhy('') : void send(why.trim() ? { type: 'deny_with', text: why.trim() } : { type: 'deny' }, []))}>
          {t('notes.merge.notYet')}
        </button>
        <span className="mc-quiet">{t('notes.merge.nothingSaved')}</span>
      </div>
    </div>
  );
}
