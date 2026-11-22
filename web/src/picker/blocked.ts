import type { T } from '../i18n';
import { shownStatus, status } from '../types';
import type { WithLog } from './Picker';

/** Why a switch cannot start now, in the window's language, or null when it can (ticket 810: these were English literals). */
export function blocked(t: T, s: WithLog | null, connected: boolean, busy: boolean): string | null {
  if (!connected) return t('walk10.picker.disconnected');
  if (!s) return t('walk10.picker.noSession');
  if (s.state !== 'running') return t('walk10.picker.notRunning');
  if (busy) return t('walk10.picker.switching');
  // CHAT-MODELIST r3: a mode walk is typing Shift+Tab; the core refuses a switch until it ends (the picker is input too).
  if (s.mode_state?.walk && !s.mode_state.walk.error) return t('walk10.picker.modeWalk');
  // The word is the shown one: a turn in `agent ask --wait` reads "waiting for an answer" (look 1117 v13 B N13-S3-1).
  return status(s) === 'idle' ? null : t('walk10.picker.notIdle', { status: t(`mw.status.${shownStatus(s)}`) });
}
