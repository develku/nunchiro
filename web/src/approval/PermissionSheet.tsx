// Permission sheet (R8-final frame 5): who made it, the exact command, read / act / never, network hosts,
// files it reads (v1b-33), the manifest viewer and the equivalent CLI line. Everything shown comes from the core's parsed manifest.
import { busyRetry } from '../api';
import { ErrorLine } from '../errors';
import { useEffect, useRef, useState } from 'react';
import './sheet.css';
import type { ApprovalCore, ApprovalView, Level, SetupStatus, SetupView } from './types';
import { actTarget, type Act } from '../widgets/api'; // v1b-20
import type { Key } from '../i18n'; // V2-14f
import { useHtmlLangT } from '../i18n/lib/useHtmlLangT';

type T = (key: Key, args?: Record<string, string | number>) => string;

interface Props {
  core: ApprovalCore;
  name: string;
  /** v1a-23 r2: an integration source (`~/.nunchiro/sources/<name>`) instead of a widget. Ticket 259: `setup` is the repo
   *  setup script of the worktree at `name` (its path). */
  subject?: 'widget' | 'source' | 'setup';
  onClose: () => void;
  /** Called with the stored grant after a successful approve. */
  onGranted?: (view: ApprovalView) => void;
  /** V2-14f: the window's catalogue lookup; ticket 960: the window's language (<html lang>) when the caller passes none. */
  t?: T;
}

