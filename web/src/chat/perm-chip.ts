// CHAT-PERMCHIP: when the permission-mode chip shows and when a click is allowed (the core re-checks every press).
// CHAT-MODELIST (ticket 285): the rows of the mode list. Order is least to most access, as Orca's picker orders its
// permission modes (MIT, orca-src/orca/src/shared/agent-chat-permission-mode.ts `AGENT_CHAT_PERMISSION_MODES`).
import type { Session } from '../types';

/** Claude sessions of this Mac that run. A remote session's keys reach its core as a forwarded caller, never the user,
 *  so the core there refuses Shift+Tab: no chip rather than one that always fails. */
export const chipShown = (s: Session | null): s is Session => !!s && s.kind === 'claude' && s.state === 'running' && !s.machine;

/** Ticket 991 (B6 chip): Codex's modes by the core's names (`permission_mode` of a Codex session: the stored choice its
 *  start applied), each under the words Settings > Providers lists it with. */
export const CODEX_MODES = { own: 'agents.new.permOwn', ask: 'agents.new.permAsk', auto: 'mode.auto', 'full-access': 'agents.new.permYolo' } as const;
export type CodexMode = keyof typeof CODEX_MODES;

/** The mode a running Codex session of this Mac was started in, or none: an older row, a start whose own arguments
 *  stated the permission, or one the owner did not make. Shown read-only: Nunchiro cannot change it in a running session. */
export const codexMode = (s: Session | null): CodexMode | null =>
  s && s.kind === 'codex' && s.state === 'running' && !s.machine && s.permission_mode && Object.hasOwn(CODEX_MODES, s.permission_mode) ? (s.permission_mode as CodexMode) : null;

/** A press needs the composer: not while the agent works, a decision waits, or the last press is in flight. */
export const chipDisabled = (s: Session, connected: boolean, busy: boolean) => !connected || busy || s.attention.working || s.pending.length > 0;

/** Claude's footer names, as the core reads them (`permission_mode`); the list shows each under a window name. */
export const MODES = ['manual', 'accept edits', 'plan', 'auto', 'bypass permissions'] as const;
export type Mode = (typeof MODES)[number];
export const SKIP: Mode = 'bypass permissions';
export const isSkip = (mode?: string) => mode === SKIP;

export interface ModeRow {
  mode: Mode;
  current: boolean;
  /** Listed but not pickable: the reason is a catalogue key. */
  disabled?: 'mode.skipUnavailable' | 'mode.skipDisabled' | 'mode.skipSetting';
}

/** Every mode of a Claude session, current marked. Bypass permissions goes last and is disabled when this session's
 *  Shift+Tab cycle does not contain it or Claude's settings turn it off; nothing here ever picks it (a pick is the user's click). */
export function modeRows(s: Session): ModeRow[] {
  const skip = s.mode_state?.skip ?? 'unavailable';
  return MODES.map((mode) => ({
    mode,
    current: s.permission_mode === mode,
    disabled: mode !== SKIP || s.permission_mode === SKIP || skip === 'available' ? undefined : skip === 'disabled' ? 'mode.skipDisabled' : skip === 'needs_setting' ? 'mode.skipSetting' : 'mode.skipUnavailable',
  }));
}

