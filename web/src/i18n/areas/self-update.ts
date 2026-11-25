// Ticket 1082: the installed app updates itself from the update folder (Settings > About, the status bar item;
// chrome/rcUpdate.ts, features/about.tsx). English only (owner rule 11-21: the other languages get one pass before the
// public release; a missing key shows English).
declare module '../index' {
  interface AreaKeys {
    'selfUpdate.item': true;
    'selfUpdate.ready': true;
    'selfUpdate.install': true;
    'selfUpdate.yes': true;
    'selfUpdate.working': true;
    'selfUpdate.workingOne': true;
    'selfUpdate.off': true;
    'selfUpdate.folder': true;
    'selfUpdate.folderDesc': true;
    'selfUpdate.failed': true;
    'selfUpdate.waiting': true;
  }
}

export const en = {
  'selfUpdate.item': 'New build {version} ready · Install and restart',
  'selfUpdate.ready': 'New build {version} ready',
  'selfUpdate.install': 'Install and restart',
  'selfUpdate.yes': 'Install',
  'selfUpdate.working': '{n} sessions are working. They keep running during the update.',
  'selfUpdate.workingOne': '1 session is working. It keeps running during the update.',
  'selfUpdate.off': 'Off: no update folder is set.',
  'selfUpdate.folder': 'Update folder',
  'selfUpdate.folderDesc': 'A folder with a built Nunchiro.app and its nunchiro-build.json. Leave it empty to turn updates off.',
  'selfUpdate.failed': 'Install failed: {error}',
  'selfUpdate.waiting': 'Waiting for {n} chats or jobs to finish before the update',
};
