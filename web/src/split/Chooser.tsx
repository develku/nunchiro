// SPLITNEW: the chooser a new split opens with (the setting "Open in a new split", default Chooser): Claude, Codex,
// Terminal, then the widgets of the library. The first choice has the focus; arrows move, Enter picks, Escape closes the
// empty split.
import { useEffect, useRef, type KeyboardEvent } from 'react';
import { Icon } from '../layout/icons';
import { AgentLogo } from '../tree/AgentLogo';
import { ENTRIES } from '../layout/registry';
import { widgetText } from '../layout/Library';
import { useWidgetList, userKind } from '../widgets/api';
import type { CoreClient } from '../api';
import type { T } from '../i18n';
import { AGENTS_OFF } from '../settings/agents/newDefaults';
import { useFeatureSetting } from '../settings/useFeatureSetting';

export type Choice = 'claude' | 'codex' | 'shell' | string;
const choices = (t: T): { id: Choice; icon: string; title: string; note: string }[] => [
  { id: 'claude', icon: 'agents', title: 'Claude', note: t('rest.st.noteAgent') },
  { id: 'codex', icon: 'agents', title: 'Codex', note: t('rest.st.noteAgent') },
  { id: 'shell', icon: 'terminal', title: t('rest.st.terminal'), note: t('rest.st.noteShell') },
  ...ENTRIES.map((e) => ({ id: e.kind, icon: e.kind, ...widgetText(t, e) })),
];

export function Chooser({ t, core, onPick, onClose }: { t: T; core: CoreClient; onPick: (c: Choice) => void; onClose: () => void }) {
  const list = useRef<HTMLDivElement>(null);
  const [agentsOff] = useFeatureSetting(AGENTS_OFF); // ticket 358
  // The library's user widgets follow the built-in ones, as in the library (rendered by the widget host like a bar icon).
  const mine = (useWidgetList(core).list?.widgets ?? []).map((w) => ({ id: userKind(w.name), icon: '', title: w.title ?? w.name, note: t(w.state === 'approved' ? 'rest.st.noteMine' : 'rest.st.noteMineOff') }));
  useEffect(() => list.current?.querySelector<HTMLElement>('[role="option"]')?.focus(), []);
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    const all = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="option"]')];
    const i = all.indexOf(document.activeElement as HTMLElement);
    const step = { ArrowDown: 1, ArrowUp: -1 }[e.key];
    if (step) return (e.preventDefault(), all[(i + step + all.length) % all.length]?.focus());
    if (e.key === 'Home' || e.key === 'End') return (e.preventDefault(), all[e.key === 'Home' ? 0 : all.length - 1]?.focus());
    if (e.key === 'Escape' && !e.nativeEvent.isComposing) return (e.preventDefault(), e.stopPropagation(), onClose());
  };
  return (
    <div className="chooser" role="listbox" aria-label={t('rest.st.chooser')} ref={list} onKeyDown={key}>
      {[...choices(t), ...mine].filter((c) => !agentsOff.includes(c.id as (typeof agentsOff)[number])).map((c, i) => (
        <div
          key={c.id}
          role="option"
          aria-selected={false}
          tabIndex={i === 0 ? 0 : -1}
          className={c.id === ENTRIES[0].kind ? 'first-widget' : undefined}
          onClick={() => onPick(c.id)}
          onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && (e.preventDefault(), onPick(c.id))}
        >
          {/* Ticket 991 A17: the agents' own logos, as the tab "+" menu shows them. */}
          {c.id === 'claude' || c.id === 'codex' ? <AgentLogo kind={c.id} /> : <Icon kind={c.icon} size={14} />}
          <b>{c.title}</b>
          <span>{c.note}</span>
        </div>
      ))}
    </div>
  );
}
