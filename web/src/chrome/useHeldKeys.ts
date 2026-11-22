// Ticket 377 item 2 (F4): the keys shown where they act. Holding the modifiers of a jump key for HELD_MS marks the document
// (`data-held-tab` for the tab jump ⌘1-9, `data-ctl` for the project jump ⌃1-9) and the chips in the strip and the tree appear
// by CSS. The 200 ms delay is T3 Code's (Sidebar.logic.ts, MIT): a quick ⌘C or ⌘K never flashes chips.
import { useEffect } from 'react';
import { label, type Bindings } from '../keys';

export const HELD_MS = 200;
const MODS = ['Control', 'Alt', 'Meta', 'Shift'];

/** The modifiers a chord is held with (`Meta+Shift+Digit1` is Meta and Shift); none for an unbound key or one after the prefix. */
export const modsOf = (chord: string | undefined) => (!chord || chord.startsWith('prefix ') ? [] : chord.split('+').slice(0, -1));

/** The chip of jump `n` (1-9) of `base` (`session.jump`, `project.jump`): the real binding from the settings, empty when unbound or after the prefix (no key to hold). */
export function jumpChip(bindings: Bindings, base: string, n: number): string {
  const chord = bindings[`${base}.${n}`]?.[0];
  return chord && modsOf(chord).length ? label(chord, bindings) : '';
}

/** Reports, on the root element, which jump keys' modifiers have been held for HELD_MS. */
export function useHeldKeys(bindings: Bindings) {
  const tab = modsOf(bindings['session.jump.1']?.[0]).join('+');
  const project = modsOf(bindings['project.jump.1']?.[0]).join('+');
  useEffect(() => {
    const root = document.documentElement;
    const wants = [
      ['data-held-tab', tab ? tab.split('+') : []],
      ['data-ctl', project ? project.split('+') : []],
    ] as const;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const hide = () => {
      clearTimeout(timer);
      for (const [attr] of wants) root.removeAttribute(attr);
    };
    // Only a modifier key's own press or release starts the wait; a key pressed with the modifier (⌘C) ends a wait that is
    // still running, so the chips never flash for a quick chord. Once shown they stay until the modifier is let go.
    const mark = (e: KeyboardEvent) => {
      const isMod = MODS.includes(e.key);
      if (e.type === 'keydown' && !isMod) return clearTimeout(timer);
      if (!isMod || e.repeat) return; // a repeating modifier must not push the wait back
      const held: Record<string, boolean> = { Control: e.ctrlKey, Alt: e.altKey, Meta: e.metaKey, Shift: e.shiftKey };
      const on = wants.filter(([, mods]) => mods.length > 0 && mods.every((m) => held[m]));
      clearTimeout(timer);
      for (const [attr] of wants) if (!on.some(([a]) => a === attr)) root.removeAttribute(attr);
      if (on.length) timer = setTimeout(() => on.forEach(([attr]) => root.setAttribute(attr, '')), HELD_MS);
    };
    window.addEventListener('keydown', mark, true);
    window.addEventListener('keyup', mark, true);
    window.addEventListener('blur', hide);
    return () => (window.removeEventListener('keydown', mark, true), window.removeEventListener('keyup', mark, true), window.removeEventListener('blur', hide), hide());
  }, [tab, project]);
}
