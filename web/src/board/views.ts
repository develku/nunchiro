// V2.5-38 (ticket 186, draft B): each placed board widget keeps its own view (lane key, filters, visible card fields,
// density) with the zone it sits in. Window storage like the bars arrangement in settings.ts, not board.toml: a broken
// or unknown value falls back to the zone's default, and storage that throws leaves the default for this window.
import { LANE_KEYS, NO_FILTERS, type Filters, type LaneKey } from './model';

export type Field = 'ref' | 'role' | 'waits' | 'pr' | 'receipt' | 'project';
export const FIELDS: Field[] = ['ref', 'role', 'waits', 'pr', 'receipt', 'project'];
export type Density = 'cards' | 'list';
export const DENSITIES: Density[] = ['cards', 'list'];

/** V2.5-69: `watch` is the default (columns derived from state); `columns` is the user-defined-columns board. */
export type Mode = 'watch' | 'columns';
export const MODES: Mode[] = ['watch', 'columns'];
/** The watch view's lanes: by project when more than one project shows (`auto`), always, or never. */
export type WatchLanes = 'auto' | 'project' | 'none';
export const WATCH_LANES: WatchLanes[] = ['auto', 'project', 'none'];

export interface View {
  mode: Mode;
  watchLanes: WatchLanes;
  /** The watch view also draws its Idle column. */
  showIdle: boolean;
  lane: LaneKey;
  filters: Filters;
  fields: Record<Field, boolean>;
  density: Density;
}

/** The right bar's zone id: a board there is a narrow widget. */
export const RIGHT = 'right';
/** A board placed with no zone id (an older caller) keeps the centre's view. */
export const CENTRE = 'centre';

/** Draft B: every field on except project, which the lane already names. */
const FIELDS_ON: Record<Field, boolean> = { ref: true, role: true, waits: true, pr: true, receipt: true, project: false };

/**
 * Test seam, built in only for the suite (VITE_FEATURE_FIXTURES, as features/index.ts): the specs written against the
 * columns board keep it as their default with one window flag; board-watch.spec.ts clears it to test the new default.
 */
function testMode(): Mode {
  if (!import.meta.env?.VITE_FEATURE_FIXTURES) return MODES[0];
  try {
    return localStorage.getItem('nunchiro.test.board-mode') === MODES[1] ? MODES[1] : MODES[0];
  } catch {
    return MODES[0];
  }
}

/**
 * Draft B: the centre board draws group lanes as cards; the right-bar widget is "Your turn only · one-line list · no lanes".
 * V2.5-69: the centre board opens as the watch view (the right bar's list keeps its own columns-based list).
 */
export function defaultView(zone: string): View {
  return zone === RIGHT
    ? { mode: 'columns', watchLanes: 'auto', showIdle: false, lane: 'none', filters: { ...NO_FILTERS, you: true }, fields: { ...FIELDS_ON }, density: 'list' }
    : { mode: testMode(), watchLanes: 'auto', showIdle: false, lane: 'group', filters: { ...NO_FILTERS }, fields: { ...FIELDS_ON }, density: 'cards' };
}

const key = (zone: string) => `nunchiro.board.view.${zone}`;

/** Each value read is checked on its own: one broken value falls back to the zone default, the rest are kept. */
export function parseView(raw: string | null, zone: string): View {
  const d = defaultView(zone);
  let v: Record<string, unknown>;
  try {
    v = raw === null ? null : JSON.parse(raw);
  } catch {
    return d;
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return d;
  const f = (v.filters && typeof v.filters === 'object' ? v.filters : {}) as Record<string, unknown>;
  const bool = (x: unknown, or: boolean) => (typeof x === 'boolean' ? x : or);
  const fields = (v.fields && typeof v.fields === 'object' ? v.fields : {}) as Record<string, unknown>;
  return {
    mode: MODES.includes(v.mode as Mode) ? (v.mode as Mode) : d.mode,
    watchLanes: WATCH_LANES.includes(v.watchLanes as WatchLanes) ? (v.watchLanes as WatchLanes) : d.watchLanes,
    showIdle: bool(v.showIdle, d.showIdle),
    lane: LANE_KEYS.includes(v.lane as LaneKey) ? (v.lane as LaneKey) : d.lane,
    filters: {
      you: bool(f.you, d.filters.you),
      role: Array.isArray(f.role) ? f.role.filter((r): r is string => typeof r === 'string') : d.filters.role,
      stale: bool(f.stale, d.filters.stale),
      missing: bool(f.missing, d.filters.missing),
      hideIdle: bool(f.hideIdle, d.filters.hideIdle),
    },
    fields: Object.fromEntries(FIELDS.map((k) => [k, bool(fields[k], d.fields[k])])) as Record<Field, boolean>,
    density: DENSITIES.includes(v.density as Density) ? (v.density as Density) : d.density,
  };
}

export function loadView(zone: string): View {
  try {
    return parseView(localStorage.getItem(key(zone)), zone);
  } catch {
    return defaultView(zone);
  }
}

export function saveView(zone: string, view: View) {
  try {
    localStorage.setItem(key(zone), JSON.stringify(view));
  } catch {
    // Storage blocked: the view lasts for this window only.
  }
}

/** A board leaving its zone forgets that zone's view, so placing it there again starts from the zone default. */
export function forgetView(zone: string) {
  try {
    localStorage.removeItem(key(zone));
  } catch {
    // Storage blocked: nothing was kept.
  }
}
