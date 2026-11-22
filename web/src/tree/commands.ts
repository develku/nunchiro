// V2-9a: every group action is a palette command (the right-click menu rows are the same commands). From the palette they
// act on the active session's project; a project row hands its own path as the argument (370: a row with no session activates nothing).
import type { Command } from '../keys';
import { FILING, FOLDER, SURFACES } from '../menu/surfaces';
import { askAddProject } from '../NewSession';
import { EXPAND_ALL, projectName } from '../tree';
import type { Session } from '../types';
import { moveProject } from './dragProject';
import { enT, type ProjectTree, type T } from './state';

// The menu offers a surface's commands in the palette's order: the order here is the menu's order.
Object.assign(SURFACES, {
  // Ticket 990: 'lead.add' (Add a leader…) is listed only while the project has no lead (LeaderDialog.leaderCommands).
  project: [...SURFACES.tree, 'worktree.create', 'lead.add', ...FILING, 'group.remove', ...FOLDER, 'project.remove'],
  // An ungrouped project's row has nothing to remove it from: the menu does not offer it (it cannot show an item disabled).
  'project-loose': [...SURFACES.tree, 'worktree.create', 'lead.add', ...FILING, ...FOLDER, 'project.remove'],
  // 370: Remove was never checked against another machine's sessions, so those heads do not offer it.
  'project-remote': [...SURFACES.tree, 'worktree.create', ...FILING, 'group.remove', ...FOLDER],
  'project-remote-loose': [...SURFACES.tree, 'worktree.create', ...FILING, ...FOLDER],
  // 370: a project with no session. session.* and worktree.create would act on the active session's project, so they are not here.
  'project-empty': ['lead.add', ...FILING, 'group.remove', ...FOLDER],
  'project-empty-loose': ['lead.add', ...FILING, ...FOLDER],
  group: ['group.rename', 'group.dissolve'],
});

/** `home`: the Home folder while the tree draws it as the Home group (a Home teammate exists), else ''. */
export function projectCommands(pt: ProjectTree, current: Session | null, sessions: Session[], t: T = enT, home = ''): Command[] {
  const project = current?.project;
  const group = project ? pt.tree.groups.find((g) => g.projects.includes(project)) : undefined;
  // What the menu shows follows the right-clicked row; what runs follows the active session (the menu makes the row's active first).
  const shown = pt.menuProject ?? project;
  const shownGroup = shown ? pt.tree.groups.find((g) => g.projects.includes(shown)) : undefined;
  const shownPinned = !!shown && pt.tree.pins.includes(shown);
  // The right-clicked project is the argument (the menu hands it to each TAKES_PROJECT item), not menuProject.
  const onProject = (act: (p: string) => void) => (arg?: string) => {
    const p = arg ?? project;
    if (p) act(p);
  };
  const some: Command['enabledFor'] = ({ arg }) => !!(arg ?? project);
  // Look 1117 v11 (v10 N4): a greyed row says why, not "Not available here" (shown only while the row is off).
  const noProject = t('palette.why.noProject');
  const noGroup = shown ? t('palette.why.noGroup') : noProject;
  return [
    { id: 'group.move', title: t('tree.group.move'), enabled: !!shown, why: noProject, enabledFor: some, run: onProject((p) => pt.setAsk({ kind: 'move', project: p })) },
    { id: 'group.create', title: t('tree.group.new'), enabled: !!shown, why: noProject, enabledFor: some, run: onProject((p) => pt.setAsk({ kind: 'create', project: p })) },
    { id: 'project.pin', title: t(shownPinned ? 'tree.unpin' : 'tree.pin'), enabled: !!shown, why: noProject, enabledFor: some, run: onProject((p) => void pt.edit({ op: 'pin', project: p, pinned: !pt.tree.pins.includes(p) })) },
    { id: 'project.rename', title: t('tree.project.rename'), enabled: !!shown, why: noProject, enabledFor: some, run: onProject((p) => pt.setAsk({ kind: 'name', project: p })) },
    // Look 1117 v12 Home S3-3: Home is no project in the tree; its palette row offered "Remove 'home' from the tree?".
    { id: 'project.remove', title: t('tree.project.remove'), enabled: !!shown && shown !== home && !sessions.some((s) => s.project === shown && s.machine), why: !shown ? noProject : shown === home ? t('palette.why.home') : t('palette.why.remoteSessions'), enabledFor: some, run: onProject((p) => pt.setAsk({ kind: 'remove', project: p })) },
    { id: 'group.remove', title: t('tree.group.remove'), enabled: !!shownGroup, why: noGroup, enabledFor: ({ arg }) => pt.tree.groups.some((g) => g.projects.includes(arg ?? project ?? '')), run: onProject((p) => void moveProject(pt, t, p, projectName(pt.tree, p), null)) },
    { id: 'group.rename', title: t('tree.group.rename'), enabled: !!shownGroup, why: noGroup, run: () => project && group && pt.setAsk({ kind: 'rename', project, group: group.name }) },
    { id: 'group.dissolve', title: t('tree.group.dissolve'), enabled: !!shownGroup, why: noGroup, run: () => group && void pt.edit({ op: 'group_dissolve', name: group.name }) },
    { id: 'tree.expand-all', title: t('tree.expandAllCmd'), run: () => window.dispatchEvent(new CustomEvent(EXPAND_ALL, { detail: { deep: false } })) },
    { id: 'projects.pick', title: t('tree.picker.title'), run: () => pt.setPicking(true) },
    { id: 'project.add', title: t('landing.addProject'), run: askAddProject },
  ];
}
