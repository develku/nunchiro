// Ticket 1031: the status bar's usage block and its popover (chrome/UsageBlock.tsx). English only (owner rule 11-21:
// the other languages get one pass before the public release; a missing key shows English).
declare module '../index' {
  interface AreaKeys {
    'usageBar.used': true;
    'usageBar.noData': true;
    'usageBar.all': true;
    'usageBar.density': true;
    'usageBar.detailed': true;
    'usageBar.compact': true;
    'usageBar.resetsIn': true;
    'usageBar.session': true;
    'usageBar.weekly': true;
    'usageBar.details': true;
    'usageBar.oneReset': true;
    'usageBar.resetsOff': true;
    'usageBar.resetsNote': true;
    'usageBar.asOf': true;
  }
}

export const en = {
  'usageBar.used': 'Used',
  'usageBar.noData': 'no data',
  'usageBar.all': 'all accounts',
  'usageBar.density': 'Density',
  'usageBar.detailed': 'Detailed',
  'usageBar.compact': 'Compact',
  'usageBar.resetsIn': 'Resets in {time}',
  'usageBar.session': '5h',
  'usageBar.weekly': 'wk',
  'usageBar.details': 'Usage details & history',
  'usageBar.oneReset': '1 reset',
  'usageBar.resetsOff': 'Codex resets: off',
  'usageBar.resetsNote': 'Turning it on starts nothing. Refresh then runs your own codex once per account.',
  'usageBar.asOf': 'as of {time}', // ticket 1036: a Claude record older than 10 minutes
};
