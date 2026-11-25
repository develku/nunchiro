// Icons of the icon bars, library cards and sidebar headers: one Octicon per widget kind from the icon module
// (STYLE 2026-10-28). The `glyph(widget)` call sites stay.
import type { ReactNode } from 'react';
import { ChromeIcon } from '../chrome/icons';
import { Icon as Octicon, type IconName } from '../icons/Icon';

const OCTICON: Record<string, IconName> = {
  tree: 'git-branch',
  files: 'file-directory',
  search: 'search',
  diff: 'diff',
  preview: 'browser',
  board: 'project',
  artifacts: 'package',
  terminal: 'terminal',
  composer: 'pencil',
  waiting: 'list-unordered',
  layout: 'apps',
  settings: 'gear',
  team: 'people',
  schedules: 'clock', // ticket 993
  history: 'history', // ticket 1022
};
// Octicons has no hand: the Decisions widget keeps the tree's earlier `hand` status icon (24 px box), joined into one path.
// tree/RowIcon.tsx now draws the 388 mockup's hand (ticket 462), the same shape within a fraction of a unit.
const HAND =
  'M18 11V6a2 2 0 0 0-4 0M14 10V4a2 2 0 0 0-4 0v2M10 10.5V6a2 2 0 0 0-4 0v8M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-6-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15';

export function Icon({ kind, size = 16 }: { kind: string; size?: number }) {
  // Placement (owner, docs/design/v25-placement item 4): the Browser icon is the familiar round globe, drawn here.
  if (kind === 'browser')
    return (
      <svg className="oi" data-icon="globe" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false">
        <circle cx="12" cy="12" r="10" />
        <path d="M2 12h20M12 2a15 15 0 0 1 0 20a15 15 0 0 1 0-20" />
      </svg>
    );
  if (kind === 'decisions')
    return (
      <svg className="oi" data-icon="hand" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false">
        <path d={HAND} />
      </svg>
    );
  // Ledger w14-room-icon: the split chooser's Room entry drew the fallback glyph; it is the Room tab's bubble.
  if (kind === 'room') return <ChromeIcon name="comment-discussion" size={size} />;
  // Ticket 1048: Octicons has no meter; a ring with a filled arc, as the composer's context ring.
  if (kind === 'context')
    return (
      <svg className="oi" data-icon="context" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden focusable="false">
        <circle cx="12" cy="12" r="9" opacity={0.35} />
        <path d="M12 3a9 9 0 0 1 8.5 12" />
      </svg>
    );
  return <Octicon name={OCTICON[kind] ?? 'code'} size={size} />; // a user widget falls back to code
}
export const glyph = (w: string): ReactNode => <Icon kind={w.startsWith('widget:') ? '' : w} />;
