// v25-exit-widgets (ticket 286 item 2, needs 207): closing an ended session. Stop is for a running one; an ended session (the agent
// quit, failed, or is resumable after a core restart) stays in the tabs and the tree until it is closed, and 11-04 had no way to.
import type { CoreClient } from '../api';
import type { T } from '../i18n';
import { sessionName } from '../Sidebar';
import { push as pushUndo, UNDO_MS } from '../undo/store';
import type { Session } from '../types';
import { errorNote, notePlain, type Note } from '../errors';

/** A session that has ended but is still listed: Close session applies (a running one is stopped, a closed one is gone). */
// Look 1117 v4f (A q10b-2): an idle live session can be closed too (the core's close keeps its Undo); a working one needs Stop first.
export const closeable = (s: Session) => !s.side_chat && (s.state === 'exited' || s.state === 'failed' || s.state === 'resumable' || (s.state === 'running' && !s.attention.working && !s.pending.length));

/** Stop applies to a running session, except an idle shell: it has no turn to stop, so ending it is Close session. */
export const stoppable = (s: Session | null | undefined) => s?.state === 'running' && !(s.kind === 'shell' && closeable(s));

/** Closes `s` through the core's two-phase close; the status line offers Undo for the core's own 10 s window. */
export const closeEnded = (core: CoreClient, s: Session, t: T, note: (n: Note) => void) => {
  const deadline = Date.now() + UNDO_MS; // taken before the request, so never later than the core's own window
  return core.request({ op: 'close', id: s.id }).then(
    () => pushUndo({ label: t('exitWidgets.closed', { name: sessionName(s) }), undo: () => core.request({ op: 'close_undo', id: s.id }), deadline }),
    (e) => note(errorNote(t('exitWidgets.notClosed', { error: notePlain(t, e) }), e)),
  );
};
