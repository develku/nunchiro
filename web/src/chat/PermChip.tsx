// CHAT-PERMCHIP: the composer's permission-mode chip. CHAT-MODELIST (ticket 285): a click opens the list of every mode
// of the session (current marked) and one pick switches: the core presses Claude's own Shift+Tab one logged key at a
// time and stops when the footer shows the pick. Bypass permissions is listed last (owner 11-09: no confirm), and the
// chip then wears the warning colour. Side chat locks its launch mode; other sessions follow the observed footer.
// The menu is the composer stash's pattern (ComposerStash.tsx): Esc closes and returns focus to the trigger.
import { useEffect, useId, useRef, useState } from 'react';
import type { CoreClient } from '../api';
import { Icon } from '../icons/Icon';
import type { T } from '../i18n';
import { plainError, rawError } from '../errors';
import type { Session } from '../types';
import { chipDisabled, chipShown, CODEX_MODES, codexMode, isSkip, modeRows, type Mode } from './perm-chip';
import './perm-chip.css';

export function PermChip({ core, session, connected, t, sideChat = false, typed = false }: { sideChat?: boolean; core: CoreClient; session: Session | null; connected: boolean; t: T; typed?: boolean }) {
  const name = (mode?: string) => (mode ? t(`mode.${mode}` as 'mode.manual') : t('chat.perm.mode'));
  const root = useRef<HTMLSpanElement>(null);
  const chip = useRef<HTMLButtonElement>(null);
  const why = useId(); // Ticket 412: a disabled control names its reason to screen readers too (aria-describedby to a hidden span), not only in its tooltip.
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState(0);
  const [wait, setWait] = useState<Mode | null>(null); // the pick being walked to, until the footer shows it or the core gives up
  const [error, setError] = useState<unknown>('');
  // B15 (ticket 991): the footer that names the mode is hidden while Claude works or shows a dialog; the chip keeps the last
  // mode it read for this session instead of flipping to an unlabelled "Mode".
  // N16 (look 1117 v4f): kept per session for the window, not per chip, so a chip drawn again (a tab switch, a resumed
  // session's composer) still knows it; the bare label shows only when no mode was ever read for the session.
  if (session?.permission_mode) lastMode.set(session.id, session.permission_mode);
  const mode = session?.permission_mode ?? (session ? lastMode.get(session.id) : undefined);
  const walk = session?.mode_state?.walk;
  // A different session ends everything; the footer reaching the pick, or the core's reason, ends the wait.
  useEffect(() => {
    setOpen(false);
    setWait(null);
    setError('');
  }, [session?.id]);
  // Look 1117 v10 N10-S3-6: a refused switch ("not ready for input") is about that moment: it goes once the footer shows
  // the mode again (the agent is at its prompt) or the user types.
  const ready = !!session?.permission_mode;
  useEffect(() => setError(''), [ready, typed]);
  useEffect(() => {
    if (wait && (mode === wait || walk?.error)) setWait(null);
  }, [mode, walk?.error, wait]);
  useEffect(() => {
    if (!wait) return;
    const timer = setTimeout(() => setWait(null), 15000); // the core ends its own walk in seconds; this only frees the chip
    return () => clearTimeout(timer);
  }, [wait]);
  // The list opens with focus on the current mode; its keys are the menu's own (arrows, Home/End, Esc, Tab).
  useEffect(() => {
    if (open) root.current?.querySelector<HTMLElement>(`[role="menuitemradio"][data-i="${at}"]`)?.focus();
  }, [open, at]);
  if (sideChat && session)
    return (
      <>
        <button type="button" className="ch perm" aria-label={t('chat.perm.label')} title={t('chat.side.locked')} aria-describedby={why} disabled>
          {session.kind === 'codex' ? t('chat.side.readOnly') : name('plan')}
        </button>
        <span id={why} hidden>
          {t('chat.side.locked')}
        </span>
      </>
    );
  // Ticket 991 (B6 chip): a Codex session says the mode it was started in, in the chip's place and look. No list: the mode
  // is the stored choice of Settings > Providers, and nothing here can change it in a running session.
  const started = codexMode(session);
  if (started) {
    const word = t(CODEX_MODES[started]);
    const tip = t('mode.codexStart', { mode: word });
    return (
      <span className="perm-wrap">
        <button type="button" className={`ch perm ro${started === 'full-access' ? ' skip' : ''}`} aria-label={`${t('chat.perm.label')} · ${word}`} title={tip} aria-describedby={why} aria-disabled="true" data-mode={started}>
          <span className="pm-text">{word}</span>
        </button>
        <span id={why} hidden>
          {tip}
        </span>
      </span>
    );
  }
  if (!chipShown(session)) return null;
  const rows = modeRows(session);
  const walking = !!wait || (!!walk && !walk.error);
  const close = (back = true) => {
    setOpen(false);
    if (back) chip.current?.focus(); // a removed row would take focus with it
  };
  const send = (pick: Mode) => {
    setError('');
    setWait(pick);
    core.setMode(session.id, pick).catch((e) => (setWait(null), setError(e)));
  };
  const pick = (i: number) => {
    const row = rows[i];
    if (!row || row.disabled) return;
    close();
    if (row.current) return;
    send(row.mode);
  };
  const move = (to: number) => setAt((to + rows.length) % rows.length);
  const skipOn = isSkip(mode);
  const walkError = walk?.error;
  const reason = rows.find((r) => r.disabled)?.disabled;
  return (
    <span
      ref={root}
      className="perm-wrap"
      onBlur={(e) => e.relatedTarget && !e.currentTarget.contains(e.relatedTarget as Node) && close(false)} // WebKit gives a clicked button no focus: a null target is not leaving
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing || !open) return;
        if (e.key === 'Escape') return e.preventDefault(), e.stopPropagation(), close(); // not the composer's Stop
        if (e.key === 'ArrowDown') return e.preventDefault(), move(at + 1);
        if (e.key === 'ArrowUp') return e.preventDefault(), move(at - 1);
        if (e.key === 'Home') return e.preventDefault(), setAt(0);
        if (e.key === 'End') return e.preventDefault(), setAt(rows.length - 1);
        if (e.key === 'Tab') close(false);
      }}
    >
      <button
        ref={chip}
        className={`ch perm${skipOn ? ' skip' : ''}`}
        aria-label={`${t('chat.perm.label')} · ${name(mode)}`} // look 1117 v4: the name says the mode, as the model chip's does
        aria-haspopup="menu"
        aria-expanded={open}
        title={skipOn ? t('mode.skipWarn') : t('mode.chipTitle', { mode: name(mode) })}
        data-mode={mode}
        aria-busy={walking || undefined}
        disabled={chipDisabled(session, connected, false)} // a walk keeps the chip enabled so focus stays on it; a click then waits
        onClick={() => walking || (open ? close(false) : (setAt(Math.max(0, rows.findIndex((r) => r.current))), setOpen(true)))}
      >
        <span className="pm-text">{walking && wait ? t('mode.walking', { mode: name(wait) }) : name(mode)}</span> <span className="c" aria-hidden="true">▼</span>
      </button>
      {open && (
        <div className="perm-menu" role="menu" aria-label={t('mode.list')}>
          {rows.map((r, i) => (
            <button
              key={r.mode}
              type="button"
              role="menuitemradio"
              aria-checked={r.current}
              aria-disabled={!!r.disabled || undefined}
              aria-describedby={r.disabled ? 'perm-reason' : undefined}
              className={`pi${isSkip(r.mode) ? ' skip' : ''}`}
              data-mode={r.mode}
              data-i={i}
              tabIndex={i === at ? 0 : -1}
              onMouseMove={() => setAt(i)}
              onClick={() => pick(i)}
            >
              <span className="ck">{r.current && <Icon name="check" size={14} />}</span>
              <span className="nm">{name(r.mode)}</span>
              {r.current && <span className="d">{t('mode.current')}</span>}
            </button>
          ))}
          {reason && (
            <p id="perm-reason" className="perm-reason">
              {t(reason)}
            </p>
          )}
        </div>
      )}
      {(error || walkError) && (
        // Ticket 480: a refused switch reads plainly; its raw reason is the tooltip.
        <span className="perm-err" role="status" title={error ? rawError(error) : undefined}>
          {error ? plainError(t, error) : walkError}
        </span>
      )}
    </span>
  );
}

/** The last permission mode each session's footer showed (window memory). */
const lastMode = new Map<string, string>();
