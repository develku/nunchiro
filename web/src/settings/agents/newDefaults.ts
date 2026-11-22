// Ticket 223 (B3): what a new session starts with when the owner set it. Per agent CLI, with a project override field by
// field; a field nobody set leaves the session to its old inheritance (NewSession's `likeNew`). Shape after T3 Code's
// ProjectDefaultsSettings.tsx (a global default, a project value over it; MIT License, Copyright (c) 2026 T3 Tools Inc.; idea only).
import { useEffect, useState } from 'react';
import type { CoreClient } from '../../api';
import { models, type Option } from '../../picker/catalog';
import type { AgentKind } from '../../types';
import { currentFeature, defineSetting } from '../useFeatureSetting';

export type AgentCli = 'claude' | 'codex';
export type ModelDefault = { model?: string; effort?: string };
/** Ticket 382: retired, Settings now writes the core's `agents.permission`; only `legacyChoice` and an unmigrated launch read these. */
export const PERMISSIONS = ['default', 'acceptEdits', 'plan'] as const;
export type Permission = (typeof PERMISSIONS)[number];
export type Defaults = { claude?: ModelDefault; codex?: ModelDefault; permission?: Permission };
export type Stored = { all: Defaults; projects: Record<string, Defaults> };

/** One word of the agent's command line: a leading dash would read as a flag. */
export const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/[\]-]{0,127}$/;
const EFFORT = /^(low|medium|high|xhigh|max|ultra)$/;

const text = (v: unknown, shape: RegExp) => (typeof v === 'string' && shape.test(v) ? v : undefined);
const cleanModel = (v: unknown): ModelDefault => {
  const o = (v ?? {}) as Record<string, unknown>;
  return { model: text(o.model, MODEL_NAME), effort: text(o.effort, EFFORT) };
};
const cleanOne = (v: unknown): Defaults => {
  const o = (v ?? {}) as Record<string, unknown>;
  return { claude: cleanModel(o.claude), codex: cleanModel(o.codex), permission: PERMISSIONS.find((p) => p === o.permission) };
};

export const NEW_DEFAULTS = defineSetting<Stored>('agents.new_session_defaults', { all: {}, projects: {} }, (v) => {
  if (typeof v !== 'object' || v === null) return undefined;
  const o = v as Record<string, unknown>;
  return { all: cleanOne(o.all), projects: Object.fromEntries(Object.entries((o.projects ?? {}) as object).map(([p, d]) => [p, cleanOne(d)])) };
});

/** Ticket 357: the models turned off per agent; absent means on. Every list that offers a model reads it (never `catalog.models()`:
 *  a running session's chip text and a stored default still need the full list). */
export type ModelsOff = Partial<Record<AgentCli, string[]>> & { acp?: Record<string, string[]> };
export const MODELS_OFF = defineSetting<ModelsOff>('agents.models_off', {}, (v) => {
  if (typeof v !== 'object' || v === null) return undefined;
  const list = (x: unknown) => (Array.isArray(x) ? x.filter((m): m is string => typeof m === 'string' && MODEL_NAME.test(m)) : []);
  // Ticket 358: per ACP entry name. An agent's own values never reach a command line, so they need not be one argv word.
  const values = (x: unknown) => (Array.isArray(x) ? x.filter((m): m is string => typeof m === 'string') : []);
  const o = v as Record<string, unknown>;
  return { claude: list(o.claude), codex: list(o.codex), acp: Object.fromEntries(Object.entries((o.acp ?? {}) as object).map(([name, off]) => [name, values(off)])) };
});
/** `acp` is the entry name of an ACP session (`Session.acp_agent`). */
export const isOff = (off: ModelsOff, kind: AgentKind, model: string | null | undefined, acp?: string | null) => !!model && (kind === 'acp' ? !!acp && !!off.acp?.[acp]?.includes(model) : (kind === 'claude' || kind === 'codex') && !!off[kind]?.includes(model));

