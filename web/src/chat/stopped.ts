// N27 (look 1117 v3): a Stop pressed before any output leaves Claude's transcript with no record of it, so the chat showed
// the user's message with nothing after. The window remembers, per session, the newest chat event it had drawn when its
// own Stop was pressed; a turn that then ends with that message last reads as interrupted. Window memory only.
const seen = new Map<string, number>();
const stopped = new Map<string, number>();
export const seenCursor = (id: string, cursor: number) => void seen.set(id, cursor);
/** Ticket 1019 round 2: the newest chat event this window has drawn for the session (-1 before any). */
export const seenAt = (id: string) => seen.get(id) ?? -1;
export const markStopped = (id: string) => {
  const c = seen.get(id);
  if (c !== undefined) stopped.set(id, c);
};
/** The chat event cursor this window had drawn at its last Stop for the session. */
export const stoppedAt = (id: string) => stopped.get(id);
// v9-B-N2-S3-1: as Claude Code puts a prompt stopped before any output back in its box, the window gives that message
// back to the composer, once per stopped message (ChatView finds it, useComposerSend fills the box).
export const STOP_RETURN_EVENT = 'nunchiro:stop-return';
const returned = new Map<string, number>();
/** True the first time the stopped message at `key` is seen for the session. */
export const claimReturn = (id: string, key: number) => returned.get(id) !== key && (returned.set(id, key), true);
