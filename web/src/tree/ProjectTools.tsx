// V2.5-15 (ticket 154, needs 139): the project row's icon, "Open in editor" and "Set icon", and the new-project wizard.
import { PLAIN } from '../plainText';
import { useEffect, useRef, useState, type KeyboardEvent, type SyntheticEvent } from 'react';
import type { CloneState, CoreClient } from '../api';
import { Icon, type IconName } from '../icons/Icon';
import { pickFolder } from '../pickFolder';
import { TREE_SET } from '../tree';
import { askNewAfterAdd } from '../firstrun/added';
import { ErrorDetails, lineError, rawError } from '../errors';
import { enT, type T } from './state';

const ICON_MAX = 256 << 10;
type Icon = { mime: string; data_b64: string } | null;
const icons = new Map<string, Icon>();
const ICON_EVENT = 'nunchiro:project.icon';


/** The chosen image, drawn before the project name; nothing when none is set (or the core refuses the read). */
export function ProjectIcon({ core, project }: { core: CoreClient; project: string }) {
  const [icon, setIcon] = useState<Icon>(icons.get(project) ?? null);
  useEffect(() => {
    let live = true;
    const load = () =>
      void core.request({ op: 'project_icon_get', project }).then(
        (r) => {
          const { mime, data_b64 } = r as { mime: string | null; data_b64: string | null };
          const next = mime && data_b64 ? { mime, data_b64 } : null;
          icons.set(project, next);
          if (live) setIcon(next);
        },
        () => {},
      );
    if (!icons.has(project)) load();
    const on = (e: Event) => (e as CustomEvent<string>).detail === project && load();
    window.addEventListener(ICON_EVENT, on);
    return () => ((live = false), window.removeEventListener(ICON_EVENT, on));
  }, [core, project]);
  return icon ? <img className="pico" alt="" src={`data:${icon.mime};base64,${icon.data_b64}`} /> : null;
}

const toBase64 = (file: File) =>
  new Promise<string>((ok, no) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result).split(',')[1] ?? '');
    r.onerror = () => no(r.error);
    r.readAsDataURL(file);
  });

/** Stores a chosen image as the project's icon (the tree row and Settings > Projects, ticket 1040); every drawn icon reads again. */
export async function pickIcon(core: CoreClient, project: string, f: File | undefined, onError: (m: string) => void, t: T = enT) {
  if (!f) return;
  onError('');
  if (f.size > ICON_MAX) return onError(t('projects.iconBad'));
  try {
    await core.request({ op: 'project_icon_set', project, data_b64: await toBase64(f) });
    icons.delete(project);
    window.dispatchEvent(new CustomEvent(ICON_EVENT, { detail: project }));
  } catch (e) {
    onError(lineError(t, e));
  }
}

/** Two hover buttons on the project row. Errors go to `onError` (the tree's alert line). */
export function ProjectTools({ core, project, name, onError, t = enT }: { core: CoreClient; project: string; name: string; onError: (m: string) => void; t?: T }) {
  const file = useRef<HTMLInputElement>(null);
  const pick = (f: File | undefined) => pickIcon(core, project, f, onError, t);
  return (
    <>
      <button className="ptool ped" aria-label={t('projects.editor')} title={t('projects.editorTitle', { name })} onClick={() => (onError(''), void core.request({ op: 'open_in_editor', path: project }).catch((e) => onError(lineError(t, e))))} />
      <button className="ptool pic" aria-label={t('projects.icon')} title={t('projects.iconTitle', { name })} onClick={() => file.current?.click()} />
      <input ref={file} type="file" hidden accept="image/png,image/jpeg,image/svg+xml" aria-label={t('projects.icon')} onChange={(e) => (void pick(e.target.files?.[0]), (e.target.value = ''))} />
    </>
  );
}

