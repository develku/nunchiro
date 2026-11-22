// The title bar's Auto-hide reveal and the Hidden hint (A30-A32), moved out of App.tsx (its line bound) with ticket 1030.
import { useEffect, useRef, useState } from 'react';
import type { Settings } from '../settings';

export function useTitleBar(settings: Settings, update: (patch: Partial<Settings>) => void, palette: boolean) {
  // The title bar (A30-A32): Auto-hide shows it while the pointer is within 6 px of the top, Hidden says once how to bring it back.
  const [reveal, setReveal] = useState(false);
  const headRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (settings.titleBar !== 'auto') return setReveal(false);
    const move = (e: MouseEvent) => {
      if (e.clientY <= 6) setReveal(true);
      else if (!palette && e.clientY > (headRef.current?.offsetHeight ?? 34) + 2) setReveal(false);
    };
    window.addEventListener('mousemove', move);
    return () => window.removeEventListener('mousemove', move);
  }, [settings.titleBar, palette]);
  // v25f-title-hidden: Hidden also hides the macOS traffic lights; Always and Auto-hide keep them.
  useEffect(() => {
    if (!('__TAURI_INTERNALS__' in window)) return;
    void import('@tauri-apps/api/core').then(({ invoke }) => invoke('window_buttons', { shown: settings.titleBar !== 'hidden' })).catch(() => {});
  }, [settings.titleBar]);
  const [hint, setHint] = useState(false);
  useEffect(() => {
    if (settings.titleBar !== 'hidden') return setHint(false);
    if (settings.titleHint) return;
    setHint(true);
    update({ titleHint: true });
  }, [settings.titleBar, settings.titleHint, update]);
  useEffect(() => {
    if (!hint) return;
    const t = setTimeout(() => setHint(false), 15000);
    return () => clearTimeout(t);
  }, [hint]);
  return { reveal, headRef, hint, setHint };
}
