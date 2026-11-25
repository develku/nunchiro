// Widget registry (v1b-28): one entry per built-in widget kind, in drawer order, with its title, minimum size,
// drawer note and card preview. Its window view is the same kind's entry in windows.tsx. The core names the same
// kinds in WIDGET_KINDS (crates/nunchiro-core/src/http/widget_kinds.rs); a cargo test and tests/registry.spec.ts fail
// when they drift; the cargo one reads the single-quoted kind of each entry below, so keep that spelling.
// No component or CSS imports here: the pure layout specs load this file in Node.
import type { ReactNode } from 'react';
import { Icon } from '../icons/Icon';
import type { Session } from '../types';

export interface PreviewProps {
  sessions: Session[];
  waiting: number;
}
export interface Entry {
  kind: string;
  title: string;
  min: { w: number; h: number };
  /** The drawer card's one line under the title. */
  note: string;
  preview: (p: PreviewProps) => ReactNode;
}

export const ENTRIES = [
  {
    kind: 'tree',
    title: 'Tree',
    min: { w: 160, h: 120 },
    note: 'waiting slots',
    preview: ({ waiting }) => (
      <>
        <i className={`bar${waiting ? ' w' : ''}`} />
        <i className="ln" />
        <i className={`ln${waiting ? ' w' : ''}`} />
      </>
    ),
  },
  { kind: 'waiting', title: 'Answer strip', min: { w: 200, h: 40 }, note: 'answer here', preview: ({ waiting }) => <span className="txt">{waiting ? `${waiting} waiting` : 'appears when waiting'}</span> },
  { kind: 'terminal', title: 'Terminal', min: { w: 240, h: 120 }, note: 'follows or pinned', preview: ({ sessions }) => <span className="txt mono">$ {sessions[0]?.label || '_'}</span> },
  { kind: 'composer', title: 'Composer', min: { w: 240, h: 56 }, note: 'hideable', preview: () => <span className="box" /> },
  { kind: 'diff', title: 'Diff', min: { w: 240, h: 120 }, note: 'follows or pinned', preview: () => <span className="txt mono"><Icon name="diff" size={12} /></span> }, // v1b-11
  { kind: 'files', title: 'Files', min: { w: 160, h: 120 }, note: 'focused folder', preview: () => <span className="txt mono"><Icon name="file-directory" size={12} /> src/</span> }, // v1b-09
  { kind: 'board', title: 'Board', min: { w: 240, h: 160 }, note: 'work board', preview: ({ sessions }) => <span className="txt"><Icon name="project" size={12} /> {sessions.length} cards</span> }, // v1b-16
  { kind: 'search', title: 'Search', min: { w: 160, h: 120 }, note: 'focused folder', preview: () => <span className="txt mono"><Icon name="search" size={12} /> text</span> }, // v1b-10
  { kind: 'preview', title: 'Preview', min: { w: 220, h: 160 }, note: 'follows or pinned', preview: () => <span className="txt"><Icon name="triangle-right" size={12} /></span> }, // v1b-06
  { kind: 'artifacts', title: 'Artifacts', min: { w: 220, h: 160 }, note: 'attachments · artifacts', preview: () => <span className="txt"><Icon name="package" size={12} /> this session</span> }, // v1b-13
  { kind: 'decisions', title: 'Decisions', min: { w: 240, h: 120 }, note: 'pending answers · risky allow', preview: ({ waiting }) => <span className="txt">{waiting ? `${waiting} waiting` : 'Nothing waiting'}</span> }, // V2-8e
  // Ticket 990: the room of the focused session's place; never in the default layout or rail (a lead's place shows it in the Team view).
  { kind: 'room', title: 'Room', min: { w: 280, h: 160 }, note: 'leader and team', preview: () => <span className="txt">Room</span> },
  // Ticket 1048: the context fill of the session in view (its window view is ContextWidget.tsx).
  { kind: 'context', title: 'Context', min: { w: 200, h: 80 }, note: 'context window of the session', preview: () => <span className="txt">36% used</span> },
] as const satisfies readonly Entry[];

export type Kind = (typeof ENTRIES)[number]['kind'];
