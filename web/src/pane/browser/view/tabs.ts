// Ticket 328 part 1: My browser's tabs. The first tab is the "you" space; each later one is a space `you:<id>` that the app
// gives its own native view on the same store and rules (mod.rs `rules_of`). The list (address, title, order, active) is
// kept in localStorage so it comes back after a restart; a page loads again only when its tab is shown.
// Closing picks the tab now at the closed one's place, else the one before it, as Orca does
// (orca src/renderer/src/store/slices/browser/browser-page-create-actions.ts:140-143).
import { YOU_SPACE, dropStore } from './spaces';
import { call, inApp } from './bridge';

export type Tab = { id: string; url: string; title: string };
export type Tabs = { tabs: Tab[]; active: string };

const KEY = 'nunchiro.browser.tabs.v1';
const ID = /^you:[A-Za-z0-9]{1,16}$/; // the app's own check (mod.rs `rules_of`); anything else would get an agent space's rules
/** A space of the owner's own browser: the first tab or a later one. */
export const isMine = (space: string) => space === YOU_SPACE || ID.test(space);

// Query names that may carry a secret (tokens, keys, OAuth codes and states, signatures, session ids). Their values never reach storage.
const SECRET = /token|key|secret|pass|pwd|auth|code|state|sig|session|sid|jwt|cred|otp|nonce|ticket/i;
/** What a tab keeps of an address: http(s) only, no user name or password, no fragment (OAuth puts tokens there), no
 *  secret-looking query parameter. Anything else keeps nothing. */
export function keptUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    u.username = u.password = u.hash = '';
    [...u.searchParams.keys()].filter((k) => SECRET.test(k)).forEach((k) => u.searchParams.delete(k));
    return u.href;
  } catch {
    return '';
  }
}
const titleOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
};

const first = (): Tabs => ({ tabs: [{ id: YOU_SPACE, url: '', title: '' }], active: YOU_SPACE });
/** A stored list, checked: unknown ids and duplicates go, addresses are kept again, and the active tab is one of them. */
export function parseTabs(v: unknown): Tabs {
  const o = v as { tabs?: unknown; active?: unknown } | null;
  if (!o || !Array.isArray(o.tabs)) return first();
  const seen = new Set<string>();
  const tabs = o.tabs.flatMap((x: { id?: unknown; url?: unknown }) => {
    if (!x || typeof x.id !== 'string' || !isMine(x.id) || seen.has(x.id)) return [];
    seen.add(x.id);
    const url = typeof x.url === 'string' ? keptUrl(x.url) : '';
    return [{ id: x.id, url, title: titleOf(url) }];
  });
  if (!tabs.length) return first();
  return { tabs, active: tabs.some((t) => t.id === o.active) ? (o.active as string) : tabs[0].id };
}

const read = (): Tabs => {
  try {
    return parseTabs(JSON.parse(localStorage.getItem(KEY) ?? 'null'));
  } catch {
    return first();
  }
};
let state = read();
const listeners = new Set<() => void>();
const set = (next: Tabs) => {
  state = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Storage blocked: the tabs last for this run only.
  }
  listeners.forEach((l) => l());
};
export const tabs = () => state;
export const watchTabs = (l: () => void) => (listeners.add(l), () => void listeners.delete(l));

const newId = () => `${YOU_SPACE}:${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
export const pickTab = (id: string) => state.tabs.some((t) => t.id === id) && state.active !== id && set({ ...state, active: id });
export function newTab() {
  const id = newId();
  const at = state.tabs.findIndex((t) => t.id === state.active) + 1;
  set({ tabs: [...state.tabs.slice(0, at), { id, url: '', title: '' }, ...state.tabs.slice(at)], active: id });
}
/** Moves `by` tabs from the active one, wrapping. */
export function stepTab(by: number) {
  const n = state.tabs.length;
  const at = state.tabs.findIndex((t) => t.id === state.active);
  pickTab(state.tabs[(((at + by) % n) + n) % n].id);
}
/** Closes the tab and its native view (its history goes; the logins are the store's and stay). The last tab gives way to an empty one. */
export function closeTab(id = state.active) {
  const at = state.tabs.findIndex((t) => t.id === id);
  if (at < 0) return;
  const rest = state.tabs.filter((t) => t.id !== id);
  const tabsNow = rest.length ? rest : [{ id: newId(), url: '', title: '' }];
  const active = state.active !== id ? state.active : (tabsNow[at] ?? tabsNow[at - 1]).id;
  set({ tabs: tabsNow, active });
  dropStore(id);
  if (inApp()) void call('browser_forget', { space: id }).catch(() => {});
}
/** The page the tab shows now; nothing changes when the kept address is the same. */
export function noteTabUrl(id: string, url: string) {
  const kept = keptUrl(url);
  const tab = state.tabs.find((t) => t.id === id);
  if (!tab || !kept || tab.url === kept) return;
  set({ ...state, tabs: state.tabs.map((t) => (t.id === id ? { ...t, url: kept, title: titleOf(kept) } : t)) });
}
/** The strip is on screen, so the tab keys have something to act on. */
let strips = 0;
export const stripShown = (d: number) => void (strips += d);
export const hasStrip = () => strips > 0;