/** Ticket 358: the owner's own model ids per agent, a core value so a launch can accept them (sessions.rs `check_stored_model`).
 *  `name` is absent when it would only repeat the id. */
export const CUSTOM_MODELS = 'agents.custom_models';
export type CustomModel = { id: string; name?: string };
export type CustomModels = Partial<Record<AgentCli, CustomModel[]>>;
/** The core's rule (accounts.rs `check_label`), so the button only offers what the core accepts. */
export const validName = (name: string) => name.trim() !== '' && [...name].length <= 64 && new TextEncoder().encode(name).length <= 192 && !/[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}⠀\u{16FE4}\u{1D159}]/u.test(name);
const customList = (x: unknown): CustomModel[] => {
  const seen = new Set<string>();
  return (Array.isArray(x) ? x : []).flatMap((m) => {
    const o = (m ?? {}) as Record<string, unknown>;
    const id = text(o.id, MODEL_NAME);
    if (!id || seen.has(id)) return [];
    seen.add(id);
    return typeof o.name === 'string' && validName(o.name) ? [{ id, name: o.name }] : [{ id }];
  });
};
export const cleanCustomModels = (v: unknown): CustomModels => {
  const o = (v ?? {}) as Record<string, unknown>;
  return { claude: customList(o.claude), codex: customList(o.codex) };
};
/** The built-in list plus the owner's ids, after t3code modelSelection.ts `getAppModelOptions` (MIT License, Copyright (c) 2026
 *  T3 Tools Inc.). Every list that offers a model reads this; `catalog.models()` stays what the core ships with. */
export function modelChoices(kind: AgentKind, custom: CustomModels): Option[] {
  const built = models(kind);
  const mine = kind === 'claude' || kind === 'codex' ? (custom[kind] ?? []) : [];
  return [...built, ...mine.filter((m) => !built.some((o) => o.value === m.id)).map((m) => ({ value: m.id, label: m.name ?? m.id }))];
}
/** Ticket 358: `stored` with `model` gone from every default of this agent that names it, for all projects and each project; the effort stays. */
export function withoutDefaultModel({ all, projects }: Stored, kind: AgentCli, model: string): Stored {
  const drop = (d: Defaults): Defaults => (d[kind]?.model === model ? { ...d, [kind]: { ...d[kind], model: undefined } } : d);
  return { all: drop(all), projects: Object.fromEntries(Object.entries(projects).map(([p, d]) => [p, drop(d)])) };
}
/** The stored ids for a list outside Settings, read again when `again` changes. A window the core refuses (a browser tab) lists the built-ins. */
export function useCustomModels(core: CoreClient, again?: unknown): CustomModels {
  const [value, setValue] = useState<CustomModels>({});
  useEffect(() => {
    let live = true;
    core.request({ op: 'quit_settings' }).then(
      (r) => live && setValue(cleanCustomModels((r as { settings: { features?: Record<string, unknown> } }).settings.features?.[CUSTOM_MODELS])),
      () => {},
    );
    return () => void (live = false);
  }, [core, again]);
  return value;
}

/** Ticket 358: the CLI agents turned off in Settings > Accounts; absent means on. Every new-session agent surface reads it; a
 *  running session never does. Same rule as t3code providerInstances.ts (MIT License, Copyright (c) 2026 T3 Tools Inc.; idea only). */
export const AGENTS_OFF = defineSetting<AgentCli[]>('agents.off', [], (v) => (Array.isArray(v) ? v.filter((a): a is AgentCli => a === 'claude' || a === 'codex') : undefined));
export const agentOff = (kind: string) => currentFeature(AGENTS_OFF).includes(kind as AgentCli);

/** The agent a new session starts on (tickets 305, 223, 358): the default agent, else the one used last; never one that is off. */
export const leadAgent = (defaultAgent: string, sessions: readonly { kind: string }[]) =>
  (agentOff(defaultAgent) ? '' : defaultAgent) || [...sessions].reverse().find((s) => (s.kind === 'claude' || s.kind === 'codex') && !agentOff(s.kind))?.kind;

