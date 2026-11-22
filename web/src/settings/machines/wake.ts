import { useEffect } from 'react';
import type { CoreClient } from '../../api';

/** A Mac that woke or came back online does not wait out the channel's backoff (up to 30 s): when the window is seen
 *  again or the network returns, every machine that is not up gets one retry, at most once per 10 s. */
export function useMachineWake(core: CoreClient, connected: boolean) {
  useEffect(() => {
    if (!connected) return;
    let last = 0;
    const wake = () => {
      if (document.visibilityState !== 'visible' || Date.now() - last < 10_000) return;
      last = Date.now();
      void core.request({ op: 'machine_status' }).then((r) => {
        for (const m of (r as { machines: { machine: string; channel?: { state: string } }[] }).machines)
          if (m.channel && m.channel.state !== 'up' && m.channel.state !== 'connecting') void core.request({ op: 'machine_status', label: m.machine, retry: true }).catch(() => {});
      }, () => {});
    };
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('online', wake);
    return () => (document.removeEventListener('visibilitychange', wake), window.removeEventListener('online', wake));
  }, [core, connected]);
}
