// The reusable sandboxed frame (spec v1b B2; web widgets reuse it). The page is served by the app's
// artifact-only scheme with CSP response headers; the iframe adds `sandbox="allow-scripts"` and nothing else.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { appGrant } from './grant';
import { LibsPanel, tEn, useLibCards, type T } from './LibCards';
import { libsBridge, runtimeLoadUrl, type LibsBridge } from './libs';
import { openExternal, webUrl } from './link';
import { artifactUrl, withView } from './url';
import './sandbox.css';

/** The content seam: an id the app can resolve to bytes, and a hash that changes when they do. */
export interface ArtifactSource {
  id: string;
  hash: string;
}

export interface ArtifactFrameProps {
  artifact: ArtifactSource;
  title?: string;
  /** The per-project "always allow network" setting, already resolved by the caller. */
  alwaysAllow?: boolean;
  /** Offered after a grant so the caller can store the per-project setting. */
  onAlwaysAllow?: () => void;
  /** Frame height cap in px (the chat card uses 320); the page's own height is followed up to it. */
  maxHeight?: number;
  /** Overridable for tests; the app's scheme, `invoke` grant and the user's browser by default. */
  srcFor?: (id: string) => string;
  grant?: (id: string, hash: string) => Promise<void>;
  openLink?: (url: string) => void;
  /** v1b-06: the chat card's and Preview's buttons (Open, "changed"), in the frame's bar after the title. */
  actions?: ReactNode;
  /** V2-10c: the session or widget whose page asks for a library (the card's "Asked by"). Never the title: that is the page's. */
  requester?: string;
  /** V2-10c: the app's card list and "Open with", the core's Allow; overridable for tests. */
  libs?: LibsBridge;
  /** V2-14f: the window's catalogue lookup; English when the caller passes none. */
  t?: T;
}

const OPEN_GAP_MS = 2000;

// Module level: an inline default would be a new function every render, and the message effect lists `openLink` in its deps,
// so it would remove and add the same handler on each parent render.
const openLinkDefault = (u: string) => void openExternal(u);

