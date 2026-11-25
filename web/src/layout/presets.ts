// Layout presets (A23, A24): a preset is the main zones plus the bars (membership, order, the open widget per side).
// Default, Review and Focus are built in; "Save as…" adds named ones to the window settings.
import { defaultBars, members, type Bars } from './bars';
import { defaultLayout, isKind, kindOf, RETIRED, withoutRetired, type Layout, type Node } from './model';

export interface Preset {
  name: string;
  root: Node;
  bars: Bars;
}
export const BUILT_IN = ['Default', 'Review', 'Focus'] as const;

export function builtIn(name: string): Preset | null {
  const d = defaultLayout();
  const bars = defaultBars();
  if (name === 'Default') return { name, root: d.root, bars };
  if (name === 'Focus') return { name, root: d.root, bars: { ...bars, active: { left: null, right: null } } };
  if (name === 'Review')
    return {
      name,
      root: { id: 'main', split: 'row', children: [d.root, { id: 'diff', size: 640, widgets: ['diff'] }] },
      bars: { ...bars, right: bars.right.map((w) => (w === 'diff' ? null : w)) }, // Diff is the zone
    };
  return null;
}

/** A preset by name: the user's saved one (it may override a built-in), else the built-in. */
export const find = (saved: Preset[], name: string): Preset | null => saved.find((p) => p.name === name) ?? builtIn(name);
export const names = (saved: Preset[]) => [...BUILT_IN, ...saved.map((p) => p.name).filter((n) => !(BUILT_IN as readonly string[]).includes(n))];

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** True when the window's zones or bar membership differ from the preset (the mark beside the name). */
export const dirty = (p: Preset | null, layout: Layout, bars: Bars) => !p || !sameJson(p.root, layout.root) || members(p.bars) !== members(bars);

/** Zones the way layout.toml names them: ids, sizes and widgets only, every widget a known kind. */
function node(v: unknown, depth = 0, ids = new Set<string>()): v is Node {
  const n = v as Record<string, unknown> | null;
  if (!n || typeof n !== 'object' || depth > 12 || typeof n.id !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(n.id) || ids.has(n.id)) return false;
  ids.add(n.id);
  if (n.size !== undefined && !(typeof n.size === 'number' && Number.isFinite(n.size) && n.size > 0)) return false;
  if (Array.isArray(n.widgets))
    return n.widgets.length > 0 && n.widgets.every((w) => typeof w === 'string' && (isKind(kindOf(w)) || kindOf(w) === RETIRED)) && (n.active === undefined || (Number.isInteger(n.active) && (n.active as number) < n.widgets.length));
  return (n.split === 'row' || n.split === 'column') && Array.isArray(n.children) && n.children.length > 0 && n.children.every((c) => node(c, depth + 1, ids));
}
/** Saved presets rebuilt from checked fields, or null when any is broken or two share a name. */
export function cleanPresets(v: unknown, cleanBars: (b: unknown) => Bars | null): Preset[] | null {
  if (!Array.isArray(v) || v.length > 50) return null;
  const out: Preset[] = [];
  for (const p of v as Record<string, unknown>[]) {
    const bars = cleanBars(p?.bars);
    if (!p || typeof p.name !== 'string' || !p.name.trim() || p.name.length > 60 || !bars || !node(p.root) || out.some((o) => o.name === p.name)) return null;
    out.push({ name: p.name, root: withoutRetired(p.root as Node) ?? defaultLayout().root, bars }); // ticket 1070: a preset that still names Agents loads without it
  }
  return out;
}
