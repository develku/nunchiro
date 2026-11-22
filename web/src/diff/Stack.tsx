// Ticket 374: every changed file in one scrolling view, one PatchView per file. Only the sections near the viewport
// are mounted (react-virtual), and a section asks the core for its patch when it mounts, so a 2000-file list stays
// cheap. Stacking pattern after Orca's combined PR diff viewer (pattern only; that file is Monaco-based).
import { useVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CoreClient } from '../api';
import { COLLAPSE, HIDE_WHITESPACE, WRAP } from '../features/diff-options';
import { openFileAt } from '../files/open';
import type { T } from '../i18n';
import { useFeatureSetting } from '../settings/useFeatureSetting';
import { counts, diffRequest, type Change, type Patch } from './Diff';
import { areAllDiffFilesCollapsed, toggleAllDiffFiles } from './diffCollapse';
import { PatchView } from './PatchView';
import './stack.css';
import { rawError } from '../errors';

const MODE_KEY = 'nunchiro.diffMode';
function storedMode(): 'unified' | 'split' {
  try {
    return localStorage.getItem(MODE_KEY) === 'split' ? 'split' : 'unified';
  } catch {
    return 'unified';
  }
}

type Got = { patch: Patch | null; error: string };
/** A patch read waiting its turn; `live` is false once its file scrolled away or the view closed. */
type Read = { live: () => boolean; run: () => Promise<void> };
const HEAD = 27; // a file header's height
const LINE = 17; // a code row's height (diff.css .dl line-height)

/** `at` is the file the list chose; a new `jump` scrolls to it again (a click on the file already chosen). `machine`
 *  sends the reads over Remote (an SSH session), `branch` reads the Branch scope's patches, and a new `force` (Refresh)
 *  re-reads every mounted file. */
