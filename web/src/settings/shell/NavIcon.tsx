// Ticket 250: the Settings nav icons of final.html: Octicons from the icon module where it has one, else the simple stroke
// icons drawn for that mockup (docs/design/settings-1103/final.html `STROKE`; drawn for Nunchiro, no third-party source).
import { Icon, type IconName } from '../../icons/Icon';

const STROKE: Record<string, string[]> = {
  shield: ['M8 1.5l5 2v4c0 3.2-2.1 5.8-5 7-2.9-1.2-5-3.8-5-7v-4z', 'M5.8 8l1.6 1.6 3-3.2'],
  paint: ['M10.5 2.5l3 3-6 6H4.5v-3z', 'M4.5 11.5c-1 0-2 .8-2 2h2'],
  bell: ['M4 11V7a4 4 0 0 1 8 0v4l1 1.5H3z', 'M6.5 14h3'],
  keyboard: ['M3 4h10a1.5 1.5 0 0 1 1.5 1.5v5A1.5 1.5 0 0 1 13 12H3a1.5 1.5 0 0 1-1.5-1.5v-5A1.5 1.5 0 0 1 3 4z', 'M4 6.5h.01M6.5 6.5h.01M9 6.5h.01M11.5 6.5h.01M5 9.5h6'],
  agent: ['M5 4.5h6a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2z', 'M8 2v2.5M6 8.5h.01M10 8.5h.01M1.5 8v2M14.5 8v2'],
  orch: ['M8 2a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zM3.5 10.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zM12.5 10.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z', 'M8 5v2.5M8 7.5L3.5 10.5M8 7.5l4.5 3'],
  server: ['M3 2.5h10a1 1 0 0 1 1 1V6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3.5a1 1 0 0 1 1-1zM3 9h10a1 1 0 0 1 1 1v2.5a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V10a1 1 0 0 1 1-1z', 'M4.5 4.75h.01M4.5 11.25h.01'],
  // D2: Usage (drawn for Nunchiro: three bars).
  usage: ['M3 13.5V9M8 13.5V3M13 13.5V6.5'],
  history: ['M2.5 8a5.5 5.5 0 1 0 1.6-3.9', 'M2.5 2.5v2.5H5M8 5v3l2 1.5'],
  tool: ['M9.5 2.2a3.3 3.3 0 0 0 4.3 4.3L7 13.3a1.5 1.5 0 0 1-2.2-2.2z'],
  // Ticket 262: About (drawn for Nunchiro: a circled "i").
  info: ['M8 1.75a6.25 6.25 0 1 0 0 12.5 6.25 6.25 0 0 0 0-12.5z', 'M8 7.25v4M8 4.75h.01'],
  // Ticket 311: the per-row reset arrow (drawn for Nunchiro).
  undo: ['M3 6.5h6.5a3.5 3.5 0 0 1 0 7H6', 'M5.5 4 3 6.5 5.5 9'],
  // Ticket 350: an action that leaves the app (final.html `ext`).
  ext: ['M9.5 2.5h4v4M13.5 2.5L8 8', 'M12 9.5v3a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3'],
  // Ticket 326: Agent extensions (drawn for Nunchiro: a plug).
  plug: ['M6 1.5V5M10 1.5V5', 'M4 5h8v2.5a4 4 0 0 1-8 0z', 'M8 11.5v3'],
  // Ticket 990 slice h: Notes (drawn for Nunchiro: a page with lines).
  note: ['M4 1.5h6l2.5 2.5v10.5H4z', 'M6 6.5h4.5M6 9h4.5M6 11.5h3'],
  // Plugins (drawn for Nunchiro: a puzzle piece, the usual mark for an add-on).
  puzzle: ['M2.5 4.5h3a1.5 1.5 0 1 1 3 0h3v3a1.5 1.5 0 1 1 0 3v3h-9v-3a1.5 1.5 0 1 0 0-3z'],
  layout: ['M3 2.5h10a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5H3A1.5 1.5 0 0 1 1.5 12V4A1.5 1.5 0 0 1 3 2.5z', 'M6 2.5v11M6 8h8.5'],
};

/** Each built-in page's icon (final.html NAV), and a registered page's when it has one; any other draws the gear. */
const PAGE_ICON: Record<string, string> = {
  general: 'gear',
  onboarding: 'list-unordered', // ticket 391 follow-up K: the setup checklist, not General's gear
  appearance: 'paint',
  terminal: 'terminal',
  layout: 'layout',
  alerts: 'bell',
  keys: 'keyboard',
  agents: 'agent',
  providers: 'agent', // ticket 391
  extensions: 'plug',
  accounts: 'person',
  usage: 'usage',
  orchestration: 'orch',
  git: 'git-branch',
  machines: 'server',
  browser: 'browser',
  'inapp-browser': 'browser', // ticket 255: a registered page with its own icon (the Octicons browser glyph)
  libraries: 'package',
  history: 'history',
  advanced: 'tool',
  about: 'info', // ticket 262: a registered page with its own icon
  permissions: 'shield', // ticket 378: its own icon, not General's gear
  team: 'people', // ticket 991 C16: its own icon, not General's gear
  notes: 'note', // ticket 990 slice h
  assistants: 'person', // ticket 1041 (N164): its own icon, not General's gear (Team keeps people)
  projects: 'file-directory', // ticket 1041: Projects (ticket 1040) drew General's gear
  plugins: 'puzzle',
};

/** Ticket 1043 (mockup docs/design/settings-1122, version A): each page's tile colour, from the nav palette in tokens.css
 *  (`--nav-tone-<tone>`: no orange, red or blue, which mean your turn, broken and working). */
const PAGE_TONE: Record<string, string> = {
  appearance: 'indigo',
  terminal: 'graphite',
  layout: 'teal',
  alerts: 'pink',
  'inapp-browser': 'teal',
  providers: 'purple',
  usage: 'green',
  team: 'purple',
  assistants: 'pink',
  extensions: 'indigo',
  plugins: 'teal',
  notes: 'green',
  git: 'graphite',
  projects: 'teal',
  machines: 'graphite',
  browser: 'green',
  libraries: 'indigo',
  permissions: 'green',
};

export function NavIcon({ page }: { page: string }) {
  const name = PAGE_ICON[page] ?? 'gear';
  return (
    <span className="nico" data-tone={PAGE_TONE[page] ?? 'grey'}>
      {STROKE[name] ? <StrokeIcon name={name} size={13} /> : <Icon name={name as IconName} size={13} />}
    </span>
  );
}

/** One of the mockup's stroke icons by name (a row's icon, the reset arrow). */
export function StrokeIcon({ name, size = 16 }: { name: string; size?: number }) {
  const stroke = STROKE[name];
  return (
    <svg className="oi si" width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {stroke.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
