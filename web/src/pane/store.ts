// AGENTVIEW: the side pane of an agent session tab. Open state, shells and width are remembered in this window's storage
// (a broken store is ignored, never partially trusted); the open tab, maximise and an auto-open are for this window run only.
import { useSyncExternalStore } from 'react';
import type { Decision, Session } from '../types';
import { tEn } from '../i18n';
import { plan } from '../queue/answer';

export type PaneTab = 'pty' | 'browser' | 'preview' | { shell: string };
export const tabKey = (t: PaneTab) => (typeof t === 'string' ? t : `shell:${t.shell}`);

const OPEN = 'nunchiro.pane.open.v1';
const SHELLS = 'nunchiro.pane.shells.v1';
/** Ticket 997 L2 (rule A7): one width per pane widget (`widthKey`). The v1 store held one width for all; it seeds each. */
const WIDTH = 'nunchiro.pane.width.v2';
const WIDTH_V1 = 'nunchiro.pane.width.v1';
/** Pane and chat minimums (px), and the pane's share of the session view until the user drags the divider. */
export const PANE_MIN = 280;
export const CHAT_MIN = 320;
export const PANE_SHARE = 0.45;

const read = (key: string): unknown => {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null');
  } catch {
    return null;
  }
};
const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export function parseOpen(v: unknown): Record<string, true> {
  return plain(v) ? Object.fromEntries(Object.entries(v).filter(([, x]) => x === true)) as Record<string, true> : {};
}
export function parseShells(v: unknown): Record<string, string[]> {
  if (!plain(v)) return {};
  return Object.fromEntries(Object.entries(v).filter((e): e is [string, string[]] => Array.isArray(e[1]) && e[1].every((x) => typeof x === 'string')));
}
export const parseWidth = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= PANE_MIN && v <= 4000 ? v : null);
/** The pane widget a tab belongs to: the agent's terminal and its shells share the Terminal's width. */
export const widthKey = (t: PaneTab) => (t === 'browser' || t === 'preview' ? t : 'terminal');
/** The stored widths; without a v2 store, the v1 single width for every pane widget (nobody loses the width they had). */
export function parseWidths(v: unknown, v1: unknown): Record<string, number> {
  if (!plain(v)) return parseWidth(v1) === null ? {} : Object.fromEntries(['terminal', 'browser', 'preview'].map((k) => [k, parseWidth(v1)!]));
  return Object.fromEntries(Object.entries(v).filter((e): e is [string, number] => parseWidth(e[1]) !== null));
}

interface State {
  open: Record<string, true>;
  shells: Record<string, string[]>;
  /** By `widthKey`; a key absent = the default share. */
  width: Record<string, number>;
  /** Panes opened by a blocked screen: they close again when it clears. */
  auto: Record<string, true>;
  tab: Record<string, PaneTab>;
  max: Record<string, true>;
  /** A request to focus a session's pane terminal (n counts requests). */
  focus: { id: string; n: number; at: number } | null;
  /** SPLITKEYS: the terminal area split in two (this window run): `a` the terminal ⌘D split, `b` the shell it started. */
  grid: Record<string, Grid>;
  /** Ticket 288: the user's own Browser, open in the sidebar of its icon while no agent session's pane has it (this window run only). */
  you: boolean;
}
export type Grid = { dir: 'h' | 'v'; a: string; b: string };
let state: State = { open: parseOpen(read(OPEN)), shells: parseShells(read(SHELLS)), width: parseWidths(read(WIDTH), read(WIDTH_V1)), auto: {}, tab: {}, max: {}, focus: null, grid: {}, you: false };
const subs = new Set<() => void>();
const save = (key: string, v: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    // Storage blocked: the choice lasts for this window only.
  }
};
function set(next: Partial<State>) {
  const was = state;
  state = { ...state, ...next };
  if (state.open !== was.open) save(OPEN, state.open);
  if (state.shells !== was.shells) save(SHELLS, state.shells);
  if (state.width !== was.width) save(WIDTH, state.width);
  subs.forEach((f) => f());
}
const without = <T,>(m: Record<string, T>, id: string) => Object.fromEntries(Object.entries(m).filter(([k]) => k !== id));

export const usePane = () =>
  useSyncExternalStore(
    (f) => (subs.add(f), () => subs.delete(f)),
    () => state,
  );