/** Add project: the chooser (Browse folder first and focused, as Orca's add-repo-local-start-actions.ts and AddRepoStartSteps.tsx;
 * behaviour taken, no code. Orca: MIT License, Copyright (c) 2026 Lovecast Inc.). Create new asks a name and a location:
 * the core makes the folder and its Git repository (`project_create`), the tree gets it, and New session then opens on it, where the first agent is picked.
 * The live path line follows T3 Code's CommandPaletteAddProject.tsx, the kept-folder warning its useNewProject.ts. T3 Code: MIT License, Copyright (c) 2026 T3 Tools Inc. */
/** Where a new or cloned project goes by default: the folder most of the tree's projects already sit in. */
export function defaultParent(projects: string[] = []) {
  const n = new Map<string, number>();
  for (const p of projects) {
    const dir = p.replace(/\/+$/, '').replace(/\/[^/]+$/, '');
    if (dir.startsWith('/')) n.set(dir, (n.get(dir) ?? 0) + 1);
  }
  return [...n].sort((x, y) => y[1] - x[1])[0]?.[0] ?? '~/Projects';
}

export function ProjectWizard({ core, onClose, projects, t = enT }: { core: CoreClient; onClose: () => void; projects?: string[]; t?: T }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState('');
  const [location, setLocation] = useState(() => defaultParent(projects));
  const [pickError, setPickError] = useState(false);
  const [made, setMade] = useState<Made | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [errorRaw, setErrorRaw] = useState('');
  const [step, setStep] = useState<'choose' | 'create' | 'clone'>('choose');
  const cloning = step === 'clone';
  const back = useRef<Element | null>(document.activeElement);
  useEffect(() => () => (back.current as HTMLElement | null)?.focus?.(), []);
  useEffect(() => {
    if (!cloning) dialog.current?.showModal(); // again after the clone step's Back: this <dialog> is a new element
    const open = () => setStep('clone');
    window.addEventListener(CLONE_EVENT, open);
    return () => window.removeEventListener(CLONE_EVENT, open);
  }, [cloning]);
  const typed = name.trim();
  const root = location.trim().replace(/\/+$/, '') || location.trim();
  const canCreate = !!typed && !!location.trim() && !busy && !made;
  const open = (path: string) => (onClose(), askNewAfterAdd(path));
  // F15: in the tree before the popover opens, so dismissing it keeps the project. The folder exists either way, so a
  // failed add or a Git warning stays here and says so.
  const addToTree = async (done: Made) => {
    setBusy(true);
    setMade({ ...done, addFail: undefined });
    try {
      const tree = await core.treeEdit({ op: 'add', project: done.path, added: true });
      window.dispatchEvent(new CustomEvent(TREE_SET, { detail: tree }));
    } catch (e) {
      setMade({ ...done, addFail: rawError(e) });
      setBusy(false);
      return;
    }
    setBusy(false);
    if (!done.warning) open(done.path);
  };
  const create = async () => {
    setBusy(true);
    setError('');
    setErrorRaw('');
    try {
      await addToTree((await core.request({ op: 'project_create', name, parent: location.trim() })) as Made);
    } catch (e) {
      const key = CREATE_ERRORS[rawError(e)];
      setError(key ? t(key) : lineError(t, e));
      setErrorRaw(key ? '' : rawError(e));
      setBusy(false);
    }
  };
  const browse = () =>
    pickFolder().then(
      (p) => (setPickError(false), p && setLocation(p)),
      () => setPickError(true),
    );
  const onEnter = (e: KeyboardEvent) => e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229 && canCreate && (e.preventDefault(), void create());
  if (cloning) return <CloneStep core={core} onClose={onClose} onBack={() => setStep('choose')} projects={projects} t={t} />;
  const dialogProps = { ref: dialog, className: 'modal newsess', onCancel: (e: SyntheticEvent) => (e.preventDefault(), onClose()), onKeyDown: (e: KeyboardEvent) => e.stopPropagation() };
  if (step === 'choose')
    return (
      <dialog {...dialogProps} aria-label={t('landing.addProject')}>
        <b>{t('landing.addProject')}</b>
        {/* The dialog opens on its first control, so this order is also the focus: Enter on Browse folder is the folder panel. */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-6)' }}>
          <AddOption autoFocus icon="file-directory" title={t('projects.add.browse')} note={t('projects.add.browseNote')} kbd="Enter" onClick={() => (onClose(), askNewAfterAdd(''))} />
          <AddOption icon="plus" title={t('projects.add.create')} note={t('projects.add.createNote')} onClick={() => setStep('create')} />
          <AddOption icon="git-branch" title={t('projects.add.clone')} note={t('projects.add.cloneNote')} onClick={askClone} />
        </div>
        <div className="row">
          <button className="btn" onClick={onClose}>
            {t('projects.wizard.cancel')}
          </button>
        </div>
      </dialog>
    );
  return (
    <dialog {...dialogProps} aria-label={t('projects.wizard.title')}>
      <h2 style={TITLE}>
        {!made && <BackButton t={t} onBack={() => setStep('choose')} />}
        {t('projects.wizard.title')}
      </h2>
      <label className="ns-folder">
        {t('projects.wizard.name')}
        <span className="ns-path mono">
          <input {...PLAIN} autoFocus value={name} disabled={!!made} autoComplete="off" spellCheck={false} onChange={(e) => setName(e.target.value)} onKeyDown={onEnter} />
        </span>
      </label>
      <label className="ns-folder">
        {t('projects.new.location')}
        <span className="ns-path mono">
          <input {...PLAIN} value={location} disabled={!!made} autoComplete="off" spellCheck={false} onChange={(e) => setLocation(e.target.value)} onKeyDown={onEnter} />
          <button className="btn" disabled={!!made} aria-label={t('projects.clone.browse')} title={t('projects.clone.browse')} onClick={() => void browse()}>
            <svg viewBox="0 0 16 16" style={{ ...GLYPH, fill: 'currentColor' }} aria-hidden>
              <path d={FOLDER_GLYPH} />
            </svg>
          </button>
        </span>
      </label>
      {pickError && (
        <span className="conflict" role="alert">
          {t('newtab.pickerFailed')}
        </span>
      )}
      <div style={CREATES}>
        <span style={{ color: 'var(--muted)' }}>{typed ? t('projects.new.creates') : t('projects.new.goesIn')}</span> <b className="mono" style={CREATES_PATH}>{typed ? `${root}/${typed}` : root}</b>
      </div>
      <p style={NOTE}>{t('projects.new.note')}</p>
      {error && (
        <span className="conflict" role="alert">
          {error}
          <ErrorDetails t={t} details={errorRaw} />
        </span>
      )}
      {made?.warning && (
        <>
          <span className="conflict" role="alert">
            {t(made.repo ? 'projects.new.commitWarning' : 'projects.new.initWarning', { path: made.path })}
          </span>
          <ErrorDetails t={t} details={made.warning} />
        </>
      )}
      {made?.addFail && (
        <>
          <span className="conflict" role="alert">
            {t('projects.new.addFailed', { path: made.path })}
          </span>
          <ErrorDetails t={t} details={made.addFail} />
        </>
      )}
      <div className="row">
        <button className="btn" onClick={onClose}>
          {t('projects.wizard.cancel')}
        </button>
        {made?.addFail ? (
          <button className="btn p" disabled={busy} onClick={() => void addToTree(made)}>
            {t('projects.clone.readd')}
          </button>
        ) : made ? (
          <button className="btn p" disabled={busy} onClick={() => open(made.path)}>
            {t('projects.new.continue')}
          </button>
        ) : (
          <button className="btn p" disabled={!canCreate} onClick={() => void create()}>
            {t('projects.wizard.create')}
          </button>
        )}
      </div>
    </dialog>
  );
}