/** One argv word as a shell would need it, so what is shown is what runs, character for character. */
const word = (w: string) => (/^[\w@%+=:,./-]+$/.test(w) ? w : `'${w.replaceAll("'", `'\\''`)}'`);

export function PermissionSheet(props: Props) {
  return props.subject === 'setup' ? <SetupSheet {...props} /> : <FolderSheet {...props} />;
}

/** Tab and Shift+Tab stay on the sheet's buttons; Escape closes it. */
const trap = (root: React.RefObject<HTMLDivElement | null>, onClose: () => void) => (e: React.KeyboardEvent) => {
  if (e.key === 'Escape') return onClose();
  if (e.key !== 'Tab') return;
  const items = [...(root.current?.querySelectorAll<HTMLElement>('button:not(:disabled)') ?? [])];
  const at = items.indexOf(document.activeElement as HTMLElement);
  const next = e.shiftKey ? (at <= 0 ? items.length - 1 : at - 1) : at === items.length - 1 ? 0 : at + 1;
  e.preventDefault();
  items[next]?.focus();
};

/** Ticket 259: a repo's worktree setup script, shown as the exact text that runs, with its hash; Approve runs it. */
function SetupSheet({ core, name: path, onClose, t: given }: Props) {
  const htmlT = useHtmlLangT();
  const t = given ?? htmlT;
  const [view, setView] = useState<SetupView | null>(null);
  const [none, setNone] = useState(false);
  const [error, setError] = useState<unknown>('');
  const [busy, setBusy] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const back = useRef<Element | null>(document.activeElement);
  useEffect(() => {
    // A busy refusal (the window's connect burst) is retried: shown as is, the ask could not be reviewed at all.
    busyRetry(() => core.request({ op: 'setup_status', path }))
      .then((r) => {
        const v = (r as { status: SetupStatus }).status.view;
        if (v) setView(v);
        else setNone(true);
      })
      .catch((e: Error) => setError(e));
    const prev = back.current;
    return () => (prev as HTMLElement | null)?.focus?.();
  }, [core, path]);
  useEffect(() => {
    root.current?.querySelector<HTMLElement>('[data-cancel]')?.focus();
  }, [view, error, none]);
  const approve = () => {
    if (!view || busy) return;
    setBusy(true);
    core
      .request({ op: 'setup_grant', path, hash: view.hash })
      // The grant started the setup tab; the sheet has nothing more to show.
      .then(onClose)
      .catch((e: Error) => (setError(e), setBusy(false)));
  };
  const leaf = (p: string) => p.split('/').filter(Boolean).at(-1) ?? p;
  return (
    <>
      <div className="ps-scrim" onClick={onClose} />
      <div ref={root} className="ps" role="dialog" aria-modal="true" aria-labelledby="ps-title" onKeyDown={trap(root, onClose)}>
        <div>
          <h3 id="ps-title">{t('setupSheet.title', { name: leaf(view?.project ?? path) })} {/* real-app look 11-16: the worktree folder is an id; the approval is the project's */}</h3>
          <div className="ps-meta">
            {t('setupSheet.kind')}
            {' · '}
            <span className="mono" data-field="path">
              {path}
            </span>
            {view && (
              <>
                {' · '}
                <span className="mono" data-field="hash">
                  {t('approval.hash', { hash: view.hash.slice(0, 12) })}
                </span>
              </>
            )}
          </div>
        </div>
        <ErrorLine t={t} error={error} className="ps-error" />
        {none && <p role="status">{t('setupSheet.none')}</p>}
        {view?.state === 'changed' && (
          <p role="status" className="ps-changed">
            {t('setupSheet.changed')}
          </p>
        )}
        {view && (
          <div>
            <b>{t('setupSheet.runs')}</b>
            <pre data-field="script">{view.script}</pre>
            <p className="ps-meta" data-field="note">
              {t('setupSheet.note', { project: leaf(view.project) })}
            </p>
          </div>
        )}
        <div className="ps-acts">
          <span className="sp" />
          <button className="btn" data-cancel onClick={onClose}>
            {t('approval.cancel')}
          </button>
          <button className="btn p" disabled={!view || busy} onClick={approve}>
            {t('setupSheet.approve')}
          </button>
        </div>
      </div>
    </>
  );
}

function FolderSheet({ core, name, subject = 'widget', onClose, onGranted, t: given }: Props) {
  const htmlT = useHtmlLangT();
  const t = given ?? htmlT;
  const isSource = subject === 'source'; // v1a-23 r2
  // A plugin (`plugin:<id>`, or one of its panels `plugin__<id>__<panel>` from the library) is shown and approved whole:
  // its parts take the command's place; the rest of the sheet reads the same.
  const plugin = /^plugin:([a-z0-9_-]+)$/.exec(name)?.[1] ?? /^plugin__(.+?)__/.exec(name)?.[1] ?? null;
  const asked = plugin ? `plugin:${plugin}` : name;
  const [view, setView] = useState<ApprovalView | null>(null);
  const [error, setError] = useState<unknown>('');
  const [act, setAct] = useState(false);
  const [source, setSource] = useState(false);
  const [busy, setBusy] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const back = useRef<Element | null>(document.activeElement);

  useEffect(() => {
    core
      .request(isSource ? { op: 'board_source_status', name } : { op: 'approval_status', name: asked })
      .then((r) => setView((r as { view: ApprovalView }).view))
      .catch((e: Error) => setError(e));
    const prev = back.current;
    return () => (prev as HTMLElement | null)?.focus?.();
  }, [core, asked, isSource]);
  // Focus lands on Cancel, so a stray Enter never approves.
  useEffect(() => {
    root.current?.querySelector<HTMLElement>('[data-cancel]')?.focus();
  }, [view, error]);

  const level: Level = act ? 'act' : 'read';
  const approve = () => {
    if (!view || busy) return;
    setBusy(true);
    core
      .request(isSource ? { op: 'board_source_grant', name, level, hash: view.hash } : { op: 'approval_grant', name: asked, level, hash: view.hash })
      .then((r) => onGranted?.((r as { view: ApprovalView }).view))
      .catch((e: Error) => (setError(e), setBusy(false)));
  };
  const keys = trap(root, onClose);

  const m = view?.manifest;
  const canAct = !!m?.permissions.includes('act') && !view?.act_refused;
  // v1b-20: the manifest's `[act]` table, shown verbatim (types.ts predates it).
  const actTable = (m as { act?: Act | null } | undefined)?.act ?? null;
  return (
    <>
      <div className="ps-scrim" onClick={onClose} />
      <div ref={root} className="ps" role="dialog" aria-modal="true" aria-labelledby="ps-title" onKeyDown={keys}>
        <div>
          <h3 id="ps-title">{t('approval.title', { name: plugin ?? name })}</h3>
          <div className="ps-meta">
            {isSource ? t('approval.kindSource') : plugin ? t('plugins.sheet.kind') : t('approval.kindWidget')}
            {m && !plugin && ` · ${m.kind}`}
            {m && (
              <>
                {' · '}
                {t('approval.madeBy')}
                {' '}
                <span data-field="author">{m.author}</span>
              </>
            )}
            {' · '}
            <span className="mono">
              ~/.nunchiro/{isSource ? 'sources' : plugin ? `plugins/${plugin}` : `widgets/${name}`}/
            </span>
            {/* v1a-23 r2: the content this approval is bound to. */}
            {view && (
              <>
                {' · '}
                <span className="mono" data-field="hash">
                  {t('approval.hash', { hash: view.hash.slice(0, 12) })}
                </span>
              </>
            )}{' '}
            · {t('approval.asked')}
          </div>
        </div>
        <ErrorLine t={t} error={error} className="ps-error" />
        {view?.state === 'changed' && (
          <p role="status" className="ps-changed">
            {t('approval.changed')}
          </p>
        )}
        {view && m && plugin && (
          <div data-field="parts">
            <p className="ps-meta">{t('plugins.sheet.notOurs')}</p>
            <b>{t('plugins.sheet.runs')}</b>
            <ul className="ps-parts">
              {(view.parts ?? []).map((p) => (
                <li key={p.name}>
                  {t(p.kind === 'panel' ? 'plugins.sheet.panel' : p.kind === 'check' ? 'plugins.sheet.check' : 'plugins.sheet.command')} · {p.title}
                  <pre>{p.runs.map(word).join(' ')}</pre>
                  {p.check_on && (
                    <p className="ps-meta" data-field="check-does">
                      {t(p.check_on === 'session.start.before' ? 'plugins.sheet.checkStart' : 'plugins.sheet.checkSend')}{' '}
                      {t(p.on_error === 'allow' ? 'plugins.sheet.onErrorAllow' : 'plugins.sheet.onErrorRefuse')}
                    </p>
                  )}
                  <p className="ps-meta" data-field="part-rights">
                    {[
                      p.network?.length ? t('plugins.sheet.net', { hosts: p.network.join(' · ') }) : t('plugins.sheet.noNet'),
                      p.read?.length ? t('plugins.sheet.reads', { paths: p.read.join(' · ') }) : t('plugins.sheet.noReads'),
                      ...(p.interval_secs ? [t('plugins.sheet.every', { secs: p.interval_secs })] : []),
                      ...(p.writes_draft ? [t('plugins.sheet.draft')] : []),
                    ].join(' · ')}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        )}
        {view && m && (
          <>
            <div hidden={!!plugin}>
              <b>
                {m.kind === 'web'
                  ? t('approval.pageToShow')
                  : m.interval_secs
                    ? t('approval.commandEvery', { secs: m.interval_secs })
                    : t('approval.commandNoRepeat')}
              </b>
              <pre data-field="command">{m.kind === 'web' ? m.entry : m.command.map(word).join(' ')}</pre>
              {m.kind !== 'web' && (
                <p className="ps-meta" data-field="runtime-limit">
                  {t('approval.spawnBefore')} <code>posix_spawn</code> {t('approval.spawnAfter')}{' '}
                  {/* v1b-21 r2 (ruling 09:48 Q3): macOS enforces no per-process memory limit. */}
                  {t('approval.runLimits')}
                </p>
              )}
            </div>
            <div className="ps-perm">
              <div className="ps-row">
                <span className="ps-pk">{t('approval.read')}</span>
                <ul>
                  <li>{m.kind === 'web' ? t('approval.showPage') : t('approval.showOutput')}</li>
                  <li>{t('approval.readProjects')}</li>
                </ul>
                <span className="ps-tag">{t('approval.tagDefaultOn')}</span>
              </div>
              <div className="ps-row" hidden={!!plugin}>
                <span className="ps-pk">{t('approval.act')}</span>
                <ul>
                  {view.act_refused ? (
                    <li className="ps-error" data-field="act-refused" id="ps-act-refused">
                      {view.act_refused}
                    </li>
                  ) : (
                    <li>{canAct ? t('approval.actSend') : t('approval.actNotRequested')}</li>
                  )}
                  {/* v1b-20 */}
                  {actTable && (
                    <li>
                      {t('approval.actClick')} <b data-field="act-target">{actTarget(actTable)}</b>:
                      <pre data-field="act-template">{actTable.template}</pre>
                    </li>
                  )}
                  <li>{t('approval.logged', { name })}</li>
                </ul>
                <button
                  className="ps-switch"
                  role="switch"
                  aria-checked={act}
                  aria-label={t('approval.allowAct')}
                  aria-describedby={view.act_refused ? 'ps-act-refused' : undefined}
                  disabled={!canAct}
                  onClick={() => setAct(!act)}
                >
                  <i className={act ? 'on' : ''} /> {act ? t('approval.on') : t('approval.off')}
                </button>
              </div>
              <div className="ps-row ps-never">
                <span className="ps-pk">{t('approval.never')}</span>
                <ul>
                  <li>{t('approval.neverAnswer')}</li>
                  <li>{t('approval.neverChange')}</li>
                </ul>
                <span className="ps-tag">{t('approval.tagAlways')}</span>
              </div>
              <div className="ps-row">
                <span className="ps-pk">{t('approval.network')}</span>
                <span data-field="network">
                  {m.network.length ? (
                    <>
                      {t('approval.netHosts')} <span className="mono">{m.network.join(' · ')}</span> · {t('approval.netBlocked')}
                    </>
                  ) : (
                    t('approval.netNone')
                  )}
                </span>
                <span className="ps-tag">{m.network.length ? t('approval.tagAllowed') : t('approval.tagNone')}</span>
              </div>
              {/* v1b-33 (needs 45): script widgets read their project, cache and tools, plus what they declare. */}
              {(m.kind === 'script' || m.kind === 'plugin') && (
                <div className="ps-row">
                  <span className="ps-pk" id="ps-files">
                    {t('approval.files')}
                  </span>
                  {/* r2 (review S3, S4): named for screen readers; the default names the user tool folders too. */}
                  <div data-field="read" role="group" aria-labelledby="ps-files">
                    {t('approval.filesDefault')}
                    {m.read.length ? (
                      <>
                        {', '}
                        {t('approval.andAlso')}
                        <ul className="mono">
                          {m.read.map((p) => (
                            <li key={p}>{p}</li>
                          ))}
                        </ul>
                      </>
                    ) : (
                      <>{' · '}{t('approval.nothingElse')}</>
                    )}
                    {view.read_home_wide && (
                      <p className="ps-danger" data-field="read-warning" role="note">
                        {t('approval.homeWide')}
                      </p>
                    )}
                  </div>
                  <span className="ps-tag">{m.read.length ? t('approval.tagDeclared') : t('approval.tagDefault')}</span>
                </div>
              )}
            </div>
            {source && (
              <pre data-field="manifest" aria-label={t('approval.manifestFile')}>
                {view.manifest_text}
              </pre>
            )}
          </>
        )}
        <div className="ps-acts">
          <button className="btn" aria-expanded={source} disabled={!view} onClick={() => setSource(!source)}>
            {plugin ? (source ? t('plugins.sheet.hideToml') : t('plugins.sheet.viewToml')) : source ? t('approval.hideToml') : t('approval.viewToml')}
          </button>
          <span className="dim mono" data-field="cli">
            = {view ? view.cli.replace(/--read$/, `--${level}`) : plugin ? `nunchiro plugin allow ${plugin}` : `nunchiro widget allow ${name} --${level}`}
          </span>
          <span className="sp" />
          <button className="btn" data-cancel onClick={onClose}>
            {t('approval.cancel')}
          </button>
          <button className="btn p" disabled={!view || busy} onClick={approve}>
            {act ? t('approval.allowReadAct') : t('approval.allowRead')}
          </button>
        </div>
      </div>
    </>
  );
}
