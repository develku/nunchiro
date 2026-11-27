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
}
interface Core {
  request(request: { op: string; [k: string]: unknown }): Promise<unknown>;
}
export const pluginOp = async (core: Core, action: Record<string, unknown>) => ((await core.request({ op: 'plugin', action })) as { plugins: Listed[] }).plugins;

export interface Ran {
  run: { output?: { format: 'text' | 'json'; text: string } | null; error?: string | null };
  show: Show;
}
export const runCommand = (core: Core, id: string, command: string, session?: string) => core.request({ op: 'plugin', action: { do: 'run', id, command, session } }) as Promise<Ran>;

/** The approval name of a plugin, as the permission sheet asks for it. */
export const approvalName = (id: string) => `plugin:${id}`;
