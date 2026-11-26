// ⌘Z takes out what Nunchiro put into the composer (mockup docs/design/draft-hold/index.html, panel 5): each write keeps
// the box as it was before and after, and what undoes the write elsewhere (a detach, words put back in the terminal).
// ⌘Z while the box still reads exactly `after` sets `before` and runs `undo`; after any edit of his it is the textarea's
// own undo. Window memory only, newest last, a few per session.
/** `undo` may answer later (a request): the box is restored only once it did, and the write stays when it failed. */
export type Write = { before: string; after: string; undo?: () => void | Promise<unknown>; line?: string };

const writes = new Map<string, Write[]>();
const KEEP = 5;

export function noteWrite(id: string, w: Write) {
  const list = writes.get(id) ?? [];
  list.push(w);
  writes.set(id, list.slice(-KEEP));
}
/** The newest write of session `id` while the box still shows its result, taken off the list. */
export function takeWrite(id: string, box: string): Write | undefined {
  const list = writes.get(id);
  const last = list?.[list.length - 1];
  if (!last || last.after !== box) return undefined;
  list!.pop();
  return last;
}
/** Session `id` has a write ⌘Z can undo with the box as it is. */
export const canUndo = (id: string, box: string) => writes.get(id)?.at(-1)?.after === box;
