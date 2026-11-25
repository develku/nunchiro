// AGENTVIEW: the right side pane of an agent session tab. Tabs, in order: this session's PTY (not closable), extra shells
// (closable), `+ Shell`, Browser (V2.5-19: the native view), Preview. Diff and Artifacts stay right-bar widgets.
import { agentName } from '../chat/conversation';
import { docT, errorNote, notePlain, type Note } from '../errors';
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { CoreClient } from '../api';
import { Preview } from '../artifacts/Preview';
import type { T } from '../i18n';
import { resizing } from '../layout/resizing';
import { BrowserSpaces } from './browser/view/BrowserView';
import { sessionName } from '../Sidebar';
import { terminals } from '../Terminal';
import { ptyInSplit, useSplits } from '../split/store';
import type { Session } from '../types';
import { CHAT_MIN, FOCUS_FRESH_MS, PANE_MIN, PANE_SHARE, addShell, blocked, clearFocus, isOpen, removeShell, select, setWidth, shellsOf, show, tabKey, tabOf, toggle as paneToggle, usePane, widthKey, type PaneTab } from './store';
import { keepComposerClear } from './composerRoom';
import './pane.css';

interface Props {
  core: CoreClient;
  session: Session;
  all: Session[];
  /** The window's TerminalView for a session id (App owns its settings and theme). */
  term: (id: string, active: boolean) => ReactNode;
  /** Appends text to the composer's draft and focuses it. */
  insert: (text: string) => void;
  /** The window's translator: the pane's plain UI text and its Browser space switcher follow the window language. */
  t: T;
}

/** `+ Shell` / pane.shell.new: a shell session in the agent's own folder (its worktree when it has one) through the
 *  existing start op; it shows in the tree like any shell. Returns an error note, or null. */
export async function startShell(core: CoreClient, session: Session, then?: (shell: string) => void): Promise<Note | null> {
  try {
    const label = `shell ${shellsOf(session.id).length + 1}`;
    const reply = (await core.request({ op: 'start', session: { kind: 'shell', project: session.cwd, label, resume: null } })) as { session?: Session };
    if (reply.session) (show(session.id, 'pty'), addShell(session.id, reply.session.id), then?.(reply.session.id));
    return null;
  } catch (e) {
    return errorNote(docT()('err.note.shellNotStarted', { error: notePlain(docT(), e) }), e);
  }
}

/** The divider's own width beside the chat (5 px, less its two -2 px margins). */
const DIV = 1;
const same = (a: PaneTab, b: PaneTab) => tabKey(a) === tabKey(b);

