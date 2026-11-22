// Icon bars (LAYOUT D5b, A01-A14): each icon is a widget on the left or right bar; a click opens it in that side's
// sidebar, one at a time. The arrangement is window settings (settings.ts), not layout.toml, which keeps main zones only.
// Pure: the pure specs load this file in Node. Drops go through `TARGETS`, the one drop-target list lane B extends.
import { isUserKind, kindName, kindOf, type Dir, type Item } from './model';
import { ENTRIES } from './registry';
import type { Key } from '../i18n';

type T = (key: Key, args?: Record<string, string | number>) => string;

export type Side = 'left' | 'right';
export const SIDES: Side[] = ['left', 'right'];
/** ICONBAR: a bar is a column of icon-size slots. An icon sits in any slot; empty slots stay empty. */
export const SLOTS = 10;
export type Slot = string | null;
export interface Bars {
  left: Slot[];
  right: Slot[];
  /** The widget open in each side's sidebar; null = that sidebar is collapsed. */
  active: Record<Side, string | null>;
  /** D5b lane B: project folder path to the widget kinds nested under it as sub-views, in nest order. A widget keeps its bar slot. */
  nest: Record<string, string[]>;
  /** Whether each sub-view is open, keyed `<project path>::<kind>` (a missing key reads as closed). */
  open: Record<string, boolean>;
  /** PLACED once the v25 placement (Settings bottom-left, Layout bottom-right, Browser) was applied; an older store has none. */
  placed?: number;
  /** v25-shell-chrome (ticket 283), v25f F12 (owner 11-08, amends needs 206): each side's own Sidebar width, px. Kept with the
   *  arrangement, so each layout (a saved preset too) has its own; a side absent = SIDEBAR_W. */
  sidebarW?: Partial<Record<Side, number>>;
  /** Ticket 997 L2 (rule A7, owner 11-19): each widget's own Sidebar width, px, by widget id. A widget absent here takes its
   *  side's `sidebarW` (the width from before per-widget widths), then SIDEBAR_W. */
  widgetW?: Record<string, number>;
  /** v25f F13: both icon bars are hidden (the sidebars stay as they are); absent = shown. */
  barsHidden?: boolean;
}

/** Sidebar width: default, minimum (from t3code's thread sidebar, MIT: 13rem), and the widest a sidebar may be. */
export const SIDEBAR_W = 250;
export const SIDEBAR_MIN = 208;
export const SIDEBAR_MAX = 4000;
/** One keyboard / palette step of a Sidebar width. */
export const SIDEBAR_STEP = 24;
/** Ticket 1041 (owner 2026-11-22, supersedes ticket 283 item 5): the Icon bars are icons only, at one fixed width; no drag. */
const BAR_W = 48;
/** What a sidebar leaves for the rest of the window: the chat minimum (pane/store.ts CHAT_MIN, 320) and both Icon bars. */
const CENTRE_KEEP = 320 + 2 * BAR_W;
/** The widest a sidebar may be in a window of `window` px while the other side's sidebar takes `other` px (0 when it is closed). */
export const maxWidth = (window: number, other = 0) => Math.max(SIDEBAR_MIN, Math.floor(window - other - CENTRE_KEEP));
const inRange = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;

/** The tree stays in the window: on a bar or in one main zone (needs 157 (2)), never removed, never two. */
export const REQUIRED = 'tree';
/** Widgets that never leave the window (they may move anywhere else, a main zone included), with the reason a removal
 *  is refused. Decisions holds the only risky allow. */
export const REQUIRED_WHY: Record<string, 'own.refuse.treeRequired' | 'own.refuse.decisionsRequired'> = {
  tree: 'own.refuse.treeRequired',
  decisions: 'own.refuse.decisionsRequired',
};
export const isRequired = (w: string) => Object.hasOwn(REQUIRED_WHY, kindOf(w));
/** Settings and Layout sit in slots like widgets (they move) but are not widgets: no sidebar, no zone. Browser
 *  (v25 placement) is the same kind of icon: a click opens the session's side pane on its Browser tab. */
export const PSEUDO = ['settings', 'layout', 'browser'];
/** Icons that can move but never leave the bars (the tree may leave them for a zone, needs 157 (2)). */
export const FIXED = PSEUDO;
/** Composer and Answer strip live in the main area only (A14). Terminal is bar-placeable since AGENTVIEW (TERMW): its icon
 *  toggles the session's side pane. Preview is never on a bar (RIGHTBAR): it is the side pane's tab, or a main zone. */
