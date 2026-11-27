// Plugin commands in the palette (docs/plugins.md): one row per command of a plugin that is on and approved, tagged with
// the plugin's name. The core runs it in the widget sandbox; `note` and `panel` show the output as the window's note,
// `send` puts it in the focused agent's message box as a draft that is never sent by itself.
import { useEffect, useState, type RefObject } from 'react';
import type { Command } from '../keys';
import type { Key } from '../i18n';
import type { Session } from '../types';
import { getDraft, setDraft } from '../composer-drafts';
import { pluginOp, runCommand, type Listed } from './api';

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

export function usePluginCommands({ core, t, open, current, composer, note }: Deps): Command[] {
  const [list, setList] = useState<Listed[]>([]);
  useEffect(() => {
    if (open) pluginOp(core, { do: 'list' }).then(setList, () => setList([]));
  }, [core, open]);
  return list
    .filter((p) => p.on && p.state === 'approved' && p.plugin && !p.needs)
    .flatMap((p) =>
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
            (e: Error) => note(t('plugins.ran', { name: p.plugin!.name, text: e.message })),
          ),
      })),
    );
}
