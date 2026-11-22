// v25f (D-20261108-10): Settings and the Board open in one large modal over the workspace, never as a centre tab. The
// workspace behind keeps its size (no PTY resize) and its active tab; closing gives focus back to where it was.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from '../icons/Icon';
import { composing } from '../keys';
import { useHtmlLangT } from '../i18n/lib/useHtmlLangT';

export type OverlayKind = 'settings' | 'board' | null;

// Per window (sessionStorage, as chrome/windowState.ts keeps its id): a reload keeps the modal that was open.
const KEY = 'nunchiro.overlay';
export const loadOverlay = (): OverlayKind => {
  try {
    const v = sessionStorage.getItem(KEY);
    return v === 'settings' || v === 'board' ? v : null;
  } catch {
    return null;
  }
};
export const saveOverlay = (o: OverlayKind) => {
  try {
    if (o) sessionStorage.setItem(KEY, o);
    else sessionStorage.removeItem(KEY);
  } catch {
    /* storage blocked: a reload opens no modal */
  }
};

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Overlay({ kind, label, onClose, children }: { kind: Exclude<OverlayKind, null>; label: string; onClose: () => void; children: ReactNode }) {
  // Read while rendering, before a child's autoFocus moves focus; kept while the content switches between Settings and Board.
  const t = useHtmlLangT();
  const [from] = useState(() => document.activeElement as HTMLElement | null);
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  // Ticket 991 C22: the workspace behind the modal is out of reach (Tab, VoiceOver) while it is open. Only the window's
  // own regions (cleared before focus goes back, so this effect comes first): a popover above the modal (palette, New tab) is a
  // sibling and stays live, and the status bar stays live as the modal leaves it uncovered (its Undo line, styles.css .ovl).
  useEffect(() => {
    const behind = [...(panel.current?.closest('.win')?.querySelectorAll<HTMLElement>(':scope > .title, :scope > .body') ?? [])];
    behind.forEach((el) => (el.inert = true));
    return () => behind.forEach((el) => (el.inert = false));
  }, []);
  useEffect(() => {
    if (!panel.current?.contains(document.activeElement)) panel.current?.focus();
    // Esc closes only when nothing inside took it: the codebase's inner Esc handlers (card detail, menus, search) call
    // preventDefault or stopPropagation, some on the window after this listener, so the check waits for the dispatch to end.
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || composing(e)) return;
      // Look v11 C NC2 (and v10's teammate form): Esc in a field of an unsaved form (add a note, add a teammate) that
      // holds typed words never closes the sheet and loses them; it only leaves the field, and a second Esc closes. A
      // plain setting saves as it is typed, so Esc there closes the sheet at once (settings.spec's font test).
      const field = document.activeElement;
      if ((field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) && field.value.trim() && field.closest('form') && panel.current?.contains(field)) {
        e.preventDefault();
        field.blur();
        panel.current?.focus();
        return;
      }
      setTimeout(() => e.defaultPrevented || close.current());
    };
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('keydown', esc);
      if (from?.isConnected) from.focus({ preventScroll: true });
    };
  }, []);
  useEffect(() => {
    if (!panel.current?.contains(document.activeElement)) panel.current?.focus();
  }, [kind]);
  // Focus stays in the modal: Tab past the last control comes back to the first, and Shift+Tab the other way.
  // While a Tab step is in flight, `wrap` names where focus goes if the browser's own step still leaves the panel.
  const wrap = useRef<HTMLElement | null>(null);
  useEffect(() => {
    // Synchronous, so no frame ever shows focus outside: WebKit's plain Tab skips buttons, so its step can leave from a
    // control that is not the last one (ticket 521); past the document's end focus goes to no element (focusout, no focusin).
    const back = (e: FocusEvent) => {
      const p = panel.current;
      const to = wrap.current;
      const from = e.target as Node;
      if (!p || !to) return;
      if (e.type === 'focusin') return void (!p.contains(from) && to.focus());
      // A control that closes on Tab removes the focused element (the Board's project picker); the browser's step then goes
      // on from where it was, so only a step that left a still-present control for nowhere is pulled back.
      if (!e.relatedTarget && p.contains(from)) queueMicrotask(() => from.isConnected && !p.contains(document.activeElement) && to.focus());
    };
    document.addEventListener('focusin', back, true);
    document.addEventListener('focusout', back, true);
    return () => {
      document.removeEventListener('focusin', back, true);
      document.removeEventListener('focusout', back, true);
    };
  }, []);
  // Owner 2026-11-16: the panel is as large as the window until the corner grip is dragged; the size is kept per kind.
  // The panel stays centred, so a drag moves both edges (twice the pointer's move keeps the grip under it). A double
  // click on the grip goes back to full size.
  const sizeKey = `nunchiro.overlay.size.${kind}`;
  const [size, setSize] = useState<{ w: number; h: number } | null>(() => {
    try {
      const v = JSON.parse(localStorage.getItem(sizeKey) ?? 'null');
      return v && v.w > 0 && v.h > 0 ? { w: v.w, h: v.h } : null;
    } catch {
      return null;
    }
  });
  const keep = (v: { w: number; h: number } | null) => {
    setSize(v);
    try {
      if (v) localStorage.setItem(sizeKey, JSON.stringify(v));
      else localStorage.removeItem(sizeKey);
    } catch {
      /* storage blocked: the size lasts until the modal closes */
    }
  };
  const grip = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = panel.current!.getBoundingClientRect();
    const [x, y] = [e.clientX, e.clientY];
    e.currentTarget.setPointerCapture(e.pointerId);
    const move = (m: PointerEvent) => keep({ w: Math.max(640, r.width + 2 * (m.clientX - x)), h: Math.max(420, r.height + 2 * (m.clientY - y)) });
    const el = e.currentTarget;
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', () => el.removeEventListener('pointermove', move), { once: true });
  };
  const trap = (e: React.KeyboardEvent) => {
    // Ticket 991 C21: Settings is no document: ⌘A selects all inside a field or a terminal only, never every label.
    if (kind === 'settings' && e.code === 'KeyA' && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && !(e.target as HTMLElement).closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), .xterm')) return e.preventDefault();
    if (e.key !== 'Tab' || e.defaultPrevented) return; // an inner sheet with its own trap took it
    const p = panel.current!;
    // Tab reaches only the checked radio of a group (ticket 519: an unchecked last radio let Tab leave the modal for a tick).
    const skipped = (x: HTMLElement) => x instanceof HTMLInputElement && x.type === 'radio' && !x.checked && !!x.name && !!p.querySelector(`input[type='radio'][name='${CSS.escape(x.name)}']:checked`);
    // A roving group's other items are `tabIndex={-1}` buttons (ticket 521: Usage's Project/Session pair); counting one as
    // the last control let Tab from the real last control leave the modal.
    const all = [...p.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((x) => x.tabIndex >= 0 && x.checkVisibility() && !skipped(x));
    if (!all.length) return e.preventDefault();
    const [first, last] = [all[0], all[all.length - 1]];
    // The edge by document order, not by identity: focus can sit on what the list leaves out (a page title focused by
    // script, a scroll area Chromium makes focusable), and a step from there past the end left the modal (ticket 521).
    const at = document.activeElement ?? document.body;
    const side = e.shiftKey ? Node.DOCUMENT_POSITION_PRECEDING : Node.DOCUMENT_POSITION_FOLLOWING;
    const to = e.shiftKey ? last : first;
    if (!p.contains(at) || !all.some((x) => x !== at && at.compareDocumentPosition(x) & side)) return (e.preventDefault(), to.focus());
    wrap.current = to;
    setTimeout(() => (wrap.current = null));
  };
  return (
    <div className="ovl" data-overlay={kind} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={panel} className="ovl-panel" role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} onKeyDown={trap} style={size ? { flex: 'none', alignSelf: 'center', width: size.w, height: size.h } : undefined}>
        <div className="ovl-head">
          <b>{label}</b>
          <button className="ovl-x" aria-label={t('mw.agents.close', { name: label })} title={t('rest.st.closeEsc')} onClick={onClose}>
            <Icon name="x" size={14} />
          </button>
        </div>
        {/* A section, as the layout zone it sat in before: a page's own header stays out of the banner landmarks. */}
        <section className="ovl-body">{children}</section>
        <div className="ovl-grip" aria-hidden="true" data-sized={size ? '' : undefined} onPointerDown={grip} onDoubleClick={() => keep(null)} />
      </div>
    </div>
  );
}
