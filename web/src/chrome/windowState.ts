// v25-shell-chrome (ticket 282 item 1): the window comes back as it was: open tabs, the focused tab, and the sessions it has
// seen (a tab the user closed stays closed after a restart). Splits and side panes keep their own stores (split/store.ts,
// pane/store.ts), also per session in this browser's storage. A broken store is ignored, never partly trusted.
// Ticket 302: every window keeps its own state under `PREFIX + id` (the id lives in sessionStorage, so it survives that
// window's reload and no other window's). `KEY` holds the state last written by any window: a window with no state of its
// own yet (a new one) starts from it. The states of windows that are gone are pruned to `WINDOW_MAX`, oldest write first.
export const KEY = 'nunchiro.window.v1';
export const PREFIX = 'nunchiro.window.v1:';
export const WINDOW_MAX = 8;
const ID_KEY = 'nunchiro.window.id';
const SEEN_MAX = 500;

export interface WindowState {
  /** Open tab ids in order: session ids, `file:` tabs, imported conversations. */
  tabs: string[];
  active: string | null;
  /** Session ids this window has shown before (a new one opens as a tab once; a seen one only if its tab was open). */
  seen: string[];
  /** Scroll position per session (px from the top). The shell keeps it; the chat view reads and writes it through `scrollOf` / `setScroll`. */
  scroll: Record<string, number>;
  /** Ticket 570: the selected project, each project's own active tab, and the project of a tab that has none of its own (an imported chat). Old states lack all three. */
  selected: string | null;
  activeBy: Record<string, string>;
  tabProj: Record<string, string>;
}

const strMap = (v: unknown): Record<string, string> | null =>
  v === undefined ? {} : v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every((x) => typeof x === 'string') ? (v as Record<string, string>) : null;

const strings = (v: unknown, max: number): string[] | null => (Array.isArray(v) && v.length <= max && v.every((x) => typeof x === 'string' && x.length > 0 && x.length < 4096) ? (v as string[]) : null);

/** A stored state rebuilt from checked fields, or null when any field is broken or a tab repeats. */
export function parse(v: unknown): WindowState | null {
  const r = v as Record<string, unknown> | null;
  if (!r || typeof r !== 'object') return null;
  const tabs = strings(r.tabs, 200);
  const seen = strings(r.seen, SEEN_MAX);
  const scroll = r.scroll;
  if (!tabs || !seen || new Set(tabs).size !== tabs.length) return null;
  if (r.active !== null && (typeof r.active !== 'string' || !tabs.includes(r.active) && !r.active.startsWith('room:'))) return null; // ticket 571: a project's Room tab is not in the tab list
  if (!scroll || typeof scroll !== 'object' || Array.isArray(scroll) || !Object.values(scroll).every((x) => typeof x === 'number' && Number.isFinite(x) && x >= 0)) return null;
  const activeBy = strMap(r.activeBy);
  const tabProj = strMap(r.tabProj);
  if (!activeBy || !tabProj || (r.selected !== undefined && r.selected !== null && typeof r.selected !== 'string')) return null;
  return { tabs, active: r.active as string | null, seen, scroll: scroll as Record<string, number>, selected: (r.selected as string | null | undefined) ?? null, activeBy, tabProj };
}

let state: WindowState | null = null;
let id = '';
// ponytail: a duplicated tab copies sessionStorage and so shares its id with the original; they then overwrite each other as before.
function windowId(): string {
  try {
    id = sessionStorage.getItem(ID_KEY) ?? '';
    if (!id) sessionStorage.setItem(ID_KEY, (id = crypto.randomUUID()));
  } catch {
    id ||= crypto.randomUUID(); // sessionStorage blocked: this page load only, a reload starts as a new window
  }
  return id;
}
const read = (key: string): WindowState | null => {
  try {
    return parse(JSON.parse(localStorage.getItem(key) ?? 'null'));
  } catch {
    return null;
  }
};
/** Writes the window's own state and the last-written copy; the stamp orders the windows for `prune`. */
function write(s: WindowState) {
  try {
    const text = JSON.stringify({ ...s, at: Date.now() });
    localStorage.setItem(PREFIX + id, text);
    localStorage.setItem(KEY, text);
  } catch {
    // Storage blocked: the window comes back empty next time.
  }
}
/** Drops the states of vanished windows beyond `WINDOW_MAX` (this window's is always kept); a stamp-less or broken one goes first. */
function prune() {
  try {
    const rows = Object.keys(localStorage)
      .filter((k) => k.startsWith(PREFIX) && k !== PREFIX + id)
      .map((k) => {
        try {
          const v = JSON.parse(localStorage.getItem(k) ?? 'null');
          return { k, at: parse(v) ? Number(v.at) || 0 : 0 };
        } catch {
          return { k, at: 0 };
        }
      })
      .sort((a, b) => b.at - a.at);
    for (const { k } of rows.slice(WINDOW_MAX - 1)) localStorage.removeItem(k);
  } catch {
    // As above.
  }
}
export function load(): WindowState | null {
  windowId();
  state = read(PREFIX + id) ?? read(KEY);
  prune();
  return state;
}
export function save(next: Omit<WindowState, 'scroll'>) {
  const s: WindowState = { ...next, seen: next.seen.slice(-SEEN_MAX), scroll: Object.fromEntries(Object.entries(state?.scroll ?? {}).filter(([id]) => next.seen.includes(id))) };
  if (JSON.stringify(s) === JSON.stringify(state)) return;
  state = s;
  write(s);
}
/** Where a session's view was scrolled to when the window last closed (the chat view restores it; nothing else reads it yet). */
export const scrollOf = (id: string): number | undefined => state?.scroll[id];
/** `null` forgets it (the view was at its bottom: it follows the newest message, nothing to restore). */
export function setScroll(id: string, top: number | null) {
  if (!state || (top !== null && (!Number.isFinite(top) || top < 0)) || state.scroll[id] === (top === null ? undefined : Math.round(top))) return;
  const scroll = { ...state.scroll };
  if (top === null) delete scroll[id];
  else scroll[id] = Math.round(top);
  state = { ...state, scroll };
  write(state);
}
