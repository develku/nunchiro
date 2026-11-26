// V2-6a: the app's one context menu. Surfaces opt in by attribute, as the tooltip does:
//   data-menu="tab"             the surface (a key of SURFACES)
//   data-menu-session="<id>"    the session its items act on (made the active one first)
//   data-menu-arg="<text>"      handed to the command as its argument (a path, a message); page text, so commands treat it as a string only
//   data-menu-project="<path>"  the project row's folder: the argument of the TAKES_PROJECT items only
// Right-click opens it at the pointer without moving focus; the menu key or Shift+F10 on the focused row opens it at
// the row and takes focus until it closes (Esc returns it). The terminal, text fields and selects keep the platform menu.
import { KeyChip } from '../KeyChip';
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { Bindings, Command } from '../keys';
import { useHtmlLangT } from '../i18n/lib/useHtmlLangT';
import { DANGER, HINT, ROW_SESSION, SEPARATE_BEFORE, SURFACES, TAKES_PROJECT, TAKES_WORKTREE } from './surfaces';
import './menu.css';

type Open = { x: number; y: number; surface: string; session?: string; arg?: string; project?: string; worktree?: string; row: HTMLElement; byKey: boolean; title?: string };

const NATIVE = '.xterm, input, textarea, select, [contenteditable]';
const MARGIN = 6;

// Test seam, built in only for the suite (VITE_FEATURE_FIXTURES, as features/index.ts): the specs add a probe surface, probe
// commands and a probe danger id to the live tables. The production build drops it.
const probe = import.meta.env.VITE_FEATURE_FIXTURES ? ((window as unknown as { __menuProbe: unknown }).__menuProbe = { SURFACES, DANGER, commands: [] as Command[] }) : undefined;

// A command may say per target whether it can run (`enabledFor`); else a row with a session ignores `enabled`, which is
// computed for the active session, and a row with none uses it. The same test runs again on the fresh registry in `run`.
const argOf = (id: string, o: Open) => (TAKES_PROJECT.has(id) ? (o.project ?? o.arg) : TAKES_WORKTREE.has(id) && o.surface === 'worktree' ? (o.worktree ?? o.arg) : o.arg);
const off = (c: Command, o: Open) => (c.enabledFor ? !c.enabledFor({ session: o.session, arg: argOf(c.id, o) }) : o.session ? false : c.enabled === false);

/** Why `c` cannot run on the menu's row: the row's own reason when the command gives one, else the active session's. */
const whyOf = (c: Command, o: Open) => (off(c, o) ? (c.whyFor ? c.whyFor({ session: o.session, arg: argOf(c.id, o) }) : c.why) : undefined);

