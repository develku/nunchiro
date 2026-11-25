// Shell: the window's keys and the prefix's focus sink (split out of App.tsx, needs 183).
import { docT, tipError, type Note } from '../errors';
import { useEffect, useLayoutEffect, useRef } from 'react';
import { CoreClient } from '../api';
import { chordBytes, chordOf, composerKey, composing, isModifier, keyCapture, merge, PANE_DIRS, PANE_LEAVE, RESET_CHORD, resolve, TERMINAL_PASSTHROUGH } from '../keys';
import type { DragSource } from '../layout/DragLayer';
import { useArrange } from '../layout/useArrange';
import type { Dir } from '../layout/model';
import { pageFocus } from '../pane/browser/view/bridge';
import { drop as dropUndo, onKey as undoKey, push as pushUndo, type Entry } from '../undo/store';
import type { Session } from '../types';
import type { Settings } from '../settings';

type Deps = {
  editing: boolean;
  palette: boolean;
  finish: () => Promise<void>;
  arrange: ReturnType<typeof useArrange>;
  setMessage: (m: { text: string; error: boolean } | null) => void;
  drag: DragSource | null;
  settings: Settings;
  update: (patch: Partial<Settings>) => void;
  setPaneNote: (note: Note) => void;
  hints: false | 'open' | 'copy';
  copyId: string | null;
  bindings: ReturnType<typeof merge>;
  pane: string | null;
  paneApi: { current: { focus: (d: Dir) => void; swap: (d: Dir) => void; resize: (d: Dir) => void; enter: () => void; leave: () => void } };
  armed: boolean;
  setArmed: (on: boolean) => void;
  run: (id: string) => void;
  current: Session | null;
  core: CoreClient;
  toSink: () => void;
  fromSink: () => void;
  /** Ticket 516: Settings is open, so its own keys (SETTINGS_ONLY) come first. */
  inSettings: boolean;
};

export function useKeySink() {
  // While the prefix is armed (or hints show), focus rests on a non-editable sink so an input source such as
  // Korean has no text field to type the next key into; focus goes back before the command runs.
  const sink = useRef<HTMLDivElement>(null);
  const before = useRef<HTMLElement | null>(null);
  const toSink = () => {
    if (document.activeElement !== sink.current) before.current = document.activeElement as HTMLElement | null;
    sink.current?.focus();
  };
  const fromSink = () => {
    if (document.activeElement === sink.current) before.current?.focus?.();
    before.current = null;
  };
  return { sink, before, toSink, fromSink };
}

/** The window's keys: layout edit mode's Esc and Cmd+Z, the status line's Undo, and the global key handler (prefix, pane
 *  mode, bindings) in the capture phase. */
