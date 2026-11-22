// Ticket 1040 (mockup docs/design/projects-settings-1121/index.html; research docs/research/projects-settings-1121.md):
// Settings > Projects. The list has every project the core knows, in the tree's order; a row opens that project's page,
// the one home of what is set per project (its name and icon, its new-session defaults, its worktree settings, remove).
// Adding, opening, groups and pins stay in the tree. The page shape follows T3 Code's ProjectsSettings.tsx and
// ProjectSettingsPanel.tsx (a projects page, then one project's panel) and Orca's RepositoryPane.tsx (every per-project
// value in one pane); Locate follows GitHub Desktop's missing-repository.tsx. Shape only, no code taken.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CoreClient } from '../api';
import { ErrorLine, plainError, rawError } from '../errors';
import type { T } from '../i18n';
import { Icon } from '../icons/Icon';
import { pickFolder } from '../pickFolder';
import { PLAIN } from '../plainText';
import { ModelDefaults } from '../settings/accounts/defaults';
import { AGENTS_OFF, NEW_DEFAULTS, type AgentCli } from '../settings/agents/newDefaults';
import { Reset, Row, Sec, tilde } from '../settings/shell/Row';
import { PageSummary } from '../settings/shell/PageActions';
import { currentFeature, useFeatureSetting, writeFeature } from '../settings/useFeatureSetting';
import { copyText } from '../terminal/clipboard';
import { basename, EMPTY_TREE, projectName, TREE_SET } from '../tree';
import { AlertSheet, askRemoveProject } from '../tree/Dialogs';
import { pickIcon, ProjectIcon } from '../tree/ProjectTools';
import type { TreeState } from '../types';
import { registerSettingsPage, registerSettingsSection, type PageContext } from './registry';
import { SetupScripts } from './setup-scripts';
import { SharedFiles } from './wt-files';
import './projects.css';

/** The core's word for a project's folder (tree.rs `FolderState`); a project the core has not answered for reads `ok`. */
type Folder = 'ok' | 'missing' | 'offline' | 'no_access';
const CLIS: [AgentCli, string][] = [
  ['claude', 'Claude'],
  ['codex', 'Codex'],
];
/** `/Volumes/<disk>/…`: the disk a folder is on, for the row that cannot show a path. */
const diskOf = (p: string) => /^\/Volumes\/([^/]+)/.exec(p)?.[1] ?? '';
/** Locate's own refusals (sessions/locate.rs ALREADY, RUNNING; tree.rs DISK_SILENT): already plain sentences, shown as the
 *  core says them (English only until ticket 1035; a line of the error catalogue needs all eight languages). */
const LOCATE_SAYS = ['That folder is already a project in Nunchiro.', "Stop this project's sessions, then try again.", "That folder's disk did not answer. Try again."];
const groupOf = (tree: TreeState, p: string) => tree.groups.find((g) => g.projects.includes(p))?.name;
/** The tree's order (tree.ts `place`): the ungrouped projects, then each group; pinned ones lead their part. */
function treeOrder(projects: string[], tree: TreeState) {
  const part = (ps: string[]) => [...ps.filter((p) => tree.pins.includes(p)), ...ps.filter((p) => !tree.pins.includes(p))];
  const grouped = tree.groups.map((g) => g.projects.filter((p) => projects.includes(p)));
  const taken = new Set(grouped.flat());
  return [...part(projects.filter((p) => !taken.has(p))), ...grouped.flatMap(part)];
}

/** How often an open Projects page reads its folders again (look v33 S3-4: a folder renamed while a project's page was
 *  open kept its stale path until the list was opened again). One stat per project. */
const FOLDERS_EVERY_MS = 5000;

/** The window's copy of the tree (names and groups) and each folder's state, read when the page opens, when the
 *  window regains focus, when the project list changes and every `FOLDERS_EVERY_MS` while it shows. The folder read is
 *  single-flight: a stalled disk (the core stats each folder) holds one request, never a growing pile, and a hidden
 *  window asks nothing. */
