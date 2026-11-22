// Ticket 997 L7: the browser chrome's icons, as drawn in the approved mockup (docs/design/browser-widget-1119.html): 16-unit
// outlines at the Octicons' 1.5 stroke, so they sit with icons/Icon.tsx. Original drawings; `annotate` is a speech bubble with
// a plus (the look of Orca's message-square-plus), `agent` the agent's pointer.
const PATHS = {
  back: 'M7 3.5 2.5 8 7 12.5M3 8h10.5',
  forward: 'M9 3.5 13.5 8 9 12.5M13 8H2.5',
  reload: 'M13.25 8a5.25 5.25 0 1 1-1.54-3.71M12.5 1.75v3h-3',
  more: 'M3 8h.01M8 8h.01M13 8h.01',
  globe: 'M8 1.75a6.25 6.25 0 1 0 0 12.5 6.25 6.25 0 0 0 0-12.5ZM1.75 8h12.5M8 1.75c-2.2 2.3-2.2 10.2 0 12.5M8 1.75c2.2 2.3 2.2 10.2 0 12.5',
  lock: 'M5.5 7V5.25a2.5 2.5 0 0 1 5 0V7M5 7h6a1.25 1.25 0 0 1 1.25 1.25v4A1.25 1.25 0 0 1 11 13.5H5a1.25 1.25 0 0 1-1.25-1.25v-4A1.25 1.25 0 0 1 5 7Z',
  info: 'M8 1.75a6.25 6.25 0 1 0 0 12.5 6.25 6.25 0 0 0 0-12.5ZM8 7.25v3.75M8 5h.01',
  chevron: 'M4.5 6.25 8 9.75l3.5-3.5',
  close: 'M4 4l8 8M12 4l-8 8',
  plus: 'M8 3v10M3 8h10',
  annotate: 'M2.75 3.25h10.5v7.5h-5.5l-3 2.5v-2.5h-2zM8 5.25v3.5M6.25 7h3.5',
  full: 'M2.75 6V2.75H6M10 2.75h3.25V6M13.25 10v3.25H10M6 13.25H2.75V10',
  side: 'M6 2.75V6H2.75M13.25 6H10V2.75M10 13.25V10h3.25M2.75 10H6v3.25',
  handBack: 'M6 3.75 2.5 7.25 6 10.75M3 7.25h6.25a4 4 0 0 1 4 4v1',
} as const;

/** A decorative icon; the control around it keeps the accessible name. */
export function BIcon({ name, size = 16 }: { name: keyof typeof PATHS; size?: number }) {
  const more = name === 'more'; // three dots: round caps of a wide stroke
  return (
    <svg className="bi" data-icon={name} width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={more ? 2.2 : 1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d={PATHS[name]} />
    </svg>
  );
}

/** The agent's pointer, filled (the tab badge). */
export const AgentMark = () => (
  <svg className="bi" data-icon="agent" width={12} height={12} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" focusable="false">
    <path d="M3 2.5l9.5 4.25-4 1.25-1.75 4.25z" />
  </svg>
);