export const MAIN_ONLY = ['composer', 'waiting', 'preview'];
/** Icons whose click opens no sidebar: Settings and Layout and the Terminal (the side pane). V2.5-38: the Board opens in
 *  its bar's sidebar when placed there (a drop); its icon click stays a centre tab otherwise (App, needs 103). */
const noSidebar = (w: string) => PSEUDO.includes(w) || kindOf(w) === 'terminal';
const pseudoName = (w: string) => (w === 'layout' ? 'Layout' : w === 'browser' ? 'Browser' : 'Settings');
export const onlyMain = (w: string) => MAIN_ONLY.includes(kindOf(w));
const pad = (l: Slot[]): Slot[] => [...l, ...Array<Slot>(SLOTS - l.length).fill(null)];
/** The last slot is each bar's foot (rails.css pins it to the bottom). */
const FOOT = SLOTS - 1;
const withFoot = (l: Slot[], foot: string): Slot[] => [...pad(l).slice(0, FOOT), foot];
/** The current placement version (the owner on docs/design/v25-placement, 2026-10-31). */
export const PLACED = 2;
export const DEFAULT_BARS: Bars = {
  // Settings bottom-left, Layout bottom-right; Browser under Terminal (placement items 1 and 4).
  left: withFoot(['tree', 'files', 'search'], 'settings'),
  right: withFoot(['board', 'decisions', 'terminal', 'browser', 'diff', 'artifacts'], 'layout'),
  active: { left: 'tree', right: null },
  nest: {},
  open: {},
  placed: PLACED,
};
/** Once for an arrangement saved before PLACED (placement item 1, recommended option): Settings and Layout move to the
 *  feet only while they still sit in their old default slots (Layout right slot 1, Settings right slot 10) and the foot
 *  is free; Browser joins under Terminal when there is room. A user-placed icon stays. Pure: returns a new value. */
export function place(b: Bars): Bars {
  if ((b.placed ?? 0) >= PLACED) return b;
  const n: Bars = { ...b, left: [...b.left], right: [...b.right], placed: PLACED };
  if (n.right[FOOT] === 'settings' && n.left[FOOT] === null) (n.left[FOOT] = 'settings'), (n.right[FOOT] = null);
  if (n.right[0] === 'layout' && n.right[FOOT] === null) (n.right[FOOT] = 'layout'), (n.right[0] = null);
  if (!slotOf(n, 'browser')) {
    // Under Terminal: the icons below it move down one slot into the next free one; without Terminal, the first free slot.
    const t = n.right.indexOf('terminal');
    const free = n.right.findIndex((x, i) => x === null && i > t && i < FOOT);
    const first = n.right.slice(0, FOOT).indexOf(null);
    if (t >= 0 && free > t) n.right.splice(t + 1, free - t, 'browser', ...n.right.slice(t + 1, free));
    else if (first >= 0) n.right[first] = 'browser';
    else return b; // no room on the right bar: the old arrangement stays whole (Browser stays reachable from the side pane)
  }
  return n;
}
export const defaultBars = (): Bars => structuredClone(DEFAULT_BARS);

export const slotOf = (b: Bars, w: string): { side: Side; index: number } | null => {
  for (const side of SIDES) {
    const index = b[side].indexOf(w);
    if (index >= 0) return { side, index };
  }
  return null;
};
export const where = (b: Bars, w: string): Side | null => slotOf(b, w)?.side ?? null;
export const same = (a: Bars, b: Bars) => JSON.stringify(a) === JSON.stringify(b);
/** The slots of both bars and the nest (what a preset's dirty mark compares; opening a sidebar or a sub-view is not a change). */
export const members = (b: Bars) => JSON.stringify([b.left, b.right, Object.keys(b.nest).sort().map((k) => [k, b.nest[k]])]);
export const nestKey = (project: string, kind: string) => `${project}::${kind}`;
/** `kind` nested under `project`, open; null when it is already there (the caller says so). */
export function nestUnder(b: Bars, project: string, kind: string): Bars | null {
  if (b.nest[project]?.includes(kind)) return null;
  return { ...b, nest: { ...b.nest, [project]: [...(b.nest[project] ?? []), kind] }, open: { ...b.open, [nestKey(project, kind)]: true } };
}
/** The sub-view removed; an emptied project leaves the nest. */
export function unnest(b: Bars, project: string, kind: string): Bars {
  const rest = (b.nest[project] ?? []).filter((k) => k !== kind);
  const nest = { ...b.nest };
  if (rest.length) nest[project] = rest;
  else delete nest[project];
  const open = { ...b.open };
  delete open[nestKey(project, kind)];
  return { ...b, nest, open };
}
export const setOpen = (b: Bars, project: string, kind: string, on: boolean): Bars => ({ ...b, open: { ...b.open, [nestKey(project, kind)]: on } });
/** The icons of a bar in slot order, empties left out. */
export const icons = (b: Bars, side: Side): string[] => b[side].filter((w): w is string => !!w);
/** The first empty slot of `side`, else of the other side, else null. */
export function freeSlot(b: Bars, side: Side): { side: Side; index: number } | null {
  for (const s of [side, side === 'left' ? 'right' : 'left'] as Side[]) {
    const index = b[s].indexOf(null);
    if (index >= 0) return { side: s, index };
  }
  return null;
}

