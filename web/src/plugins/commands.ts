// Plugin commands in the palette (docs/plugins.md): one row per command of a plugin that is on and approved, tagged with
// the plugin's name. The core runs it in the widget sandbox; `note` and `panel` show the output as the window's note,
// `send` puts it in the focused agent's message box as a draft that is never sent by itself.
import { useEffect, useRef, useState, type RefObject } from 'react';
import type { Bindings, Command } from '../keys';
import type { Key } from '../i18n';
import type { Session } from '../types';
import { getDraft, setDraft } from '../composer-drafts';
import { pluginOp, runCommand, type Listed } from './api';
import { lineError } from '../errors';

type T = (key: Key, args?: Record<string, string | number>) => string;
interface Core {
  request(request: { op: string; [k: string]: unknown }): Promise<unknown>;
}
interface Deps {
  core: Core;
  t: T;
  /** Read again each time the palette opens, so a plugin turned on since shows up. */
  open: boolean;
  current: Session | null;
  composer: RefObject<HTMLTextAreaElement | null>;
  note: (text: string) => void;
}

const joined = (draft: string, words: string) => (draft ? `${draft.replace(/\n*$/, '')}\n${words}` : words);

/** The plugin commands (palette rows), the shortcuts they hold and the status items of the plugins that can run. The
 *  list is read when the window opens, each time the palette opens and when the window comes back into focus. */
export function usePluginCommands({ core, t, open, current, composer, note }: Deps): { commands: Command[]; keys: Bindings; status: StatusEntry[] } {
  const [list, setList] = useState<Listed[]>([]);
  // A plugin its catalogue blocks since the last read says so once, with the reason (a refresh turned it off).
  const blocked = useRef<Map<string, string> | null>(null);
  const take = (next: Listed[]) => {
    const was = blocked.current;
    for (const p of next) if (was && p.blocked && !was.has(p.id)) note(t('plugins.blockedNote', { name: p.plugin?.name ?? p.id, why: p.blocked }));
    blocked.current = new Map(next.filter((p) => p.blocked).map((p) => [p.id, p.blocked!]));
    setList(next);
  };
  useEffect(() => {
    const read = () => void pluginOp(core, { do: 'list' }).then(take, () => setList([]));
    read();
    window.addEventListener('focus', read);
    return () => window.removeEventListener('focus', read);
  }, [core]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (open) pluginOp(core, { do: 'list' }).then(take, () => setList([]));
  }, [core, open]); // eslint-disable-line react-hooks/exhaustive-deps
  const ready = list.filter((p) => p.on && p.state === 'approved' && p.plugin && !p.needs);
  const commands = ready.flatMap((p) =>
      (p.plugin!.command ?? []).map((c) => ({
        id: `plugin.${p.id}.${c.name}`,
        title: c.title ?? c.name,
        branch: p.plugin!.name,
        run: () =>
          void runCommand(core, p.id, c.name, current?.id).then(
            ({ run, show }) => {
              const name = p.plugin!.name;
              if (run.error) return note(t('plugins.ran', { name, text: run.error }));
              const text = (run.output?.text ?? '').trim();
              if (!text) return note(t('plugins.ranEmpty', { name }));
              if (show === 'send' && current) {
                const el = composer.current;
                if (el && el.dataset.draftFor === current.id) {
                  el.value = joined(el.value, text);
                  el.dispatchEvent(new Event('input', { bubbles: true }));
                } else setDraft(current.id, joined(getDraft(current.id), text));
                return note(t('plugins.drafted', { name }));
              }
              // shortcut: `panel` shows as a note too; open a panel tab with the output when one is asked for.
              note(t('plugins.ran', { name, text: text.length > 400 ? `${text.slice(0, 400)}…` : text }));
            },
            (e: unknown) => note(t('plugins.ran', { name: p.plugin!.name, text: lineError(t, e) })), // the plain line, not the core's raw words
          ),
      })),
  );
  const keys: Bindings = {};
  for (const p of ready) for (const k of p.plugin!.keybinding ?? []) (keys[`plugin.${p.id}.${k.command}`] ??= []).push(chord(k.key));
  const status = ready.flatMap((p) => (p.plugin!.status ?? []).map((s) => ({ key: `${p.id}.${s.name}`, plugin: p.plugin!.name, text: s.text, command: s.command && `plugin.${p.id}.${s.command}` })));
  return { commands, keys, status };
}
export interface StatusEntry {
  key: string;
  plugin: string;
  text: string;
  /** The palette id of the command it runs. */
  command?: string;
}
const ORDER = ['Control', 'Alt', 'Shift', 'Meta'];
/** A plugin's key (`Meta+Shift+KeyH`) as the window spells a chord: its modifiers in `chordOf`'s order. */
export const chord = (key: string) => {
  const parts = key.split('+');
  const code = parts.pop()!;
  return [...ORDER.filter((m) => parts.includes(m)), code].join('+');
};
/** The plugins' shortcuts under the window's: a key the window or the user already holds stays theirs. */
export function withPluginKeys(bindings: Bindings, keys: Bindings): Bindings {
  const held = new Set(Object.values(bindings).flat());
  const out = { ...bindings };
  for (const [id, ks] of Object.entries(keys)) {
    const free = ks.filter((k) => !held.has(k));
    if (free.length) out[id] = free;
    free.forEach((k) => held.add(k));
  }
  return out;
}

