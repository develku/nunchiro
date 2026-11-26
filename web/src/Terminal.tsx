// One xterm.js per session tab that is on screen or was a moment ago. A tab never shown has none, and a tab hidden for
// 30 s (warm.ts) drops its xterm and its watch: the core keeps the full log and showing the tab again replays it from byte 0
// (reattach), so only the window's copy (scrollback buffers, parser state) is released. Memory ticket light-2.
import { composerText, setDirect, toComposer, useDirect } from './terminal/direct';
import { useEffect, useRef, useState } from 'react';
import { Terminal as XTerm, type IMarker, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import '@xterm/xterm/css/xterm.css';
import type { CoreClient } from './api';
import type { AgentKind } from './types';
import { useWarm } from './warm';
import type { Osc52 } from './settings';
import { copyText, osc52Write } from './terminal/clipboard';
import { linkHandler, linkProvider } from './terminal/links';
import { FindBar, FIND_EVENT } from './terminal/search';
import { writers, type Writer } from './terminal/writer';
import { FONTS_EVENT } from './settings/appearance/serve';
import { useFeatureSetting } from './settings/useFeatureSetting';
import { TERM_PREFS } from './features/terminal';
import { addons, cursorTheme, optionIsMeta, xtermOptions } from './terminal/options';
import { useHtmlLangT } from './i18n/lib/useHtmlLangT';

export const terminals = new Map<string, XTerm>();
/** Sessions whose terminal takes the focus when it opens, though it is not mounted yet (a split's shell waits for the snapshot). */
export const focusAtOpen = new Set<string>();
/** Bracketed-paste mode of a session whose xterm was dropped (a pinned composer can aim at a cold tab); false until one was seen. */
const pasteMode = new Map<string, boolean>();
/** The ligatures addon failed to load once (logged then): later terminals stay quiet. */
let ligaturesFailed = false;

/** Whether text sent to this session should be bracketed (DECSET 2004). A tab never shown has no xterm: read the mode off the core's replay buffer. */
export async function bracketedPaste(core: CoreClient, id: string): Promise<boolean> {
  const term = terminals.get(id);
  if (term) return term.modes.bracketedPasteMode;
  try {
    const r = (await core.request({ op: 'read', id, after: 0 })) as { data: number[] };
    const text = new TextDecoder('latin1').decode(Uint8Array.from(r.data));
    let mode = pasteMode.get(id) ?? false;
    for (const m of text.matchAll(/\x1b\[\?([\d;]*)([hl])/g)) if (m[1].split(';').includes('2004')) mode = m[2] === 'h';
    return mode;
  } catch {
    return pasteMode.get(id) ?? false;
  }
}

/** Ticket 413: where the shell's current prompt starts, from its OSC 133 marks (A: prompt start, B: input start, C or D:
 *  output); none while a command runs, or when the shell sends no marks. */
const promptStart = new WeakMap<XTerm, IMarker>();
/** Ticket 991 A11: terminals drawing a replay at REPLAY_COLS (the core opens a PTY at 160 columns; a wide window can be wider). */
const wide = new WeakSet<XTerm>();
const REPLAY_COLS = 300;
/** Q4: a terminal cell's CSS size per font set-up, from the last terminal that opened with it. Knowing it, the next terminal
 *  starts at its final rows and parses its replay before it opens, so opening one draws once (no empty draw, no draw at
 *  REPLAY_COLS and refit after it). */
const cells = new Map<string, { width: number; height: number }>();
/** How long an unopened terminal waits for its replay (a refused watch gets none) before it opens empty. */
const REPLAY_WAIT_MS = 1000;

/** Ticket 413: fits the terminal to its box. Before the grid's width changes, a prompt the shell marked (OSC 133) is
 *  erased from its first row down, and the shell redraws it on SIGWINCH from the prompt row it counted. Reflow would
 *  otherwise change the prompt's row count under the shell: narrowing splits a prompt row that fills the width
 *  (starship's $fill, a right prompt) in two and leaves the extra row on screen; widening joins a prompt that wrapped
 *  (oh-my-posh pads it once for the old width) and the shell, moving up by the rows it drew, redraws over the output
 *  line above (look 1117 v11 A S2-1). Ghostty does the same on every resize (libghostty-vt Screen.zig
 *  clearPromptForRedraw). Without marks: a plain fit. */
function fitPrompt(term: XTerm, addon: FitAddon, live: boolean) {
  if (wide.has(term)) return; // a replay is being drawn wide (A11): fitted when it ends
  const next = addon.proposeDimensions();
  const refit = () => {
    try {
      addon.fit();
    } catch {
      // Hidden or zero-sized since: refit on the next resize.
    }
  };
  // Look 1117 v11 A S3-13: a terminal with no live shell behind it (an ended shell's read-only view) gets no redraw, so its
  // prompt is never erased: it is only reflowed.
  if (!live || !next || !clearPrompt(term, next.cols, refit)) addon.fit();
}
/** Erases the marked prompt before the grid goes to `cols` wide, then calls `then`; false (and no call) when there is
 *  nothing to erase. */
function clearPrompt(term: XTerm, cols: number, then: () => void) {
  const b = term.buffer.active;
  const y = b.baseY + b.cursorY;
  const start = promptStart.get(term)?.line ?? -1;
  // Rows above the viewport cannot be reached by a cursor move: that prompt is left to reflow.
  if (cols === term.cols || b.type !== 'normal' || start < b.baseY || start > y) return false;
  // Relative moves only: DECSC would overwrite a cursor the program saved itself.
  const k = y - start;
  const up = k ? `\x1b[${k}A` : '';
  const down = k ? `\x1b[${k}B` : '';
  term.write(`${up}\r\x1b[J${down}\x1b[${b.cursorX + 1}G`, then);
  return true;
}
const SIZE_MARK = /\x1b\[8;(\d+);(\d+)t/;
/** Look 1117 v12 A S2-A: the holder puts each PTY size change into the output as XTWINOPS 8 (CSI 8;rows;cols t) before
 *  the bytes drawn at it. The shell's SIGWINCH redraws move up by rows counted at their width: replayed at one width,
 *  they erased output above the prompt. Each part is drawn at its size, the prompt erased before each width change as
 *  fitPrompt does live; `done` once all is parsed. */
function replaySized(term: XTerm, text: string, write: (text: string, done: () => void) => void, done: () => void) {
  const parts = text.split(SIZE_MARK);
  const next = (i: number): void =>
    write(parts[i], () => {
      if (i + 3 > parts.length) return done();
      const [rows, cols] = [Number(parts[i + 1]), Number(parts[i + 2])];
      // Codex look of wave 19 (MUST): a program's own output can carry the same sequence, so a size no window has is
      // ignored (a 1000000 x 1000000 grid would be allocated); a plausible one only redraws that program's own replay.
      if (!(cols >= 2 && cols <= 1000 && rows >= 1 && rows <= 500)) return next(i + 3);
      const resize = () => (term.resize(cols, rows), next(i + 3));
      if (!clearPrompt(term, cols, resize)) resize();
    });
  next(0);
}

interface Props {
  core: CoreClient;
  id: string;
  active: boolean;
  fontSize: number;
  fontFamily: string;
  theme: ITheme;
  connected: boolean;
  /** v1a-35: the session's name for the OSC 52 prompt, and the two terminal settings. */
  name: string;
  /** V1A-58: with the name, the terminal's accessible name. */
  kind: AgentKind;
  copyOnSelect: boolean;
  osc52: Osc52;
  /** Ticket 1115 step 2: a read-only look (the Team board's drawer). It never sizes the PTY, so a peek never redraws the
   *  agent's screen: the grid takes the PTY's own sizes from the holder's marks and the box scrolls. No keys reach the
   *  session, and the session's tab keeps its place in \`terminals\`. */
  peek?: boolean;
  /** The agent's input box is on its screen and nothing asks (the core's `at_box`): letters go to the composer then. */
  atBox?: boolean;
  /** A session on another Mac: its terminal sends every key, as before (no Type in terminal there yet). */
  remote?: boolean;
}

export function TerminalView({ core, id, active, fontSize, fontFamily, theme, connected, name, kind, copyOnSelect, osc52, peek = false, atBox = false, remote = false }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const words = useHtmlLangT(); // ticket 492
  // Type in terminal (terminal/direct.ts): a Claude or Codex terminal sends its letters to the composer unless it is on.
  const agentBox = !peek && !remote && (kind === 'claude' || kind === 'codex');
  const direct = useDirect(id);
  const route = useRef({ agentBox, direct, atBox, noted: false });
  route.current = { ...route.current, agentBox, direct, atBox };
  const [note, setNote] = useState(false);
  const fit = useRef<FitAddon | null>(null);
  const own = useRef<XTerm | null>(null);
  const writer = useRef<Writer | null>(null);
  const warm = useWarm(active);
  // Ticket 251: Settings > Terminal, Input and Look; every value applies to the live terminal below.
  const [tp] = useFeatureSetting(TERM_PREFS);
  // v1a-35: read by the xterm's handlers, which outlive a render.
  const prefs = useRef({ copyOnSelect, osc52, tp });
  prefs.current = { copyOnSelect, osc52, tp };
  const live = useRef(connected);
  live.current = connected;
  /** The Option key last pressed, for Option as Meta on one side only. */
  const side = useRef<'left' | 'right' | null>(null);
  const [renderer, setRenderer] = useState<'dom' | 'webgl'>('dom');
  /** The xterm is open in the box (Q4: it may parse its replay first); the effects below act on it from then. */
  const [ready, setReady] = useState(false);
  const [search, setSearch] = useState<{ term: XTerm; addon: SearchAddon } | null>(null);
  const [findNonce, setFindNonce] = useState(0);
  const [ask, setAsk] = useState<{ text: string; bytes: number } | null>(null);

  useEffect(() => {
    if (!warm) return;
    const el = host.current!;
    const cellKey = `${fontFamily}|${fontSize}|${window.devicePixelRatio}|${JSON.stringify(xtermOptions(tp))}`;
    const cell = cells.get(cellKey);
    // Q4: the rows FitAddon would propose, from the box's height and the known cell (a hidden box has none: open now).
    const boxRows = cell ? Math.floor(parseFloat(getComputedStyle(el).height) / cell.height) : 0;
    const late = !peek && boxRows > 1;
    const term = new XTerm({
      ...xtermOptions(tp),
      fontFamily,
      fontSize,
      lineHeight: 1.2,
      disableStdin: !connected || peek,
      allowProposedApi: true,
      theme: cursorTheme(theme, tp.cursorOpacity),
      linkHandler,
      ...(late ? { cols: REPLAY_COLS, rows: boxRows } : {}),
    });
    const addon = new FitAddon();
    term.loadAddon(addon);
    const finder = new SearchAddon();
    term.loadAddon(finder);
    const links = term.registerLinkProvider(linkProvider(term, id));
    // Registered at once, as before Q4: commands and the copy mode find the session's xterm while its replay is parsed.
    fit.current = addon;
    own.current = term;
    if (!peek) terminals.set(id, term);
    // The replay of a late terminal is parsed at REPLAY_COLS (A11) and reflowed by the one fit when it opens.
    if (late) wide.add(term);
    // Look 1117 A S2-2: the PTY learns the box's size before the replay is parsed, not after it. A shell started for a split
    // opens at the window's last size (the tab's, wider): its prompt drawn there was reflowed into the split and redrawn
    // below a copy. The same sum as FitAddon's proposeDimensions, so the fit at open keeps it (an equal size is no SIGWINCH).
    // Ticket 995 (v12-C-V10): sent once the replay is in, so the shell's redraw for it is never in the replay: it comes
    // after, is held until the open fit erased the prompt drawn at the old width (`held` below), and replaces it in place.
    const earlyResize = () => late && cell && void core.resize(id, Math.floor((parseInt(getComputedStyle(el).width) - (term.options.scrollback === 0 ? 0 : 14)) / cell.width), boxRows).catch(() => {});
    let held: { text: string; parsed: () => void }[] | null = null;
    /** Ticket 995: the replay carries the PTY's sizes (a holder that marks its first output's size), so the grid ends at
     *  the PTY's own size: a prompt erased at the open fit is redrawn only when the early resize changes it. */
    let sized = false;
    let opened = false;
    let gone = false;
    // A focus asked for before the terminal is open (it opens once its replay is in) is given at open, unless the focus
    // moved since the ask: an unopened xterm has nothing to focus, so the ask was lost (agent-pane pane_keys).
    const focusNow = term.focus.bind(term);
    let wanted: { from: Element | null } | null = focusAtOpen.delete(id) ? { from: document.activeElement } : null;
    term.focus = () => (opened ? focusNow() : void (wanted = { from: document.activeElement }));
    // A press on the box before it opens is such an ask too: on WebKit a click just after the pane showed focused the pane,
    // and the keys typed next went nowhere. Asked after the press's own focus move, so a later move elsewhere still wins.
    const pressEarly = () => void (opened || setTimeout(() => term.focus()));
    el.addEventListener('mousedown', pressEarly);
    const openNow = () => {
      if (opened || gone) return;
      opened = true;
      clearTimeout(waiting);
      term.open(el);
      if (wanted && (document.activeElement === wanted.from || document.activeElement === document.body)) focusNow();
      setSearch({ term, addon: finder });
      setReady(true);
      if (late && wide.delete(term)) {
        const was = `${term.cols}x${term.rows}`;
        const refit = () => {
          try {
            addon.fit();
          } catch {
            // Hidden or zero-sized since: refit on the next resize.
          }
          // The PTY learns the window's size even when the fit kept the grid's (onResize then did not fire).
          if (`${term.cols}x${term.rows}` === was) void core.resize(id, term.cols, term.rows).catch(() => {});
        };
        // Ticket 995: a live shell redraws its marked prompt for the box's size (the early resize), so it is erased as
        // fitPrompt does. Not after an unsized replay (an older holder): the grid's width is not the PTY's, and a resize
        // that keeps the PTY's size brings no redraw. An ended shell's prompt is only reflowed.
        const next = live.current && sized ? addon.proposeDimensions() : undefined;
        if (!next || !clearPrompt(term, next.cols, refit)) refit();
      }
      // Private like FitAddon's own read: the cell size the next terminal with this font starts from.
      const css = (term as unknown as { _core: { _renderService: { dimensions: { css: { cell: { width: number; height: number } } } } } })._core._renderService.dimensions.css.cell;
      if (css.width > 0 && css.height > 0) cells.set(cellKey, { width: css.width, height: css.height });
    };
    const waiting = late ? setTimeout(openNow, REPLAY_WAIT_MS) : undefined;
    if (!late) openNow();
    // The core answers DSR 6n, DA1 and DA2 for every PTY (pty.rs), so the window never does. Other queries
    // (OSC 11 colour, DECRQM, XTVERSION, window reports) only xterm.js can answer: it does on live output,
    // but not while replaying, or a reattach would send old answers as typed input.
    let replaying = false;
    const coreAnswers = (params: (number | number[])[]) => (params[0] ?? 0) === 6;
    const csi: [Parameters<typeof term.parser.registerCsiHandler>[0], (p: (number | number[])[]) => boolean][] = [
      [{ final: 'n' }, (p) => coreAnswers(p) || replaying],
      [{ prefix: '?', final: 'n' }, () => replaying],
      [{ final: 'c' }, () => true],
      [{ prefix: '>', final: 'c' }, () => true],
      [{ prefix: '=', final: 'c' }, () => replaying],
      [{ final: 't' }, () => replaying],
      [{ intermediates: '$', final: 'p' }, () => replaying],
      [{ prefix: '?', intermediates: '$', final: 'p' }, () => replaying],
      [{ prefix: '>', final: 'q' }, () => replaying],
    ];
    for (const [fn, swallow] of csi) term.parser.registerCsiHandler(fn, swallow);
    for (const osc of [4, 10, 11, 12]) term.parser.registerOscHandler(osc, (d) => replaying && d.split(';').includes('?'));
    // Ticket 413: the prompt's marks. A prompt that asks not to be redrawn (Kitty's redraw=0) is never erased.
    term.parser.registerOscHandler(133, (d) => {
      const [kind, ...params] = d.split(';');
      if (kind !== 'A' && kind !== 'C' && kind !== 'D') return true;
      promptStart.get(term)?.dispose();
      promptStart.delete(term);
      const at = kind === 'A' && !params.includes('redraw=0') ? term.registerMarker(0) : undefined;
      if (at) promptStart.set(term, at);
      return true;
    });
    // OSC 52 is always swallowed: a read is never answered, a replayed write never copies, a live one per Settings.
    term.parser.registerOscHandler(52, (d) => {
      const w = replaying ? null : osc52Write(d);
      if (w && prefs.current.osc52 === 'allow') void copyText(w.text);
      // The first pending request stays: a later write cannot swap the payload under the prompt before the click.
      else if (w && prefs.current.osc52 === 'ask') setAsk((cur) => cur ?? w);
      return true;
    });
    // Copy on select: a drag that started on this terminal (not the find bar or prompt), on mouse-up (possibly outside it).
    let dragging = false;
    const down = (e: MouseEvent) => (dragging = !!term.element?.contains(e.target as Node));
    const up = () => {
      if (dragging && prefs.current.copyOnSelect && term.hasSelection()) void copyText(term.getSelection());
      dragging = false;
    };
    el.addEventListener('mousedown', down);
    window.addEventListener('mouseup', up);
    // Ticket 251 Input. Hiding the pointer and the focus-follows-mouse gates after Orca (terminal-pane/mouse-hide-while-typing.ts,
    // lib/pane-manager/focus-follows-mouse.ts), MIT License, Copyright (c) 2026 Lovecast Inc.
    // Option as Meta on one side: xterm reads the option per key, so the Option key pressed sets it.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type === 'keydown' && (e.code === 'AltLeft' || e.code === 'AltRight')) {
        side.current = e.code === 'AltLeft' ? 'left' : 'right';
        term.options.macOptionIsMeta = optionIsMeta(prefs.current.tp.optionMeta, side.current);
      }
      return true;
    });
    // A full-screen app that tracks the mouse gets one report per wheel event: send the extra ones as copies.
    const copies = new WeakSet<WheelEvent>();
    term.attachCustomWheelEventHandler((e) => {
      const n = prefs.current.tp.tuiScroll;
      if (n > 1 && term.modes.mouseTrackingMode !== 'none' && !copies.has(e) && !e.shiftKey && e.deltaY !== 0) {
        for (let i = 1; i < n; i++) {
          const c = new WheelEvent(e.type, e);
          copies.add(c);
          e.target?.dispatchEvent(c);
        }
      }
      return true;
    });
    // Right-click pastes (it never opens the app's menu on a terminal: menu/ContextMenu.tsx NATIVE). Read on the
    // button's press: WebKit lets a mousedown read the clipboard, not a contextmenu event.
    const pasting = (e: MouseEvent) => prefs.current.tp.rightClickPaste && !!term.element?.contains(e.target as Node);
    const press = (e: MouseEvent) => {
      if (e.button === 2 && pasting(e)) void navigator.clipboard?.readText().then((text) => text && term.paste(text), () => {});
    };
    const context = (e: MouseEvent) => pasting(e) && e.preventDefault();
    // Focus follows the mouse from one terminal to another only: never out of the Composer or any other field, never
    // mid-drag (a selection), nor while another app has the window's focus (Orca's gates).
    const hover = (e: MouseEvent) => {
      if (term.element) term.element.style.cursor = '';
      const from = document.activeElement;
      if (prefs.current.tp.focusFollowsMouse && e.buttons === 0 && document.hasFocus() && from !== term.textarea && from?.classList.contains('xterm-helper-textarea')) term.focus();
    };
    el.addEventListener('mousedown', press);
    el.addEventListener('contextmenu', context);
    el.addEventListener('mousemove', hover);
    // Hide the pointer while typing, until the mouse moves (hover above shows it).
    const typed = term.onData(() => {
      if (prefs.current.tp.hidePointer && term.element) term.element.style.cursor = 'none';
    });
    // V1A-51: output reaches xterm a frame's share at a time (terminal/writer.ts); a keystroke lets its echo through at once.
    const out = writers.add(term);
    out.active(active);
    writer.current = out;
    // Keystrokes, IME commits and pastes all arrive here once; the core writes them to this PTY only.
    const input = term.onData((d) => {
      if (peek) return;
      const r = route.current;
      const text = r.agentBox && !r.direct && r.atBox ? composerText(d) : null;
      if (text !== null) {
        // Letters and pastes go to the session's composer; keys (Esc, arrows, Enter, Ctrl+C) still reach the agent.
        toComposer(id, text);
        if (!r.noted) (r.noted = true, setNote(true), window.setTimeout(() => setNote(false), 4000));
        return;
      }
      out.key();
      void core.sendText(id, d).catch(() => {});
    });
    const resize = term.onResize(({ cols, rows }) => !wide.has(term) && !peek && void core.resize(id, cols, rows).catch(() => {}));
    const decoder = new TextDecoder();
    // V1A-53: `parsed` acks the frame to the core once xterm parsed it; the core holds output this window has not.
    const unwatch = core.watch(id, (o, parsed) => {
      let data = o.data;
      if (o.truncated && o.start > 0) {
        // The 1 MiB replay cut can land inside an escape sequence: resume at the next line.
        const nl = data.indexOf(0x0a);
        data = nl < 0 ? data.subarray(data.length) : data.subarray(nl + 1);
        // V1A-53: the bytes before the jump can end inside an escape sequence or a UTF-8 character: CAN returns xterm's
        // parser to ground (an open OSC or DCS is dropped, not run), and the decoder drops its partial character.
        decoder.decode();
        out.write('\x18\r\n[earlier output trimmed]\r\n');
      }
      const text = decoder.decode(data, { stream: true });
      if (held && !o.replay) return void held.push({ text, parsed });
      // A peek follows the PTY's size changes (the holder's marks) instead of its box.
      if (!o.replay && opened) return peek && SIZE_MARK.test(text) ? replaySized(term, text, (t, d) => out.write(t, d), parsed) : out.write(text, parsed);
      replaying = o.replay;
      // Q4: the first replay of a late terminal goes to xterm at once (nothing is queued before it) and opens it once parsed.
      if (!opened) {
        earlyResize();
        // Look 1117 v4f A S2-2 (lane w74): a shell that has printed nothing yet. The PTY has the box's size from here, and
        // the first output opens the terminal as a replay does (it may be drawn at the old width still: the shell raced
        // the resize). Being live, its queries are answered (`replaying` stays false).
        if (!text) return parsed();
        held ??= [];
        sized = SIZE_MARK.test(text);
        replaySized(term, text, (t, d) => term.write(t, d), () => {
          replaying = false;
          openNow();
          parsed();
          // Queued behind the open fit's erase.
          const rest = held ?? [];
          held = null;
          for (const f of rest) out.write(f.text, f.parsed);
        });
        return;
      }
      // Ticket 991 A11: the bytes were drawn at widths up to the core's 160 columns or a wider window. Replayed narrower,
      // zsh's PROMPT_SP filler ("%", spaces to the edge, CR) wraps and leaves the "%" on a row of its own. The grid is
      // widened for the replay (the PTY is not told) and fitted back after, which reflows the rows as any narrowing does.
      // Wide in any case: the sizes the replay passes through are not the PTY's to learn.
      wide.add(term);
      if (term.cols < REPLAY_COLS) term.resize(REPLAY_COLS, term.rows);
      // Q9 en-a-J7-1: live output waits for the sized replay's last part, as in the first replay above.
      held ??= [];
      replaySized(term, text, (t, d) => out.write(t, d), () => {
        replaying = false;
        // A peek keeps the replay's last marked size (the PTY's); with no mark it fits the grid alone (no resize is sent).
        if (wide.delete(term) && !(peek && SIZE_MARK.test(text))) {
          try {
            addon.fit();
          } catch {
            // Hidden or zero-sized: refit on the next resize.
          }
        }
        parsed();
        const rest = held ?? [];
        held = null;
        for (const f of rest) out.write(f.text, f.parsed);
      });
    });
    return () => {
      gone = true;
      clearTimeout(waiting);
      setReady(false);
      el.removeEventListener('mousedown', down);
      el.removeEventListener('mousedown', pressEarly);
      window.removeEventListener('mouseup', up);
      el.removeEventListener('mousedown', press);
      el.removeEventListener('contextmenu', context);
      el.removeEventListener('mousemove', hover);
      typed.dispose();
      links.dispose();
      setSearch(null);
      setFindNonce(0);
      setAsk(null);
      unwatch();
      out.dispose();
      writer.current = null;
      input.dispose();
      resize.dispose();
      pasteMode.set(id, term.modes.bracketedPasteMode);
      // A pinned twin of the same session may have registered after this one: only remove our own entry.
      if (terminals.get(id) === term) terminals.delete(id);
      term.dispose();
    };
    // Font, theme and connected changes are applied below without recreating the terminal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [core, id, warm]);

  // A peek is not in `terminals` (the session's tab keeps that place): its effects act on its own xterm, never the tab's.
  const mine = () => (peek ? own.current : terminals.get(id));

  useEffect(() => writer.current?.active(active), [active, warm]);

  useEffect(() => {
    const term = mine();
    if (term) term.options.fontSize = fontSize;
  }, [id, fontSize, ready]);

  useEffect(() => {
    const term = mine();
    if (term) term.options.fontFamily = fontFamily;
  }, [id, fontFamily, ready]);

  // A renamed session renames its terminal for screen readers too.
  useEffect(() => {
    mine()?.textarea?.setAttribute('aria-label', `Terminal: ${name} (${kind})`);
  }, [id, name, kind, ready]);

  // A theme change recolours the live terminal: no recreate, no replay.
  useEffect(() => {
    const term = mine();
    if (term) term.options.theme = cursorTheme(theme, tp.cursorOpacity);
  }, [id, theme, tp.cursorOpacity, ready]);

  // Ticket 251: an Input or Look change reaches the live terminal; only the options that changed are set.
  useEffect(() => {
    const term = mine();
    if (!term) return;
    const opts = term.options as Record<string, unknown>;
    for (const [k, v] of Object.entries(xtermOptions(tp, side.current))) if (opts[k] !== v) opts[k] = v;
  }, [id, tp, ready]);

  const want = addons(tp);
  // WebGL renderer, loaded on demand; a lost GPU context drops it and xterm draws with its DOM renderer again.
  useEffect(() => {
    const term = mine();
    if (!term || !want.webgl || !ready) return; // an addon loads into an open xterm
    let gone = false;
    let gl: { dispose(): void } | null = null;
    const drop = () => {
      gl?.dispose();
      gl = null;
      setRenderer('dom');
    };
    void import('@xterm/addon-webgl')
      .then(({ WebglAddon }) => {
        if (gone) return;
        const a = new WebglAddon();
        a.onContextLoss(drop);
        term.loadAddon(a); // throws without WebGL 2: the DOM renderer stays
        gl = a;
        setRenderer('webgl');
      })
      .catch(() => {});
    return () => {
      gone = true;
      drop();
    };
  }, [id, want.webgl, ready]);

  // Ligatures: the addon reads the font's own table where the browser can (Local Font Access), else its common set.
  useEffect(() => {
    const term = mine();
    if (!term || !want.ligatures || !ready) return; // an addon loads into an open xterm
    let gone = false;
    let lig: { dispose(): void } | null = null;
    void import('@xterm/addon-ligatures')
      .then(({ LigaturesAddon }) => {
        if (gone) return;
        const a = new LigaturesAddon();
        term.loadAddon(a);
        lig = a;
      })
      // The setting stays harmless (the text draws unjoined); say why once, not once per terminal.
      .catch((e: unknown) => ligaturesFailed ||= (console.warn('Terminal ligatures are off: the addon did not load.', e), true));
    return () => {
      gone = true;
      lig?.dispose();
    };
  }, [id, want.ligatures, ready]);

  // Without the core, keys would go nowhere: say so instead of dropping them.
  useEffect(() => {
    const term = mine();
    if (term && !peek) term.options.disableStdin = !connected;
  }, [id, connected, ready, peek]);

  // V1A-67: a face the app serves loads after the terminal measured its fallback; setting fontFamily is what makes
  // xterm measure again (an equal value is ignored, hence the two steps), then the active terminal refits.
  useEffect(() => {
    const remeasure = () => {
      const term = mine();
      if (!term) return;
      term.options.fontFamily = `${fontFamily} `;
      term.options.fontFamily = fontFamily;
      try {
        if (active && !peek && own.current && fit.current) fitPrompt(own.current, fit.current, live.current);
      } catch {
        // Hidden or zero-sized: refit on the next resize.
      }
    };
    window.addEventListener(FONTS_EVENT, remeasure);
    return () => window.removeEventListener(FONTS_EVENT, remeasure);
  }, [id, fontFamily, active, ready, peek]);

  useEffect(() => {
    if (!active || peek) return;
    const refit = () => {
      try {
        if (own.current && fit.current) fitPrompt(own.current, fit.current, live.current);
      } catch {
        // Hidden or zero-sized: refit on the next resize.
      }
    };
    refit();
    // One fit per frame, on the layout the frame ends with: inside a frame the box can pass through a size another
    // observer is about to correct (SidePane's --pane-room: the composer card wraps its chips until it is set again), and
    // every fitted size is a SIGWINCH for the program (an agent re-files its prompt under a new id).
    let frame = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(refit);
    });
    ro.observe(host.current!);
    return () => (cancelAnimationFrame(frame), ro.disconnect());
  }, [active, fontSize, fontFamily, tp.fontWeight, tp.boldWeight, ready, peek]);

  useEffect(() => {
    if (osc52 !== 'ask') setAsk(null);
  }, [osc52]);

  useEffect(() => {
    if (!active || peek) return; // Find for this session opens in its tab, not in a peek too
    const on = (e: Event) => (e as CustomEvent<string>).detail === id && setFindNonce((n) => n + 1);
    window.addEventListener(FIND_EVENT, on);
    return () => window.removeEventListener(FIND_EVENT, on);
  }, [id, active, peek]);

  return (
    <div
      className="term"
      ref={host}
      hidden={!active}
      data-session={id}
      data-peek={peek || undefined}
      data-renderer={renderer}
      data-direct={direct || undefined}
      style={{ paddingLeft: tp.padLeft, paddingTop: tp.padTop }}
      onFocus={() => (route.current.noted = false)}
      onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setDirect(core, id, false)}
    >
      {agentBox && connected && (
        <button
          type="button"
          className="tdir-btn"
          aria-pressed={direct}
          title={words(direct ? 'direct.doneTip' : 'direct.onTip')}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => (setDirect(core, id, !direct), own.current?.focus())}
        >
          {words(direct ? 'direct.done' : 'direct.on')}
        </button>
      )}
      {agentBox && direct && (
        <p className="tdir-line" role="status">
          {words('direct.line')}
        </p>
      )}
      {agentBox && !direct && note && (
        <p className="tdir-line" role="status">
          {words('direct.note')}
        </p>
      )}
      {search && findNonce > 0 && <FindBar term={search.term} search={search.addon} nonce={findNonce} onClose={() => setFindNonce(0)} />}
      {/* Never focused on arrival, so a key typed into the terminal cannot press Copy; the text is never shown. */}
      {ask && (
        <div className="osc52 glass light-you light-edge" role="group" aria-label={words('mw.clip.label')}>
          <span aria-live="polite">
            {words(ask.bytes === 1 ? 'mw.clip.ask.one' : 'mw.clip.ask.other', { name, n: ask.bytes })}
          </span>
          <button className="btn p" onClick={() => (void copyText(ask.text), setAsk(null))}>
            {words('mw.copy')}
          </button>
          <button className="btn" onClick={() => setAsk(null)}>
            {words('mw.dismiss')}
          </button>
        </div>
      )}
      {!connected && (
        <div className="offline" role="status">
          {words('mw.term.paused')}
        </div>
      )}
    </div>
  );
}
