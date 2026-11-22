// Terminal copy mode (v1a-42; needs 25, 30): vi-style keyboard selection over the focused xterm's own buffer. Keys match by
// physical code and are swallowed in the capture phase, so none reaches the PTY or a global binding. Output only reads the
// buffer and drives xterm's selection; the copy goes through the clipboard helper.
import { useEffect, useReducer, useRef } from 'react';
import type { Terminal as XTerm } from '@xterm/xterm';
import { terminals } from '../Terminal';
import { copyText } from './clipboard';
import { copyKey, type CopyKey } from '../keys';
import { useHtmlLangT } from '../i18n/lib/useHtmlLangT';

type Cell = { x: number; y: number };
type Kind = 'space' | 'word' | 'punct';

const cellAt = (term: XTerm, { x, y }: Cell) => term.buffer.active.getLine(y)?.getCell(x);

function kindAt(term: XTerm, c: Cell): Kind {
  const cell = cellAt(term, c);
  // The second half of a wide character belongs to the first.
  if (cell && !cell.getChars() && cell.getWidth() === 0 && c.x > 0) return kindAt(term, { x: c.x - 1, y: c.y });
  const ch = cell?.getChars() || ' ';
  return /\s/.test(ch) ? 'space' : /[\p{L}\p{N}_]/u.test(ch) ? 'word' : 'punct';
}

/** The cell after `c` in reading order (a line end flows into the next line), or null at the buffer end. */
function step(term: XTerm, c: Cell, dir: 1 | -1): Cell | null {
  const last = term.buffer.active.length - 1;
  const x = c.x + dir;
  if (x >= 0 && x < term.cols) return { x, y: c.y };
  const y = c.y + dir;
  return y < 0 || y > last ? null : { x: dir > 0 ? 0 : term.cols - 1, y };
}

/** vi `w`, `b`, `e` over small words: runs of letters, digits and `_`, runs of other symbols, and blanks (a line end is blank). */
function word(term: XTerm, from: Cell, key: 'w' | 'b' | 'e'): Cell {
  const dir = key === 'b' ? -1 : 1;
  const kind = (c: Cell) => kindAt(term, c);
  let c = from;
  const next = (p: Cell) => step(term, p, dir);
  if (key === 'w') {
    const k = kind(c);
    // Leave the current run, then skip blanks.
    for (let n = next(c); n && k !== 'space' && kind(n) === k; n = next(c)) c = n;
    let n = next(c);
    while (n && kind(n) === 'space') (c = n), (n = next(c));
    return n ?? c;
  }
  // `e` and `b`: skip blanks ahead, then run to the end (e) or start (b) of the word reached.
  let n = next(c);
  while (n && kind(n) === 'space') (c = n), (n = next(c));
  if (!n) return c;
  c = n;
  const k = kind(c);
  for (n = next(c); n && kind(n) === k; n = next(c)) c = n;
  return c;
}

/** Columns of the first and last cell holding ink on line `y` (a wide character counts at its first cell); 0 on a blank line. */
function inkEnds(term: XTerm, y: number): [number, number] {
  const ink = (x: number) => {
    const c = cellAt(term, { x, y });
    return !!c && c.getWidth() > 0 && /\S/.test(c.getChars());
  };
  const xs = Array.from({ length: term.cols }, (_, x) => x).filter(ink);
  return xs.length ? [xs[0], xs[xs.length - 1]] : [0, 0];
}

/** Where a motion key moves the cursor; null for a key that is not a motion. */
function motion(term: XTerm, at: Cell, k: CopyKey): Cell | null {
  const last = term.buffer.active.length - 1;
  const clampY = (y: number) => Math.max(0, Math.min(last, y));
  const half = Math.max(1, term.rows >> 1);
  const side = (d: 1 | -1) => {
    let x = Math.max(0, Math.min(term.cols - 1, at.x + d));
    if (x !== at.x && cellAt(term, { x, y: at.y })?.getWidth() === 0) x = Math.max(0, Math.min(term.cols - 1, x + d));
    return { ...at, x };
  };
  switch (k) {
    case 'half-up': return { ...at, y: clampY(at.y - half) };
    case 'half-down': return { ...at, y: clampY(at.y + half) };
    case 'left': return side(-1);
    case 'right': return side(1);
    case 'up': return { ...at, y: clampY(at.y - 1) };
    case 'down': return { ...at, y: clampY(at.y + 1) };
    case 'line-start': return { ...at, x: 0 };
    case 'first': return { ...at, x: inkEnds(term, at.y)[0] };
    case 'line-end': return { ...at, x: inkEnds(term, at.y)[1] };
    case 'bottom': return { ...at, y: last };
    case 'w': case 'b': case 'e': return word(term, at, k);
  }
  return null;
}

