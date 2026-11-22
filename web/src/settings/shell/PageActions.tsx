// Ticket 250: a page's header actions (final.html `header(title, desc, acts)`). The page keeps the state its buttons use
// and draws them here; SettingsView owns the slot in the page header.
import { createContext, Fragment, useContext, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export const ActionsSlot = createContext<HTMLElement | null>(null);

/** Draws `children` in the shown page's header, right of its title; nothing outside Settings. */
export function PageActions({ children }: { children: ReactNode }) {
  const slot = useContext(ActionsSlot);
  return slot ? createPortal(children, slot) : null;
}

export const SummarySlot = createContext<HTMLElement | null>(null);

/** Ticket 1043 (mockup docs/design/settings-1122 A): one line of the page's current values under its title, as
 *  "Label **value** · Label **value**", from values the page already reads. A part without a value is left out. */
export function PageSummary({ parts }: { parts: [label: string, value: ReactNode, note?: string][] }) {
  const slot = useContext(SummarySlot);
  const shown = parts.filter(([, v]) => v !== null && v !== undefined && v !== '' && v !== false); // `cond && value` leaves false
  if (!slot || !shown.length) return null;
  return createPortal(
    shown.map(([label, value, note], i) => (
      <Fragment key={i}>
        {i > 0 && ' · '}
        {label && `${label} `}
        <b>{value}</b>
        {note && ` (${note})`}
      </Fragment>
    )),
    slot,
  );
}
