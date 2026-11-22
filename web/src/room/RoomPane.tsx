// Ticket 990 (H2 ①): the `room` widget. The room of the focused (or pinned) session's place, in a split or a dock like the
// board, placed by the user (a lead's place shows its room in the Team view). Narrow, it reads as a chat.
import { useMemo } from 'react';
import type { CoreClient } from '../api';
import type { T } from '../i18n';
import type { Session } from '../types';
import { useRoom } from './room';
import { RoomView, type RoomWorktrees } from './RoomView';
import './room.css';

export function RoomPane({ core, t, session, sessions, open, wt }: { core: CoreClient; t: T; session: Session | null; sessions: Session[]; open: (id: string) => void; wt?: RoomWorktrees }) {
  // A worktree session's project is its main checkout, a Home seat's the Home folder: either way the room's own folder.
  const project = session?.project ?? null;
  const room = useRoom(core, project, true, true);
  const byId = useMemo(() => new Map(sessions.map((s) => [s.id, s])), [sessions]);
  return (
    <div className="roompane" data-room-pane={project ?? ''}>
      <div className="roompane-head">
        <span className="room-meta">{t('lead.legend')}</span>
      </div>
      <div className="roompane-body">
        {project ? (
          <RoomView core={core} t={t} project={project} sessions={sessions} byId={byId} messages={room.messages} pins={room.pins} names={room.names} dropped={room.dropped} toggle={room.toggle} refresh={room.refresh} open={open} wt={wt} />
        ) : (
          <p className="room-empty">{t('lead.paneNone')}</p>
        )}
      </div>
    </div>
  );
}