/** The tree back on the Left bar (its first slot when free, else the first free one) when it is on no bar; the caller
 *  (App.tsx, which sees layout.toml) knows it is in no zone either. With both bars full it takes the slot of the last
 *  left icon that may leave the bars (the tree is required, that icon stays in the library). */
export function withTree(b: Bars): Bars {
  if (slotOf(b, REQUIRED)) return b;
  const optional = b.left.map((w, i) => (w && !isRequired(w) && !PSEUDO.includes(w) ? i : -1)).filter((i) => i >= 0);
  const at = b.left[0] === null ? { side: 'left' as Side, index: 0 } : (freeSlot(b, 'left') ?? { side: 'left' as Side, index: optional.at(-1)! });
  const next = structuredClone(b);
  next[at.side][at.index] = REQUIRED;
  return next;
}

/** A sidebar whose widget left its bar collapses. */
function settle(b: Bars): Bars {
  for (const s of SIDES) if (b.active[s] && !b[s].includes(b.active[s])) b.active[s] = null;
  return b;
}
/** The bars without `w` (its slot stays empty); a sidebar that showed it collapses. */
export function without(b: Bars, w: string): Bars {
  const next = structuredClone(b);
  for (const s of SIDES) next[s] = next[s].map((x) => (x === w ? null : x));
  return settle(next);
}
/** ICONBAR: `w` into slot `index` of `side`. An empty slot takes it; an occupied one swaps with it (the occupant goes to
 *  `w`'s old slot). A widget that was on no bar (a library card) sends the occupant to the first free slot, or the drop
 *  is refused (null). The side opens `w`; a displaced widget that was open on its side collapses with it. */
export function drop(b: Bars, w: string, side: Side, index: number): Bars | null {
  const next = structuredClone(b);
  const from = slotOf(next, w);
  const occupant = next[side][index];
  if (occupant === w) {
    if (!noSidebar(w)) next.active[side] = w;
    return settle(next);
  }
  if (from) next[from.side][from.index] = occupant;
  else if (occupant) {
    const free = freeSlot(next, side);
    if (!free) return null;
    next[free.side][free.index] = occupant;
  }
  next[side][index] = w;
  // Settings and Layout open nothing in a sidebar.
  if (!noSidebar(w)) next.active[side] = w;
  return settle(next);
}
/** A click on an icon: opens its widget, or collapses the sidebar when it is the open one. */
export function toggle(b: Bars, w: string): Bars {
  const s = where(b, w);
  if (!s) return b;
  return { ...b, active: { ...b.active, [s]: b.active[s] === w ? null : w } };
}
/** Hides or shows both icon bars; shown leaves no field, so the arrangement equals one that was never hidden. */
export function toggleBars({ barsHidden, ...rest }: Bars): Bars {
  return barsHidden ? rest : { ...rest, barsHidden: true };
}
/** A command opens (never collapses) a widget on its bar. */
export function open(b: Bars, w: string): Bars {
  const s = where(b, w);
  return !s || b.active[s] === w ? b : { ...b, active: { ...b.active, [s]: w } };
}

