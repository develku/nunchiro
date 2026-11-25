// Preview (▶, ticket v1b-06, spec B3): the selected artifact, image or file at full size. HTML and SVG run in 04's
// sandbox frame; Markdown renders with the chat's renderer (raw HTML escaped, links only through the browser path,
// no image loaded); an image shows from its bytes. Read on view; "changed" when the file changes afterwards.
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { Md } from '../chat/Rows';
import { Icon } from '../icons/Icon';
import { ArtifactFrame } from '../sandbox/ArtifactFrame';
import { useHtmlLangT } from '../i18n/lib/useHtmlLangT';
import { Changed, PROBLEM_TEXT, StateBar } from './Card';
import { host, type Target } from './host';
import { setDock, useSelection } from './store';
import { keepComposerClear } from '../pane/composerRoom';
import { loadContent, loadFrame, useWatched, type Watched } from './watch';
import './artifacts.css';

function Status({ t, w }: { t: Target; w: Exclude<Watched<unknown>, { status: 'ready' }> }) {
  return (
    <div className="pv-state" data-state={w.status}>
      <StateBar t={t} w={w} className="pv-bar" />
      {w.status !== 'loading' && <p className="dim">{PROBLEM_TEXT[w.status]}</p>}
    </div>
  );
}

/** `label`: the session the Preview follows, as the tree names it (the library card's "Asked by"). */
function FramePreview({ t, label }: { t: Target; label?: string }) {
  const w = useWatched(t, loadFrame);
  const h = host();
  if (w.status !== 'ready') return <Status t={t} w={w} />;
  return (
    <div className="pv-frame" data-hash={w.shown.hash}>
      <ArtifactFrame artifact={w.shown} title={t.title} maxHeight={100_000} srcFor={h.src} grant={h.grant} actions={<Changed w={w} />} requester={label || undefined} />
    </div>
  );
}

function ContentPreview({ t }: { t: Target }) {
  const w = useWatched(t, loadContent);
  if (w.status !== 'ready') return <Status t={t} w={w} />;
  return (
    <div className="pv-content">
      <div className="pv-bar">
        <span className="af-title" dir="auto">
          {t.title}
        </span>
        <Changed w={w} />
      </div>
      <div className="pv-body">{'text' in w.shown ? <Md text={w.shown.text} /> : <img src={w.shown.image} alt={t.title} />}</div>
    </div>
  );
}

// Ticket 1088: what each mounted Preview shows, so the Artifacts widget can mark it; a host that closes unmounts its Preview.
const shown = new Map<string, number>();
const shownSubs = new Set<() => void>();
const shownKey = (session: string, t: Pick<Target, 'root' | 'path'>) => `${session}\n${t.root}\n${t.path}`;
const count = (k: string, by: number) => {
  const n = (shown.get(k) ?? 0) + by;
  if (n > 0) shown.set(k, n);
  else shown.delete(k);
  shownSubs.forEach((f) => f());
};
/** True while a Preview shows `t` for `session`. */
export const useShownInPreview = (session: string, t: Pick<Target, 'root' | 'path'>) =>
  useSyncExternalStore(
    (f) => (shownSubs.add(f), () => void shownSubs.delete(f)),
    () => shown.has(shownKey(session, t)),
  );

/** `onClose`: what removes the host (side pane 1058; zone, split, sidebar 1084). The bar shows with or without an artifact. */
export function Preview({ session, label, onClose }: { session: string | null; label?: string; onClose?: () => void }) {
  const sel = useSelection(session);
  const words = useHtmlLangT(); // ticket 508
  const key = session && sel ? shownKey(session, sel) : null;
  useEffect(() => {
    if (!key) return;
    count(key, 1);
    return () => count(key, -1);
  }, [key]);
  // Ticket 1093: in every host (side pane, session split, layout zone, sidebar, dock) the composer stays out of the Preview.
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => (box.current ? keepComposerClear(box.current) : undefined), []);
  return (
    <div className="preview" ref={box} data-path={sel?.path}>
      {onClose && (
        <div className="pv-bar pv-top" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
          <button type="button" className="pclose" aria-label={words('rest.widgets.preview.closeAria')} onClick={onClose}>
            <Icon name="x" size={12} />
          </button>
        </div>
      )}
      {!sel ? (
        <div className="empty">{words('rest.widgets.preview.empty')}</div>
      ) : sel.type === 'html' || sel.type === 'svg' ? (
        <FramePreview key={`${sel.root}:${sel.path}`} t={sel} label={label} />
      ) : (
        <ContentPreview key={`${sel.root}:${sel.path}`} t={sel} />
      )}
    </div>
  );
}

/** The right dock (R8 frame 1, ▶ in the right bar) for a layout without a Preview zone. */
export function PreviewDock({ session, label }: { session: string | null; label: string }) {
  const words = useHtmlLangT(); // ticket 508
  return (
    <aside className="dock r pdock" aria-label={words('rest.widgets.preview.title')}>
      <div className="ph">
        {words('rest.widgets.preview.title')}<span className="r">{label}</span>
        <button type="button" className="pclose" aria-label={words('rest.widgets.preview.closeAria')} onClick={() => setDock(false)}>
          ×
        </button>
      </div>
      <Preview session={session} label={label} />
    </aside>
  );
}
