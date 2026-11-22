// One file tab, read only until Edit. The body's box is fixed by the pane before anything loads, so content arriving never
// moves the centre. A file that changes while open shows "changed" with a reload button; it is never swapped
// silently. Everything is read through the core. Ticket 820: Edit makes a text file's text editable; Save (or Cmd+S in
// the text) sends it with the hash of the read it started from, and the core refuses it if the file changed since.
import { Component, lazy, Suspense, useCallback, useEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import type { CoreClient } from '../api';
import './files.css';
import { makeT, type Key, type Lang } from '../i18n';
import { docT, ErrorDetails, plainError, rawError } from '../errors';
import { Md } from '../chat/Rows';
import { LinkSpace } from '../features/link-routing'; // ticket 256: a link in a file opens in its session's space when set
import { ArtifactFrame, type ArtifactSource } from '../sandbox/ArtifactFrame';
import { formatSize, isGone, MAX_EDIT, readFile, sameContent, viewOf, writeFile, type FileContent } from './api';
import type { Edit } from './Code';
import { artifactFor, artifactSrc, baseName, fileTabId, reveal, unsavedTabs, type FileRef } from './open';
import { defineSetting, useFeatureSetting } from '../settings/useFeatureSetting';
import { MdDoc } from '../chat/Rows';

const CHECK_MS = 3000;
/** Ticket 375: the file tabs (fileTabId) the owner set to Wrap, newest last; a window value, so a reopened tab keeps it.
 *  shortcut: the oldest drop off past WRAP_KEEP; a per-file store would keep them all if that ever matters. */
const WRAP_KEEP = 200;
const WRAPPED = defineSetting<string[]>('files.wrapped', [], (v) => (Array.isArray(v) && v.every((x) => typeof x === 'string') ? v.slice(-WRAP_KEEP) : undefined));
// The window's language is on <html lang> (as terminal/links.ts reads it).
const words = (key: Key, args?: Record<string, string | number>) => makeT((document.documentElement.lang || 'en') as Lang, navigator.language)(key, args);
/** Ticket 476: a file that could not be read or shown: its name, the plain line, the raw reason under Details. */
function Failed({ name, error }: { name: string; error: string }) {
  const t = makeT((document.documentElement.lang || 'en') as Lang, navigator.language);
  return (
    <div className="empty fv-error" role="alert" data-error="plain">
      {/* One child: .empty spreads its children apart. */}
      <span>
        {t('err.cantOpen', { name })} {plainError(t, error)}
        <ErrorDetails t={t} details={error} />
      </span>
    </div>
  );
}
// CodeMirror (~224 KB) loads with the first text tab, not with the window.
const LazyCode = lazy(() => import('./Code').then((m) => ({ default: m.Code })));
const Code = (p: ComponentProps<typeof LazyCode>) => (
  <ChunkError>
    <Suspense fallback={<div className="empty">{words('rest.pf.fv.loadingViewer')}</div>}>
      <LazyCode {...p} />
    </Suspense>
  </ChunkError>
);
/** A viewer chunk that fails to load says so in the tab instead of blanking the window. */
class ChunkError extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(e: unknown) {
    return { error: rawError(e) };
  }
  render() {
    return this.state.error ? (
      <div className="empty fv-error" role="alert">
        {docT()('rest.pf.fv.viewerFailed', { error: plainError(docT(), this.state.error) })}
        <ErrorDetails t={docT()} details={this.state.error} />
      </div>
    ) : (
      this.props.children
    );
  }
}

function imageUrl(bytes: number[]) {
  const b = Uint8Array.from(bytes);
  const mime = b[0] === 0x89 ? 'image/png' : b[0] === 0xff ? 'image/jpeg' : b[0] === 0x47 ? 'image/gif' : 'image/webp';
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return `data:${mime};base64,${btoa(s)}`;
}

interface Props {
  core: CoreClient;
  file: FileRef;
  /** The session's folder, for Reveal in Finder; absent once the session is gone. */
  cwd?: string;
  visible: boolean;
  jump?: { line: number; at: number };
}

