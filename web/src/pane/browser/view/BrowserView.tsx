// V2.5-19 (WP1): the side pane's Browser tab: a toolbar (back, forward, reload or stop, address) over a slot the app glues its native
// WKWebView to. One view per space (an agent session); the slot reports its rectangle, the view hides when the tab is not shown.
import { PLAIN } from '../../../plainText';
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { tEn, type T } from '../../../i18n';
import { sessionName } from '../../../Sidebar';
import type { Session } from '../../../types';
import { call, inApp, onFailed, onMoved } from './bridge';
import { causeOf, hostOf, isWeb, retriesItself, type Failure } from './failure';
import { shownTab, type AgentTabs as AgentList } from './agentTabs';
import { openExternal } from '../../../sandbox/link';
import { invoke, listen } from '../control/bridge';
import { isCovered, useCovered } from './covered';
import { useAnnotate } from '../annotate/Annotate';
import { ErrorDetails, ErrorLine, rawError } from '../../../errors';
import { HandBack, SignedInChip, useControl, type State as Control } from '../control/ControlChip';
import { setMax, usePane } from '../../store';
import { AgentMark, BIcon } from './icons';
import { dropStore, hasStore, noteStore, spaceChoices, YOU_SPACE } from './spaces';
import { noteClosed } from '../../../chrome/closedTabs'; // ticket 299: ⇧⌘T reopens the closed page
import { BROWSER_GO_EVENT, takeBrowserGo } from '../../../tree/browserGo'; // v25-new-tab: the New tab popover's URL row
import { closeTab, isMine, newTab, noteTabUrl, pickTab, stripShown, tabs as ownTabs, watchTabs } from './tabs';
import './browser-view.css';
import '../toolbar.css';

/** Spaces whose native view exists: it outlives this component (tab switches hide it, they do not close it). */
const opened = new Set<string>();
/** Ticket 288: each space's address bar text. Closing the widget unmounts this view; the text outlives it, as the page does. */
const addresses = new Map<string, string>();
/** Ticket 997 L7: side panes that Take over maximised; Hand back returns them to their width (and only them). */
const tookMax = new Set<string>();

/** V2.5-82: how many mounted BrowserViews show each space. The app keeps one native webview per space, so two panes on one space
 *  fight over it (whichever hides or shows last wins and the other goes blank); the switcher reads this to keep a taken space
 *  from being picked. Module level: it spans every BrowserSpaces of this window (it cannot see another window). */
const shown = new Map<string, number>();
let shownVersion = 0;
const shownListeners = new Set<() => void>();
const count = (space: string, d: number) => {
  shown.set(space, (shown.get(space) ?? 0) + d);
  shownVersion++;
  shownListeners.forEach((l) => l());
};
const watchShown = (l: () => void) => (shownListeners.add(l), () => void shownListeners.delete(l));

/** Tickets 288, 309: the space's native view as the app reports it (`browser_nav`). */
type Popup = { url: string | null };
type Nav = { url: string; back: boolean; forward: boolean; loading: boolean; progress: number; popup?: Popup | null };
/** Ticket 264: `browser_profiles`, for the new-space picker. */
type Choices = { list: { id: string; name: string }[]; default: string; picked: string | null };
const NO_NAV: Nav = { url: '', back: false, forward: false, loading: false, progress: 0 };

/** `restore`: ticket 328, the address a tab of My browser kept from an earlier run; it opens when the tab is first shown.
 *  `tab`: ticket 328 part 2, the agent's tab this view shows (1, the default, is the space's own view, as before).
 *  `ctl`: who drives an agent's space (absent for the owner's own). `pane`: ticket 997 L7, the session whose side pane holds
 *  this view; its toolbar then offers Take over and open full size (maximise that pane). */