export function useGlobalKeys({ editing, palette, finish, arrange, setMessage, drag, settings, update, setPaneNote, hints, copyId, bindings, pane, paneApi, armed, setArmed, run, current, core, toSink, fromSink, inSettings }: Deps) {
  // In edit mode Esc ends it (not during a drag, a sheet, a menu or a field) and ⌘Z / Ctrl+Z steps back one change.
  const dragRef = useRef<DragSource | null>(null);
  useEffect(() => {
    if (!editing) return;
    const on = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = !!t?.closest('input, textarea, select, [contenteditable="true"], .xterm') || !!t?.isContentEditable;
      if (e.key === 'Escape') {
        if (dragRef.current || typing || palette || document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"], .lcard[data-armed] /* layout-b */')) return;
        e.preventDefault();
        void finish();
      } else if (e.key.toLowerCase() === 'z' && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && !typing) {
        e.preventDefault();
        void arrange.undo().catch((err: Error) => setMessage({ text: tipError(docT(), err), error: true }));
      }
    };
    // Capture: a sheet or menu that closes on this Esc must still be in the page when it is checked.
    window.addEventListener('keydown', on, true);
    return () => window.removeEventListener('keydown', on, true);
  }, [editing, palette, finish, arrange]);
  // V2-6a: Cmd+Z runs the status line's Undo; the layout edit's own Cmd+Z (above) has already claimed its key.
  useEffect(() => {
    window.addEventListener('keydown', undoKey);
    return () => window.removeEventListener('keydown', undoKey);
  }, []);
  // A layout edit that offers Undo in its toast offers it in the status line too (same history behind it).
  const layoutToast = arrange.toast;
  // A later toast without Undo ("Undone", a refusal) means that step is gone: the line must not run it again.
  const layoutEntry = useRef<Entry | null>(null);
  useEffect(() => {
    if (!layoutToast) return;
    if (layoutToast.undo) pushUndo((layoutEntry.current = { label: layoutToast.text, undo: () => arrange.undo() }));
    else if (layoutEntry.current) dropUndo(layoutEntry.current);
  }, [layoutToast?.n]); // eslint-disable-line react-hooks/exhaustive-deps -- one push per toast
  // Global keys, capture phase so the terminal never sees a binding. Composition keys pass untouched.
  const onKeyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  useLayoutEffect(() => {
    onKeyRef.current = (e: KeyboardEvent) => {
      if (isModifier(e.code)) return;
      const chord = chordOf(e);
      // The fixed reset chord (needs 170 (3)) comes before everything: while recording, in a terminal, in pane mode.
      if (chord === RESET_CHORD) {
        e.preventDefault();
        e.stopPropagation();
        const was = settings.bindings;
        if (Object.keys(was).length) {
          update({ bindings: {} });
          pushUndo({ label: 'Key changes cleared', undo: () => update({ bindings: was }) });
        }
        return setPaneNote('Keys reset to defaults');
      }
      if (keyCapture.active || hints || copyId) return;
      // The "+" popover's and the project wizard's own fields take Enter, Cmd+Enter included: they start their session, not the composer's.
      // Ticket 374: so does a Diff line note's field, which only adds its note to the composer (never sends it).
      if (composerKey(bindings, chord) && document.activeElement?.closest('.newtab, .newsess, .dnotebox')) return;
      if (pane && !e.metaKey) {
        // v1a-43: every key belongs to pane mode, composing or not (none reaches the PTY); fixed keys by physical code.
        e.preventDefault();
        e.stopPropagation();
        const dir = PANE_DIRS[e.code];
        if (PANE_LEAVE.includes(e.code)) paneApi.current.leave();
        else if (dir) paneApi.current[e.ctrlKey ? 'resize' : e.shiftKey ? 'swap' : 'focus'](dir);
        return;
      }
      if (composing(e)) return;
      // v25-sendkeys: the composer's own two Enters are its textarea's (it knows which session, pin or split it is
      // for); the capture listener must not act on the main composer's text instead. Only that box: the terminal's
      // hidden input and every other field keep the old rule, so a chord never becomes a raw key to the PTY.
      if (composerKey(bindings, chord) && e.target instanceof HTMLTextAreaElement && !e.target.classList.contains('hoff-edit') && e.target.closest('.cbox')) return;
      if (armed && e.code === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        fromSink();
        pageFocus(true); // ticket 535: a prefix pressed in a page and cancelled hands the keys back to the page
        return setArmed(false);
      }
      const m = resolve(bindings, chord, armed, inSettings);
      if (m.kind === 'none' && !armed) return;
      // The agent's own Ctrl+O and a TUI's F2 stay the terminal's: such a direct chord with no Meta goes through untouched.
      if (m.kind === 'command' && !armed && TERMINAL_PASSTHROUGH.includes(m.id) && !e.metaKey && (e.target as HTMLElement | null)?.closest?.('.xterm')) return;
      // V2-8a: F2 on a focused tree row renames that row (a worktree's label, a main-folder session's name), not the tab.
      if (chord === 'F2' && !armed && (e.target as HTMLElement | null)?.closest?.('[data-wt], [data-menu="treerow"]')) return;
      // Ticket 200: over a file's text the find key belongs to the viewer's own find panel (CodeMirror's keymap), not the terminal's.
      if (m.kind === 'command' && !armed && m.id === 'terminal.find' && (e.target as HTMLElement | null)?.closest?.('.cm-editor')) return;
      e.preventDefault();
      e.stopPropagation();
      if (m.kind === 'command' && m.id === 'keys.help') return run(m.id); // v1a-57: stays armed, on the sink
      setArmed(m.kind === 'prefix');
      if (m.kind === 'prefix') return toSink();
      fromSink();
      if (m.kind === 'prefix-twice' && current) {
        const bytes = chordBytes(chord);
        if (bytes !== null) void core.sendText(current.id, bytes).catch(() => {});
      }
      if (m.kind === 'command') {
        if (m.id !== 'palette.open') pageFocus(false); // a command acted; the palette decides when it closes
        run(m.id);
      }
    };
  });
  // Ticket 535: the native monitor hands a window command's key (palette, settings, session switching) or the prefix,
  // pressed in a browser page, to this window. It reads the keymap by command id, so it is sent again after each rebinding.
  const sent = JSON.stringify(bindings);
  useEffect(() => {
    if (!('__TAURI_INTERNALS__' in window)) return;
    void import('@tauri-apps/api/core').then(({ invoke }) => invoke('browser_keys', { keymap: JSON.parse(sent) })).catch(() => {});
  }, [sent]);
  // Added once, calling the latest handler: a listener re-added on each render missed any key whose dispatch committed a
  // render first (one removed or added during a dispatch does not run for it), e.g. ⌘N after the tree's keydown clear (RC2b).
  useLayoutEffect(() => {
    const onKey = (e: KeyboardEvent) => onKeyRef.current(e);
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
  // Ticket 1071: the native View menu (main.rs VIEW_COMMANDS and TAB_JUMPS) runs these page commands; its keys reach the window even
  // while the in-app browser view holds the keyboard, which the page's own bindings never see.
  const runRef = useRef(run);
  useEffect(() => {
    const on = (e: Event) => {
      const id = (e as CustomEvent<unknown>).detail;
      if (typeof id === 'string' && /^(zoom\.(in|out|reset)|session\.jump\.[1-9])$/.test(id)) runRef.current(id);
    };
    window.addEventListener('nunchiro:command', on);
    return () => window.removeEventListener('nunchiro:command', on);
  }, []);
  runRef.current = run;
  dragRef.current = drag;
}
