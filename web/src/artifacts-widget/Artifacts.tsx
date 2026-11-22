// Artifacts (◧) widget (ticket v1b-13, spec B2, R8 frame 1): per session, "This session" lists attachments and artifacts
// from the chat events this window holds, each opening Preview in one click; "Files changed" lists Diff's own changed
// files with `+n −m`, each opening Diff at that path. Rows have a fixed height in a virtual list, so 300 entries or
// one arriving while the list is scrolled move nothing on screen (needs 26).
import { useVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useId, useMemo, useRef, useState } from 'react'; // v1b-28: useId
import type { Boot, CoreClient } from '../api';
import { ICON, openInFiles, PROBLEM, PROBLEM_TEXT } from '../artifacts/Card';
import { select } from '../artifacts/store';
import { loadContent, useWatched } from '../artifacts/watch';
import { chatFeed, type ChatEvent } from '../chat/feed';
import { mergeEvents } from '../chat/model';
import { counts, ext, listState, openDiff, truncatedNote, type DiffList } from '../diff/Diff';
import { fileOf, Thumbnail } from '../images/Thumbnail';
import type { T } from '../i18n';
import { ErrorDetails, rawError } from '../errors';
import { askNew } from '../NewSession';
import { entries, type Entry } from './model';
import './artifacts-widget.css';

export const ROW = 40;

type Held = { session: string | null; generation: number | null; events: ChatEvent[]; error?: string };

/** The session's chat events: the newest page, then live pages, on 03's shared socket. */
function useEvents(boot: Boot, session: string | null) {
  const [held, setHeld] = useState<Held>({ session, generation: null, events: [] });
  const at = useRef(new Map<number, number>());
  useEffect(() => {
    at.current = new Map();
    setHeld({ session, generation: null, events: [] });
    if (!session) return;
    return chatFeed(boot).open(session, {
      page: (p, kind) => {
        // Fail closed on a schema this window was not built for, as the chat view does.
        if (p.schema_version !== 1) return setHeld({ session, generation: null, events: [], error: `chat schema ${p.schema_version} is not supported by this window` });
        const fresh = (h: Held) => kind === 'reset' || h.generation !== p.generation;
        if (kind === 'reset') at.current = new Map();
        if (kind === 'live') for (const e of p.events) if (!at.current.has(e.cursor)) at.current.set(e.cursor, Date.now());
        setHeld((h) => (fresh(h) ? { session, generation: p.generation, events: p.events } : { ...h, events: mergeEvents(h.events, p.events), error: undefined }));
      },
      error: (error) => setHeld((h) => ({ ...h, error })),
    });
  }, [boot, session]);
  // A focus switch shows the new session's (empty) list in the same render, never the old one's.
  return held.session === session ? { events: held.events, error: held.error, at: at.current } : { events: [], at: at.current };
}

/** Diff's `diff_list`, asked on open, on window focus and when the chat shows another edit. */
function useChanges(core: CoreClient, session: string | null, edits: number) {
  const [got, setGot] = useState<{ session: string | null; list: DiffList | null; error: string }>({ session, list: null, error: '' });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const on = () => setTick((t) => t + 1);
    window.addEventListener('focus', on);
    return () => window.removeEventListener('focus', on);
  }, []);
  useEffect(() => {
    if (!session) return;
    let live = true;
    core
      .request({ op: 'diff_list', session })
      .then((r) => live && setGot({ session, list: r as DiffList, error: '' }))
      .catch((e: Error) => live && setGot({ session, list: null, error: rawError(e) }));
    return () => {
      live = false;
    };
  }, [core, session, edits, tick]);
  return got.session === session ? got : { list: null, error: '' };
}

const hhmm = (ms?: number) => (ms ? ` · ${new Date(ms).toTimeString().slice(0, 5)}` : '');

