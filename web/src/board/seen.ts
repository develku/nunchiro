// board_seen from the window, whether or not a Board widget is placed: the board's state lives in the core, so a
// finished turn the user has in view (its tab open, the window visible) stops being "review" everywhere.
import { useEffect, useRef, useState } from 'react';
import type { CoreClient } from '../api';
import type { Session } from '../types';

export function useBoardSeen(core: CoreClient, session: Session | null, connected: boolean) {
  const [visible, setVisible] = useState(document.visibilityState === 'visible');
  useEffect(() => {
    const on = () => setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);
  const sent = useRef('');
  const id = session?.id;
  // The snapshot carries `completion_seq` (core README); the window's Session type does not name it.
  const seq = (session as { completion_seq?: number } | null)?.completion_seq ?? 0;
  useEffect(() => {
    if (!id || !seq || !connected || !visible || sent.current === `${id}:${seq}`) return;
    sent.current = `${id}:${seq}`;
    core.request({ op: 'board_seen', id, completion_seq: seq }).catch(() => (sent.current = ''));
  }, [core, id, seq, connected, visible]);
}
