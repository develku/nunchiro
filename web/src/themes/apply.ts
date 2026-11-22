// Applies the active theme (needs 55): window tokens on <html>, `color-scheme` and `data-theme` by background, and the
// xterm theme for every open terminal. System mode follows the OS live.
import { useLayoutEffect, useMemo, useSyncExternalStore } from 'react';
import type { Settings } from '../settings';
import { deriveTokens, isDark, xtermTheme } from './derive';
import { DARK_PICK, LIGHT_PICK, type ThemePick } from './nunchiro';

const DARK = '(prefers-color-scheme: dark)';
const SELECTION_STYLE = 'theme-selection';
const subscribe = (fn: () => void) => {
  const q = matchMedia(DARK);
  q.addEventListener('change', fn);
  return () => q.removeEventListener('change', fn);
};

export const useOsDark = () => useSyncExternalStore(subscribe, () => matchMedia(DARK).matches);

// V1A-62 live preview: the gallery shows a theme in the whole window without saving it; null goes back to the saved one.
let preview: ThemePick | null = null;
const previewSubs = new Set<() => void>();
export function previewTheme(p: ThemePick | null) {
  if (preview === p) return;
  preview = p;
  for (const fn of previewSubs) fn();
}
const usePreview = () =>
  useSyncExternalStore(
    (fn) => (previewSubs.add(fn), () => void previewSubs.delete(fn)),
    () => preview,
  );

export function useTheme(s: Settings) {
  const osDark = useOsDark();
  const pick = usePreview() ?? (s.themeMode === 'fixed' ? s.themeFixed : osDark ? s.themeDark : s.themeLight);
  // Before paint, so a stored catalog theme never flashes the stylesheet's default first.
  useLayoutEffect(() => {
    const root = document.documentElement;
    // The bundled Nunchiro picks paint tokens.css exactly (the ko/ mockup values); any other theme derives the roles.
    const bundled = pick.id === LIGHT_PICK.id || pick.id === DARK_PICK.id;
    for (const [k, v] of Object.entries(deriveTokens(pick.colors))) bundled ? root.style.removeProperty(k) : root.style.setProperty(k, v);
    // The window's own text selection takes the theme's selection colours (--selection-bg, --selection-text); the bundled pair keeps the browser's.
    let sel = document.getElementById(SELECTION_STYLE);
    if (bundled) sel?.remove();
    else if (!sel) {
      sel = document.createElement('style');
      sel.id = SELECTION_STYLE;
      sel.textContent = '::selection { background: var(--selection-bg); color: var(--selection-text); }';
      document.head.append(sel);
    }
    const scheme = isDark(pick.colors) ? 'dark' : 'light';
    // chat, diff, files and sheet styles key their own light/dark sets off this attribute.
    root.dataset.theme = scheme;
    root.style.colorScheme = scheme;
  }, [pick]);
  // Ticket 1039: Plain turns the chat's accent rules off; chat/chat.css keys them off this attribute.
  useLayoutEffect(() => {
    if (s.chatColours === 'plain') document.documentElement.dataset.chatColours = 'plain';
    else delete document.documentElement.dataset.chatColours;
  }, [s.chatColours]);
  return useMemo(() => xtermTheme(pick.colors), [pick]);
}
