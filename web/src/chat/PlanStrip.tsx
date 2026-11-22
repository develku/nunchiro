// needs 168: the session's newest plan as a strip above the composer, inside the chat column. Folded it is one 28 px
// line ("3/7 · current step"); expanded, the same button heads the list of every item. The plan is the agent's text and
// is drawn as React text only. Children (sub-agents) stay in the tree; the strip lists plan items.
import { useContext, useMemo, useRef, useState, type KeyboardEvent, type ReactElement } from 'react';
import { Icon } from '../icons/Icon';
import { Tr } from '../i18n';
import type { ChatEvent } from './feed';
import { current, planOf, tally, type PlanItem } from './plan';
import './plan-strip.css';

/** Expanded state per session, so a tab switch (the chat is dropped 30 s after it was shown) keeps it. */
const expanded = new Map<string, boolean>();

// Outline icons as the tree rows draw them (RowIcon: 24-unit grid, stroke 2, round caps). Blue arc = working.
const MARK: Record<PlanItem['status'], { icon: string; body: ReactElement }> = {
  completed: {
    icon: 'check-circle',
    body: (
      <>
        <circle cx="12" cy="12" r="8.5" />
        <path d="M8.5 12.2l2.5 2.5 4.5-5" />
      </>
    ),
  },
  in_progress: {
    icon: 'work',
    body: (
      <>
        <circle cx="12" cy="12" r="8.5" opacity=".25" />
        <circle className="arc" cx="12" cy="12" r="8.5" pathLength="100" strokeDasharray="28 100" />
      </>
    ),
  },
  pending: { icon: 'circle', body: <circle cx="12" cy="12" r="8.5" /> },
};

function Mark({ status }: { status: PlanItem['status'] }) {
  const m = MARK[status];
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" data-icon={m.icon}>
      {m.body}
    </svg>
  );
}

export function PlanStrip({ events, session }: { events: ChatEvent[]; session: string }) {
  const t = useContext(Tr);
  const plan = useMemo(() => planOf(events), [events]);
  const [open, setOpen] = useState(() => expanded.get(session) ?? false);
  const button = useRef<HTMLButtonElement>(null);
  if (!plan) return null;
  const { done, total } = tally(plan);
  const step = current(plan);
  const line = step === null ? t('chat.plan.done', { done, total }) : t('chat.plan.count', { done, total, step });
  const set = (on: boolean) => (expanded.set(session, on), setOpen(on));
  // Esc closes the open list and keeps focus on the header; the composer's Esc (stop) is not reached.
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || !open) return;
    e.preventDefault();
    e.stopPropagation();
    set(false);
    button.current?.focus();
  };
  return (
    <section className="pstrip" role="region" aria-label={t('chat.plan.region')} data-plan-strip="" data-open={open ? '' : undefined} onKeyDown={onKeyDown}>
      <button ref={button} type="button" className="phead" aria-expanded={open} data-tip={open ? t('chat.plan.collapse') : t('chat.plan.expand')} onClick={() => set(!open)}>
        <span className="pc" aria-hidden>
          <Icon name={open ? 'chevron-down' : 'chevron-right'} size={12} />
        </span>
        <span className="pt" data-tip={step ?? undefined} data-tip-clip="">
          {line}
        </span>
      </button>
      {open && (
        <ol className="plist">
          {plan.items.map((it, i) => (
            <li key={i} data-status={it.status} aria-current={it.status === 'in_progress' ? 'step' : undefined}>
              <Mark status={it.status} />
              <span>{it.text}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