export function CopyMode({ id, onDone, onCopied, onSink }: { id: string; onDone: () => void; onCopied: (ok: boolean) => void; onSink: () => void }) {
  const term = terminals.get(id);
  const t = useHtmlLangT();
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const buf = term?.buffer.active;
  // Buffer coordinates, so output arriving later does not move the cursor. shortcut: scrollback trimming shifts them, a rare edge at thousands of lines.
  const at = useRef<Cell>({ x: buf?.cursorX ?? 0, y: (buf?.baseY ?? 0) + (buf?.cursorY ?? 0) });
  const anchor = useRef<{ cell: Cell; lines: boolean } | null>(null);
  const pendingG = useRef(false);

  useEffect(() => {
    if (!term) return onDone();
    const show = () => {
      const { y } = at.current;
      const top = term.buffer.active.viewportY;
      if (y < top) term.scrollToLine(y);
      else if (y >= top + term.rows) term.scrollToLine(y - term.rows + 1);
      const a = anchor.current;
      if (!a) term.clearSelection();
      else if (a.lines) term.selectLines(Math.min(a.cell.y, y), Math.max(a.cell.y, y));
      else {
        const [s, e] = a.cell.y < y || (a.cell.y === y && a.cell.x <= at.current.x) ? [a.cell, at.current] : [at.current, a.cell];
        term.select(s.x, s.y, (e.y - s.y) * term.cols + e.x - s.x + 1);
      }
      redraw();
    };
    const leave = () => onDone();
    const onKey = (e: KeyboardEvent) => {
      // A key with ⌘ belongs to the system or the window. Composing keys are the mode's too (pane mode's rule): no byte reaches the PTY.
      if (e.metaKey || ['Shift', 'Control', 'Alt', 'Meta'].some((m) => e.code.startsWith(m))) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.altKey) return; // swallowed too: xterm would send it to the PTY as ESC-prefixed bytes
      const g = pendingG.current;
      pendingG.current = false;
      const k = copyKey(e.code, e.shiftKey, e.ctrlKey);
      if (k === 'leave') return leave();
      if (k === 'copy') {
        if (!term.hasSelection()) return;
        void copyText(term.getSelection()).then(onCopied);
        return leave();
      }
      if (k === 'g') {
        if (!g) return void (pendingG.current = true);
        at.current = { ...at.current, y: 0 };
        return show();
      }
      if (k === 'select' || k === 'select-lines') {
        const lines = k === 'select-lines';
        const a = anchor.current;
        anchor.current = a && a.lines === lines ? null : { cell: a?.cell ?? at.current, lines };
        return show();
      }
      const to = k && motion(term, at.current, k);
      if (!to) return;
      at.current = to;
      show();
    };
    // The terminal's own input must not hold focus: an IME commits text there, and xterm would send it to the PTY.
    const refocus = (e: FocusEvent) => term.element?.contains(e.target as Node) && onSink();
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', leave);
    document.addEventListener('focusin', refocus);
    // Redraw only when the view moves (output that scrolls it, a resize); a key redraws through show().
    const subs = [term.onScroll(redraw), term.onResize(redraw)];
    // Belt and braces with the focus pull-back above: xterm sends no key, composition or paste to the PTY while stdin is off.
    // Set last, so a throw earlier in this setup (no cleanup registered) cannot leave stdin off.
    const stdin = term.options.disableStdin;
    term.options.disableStdin = true;
    return () => {
      // Every way out (a key, blur, another tab shown) unmounts the mode: none leaves its selection drawn.
      term.clearSelection();
      term.options.disableStdin = stdin;
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', leave);
      document.removeEventListener('focusin', refocus);
      for (const s of subs) s.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const screen = term?.element?.querySelector('.xterm-screen')?.getBoundingClientRect();
  const row = at.current.y - (term?.buffer.active.viewportY ?? 0);
  const inView = !!screen && !!term && row >= 0 && row < term.rows;
  return (
    <div className="copy-layer" data-cursor={`${at.current.x},${at.current.y}`}>
      {inView && (
        <span
          className="copy-cursor"
          style={{ left: screen.left + (at.current.x * screen.width) / term.cols, top: screen.top + (row * screen.height) / term.rows, width: screen.width / term.cols, height: screen.height / term.rows }}
        />
      )}
      <div className="copy-status glass" role="status" aria-live="polite">{t('rest.st.copyStatus')}</div>
    </div>
  );
}
