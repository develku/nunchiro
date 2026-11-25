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
    'chatAccent.title': true;
    'chatAccent.desc': true;
    'chatAccent.s0': true;
    'chatAccent.s1': true;
    'chatAccent.s2': true;
    'chatAccent.s3': true;
    'chatAccent.s4': true;
    'chatAccent.s5': true;
    'chatAccent.s6': true;
  }
}

export const en = {
  'chatColours.title': 'Chat colours',
  'chatColours.desc': 'Headings, bold, code, file paths, links and tool names in a chat take theme colours. Plain turns this off.',
  'chatColours.accents': 'Theme accents',
  'chatColours.plain': 'Plain',
  'chatAccent.title': 'Chat accent',
  'chatAccent.desc': 'The theme colour for headings and bold in a chat. Code and links keep their own colours. Off while Chat colours is Plain.',
  'chatAccent.s0': 'Theme colour',
  'chatAccent.s1': 'Red',
  'chatAccent.s2': 'Green',
  'chatAccent.s3': 'Yellow',
  'chatAccent.s4': 'Blue',
  'chatAccent.s5': 'Magenta',
  'chatAccent.s6': 'Cyan',
};
