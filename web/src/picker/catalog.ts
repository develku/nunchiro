// Model and effort catalog per agent (ticket 10). Claude: Claude Code 2.1.310 `--help` aliases and its model picker
// effort levels, fixed here and in the core (CLAUDE_MODELS in crates/nunchiro-core/src/sessions.rs; tests/picker.spec.ts
// keeps the two equal). Codex (ticket 1100): the core serves Codex's own list (`agent_models`: Codex's
// models_cache.json, else the core's fixed list), so a model Codex adds shows without a Nunchiro update. The core refuses
// anything else. Ids the owner added sit outside this list: newDefaults `modelChoices` merges them and sessions.rs
// `check_stored_model` accepts them.
import type { CoreClient } from '../api';
import type { AgentKind } from '../types';
import { seenVersion } from './seenModels';

/** `null` is "Default": no flag, the agent's own choice. */
export type Pick = string | null;
export type Option = { value: Pick; label: string };

const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

export const CLAUDE_MODELS: Option[] = [
  { value: 'fable', label: 'Fable' },
  { value: 'opus', label: 'Opus' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'haiku', label: 'Haiku' },
];
/** What the core served (`agent_models`); empty until it answers. Filled in place, so a reader that imported it sees the list. */
export const CODEX_MODELS: (Option & { efforts: string[] })[] = [];

let codexFor: CoreClient | null = null;
let codexRead = 0;
const codexSubs = new Set<() => void>();
const isRow = (r: unknown): r is { value: string; label: string; efforts: string[] } => {
  const o = (r ?? {}) as Record<string, unknown>;
  return typeof o.value === 'string' && typeof o.label === 'string' && Array.isArray(o.efforts) && o.efforts.every((e) => typeof e === 'string');
};
/** Reads Codex's list from `core`, once per core, or again with `again` (a menu opening: Codex may have fetched a new
 *  model since). A core that refuses (a browser tab without the op) leaves the list as it was. */
export function readCodexModels(core: CoreClient, again = false) {
  if (codexFor === core && !again) return;
  codexFor = core;
  core.request({ op: 'agent_models' }).then(
    (r) => {
      const rows = (r as { codex?: unknown }).codex;
      if (Array.isArray(rows)) setCodexModels(rows.filter(isRow));
    },
    () => void (codexFor === core && (codexFor = null)),
  );
}
/** The served list, set; also the seam a test without a core uses. */
export function setCodexModels(rows: { value: string; label: string; efforts: string[] }[]) {
  CODEX_MODELS.splice(0, CODEX_MODELS.length, ...rows.map((m) => ({ value: m.value, label: m.label, efforts: m.efforts })));
  codexRead++;
  codexSubs.forEach((f) => f());
}
export const subscribeModels = (f: () => void) => (codexSubs.add(f), () => void codexSubs.delete(f));
/** Changes each time the served list arrives, for `useSyncExternalStore`. */
export const modelsRead = () => codexRead;

const DEFAULT: Option = { value: null, label: 'Default' };

/** Ticket 454: a Claude alias with the version the user's sessions last ran it as ("Opus 5.5"); the plain name until one has. */
const versioned = (m: Option): Option => {
  const v = m.value ? seenVersion(m.value) : '';
  return v ? { ...m, label: `${m.label} ${v}` } : m;
};

export function models(kind: AgentKind): Option[] {
  return [DEFAULT, ...(kind === 'claude' ? CLAUDE_MODELS.map(versioned) : kind === 'codex' ? CODEX_MODELS : [])];
}

export function efforts(kind: AgentKind, model: Pick): Option[] {
  const list = kind === 'codex' ? (CODEX_MODELS.find((m) => m.value === model)?.efforts ?? LEVELS) : kind === 'claude' ? LEVELS : [];
  return [DEFAULT, ...list.map((e) => ({ value: e, label: e === 'xhigh' ? 'xHigh' : e }))];
}

/** The catalogue's name for a model value, or '' when it has none: a raw session value is never shown (needs 130). */
export function modelLabel(kind: AgentKind, model: Pick, list = models(kind)): string {
  // The "Default" entry is the menu's own row, not a model name: no model and an unnamed model both give ''.
  return list.find((m) => m.value !== null && m.value === model)?.label ?? '';
}

/** B15 (ticket 991): a model id the agent reported, as a name: "claude-fable-5-2" → "Fable 5.2", a Codex id by the catalogue. */
export function reportedLabel(kind: AgentKind, id: string): string {
  if (kind === 'codex') return CODEX_MODELS.find((m) => m.value === id)?.label ?? '';
  const m = /^claude-([a-z]+)-(\d{1,2})(?:-(\d{1,2}))?(?:-\d{8})?(?:\[1m\])?$/.exec(id);
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] === undefined ? '' : `.${m[3]}`}` : '';
}

/** The model chip's words: "<agent> · <model>", the agent alone when there is no name to show. A Default session names the
 *  model the agent reported (B15). */
export function modelText(agent: string, kind: AgentKind, model: Pick, list?: Option[], reported?: string): string {
  // Dogfood 11-20: a full id picked outside the menu (`agent start --model claude-opus-5-5`) is named too, not just "Claude".
  const label = modelLabel(kind, model, list) || reportedLabel(kind, model ?? reported ?? '');
  return label ? `${agent} · ${label}` : agent;
}

/** W35 picker: the Claude menu's order (mockup 2), Opus first as Claude Desktop lists it. */
export const CLAUDE_ORDER = ['opus', 'fable', 'sonnet', 'haiku'];

/** W35 picker: Claude's fast mode runs on Opus 5.5 and Fable 5.2 only (sessions/claude_modes.rs `fast_model`); a Default
 *  session counts by the model it reported, and one that reported none yet is let through (the core takes it). */
export function fastModel(model: Pick, reported?: string): boolean {
  const id = model ?? reported ?? '';
  return id === '' || /^(opus|fable)(\[1m\])?$/.test(id) || /^claude-(opus-5-5|fable-5-2)/.test(id);
}

/** W35 picker: the level as the menu names it ("xHigh"), the raw word when the list has none. */
export const effortLabel = (kind: AgentKind, model: Pick, effort: string) => efforts(kind, model).find((e) => e.value === effort)?.label ?? effort;
