// AGENTVIEW: a session whose screen the chat cannot draw (store.ts `blocked`) opens its pane on the PTY. The terminal takes
// focus unless the user is in a text field (the composer, with or without a draft); when the screen clears, a pane that only it opened closes.
// Ticket 255 (T-109): an agent's browser space loading its first page opens that session's pane on the Browser tab, never
// taking focus (the user keeps typing where they were), while the window setting below is on.
import { useEffect, useRef } from 'react';
import type { Session } from '../types';
import { defineSetting, useFeatureSetting } from '../settings/useFeatureSetting';
import { inApp, onMoved } from './browser/view/bridge';
import { YOU_SPACE } from './browser/view/spaces';
import { autoClose, autoOpen, blocked, show } from './store';

/** "Show the browser when an agent opens a page" (Settings › In-app browser); on by default. */
export const SHOW_ON_AGENT_NAV = defineSetting('browser.show_on_agent_nav', true, (v) => (typeof v === 'boolean' ? v : undefined));

export function useAutoOpen(sessions: Session[], active: string | null) {
  const was = useRef(new Set<string>());
  useEffect(() => {
    const now = new Set(sessions.filter((s) => s.kind !== 'shell' && blocked(s)).map((s) => s.id));
    for (const id of now)
      if (!was.current.has(id)) {
        // Never take focus from a field the user is in (the composer, a deny note): a new prompt must not move it
        // (decisions-widget promise), whether or not a draft is there.
        const at = document.activeElement;
        const typing = !!at && at.matches('textarea, input, select, [contenteditable="true"]') && !at.closest('.xterm');
        autoOpen(id, id === active && !typing);
      }
    for (const id of was.current) if (!now.has(id)) autoClose(id);
    was.current = now;
    // `active` and the focused element are read at the moment a screen appears, not subscribed to.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions]);

  const [showBrowser] = useFeatureSetting(SHOW_ON_AGENT_NAV);
  const now = useRef({ sessions, showBrowser });
  now.current = { sessions, showBrowser };
  useEffect(() => {
    if (!inApp()) return;
    const seen = new Set<string>(); // a space's first page in this window run; later pages leave the pane as the user set it
    const off = onMoved((space) => {
      if (space === YOU_SPACE || seen.has(space)) return;
      seen.add(space);
      const s = now.current.sessions.find((x) => x.id === space);
      if (now.current.showBrowser && s && s.kind !== 'shell') show(space, 'browser'); // no focus request
    }).catch(() => () => {});
    return () => void off.then((f) => f()).catch(() => {});
  }, []);
}
