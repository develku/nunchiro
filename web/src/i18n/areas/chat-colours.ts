// Ticket 1039 (mockup docs/design/chat-theme-1121/index.html): the Chat colours row on Settings > Appearance. English only
// (owner 11-21): the other languages show these in English until their one pass before the public release. The row is not
// a search field yet: a field needs search words in all 8 languages (settings-search-all-languages.spec.ts), so it joins
// FIELDS (features/builtin.ts) with that pass.
declare module '../index' {
  interface AreaKeys {
    'chatColours.title': true;
    'chatColours.desc': true;
    'chatColours.accents': true;
    'chatColours.plain': true;
  }
}

export const en = {
  'chatColours.title': 'Chat colours',
  'chatColours.desc': 'Headings, bold, code, file paths, links and tool names in a chat take theme colours. Plain turns this off.',
  'chatColours.accents': 'Theme accents',
  'chatColours.plain': 'Plain',
};