export function ContextMenu({ commands, bindings, activate, say }: { commands: Command[]; bindings: Bindings; activate: (session: string) => void; say?: (why: string) => void }) {
  const t = useHtmlLangT();
  const [m, setM] = useState<Open | null>(null);
  const [at, setAt] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  // A surface lists its commands in its own order (V2-CF3: the worktree's own first); a row with no session has nothing to stop.
  const items = m ? [...new Set(SURFACES[m.surface] ?? [])].flatMap((id) => [...commands, ...(probe?.commands ?? [])].filter((c) => c.id === id && c.menu !== false && !(!m.session && (ROW_SESSION.has(id) || (m.surface === 'worktree' && id === 'diff.open')))))
        // Look 1117 (F2): a row whose session has ended has nothing to stop; Restart is its action, so Stop is not offered.
        .filter((c) => !(c.id === 'session.stop' && m.session && off(c, m)))
        // Ticket 991 A14: a row's menu stops that row's session, not "the current" one.
        .map((c) => (c.id === 'session.stop' ? { ...c, title: t('rest.shell.menu.stopThis') } : c.titleFor ? { ...c, title: c.titleFor({ session: m.session, arg: argOf(c.id, m) }) } : c)) : [];
  const live = useRef({ commands, activate, say, m, at, items, run: (_: Command) => {} });
  Object.assign(live.current, { commands, activate, say, m, at, items });

  useEffect(() => {
    const st = live.current;
    const close = () => {
      const cur = st.m;
      if (!cur) return;
      // Focus inside the menu would drop to <body> when it unmounts: always hand it back to the row.
      if (box.current?.contains(document.activeElement) && cur.row.isConnected) cur.row.focus({ preventScroll: true });
      setM(null);
    };
    const show = (row: HTMLElement, x: number, y: number, byKey: boolean) => {
      const surface = row.dataset.menu!;
      if (!SURFACES[surface]) return false;
      setAt(0);
      setM({ x, y, surface, session: row.dataset.menuSession, arg: row.dataset.menuArg, project: row.dataset.menuProject, worktree: row.closest<HTMLElement>('[data-wt]')?.dataset.wt, row, byKey, title: row.dataset.menuTitle });
      return true;
    };
    const run = (c: Command | undefined) => {
      const cur = st.m;
      if (!c || !cur) return;
      if (off(c, cur)) {
        // Look 1117 v7 (S2-1): a greyed item that is pressed says why in the status line (it closed the menu and said
        // nothing, so "Restart session" on a running session read as a dead item). The row is not made active.
        const why = whyOf(c, cur);
        close();
        if (why) st.say?.(why);
        return;
      }
      close();
      // The command acts on the active session: make the row's session active first, then take the fresh registry.
      if (cur.session) flushSync(() => st.activate(cur.session!));
      const fresh = [...st.commands, ...(probe?.commands ?? [])].find((x) => x.id === c.id);
      if (fresh && !(fresh.enabledFor ? off(fresh, cur) : fresh.enabled === false)) fresh.run(argOf(fresh.id, cur));
    };
    st.run = run;
    const onContext = (e: MouseEvent) => {
      const t = e.target as Element | null;
      const row = t?.closest?.<HTMLElement>('[data-menu]');
      // Native menus stay for fields, the terminal, links and selected text (Copy).
      // (WebKit selects the word under a right-click only now, so the selection was read at mouse-down.)
      if (t?.closest?.(NATIVE) || t?.closest?.('a[href]') || selected || (!row && anySelected)) return close();
      // Ticket 991 A6: anywhere else the web view's own menu (Reload, AutoFill) never shows.
      e.preventDefault();
      if (!row || !show(row, e.clientX, e.clientY, false)) close();
    };
    // A right mouse-down would focus the row (a button, a tab); the menu must leave focus where it is.
    let selected = false;
    let anySelected = false;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Element | null;
      const sel = window.getSelection();
      anySelected = !!sel && !sel.isCollapsed;
      selected = !!sel && !sel.isCollapsed && !!t?.closest?.('[data-menu]')?.contains(sel.anchorNode);
      if ((e.button === 2 || (e.button === 0 && e.ctrlKey)) && t?.closest?.('[data-menu]') && !t.closest(NATIVE)) e.preventDefault();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229) return;
      const cur = st.m;
      if (!cur) {
        const opener = e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey);
        const a = document.activeElement as HTMLElement | null;
        const row = a?.closest?.<HTMLElement>('[data-menu]');
        if (!opener || !row || a!.closest(NATIVE)) return;
        const r = row.getBoundingClientRect();
        if (show(row, r.left + 12, r.bottom, true)) (e.preventDefault(), e.stopImmediatePropagation());
        return;
      }
      const n = st.items.length;
      const go = (i: number) => (e.preventDefault(), e.stopImmediatePropagation(), setAt(n ? (i + n) % n : 0));
      if (e.key === 'Escape') (e.preventDefault(), e.stopImmediatePropagation(), close());
      else if (e.key === 'ArrowDown') go(st.at + 1);
      else if (e.key === 'ArrowUp') go(st.at - 1);
      else if (e.key === 'Home') go(0);
      else if (e.key === 'End') go(n - 1);
      else if (e.key === 'Enter' || (e.key === ' ' && cur.byKey)) (e.preventDefault(), e.stopImmediatePropagation(), run(st.items[st.at]));
      else if (cur.byKey && e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
        // Type-ahead: the next item whose name starts with the letter.
        const k = e.key.toLowerCase();
        const next = [...st.items.keys()].map((i) => (st.at + 1 + i) % n).find((i) => st.items[i].title.toLowerCase().startsWith(k));
        e.preventDefault();
        e.stopImmediatePropagation();
        if (next !== undefined) setAt(next);
      } else if (!['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) close(); // any other key ends it and goes on
    };
    const outside = (e: Event) => !box.current?.contains(e.target as Node) && close();
    // Look 1117 v3: a dialog that takes the focus (Settings opened by any way) ends the menu; the row keeping it does not.
    // Only a dialog: a session that has just started focuses its terminal a moment after its tab opens, and that late
    // focus closed a menu the user had opened in between (wave 15: the row menu went 60 ms after the right-click).
    const focused = (e: FocusEvent) => st.m && !box.current?.contains(e.target as Node) && e.target !== st.m.row && (e.target as Element).closest?.('[role="dialog"], dialog, .ovl') && close();
    document.addEventListener('contextmenu', onContext);
    document.addEventListener('mousedown', onDown);
    // Capture on window: before every other key handler, which then never sees the key the menu used.
    window.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('wheel', outside, true); // the user scrolling; content scrolling by itself (a streaming chat) keeps it
    document.addEventListener('focusin', focused, true);
    // Look 1117 v11 (A): the menu went in the real app as a session started, with no in-page cause (the Chromium spec keeps
    // it). Only the window really leaving ends it: a blur the window takes back at once, or a resize that kept its size,
    // leaves the menu the user opened.
    const size = () => `${innerWidth}x${innerHeight}`;
    let was = size();
    const away = (e: Event) => {
      if (e.type === 'resize') return size() !== was && ((was = size()), close());
      setTimeout(() => document.hasFocus() || close(), 100);
    };
    window.addEventListener('resize', away);
    window.addEventListener('blur', away);
    return () => {
      document.removeEventListener('contextmenu', onContext);
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('wheel', outside, true);
      document.removeEventListener('focusin', focused, true);
      window.removeEventListener('resize', away);
      window.removeEventListener('blur', away);
    };
  }, []);

  // Place it at the pointer or row, kept inside the window, before paint; a keyboard open takes focus.
  useLayoutEffect(() => {
    const el = box.current;
    if (!m || !el) return;
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    el.style.left = `${Math.max(MARGIN, Math.min(m.x, vw - el.offsetWidth - MARGIN))}px`;
    el.style.top = `${Math.max(MARGIN, Math.min(m.y, vh - el.offsetHeight - MARGIN))}px`;
    if (m.byKey) el.focus({ preventScroll: true });
  }, [m]);

  if (!m || !items.length) return null;
  return (
    <div ref={box} className="cmenu" role="menu" aria-label={t('rest.shell.menu.actions')} tabIndex={-1} aria-activedescendant={`cm-${items[at]?.id}`}>
      {m.title && (
        <div className="mhd" role="presentation">
          {m.title}
        </div>
      )}
      {items.map((c, i) => {
        const b = bindings[c.id]?.[0];
        const why = whyOf(c, m); // its tooltip and accessible description; the item is drawn as mockup 05 draws it
        return (
          <Fragment key={c.id}>
            {SEPARATE_BEFORE.has(c.id) && (m.surface === 'worktree' || c.id === 'path.copy' || c.id === 'project.remove' || (m.surface === 'files' && c.id === 'files.show')) && i > 0 && <div className="msep" role="separator" />}
          <div
            id={`cm-${c.id}`}
            role="menuitem"
            data-danger={DANGER.has(c.id) ? '' : undefined}
            data-command={c.id}
            data-current={i === at ? '' : undefined}
            aria-disabled={off(c, m) || undefined}
            title={why}
            onMouseEnter={() => setAt(i)}
            onClick={() => live.current.run(c)}
          >
            <span className="mt">{c.title}</span>
            {b ? <KeyChip binding={b} bindings={bindings} /> : m.surface === 'worktree' && HINT[c.id] && <span className="kbd">{HINT[c.id]}</span>}
          </div>
          </Fragment>
        );
      })}
    </div>
  );
}
