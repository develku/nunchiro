// Ticket 197 (needs 39): the menu bar's waiting item (main.rs WAITING_SCRIPT) brings up the next waiting item.
import { useEffect, useRef } from 'react';

/** Runs `waiting.next` on the menu bar item's event. A window it reopened keeps the flag until its items arrive, for 10 s
 * at most. */
export function useWaitingFlag(count: number, run: (id: string) => void) {
  const runRef = useRef(run);
  runRef.current = run;
  useEffect(() => {
    const w = window as { __NUNCHIRO_WAITING__?: number };
    const go = () => {
      if (!w.__NUNCHIRO_WAITING__) return;
      if (Date.now() - w.__NUNCHIRO_WAITING__ > 10_000) return void delete w.__NUNCHIRO_WAITING__;
      if (!count) return;
      delete w.__NUNCHIRO_WAITING__;
      runRef.current('waiting.next');
    };
    go();
    window.addEventListener('nunchiro:waiting', go);
    return () => window.removeEventListener('nunchiro:waiting', go);
  }, [count]);
}