function AddOption({ icon, title, note, kbd, autoFocus, onClick }: { icon: IconName; title: string; note: string; kbd?: string; autoFocus?: boolean; onClick: () => void }) {
  return (
    <button className="btn" autoFocus={autoFocus} style={OPTION} onClick={onClick}>
      <Icon name={icon} />
      <span style={{ flex: 1, minWidth: 0 }}>
        <b style={{ display: 'block', fontSize: 'var(--fs-13)' }}>{title}</b>
        <small style={{ color: 'var(--muted)', fontSize: 'var(--fs-12)' }}>{note}</small>
      </span>
      {kbd && <span className="mono">{kbd}</span>}
    </button>
  );
}

function BackButton({ t, onBack }: { t: T; onBack: () => void }) {
  return (
    <button style={BARE} aria-label={t('projects.clone.back')} title={t('projects.clone.back')} onClick={onBack}>
      <svg viewBox="0 0 16 16" style={{ ...GLYPH, fill: 'none', stroke: 'currentColor', strokeWidth: 1.5 }} aria-hidden>
        <path d="M10 3L5 8l5 5" />
      </svg>
    </button>
  );
}

const CLONE_EVENT = 'nunchiro:project.clone';
/** Opens the clone step in the Add project dialog that is showing. */
export const askClone = () => window.dispatchEvent(new Event(CLONE_EVENT));

