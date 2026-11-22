// While a window is connected the core lets a blocking hook wait (bounded) for the user's answer; without
// this heartbeat it answers "no decision" at once and the agent shows its own prompt (spec Decision queue).
import { useEffect } from 'react';
import type { CoreClient } from '../api';

/** The core counts a window as present for 3 s after each `queue_connect`; beat every second. */
export function useQueueConnect(core: CoreClient, connected: boolean) {
  useEffect(() => {
    if (!connected) return;
    const beat = () => void core.request({ op: 'queue_connect' }).catch(() => {});
    beat();
    const timer = setInterval(beat, 1000);
    return () => clearInterval(timer);
  }, [core, connected]);
}