/** The core's `agents.permission` values (api.rs `PermissionChoice`). */
export type AgentChoice = 'own' | 'ask' | 'accept-edits' | 'auto' | 'full-access';
/** Ticket 382: what a value stored by the old row becomes. Dropping one would widen that owner to full access, and
 *  `agents.permission` has no project level and no Plan, so the strictest intent wins for Claude. */
export function legacyChoice({ all, projects }: Stored): AgentChoice | null {
  const old = [all, ...Object.values(projects)].flatMap((d) => d.permission ?? []);
  return !old.length ? null : old.every((p) => p === 'acceptEdits') ? 'accept-edits' : 'ask';
}
const noPermission = ({ permission: _, ...rest }: Defaults): Defaults => rest;
export const withoutPermission = ({ all, projects }: Stored): Stored => ({ all: noPermission(all), projects: Object.fromEntries(Object.entries(projects).map(([p, d]) => [p, noPermission(d)])) });

/** Ticket 382: the old row's values, kept so they can be restored by hand, and the record that makes the move safe to resume:
 *  `before` is the core's choice when the move began, `to` what it may become, `moved` that the core step is over. */
export type PermissionBackup = { all?: Permission; projects: Record<string, Permission>; before: AgentChoice; to: AgentChoice; moved: boolean };
const CHOICES: AgentChoice[] = ['own', 'ask', 'accept-edits', 'auto', 'full-access'];
const permissionOf = (v: unknown) => PERMISSIONS.find((p) => p === v);
export const PERMISSION_BACKUP = defineSetting<PermissionBackup | null>('agents.new_session_permission_backup', null, (v) => {
  const o = (v ?? {}) as Record<string, unknown>;
  const before = CHOICES.find((c) => c === o.before);
  const to = CHOICES.find((c) => c === o.to);
  if (!before || !to || typeof o.moved !== 'boolean') return undefined;
  const projects = Object.entries((o.projects ?? {}) as object).flatMap(([p, d]) => (permissionOf(d) ? [[p, permissionOf(d)!] as const] : []));
  return { all: permissionOf(o.all), projects: Object.fromEntries(projects), before, to, moved: o.moved };
});
export function permissionBackup({ all, projects }: Stored, before: AgentChoice, to: AgentChoice): PermissionBackup {
  return { all: all.permission, projects: Object.fromEntries(Object.entries(projects).flatMap(([p, d]) => (d.permission ? [[p, d.permission] as const] : []))), before, to, moved: false };
}
/** Least to most access, the order of the composer's mode list (perm-chip.ts). `own` is the agent's setting: it cannot be ranked, so it is never replaced. */
const STRICTNESS: Partial<Record<AgentChoice, number>> = { 'full-access': 0, auto: 1, 'accept-edits': 2, ask: 3 };
/** The core is written only if the owner has not changed it since the move began, and only to tighten it. */
export const mayMove = (b: PermissionBackup, now: AgentChoice) => now === b.before && now !== 'own' && STRICTNESS[b.to]! > STRICTNESS[now]!;

/** What this project starts `kind` with; empty fields were not set. A permission still here predates ticket 382 and holds until Settings > Agents
 *  moves it to `agents.permission` (else that launch would widen to full access). It is a Claude flag only: on Codex any
 *  launch arg turns its hook injection off (sessions.rs, `start.args.is_empty()`). */
export function newDefaults(kind: AgentKind, project: string): ModelDefault & { args?: string[] } {
  if (kind !== 'claude' && kind !== 'codex') return {};
  const { all, projects } = currentFeature(NEW_DEFAULTS);
  const here = projects[project];
  const permission = kind === 'claude' ? (here?.permission ?? all.permission) : undefined;
  return {
    model: here?.[kind]?.model ?? all[kind]?.model,
    effort: here?.[kind]?.effort ?? all[kind]?.effort,
    ...(permission && permission !== 'default' ? { args: ['--permission-mode', permission] } : {}),
  };
}
