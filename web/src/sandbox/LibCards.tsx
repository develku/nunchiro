// V2-10c (needs 91): one approval card per unpinned library, next to the Network chip. The list comes only from the
// app's parse of the served bytes (`LibsBridge.cards`); a frame message never adds, removes or answers a card.
// Every page-derived string (library, file, requester, messages) is a React text node.
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { makeT, type Key } from '../i18n'; // V2-14f
import { ARM_MS, MAX_CARDS, NOT_APP, UNREAD, POLL_MAX, POLL_MS, REASON, UNVERIFIED_HOVER, denied, entryFor, leaves, newestFirst, runtimeLoad, type LibCard, type LibCards, type LibsBridge } from './libs';
import { lineError, rawError } from '../errors';

export type T = (key: Key, args?: Record<string, string | number>) => string;
export const tEn: T = makeT('en', 'en');

interface Args {
  id: string;
  hash: string;
  /** The content key: denials last while it does (this view), whatever reloads Allow causes. */
  key: string;
  /** Changes on every frame load; the card list is asked again for each. */
  load: string;
  libs: LibsBridge;
  /** Reloads the frame (after Allow, "Open with", or an auto-allowed pin); "Open with" passes its one-view token. */
  reload: (view?: string) => void;
  t: T;
}

/** The cards' state for one frame. `notes` are display-only texts: denials (8), refusals (1-3), run-time loads (10). */
export function useLibCards({ id, hash, key, load, libs, reload, t }: Args) {
  const [got, setGot] = useState<{ load: string; v: LibCards } | null>(null);
  const [no, setNo] = useState<{ key: string; urls: string[] }>({ key, urls: [] });
  const [errors, setErrors] = useState<{ key: string; by: Record<string, string> }>({ key, by: {} });
  const [opened, setOpened] = useState<{ load: string; url: string; version: string } | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [runtime, setRuntime] = useState<{ key: string; urls: string[] }>({ key, urls: [] });
  const [unread, setUnread] = useState<string | null>(null);
  const current = useRef(load);
  current.current = load;

  useEffect(() => {
    let live = true;
    libs.cards(id, hash).then(
      (v) => live && setGot({ load, v }),
      // Outside the app nothing changes (no render: the page is as it was); a refusal in the app is said, not silent.
      (e: unknown) => live && !(e instanceof Error && rawError(e) === NOT_APP) && setUnread(load),
    );
    return () => {
      live = false;
    };
  }, [id, hash, load, libs]);

  // An auto-allowed fetch runs in the core with no card answer: ask again each second (40 at most), reload once it pins.
  const autos = got?.load === load ? got.v.cards.filter((c) => c.auto).length : 0;
  useEffect(() => {
    if (!autos) return;
    let n = 0;
    let live = true;
    const timer = setInterval(() => {
      if (++n > POLL_MAX) return clearInterval(timer);
      libs.cards(id, hash).then(
        (v) => {
          if (!live || v.cards.filter((c) => c.auto).length >= autos) return;
          live = false;
          clearInterval(timer);
          reload();
        },
        () => {},
      );
    }, POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [autos, id, hash, libs, reload]);

  const v = got?.load === load ? got.v : null;
  const noUrls = no.key === key ? no.urls : [];
  const errs = errors.key === key ? errors.by : {};
  const openedNow = opened?.load === load ? opened : null;
  const open = (v?.cards ?? []).filter((c) => !noUrls.includes(c.url) && c.url !== openedNow?.url);
  const fail = (url: string, e: unknown) => setErrors((x) => ({ key, by: { ...(x.key === key ? x.by : {}), [url]: rawError(e) } }));

  const answer = {
    // Owner-only: the window's core op, from this click alone.
    async allow(c: LibCard, requester: string) {
      setPending(c.url);
      try {
        await libs.allow(c.url, c.integrity, requester);
        reload();
      } catch (e) {
        fail(c.url, e);
      } finally {
        setPending(null);
      }
    },
    deny(c: LibCard) {
      setNo((x) => ({ key, urls: [...(x.key === key ? x.urls : []), c.url] }));
    },
    async openWith(c: LibCard, version: string, next: string) {
      const asked = current.current;
      setPending(c.url);
      try {
        const e = entryFor(c, version, (await libs.list()).entries);
        if (!e) throw new Error(t('approval.libNoLongerPinned', { library: c.library, version }));
        // Another reload (an Allow, an auto-allowed pin) came first: the one-view state would go to the wrong load.
        if (current.current !== asked) throw new Error(t('approval.libReloaded'));
        const view = await libs.openWith(id, hash, c.url, e.sha384);
        // The app serves the pinned bytes for the next load only, the one carrying `view`; the card returns after it.
        setOpened({ load: next, url: c.url, version });
        reload(view);
      } catch (e) {
        fail(c.url, e);
      } finally {
        setPending(null);
      }
    },
  };

  /** Text 10 from a CSP report (display only; `url` is already on one of the five hosts). Stable, so the frame's one
   *  message listener is not registered again on each render. */
  const report = useCallback(
    (url: string) =>
      setRuntime((x) => {
        const urls = x.key === key ? x.urls : [];
        // A flood of forged reports stays bounded.
        return urls.includes(url) || urls.length >= 64 ? x : { key, urls: [...urls, url] };
      }),
    [key],
  );
  // A blocked tag that has its card or refusal already says why; text 10 is for what the page loads while it runs.
  const tagged = new Set([...(v?.cards ?? []), ...(v?.refused ?? [])].map((x) => x.url));
  const notes = [
    ...(v?.cards ?? []).filter((c) => noUrls.includes(c.url)).map((c) => denied(c)),
    ...(openedNow ? [t('approval.libOpenedWith', { version: openedNow.version })] : []),
    ...(v?.refused ?? []).map((r) => r.message),
    ...(unread === load ? [UNREAD] : []),
    // Only once this load's card list is in: before it, a blocked tag's report would read as a run-time load.
    ...(v ? hostsOf((runtime.key === key ? runtime.urls : []).filter((u) => !tagged.has(u))).map(runtimeLoad) : []),
  ];
  return {
    cards: open,
    notes,
    errors: errs,
    pending,
    answer,
    report,
  };
}

const hostsOf = (urls: string[]) => [...new Set(urls.map((u) => new URL(u).hostname))];

export type LibState = ReturnType<typeof useLibCards>;

/** `requester`: the session or widget the caller names; never the page's own title (it is page-controlled). */
export function LibsPanel({ s, requester, nextLoad, t = tEn }: { s: LibState; requester: string | undefined; nextLoad: string; t?: T }) {
  const shown = s.cards.slice(0, MAX_CARDS);
  const rawId = useId();
  const more = s.cards.length - shown.length;
  // A card that just appeared or moved (the panel opening, the next card sliding in, a scroll, a page resizing itself
  // so the panel shifts under a resting pointer) cannot be answered by a click already on its way: the buttons arm
  // ARM_MS after the panel last stood still, as browser permission prompts do.
  const box = useRef<HTMLDivElement>(null);
  const [armed, setArmed] = useState<{ at: string; spot: string } | null>(null);
  const [moves, setMoves] = useState(0);
  const at = shown.map((c) => c.url).join(' ');
  const spot = () => {
    const r = box.current?.getBoundingClientRect();
    return r ? `${r.left},${r.top}` : '';
  };
  const moved = useCallback(() => {
    setArmed(null);
    setMoves((m) => m + 1);
  }, []);
  useEffect(() => {
    const t = setTimeout(() => setArmed({ at, spot: spot() }), ARM_MS);
    return () => clearTimeout(t);
  }, [at, moves]);
  useEffect(() => {
    window.addEventListener('scroll', moved, true);
    window.addEventListener('resize', moved);
    return () => {
      window.removeEventListener('scroll', moved, true);
      window.removeEventListener('resize', moved);
    };
  }, [moved]);
  const ready = armed?.at === at;
  // A shift no scroll event reports (content above it grew): the click finds the panel elsewhere and only re-arms.
  const still = () => (armed?.spot === spot() ? true : (moved(), false));
  return (
    <div className="af-libs" role="region" aria-label={t('approval.libRegion')} ref={box}>
      {shown.length > 0 && (
        <ul className="af-lib-list">
          {shown.map((c) => {
            // Q9 en-b-J4-1: the tag's own `integrity` names its version, so another one would fail the SRI check unseen.
            const others = c.integrity ? [] : newestFirst(c.other_versions);
            const busy = s.pending === c.url || !ready;
            return (
              <li key={c.url} className="af-lib light-you light-edge" data-url={c.url}>
                <div className="af-lib-head">
                  <span className="af-lib-name">
                    {c.library} {c.version}
                    {others.length > 0 && t('approval.libAllowedOther', { version: others[0] })}
                  </span>
                  <span className="af-badge" data-badge={c.listed ? 'listed' : 'unverified'} title={c.listed ? undefined : UNVERIFIED_HOVER}>
                    {c.listed ? t('approval.libListed', { source: 'cdnjs' }) : t('approval.libUnverified')}
                  </span>
                </div>
                <div className="af-lib-line">
                  <span className="af-lib-file">{c.file}</span> · {c.host}
                </div>
                <div className="af-lib-line">{requester ? t('approval.askedBy', { requester }) : t('approval.askedByNone')}</div>
                <div className="af-lib-line af-dim">{REASON}</div>
                <div className="af-lib-line af-dim">{leaves(c.host)}</div>
                {/* Ticket 480: a refusal reads plainly; its raw reason is the tooltip. Ticket 553: and the description. */}
                <div className="af-lib-line af-lib-msg" role={s.errors[c.url] ? 'alert' : undefined} title={s.errors[c.url]} aria-describedby={s.errors[c.url] ? `${rawId}${encodeURIComponent(c.url)}` : undefined}>
                  {s.errors[c.url] ? lineError(t, s.errors[c.url]) : c.auto ? t('approval.libAuto') : c.message}
                </div>
                {s.errors[c.url] && (
                  <span hidden id={`${rawId}${encodeURIComponent(c.url)}`}>
                    {s.errors[c.url]}
                  </span>
                )}
                <div className="af-lib-acts">
                  <button type="button" className="af-chip" disabled={busy} onClick={() => still() && void s.answer.allow(c, requester ?? '')}>
                    {s.pending === c.url ? t('approval.libAllowing') : t('approval.libAllow')}
                  </button>
                  <button type="button" className="af-chip" disabled={busy} onClick={() => still() && s.answer.deny(c)}>
                    {t('approval.libDeny')}
                  </button>
                  {others.map((ver) => (
                    <button key={ver} type="button" className="af-chip" disabled={busy} onClick={() => still() && void s.answer.openWith(c, ver, nextLoad)}>
                      {t('approval.libOpenWith', { version: ver })}
                    </button>
                  ))}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {more > 0 && <p className="af-lib-more">{more === 1 ? t('approval.libMoreOne') : t('approval.libMoreMany', { n: more })}</p>}
      {s.notes.map((n, i) => (
        <p key={i} className="af-lib-note">
          {n}
        </p>
      ))}
    </div>
  );
}
