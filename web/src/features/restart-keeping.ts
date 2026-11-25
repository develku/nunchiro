// Ticket 1123 T10 (owner 11-25 Q3), shared by ticket 1130 C6: restart an agent session so it starts with a new MCP server.
// It resumes its conversation when restartStart finds one; Settings > Skills & hooks and the composer's offer row use it.
import type { CoreClient } from '../api';
import { continueSession } from '../history/history';
import { restartStart } from '../PermissionNeeded';
import type { Session } from '../types';

/** `before` runs once the old run is closed, before the resume opens its tab (Settings closes itself there). */
export async function restartKeeping(core: CoreClient, s: Session, before?: () => void) {
  // A resumed conversation cannot start while its old run is live. close_idle (ticket 1130 round 2): the core refuses
  // it while a turn runs or the session waits for the owner, in the same step as the close.
  await core.request({ op: 'close_idle', id: s.id });
  before?.();
  continueSession({ ...s, state: 'exited', agent_session_id: restartStart(s).resume });
}
