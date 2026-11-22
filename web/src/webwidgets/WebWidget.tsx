// A placed web widget (ticket v1b-22): its approved entry in the artifact sandbox (opaque origin, `allow-scripts`
// only, a per-widget CSP the app sends), and the postMessage bridge (bridge.ts). The window answers `context` from
// the core and turns `act` into the header confirm; only a Send click on it calls widget_act, and only after the whole
// text has been in view (r2: the box wraps and scrolls, and Send arms at its end).
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ApprovalCore } from '../approval/types';
import { clean, statusLine } from '../widgets/output';
import { actWebWidget, frameId, widgetPage, widgetSrc, type Target } from './api';
import { labelError, parse, textError } from './bridge';
import { useHtmlLangT } from '../i18n/lib/useHtmlLangT';
import './webwidgets.css';
import { docT, ErrorLine, tipError, rawError } from '../errors';

/** Widgets with a confirm showing (one per widget across its placements) and their last act, for the rate limit. */
const pending = new Set<string>();
const lastAct = new Map<string, number>();
export const ACT_GAP_MS = 1000;
/** A Send click whose pointerdown came sooner than this after the confirm rendered is ignored (no click-through). */
export const ARM_MS = 500;
/** v1b-23 (SHOULD-2): each `context` call re-hashes the widget folder in the core, so one per second per placement. */
export const CONTEXT_GAP_MS = 1000;

// v1b-23 (SHOULD-3): the session and page hash the confirm was raised for, not whatever the placement shows at Send.
type Confirm = { id: string | number; text: string; target: Target; session: string; hash: string; frame: string };

/** The box is inside the viewport and nothing covers it: a point just inside each corner hits the box itself. The
 * points sit in the box's padding (webwidgets.css), clear of the layout's splitter gutters, which overlap a widget's
 * edge by a few px without drawing anything. */
function onScreen(el: HTMLElement) {
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0 || r.top < 0 || r.left < 0 || r.bottom > innerHeight || r.right > innerWidth) return false;
  const i = 6;
  return [
    [r.left + i, r.top + i],
    [r.right - i, r.top + i],
    [r.left + i, r.bottom - i],
    [r.right - i, r.bottom - i],
  ].every(([x, y]) => {
    const hit = document.elementFromPoint(x, y);
    return !!hit && el.contains(hit);
  });
}

const targetName = (t: Target, w: ReturnType<typeof useHtmlLangT>) => ('session' in t ? w('rest.widgets.web.target.session', { name: t.session }) : w('rest.widgets.web.target.start', { kind: t.start }));

