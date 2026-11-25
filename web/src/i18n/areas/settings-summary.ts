// Ticket 1043 (mockup docs/design/settings-1122 A): the one line of current values under a Settings page title
// (settings/shell/PageActions.tsx PageSummary). English only until the pre-release pass adds the other seven.
declare module '../index' {
  interface AreaKeys {
    'summary.language': true;
    'summary.theme': true;
    'summary.followsSystem': true;
    'summary.oneTheme': true;
    'summary.rows': true;
    'summary.chatText': true;
    'summary.font': true;
    'summary.scrollback': true;
    'summary.lines': true;
    'summary.copyOnSelect': true;
    'summary.on': true;
    'summary.off': true;
    'summary.newSplit': true;
    'summary.answer': true;
    'summary.level': true;
    'summary.shortcuts': true;
    'summary.changed': true;
    'summary.conflicts': true;
    'summary.agents': true;
    'summary.accounts': true;
    'summary.setup': true;
    'summary.stepsDone': true;
    'summary.of': true;
    'summary.search': true;
    'summary.zoom': true;
    'summary.viewport': true;
    'summary.range': true;
    'summary.teammates': true;
    'summary.assistant': true;
    'summary.noAssistant': true;
    'summary.mode': true;
    'summary.notes': true;
    'summary.itemsOn': true;
    'summary.mcp': true;
    'summary.services': true;
    'summary.access': true;
    'summary.paired': true;
    'summary.libraries': true;
    'summary.history': true;
    'summary.masked': true;
    'summary.version': true;
    'summary.projects': true;
    'summary.notFound': true;
    'summary.machines': true;
    'summary.connected': true;
    'summary.unreachable': true;
  }
}

export const en = {
  'summary.language': 'Language',
  'summary.theme': 'Theme',
  'summary.followsSystem': 'follows the system',
  'summary.oneTheme': 'one theme',
  'summary.rows': 'Rows',
  'summary.chatText': 'Chat text',
  'summary.font': 'Font',
  'summary.scrollback': 'Scrollback',
  'summary.lines': '{n} lines',
  'summary.copyOnSelect': 'Copy on select',
  'summary.on': 'On',
  'summary.off': 'Off',
  'summary.newSplit': 'New split',
  'summary.answer': 'Where you answer',
  'summary.level': 'Alerts',
  'summary.shortcuts': 'Shortcuts',
  'summary.changed': 'Changed',
  'summary.conflicts': 'Shared keys',
  'summary.agents': 'Agents',
  'summary.accounts': 'Accounts',
  'summary.setup': 'Setup',
  'summary.stepsDone': '{done} of {all} done',
  'summary.of': '{n} of {all}',
  'summary.search': 'Search',
  'summary.zoom': 'Zoom',
  'summary.viewport': 'Viewport',
  'summary.range': 'Range',
  'summary.teammates': 'Teammates',
  'summary.assistant': 'Main assistant',
  'summary.noAssistant': 'none yet',
  'summary.mode': 'Mode',
  'summary.notes': 'Notes',
  'summary.itemsOn': 'Turned on',
  'summary.mcp': 'MCP servers',
  'summary.services': 'Services signed in',
  'summary.access': 'Phone and web access',
  'summary.paired': 'Paired browsers',
  'summary.libraries': 'Libraries',
  'summary.history': 'Terminal history kept',
  'summary.masked': 'Secrets masked',
  'summary.version': 'Version',
  'summary.projects': 'Projects',
  'summary.notFound': 'Not found',
  'summary.machines': 'Machines',
  'summary.connected': 'Connected',
  'summary.unreachable': 'Unreachable',
};