export const shellsOf = (agent: string): string[] => state.shells[agent] ?? [];
/** A shell session that the pane started and holds as a tab: it is not also opened as a window tab. */
export const isPaneShell = (id: string) => Object.values(state.shells).some((l) => l.includes(id));
export const isOpen = (s: State, id: string) => !!(s.open[id] || s.auto[id]);
export const tabOf = (s: State, id: string): PaneTab => s.tab[id] ?? 'pty';
/** The tab a pane shows now, read outside a render. */
export const tabNow = (id: string) => tabOf(state, id);
export const openNow = (id: string) => isOpen(state, id);

export function toggle(id: string) {
  if (isOpen(state, id)) set({ open: without(state.open, id), auto: without(state.auto, id), max: without(state.max, id) });
  else set({ open: { ...state.open, [id]: true } });
}
/** The user opens it (and picks a tab); a request to focus its terminal rides along when the tab is a terminal. */
export function show(id: string, tab: PaneTab = 'pty', focus = false) {
  set({ open: { ...state.open, [id]: true }, tab: { ...state.tab, [id]: tab }, ...(focus ? { focus: { id, n: (state.focus?.n ?? 0) + 1, at: Date.now() } } : {}) });
}
/** Ticket 288: opens (`false` closes) the user's own Browser, the one that needs no agent session. */
export const showYou = (on = true) => set({ you: on });
export const select = (id: string, tab: PaneTab) => set({ tab: { ...state.tab, [id]: tab } });
export const maximise = (id: string) => setMax(id, !state.max[id]);
/** Ticket 997 L7: Take over maximises the pane and Hand back puts its width back, whatever the toggle did in between. */
export const setMax = (id: string, on: boolean) => set({ max: on ? { ...state.max, [id]: true } : without(state.max, id) });
/** The width of `tab`'s pane widget; null puts the default share back (double-click on the divider). */
export const setWidth = (tab: PaneTab, w: number | null) => {
  const { [widthKey(tab)]: _old, ...rest } = state.width;
  set({ width: w === null ? rest : { ...rest, [widthKey(tab)]: Math.round(w) } });
};
export const addShell = (agent: string, shell: string) => set({ shells: { ...state.shells, [agent]: [...(state.shells[agent] ?? []), shell] }, tab: { ...state.tab, [agent]: { shell } } });
export function removeShell(agent: string, shell: string) {
  const left = (state.shells[agent] ?? []).filter((x) => x !== shell);
  const t = state.tab[agent];
  const g = state.grid[agent];
  set({ shells: { ...state.shells, [agent]: left }, ...(t && typeof t !== 'string' && t.shell === shell ? { tab: without(state.tab, agent) } : {}), ...(g && (g.a === shell || g.b === shell) ? { grid: without(state.grid, agent) } : {}) });
}
export const setGrid = (agent: string, g: Grid) => set({ grid: { ...state.grid, [agent]: g } });
export const gridOf = (agent: string): Grid | undefined => state.grid[agent];
/** A blocked screen opens the pane on the PTY (once); clearing it closes a pane that only it opened. */
export function autoOpen(id: string, focus: boolean) {
  if (isOpen(state, id)) return void (focus && set({ focus: { id, n: (state.focus?.n ?? 0) + 1, at: Date.now() }, tab: { ...state.tab, [id]: 'pty' } }));
  set({ auto: { ...state.auto, [id]: true }, tab: { ...state.tab, [id]: 'pty' }, ...(focus ? { focus: { id, n: (state.focus?.n ?? 0) + 1, at: Date.now() } } : {}) });
}
export const autoClose = (id: string) => state.auto[id] && set({ auto: without(state.auto, id) });

/** Sources of an item as the core serialises them (types.ts does not carry the field). */
const sources = (d: Decision): string[] => (d as Decision & { sources?: string[] }).sources ?? [];
/** A pending item the chat cannot answer: a dialog, or a prompt only the screen detector saw (hooks silent) that the chat's
 *  card cannot answer either (not actionable). Ticket 1097: a screen-only question the docked card answers is the card's;
 *  opening the PTY for it showed the same question twice under a banner saying the chat could not show it. */
export const blocked = (s: Session | null | undefined): boolean =>
  !!s && s.state === 'running' && s.pending.some((d) => d.kind === 'dialog' || (['permission', 'question'].includes(d.kind) && sources(d).length === 1 && sources(d)[0] === 'screen' && !!plan(d, s, tEn).note));

/** A focus request is for the moment it is made: the pane that takes it clears it, and a stale one is never replayed. */
export const FOCUS_FRESH_MS = 1500;
export const clearFocus = (id: string) => void (state.focus?.id === id && set({ focus: null }));