export function WebWidget({ core, name, session }: { core: ApprovalCore; name: string; session: string | null }) {
  const t = useHtmlLangT(); // ticket 508
  const [hash, setHash] = useState<string | null>(null);
  const [act, setAct] = useState(false);
  const [error, setError] = useState('');
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const shown = useRef(0);
  const down = useRef<number | null>(null);
  const contextBusy = useRef(false);
  // r2 S1: the bridge serves the page that was framed, not whatever the frame navigates to afterwards.
  const loads = useRef(0);
  // v1b-23 (S2): the key the served page's first script announced (bridge-key.js); calls without it are not the
  // served page's. Closed for good on a second announcement or a second load.
  const key = useRef<string | null>(null);
  const closed = useRef(false);
  const lastContext = useRef(0);
  // Bumped by Reload (which also releases the hold): an answer for a call the old frame made is dropped, never shown
  // as a confirm or posted into the new frame, whose call ids start over.
  const gen = useRef(0);
  const [navigated, setNavigated] = useState(false);
  // Reload (ticket 203): bumped by the owner's button, part of the frame's key, so the frame is a new element.
  const [reloads, setReloads] = useState(0);
  const textBox = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ end: false, lines: 1, covered: false });
  // This placement holds the widget's one pending act (from the call until the send settles).
  const holding = useRef(false);
  // The core has this placement's act (from `actWebWidget` until it settles). The hold is not released meanwhile, by
  // Reload, a navigation or an unmount: the old act is still in the core, so the next one waits for it (one pending act
  // per widget). The send's own `finally` releases once the call has settled.
  const sending = useRef(false);
  const hold = () => ((holding.current = true), pending.add(name));
  const release = () => !sending.current && holding.current && ((holding.current = false), pending.delete(name));

  useEffect(() => {
    let live = true;
    widgetPage(core, name).then(
      (p) => live && (setHash(p.hash), setAct(p.act), setError('')),
      (e: Error) => live && setError(rawError(e)),
    );
    return () => {
      live = false;
    };
  }, [core, name]);

  // Torn down with the frame: a pending confirm never outlives the widget it belongs to.
  useEffect(() => () => void release(), []); // eslint-disable-line react-hooks/exhaustive-deps

  // A new page (new hash or grant, or the owner's Reload: a new frame element) starts its own load count; nothing else
  // reopens the bridge.
  useLayoutEffect(() => {
    loads.current = 0;
    key.current = null;
    closed.current = false;
    setNavigated(false);
  }, [hash, act, reloads]);

  // The frame left its served page: close the bridge, drop a confirm it raised without answering it.
  const close = () => {
    closed.current = true;
    setNavigated(true);
    release();
    setConfirm(null);
  };

  // v1b-23: a layout effect, so the listener is in place before the frame's first message can arrive.
  useLayoutEffect(() => {
    if (!hash) return;
    const reply = (id: string | number, r: { ok: unknown } | { error: string }) =>
      !closed.current && frame.current?.contentWindow?.postMessage({ nunchiro: 1, id, ...r }, '*');
    const onMessage = (e: MessageEvent) => {
      // Only this widget's own frame: another frame (an artifact card, a second widget) posting as it is ignored.
      if (!frame.current || e.source !== frame.current.contentWindow || closed.current) return;
      const d = e.data as { type?: unknown; key?: unknown } | null;
      if (typeof d !== 'object' || d === null) return;
      if (d.type === 'nunchiro:bridge') {
        if (key.current === null && typeof d.key === 'string') key.current = d.key;
        else close();
        return;
      }
      if (key.current === null || d.key !== key.current) return;
      const call = parse(e.data);
      if (!call) return;
      const from = gen.current;
      const say = (id: string | number, r: { ok: unknown } | { error: string }) => from === gen.current && reply(id, r);
      if ('error' in call) return say(call.id, { error: call.error });
      if (call.method === 'context') {
        if (contextBusy.current) return say(call.id, { error: 'busy' });
        if (Date.now() - lastContext.current < CONTEXT_GAP_MS) return say(call.id, { error: 'one context per second' });
        lastContext.current = Date.now();
        contextBusy.current = true;
        widgetPage(core, name)
          .then(
            (p) => say(call.id, p.hash === hash ? { ok: p.context } : { error: 'widget changed' }),
            (err: Error) => say(call.id, { error: rawError(err) }),
          )
          .finally(() => (contextBusy.current = false));
        return;
      }
      if (pending.has(name)) return say(call.id, { error: 'busy' });
      const now = Date.now();
      if (now - (lastAct.get(name) ?? 0) < ACT_GAP_MS) return say(call.id, { error: 'one act per second' });
      const bad = textError(call.text) ?? ('session' in call.target ? labelError(call.target.session) : null);
      if (bad) return say(call.id, { error: bad });
      if (!session) return say(call.id, { error: 'act needs the placement’s session for its project' });
      const at = { session, hash, frame: frameId(name, hash, act) };
      lastAct.set(name, now);
      hold();
      // The grant is read fresh: nothing is confirmed (or sent) for a widget allowed only to read.
      widgetPage(core, name).then(
        (p) => {
          // v1b-23: the bridge may have closed while the core answered.
          if (from !== gen.current) return;
          if (closed.current) return release();
          // review-34: a page framed without act ran under the read policy (CDN scripts); it never acts, the frame is
          // served again under the act policy instead.
          if (p.hash !== hash || !p.act || !act) {
            release();
            setAct(p.act);
            const error =
              p.hash !== hash
                ? 'widget changed'
                : p.act
                  ? 'act was just allowed; the widget reloads under its act policy'
                  : `act is not allowed for ${name}: turn on act in its permission sheet`;
            return say(call.id, { error });
          }
          setConfirm({ id: call.id, text: call.text, target: call.target, ...at });
        },
        (err: Error) => (from === gen.current && release(), say(call.id, { error: rawError(err) })),
      );
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [core, name, hash, act, session]);

  // Whether the box has shown its end (or fits) while whole on screen, and how many wrapped lines it holds.
  const measure = () => {
    const el = textBox.current;
    if (!el) return false;
    const s = getComputedStyle(el);
    const lines = Math.max(1, Math.round((el.scrollHeight - parseFloat(s.paddingTop) - parseFloat(s.paddingBottom)) / parseFloat(s.lineHeight)));
    const covered = !onScreen(el);
    const end = !covered && el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
    setView((v) => ({ end: v.end || end, lines, covered }));
    return !covered;
  };
  useLayoutEffect(() => {
    if (!confirm) return;
    shown.current = performance.now();
    down.current = null;
    setView({ end: false, lines: 1, covered: false });
    measure();
    const el = textBox.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const o = new ResizeObserver(() => measure());
    o.observe(el);
    return () => o.disconnect();
  }, [confirm]); // eslint-disable-line react-hooks/exhaustive-deps

  // The owner pressed Reload: the same path as a first load (a new frame under the same key rule, sandbox and URL).
  const reload = () => {
    gen.current += 1;
    release();
    setConfirm(null);
    setReloads((n) => n + 1);
  };

  const onLoad = () => {
    loads.current += 1;
    if (loads.current > 1) close();
  };

  const finish = (r: { ok: unknown } | { error: string }) => {
    if (!confirm) return;
    if (!closed.current) frame.current?.contentWindow?.postMessage({ nunchiro: 1, id: confirm.id, ...r }, '*');
    release();
    setConfirm(null);
  };
  const send = (e: React.MouseEvent) => {
    if (!confirm || closed.current || !view.end) return;
    // Checked again at the click: something may have moved over the box since it was measured.
    if (!measure()) return;
    // A pointer click counts only when its pointerdown landed on Send after the line had shown for ARM_MS; a key
    // press (detail 0) only after ARM_MS too.
    const start = e.detail > 0 ? down.current : performance.now();
    if (start === null || start < shown.current + ARM_MS) return;
    const c = confirm;
    setConfirm(null);
    // Reload while this Send is in flight: the answer belongs to the old frame (its ids restart in the new one), so it
    // is not posted; the owner still gets the note. The hold stays this send's until the call settles (`sending`), so the
    // new frame's act is busy meanwhile.
    const from = gen.current;
    sending.current = true;
    const post = (m: object) => from === gen.current && !closed.current && frame.current?.contentWindow?.postMessage({ nunchiro: 1, id: c.id, ...m }, '*');
    actWebWidget(core, name, c.session, c.text, c.target, c.hash, c.frame).then(
      (r) => {
        post({ ok: { status: r.send.status } });
        setNote({ text: t(r.send.status === 'queued' ? 'rest.widgets.web.queued' : 'rest.widgets.web.sent', { target: targetName(c.target, t), time: new Date().toLocaleTimeString() }), error: false });
      },
      (err: Error) => {
        post({ error: rawError(err) });
        setNote({ text: tipError(docT(), err), error: true });
      },
    ).finally(() => ((sending.current = false), release()));
  };

  // Ticket 203: the status line truncates, so its whole text (cleaned, never the widget's raw text) is also its title.
  const status = statusLine(
    navigated
      ? t('rest.widgets.web.navigated')
      : note
        ? note.text
        : act
          ? t('rest.widgets.web.hint.act')
          : t('rest.widgets.web.hint.read'),
  );
  if (error) return <ErrorLine t={docT()} error={clean(error)} className="uw-note uw-err" />;
  if (!hash) return <p className="uw-note dim">{t('rest.widgets.loading')}</p>;
  return (
    <>
      {/* One line, always there: a confirm takes its place and its text box opens over the frame, so nothing moves
          (needs 26). */}
      <div
        className="ww-confirm"
        role="group"
        aria-label={t('rest.widgets.web.actAria', { name })}
        data-confirm={confirm ? 'open' : 'idle'}
        aria-live="polite"
        onKeyDown={(e) => e.key === 'Escape' && confirm && (e.stopPropagation(), finish({ error: 'cancelled' }))}
      >
        {confirm ? (
          <>
            <span className="ww-to">{t('rest.widgets.web.sendTo', { target: clean(targetName(confirm.target, t)) })}</span>
            <span className="ww-count dim">
              {t('rest.widgets.web.chars', { n: [...confirm.text].length })} · {t(view.lines === 1 ? 'rest.widgets.web.lines.one' : 'rest.widgets.web.lines.other', { n: view.lines })}
              {view.covered ? ` · ${t('rest.widgets.web.covered')}` : view.end ? '' : ` · ${t('rest.widgets.web.scrollEnd')}`}
            </span>
            <button type="button" className="btn" onClick={() => finish({ error: 'cancelled' })}>
              {t('rest.widgets.web.cancel')}
            </button>
            <button type="button" className="btn p" disabled={!view.end} onPointerDown={(e) => (down.current = e.timeStamp)} onClick={send}>
              {t('rest.widgets.web.send')}
            </button>
          </>
        ) : (
          <>
            <span className={note?.error ? 'uw-err' : 'dim'} tabIndex={0} title={status.title} data-act-note={note ? (note.error ? 'error' : 'ok') : 'hint'}>
              {status.text}
            </span>
            {navigated && (
              <button type="button" className="btn ww-reload" aria-label={t('rest.widgets.web.reloadAria')} onClick={reload}>
                {t('rest.widgets.web.reload')}
              </button>
            )}
          </>
        )}
      </div>
      <div className="ww-body">
        {/* The whole text, over the top of the frame and never outside it: capped by the frame area, scrolled there. */}
        {confirm && (
          <div ref={textBox} className="ww-text glass" tabIndex={0} role="document" aria-label={t('rest.widgets.web.textToSend')} onScroll={measure}>
            {confirm.text}
          </div>
        )}
        <iframe
        key={`${hash}${act ? '-act' : ''}-${reloads}`}
        ref={frame}
        className="ww-frame"
        title={t('rest.widgets.web.frameTitle', { name })}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        src={widgetSrc(frameId(name, hash, act))}
        onLoad={onLoad}
        />
      </div>
    </>
  );
}