const CLONE_POLL_MS = 400; // well inside the core's 15 s "nobody is watching" limit
// The mock's check while typing; the core's allowlist is the one that decides.
const CLONE_URL = /^(https:\/\/|ssh:\/\/|[\w.-]+@[\w.-]+:)/;
const CLONE_STAGES: Record<string, Parameters<T>[0]> = {
  'Counting objects': 'projects.clone.stage.counting',
  'Compressing objects': 'projects.clone.stage.compressing',
  'Receiving objects': 'projects.clone.stage.receiving',
  'Resolving deltas': 'projects.clone.stage.resolving',
  'Updating files': 'projects.clone.stage.updating',
};
const FOLDER_GLYPH = 'M0 2.75C0 1.784.784 1 1.75 1H5c.55 0 1.07.26 1.4.7l.9 1.2a.25.25 0 0 0 .2.1h6.75c.966 0 1.75.784 1.75 1.75v8.5A1.75 1.75 0 0 1 14.25 15H1.75A1.75 1.75 0 0 1 0 13.25Zm1.75-.25a.25.25 0 0 0-.25.25v10.5c0 .138.112.25.25.25h12.5a.25.25 0 0 0 .25-.25v-8.5a.25.25 0 0 0-.25-.25H7.5c-.55 0-1.07-.26-1.4-.7l-.9-1.2a.25.25 0 0 0-.2-.1Z'; // Octicon file-directory, as the mock
const NOTE = { color: 'var(--muted)', margin: 0 };
type Made = { path: string; repo: boolean; warning: string | null; addFail?: string };
const CREATES = { padding: 'var(--sp-6) var(--sp-8)', borderRadius: 'var(--r-6)', background: 'var(--page)' };
const CREATES_PATH = { fontWeight: 500, fontSize: 'var(--fs-12)', wordBreak: 'break-all' } as const;
// The core's fixed refusals, in the window's language; anything else (a disk error) is shown as the core said it.
const CREATE_ERRORS: Record<string, Parameters<T>[0]> = {
  'project name must be 1-64 characters, no slash, not starting with a dot': 'projects.new.nameBad',
  'a folder with that name already exists': 'projects.new.exists',
  'the location must start with / or ~/ and cannot contain ..': 'projects.new.locationBad',
};
const TITLE = { display: 'flex', alignItems: 'center', gap: 'var(--sp-4)', margin: 0 };
const OPTION = { display: 'flex', alignItems: 'center', gap: 'var(--sp-12)', width: '100%', padding: 'var(--sp-8) var(--sp-12)', borderRadius: 'var(--r-8)', textAlign: 'left', cursor: 'pointer' } as const;
const BARE = { background: 'none', border: 0, padding: 0, color: 'inherit', cursor: 'pointer' };
const GLYPH = { width: 'var(--sp-16)', height: 'var(--sp-16)', display: 'block' };

/** The clone step (#clone #cloning #clonefail): one job per dialog, and closing the dialog cancels it. Fields ported from
 * Orca's AddRepoCloneStep.tsx to this dialog's markup; Retry follows T3 Code's ProjectCloneToastCoordinator.tsx.
 * Orca: MIT License, Copyright (c) 2026 Lovecast Inc. T3 Code: MIT License, Copyright (c) 2026 T3 Tools Inc. */
