// needs 150: when the start-up store migration moved a stored value to a new approved default, one toast says so and
// offers Undo, which puts the old value back (and the store, saved at that change, keeps it).
import { useEffect, useState } from 'react';
import type { T } from '../../i18n';
import type { Key } from '../../i18n';
import { takeMigration, type Settings } from '../../settings';

/** One line per migrated field; a version that moves another default adds its field here and its string. */
const SAID: Partial<Record<keyof Settings, Key>> = { copyOnSelect: 'settings.migrated.copyOnSelect' };

/** Leaves after this long, like the worktree toast (tree/worktrees.tsx `TOAST_MS`). */
const TOAST_MS = 10_000;

export function MigrationToast({ t, update }: { t: T; update: (patch: Partial<Settings>) => void }) {
  const [undo, setUndo] = useState(takeMigration);
  // needs 172: a pointer or focus on the toast holds it; the full time counts again once both leave.
  const [held, setHeld] = useState({ pointer: false, focus: false });
  const hold = held.pointer || held.focus;
  useEffect(() => {
    if (!undo || hold) return;
    const id = window.setTimeout(() => setUndo(null), TOAST_MS);
    return () => window.clearTimeout(id);
  }, [undo, hold]);
  if (!undo) return null;
  return (
    <div
      className="toast"
      role="status"
      onPointerEnter={() => setHeld((h) => ({ ...h, pointer: true }))}
      onPointerLeave={() => setHeld((h) => ({ ...h, pointer: false }))}
      onFocus={() => setHeld((h) => ({ ...h, focus: true }))}
      onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setHeld((h) => ({ ...h, focus: false }))}
    >
      {(Object.keys(undo) as (keyof Settings)[]).map((k) => SAID[k] && <span key={k}>{t(SAID[k])}</span>)}
      <button onClick={() => (update(undo), setUndo(null))}>{t('settings.migrated.undo')}</button>
      <button aria-label={t('settings.migrated.dismiss')} onClick={() => setUndo(null)}>
        ×
      </button>
    </div>
  );
}
