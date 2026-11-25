// The status line's Undo: a polite live region, "<label> · Undo" for 10 s (mockup 05-context-undo.html, option A).
import { docT, FailedNote } from '../errors';
import { useEffect, useRef } from 'react';
import { pause, resume, run, useUndo } from './store';
import { useHtmlLangT } from '../i18n/lib/useHtmlLangT';

// Hover and focus are tracked apart: the countdown resumes only when both are gone.
const PAUSED_BAR = '.undobar::after { animation-play-state: paused; }';

export function UndoLine() {
  const { entry, failed, n, paused } = useUndo();
  const t = useHtmlLangT(); // ticket 492
  const held = useRef({ pointer: false, focus: false });
  const hold = (k: 'pointer' | 'focus', on: boolean) => {
    held.current[k] = on;
    if (on) pause();
    else if (!held.current.pointer && !held.current.focus) resume();
  };
  // A line that cleared under the pointer or focus never saw its leave/blur: a newer entry starts clean.
  useEffect(() => {
    held.current = { pointer: false, focus: false };
  }, [n]);
  // A line rebuilt under a still pointer (a refused Undo) never saw its pointerleave: moves anywhere settle it.
  const shown = !!(entry || failed);
  const el = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!shown) return;
    // The button that held focus went with the old line (no blur fires for a removed element).
    held.current.focus = !!el.current?.contains(document.activeElement);
    if (!held.current.pointer && !held.current.focus) resume();
    const move = (e: PointerEvent) => {
      const inside = !!(e.target as Element | null)?.closest?.('.undoline');
      if (inside !== held.current.pointer) hold('pointer', inside);
    };
    document.addEventListener('pointermove', move);
    return () => document.removeEventListener('pointermove', move);
  }, [shown]);
  if (!shown || entry?.toast) return null; // ticket 1130 B-L3: a toast entry is drawn by its own toast
  return (
    <span
      ref={el}
      className="undoline"
      role="status"
      aria-live="polite"
      onPointerEnter={() => hold('pointer', true)}
      onPointerLeave={() => hold('pointer', false)}
      onFocus={() => hold('focus', true)}
      onBlur={() => hold('focus', false)}
    >
      {/* styles.css is chrome's: the bar's animation sits on ::after, which an inline style cannot reach */}
      {paused && <style>{PAUSED_BAR}</style>}
      {entry ? (
        <>
          <span>{entry.label}</span>
          <button className="btn sm" onClick={() => void run()}>
            {t('mw.undo')} <kbd className="kbd">⌘Z</kbd>
          </button>
          <i className="undobar" key={n} aria-hidden />
        </>
      ) : typeof failed === 'string' ? (
        failed
      ) : (
        <FailedNote t={docT()} note={failed} />
      )}
    </span>
  );
}