export function BrowserView({ space, insert, to, annotate = false, restore = '', tab = 1, ctl, pane, t }: { space: string; insert?: (text: string) => void; to?: string; annotate?: boolean; restore?: string; tab?: number; ctl?: Control; pane?: string; t: T }) {
  const mine = isMine(space);
  const rules = mine ? YOU_SPACE : space; // the owner's later tabs keep his rules: no control chip, his profile, his New tab address
  const at = tab > 1 ? { tab } : {}; // every app call names the tab; none is tab 1, exactly as before
  const view = tab > 1 ? `${space}#${tab}` : space; // the native view's own key for what outlives this component
  const slot = useRef<HTMLDivElement>(null);
  const [live, setLive] = useState(opened.has(view));
  const [address, setAddress] = useState(addresses.get(view) ?? '');
  const [stored, setStored] = useState(hasStore(space));
  const [error, setError] = useState<unknown>('');
  const [failure, setFailure] = useState<Failure | null>(null); // ticket 329: the page that could not load, until another one lands
  const typed = useRef(''); // what this pane was asked to open, while that load is under way
  const [page, setPage] = useState(NO_NAV);
  const [popup, setPopup] = useState<Popup | null>(null); // ticket 307: what the page showing here last asked to open; the app keeps it per space
  const bar = useRef<HTMLInputElement>(null);
  const epoch = useRef(0); // Forget moves it on: an answer still on its way describes the view it closed
  const [choices, setChoices] = useState<Choices | null>(null); // ticket 264: read while no view exists
  const [pick, setPick] = useState<string | null>(null); // the user's own choice; none leaves it to the app (remembered pick, else the default)
  const [reread, setReread] = useState(0);
  const [more, setMore] = useState(false);
  const moreBox = useRef<HTMLSpanElement>(null);
  // S3-1 (look v35 c): WebKit never focuses a clicked button, so the span's blur alone left the menu open over the notes
  // bar, where the next click hit Forget page. Close it on any press outside and on Escape anywhere; a click in the page
  // itself (a pick, or the owner taking control) closes it below.
  useEffect(() => {
    if (!more) return;
    const away = (e: PointerEvent) => !moreBox.current?.contains(e.target as Node) && setMore(false);
    const esc = (e: globalThis.KeyboardEvent) => e.key === 'Escape' && !e.isComposing && setMore(false);
    document.addEventListener('pointerdown', away, true);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('pointerdown', away, true);
      document.removeEventListener('keydown', esc);
    };
  }, [more]);
  // Ticket 264: the remembered profile was removed. The app refuses to open on the default, so this space asks.
  const gone = !!choices && pick === null && choices.picked !== null && !choices.list.some((p) => p.id === choices.picked);
  const app = inApp();
  const covered = useCovered(slot, app && live);
  const failed = failure !== null;
  const cause = failure && causeOf(failure.code);
  const waits = failure !== null && cause !== null && retriesItself(cause, failure.url, typed.current);
  useEffect(() => (count(rules, 1), () => count(rules, -1)), [rules]);
  useEffect(() => void addresses.set(view, address), [view, address]);

  const rect = () => {
    const r = slot.current!.getBoundingClientRect();
    const z = Number(document.documentElement.dataset.uiZoom ?? 1); // ticket 1071: CSS pixels to window points under the window zoom
    return { x: r.left * z, y: r.top * z, w: r.width * z, h: r.height * z };
  };
  const fail = (e: unknown) => setError(e);
  const show = (url: string) => call('browser_show', { space, url, profile: pick, ...at, ...rect() });

  // The native view follows the slot while this tab is shown and nothing is over it, and hides otherwise (the page stays loaded).
  useEffect(() => {
    if (!app || !live) return;
    // Measured here too: on the commit that brings the tab back `covered` is still false, and a show would flash over the overlay.
    // A failed page leaves the view blank or on the page before it, and the view sits above the web layer: it steps aside for the error.
    if (covered || failed || isCovered(slot.current!)) return void call('browser_hide', { space, ...at }).catch(() => {}); // also a view just opened under an overlay
    const place = () => void show(address).catch(fail);
    place();
    const watch = new ResizeObserver(place);
    watch.observe(slot.current!);
    window.addEventListener('resize', place);
    return () => {
      watch.disconnect();
      window.removeEventListener('resize', place);
      void call('browser_hide', { space, ...at }).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app, live, space, tab, covered, failed]);

  // Ticket 264: a new space offers the profiles (the render shows the picker only with two or more).
  useEffect(() => {
    if (!app || live) return;
    let on = true;
    void invoke<Choices | null>('browser_profiles', { space: rules })
      .then((r) => on && setChoices(r))
      .catch(() => {});
    return () => {
      on = false;
    };
  }, [app, live, rules, reread]);

  // The address bar follows the page; a page that could not load says why (the native view stays blank, ticket 288).
  useEffect(() => {
    if (!app) return;
    const moved = (s: string, url: string, n: number) => {
      if (s === space && n === tab) ((typed.current = ''), setAddress(url), setError(''), setFailure(null), mine && noteTabUrl(space, url));
    };
    // A refused subscription leaves the address bar as typed; it never rejects unhandled.
    const asked = listen<{ space: string; url: string | null }>('browser-popup', (p) => p.space === space && setPopup((was) => (was?.url === p.url ? was : { url: p.url })));
    // Another page landed, so "Open here" would load what the old one chose. The same load's `finished` half is the same page.
    const landed = listen<{ space: string; tab?: number; finished?: boolean }>('browser-moved', (p) => p.space === space && !p.tab && !p.finished && setPopup(null));
    const subs = [onMoved(moved), onFailed((s, f, n) => s === space && n === tab && setFailure({ ...f, url: f.url || (addresses.get(view) ?? '') })), asked, landed].map((p) => p.catch(() => () => {}));
    return () => subs.forEach((off) => void off.then((f) => f()).catch(() => {}));
  }, [app, space, tab]);

  // Ticket 288: a view can exist that this pane did not open (the agent's first page, parked off screen until a pane places it):
  // the app's answer is what makes it live. Ticket 309: the same answer drives the toolbar.
  // ponytail: polled (500 ms, 150 ms while loading), since history a page changes by script fires no event; KVO on the WKWebView if this ever shows in idle CPU.
  useEffect(() => {
    if (!app) return;
    let on = true;
    let timer = 0;
    let first = true; // a request made while no pane was open (or on another space) is waiting in the app
    const tick = async () => {
      const asked = epoch.current;
      const now = await invoke<Nav | null>('browser_nav', { space, ...at }).catch(() => null);
      if (!on) return;
      if (now && asked === epoch.current) {
        setPage((was) => (JSON.stringify(was) === JSON.stringify(now) ? was : now));
        if (first && now.popup && tab === 1) setPopup(now.popup); // the space's offer is about the pane's own view
        first = false;
        if (!opened.has(view)) {
          opened.add(view);
          noteStore(space);
          setStored(true);
          setLive(true);
          setAddress((typed) => typed || now.url);
        }
      }
      timer = window.setTimeout(() => void tick(), now?.loading ? 150 : 500);
    };
    void tick();
    return () => {
      on = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app, space, tab]);

  // Ticket 329: each failure arms one try, so a slow load that is finally answering is never restarted. A new failure re-arms it;
  // a page landing, navigating away and unmounting all end it.
  useEffect(() => {
    if (!failure || !retriesItself(causeOf(failure.code), failure.url, typed.current)) return;
    const timer = window.setTimeout(() => void call('browser_go', { space, url: failure.url, ...at }).catch(fail), 2000);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [failure, space, tab]);

  const dropPopup = () => {
    setPopup(null);
    void call('browser_popup_clear', { space }).catch(() => {});
  };
  const navigate = async (url: string) => {
    setError('');
    setFailure(null);
    typed.current = url;
    dropPopup();
    if (mine) noteTabUrl(space, url);
    try {
      if (live) await call('browser_go', { space, url, ...at });
      else {
        await show(url);
        opened.add(view);
        noteStore(space);
        setStored(true);
        setLive(true);
      }
    } catch (x) {
      if (rawError(x).includes('PROFILE_REMOVED')) setReread((n) => n + 1); // the picker says it
      else fail(x);
    }
  };
  // Eighth look (C): a narrow pane's field read "ttp://127.0.0.1:8791/": the caret stood at the end of the address, so
  // its start was scrolled out. An address that was entered, or that the page set, shows from its start (typing does not).
  const keyed = useRef(false);
  const fromStart = () => bar.current && (bar.current.scrollLeft = 0);
  useLayoutEffect(() => {
    if (!keyed.current) fromStart();
    keyed.current = false;
  }, [address]);
  const go = (e: FormEvent) => {
    e.preventDefault();
    if (!address.trim()) return; // an empty field has nothing to open; the red "did not work" line was noise
    fromStart();
    return navigate(address);
  };
  // v25-new-tab: an address the New tab popover left for this space opens here (at mount, or while mounted by its event).
  const nav = useRef(navigate);
  nav.current = navigate;
  useEffect(() => {
    if (!app) return;
    const take = () => {
      const url = takeBrowserGo(rules);
      if (url) (setAddress(url), void nav.current(url));
      // Ticket 328: a kept tab opens its page again when first shown in this run (a view that still exists is only placed).
      else if (restore && !opened.has(view)) (setAddress(restore), void nav.current(restore));
    };
    take();
    const on = (e: Event) => (e as CustomEvent<{ space: string }>).detail?.space === rules && take();
    window.addEventListener(BROWSER_GO_EVENT, on);
    return () => window.removeEventListener(BROWSER_GO_EVENT, on);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app, space, rules]);
  const forget = async () => {
    setError('');
    setFailure(null);
    typed.current = '';
    setPopup(null);
    epoch.current++;
    try {
      await call('browser_forget', { space });
      epoch.current++;
      setPage(NO_NAV);
      if (address) noteClosed({ browser: space, url: address });
      opened.delete(view);
      dropStore(space);
      setStored(false);
      setLive(false);
      setAddress('');
      setPick(null);
    } catch (x) {
      fail(x);
    }
  };
  const act = (cmd: 'browser_back' | 'browser_forward' | 'browser_reload' | 'browser_stop') => () => void call(cmd, { space, ...at }).catch(fail);
  const leave = (cmd: 'browser_back' | 'browser_forward') => () => (setFailure(null), act(cmd)());
  // The surface stays up during the try (a failure replaces it, a landed page clears it). `browser_reload` would reload the page before the failed one.
  const retry = () => {
    typed.current = failure!.url;
    setError('');
    void call('browser_go', { space, url: failure!.url, ...at }).catch(fail);
  };

  // Ticket 997 L7 (A8): Take over is this button only, never `control::take` (it fires on many events). Hand back puts back
  // the width Take over changed; the side-width button only returns the width.
  const maxed = usePane().max[pane ?? ''] === true;
  const takeOver = () => {
    void call('browser_take', { space, ...at }).catch(fail);
    if (pane && !maxed) (tookMax.add(pane), setMax(pane, true));
  };
  const sideWidth = () => pane && (tookMax.delete(pane), setMax(pane, false));
  const handedBack = () => pane && tookMax.delete(pane) && setMax(pane, false);
  const note = useAnnotate({ space, tab, app, page: live, offered: annotate, insert, to, t });
  useEffect(() => setMore(false), [note.picks, ctl?.user]);
  // The owner already has control: nothing to take over, only the size.
  const fullName = t(maxed ? 'browserPane.sideWidth' : ctl?.user ? 'browserPane.fullSizeOwn' : 'browserPane.fullSize');
  const secure = /^https:/i.test(page.url);
  return (
    <div className="bview">
      <form className="btool" onSubmit={(e) => void go(e)}>
        <span className="bgrp">
          <button type="button" className="bib" aria-label={t('browserPane.back')} data-tip={t('browserPane.back')} disabled={!live || !page.back} onClick={leave('browser_back')}>
            <BIcon name="back" />
          </button>
          <button type="button" className="bib bfwd" aria-label={t('browserPane.forward')} data-tip={t('browserPane.forward')} disabled={!live || !page.forward} onClick={leave('browser_forward')}>
            <BIcon name="forward" />
          </button>
          <button type="button" className="bib" aria-label={t(page.loading ? 'browserPane.stop' : 'browserPane.reload')} data-tip={t(page.loading ? 'browserPane.stop' : 'browserPane.reload')} disabled={!live} onClick={page.loading ? act('browser_stop') : failure ? retry : act('browser_reload')}>
            <BIcon name={page.loading ? 'close' : 'reload'} />
          </button>
        </span>
        <span className="baddr field-box">
          {live && page.url && <BIcon name={secure ? 'lock' : 'info'} size={12} />}
          <input {...PLAIN} ref={bar} type="text" aria-label={t('browserPane.address')} placeholder={t('browserPane.addressHint')} value={address} disabled={!app} onChange={(e) => ((keyed.current = true), setAddress(e.target.value))} />
        </span>
        {app && ctl && <HandBack space={space} state={ctl} back={handedBack} t={t} />}
        {note.button}
        {app && pane && !mine && (
          <button type="button" className={maxed ? 'bib on' : 'bib'} aria-label={fullName} data-tip={fullName} onClick={maxed ? sideWidth : takeOver}>
            <BIcon name={maxed ? 'side' : 'full'} />
          </button>
        )}
        {/* Forget page lives in this menu at every width (ticket 997 L7), so the toolbar keeps one line. */}
        <span ref={moreBox} className="bmore" onBlur={(e) => !e.currentTarget.contains(e.relatedTarget) && setMore(false)} onKeyDown={(e) => e.key === 'Escape' && more && (e.stopPropagation(), setMore(false))}>
          <button type="button" className={more ? 'bib on' : 'bib'} aria-label={t('browserPane.more')} data-tip={t('browserPane.more')} aria-expanded={more} aria-haspopup="menu" onClick={() => setMore(!more)}>
            <BIcon name="more" />
          </button>
          {more && (
            <span className="bmenu" role="menu">
              {/* Ticket 328: a pane of 280 px or less moves Forward here, so the whole address hint fits (browser-view.css). */}
              <button type="button" role="menuitem" className="bmfwd" disabled={!live || !page.forward} onClick={() => (setMore(false), leave('browser_forward')())}>
                {t('browserPane.forward')}
              </button>
              {note.item?.(() => setMore(false))}
              <button type="button" role="menuitem" disabled={!app || !(live || stored)} onClick={() => (setMore(false), void forget())}>
                {t('browserPane.forget')}
                <small>{t('browserPane.forgetTip')}</small>
              </button>
            </span>
          )}
        </span>
      </form>
      {app && !mine && <SignedInChip space={space} tab={tab} url={page.url} loading={page.loading} t={t} />}
      <div className="bprog" {...(page.loading ? { role: 'progressbar', 'aria-label': t('browserPane.loading'), 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round(page.progress * 100) } : {})}>
        {page.loading && <i style={{ transform: `scaleX(${page.progress})` }} />}
      </div>
      {/* Always in the page: a live region inserted already holding its text is often not announced. */}
      <div className={popup ? 'bnotice' : undefined}>
        <span aria-live="polite" title={popup?.url ?? undefined}>
          {popup && (popup.url ? t('browserPane.popup', { host: new URL(popup.url).host }) : t('browserPane.popupRefused'))}
        </span>
        {popup?.url && (
          <button type="button" onClick={() => (setAddress(popup.url!), void navigate(popup.url!), bar.current?.focus())}>
            {t('browserPane.openHere')}
          </button>
        )}
        {popup && (
          <button type="button" aria-label={t('browserPane.dismiss')} onClick={() => (dropPopup(), bar.current?.focus())}>
            ×
          </button>
        )}
      </div>
      {note.notes}
      <ErrorLine t={t} error={error} className="berr" />
      <div className="bslot" ref={slot}>
        {!app ? (
          <div className="empty">{t('browserPane.needsApp')}</div>
        ) : failure && cause ? (
          <div className="bfail" role="alert">
            <div className="bfail-title">{t(`browserPane.fail.${cause}`, { host: hostOf(failure.url) })}</div>
            {cause === 'other' && <ErrorDetails t={t} details={failure.error} />}
            <div className="bfail-url">{failure.url}</div>
            {waits && <div className="bfail-note">{t('browserPane.failWaiting')}</div>}
            <div className="bfail-acts">
              <button type="button" className="btn" onClick={retry}>
                {t('browserPane.retry')}
              </button>
              {isWeb(failure.url) && (
                <button type="button" className="btn" onClick={() => void openExternal(failure.url).catch(fail)}>
                  {t('browserPane.openDefault')}
                </button>
              )}
            </div>
          </div>
        ) : !live ? (
          <div className="empty">
            {t(mine ? 'browserPane.empty' : 'browserPane.agentEmpty')}
            {gone && <div role="alert">{t('bprofiles.gone')}</div>}
            {choices && (choices.list.length > 1 || gone) && (
              <label className="bprofile">
                {t('bprofiles.picker')}
                <select value={pick ?? (gone ? '' : choices.picked ?? choices.default)} onChange={(e) => setPick(e.target.value)}>
                  {gone && <option value="" disabled />}
                  {choices.list.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name || t('bprofiles.builtIn')}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** Ticket 288 (needs 213): the Browser with a switcher at the top. `initial` is the focused agent session's space, else the
 *  user's own ("My browser": logins and tabs kept, no agent verb ever runs there). One view per space, so a switch hides one
 *  and shows the other; the agent's own space stays open behind it. `own` is the session whose composer `insert` reaches: Annotate is
 *  offered only on that session's space, so a note picked on another agent's page never lands in this composer. Ticket 1038
 *  (coordinator, for owner 11-21): My browser offers it on every view; its notes go to `insert` (the session in front, named
 *  `to`), and with no session it is shown inert. */
export function BrowserSpaces({ initial, sessions, insert, to, own, t = tEn }: { initial: string; sessions: Session[]; insert?: (text: string) => void; to?: string; own?: string; t?: T }) {
  const [picked, setPicked] = useState(initial);
  // The focused session changing (another agent focused, or none) moves the view with it; a pick stays until then.
  useEffect(() => setPicked(initial), [initial]);
  useSyncExternalStore(watchShown, () => shownVersion); // another pane taking or freeing a space redraws the options
  const spaces = spaceChoices(sessions);
  const mine = useRef<string | null>(null); // the space this pane's view is registered on (set after the child's effect)
  const home = spaces.includes(initial) ? initial : YOU_SPACE;
  const taken = (id: string) => (shown.get(id) ?? 0) - (id === mine.current ? 1 : 0) > 0;
  const lost = spaces.includes(picked) && picked !== home && taken(picked); // the pick was taken by another pane
  const space = !spaces.includes(picked) ? YOU_SPACE : lost ? home : picked;
  useEffect(() => {
    mine.current = space;
    if (lost) setPicked(home);
  });
  const nameOf = (id: string) => {
    const s = sessions.find((x) => x.id === id);
    return id === YOU_SPACE || !s ? t('exitWidgets.myBrowser') : t('exitWidgets.agentSpace', { name: sessionName(s) });
  };
  // Ticket 997 L7: a compact chip on the tab row; the native select inside it keeps the keyboard and the screen reader's list.
  const select = (
    <select className="bspace" aria-label={t('exitWidgets.spaces')} data-tip={t('exitWidgets.spaces')} value={space} onChange={(e) => setPicked(e.target.value)}>
      {spaces.map((id) => {
        const off = id !== space && id !== home && taken(id);
        return (
          <option key={id} value={id} disabled={off}>
            {off ? t('spaceSwitchFu.shownElsewhere', { name: nameOf(id) }) : nameOf(id)}
          </option>
        );
      })}
    </select>
  );
  const s = sessions.find((x) => x.id === space);
  const chip = (mark: ReactNode) => (
    // A span, not a label: the select already covers the chip, and a label made its disabled options read as enabled.
    <span className="bchip">
      {mark}
      <span className="bchip-name">{space === YOU_SPACE || !s ? t('exitWidgets.myBrowser') : sessionName(s)}</span>
      <BIcon name="chevron" size={12} />
      {select}
    </span>
  );
  return <div className="bspaces">{space === YOU_SPACE ? <OwnTabs chip={chip(<BIcon name="globe" size={12} />)} insert={insert} to={to} t={t} /> : <AgentTabs key={space} space={space} chip={chip} insert={insert} annotate={space === own} pane={own} t={t} />}</div>;
}

type StripTab = { id: string; name: string; tip: string };

/** Ticket 328: the browser's tab strip, for My browser and for an agent's space. The look is the side pane's terminal tab row
 *  (pane.css .tdh, .tt, .px); Left and Right move between tabs as there (WAI-ARIA tablist). `close` and `add` are My browser's
 *  only: the owner never creates or closes an agent's tab. Middle-click closes where `close` is given. */
/** Ticket 997 L7: one 36 px row: the space chip (`lead`), then the tabs as flat pills with the close inside; `agent` is the tab
 *  the agent is using now, marked with its pointer. */
function TabStrip({ tabs, active, pick, close, add, lead, agent, t }: { tabs: StripTab[]; active: string; pick: (id: string) => void; close?: (id: string) => void; add?: () => void; lead: ReactNode; agent?: string; t: T }) {
  const keys = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.nativeEvent.isComposing || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const all = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')];
    const at = all.indexOf(e.target as HTMLElement);
    const to = { ArrowRight: at + 1, ArrowLeft: at - 1, Home: 0, End: all.length - 1 }[e.key];
    if (at < 0 || to === undefined) return;
    e.preventDefault();
    const next = all[(to + all.length) % all.length];
    next.focus();
    next.click();
  };
  return (
    <div className="btabs">
      {lead}
      {tabs.length > 0 && (
        <div role="tablist" aria-label={t('browserTabs.strip')} className="btablist" onKeyDown={keys}>
          {tabs.map((x) => (
            <span className={close ? 'bt' : 'bt ro'} key={x.id} data-on={x.id === active ? '' : undefined} onAuxClick={(e) => close && e.button === 1 && (e.preventDefault(), close(x.id))}>
              <button role="tab" className="bstab" aria-selected={x.id === active} tabIndex={x.id === active ? 0 : -1} data-tip={x.id === agent ? t('browserPane.agentUsing') : x.tip} ref={(b) => void (x.id === active && b?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }))} onClick={() => pick(x.id)}>
                {x.id === agent && (
                  <span className="bag" data-agent-badge>
                    <AgentMark />
                  </span>
                )}
                {x.name}
              </button>
              {close && (
                <button type="button" className="bsx" aria-label={t('browserTabs.close', { name: x.name })} data-tip={t('browserTabs.close', { name: x.name })} tabIndex={-1} onClick={() => close(x.id)}>
                  <BIcon name="close" size={12} />
                </button>
              )}
            </span>
          ))}
        </div>
      )}
      {add && (
        <button type="button" className="bib" aria-label={t('browserTabs.new')} data-tip={t('browserTabs.new')} onClick={add}>
          <BIcon name="plus" />
        </button>
      )}
    </div>
  );
}

/** Ticket 328 part 1: My browser's tab strip over the shown tab's view. */
function OwnTabs({ chip, insert, to, t }: { chip: ReactNode; insert?: (text: string) => void; to?: string; t: T }) {
  const now = useSyncExternalStore(watchTabs, ownTabs);
  useEffect(() => (stripShown(1), () => stripShown(-1)), []);
  const active = now.tabs.find((x) => x.id === now.active)!;
  const named = now.tabs.map((x) => {
    const name = x.title || t('browserTabs.newTab');
    return { id: x.id, name, tip: x.url ? `${name} · ${x.url}` : name };
  });
  return (
    <>
      <TabStrip tabs={named} active={now.active} pick={pickTab} close={closeTab} add={newTab} lead={chip} t={t} />
      <div className="btabbody" role="tabpanel" aria-label={active.title || t('browserTabs.newTab')}>
        <BrowserView key={active.id} space={active.id} restore={active.url} insert={insert} to={to} annotate t={t} />
      </div>
    </>
  );
}

/** Ticket 328 part 2: an agent's space. With two or more agent tabs the strip lists them (page title, else host) and the
 *  owner shows any of them; the agent's own tab switches never move the owner's view (Orca's `navigation: 'caller'`). Nothing
 *  here is stored: the agent's session owns its tabs. */
function AgentTabs({ space, chip, insert, annotate, pane, t }: { space: string; chip: (mark: ReactNode) => ReactNode; insert?: (text: string) => void; annotate: boolean; pane?: string; t: T }) {
  const [list, setList] = useState<AgentList>({ tabs: [], current: 1 });
  const [pick, setPick] = useState<number | null>(null);
  useEffect(() => {
    if (!inApp()) return;
    let on = true;
    let timer = 0;
    // ponytail: polled (1 s) like `browser_nav`; an app event on open, switch and Forget if this ever shows in idle CPU.
    const tick = async () => {
      const now = await invoke<AgentList | null>('browser_tabs', { space }).catch(() => null);
      if (!on) return;
      if (Array.isArray(now?.tabs)) setList((was) => (JSON.stringify(was) === JSON.stringify(now) ? was : now!)); // an older app answers nothing usable
      timer = window.setTimeout(() => void tick(), 1000);
    };
    void tick();
    return () => {
      on = false;
      clearTimeout(timer);
    };
  }, [space]);
  const shown = shownTab(list, pick);
  useEffect(() => void (pick !== null && pick !== shown && setPick(shown)), [pick, shown]); // a closed pick stays on its fallback
  const name = (x: AgentList['tabs'][number]) => x.title || (x.url && hostOf(x.url)) || t('browserTabs.newTab');
  const strip = list.tabs.map((x) => ({ id: String(x.tab), name: name(x), tip: [name(x), x.url, x.tab === list.current && t('browserTabs.agentHere')].filter(Boolean).join(' · ') }));
  const label = strip.find((x) => x.id === String(shown))?.name;
  // Ticket 997 L7: while the agent is using the space (the app's word: a verb in the last 20 s) its tab carries the pointer and
  // the chip's dot is blue; while the owner has it, orange. The app draws the page's outline itself (agent.rs nav_state).
  const ctl = useControl(space);
  const driving = !!list.agent && !ctl.user;
  const dot = <i className={driving ? 'bsdot run' : ctl.user ? 'bsdot you' : 'bsdot'} />;
  return (
    <>
      {/* Ticket 328: no "+" or close here on purpose: the agent's session owns its tabs. */}
      <TabStrip tabs={strip} active={String(shown)} pick={(id) => setPick(Number(id))} lead={chip(dot)} agent={driving ? String(list.current) : undefined} t={t} />
      <div className="btabbody" {...(strip.length > 0 ? { role: 'tabpanel', 'aria-label': label } : {})}>
        <BrowserView key={shown} space={space} tab={shown} insert={insert} annotate={annotate} ctl={ctl} pane={pane} t={t} />
      </div>
    </>
  );
}
