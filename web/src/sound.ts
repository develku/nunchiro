// v1a-38: a macOS system sound on running -> done and on a new waiting item (needs 56, owner change: system
// sounds, no bundled audio). The app plays it by name from the same fixed list (`play_sound`); it never takes focus.
import { load, type SoundChoice } from './settings';

export function play(name: SoundChoice, volume: number) {
  // shortcut: silent outside the app (browser dev page); a web Audio fallback would need bundled files.
  if (name === 'off' || !('__TAURI_INTERNALS__' in window)) return;
  void import('@tauri-apps/api/core').then(({ invoke }) => invoke('play_sound', { name, volume })).catch(() => {});
}

const lastCue = new Map<string, number>();

/** The chosen sound for an event, read from the window settings at the moment it happens. Ticket 372: a repeat of the
 *  same event inside 1 s is dropped, so sessions ending together play once (T3 threadNotifications.ts:111-115, MIT;
 *  rule only: the shell plays NSSound, so a timestamp stands in for the audio clock). */
export function cue(event: 'done' | 'waiting') {
  const now = Date.now();
  if (now - (lastCue.get(event) ?? -Infinity) < 1000) return;
  lastCue.set(event, now);
  const s = load();
  play(event === 'done' ? s.soundDone : s.soundWaiting, s.soundVolume);
}
