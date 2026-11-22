// V1A-38b: the focused session's whole log in $EDITOR. The core writes the file and starts the editor session; the
// window sends only the session id (no path, editor or argv).
import type { CoreClient } from '../api';
import type { Session } from '../types';

export type EditReply = { session: Session; truncated: boolean };

export const editScrollback = (core: CoreClient, id: string) => core.request({ op: 'scrollback_edit', id }) as Promise<EditReply>;