/** Why `w` cannot go to a bar, or null. `t`: the window's language (ticket 565). */
export function refuses(w: string, to: 'bar' | 'remove' | 'nest', t: T): string | null {
  const k = kindOf(w);
  const name = () => WIDGET_LABEL(w);
  if (to === 'nest') {
    if (k === REQUIRED) return t('own.refuse.treeNest');
    if (PSEUDO.includes(w)) return t('own.refuse.pseudoNest', { name: name() });
    if (onlyMain(w)) return t('own.refuse.mainOnly', { name: name() });
    if (k === 'terminal') return t('own.refuse.terminalNest');
    if (k === 'preview') return t('own.refuse.previewNest');
    if ((k as string) === 'decisions') return t('own.refuse.decisionsNest');
    if (isUserKind(k)) return t('own.refuse.userNest');
    return null;
  }
  if (to === 'bar' && onlyMain(w)) return t('own.refuse.mainOnly', { name: name() });
  if (to === 'remove' && isRequired(k)) return t(REQUIRED_WHY[k]);
  if (to === 'remove' && PSEUDO.includes(k)) return t('own.refuse.pseudoRemove', { name: name() });
  return null;
}
const TITLES: Record<string, string> = Object.fromEntries(ENTRIES.map((e) => [e.kind, e.title]));

const known = (w: unknown): w is string => typeof w === 'string' && (ENTRIES.some((e) => e.kind === w) || isUserKind(w) || PSEUDO.includes(w));
/** A stored arrangement rebuilt from checked fields, or null: at most SLOTS slots a side (a short list is padded), known
 *  icons once each, Settings and Layout on a bar, the open widget on its side, none in main only. Bars with no tree are
 *  kept as stored: the tree may be in a zone of layout.toml, which only the window sees (App.tsx puts it back on the
 *  Left bar when it is in neither). A preset keeps its bars as saved, so its dirty mark stays right. */
export function cleanBars(v: unknown): Bars | null {
  const r = v as Record<string, unknown> | null;
  if (!r || typeof r !== 'object') return null;
  const a = r.active as Record<string, unknown> | null;
  const ok = (l: unknown) => Array.isArray(l) && l.length <= SLOTS && l.every((x) => x === null || known(x));
  if (!a || typeof a !== 'object' || !SIDES.every((s) => ok(r[s]))) return null;
  // An arrangement saved while Preview had a bar slot (interim build) keeps the rest and drops that icon.
  const dropPreview = (l: Slot[]) => l.map((x) => (x === 'preview' ? null : x));
  const left = pad(dropPreview(r.left as Slot[]));
  const right = pad(dropPreview(r.right as Slot[]));
  const all = [...left, ...right].filter((x): x is string => !!x);
  const placed = typeof r.placed === 'number' && r.placed >= 0 ? r.placed : 0;
  // A store from before Browser existed has no Browser icon; place() adds it once.
  const needed = placed >= PLACED ? PSEUDO : PSEUDO.filter((f) => f !== 'browser');
  if (new Set(all).size !== all.length || !needed.every((f) => all.includes(f)) || all.some(onlyMain)) return null;
  const lists = { left, right };
  const open = (v: unknown) => (v === 'preview' || v === 'terminal' ? null : (v as string | null));
  for (const s of SIDES) if (open(a[s]) !== null && !(lists[s] as Slot[]).includes(a[s] as string)) return null;
  // A width out of range is dropped, never partly trusted; the bars stay. v25f F12: an older store's one shared width is both sides'.
  // Ticket 1041: an older store's Icon bar width (`barW`, ticket 283) is not read; the bars have one width now.
  const sw = (typeof r.sidebarW === 'number' ? { left: r.sidebarW, right: r.sidebarW } : (r.sidebarW ?? {})) as Record<string, unknown>;
  const sides = Object.fromEntries(SIDES.flatMap((s) => (inRange(sw[s], SIDEBAR_MIN, SIDEBAR_MAX) ? [[s, Math.round(sw[s])]] : [])));
  const ww = (r.widgetW && typeof r.widgetW === 'object' && !Array.isArray(r.widgetW) ? r.widgetW : {}) as Record<string, unknown>;
  const each = Object.fromEntries(Object.entries(ww).flatMap(([w, v]) => (w.length <= 200 && inRange(v, SIDEBAR_MIN, SIDEBAR_MAX) ? [[w, Math.round(v)]] : [])));
  const widths = { ...(Object.keys(sides).length ? { sidebarW: sides } : {}), ...(Object.keys(each).length ? { widgetW: each } : {}) };
  return place({ left, right, active: { left: open(a.left), right: open(a.right) }, ...cleanNest(r.nest, r.open), placed, ...widths, ...(r.barsHidden === true ? { barsHidden: true } : {}) });
}
/** The nest and open maps of a stored arrangement. Old stores have none; garbage in either gives `{}` and the bars stay. */
// (`refuses` is used here only as a yes or no: the identity `t` keeps its answer a non-empty string.)
function cleanNest(nest: unknown, open: unknown): Pick<Bars, 'nest' | 'open'> {
  const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  const goodNest =
    obj(nest) &&
    Object.entries(nest).every(([p, l]) => p.length > 0 && p.length <= 4096 && Array.isArray(l) && l.length > 0 && new Set(l).size === l.length && l.every((k) => typeof k === 'string' && ENTRIES.some((e) => e.kind === k) && !refuses(k, 'nest', (key) => key)));
  if (nest === undefined || !goodNest) return { nest: {}, open: {} };
  const goodOpen = obj(open) && Object.entries(open).every(([k, v]) => typeof v === 'boolean' && k.length <= 4200);
  return { nest: nest as Bars['nest'], open: goodOpen ? (open as Bars['open']) : {} };
}