export function ArtifactFrame({
  artifact,
  title,
  alwaysAllow = false,
  onAlwaysAllow,
  maxHeight = 4000,
  srcFor = artifactUrl,
  grant = appGrant,
  openLink = openLinkDefault,
  actions, // v1b-06
  requester,
  libs = libsBridge(),
  t = tEn,
}: ArtifactFrameProps) {
  const key = `${artifact.id}:${artifact.hash}`;
  const frame = useRef<HTMLIFrameElement>(null);
  // Keys, not booleans: a content change makes every one of these stale at once, which is the reset.
  const [clicked, setClicked] = useState<string | null>(null);
  const [granted, setGranted] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [height, setHeight] = useState<{ key: string; px: number } | null>(null);
  // Which iframe holds focus, by its key. The iframe element gets no focus or blur event and never matches :focus while
  // the page inside holds focus; the parent window does see blur (focus went into the frame) and focus (it came back)
  // with the iframe as activeElement. Nothing is sent into the frame. A remount makes the key stale.
  const [focused, setFocused] = useState<string | null>(null);
  const lastOpen = useRef(0);
  const wantNet = alwaysAllow || clicked === key;
  const wide = granted === key;
  // V2-10c: Allow, "Open with" and an auto-allowed pin reload the frame; a content change starts the count afresh.
  // V2-38: "Open with" gives its token to the one load it reloads; the next reload goes without. A remount in between
  // (a grant) replays the spent token, which the app answers with the plain page.
  const [loads, setLoads] = useState<{ key: string; n: number; view?: string }>({ key, n: 0 });
  const n = loads.key === key ? loads.n : 0;
  const view = loads.key === key ? (loads.view ?? null) : null;
  const frameKey = `${key}:${wide}:${n}`;
  const reload = useCallback((view?: string) => setLoads((l) => ({ key, n: (l.key === key ? l.n : 0) + 1, view })), [key]);
  const lib = useLibCards({ id: artifact.id, hash: artifact.hash, key, load: `${key}:${n}`, libs, reload, t });
  const libReport = lib.report;
  // Cards never appear over or shift what the pointer or keyboard is on (needs 26, 49): while either is in this frame
  // the bar's chip counts them, and the cards open when both have left or the chip is pressed. A ref, so a frame with
  // nothing waiting renders exactly as before.
  const inside = useRef({ pointer: false, focus: false });
  const [, setSensed] = useState(0);
  const [panel, setPanel] = useState<{ key: string; open: boolean } | null>(null);

  useEffect(() => {
    if (!wantNet || granted === key) return;
    let live = true;
    grant(artifact.id, artifact.hash).then(
      () => live && setGranted(key),
      () => live && setFailed(key),
    );
    return () => {
      live = false;
    };
  }, [wantNet, granted, key, artifact.id, artifact.hash, grant]);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const f = frame.current;
      if (!f || e.source !== f.contentWindow) return;
      const d = e.data as { type?: unknown; url?: unknown; height?: unknown } | null;
      if (d?.type === 'nunchiro:height' && typeof d.height === 'number' && Number.isFinite(d.height)) {
        setHeight({ key, px: Math.max(0, Math.min(Math.ceil(d.height), maxHeight)) });
      } else if (d?.type === 'nunchiro:csp-violation') {
        // Page-controlled and forgeable: text 10 for one of the five hosts, never a card, a fetch or a policy change.
        const u = runtimeLoadUrl(d);
        if (u) libReport(u.href);
      } else if (d?.type === 'nunchiro:open-link') {
        // The frame may ask, the window decides: public http(s) hosts only, only while the user is inside the
        // frame and has just clicked (activation reaches this window from the child frame), and not in bursts.
        // Page script and bootstrap share one realm, so a click anywhere in the page still lets the page ask.
        const url = webUrl(d.url);
        const now = Date.now();
        const clicked = navigator.userActivation ? navigator.userActivation.isActive : true;
        if (!url || !clicked || document.activeElement !== f || now - lastOpen.current < OPEN_GAP_MS) return;
        lastOpen.current = now;
        openLink(url);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [key, maxHeight, openLink, libReport]);

  useEffect(() => {
    const sync = () => setFocused(document.activeElement === frame.current ? frameKey : null);
    sync();
    window.addEventListener('blur', sync);
    window.addEventListener('focus', sync);
    return () => {
      window.removeEventListener('blur', sync);
      window.removeEventListener('focus', sync);
    };
  }, [frameKey]);

  const libItems = lib.cards.length + lib.notes.length;
  const sense = (k: 'pointer' | 'focus', v: boolean) => {
    inside.current[k] = v;
    if (libItems && panel?.key !== key) setSensed((n) => n + 1);
  };
  const frozen = inside.current.pointer || inside.current.focus || focused === frameKey;
  useEffect(() => {
    if (libItems && !frozen && panel?.key !== key) setPanel({ key, open: true });
  }, [libItems, frozen, panel, key]);
  const panelOpen = libItems > 0 && panel?.key === key && panel.open;

  // With "always allow" the first load waits for the grant, so the page never starts under the narrow policy.
  const holding = alwaysAllow && !wide && failed !== key;
  const px = height?.key === key ? height.px : undefined;
  return (
    <div
      className="artifact-frame"
      data-artifact={artifact.id}
      data-net={wide ? 'on' : 'off'}
      data-focus={focused === frameKey ? '' : undefined}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.target === e.currentTarget && e.key === 'Enter') frame.current?.focus();
      }}
      onPointerEnter={() => sense('pointer', true)}
      onPointerLeave={() => sense('pointer', false)}
      // Focus on the container itself sits above where the cards open; only a bar control or the page holds them.
      onFocus={(e) => sense('focus', e.target !== e.currentTarget)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) sense('focus', false);
      }}
    >
      <div className="af-bar">
        <span className="af-title">{title ?? artifact.id}</span>
        {/* Right after the title, which gives up the width: nothing to its right moves when it appears (needs 26, 49). */}
        {libItems > 0 && (
          <button type="button" className="af-chip af-libs-chip" aria-expanded={panelOpen} onClick={() => setPanel({ key, open: !panelOpen })}>
            {lib.cards.length ? t(lib.cards.length === 1 ? 'widget.libsToAllowOne' : 'widget.libsToAllowMany', { n: lib.cards.length }) : t('widget.libs')}
          </button>
        )}
        {actions /* v1b-06 */}
        {wide && onAlwaysAllow && !alwaysAllow && (
          <button type="button" className="af-chip" onClick={onAlwaysAllow}>
            {t('widget.alwaysAllow')}
          </button>
        )}
        <button
          type="button"
          className="af-chip"
          data-state={wide ? 'on' : 'off'}
          aria-pressed={wide}
          disabled={wide || (wantNet && failed !== key)}
          title={
            failed === key
              ? t('widget.netRefused')
              : wide
                ? t('widget.netOnTip')
                : t('widget.netOffTip')
          }
          onClick={() => setClicked(key)}
        >
          {wide ? t('widget.netOn') : t('widget.netOff')}
        </button>
      </div>
      {panelOpen && <LibsPanel s={lib} requester={requester} nextLoad={`${key}:${n + 1}`} t={t} />}
      {!holding && (
        <iframe
          key={frameKey}
          ref={frame}
          title={title ?? artifact.id}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          src={withView(srcFor(artifact.id), view)}
          style={px === undefined ? { height: Math.min(160, maxHeight) } : { height: px }}
        />
      )}
    </div>
  );
}