// Ticket 960: a pasted image's saved name is its sha256 and a base64 one is "png image"; both read as "<type> image".
const SAVED_OR_BYTES = /^(?:[0-9a-f]{64}\.(\w+)|(\w+) image)$/;
const shownName = (e: Entry, t: T) => {
  const m = e.label === 'attachment' ? SAVED_OR_BYTES.exec(e.name) : null;
  return m ? t('artifactsWidget.image', { type: m[1] ?? m[2] }) : e.name;
};

function Name({ e, t, extra }: { e: Entry; t: T; extra?: React.ReactNode }) {
  return (
    <span className="awname">
      <span className="awn" dir="auto">
        {shownName(e, t)}
      </span>
      <span className="m">
        {t(e.label === 'attachment' ? 'artifactsWidget.label.attachment' : 'artifactsWidget.label.byAgent')}
        {hhmm(e.at)}
        {extra}
      </span>
    </span>
  );
}

/** An agent's file: 06's state word, and 06's card click (Preview, Files for one over 2 MB, nothing otherwise). */
function ArtifactRow({ session, e, t }: { session: string; e: Extract<Entry, { label: 'by agent' }>; t: T }) {
  const w = useWatched(e.target, loadContent);
  const problem = w.status === 'ready' || w.status === 'loading' ? null : w.status;
  const click = !problem ? () => select(session, e.target) : problem === 'too_large' ? () => openInFiles(e.target) : undefined;
  const why = useId();
  return (
    <>
      <button type="button" className="it" data-state={w.status} title={problem ? PROBLEM_TEXT[problem] : e.target.path} disabled={!click} onClick={click} aria-describedby={problem && !click ? why : undefined}>
        <span className="ic" aria-hidden>
          {ICON[e.kind]}
        </span>
        <Name
          e={e}
          t={t}
          extra={
            problem && (
              <>
                {' · '}
                <span className="astate" data-problem={problem}>
                  {PROBLEM[problem]}
                </span>
              </>
            )
          }
        />
      </button>
      {/* v1b-28: a disabled row names its reason to screen readers, not only in its tooltip (aria-describedby) */}
      {problem && !click && (
        <span id={why} className="sr">
          {PROBLEM_TEXT[problem]}
        </span>
      )}
    </>
  );
}

/** An attachment: 05's thumbnail (or its placeholder); a file opens in Preview, bytes in 05's viewer. */
function ImageRow({ session, e, t }: { session: string; e: Extract<Entry, { label: 'attachment' }>; t: T }) {
  const thumb = useRef<HTMLSpanElement>(null);
  const f = fileOf(e.source);
  const click = f
    ? () => select(session, { ...f, type: 'image', title: e.name })
    : e.source.type === 'path'
      ? undefined
      : () => thumb.current?.querySelector<HTMLButtonElement>('button')?.click();
  const why = useId();
  return (
    <>
      <span ref={thumb} className="awthumb">
        <Thumbnail source={e.source} />
      </span>
      <button type="button" className="it" title={f?.path ?? e.name} disabled={!click} onClick={click} aria-describedby={!click ? why : undefined}>
        <Name e={e} t={t} />
      </button>
      {/* v1b-28: a disabled attachment's reason (aria-describedby), in ticket V1B-05's placeholder wording */}
      {!click && (
        <span id={why} className="sr">
          {t('rest.widgets.artifacts.outside')}
        </span>
      )}
    </>
  );
}

function SessionList({ session, list, error, t }: { session: string; list: Entry[]; error?: string; t: T }) {
  const scroller = useRef<HTMLUListElement>(null);
  const v = useVirtualizer({ count: list.length, getScrollElement: () => scroller.current, estimateSize: () => ROW, getItemKey: (i) => list[i].key, overscan: 6 });
  if (!list.length)
    return (
      <p className="awempty" role="status">
        {error ? t('artifactsWidget.eventsError', { error }) : t('artifactsWidget.noItems')}
      </p>
    );
  return (
    <>
      {error && (
        <p className="awnote" role="status">
          {t('artifactsWidget.eventsError', { error })}
        </p>
      )}
      <ul ref={scroller} className="awlist" aria-label={t('artifactsWidget.thisSession')} style={{ maxHeight: list.length * ROW }}>
        <li aria-hidden className="awspace" style={{ height: v.getTotalSize() }} />
        {v.getVirtualItems().map((r) => {
          const e = list[r.index];
          return (
            <li key={r.key} className="awrow" data-key={e.key} data-label={e.label} style={{ transform: `translateY(${r.start}px)` }}>
              {e.label === 'attachment' ? <ImageRow session={session} e={e} t={t} /> : <ArtifactRow session={session} e={e} t={t} />}
            </li>
          );
        })}
      </ul>
    </>
  );
}

