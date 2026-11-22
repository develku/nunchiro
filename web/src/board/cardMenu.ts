// needs 171 (board r7): the card context menu. The six `board.card.*` registry commands (App.tsx) hand the card key from
// `data-menu-arg` to the board as a `nunchiro:board.card` event; each placed Board says here, per card key, which of them
// the card can take, so the menu greys the rest (`Command.enabledFor` sees only the key). The key is page text: it is
// only looked up, never evaluated or navigated to.
export const CARD_OPS = ['open', 'edit', 'next', 'prev', 'pr', 'delete'] as const;
export type CardOp = (typeof CARD_OPS)[number];
export const CARD_EVENT = 'nunchiro:board.card';
export interface CardEvent {
  op: CardOp;
  key: string;
}

type Can = (key: string, op: CardOp) => boolean;
/** One test per placed Board: can the card with this key take this op now (asked when the menu draws)? */
const boards = new Set<Can>();

export function registerBoard(can: Can) {
  boards.add(can);
  return () => void boards.delete(can);
}

export const cardCan = (key: string | undefined, op: CardOp) => !!key && [...boards].some((can) => can(key, op));

/** The command's `run`: the Board that holds the card acts on it (the first one; a stale key does nothing). */
export const runCard = (op: CardOp) => (key?: string) => key && window.dispatchEvent(new CustomEvent<CardEvent>(CARD_EVENT, { detail: { op, key } }));
