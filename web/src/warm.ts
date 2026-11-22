// A tab's heavy view (xterm, chat list) exists while the tab is shown and for COOL_MS after; the core keeps the data,
// so showing the tab again rebuilds it. Never-shown tabs cost nothing. Memory ticket light-2.
import { useEffect, useState } from 'react';

export const COOL_MS = 30_000;

export function useWarm(active: boolean): boolean {
  const [warm, setWarm] = useState(false);
  // Set during render so the effects of the commit that shows the tab already see it.
  if (active && !warm) setWarm(true);
  useEffect(() => {
    if (active || !warm) return;
    const t = setTimeout(() => setWarm(false), COOL_MS);
    return () => clearTimeout(t);
  }, [active, warm]);
  return warm;
}