function Changes({ session, list, error, t }: { session: string; list: DiffList | null; error: string; t: T }) {
  const state = listState(session, list, error, t);
  if (state)
    return (
      <div className="awempty" role="status">
        {state}
        <ErrorDetails t={t} details={error} />
      </div>
    );
  return (
    <>
      {list!.base?.kind === 'no_commits' && <p className="awnote">{t('rest.widgets.artifacts.emptyRepo')}</p>}
      <ul className="awfiles" aria-label={t('artifactsWidget.filesChanged')}>
        {/* B21 (ticket 991): Python's bytecode cache is build output, never an artifact of the session. */}
        {list!.files.filter((f) => !/(^|\/)__pycache__\//.test(f.path)).map((f) => (
          <li key={f.path}>
            {/* needs 172: the row fills the list, so a long path is cut by its own ellipsis (and `data-tip-clip` shows it whole); the width is in artifacts-widget.css */}
            <button type="button" className="it" data-path={f.path} onClick={() => openDiff(f.path)}>
              <span className="ic" aria-hidden>
                {ext(f.path)}
              </span>
              <span className="awname">
                <span className="awn mono" dir="auto" data-tip={f.path} data-tip-clip="">
                  {f.path}
                </span>
                <span className="m">
                  {counts(f) && <>{counts(f)} · </>}{t('rest.widgets.artifacts.openInDiff')}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      {list!.truncated && (
        <p className="awnote" role="note">
          {truncatedNote(list!.files.length)}
        </p>
      )}
    </>
  );
}

/** Beside the right icon bar (◧) with `onClose`; inside a layout zone (gallery widget) without it. */
export function Artifacts({ boot, core, session, label, onClose, t }: { boot: Boot; core: CoreClient; session: string | null; label: string; onClose?: () => void; t: T }) {
  const { events, error, at } = useEvents(boot, session);
  const list = useMemo(() => (session ? entries(session, events, at) : []), [session, events, at]);
  const edits = useMemo(() => events.filter((e) => e.data.kind === 'edit').length, [events]);
  const changes = useChanges(core, session, edits);
  return (
    <aside className={`${onClose ? 'dock r' : 'dock zone'} aw`} aria-label={t('rest.widgets.artifacts.title')}>
      <div className="ph">
        <span className="grip" aria-hidden>
          ⋮⋮
        </span>
        <span className="pt">{t('rest.widgets.artifacts.title')}</span>
        <span className="r">{session ? label : ''}</span>
        {onClose && (
          <button type="button" className="awclose" aria-label={t('rest.widgets.artifacts.closeAria')} data-tip={t('rest.widgets.close')} data-tip-cmd="artifacts.toggle" onClick={onClose}>
            ×
          </button>
        )}
      </div>
      {!session ? (
        <p className="awempty" role="status">
          {t('artifactsWidget.noSession')}{' '}
          <button type="button" className="btn" onClick={() => askNew()}>
            {t('empty.startSession')}
          </button>
        </p>
      ) : (
        <>
          <div className="sec">{t('artifactsWidget.thisSession')}</div>
          <SessionList session={session} list={list} error={error} t={t} />
          <div className="sec">{t('artifactsWidget.filesChanged')}</div>
          <Changes session={session} list={changes.list} error={changes.error} t={t} />
        </>
      )}
    </aside>
  );
}