export function FileView({ core, file, cwd, visible, jump }: Props) {
  const [shown, setShown] = useState<FileContent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [next, setNext] = useState<FileContent | null>(null);
  const [missing, setMissing] = useState(false);
  const [source, setSource] = useState(false);
  // Set by the text viewer while it is mounted; the Find button below opens the same panel as Cmd+F.
  const [openFind, setOpenFind] = useState<(() => void) | null>(null);
  const shownRef = useRef<FileContent | null>(null);
  shownRef.current = shown;
  // Ticket 820: the text as edited (null: as read), a bump that puts the read text back, and the last save's refusal.
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const [wrappedTabs, setWrapped] = useFeatureSetting(WRAPPED);
  const tabId = fileTabId(file);
  const wrap = wrappedTabs.includes(tabId);
  const toggleWrap = () => setWrapped([...wrappedTabs.filter((x) => x !== tabId), ...(wrap ? [] : [tabId])].slice(-WRAP_KEEP));

  // Reads can overtake each other; only the newest reply counts.
  const seq = useRef({ next: 0, done: 0 });
  const check = useCallback(async () => {
    const n = ++seq.current.next;
    const newest = () => n > seq.current.done && ((seq.current.done = n), true);
    try {
      const c = await readFile(core, file.root, file.path);
      if (!newest()) return;
      setMissing(false);
      setError(null);
      const cur = shownRef.current;
      if (!cur) setShown(c);
      else setNext(sameContent(cur, c) ? null : c);
    } catch (e) {
      if (/core disconnected/.test(rawError(e)) || !newest()) return;
      if (shownRef.current && isGone(e)) setMissing(true);
      else if (!shownRef.current) setError(rawError(e));
    }
  }, [core, file.root, file.path]);

  // Re-read when the tab becomes visible and every 3 s while it stays visible.
  useEffect(() => {
    if (!visible) return;
    void check();
    const t = setInterval(() => void check(), CHECK_MS);
    return () => clearInterval(t);
  }, [visible, check]);

  const name = baseName(file.path);
  const view = shown ? viewOf(shown) : null;
  const reload = () => {
    if (next) setShown(next);
    setNext(null);
  };
  const canEdit = !!shown?.hash && shown.size <= MAX_EDIT && (view === 'text' || view === 'markdown');
  const dirty = draft !== null && draft !== shown?.text;
  useEffect(() => {
    const id = fileTabId(file);
    if (dirty) unsavedTabs.add(id);
    return () => void unsavedTabs.delete(id);
  }, [dirty, file.root, file.path]);
  const save = async () => {
    const cur = shownRef.current;
    const text = draftRef.current;
    if (!cur?.hash || text === null || text === cur.text) return;
    setSaving(true);
    setSaveError(null);
    try {
      const c = await writeFile(core, file.root, file.path, text, cur.hash);
      setShown(c);
      setNext(null);
      setDraft(null);
    } catch (e) {
      setSaveError(rawError(e));
    } finally {
      setSaving(false);
    }
  };
  const revert = () => {
    setDraft(null);
    setSaveError(null);
    setRevision((n) => n + 1);
  };
  const edit: Edit | undefined = editing && canEdit ? { onChange: setDraft, onSave: () => void save(), revision, busy: saving } : undefined;

  return (
    <div className="fview" hidden={!visible} data-file={file.path} data-view={view ?? (error ? 'error' : 'loading')}>
      <div className="fv-bar">
        <span className="fv-path" title={file.path}>
          {file.path}
        </span>
        {shown && <span className="dim">{formatSize(shown.size)}</span>}
        {edit ? dirty && <span className="fv-state" data-state="unsaved">{words('rest.pf.fv.unsaved')}</span> : <span className="fv-ro">{words('rest.pf.fv.readOnly')}</span>}
        <span className="sp" />
        {missing && (
          <span className="fv-state" role="status" data-state="missing">
            {words('rest.pf.fv.missing')}
          </span>
        )}
        {next && !missing && (
          <>
            <span className="fv-state" role="status" data-state="changed">
              {words('rest.pf.fv.changed')}
            </span>
            <button className="btn" onClick={reload} disabled={dirty} title={dirty ? words('rest.pf.fv.keepEdits') : undefined}>
              {words('rest.pf.fv.reload')}
            </button>
          </>
        )}
        {openFind && (
          <button className="btn" aria-pressed={wrap} title={words('files.wrapTip')} onClick={toggleWrap}>
            {words('files.wrap')}
          </button>
        )}
        {openFind && (
          <button className="btn" aria-label={words('fvfind.label')} title={`${words('fvfind.label')} (⌘F)`} onClick={openFind}>
            {words('fvfind.find')}
          </button>
        )}
        {edit && (
          <>
            <button className="btn" onClick={revert} disabled={!dirty || saving}>
              {words('rest.pf.fv.revert')}
            </button>
            <button className="btn" onClick={() => void save()} disabled={!dirty || saving} title={`${words('rest.pf.fv.save')} (⌘S)`}>
              {words('rest.pf.fv.save')}
            </button>
          </>
        )}
        {canEdit && (
          <button className="btn" aria-pressed={editing} onClick={() => (setEditing(!editing), setDraft(null), setSaveError(null))} disabled={dirty} title={dirty ? words('rest.pf.fv.keepEdits') : undefined}>
            {words('rest.pf.fv.edit')}
          </button>
        )}
        {view === 'markdown' && !edit && (
          <div className="fv-seg" role="group" aria-label={words('rest.pf.fv.mdView')}>
            <button aria-pressed={!source} onClick={() => setSource(false)}>
              {words('rest.pf.fv.rendered')}
            </button>
            <button aria-pressed={source} onClick={() => setSource(true)}>
              {words('rest.pf.fv.source')}
            </button>
          </div>
        )}
      </div>
      {saveError && edit && (
        <div className="fv-save-error" role="alert">
          {plainError(docT(), saveError)}
          <ErrorDetails t={docT()} details={saveError} />
        </div>
      )}
      <div className="fv-body">
        {error ? (
          <Failed name={name} error={error} />
        ) : !shown ? (
          <div className="empty" aria-busy="true">
            {words('rest.pf.fv.loading', { name })}
          </div>
        ) : (
          <Body file={file} c={shown} view={view!} name={name} cwd={cwd} source={source} jump={jump} onFind={(open) => setOpenFind(() => open)} edit={edit} wrap={wrap} />
        )}
      </div>
    </div>
  );
}

