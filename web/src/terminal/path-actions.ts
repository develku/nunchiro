// Copyright (c) 2026 Lovecast Inc. (Orca, MIT): the action list and the resolve-then-act shape of
// `src/renderer/src/components/terminal-pane/terminal-file-link-actions.ts` at `2eb0bb63`, rebuilt as a plain-DOM popover.
// Orca's store, IPC, worktree routing and "Open with default app" row are not lifted.
//
// The popover for a terminal file path (ticket 216, needs 178 B2): a few text rows at the pointer. Never the system
// default app: nothing here opens a URL or runs a file; the calls that leave the window are the Reveal row, which
// the caller builds with `reveal()` and which shows the file in Finder without running it, and (ticket 375) Open in
// editor, which hands the path to the core's confined `open_in_editor` (the editor chosen in Settings, never a run).
import './path-actions.css';

export interface PathAction {
  label: string;
  run: () => void;
  /** Drawn `aria-disabled`: stays focusable, does nothing. */
  disabled?: boolean;
  /** The action moves focus itself (it opens a tab): the terminal is not refocused after it. */
  leaves?: boolean;
}

let closeCurrent: (() => void) | null = null;

/** Opens the popover at the pointer (one at a time). Esc and a pick hand focus back through `restore`. */
export function showPathActions(x: number, y: number, actions: PathAction[], restore: () => void) {
  closeCurrent?.();
  const box = document.createElement('div');
  box.className = 'pathmenu';
  box.setAttribute('role', 'menu');
  const rows = actions.map((a) => {
    const row = document.createElement('div');
    row.setAttribute('role', 'menuitem');
    row.tabIndex = -1;
    row.textContent = a.label;
    if (a.disabled) row.setAttribute('aria-disabled', 'true');
    row.addEventListener('click', () => {
      if (a.disabled) return;
      close(false);
      a.run();
      if (!a.leaves) restore();
    });
    return row;
  });
  box.append(...rows);
  document.body.append(box);

  // Inside the window: flip left / up when the pointer is near the right or bottom edge.
  const { width, height } = box.getBoundingClientRect();
  box.style.left = `${Math.max(0, x + width > innerWidth ? x - width : x)}px`;
  box.style.top = `${Math.max(0, y + height > innerHeight ? y - height : y)}px`;

  const at = () => rows.indexOf(document.activeElement as HTMLDivElement);
  const onKey = (e: KeyboardEvent) => {
    const n = rows.length;
    if (e.key === 'Tab') return close(false); // focus moves on; the popover is not a tab stop
    if (e.key === 'Escape') close(true);
    else if (e.key === 'ArrowDown') rows[(at() + 1) % n].focus();
    else if (e.key === 'ArrowUp') rows[(at() - 1 + n) % n].focus();
    else if (e.key === 'Enter' || e.key === ' ') rows[at()]?.click();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  const outside = (e: Event) => void (!box.contains(e.target as Node) && close(false));
  function close(refocus: boolean) {
    closeCurrent = null;
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('mousedown', outside, true);
    document.removeEventListener('contextmenu', outside, true);
    window.removeEventListener('blur', onBlur);
    box.remove();
    if (refocus) restore();
  }
  const onBlur = () => close(false);
  closeCurrent = () => close(false);
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('mousedown', outside, true);
  document.addEventListener('contextmenu', outside, true);
  window.addEventListener('blur', onBlur);
  rows[0].focus();
}
