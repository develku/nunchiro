// Manual card create, edit and delete. Enter in the title saves, except the Enter that commits a Hangul syllable.
import { PLAIN } from '../plainText';
import { useState } from 'react';
import { askNew } from '../NewSession';
import { sessionName } from '../Sidebar';
import type { Session } from '../types';
import { columnTitle, type Card, type Column } from './model';
import type { T } from './Board';
import { setPendingStart } from './startFromCard';
import { lineError } from '../errors';

/** Ticket 225: New session opens with the card's title, note and project; the user's own Start there attaches it as the card's
 * worker. Reached from the editor, the card detail and the card itself (ticket 991 B16). */
export function startCard(card: Card, title = card.title, note = card.note) {
  setPendingStart({ cardId: card.id, title, note, project: card.project, attachments: (card.attachments ?? []).map((a) => ({ session_id: a.session_id, role: a.role })) });
  // A focused node removed with the editor sends no blur, which would hold the board frozen (needs 26) behind the dialog.
  (document.activeElement as HTMLElement | null)?.blur();
  askNew(card.project ?? undefined);
}

export type CardDraft = { title: string; note: string; column: string; session_id: string | null };
const bytes = (s: string) => new TextEncoder().encode(s).length;
export const imeEnter = (e: React.KeyboardEvent) => e.nativeEvent.isComposing || e.keyCode === 229;

export function CardEditor(p: {
  t: T;
  card: Card | null;
  columns: Column[];
  column: string;
  sessions: Session[];
  onSave: (d: CardDraft) => Promise<void>;
  onDelete: () => Promise<void>;
  onClose: () => void;
}) {
  const [d, setD] = useState<CardDraft>({ title: p.card?.title ?? '', note: p.card?.note ?? '', column: p.card?.column ?? p.column, session_id: p.card?.session_id ?? null });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const run = async (f: () => Promise<void>) => {
    setBusy(true);
    try {
      await f();
      p.onClose();
    } catch (e) {
      setError(lineError(p.t, e));
      setBusy(false);
    }
  };
  const save = () => {
    if (!d.title.trim() || bytes(d.title) > 256) return setError(p.t('board.card.errTitle'));
    if (bytes(d.note) > 65536) return setError(p.t('board.card.errNote'));
    void run(() => p.onSave(d));
  };
  const name = p.card ? p.t('board.card.edit') : p.t('board.card.new');
  // Ticket 225 (B7): a saved card that is not Done can start a session; New session opens prefilled and the user's own
  // Start there attaches it. A live attachment (a session still there) makes it "another" session.
  const card = p.card;
  const done = !!card && !!p.columns.find((c) => c.id === card.column)?.states.includes('done');
  const working = !!card?.attachments?.some((a) => p.sessions.some((s) => s.id === a.session_id));
  const startSession = () => {
    if (!card) return;
    p.onClose();
    startCard(card, d.title, d.note);
  };
  return (
    <div className="bedit" role="dialog" aria-label={name} onKeyDown={(e) => e.key === 'Escape' && !imeEnter(e) && (e.stopPropagation(), p.onClose())}>
      <b>{name}</b>
      <label>
        {p.t('board.card.title')}
        <input {...PLAIN} autoFocus value={d.title} onChange={(e) => setD({ ...d, title: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && !imeEnter(e) && (e.preventDefault(), save())} />
      </label>
      <label>
        {p.t('board.card.note')}
        <textarea {...PLAIN} rows={3} value={d.note} onChange={(e) => setD({ ...d, note: e.target.value })} />
      </label>
      <div className="brow">
        <label>
          {p.t('board.card.column')}
          <select value={d.column} onChange={(e) => setD({ ...d, column: e.target.value })}>
            {p.columns.map((c) => (
              <option key={c.id} value={c.id}>
                {columnTitle(p.t, c)}
              </option>
            ))}
          </select>
        </label>
        <label>
          {p.t('board.card.session')}
          <select value={d.session_id ?? ''} onChange={(e) => setD({ ...d, session_id: e.target.value || null })}>
            <option value="">{p.t('board.card.sessionNone')}</option>
            {p.sessions.map((s) => (
              <option key={s.id} value={s.id}>
                {sessionName(s)}
              </option>
            ))}
            {d.session_id && !p.sessions.some((s) => s.id === d.session_id) && <option value={d.session_id}>{p.t('board.card.sessionClosedOption', { id: p.t('decisions.someSession') })}</option>}
          </select>
        </label>
      </div>
      {error && (
        <p className="berr" role="alert">
          {error}
        </p>
      )}
      <div className="brow">
        {p.card && (
          <button className="btn" disabled={busy} onClick={() => void run(p.onDelete)}>
            {p.t('board.card.delete')}
          </button>
        )}
        {card && !done && (
          <button className="btn" title={p.t('board.start.hint')} onClick={startSession}>
            {working ? p.t('board.start.another') : p.t('board.start.button')}
          </button>
        )}
        <span className="sp" />
        <button className="btn" onClick={p.onClose}>
          {p.t('board.card.cancel')}
        </button>
        <button className="btn p" disabled={busy} onClick={save}>
          {p.t('board.card.save')}
        </button>
      </div>
    </div>
  );
}
