// Ticket 1057: the changed-files card's fold and the artifact card's fold. English only until ticket 1035 (the prefix is
// not chat.*, whose English text tests/i18n-chat-catalogue.spec.ts pins one by one).
declare module '../index' {
  interface AreaKeys {
    'cards.moreFiles': true;
    'cards.fewer': true;
    'cards.oneFile': true;
    'cards.fold': true;
    'cards.unfold': true;
    'cards.teamUpdate': true;
  }
}

export const en = {
  'cards.moreFiles': '{n} more files',
  'cards.fewer': 'Show fewer',
  'cards.oneFile': '1 file changed, {added} added, {removed} removed, this turn',
  'cards.fold': 'Fold the preview',
  'cards.unfold': 'Show the preview',
  'cards.teamUpdate': 'Team update', // ticket 1085: the quiet row of only the core's heartbeat or nudge lines
};
