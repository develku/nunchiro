// Quit and close-window flow (split out of App.tsx, needs 183).
import { useEffect, useState } from 'react';
import { app as appCommand, inApp } from './tauri';
import { notifyDefault } from '../../settings';
import { docT, plainError, rawError } from '../../errors';

// Ticket 372: the shell cannot read per-session levels, so the page hands it one bit: count alerts on unless the default is muted.
const close = () => appCommand('close_window', { alerts: notifyDefault() !== 'muted' });

const CLOSE_NOTICE = 'nunchiro.closeNoticeSeen';

/** v1a-09: the quit confirmation and the window close notice (state and their app-shell commands). */
export function useLifetime() {
  // Ticket 480: `error` is the plain line; `details` the raw reason for Details.
  const [quit, setQuit] = useState<{ busy: boolean; error: string; details?: string } | null>(null);
  const [closeNotice, setCloseNotice] = useState(false);

  // v1a-09: the app shell asks for the full-quit confirmation and reports window close requests.
  useEffect(() => {
    const askQuit = () => setQuit({ busy: false, error: '' });
    const onClose = () => {
      let seenBefore = false;
      try {
        seenBefore = localStorage.getItem(CLOSE_NOTICE) === '1';
      } catch {
        // Storage blocked: the notice shows each time, which is the safe side.
      }
      if (seenBefore) void close();
      else setCloseNotice(true);
    };
    // The shell may have asked before this page was ready to listen.
    if ((window as { __NUNCHIRO_QUIT__?: boolean }).__NUNCHIRO_QUIT__) askQuit();
    window.addEventListener('nunchiro:quit-request', askQuit);
    window.addEventListener('nunchiro:close-request', onClose);
    (window as { __nunchiroCloseReady?: boolean }).__nunchiroCloseReady = true;
    return () => {
      window.removeEventListener('nunchiro:quit-request', askQuit);
      window.removeEventListener('nunchiro:close-request', onClose);
      (window as { __nunchiroCloseReady?: boolean }).__nunchiroCloseReady = false;
    };
  }, []);
  const confirmQuit = async () => {
    if (!inApp()) return setQuit({ busy: false, error: 'Quitting from the window needs the Nunchiro app. In a terminal, run: nunchiro serve stop' });
    setQuit({ busy: true, error: '' });
    try {
      await appCommand('quit_all');
    } catch (e) {
      setQuit({ busy: false, error: plainError(docT(), e), details: rawError(e) });
    }
  };
  const closeWindow = () => {
    try {
      localStorage.setItem(CLOSE_NOTICE, '1');
    } catch {
      // Storage blocked: see above.
    }
    setCloseNotice(false);
    void close();
  };
  return { quit, setQuit, closeNotice, setCloseNotice, confirmQuit, closeWindow };
}