export function Stack({ core, session, machine, branch, force, files, at, jump, t, quote }: { core: CoreClient; session: string; machine?: string; branch: boolean; force: number; files: Change[]; at: string | null; jump: number; t: T; quote?: (text: string) => void }) {
  const [mode, setMode] = useState(storedMode);
  const [ws, setWs] = useFeatureSetting(HIDE_WHITESPACE);
  const [wrap, setWrap] = useFeatureSetting(WRAP);
  const [collapse, setCollapse] = useFeatureSetting(COLLAPSE);
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  // Patches by path. A re-read list keeps the old patch on screen until the new one arrives, so nothing jumps.
  const [got, setGot] = useState<Map<string, Got>>(new Map());
  const scroller = useRef<HTMLDivElement>(null);
  // One patch read at a time: the window's requests reach the core in order, so a burst of reads (every mounted file)
  // would hold the list's own re-read behind it. A read whose file left the view is dropped before it is sent.
  const reads = useRef<{ busy: boolean; queue: Read[] }>({ busy: false, queue: [] });
  const ask = (r: Read) => {
    const q = reads.current;
    q.queue.push(r);
    const next = () => {
      let job: Read | undefined;
      while ((job = q.queue.shift()) && !job.live());
      if (!job) return void (q.busy = false);
      q.busy = true;
      void job.run().finally(next);
    };
    if (!q.busy) next();
  };
  const keys = files.map((f) => f.path);
  // The file at the top of the view and how far into it the view starts. A re-read list that adds or drops files
  // above it (window focus, every 30 s, a finished turn) would move the text under the reader, so until the reader
  // scrolls, clicks or types, every render puts that file back at the same offset, read from the DOM: the
  // virtualizer's own correction treats a newly listed file's first measure as a resize and moves the view the wrong
  // way, and its positions lag a render behind.
  const anchor = useRef<{ key: string; offset: number } | null>(null);
  const restoring = useRef(false);
  const order = keys.join('\u0000');
  const listed = useRef(order);
  if (listed.current !== order) {
    listed.current = order;
    restoring.current = !!anchor.current;
  }
  const v = useVirtualizer({
    count: files.length,
    getScrollElement: () => scroller.current,
    estimateSize: (i) => HEAD + (closed.has(files[i].path) ? 0 : ((files[i].additions ?? 0) + (files[i].deletions ?? 0) + 4) * LINE),
    getItemKey: (i) => files[i].path,
    overscan: 3,
  });
  // Otherwise close to the library's rule: keep the view when a file above it changes size while scrolling down.
  v.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, inst) => !restoring.current && item.start < (inst.scrollOffset ?? 0) && inst.scrollDirection !== 'backward';
  const remember = () => {
    const el = scroller.current;
    if (!el || restoring.current) return;
    const top = el.getBoundingClientRect().top;
    const sec = [...el.querySelectorAll<HTMLElement>('.dsec')].find((x) => x.getBoundingClientRect().bottom > top);
    anchor.current = sec ? { key: sec.dataset.key!, offset: top - sec.getBoundingClientRect().top } : null;
  };
  const release = () => {
    restoring.current = false;
  };
  useLayoutEffect(() => {
    const a = anchor.current;
    const el = scroller.current;
    if (!restoring.current || !a || !el) return;
    const sec = [...el.querySelectorAll<HTMLElement>('.dsec')].find((x) => x.dataset.key === a.key);
    if (!sec) return;
    const drift = el.getBoundingClientRect().top - sec.getBoundingClientRect().top - a.offset;
    if (Math.abs(drift) < 1) return;
    el.scrollTop -= drift;
    v.scrollOffset = el.scrollTop; // the virtualizer reads its own offset before the scroll event reports it
  });
  useEffect(() => {
    const i = at ? files.findIndex((f) => f.path === at) : -1;
    if (i < 0) return;
    release();
    v.scrollToIndex(i, { align: 'start' });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- scroll on a new choice only, not on every list re-read
  }, [at, jump]);
  const choose = (m: 'unified' | 'split') => {
    setMode(m);
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch {
      // Per-viewer convenience only.
    }
  };
  const toggle = (path: string) =>
    setClosed((c) => {
      const n = new Set(c);
      if (!n.delete(path)) n.add(path);
      return n;
    });
  const all = areAllDiffFilesCollapsed(keys, closed);

  return (
    <section className="dview" aria-label={t('mw.diff.view')}>
      <div className="dbar">
        <button type="button" className="btn" disabled={all} onClick={() => setClosed(toggleAllDiffFiles(keys, closed))}>
          {t('diffview.collapseAll')}
        </button>
        <button type="button" className="btn" disabled={!keys.some((k) => closed.has(k))} onClick={() => setClosed(new Set())}>
          {t('diffview.expandAll')}
        </button>
        {/* B21 (look 1117): short words, as the Unified / Split toggle beside them; the full name is the tooltip and the accessible name. */}
        <span className="seg" role="group" aria-label={t('diffopt.title')}>
          <button type="button" aria-label={t('field.diffHideWhitespace')} data-tip={t('field.diffHideWhitespace')} aria-pressed={ws} onClick={() => setWs(!ws)}>
            {t('diffopt.short.ws')}
          </button>
          <button type="button" aria-label={t('field.diffWrap')} data-tip={t('field.diffWrap')} aria-pressed={wrap} onClick={() => setWrap(!wrap)}>
            {t('diffopt.short.wrap')}
          </button>
          {/* Ticket 410: the same stored value as Settings > Appearance > Diff's switch (features/diff-options.tsx). */}
          <button type="button" aria-label={t('field.diffCollapse')} data-tip={t('field.diffCollapse')} aria-pressed={collapse} onClick={() => setCollapse(!collapse)}>
            {t('diffopt.short.fold')}
          </button>
        </span>
        <span className="seg" role="group" aria-label={t('mw.diff.layout')}>
          <button aria-pressed={mode === 'unified'} onClick={() => choose('unified')}>
            {t('mw.diff.unified')}
          </button>
          <button aria-pressed={mode === 'split'} onClick={() => choose('split')}>
            {t('mw.diff.split')}
          </button>
        </span>
      </div>
      <div className="dstack" ref={scroller} onScroll={remember} onWheel={release} onPointerDown={release} onKeyDown={release} onTouchStart={release}>
        <div style={{ height: v.getTotalSize(), position: 'relative' }}>
          {v.getVirtualItems().map((item) => {
            const f = files[item.index];
            return (
              <div key={item.key} ref={v.measureElement} data-index={item.index} data-key={item.key} className="dsec" style={{ transform: `translateY(${item.start}px)` }}>
                <Section
                  {...{ core, session, machine, branch, force, f, mode, ws, wrap, collapse, t, quote, ask }}
                  shut={closed.has(f.path)}
                  toggle={() => toggle(f.path)}
                  got={got.get(f.path)}
                  put={(g) => setGot((m) => new Map(m).set(f.path, g))}
                />
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function Section({ core, session, machine, branch, force, f, shut, toggle, got, put, mode, ws, wrap, collapse, t, quote, ask }: { ask: (r: Read) => void; core: CoreClient; session: string; machine?: string; branch: boolean; force: number; f: Change; shut: boolean; toggle: () => void; got?: Got; put: (g: Got) => void; mode: 'unified' | 'split'; ws: boolean; wrap: boolean; collapse: boolean; t: T; quote?: (text: string) => void }) {
  const path = f.path;
  // The patch is read again only when this file's entry changed (Q9 pop-J25-1: `stamp` sees a second edit with the same
  // counts) or Refresh was pressed, so the list's re-read (window
  // focus, every 30 s, a finished turn) costs no patch reads and keeps scroll, folds and an open note in place.
  const changed = `${f.status} ${f.old_path} ${f.additions} ${f.deletions} ${f.stamp}`;
  useEffect(() => {
    if (shut) return;
    let live = true;
    ask({
      live: () => live,
      run: () =>
        core
          .request(diffRequest(machine, { op: 'diff_file', session, path, ...(branch ? { scope: 'branch' } : {}) }))
          .then((r) => void (live && put({ patch: r as Patch, error: '' })))
          .catch((e: Error) => void (live && put({ patch: null, error: rawError(e) }))),
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- put is new each render; changed and force are the re-read signals
  }, [core, session, machine, branch, path, changed, force, shut]);
  const gone = f.status === 'D';
  return (
    <section aria-label={t('mw.diff.of', { path })}>
      <div className="fhead">
        <button type="button" className="chev" aria-expanded={!shut} aria-label={t(shut ? 'diffview.expand' : 'diffview.collapse', { path })} onClick={toggle}>
          {shut ? '▸' : '▾'}
        </button>
        <span className="mono dpath" data-tip={path} data-tip-clip="">
          {path}
        </span>
        <span className="m">{[shut && t('diffview.collapsed'), counts(f)].filter(Boolean).join(' · ')}</span>
        {/* needs 172: one visible control opens the file in a tab of this session; a deleted file has none. aria-disabled (not disabled) keeps the button focusable; the tooltip sits on the button itself because the app tooltip (Tooltip.tsx) shows on focus only for the focused element. */}
        <span className="dopen">
          <button type="button" className="dbtn" aria-label={t('mw.diff.openFile')} data-tip={gone ? t('mw.diff.deletedNoFile') : t('mw.diff.openFile')} aria-disabled={gone ? 'true' : undefined} onClick={() => !gone && openFileAt(session, path)}>
            ↗
          </button>
        </span>
      </div>
      {!shut && <PatchView patch={got?.patch ?? null} error={got?.error ?? ''} mode={mode} ws={ws} wrap={wrap} collapse={collapse} t={t} open={gone ? undefined : (line) => openFileAt(session, path, line)} quote={quote} />}
    </section>
  );
}
