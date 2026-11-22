// Ticket 990 slice i (mockup docs/design/leader-room/team-j.html ① and ②): the place's way of working and what its
// seats may do, set by the user only. The same menu hangs off the lead's composer chip and the day-one way card.
import { useEffect, useRef, useState } from 'react';
import type { CoreClient } from '../api';
import type { T } from '../i18n';
import type { Session } from '../types';
import { leadSeatMate, useTeam } from './lead';
import { setPlace, useTasks, type Place } from './tasks';
import './lead.css';

const WAYS = ['solo', 'team', 'strict'] as const;
const SEATS = ['ask', 'edits'] as const;
export const wayWord = (t: T, way: Place['way']) => t(`lead.way.${way}`);

export function WayMenu({ t, core, project, place, className, label }: { t: T; core: CoreClient; project: string; place: Place; className: string; label: string }) {
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]')?.focus();
    const away = (e: PointerEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('pointerdown', away, true);
    return () => document.removeEventListener('pointerdown', away, true);
  }, [open]);
  const pick = (operation: 'way' | 'grant', text: string) => {
    setOpen(false);
    setErr(false);
    setPlace(core, project, operation, text).catch(() => setErr(true));
  };
  const item = (operation: 'way' | 'grant', value: string, on: boolean, name: string, note?: string) => (
    <button key={value} type="button" role="menuitemradio" aria-checked={on} className="way-item" data-value={value} onClick={() => pick(operation, value)}>
      <span className="way-ck" aria-hidden>
        {on ? '✓' : ''}
      </span>
      <span>
        <b>{name}</b>
        {note && <small>{note}</small>}
      </span>
    </button>
  );
  return (
    <span
      ref={root}
      className="way-wrap"
      onKeyDown={(e) => {
        if (!open) return;
        if (e.key === 'Escape') e.preventDefault(), e.stopPropagation(), setOpen(false), root.current?.querySelector<HTMLElement>('[aria-haspopup]')?.focus();
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          const items = [...(root.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [])];
          const at = items.indexOf(document.activeElement as HTMLElement);
          items[(at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
        }
      }}
    >
      <button type="button" className={className} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        {label} <span aria-hidden>▾</span>
      </button>
      {open && (
        <div className="way-menu" role="menu" aria-label={t('lead.way.menu')}>
          <div role="group" aria-label={t('lead.way.group')}>
            <h4 aria-hidden>{t('lead.way.group')}</h4>
            {WAYS.map((w) => item('way', w, place.way === w, wayWord(t, w), t(`lead.way.${w}Note`)))}
          </div>
          <div role="group" aria-label={t('lead.seats.group')}>
            <h4 aria-hidden>{t('lead.seats.group')}</h4>
            {SEATS.map((s) => item('grant', s, place.seats === s, t(`lead.seats.${s}`)))}
            <p className="way-quiet">{t('lead.seats.note')}</p>
          </div>
        </div>
      )}
      {err && (
        <span className="way-err" role="status">
          {t('lead.way.failed')}
        </span>
      )}
    </span>
  );
}

/** The way chip in a lead's composer row (mockup J: "Way: build + review" beside the model); nothing for any other seat. */
export function WayChip({ t, core, session, connected, sessions }: { t: T; core: CoreClient; session: Session | null; connected: boolean; sessions: Session[] }) {
  const team = useTeam(core, connected);
  const mate = leadSeatMate(session, team);
  const project = mate ? (mate.project ?? team.home) || null : null;
  const { place } = useTasks(core, project, connected, sessions);
  if (!project || !place) return null;
  return <WayMenu t={t} core={core} project={project} place={place} className="chip way-chip" label={t('lead.way.chip', { way: wayWord(t, place.way) })} />;
}