/** Short English names for the library's search; the mockup's Korean names match too (A17). */
export const KOREAN: Record<string, string> = {
  tree: '트리', settings: '설정', layout: '배치', agents: '에이전트', waiting: '답변 띠', terminal: '터미널', composer: '입력창', diff: '변경', files: '파일', board: '보드', search: '검색', preview: '미리보기', artifacts: '산출물', decisions: '결정',
};

/** The widget's name in the UI language (A12); English, the registry's title, where none is set (the pure specs). */
export const WIDGET_LABEL = (w: Item) => kindName(kindOf(w)) ?? (PSEUDO.includes(w) ? pseudoName(w) : (TITLES[kindOf(w)] ?? kindOf(w).replace(/^widget:/, '')));

/** The drop-target list (A36): every place a dragged widget can land outside the main zones. Lane B adds the project
 *  rows and the Tree icon here. A target is found by element; `side` names a bar, `remove` is the library's area. */
export type BarDrop = { kind: 'bar'; side: Side; index: number; el: Element } | { kind: 'remove'; el: Element } | { kind: 'project'; path: string; el: Element } | { kind: 'tree-icon'; el: Element } | { kind: 'split'; side: Dir; el: Element };
/** `w` is the dragged widget; `fromBar` says it is a bar icon (not a library card); `peek` is a drag outside edit mode
 *  (SPLITS: only the session view's split target answers it, split/Overlay.tsx). */
export type Drag = { w: string; fromBar: boolean; peek?: boolean };
export const TARGETS: ((x: number, y: number, d: Drag) => BarDrop | null)[] = [
  // Lane B (checked before the bar slot: the Tree icon is a slot). A drag exists only in edit mode.
  (x, y, { w, fromBar }) => {
    const el = document.elementFromPoint(x, y);
    const row = el?.closest<HTMLElement>('[data-project-path]');
    if (row) return { kind: 'project', path: row.dataset.projectPath!, el: row }; // the Tree is refused there, with its reason
    const slot = el?.closest<HTMLElement>('[data-slot]');
    // A bar icon over the Tree icon still reorders (lane A, A24); only a library card asks for a project. The Tree on its own icon stays a bar drop.
    return !fromBar && kindOf(w) !== REQUIRED && slot?.querySelector('[data-icon="tree"]') ? { kind: 'tree-icon', el: slot } : null;
  },
  (x, y) => {
    const el = document.elementFromPoint(x, y);
    const slot = el?.closest<HTMLElement>('[data-slot]');
    const nav = el?.closest<HTMLElement>('[data-bar]');
    if (!nav) return null;
    if (slot) return { kind: 'bar', side: nav.dataset.bar as Side, index: Number(slot.dataset.slot), el: slot };
    // Between slots (the bar's padding): the nearest slot of that bar.
    const all = [...nav.querySelectorAll<HTMLElement>('[data-slot]')];
    const near = all.sort((p, q) => Math.abs(p.getBoundingClientRect().top - y) - Math.abs(q.getBoundingClientRect().top - y))[0];
    return near ? { kind: 'bar', side: nav.dataset.bar as Side, index: Number(near.dataset.slot), el: near } : null;
  },
  (x, y) => {
    const el = document.elementFromPoint(x, y)?.closest('[data-remove-area]');
    return el ? { kind: 'remove', el } : null;
  },
];
export const targetAt = (x: number, y: number, drag: Drag): BarDrop | null => {
  for (const t of TARGETS) {
    const d = t(x, y, drag);
    if (d) return d;
  }
  return null;
};