function useProjects(core: CoreClient, paths: string) {
  const [tree, setTree] = useState<TreeState>(EMPTY_TREE);
  const [folders, setFolders] = useState<Record<string, Folder>>({});
  const asking = useRef(false);
  const readFolders = useCallback(() => {
    if (asking.current || document.hidden) return;
    asking.current = true;
    void core
      .request({ op: 'project_folders' })
      .then((r) => setFolders((r as { folders: Record<string, Folder> }).folders), () => {})
      .finally(() => (asking.current = false));
  }, [core]);
  const read = useCallback(() => {
    void core.tree().then(setTree, () => {});
    readFolders();
  }, [core, readFolders]);
  useEffect(() => {
    read();
    const set = (e: Event) => setTree((e as CustomEvent<TreeState>).detail);
    window.addEventListener('focus', read);
    window.addEventListener(TREE_SET, set);
    const every = setInterval(readFolders, FOLDERS_EVERY_MS);
    return () => (clearInterval(every), window.removeEventListener('focus', read), window.removeEventListener(TREE_SET, set));
  }, [read, readFolders, paths]);
  return { tree, folders, read };
}

/** The 24 px mark: the project's image, else its first letter. */
function Mark({ core, project, name }: { core: CoreClient; project: string; name: string }) {
  return (
    <span className="pj-mark" aria-hidden>
      {[...name][0]?.toUpperCase()}
      <ProjectIcon core={core} project={project} />
    </span>
  );
}

function StateChip({ t, folder }: { t: T; folder: Folder }) {
  return folder === 'ok' ? null : <span className={`pj-chip dot ${folder === 'missing' ? 'bad' : 'warn'}`}>{t(`projectsPage.state.${folder}`)}</span>;
}

/** Frame 4: the picked folder, confirmed once. A refusal is one line here and changes nothing. */
function LocateDialog({ core, t, project, name, to, onDone, onClose }: { core: CoreClient; t: T; project: string; name: string; to: string; onDone: (now: string, tree: TreeState) => void; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const use = () => {
    setBusy(true);
    setError('');
    core
      .request({ op: 'project_locate', from: project, to })
      .then(
        (r) => {
          const { project: now, tree } = r as { project: string; tree: TreeState };
          onDone(now, tree);
        },
        (e) => setError(LOCATE_SAYS.includes(rawError(e)) ? rawError(e) : plainError(t, e)),
      )
      .finally(() => setBusy(false));
  };
  return (
    <AlertSheet wide label={t('projectsPage.locate.title', { name })} onClose={() => void (busy || onClose())}>
      {[
        ['was', project],
        ['now', to],
      ].map(([k, p]) => (
        <div key={k} className="rmpath pj-was-now">
          <small>{t(`projectsPage.locate.${k as 'was' | 'now'}`)}</small>
          {tilde(p)}
        </div>
      ))}
      <ul className="rmfacts">
        <li className="stay">
          <Icon name="check" size={14} />
          <span>{t('projectsPage.locate.moves')}</span>
        </li>
        <li className="stay">
          <Icon name="check" size={14} />
          <span>{t('projectsPage.locate.disk')}</span>
        </li>
        {/* The grants fail closed (sessions/locate.rs): none follows the project to its new folder. */}
        <li className="gone">
          <Icon name="x" size={14} />
          <span>{t('projectsPage.locate.askedAgain')}</span>
        </li>
      </ul>
      {error && (
        <div role="alert" className="rmerr">
          {error}
        </div>
      )}
      <p className="rmacts">
        <button className="btn" onClick={() => void (busy || onClose())}>
          {t('dialog.cancel')}
        </button>
        <button className="btn p" disabled={busy} onClick={use}>
          {t('projectsPage.locate.use')}
        </button>
      </p>
    </AlertSheet>
  );
}

/** What the window itself keeps under the old path (localStorage): the new-session defaults. The core's reply came first. */
function moveWindowValues(from: string, to: string) {
  const stored = currentFeature(NEW_DEFAULTS);
  const { [from]: mine, ...rest } = stored.projects;
  if (mine) writeFeature(NEW_DEFAULTS, { ...stored, projects: { ...rest, [to]: mine } });
}

function Name({ t, value, folderName, save }: { t: T; value: string; folderName: string; save: (name: string) => Promise<string | null> }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState('');
  const commit = () => {
    if (draft === null) return;
    const name = draft.trim() === folderName ? '' : draft.trim(); // the folder name is "no name", as an empty field
    if (name !== (value === folderName ? '' : value)) void save(name).then((refused) => setError(refused ?? ''));
    setDraft(null);
  };
  return (
    <>
      <input {...PLAIN} className="search pj-name-in" aria-label={t('projectsPage.name')} autoComplete="off" spellCheck={false} maxLength={64} value={draft ?? value} onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && commit()} />
      <ErrorLine t={t} error={error} className="err" />
    </>
  );
}

