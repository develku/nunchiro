// Plugins (crates/nunchiro-core/src/plugins.rs, docs/plugins.md): one request, `{op: 'plugin', action: {do: ...}}`, owner
// and window only. Every action but `run` answers with the whole list.
import type { ApprovalState } from '../approval/types';

export type SettingKind = 'text' | 'number' | 'bool' | 'time' | 'choice';
export type Show = 'note' | 'panel' | 'send';
export interface PluginSetting {
  key: string;
  label: string;
  type: SettingKind;
  default?: unknown;
  choices?: string[];
}
export interface Plugin {
  id: string;
  name: string;
  version: string;
  about: string;
  author?: string;
  panel?: { name: string; title?: string; kind: string }[];
  command?: { name: string; title?: string; show: Show }[];
  setting?: PluginSetting[];
  gate?: { name: string; title?: string; on: 'session.start.before' | 'prompt.send.before' }[];
}
export interface Listed {
  id: string;
  on: boolean;
  state?: ApprovalState;
  plugin?: Plugin;
  values?: Record<string, unknown>;
  error?: string;
  /** The setting that is off and stops its parts. */
  needs?: 'script_widgets' | 'web_widgets';
  /** Its checks that got no time in an action's budget since the core started; the action went by `on_error`. */
  skipped?: number;
}
interface Core {
  request(request: { op: string; [k: string]: unknown }): Promise<unknown>;
}
/** One plugin of the catalogue (crates/nunchiro-core/src/plugins_online.rs): what Browse plugins shows. */
export interface CatalogEntry {
  id: string;
  name: string;
  about: string;
  author?: string;
  version: string;
  adds: Record<string, number>;
  network: string[];
  commit: string;
}
export const catalogOp = async (core: Core) => ((await core.request({ op: 'plugin', action: { do: 'catalog' } })) as { catalog: CatalogEntry[] }).catalog;
export const pluginOp = async (core: Core, action: Record<string, unknown>) => ((await core.request({ op: 'plugin', action })) as { plugins: Listed[] }).plugins;

export interface Ran {
  run: { running?: boolean; output?: { format: 'text' | 'json'; text: string } | null; error?: string | null };
  show: Show;
}
/** Runs a command; the core answers at once and a longer run is read again (`poll`) until it ends (the sandbox stops
 *  it at its limit), so the window's other requests never wait behind it. */
export async function runCommand(core: Core, id: string, command: string, session?: string): Promise<Ran> {
  let ran = (await core.request({ op: 'plugin', action: { do: 'run', id, command, session } })) as Ran;
  for (let i = 0; ran.run.running && i < 150; i++) {
    await new Promise((r) => setTimeout(r, 200));
    ran = (await core.request({ op: 'plugin', action: { do: 'run', id, command, session, poll: true } })) as Ran;
  }
  return ran;
}

/** The approval name of a plugin, as the permission sheet asks for it. */
export const approvalName = (id: string) => `plugin:${id}`;
