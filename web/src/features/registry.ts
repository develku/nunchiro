// Feature registry (V2.5-33d; ticket 169; needs 147; ticket 250 seams): a feature adds its Settings page or a section of
// any page from its own file under features/ (index.ts loads every file there), so a new row edits neither App.tsx nor
// SettingsView.tsx. Leaf module: it imports types only, so settings.ts and the pages can both depend on it.
//
// The contract absorb tickets 251-278 code against (ticket 250):
// - registerSettingsPage({ id, title, group, order, description?, fields?, render }): the page joins the nav inside
//   `group` (one of GROUPS), after that group's built-in pages, sorted by `order` (ties keep registration order).
//   `group` and `order` default to 'advanced' and 0 for the pages registered before they existed.
// - registerSettingsSection({ page, id, order, fields?, render }): a section drawn on `page` (built-in or registered)
//   after the page's own rows, sorted by `order`. The page must be registered by the time Settings draws it.
// - `fields` of both join FIELDS: the one settings search and the palette's `settings.<page>.<key>`; the label is the
//   catalogue's `field.<key>`. A repeated page id, section id or field key throws, and nothing is half-registered.
// - Values: window values through `defineSetting` / `useFeatureSetting`, core values through `useCoreFeature`
//   (settings/useFeatureSetting.ts).
//
// GROUPS lifts the shape of Orca's settings nav groups (an id per group, its title from the catalogue):
// orca/src/renderer/src/components/settings/settings-navigation-foundations.ts `SETTINGS_NAV_GROUPS`,
// MIT License, Copyright (c) 2026 Lovecast Inc. The group list itself is final.html's NAV (needs 192).
import { useSyncExternalStore, type ReactNode } from 'react';
import type { CoreClient } from '../api';
import type { Command } from '../keys';
import type { Settings } from '../settings';
import type { T } from '../i18n';
import type { Session } from '../types';
import { BUILTIN_FIELDS, BUILTIN_GROUP, BUILTIN_PAGES } from './builtin';

/** The nav groups in order; a group's heading is `settings.group.<id>` (General's group has none). */
export const GROUPS = ['general', 'interface', 'agents', 'git', 'remote', 'privacy', 'advanced'] as const;
export type SettingsGroup = (typeof GROUPS)[number];

/** One searchable setting: its page, its key (`data-setting`, and `field.<key>` in the catalogue) and the selector to focus. */
export interface Field {
  page: string;
  key: string;
  at: string;
}

/** What the Settings tab hands a page when it draws it. */
export interface PageContext {
  core: CoreClient;
  t: T;
  settings: Settings;
  commands: Command[];
  update: (patch: Partial<Settings>) => void;
  /** v1a-57: a setting to focus, from the palette. */
  focus: { key: string; n: number } | null;
  /** V2-4b: an agent whose setup sheet to open on the Agents page. */
  agent?: { name: string; n: number } | null;
  /** v25f: the window's `.toast` (App.tsx), for a page's one-line "done". */
  toast?: (text: string) => void;
  /** D2: open another page focused on the element `at` selects (Accounts' "View usage"). */
  reveal: (page: string, at: string) => void;
  /** Ticket 370: the window's project list has a project, added folders included. */
  hasProject: boolean;
  /** Ticket 470: the project onboarding's last step starts a first session in (the list's first), or null.
   *  shortcut: the first project, not the newest added; track the added one if users add several during onboarding. */
  project: { path: string; name: string } | null;
  /** Ticket 485: the paths in the window's live project list (added folders included), as the tree shows it now. */
  projects: string[];
  /** Ticket 370: closes the Settings modal, for a page that opens something over the main window. */
  closeSettings: () => void;
  /** q67 look (new 1): the window's live sessions. A running agent that completed a turn proves its account signed in;
   *  Providers and Onboarding both read that proof here, so one never says "Couldn't check" beside the other's "Signed in". */
  sessions?: Session[];
  /** Ticket 1123 T10: the window's open session, which Skills & hooks offers to restart with a new server. */
  current?: Session | null;
}