function OneProject({ ctx, project, tree, folder, back, locate }: { ctx: PageContext; project: string; tree: TreeState; folder: Folder; back: () => void; locate: () => void }) {
  const { core, t } = ctx;
  const name = projectName(tree, project);
  const group = groupOf(tree, project);
  const [off] = useFeatureSetting(AGENTS_OFF);
  const [stored, setStored] = useFeatureSetting(NEW_DEFAULTS);
  const [iconError, setIconError] = useState('');
  const file = useRef<HTMLInputElement>(null);
  const top = useRef<HTMLButtonElement>(null);
  useEffect(() => top.current?.focus(), [project]);
  const rename = (next: string) =>
    core.treeEdit({ op: 'project_name', project, name: next }).then(
      (now) => (window.dispatchEvent(new CustomEvent(TREE_SET, { detail: now })), null),
      (e) => plainError(t, e),
    );
  const mine = stored.projects[project] ?? {};
  const clear = (kind: AgentCli) => {
    const { [kind]: _gone, ...rest } = mine;
    const { [project]: _mine, ...others } = stored.projects;
    setStored({ ...stored, projects: Object.keys(rest).length ? { ...others, [project]: rest } : others });
  };
  const disk = diskOf(project);
  const locateButton = (primary?: boolean) => (
    <button type="button" className={primary ? 'btn p' : 'btn'} onClick={locate}>
      {t('projectsPage.locate')}
    </button>
  );
  return (
    <div className="pj-one" data-project={project}>
      <button ref={top} type="button" className="pj-crumb" onClick={back}>
        <span aria-hidden>‹ </span>
        {t('projectsPage.back')}
      </button>
      <div className="pj-head">
        <Mark core={core} project={project} name={name} />
        <h2>{name}</h2>
        {group && <span className="pj-chip">{group}</span>}
        <StateChip t={t} folder={folder} />
      </div>
      {folder !== 'ok' && (
        <div className={`pj-banner ${folder === 'missing' ? 'bad' : 'warn'}`} role="alert">
          <div className="pj-btx">
            {folder === 'missing' ? (
              <>
                <b>{t('projectsPage.banner.missing')}</b> <code>{tilde(project)}</code>
                <div>{t('projectsPage.banner.missingWhy')}</div>
              </>
            ) : folder === 'offline' ? (
              t('projectsPage.banner.offline', { disk })
            ) : (
              t('projectsPage.banner.no_access')
            )}
          </div>
          {folder === 'missing' && locateButton(true)}
          {folder === 'no_access' && '__TAURI_INTERNALS__' in window && (
            <button type="button" className="btn" onClick={() => ctx.reveal('permissions', 'h1')}>
              {t('projectsPage.openPermissions')}
            </button>
          )}
        </div>
      )}
      <Sec id="h-pj-project" title={t('projectsPage.card.project')}>
        <Row setting="projects.name" label={t('projectsPage.name')} desc={t('projectsPage.nameDesc')} control={<Name key={project} t={t} value={name} folderName={basename(project)} save={rename} />} />
        <Row
          setting="projects.icon"
          label={t('projectsPage.icon')}
          desc={t('projectsPage.iconDesc')}
          extra={<ErrorLine t={t} error={iconError} className="err" />}
          control={
            <>
              <Mark core={core} project={project} name={name} />
              <button type="button" className="btn" onClick={() => file.current?.click()}>
                {t('projectsPage.iconPick')}
              </button>
              <input ref={file} type="file" hidden accept="image/png,image/jpeg,image/svg+xml" aria-label={t('projectsPage.icon')} onChange={(e) => (void pickIcon(core, project, e.target.files?.[0], setIconError, t), (e.target.value = ''))} />
            </>
          }
        />
        <Row
          setting="projects.folder"
          label={t('projectsPage.folder')}
          desc={
            <span className={folder === 'missing' ? 'pj-gone' : undefined}>
              <code>{tilde(project)}</code>
              {folder === 'missing' && ` · ${t('projectsPage.notFound')}`}
            </span>
          }
          control={
            <>
              <button type="button" className="btn pj-ghost" onClick={() => void copyText(project)}>
                {t('projectsPage.copyPath')}
              </button>
              {folder === 'missing'
                ? locateButton()
                : '__TAURI_INTERNALS__' in window && (
                    <button type="button" className="btn" disabled={folder !== 'ok'} onClick={() => void import('@tauri-apps/plugin-opener').then((o) => o.revealItemInDir(project)).catch(() => {})}>
                      {t('projectsPage.reveal')}
                    </button>
                  )}
            </>
          }
        />
      </Sec>
      <Sec
        label={t('projectsPage.card.sessions')}
        title={
          <>
            {t('projectsPage.card.sessions')} <small className="pj-note">{t('projectsPage.card.sessionsNote')}</small>
          </>
        }
      >
        {CLIS.filter(([kind]) => !off.includes(kind)).map(([kind, agent]) => (
          <Row
            key={kind}
            setting={`projects.defaults.${kind}`}
            label={agent}
            control={
              <div className="pj-defaults">
                <ModelDefaults t={t} core={core} kind={kind} name={agent} project={project} />
                {/* One reset for the pair, at the row's end (mockup frame 2), not the kit's place after the label. */}
                <Reset t={t} label={t('projectsPage.modelAndEffort', { name: agent })} show={!!mine[kind]?.model || !!mine[kind]?.effort} run={() => clear(kind)} />
              </div>
            }
          />
        ))}
        {CLIS.every(([kind]) => off.includes(kind)) && <Row label={t('projectsPage.noAgents')} />}
      </Sec>
      <Sec id="h-pj-worktrees" title={t('projectsPage.card.worktrees')}>
        <SetupScripts key={`s:${project}`} t={t} project={project} />
        <SharedFiles key={`f:${project}`} t={t} project={project} />
      </Sec>
      <Sec id="h-pj-remove" title={t('projectsPage.card.remove')} className="pj-danger">
        <Row
          setting="projects.remove"
          label={t('projectsPage.remove')}
          desc={t('projectsPage.removeDesc')}
          control={
            <button type="button" className="btn pj-x" onClick={() => askRemoveProject(project)}>
              {t('projectsPage.removeAction')}
            </button>
          }
        />
      </Sec>
    </div>
  );
}

