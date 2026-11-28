// A bot's memory: its Memory tab and the Bots view's Memory settings (web/src/bots/BotMemory.tsx). English only until the
// pre-release pass.
declare module '../index' {
  interface AreaKeys {
    'memory.tab.profile': true;
    'memory.tab.memory': true;
    'memory.tabs': true;
    'memory.always': true;
    'memory.always.note': true;
    'memory.soul.note': true;
    'memory.index.note': true;
    'memory.user.note': true;
    'memory.index': true;
    'memory.index.lede': true;
    'memory.index.empty': true;
    'memory.edit': true;
    'memory.edit.label': true;
    'memory.edit.save': true;
    'memory.edit.cancel': true;
    'memory.from': true;
    'memory.from.you': true;
    'memory.from.conversation': true;
    'memory.from.mail': true;
    'memory.from.web': true;
    'memory.from.tool': true;
    'memory.from.unknown': true;
    'memory.forget': true;
    'memory.forget.ask': true;
    'memory.forget.why': true;
    'memory.forget.cancel': true;
    'memory.more': true;
    'memory.more.one': true;
    'memory.fewer': true;
    'memory.proposals': true;
    'memory.proposals.one': true;
    'memory.topics': true;
    'memory.topics.note': true;
    'memory.topics.none': true;
    'memory.topic.lines': true;
    'memory.topic.one': true;
    'memory.copies': true;
    'memory.copies.note': true;
    'memory.copies.none': true;
    'memory.copy.tidy': true;
    'memory.copy.edit': true;
    'memory.copy.undo': true;
    'memory.copy.before': true;
    'memory.copy.today': true;
    'memory.undo': true;
    'memory.settings': true;
    'memory.settings.note': true;
    'memory.keep': true;
    'memory.keep.desc': true;
    'memory.keep.days': true;
  }
}
export const en = {
  'memory.tab.profile': 'Profile',
  'memory.tab.memory': 'Memory',
  'memory.tabs': "{name}'s page",
  'memory.always': 'Always read',
  'memory.always.note': 'in every brief, on any agent',
  'memory.soul.note': 'who {name} is · {n} lines',
  'memory.index.note': 'the index · {n} of {limit} lines',
  'memory.user.note': 'about you · shared by every bot',
  'memory.index': 'MEMORY.md',
  'memory.index.lede': 'one fact per line, with its date and where it came from',
  'memory.index.empty': 'Nothing yet. {name} keeps a line here when it learns something lasting.',
  'memory.edit': 'Edit',
  'memory.edit.label': "{name}'s memory index",
  'memory.edit.save': 'Save',
  'memory.edit.cancel': 'Cancel',
  'memory.from': 'from: {source}',
  'memory.from.you': 'you',
  'memory.from.conversation': 'a conversation',
  'memory.from.mail': 'mail',
  'memory.from.web': 'web',
  'memory.from.tool': 'a tool',
  'memory.from.unknown': 'unknown',
  'memory.forget': 'Forget',
  'memory.forget.ask': 'Forget this line?',
  'memory.forget.why': 'It is deleted from MEMORY.md and from the saved copies. This cannot be undone.',
  'memory.forget.cancel': 'Cancel',
  'memory.more': '{n} more lines',
  'memory.more.one': '1 more line',
  'memory.fewer': 'Show fewer',
  'memory.proposals': '{n} proposals wait for your look',
  'memory.proposals.one': '1 proposal waits for your look',
  'memory.topics': 'Topic files',
  'memory.topics.note': 'read when an index line points to them',
  'memory.topics.none': 'None yet.',
  'memory.topic.lines': '{n} lines',
  'memory.topic.one': '1 line',
  'memory.copies': 'Saved copies',
  'memory.copies.note': 'kept {n} days',
  'memory.copies.none': 'None yet. A copy is saved before every change you make.',
  'memory.copy.tidy': 'Night tidy · {n} lines changed',
  'memory.copy.edit': 'You edited MEMORY.md',
  'memory.copy.undo': 'Before an Undo',
  'memory.copy.before': 'Before the new memory format',
  'memory.copy.today': 'Today {time}',
  'memory.undo': 'Undo',
  'memory.settings': 'Memory',
  'memory.settings.note': 'For every bot.',
  'memory.keep': 'Keep saved copies',
  'memory.keep.desc': 'Undo works on a copy while it is kept. Forget also deletes the line from every copy.',
  'memory.keep.days': '{n} days',
};
