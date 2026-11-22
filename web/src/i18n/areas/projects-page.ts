// Ticket 1040 (mockup docs/design/projects-settings-1121/index.html): Settings > Projects, the list and one project's
// page. English only (owner 11-21): the other languages show these in English until their one pass before the public
// release (ticket 1035).
declare module '../index' {
  interface AreaKeys {
    'settings.page.projects': true;
    'settings.desc.projects': true;
    'projectsPage.count.one': true;
    'projectsPage.count.other': true;
    'projectsPage.missing.one': true;
    'projectsPage.missing.other': true;
    'projectsPage.wasFolder': true;
    'projectsPage.state.missing': true;
    'projectsPage.state.offline': true;
    'projectsPage.state.no_access': true;
    'projectsPage.onDisk': true;
    'projectsPage.locate': true;
    'projectsPage.back': true;
    'projectsPage.card.project': true;
    'projectsPage.card.sessions': true;
    'projectsPage.card.sessionsNote': true;
    'projectsPage.card.worktrees': true;
    'projectsPage.card.remove': true;
    'projectsPage.name': true;
    'projectsPage.nameDesc': true;
    'projectsPage.icon': true;
    'projectsPage.iconDesc': true;
    'projectsPage.iconPick': true;
    'projectsPage.folder': true;
    'projectsPage.notFound': true;
    'projectsPage.copyPath': true;
    'projectsPage.reveal': true;
    'projectsPage.modelAndEffort': true;
    'projectsPage.noAgents': true;
    'projectsPage.banner.missing': true;
    'projectsPage.banner.missingWhy': true;
    'projectsPage.banner.offline': true;
    'projectsPage.banner.no_access': true;
    'projectsPage.openPermissions': true;
    'projectsPage.remove': true;
    'projectsPage.removeDesc': true;
    'projectsPage.removeAction': true;
    'projectsPage.locate.title': true;
    'projectsPage.locate.was': true;
    'projectsPage.locate.now': true;
    'projectsPage.locate.moves': true;
    'projectsPage.locate.disk': true;
    'projectsPage.locate.askedAgain': true;
    'projectsPage.locate.use': true;
    'projectsPage.locate.done': true;
    'projectsPage.locate.noPicker': true;
    'projectsPage.moved': true;
    'projectsPage.noCleanup': true;
    'projectsPage.open': true;
  }
}

export const en = {
  'settings.page.projects': 'Projects',
  'settings.desc.projects': 'Every project Nunchiro knows, also the ones folded away in the tree. Open one to set its name, its defaults for new sessions and its worktrees. Add projects and start sessions from the tree.',
  'projectsPage.count.one': '{n} project',
  'projectsPage.count.other': '{n} projects',
  'projectsPage.missing.one': '{n} folder not found',
  'projectsPage.missing.other': '{n} folders not found',
  'projectsPage.wasFolder': 'folder: {name}',
  'projectsPage.state.missing': 'Folder not found',
  'projectsPage.state.offline': 'Disk not connected',
  'projectsPage.state.no_access': 'No access',
  'projectsPage.onDisk': '{name} on the external disk “{disk}”',
  'projectsPage.locate': 'Locate…',
  'projectsPage.back': 'Projects',
  'projectsPage.card.project': 'Project',
  'projectsPage.card.sessions': 'New sessions',
  'projectsPage.card.sessionsNote': '"Follow All projects" uses the value on Settings > Providers.',
  'projectsPage.card.worktrees': 'Worktrees',
  'projectsPage.card.remove': 'Remove',
  'projectsPage.name': 'Name',
  'projectsPage.nameDesc': 'Shown in the tree and on tabs. Empty returns to the folder name.',
  'projectsPage.icon': 'Icon',
  'projectsPage.iconDesc': 'A PNG, JPEG or SVG image up to 256 KB, shown beside the project in the tree.',
  'projectsPage.iconPick': 'Choose image…',
  'projectsPage.folder': 'Folder',
  'projectsPage.notFound': 'not found',
  'projectsPage.copyPath': 'Copy path',
  'projectsPage.reveal': 'Reveal in Finder',
  'projectsPage.modelAndEffort': '{name} model and effort',
  'projectsPage.noAgents': 'No agent is turned on. Turn one on in Settings > Providers.',
  'projectsPage.banner.missing': 'Folder not found:',
  'projectsPage.banner.missingWhy': 'It was moved, renamed or deleted. Locate it to keep this project’s name, group, icon, settings and session history. New sessions cannot start until then.',
  'projectsPage.banner.offline': 'Connect the disk {disk} to use this project.',
  'projectsPage.banner.no_access': 'macOS does not let Nunchiro read this folder.',
  'projectsPage.openPermissions': 'Open Permissions',
  'projectsPage.remove': 'Remove from Nunchiro',
  'projectsPage.removeDesc': 'Closes this project’s sessions and deletes their history. The folder and its files stay on disk.',
  'projectsPage.removeAction': 'Remove from Nunchiro…',
  'projectsPage.locate.title': 'Use this folder for ‘{name}’?',
  'projectsPage.locate.was': 'Was',
  'projectsPage.locate.now': 'Now',
  'projectsPage.locate.moves': 'The name, group, pin, icon, settings and session history move to this folder.',
  'projectsPage.locate.disk': 'Nothing on disk is changed.',
  'projectsPage.locate.askedAgain': 'Permissions, approvals, tokens and schedules for this project are asked again after the move.',
  'projectsPage.locate.use': 'Use this folder',
  'projectsPage.locate.done': '{name} now uses {path}',
  'projectsPage.locate.noPicker': 'The folder picker is only in the Nunchiro app.',
  'projectsPage.noCleanup': 'No cleanup script',
  'projectsPage.moved': 'Setup scripts and shared files are set per project.',
  'projectsPage.open': 'Open Projects',
};