function ProjectsPage(ctx: PageContext) {
  const { core, t, projects } = ctx;
  const { tree, folders, read } = useProjects(core, projects.join('\n'));
  const [open, setOpen] = useState<string | null>(null);
  const [asking, setAsking] = useState<{ project: string; to: string } | null>(null);
  const [error, setError] = useState('');
  const state = (p: string): Folder => folders[p] ?? 'ok';
  const locate = (project: string) => {
    setError('');
    pickFolder(project.replace(/\/[^/]+\/*$/, '') || '/').then(
      (to) => to && setAsking({ project, to }),
      () => setError(t('projectsPage.locate.noPicker')),
    );
  };
  const dialog = asking && (
    <LocateDialog
      core={core}
      t={t}
      project={asking.project}
      name={projectName(tree, asking.project)}
      to={asking.to}
      onClose={() => setAsking(null)}
      onDone={(now, next) => {
        const name = projectName(tree, asking.project);
        moveWindowValues(asking.project, now);
        window.dispatchEvent(new CustomEvent(TREE_SET, { detail: next }));
        setOpen((o) => (o === asking.project ? now : o));
        setAsking(null);
        read();
        ctx.toast?.(t('projectsPage.locate.done', { name, path: tilde(now) }));
      }}
    />
  );
  const shown = open !== null && projects.includes(open) ? open : null; // a removed project's page is the list again
  if (shown)
    return (
      <>
        <ErrorLine t={t} error={error} className="err" />
        <OneProject ctx={ctx} project={shown} tree={tree} folder={state(shown)} back={() => setOpen(null)} locate={() => locate(shown)} />
        {dialog}
      </>
    );
  const missing = projects.filter((p) => state(p) === 'missing').length;
  return (
    <div className="pj-page">
      {/* Ticket 1043: the count line is the page's summary under its title. */}
      <PageSummary parts={[[t('summary.projects'), projects.length], [t('summary.notFound'), missing > 0 && <span className="pj-missing">{missing}</span>]]} />
      <ErrorLine t={t} error={error} className="err" />
      <ul className="pj-list" aria-label={t('settings.page.projects')}>
        {treeOrder(projects, tree).map((p) => {
          const [name, folder, group] = [projectName(tree, p), state(p), groupOf(tree, p)];
          return (
            <li key={p} className="pj-row" data-project={p} data-folder={folder}>
              <Mark core={core} project={p} name={name} />
              <button type="button" className="pj-open" onClick={() => setOpen(p)}>
                <span className="pj-nm">
                  <span className="pj-name">{name}</span>
                  {name !== basename(p) && <span className="pj-was">{t('projectsPage.wasFolder', { name: basename(p) })}</span>}
                  {group && <span className="pj-chip">{group}</span>}
                </span>
                {folder === 'offline' ? <span className="pj-path disk">{t('projectsPage.onDisk', { name: basename(p), disk: diskOf(p) })}</span> : <code className="pj-path">{tilde(p)}</code>}
              </button>
              <span className="pj-st">
                <StateChip t={t} folder={folder} />
                {folder === 'missing' && (
                  <button type="button" className="btn" onClick={() => locate(p)}>
                    {t('projectsPage.locate')}
                  </button>
                )}
              </span>
              <span className="pj-chv" aria-hidden>
                ›
              </span>
            </li>
          );
        })}
      </ul>
      {dialog}
    </div>
  );
}

registerSettingsPage({
  id: 'projects',
  title: 'Projects',
  group: 'git',
  order: 0,
  // The moved fields (ticket 1040): found by the settings search and the palette as before; with no project open the
  // page shows the list, as a field of one project needs a project first.
  fields: [
    { key: 'setupScript', at: '[data-setting="setupScript"]' },
    { key: 'cleanupScript', at: '[data-setting="cleanupScript"]' },
    { key: 'setupPolicy', at: '[data-setting="setupPolicy"]:checked' },
    { key: 'setupWait', at: '[data-setting="setupWait"]' },
    // data-row, not data-setting: a data-setting key must be in the static FIELDS list (settings-search spec, 11-20 gate red).
    { key: 'sharedFiles', at: '[data-row="worktree.shared.files"] input.search' },
    { key: 'sparsePreset', at: '[data-row="worktree.shared.sparse"] textarea' },
  ],
  render: (ctx) => <ProjectsPage {...ctx} />,
});

// Where the two sections were on Git & Worktrees: one line and the way to their new home.
registerSettingsSection({
  page: 'git',
  id: 'git.projects-moved',
  order: 20,
  render: ({ t, reveal }) => (
    <Sec label={t('settings.page.projects')}>
      <Row
        label={t('projectsPage.moved')}
        control={
          <button type="button" className="btn" onClick={() => reveal('projects', '.pj-open')}>
            {t('projectsPage.open')}
          </button>
        }
      />
    </Sec>
  ),
});