export function CloneStep({ core, onClose, onBack, projects, t = enT }: { core: CoreClient; onClose: () => void; onBack?: () => void; projects?: string[]; t?: T }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [url, setUrl] = useState('');
  const [parent, setParent] = useState(() => defaultParent(projects));
  const [run, setRun] = useState<{ job: string; stage: string | null; percent: number } | null>(null);
  const [fail, setFail] = useState<CloneState | null>(null);
  const [pickError, setPickError] = useState(false);
  const [addFail, setAddFail] = useState<{ path: string; detail: string } | null>(null);
  const locked = !!run || !!addFail; // an added-to-nothing clone is finished: only the add can be repeated
  const job = useRef('');
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    if (!dialog.current?.open) dialog.current?.showModal();
    dialog.current?.querySelector('input')?.focus(); // showModal took the first control, the Back arrow
    return () => {
      live.current = false;
      if (job.current) void core.cloneCancel(job.current).catch(() => {}); // closing the dialog is Cancel
    };
  }, [core]);

  const typedUrl = url.trim();
  const badUrl = !!typedUrl && !CLONE_URL.test(typedUrl);
  const refusedUrl = badUrl || (fail?.kind === 'refused' && !fail.parent);
  const stuck = fail?.kind === 'refused' || fail?.kind === 'exists'; // these two have no Retry: the input must change
  const retry = !!fail && !stuck;
  const canClone = !locked && !!typedUrl && !badUrl && !!parent.trim() && !stuck;

  const edit = (set: (v: string) => void) => (e: { target: { value: string } }) => {
    set(e.target.value);
    setFail(null);
  };
  const failedWith = (detail: string): CloneState => ({ job: '', phase: 'failed', stage: null, percent: 0, kind: 'other', parent: false, path: null, detail, removed: false });
  // F15: in the tree before the popover opens, so dismissing it keeps the project. The clone is done either way, so a
  // failed add stays here and says so instead of opening New session on a project the tree does not have.
  const addToTree = async (path: string) => {
    setAddFail(null);
    setRun({ job: '', stage: null, percent: 100 });
    try {
      const tree = await core.treeEdit({ op: 'add', project: path, added: true });
      window.dispatchEvent(new CustomEvent(TREE_SET, { detail: tree }));
    } catch (e) {
      if (live.current) {
        setRun(null);
        setAddFail({ path, detail: rawError(e) });
      }
      return;
    }
    if (!live.current) return;
    onClose();
    askNewAfterAdd(path); // ticket 479: after onboarding's Add project, its found agent leads
  };
  const clone = async () => {
    setFail(null);
    setRun({ job: '', stage: null, percent: 0 });
    try {
      let { state } = await core.cloneStart(typedUrl, parent.trim());
      if (!live.current) {
        if (state.job) void core.cloneCancel(state.job).catch(() => {});
        return;
      }
      job.current = state.job;
      while (state.phase === 'cloning') {
        setRun({ job: state.job, stage: state.stage, percent: state.percent });
        await new Promise((done) => setTimeout(done, CLONE_POLL_MS));
        if (!live.current) return; // the unmount already sent the Cancel
        ({ state } = await core.cloneState(state.job));
        if (!live.current) return;
      }
      job.current = '';
      if (state.phase === 'done' && state.path) return await addToTree(state.path);
      setRun(null);
      if (state.phase === 'failed') setFail(state);
    } catch (e) {
      // The state could not be read, so the job may still be running: end it rather than leave it for the core's limit.
      if (job.current) void core.cloneCancel(job.current).catch(() => {});
      job.current = '';
      if (!live.current) return;
      setRun(null);
      setFail(failedWith(rawError(e)));
    }
  };
  const browse = () =>
    pickFolder().then(
      (p) => (setPickError(false), p && (setParent(p), setFail(null))),
      () => setPickError(true),
    );
  const onEnter = (e: KeyboardEvent) => e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229 && canClone && (e.preventDefault(), void clone());
  const existing = fail?.kind === 'exists' && fail.path ? `${parent.trim().replace(/\/+$/, '')}/${fail.path.split('/').pop()}` : '';
  const failText =
    fail?.kind === 'auth' ? t('projects.clone.auth') : fail?.kind === 'ssh' ? t('projects.clone.ssh') : fail?.kind === 'timeout' ? t('projects.clone.timeout') : fail?.kind === 'other' ? t('projects.clone.other') : '';
  const stage = (run?.stage && CLONE_STAGES[run.stage] && t(CLONE_STAGES[run.stage])) || t('projects.clone.busy');
  return (
    <dialog ref={dialog} className="modal newsess" aria-label={t('projects.clone.title')} onCancel={(e) => (e.preventDefault(), onClose())} onKeyDown={(e) => e.stopPropagation()}>
      <h2 style={TITLE}>
        {onBack && !locked && !fail && <BackButton t={t} onBack={onBack} />}
        {t('projects.clone.title')}
      </h2>
      <label className="ns-folder">
        {t('projects.clone.url')}
        <span className="ns-path mono">
          <input {...PLAIN} autoFocus value={url} disabled={locked} placeholder="https://github.com/user/repo.git" autoComplete="off" spellCheck={false} onChange={edit(setUrl)} onKeyDown={onEnter} />
        </span>
      </label>
      {refusedUrl && (
        <span className="conflict" role="alert">
          {t('projects.clone.refused')}
        </span>
      )}
      <label className="ns-folder">
        {t('projects.clone.parent')}
        <span className="ns-path mono">
          <input {...PLAIN} value={parent} disabled={locked} autoComplete="off" spellCheck={false} onChange={edit(setParent)} onKeyDown={onEnter} />
          <button className="btn" disabled={locked} aria-label={t('projects.clone.browse')} title={t('projects.clone.browse')} onClick={() => void browse()}>
            <svg viewBox="0 0 16 16" style={{ ...GLYPH, fill: 'currentColor' }} aria-hidden>
              <path d={FOLDER_GLYPH} />
            </svg>
          </button>
        </span>
      </label>
      {pickError && (
        <span className="conflict" role="alert">
          {t('newtab.pickerFailed')}
        </span>
      )}
      {fail?.kind === 'refused' && fail.parent && (
        <span className="conflict" role="alert">
          {t('projects.clone.parentBad')}
        </span>
      )}
      {existing && (
        <span className="conflict" role="alert">
          {t('projects.clone.exists', { path: existing })}
        </span>
      )}
      {run && (
        <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-4)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--muted)' }}>
              <span>{stage}</span>
              <span className="mono">{run.percent}%</span>
            </div>
            <div role="progressbar" aria-label={t('projects.clone.progress')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={run.percent} style={{ height: 'var(--sp-4)', borderRadius: 'var(--sp-2)', background: 'var(--line)', overflow: 'hidden' }}>
              <div style={{ width: `${run.percent}%`, height: '100%', background: 'var(--accent)' }} />
            </div>
          </div>
          <p style={NOTE}>{t('projects.clone.cancelNote')}</p>
        </>
      )}
      {failText && (
        <>
          <span className="conflict" role="alert">
            {failText}
          </span>
          <ErrorDetails t={t} details={fail?.detail ?? undefined} />
          {fail?.removed && <p style={NOTE}>{t('projects.clone.removed')}</p>}
        </>
      )}
      {addFail && (
        <>
          <span className="conflict" role="alert">
            {t('projects.clone.addFailed', { path: addFail.path })}
          </span>
          <ErrorDetails t={t} details={addFail.detail} />
        </>
      )}
      <div className="row">
        <button className="btn" disabled={!!run && !run.job} onClick={() => (run ? void core.cloneCancel(run.job).catch(() => {}) : onClose())}>
          {t('projects.clone.cancel')}
        </button>
        <button className="btn p" disabled={run ? true : addFail || retry ? false : !canClone} onClick={() => void (addFail ? addToTree(addFail.path) : clone())}>
          {run ? t('projects.clone.busy') : addFail ? t('projects.clone.readd') : retry ? t('projects.clone.retry') : t('projects.clone.clone')}
        </button>
      </div>
    </dialog>
  );
}