export function SidePane({ core, session, all, term, insert, t }: Props) {
  const st = usePane();
  // One live view per PTY: the session's PTY shown in a split leaves the pane until that split closes.
  const moved = ptyInSplit(session.id, useSplits());
  const open = isOpen(st, session.id) && session.state === 'running';
  const tab = tabOf(st, session.id);
  const max = !!st.max[session.id];
  const shells = (st.shells[session.id] ?? []).map((id) => all.find((s) => s.id === id)).filter((s): s is Session => !!s && s.kind === 'shell');
  // A shell tab whose session is gone falls back to the PTY.
  const shown: PaneTab = typeof tab !== 'string' && !shells.some((s) => s.id === tab.shell) ? 'pty' : tab;
  const [pick, setPick] = useState<{ text: string; x: number; y: number } | null>(null);
  const body = useRef<HTMLDivElement>(null);
  const [aside, setAside] = useState<HTMLElement | null>(null);
  // Ticket 997 (look v20): a maximised Browser shows the mockup's two rows over the page and nothing else; pane.css hides the session
  // header and the composer while this is set (the page then gets the room and the app fits it only when it must).
  const full = open && max && shown === 'browser';
  useEffect(() => {
    if (!full) return;
    document.documentElement.setAttribute('data-browser-full', '');
    return () => document.documentElement.removeAttribute('data-browser-full');
  }, [full]);
  // Ticket 991 C12 (5), 1062: the composer card stays in the chat column beside this pane (composerRoom.ts, one rule for every host).
  useEffect(() => (aside ? keepComposerClear(aside) : undefined), [aside]);

  // A request to focus the pane's terminal (prefix o, a blocked screen): retried while the terminal mounts.
  const want = st.focus?.id === session.id ? st.focus.n : 0;
  useEffect(() => {
    if (!want || !open) return;
    if (Date.now() - st.focus!.at > FOCUS_FRESH_MS) return void clearFocus(session.id);
    // The stored tab, not `shown`: a shell just started (pane.shell.new) is not in `all` yet, so `shown` still says the PTY.
    const asked = tabOf(st, session.id);
    const id = typeof asked === 'string' ? session.id : asked.shell;
    const at = st.focus!.at;
    let tries = 0;
    let raf = 0;
    const go = () => {
      const t = terminals.get(id);
      if (t) return (t.focus(), clearFocus(session.id));
      if (tries++ < 40 || Date.now() - at < FOCUS_FRESH_MS) raf = requestAnimationFrame(go);
      else clearFocus(session.id);
    };
    go();
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [want, open]);
  useEffect(() => setPick(null), [tabKey(shown), open]);

  if (!open) return null;

  const closeShell = (s: Session) => {
    removeShell(session.id, s.id);
    void core.request({ op: 'close', id: s.id }).catch(() => {});
  };

  const dividerDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const view = el.parentElement!.getBoundingClientRect();
    // From the press, not from the pointer's distance to the edge: a press a pixel off the divider's middle no longer
    // makes the pane jump by that pixel (v25-fix-layout, pane_resize_drag).
    const w0 = (el.nextElementSibling as HTMLElement).getBoundingClientRect().width;
    const x0 = e.clientX;
    resizing(el, e.pointerId, (ev) => setWidth(shown, Math.min(view.width - CHAT_MIN - DIV, Math.max(PANE_MIN, w0 + x0 - ev.clientX))));
  };
  const dividerKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const w = (e.currentTarget.nextElementSibling as HTMLElement).getBoundingClientRect().width;
    const view = e.currentTarget.parentElement!.getBoundingClientRect().width;
    const dx = e.key === 'ArrowLeft' ? 24 : e.key === 'ArrowRight' ? -24 : 0;
    if (dx) (e.preventDefault(), setWidth(shown, Math.min(view - CHAT_MIN - DIV, Math.max(PANE_MIN, w + dx))));
  };

  // A drag that ends in a pane terminal with text selected offers "Insert in composer" beside the selection.
  const selected = () => {
    const id = typeof shown === 'string' ? (shown === 'pty' ? session.id : '') : shown.shell;
    const t = id ? terminals.get(id) : undefined;
    if (!t || !t.hasSelection()) return setPick(null);
    const pos = t.getSelectionPosition();
    const screen = body.current?.querySelector<HTMLElement>(`.term[data-session="${id}"] .xterm-screen`);
    const box = body.current?.getBoundingClientRect();
    if (!pos || !screen || !box) return setPick({ text: t.getSelection(), x: 8, y: 8 });
    const cw = screen.clientWidth / t.cols;
    const ch = screen.clientHeight / t.rows;
    const at = screen.getBoundingClientRect();
    const row = pos.start.y - t.buffer.active.viewportY;
    setPick({ text: t.getSelection(), x: Math.max(4, Math.min(at.left - box.left + pos.end.x * cw, box.width - 130)), y: Math.max(4, at.top - box.top + row * ch - 26) });
  };

  // needs 172, WAI-ARIA tablist keys: Left and Right move to the neighbouring tab (wrapping), Home and End to the first and last;
  // focus and selection go together (the tabs are selected as they are reached, as a click would).
  const tabKeys = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.nativeEvent.isComposing || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const tabs = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')];
    const at = tabs.indexOf(e.target as HTMLElement);
    const to = { ArrowRight: at + 1, ArrowLeft: at - 1, Home: 0, End: tabs.length - 1 }[e.key];
    if (at < 0 || to === undefined) return;
    e.preventDefault();
    const next = tabs[(to + tabs.length) % tabs.length];
    next.focus();
    next.click();
  };

  const tabButton = (t: PaneTab, label: ReactNode, name?: string, go = () => select(session.id, t)) => (
    <button role="tab" id={`ptab-${session.id}-${tabKey(t)}`} aria-selected={same(shown, t)} aria-controls={`pbody-${session.id}`} tabIndex={same(shown, t) ? 0 : -1} className="tt" onClick={go} title={name} data-moved={t === 'pty' && moved ? '' : undefined}>
      {label}
    </button>
  );
  // SPLITKEYS: the terminal grid shows while its two terminals run and one of them is the shown tab.
  const terms = [...(moved ? [] : [session.id]), ...shells.filter((s) => s.state === 'running').map((s) => s.id)];
  const shownTerm = typeof shown === 'string' ? (shown === 'pty' ? session.id : '') : shown.shell;
  const grid = st.grid[session.id] ?? { dir: 'h', a: '', b: '' };
  const gridded = !!st.grid[session.id] && terms.includes(grid.a) && terms.includes(grid.b) && (shownTerm === grid.a || shownTerm === grid.b);
  const needs = blocked(session);
  const width: number | undefined = st.width[widthKey(shown)];
  const label = sessionName(session);
  return (
    <>
      <div className="pdiv" data-pane-divider role="separator" aria-orientation="vertical" aria-label={t('sidePane.resize')} aria-valuenow={width} aria-valuemin={PANE_MIN} tabIndex={0} title={t('sidePane.resizeTip')} onPointerDown={dividerDrag} onKeyDown={dividerKey} onDoubleClick={() => setWidth(shown, null)} />
      <aside ref={setAside} className={`spane${needs ? ' tui light-you light-edge' : ''}`} data-side-pane data-max={max ? '' : undefined} aria-label={t('sidePane.region')} style={max ? undefined : { width: width ?? `${PANE_SHARE * 100}%` }}>
        {/* v25-shell-chrome (ticket 284 item 4): no top strip of "+ Shell", Browser, Preview, a key hint, maximise and close. A new shell and the
            splits are palette commands (pane.shell.new, split.*); Browser and Preview open from their icons, Terminal brings the PTY back.
            Only when shells or a PTY shown in a split exist, a slim row keeps them reachable. */}
        {(shells.length > 0 || moved) && (
          <div className="tdh">
            <div role="tablist" aria-label={t('sidePane.terminals')} className="ptabs" onKeyDown={tabKeys}>
              {moved ? tabButton('pty', <>{agentName(session.kind, session.acp_agent)} · {label} <i>PTY</i> · {t('sidePane.inSplit')}</>, undefined, () => terminals.get(session.id)?.focus()) : tabButton('pty', <>{agentName(session.kind, session.acp_agent)} · {label} <i>PTY</i></>)}
              {shells.map((s) => (
                <span className="pt" key={s.id}>
                  {tabButton({ shell: s.id }, sessionName(s))}
                  <button className="px" aria-label={t('sidePane.closeShell', { name: sessionName(s) })} onClick={() => closeShell(s)}>
                    ✕
                  </button>
                </span>
              ))}
            </div>
          </div>
        )}
        {/* An overlay, not a row: a blocked screen arriving must not move the terminal (answer-strip specs: rows never change). */}
        {needs && (
          <span className="need" role="status" title={t('sidePane.needsInput')}>
            {t('sidePane.needsInput')}
          </span>
        )}
        <div className="pbody" id={`pbody-${session.id}`} role="tabpanel" ref={body} onMouseUp={() => setTimeout(selected)} onKeyUp={() => setTimeout(selected)}>
          {gridded ? (
            <div className="tgrid" data-grid={grid.dir}>
              {term(grid.a, true)}
              {term(grid.b, true)}
            </div>
          ) : null}
          {terms.filter((id) => !gridded || (id !== grid.a && id !== grid.b)).map((id) => term(id, !gridded && id === shownTerm))}
          {shown === 'pty' && moved && <div className="empty">{t('sidePane.termInSplit')}</div>}
          {shown === 'browser' && <BrowserSpaces initial={session.id} own={session.id} sessions={all} insert={insert} to={label} t={t} />}
          {shown === 'preview' && (
            <div className="pprev">
              <Preview
                session={session.id}
                label={label}
                onClose={() => (paneToggle(session.id), setTimeout(() => document.querySelector<HTMLTextAreaElement>('.composer textarea:not(.hoff-edit)')?.focus()))}
              />
            </div>
          )}
          {pick && (
            <button
              className="tosel"
              style={{ left: pick.x, top: pick.y }}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                insert(pick.text);
                const id = typeof shown === 'string' ? session.id : shown.shell;
                terminals.get(id)?.clearSelection();
                setPick(null);
              }}
            >
              {t('sidePane.insert')}
            </button>
          )}
        </div>
      </aside>
    </>
  );
}
