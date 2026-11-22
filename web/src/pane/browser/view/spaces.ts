// V2.5-19: spaces that have a stored data store in the app (a page was opened for them in some run). Forget stays available
// after a restart, when no view exists yet. A broken store reads as empty.
const KEY = 'nunchiro.browser.spaces.v1';

export function parseSpaces(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}
const read = (): string[] => {
  try {
    return parseSpaces(JSON.parse(localStorage.getItem(KEY) ?? 'null'));
  } catch {
    return [];
  }
};
const write = (list: string[]) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // Storage blocked: Forget is offered only after a page opens in this run.
  }
};
export const hasStore = (space: string) => read().includes(space);
export const noteStore = (space: string) => hasStore(space) || write([...read(), space]);
export const dropStore = (space: string) => write(read().filter((s) => s !== space));

/** Ticket 288 (needs 213): the user's own browser space, the core's `browser::YOU` store (logins and tabs kept). No agent verb
 *  ever runs in it and it adds no grant: the app already keeps the store apart from every session's. */
export const YOU_SPACE = 'you';
/** The spaces the switcher offers: the user's own first, then each running agent session's (a shell has no browser). */
export const spaceChoices = (sessions: { id: string; kind: string; state: string; side_chat?: boolean }[]): string[] => [
  YOU_SPACE,
  ...sessions.filter((s) => s.state === 'running' && s.kind !== 'shell' && !s.side_chat).map((s) => s.id),
];
