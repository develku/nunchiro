// Ticket 225 (B7): the card editor hands New session a card to start from, without going through App (needs 183: App
// is held by the split lane). One pending start at a time; New session takes it once, on mount.
export type PendingStart = { cardId: string; title: string; note: string; project: string | null; attachments: { session_id: string; role: string }[] };

let pending: PendingStart | null = null;
export const setPendingStart = (p: PendingStart | null) => void (pending = p);
export function takePendingStart() {
  const p = pending;
  pending = null;
  return p;
}

/** The first message: "<title>\n\n<note>" (no note, no blank line), capped at 4000 characters. Plain text only. */
export const startText = (p: Pick<PendingStart, 'title' | 'note'>) => (p.note.trim() ? `${p.title}\n\n${p.note}` : p.title).slice(0, 4000);
