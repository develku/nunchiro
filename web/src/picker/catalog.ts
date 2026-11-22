// Static model and effort catalog per agent (ticket 10). Sources: Claude Code 2.1.310 `--help` aliases and its
// model picker effort levels; Codex 0.161.0 listed models and their reported reasoning efforts
// (~/.codex/models_cache.json, read only). The core refuses anything else (CLAUDE_MODELS and CODEX_MODELS in
// crates/nunchiro-core/src/sessions.rs; tests/picker.spec.ts keeps the two lists equal). Ids the owner added sit outside this
// list: newDefaults `modelChoices` merges them and sessions.rs `check_stored_model` accepts them.
import type { AgentKind } from '../types';
import { seenVersion } from './seenModels';

/** `null` is "Default": no flag, the agent's own choice. */
export type Pick = string | null;
export type Option = { value: Pick; label: string };

const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
const ULTRA = [...LEVELS, 'ultra'];

export const CLAUDE_MODELS: Option[] = [
  { value: 'fable', label: 'Fable' },
  { value: 'opus', label: 'Opus' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'haiku', label: 'Haiku' },
];
export const CODEX_MODELS: (Option & { efforts: string[] })[] = [
  { value: 'gpt-6.1-terra', label: 'GPT-6.1 Terra', efforts: ULTRA }, // ticket 994: in Codex's own list (models_cache.json, 2026-11-18)
  { value: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', efforts: ULTRA },
  { value: 'gpt-6-astra', label: 'GPT-6 Astra', efforts: ULTRA },
  { value: 'gpt-6-sol', label: 'GPT-6 Sol', efforts: ULTRA },
  { value: 'gpt-6-luna', label: 'GPT-6 Luna', efforts: LEVELS },
  { value: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', efforts: ULTRA },
  { value: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', efforts: ULTRA },
  { value: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', efforts: LEVELS },
];

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