export interface SettingsPageDef {
  /** Stored as the window's last page, so it never changes once shipped. */
  id: string;
  /** The nav button and page title, in English; a feature with strings in an area file may read its own key in `render` instead. */
  title: string;
  /** The line under the page title. */
  description?: string;
  group?: SettingsGroup;
  order?: number;
  fields?: { key: string; at: string }[];
  render: (ctx: PageContext) => ReactNode;
}

export interface SettingsSectionDef {
  /** A built-in or registered page id. */
  page: string;
  /** Unique across every page. */
  id: string;
  order: number;
  fields?: { key: string; at: string }[];
  render: (ctx: PageContext) => ReactNode;
}

// Live arrays: settings.ts re-exports them, so every importer sees a page registered later.
export const PAGES: string[] = [...BUILTIN_PAGES];
export const FIELDS: Field[] = [...BUILTIN_FIELDS];
const registered = new Map<string, SettingsPageDef>();
const sections: SettingsSectionDef[] = [];

let version = 0;
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => (listeners.add(l), () => void listeners.delete(l));
const changed = () => {
  version++;
  listeners.forEach((l) => l());
};

/** Throws on a field key FIELDS (or the same list) already has; nothing is added before the check passes. */
function checkFields(fields: { key: string }[]) {
  const seen = new Set(FIELDS.map((x) => x.key));
  for (const f of fields) {
    if (seen.has(f.key)) throw new Error(`Settings field "${f.key}" is already registered`);
    seen.add(f.key);
  }
}

/** An unknown group would leave the page out of every nav group, and a non-number order would scramble the sort. */
function checkPlace(what: string, group: unknown, order: unknown) {
  if (group !== undefined && !(GROUPS as readonly unknown[]).includes(group)) throw new Error(`${what}: group "${String(group)}" is not one of ${GROUPS.join(', ')}`);
  if (order !== undefined && !Number.isFinite(order)) throw new Error(`${what}: order must be a finite number`);
}

export function registerSettingsPage(def: SettingsPageDef) {
  if (PAGES.includes(def.id)) throw new Error(`Settings page "${def.id}" is already registered`);
  checkPlace(`Settings page "${def.id}"`, def.group, def.order);
  checkFields(def.fields ?? []);
  PAGES.push(def.id);
  FIELDS.push(...(def.fields ?? []).map((f) => ({ page: def.id, ...f })));
  registered.set(def.id, def);
  changed();
}

export function registerSettingsSection(def: SettingsSectionDef) {
  if (sections.some((s) => s.id === def.id)) throw new Error(`Settings section "${def.id}" is already registered`);
  checkPlace(`Settings section "${def.id}"`, undefined, def.order);
  checkFields(def.fields ?? []);
  FIELDS.push(...(def.fields ?? []).map((f) => ({ page: def.page, ...f })));
  sections.push(def);
  changed();
}

export const registeredPage = (id: string) => registered.get(id);

/** A page's registered sections, by `order` (ties keep registration order). */
export const sectionsOf = (page: string) => sections.filter((s) => s.page === page).sort((a, b) => a.order - b.order);

/** A page's nav group. */
export const groupOf = (id: string): SettingsGroup => (BUILTIN_GROUP[id] as SettingsGroup | undefined) ?? registered.get(id)?.group ?? 'advanced';

/** The nav: each group with its pages, built-in ones first in their order, then registered ones by `order`. */
export function navGroups(pages: string[] = PAGES): { group: SettingsGroup; pages: string[] }[] {
  const order = (id: string) => (BUILTIN_PAGES.includes(id) ? -Infinity : (registered.get(id)?.order ?? 0));
  return GROUPS.map((group) => ({
    group,
    pages: pages
      .filter((p) => groupOf(p) === group)
      .map((p, i) => [p, i] as const)
      .sort(([a, i], [b, j]) => order(a) - order(b) || i - j)
      .map(([p]) => p),
  })).filter((g) => g.pages.length);
}

/** Re-renders the caller when a page or section registers after it first drew (a fixture loads lazily). */
export const useRegistry = () => useSyncExternalStore(subscribe, () => version);