function Body({ file, c, view, name, cwd, source, jump, onFind, edit, wrap }: { file: FileRef; c: FileContent; view: NonNullable<ReturnType<typeof viewOf>>; name: string; cwd?: string; source: boolean; jump?: Props['jump']; onFind: ComponentProps<typeof LazyCode>['onFind']; edit?: Edit; wrap: boolean }) {
  const label = words(edit ? 'rest.pf.fv.editLabel' : 'rest.pf.fv.readOnlyLabel', { path: file.path });
  switch (view) {
    case 'text':
      return <Code text={c.text!} name={name} jump={jump} label={label} onFind={onFind} edit={edit} wrap={wrap} />;
    case 'markdown':
      return source || edit ? (
        <Code text={c.text!} name={name} jump={jump} label={label} onFind={onFind} edit={edit} wrap={wrap} />
      ) : (
        <div className="fv-scroll fv-md">
          <LinkSpace.Provider value={file.root}>
            {/* Ticket 375: relative links, images and #anchors resolve against this file's folder in its root. */}
            <MdDoc.Provider value={{ root: file.root, dir: file.path.slice(0, Math.max(0, file.path.lastIndexOf('/'))), cwd }}>
              <Md text={c.text!} />
            </MdDoc.Provider>
          </LinkSpace.Provider>
        </div>
      );
    case 'image':
      return (
        <div className="fv-scroll fv-img">
          <img src={imageUrl(c.data!)} alt={name} />
        </div>
      );
    case 'svg':
      // An <img> never runs the SVG's scripts or loads what it references; the SVG never enters the window's DOM.
      return (
        <div className="fv-scroll fv-img">
          <img src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(c.text!)}`} alt={name} />
        </div>
      );
    case 'html':
      return <Html file={file} text={c.text!} name={name} />;
    default:
      return (
        <div className="empty fv-meta">
          <div>
            <b>{name}</b>
            <div className="dim">
              {formatSize(c.size)} · {words(view === 'large' ? 'rest.pf.fv.tooLarge' : 'rest.pf.fv.binary')}
            </div>
            <button className="btn" disabled={!cwd} onClick={() => cwd && void reveal(cwd, file.path)}>
              {words('rest.pf.fv.reveal')}
            </button>
          </div>
        </div>
      );
  }
}

function Html({ file, text, name }: { file: FileRef; text: string; name: string }) {
  const [art, setArt] = useState<ArtifactSource | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    artifactFor(file.root, file.path, text).then(
      (a) => live && setArt(a),
      (e) => live && setError(rawError(e)),
    );
    return () => {
      live = false;
    };
  }, [file.root, file.path, text]);
  if (error)
    return (
      <Failed name={name} error={error} />
    );
  if (!art) return <div className="empty">{words('rest.pf.fv.loading', { name })}</div>;
  return (
    <div className="fv-scroll">
      {/* V2-10c: no session asks here; the owner opened the file from Files, so the library card names that view. */}
      <ArtifactFrame artifact={art} title={name} srcFor={artifactSrc} requester="Files" />
    </div>
  );
}
