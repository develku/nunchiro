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
    'memory.tidy': true;
    'memory.tidy.desc': true;
    'memory.tidy.every': true;
    'memory.tidy.every.1': true;
    'memory.tidy.every.3': true;
    'memory.tidy.every.7': true;
    'memory.tidy.runs': true;
    'memory.tidy.runs.desc': true;
    'memory.tidy.agent': true;
    'memory.tidy.model': true;
    'memory.tidy.codex': true;
    'memory.tidy.stats': true;
    'memory.tidy.bot': true;
    'memory.tidy.bot.follow': true;
    'memory.tidy.state.on': true;
    'memory.tidy.state.off': true;
    'memory.tidy.choice': true;
    'memory.tidy.choice.follow': true;
    'memory.tidy.choice.on': true;
    'memory.tidy.choice.off': true;
    'tidy.night.title': true;
    'tidy.night.title.one': true;
    'tidy.night.ran': true;
    'tidy.night.counts': true;
    'tidy.night.from': true;
    'tidy.night.notKept': true;
    'tidy.night.notKept.one': true;
    'tidy.night.note': true;
    'tidy.night.checked': true;
    'tidy.night.discard': true;
    'tidy.night.apply': true;
    'tidy.night.open': true;
    'tidy.night.remove': true;
    'tidy.night.add': true;
    'tidy.night.keep': true;
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
  'memory.tidy': 'Night tidy',
  'memory.tidy.desc': 'When Nunchiro is idle, only for bots that talked since. It uses your usage.',
  'memory.tidy.every': 'How often',
  'memory.tidy.every.1': 'Every night',
  'memory.tidy.every.3': 'Every 3 nights',
  'memory.tidy.every.7': 'Weekly',
  'memory.tidy.runs': 'Tidy runs on',
  'memory.tidy.runs.desc': 'An agent that runs with no tools reads only the index, never what waits from outside.',
  'memory.tidy.agent': 'Agent',
  'memory.tidy.model': 'Model',
  'memory.tidy.codex': 'Codex: not available, its runs keep their shell tool and your MCP servers',
  'memory.tidy.stats': '{runs} runs and {tokens} tokens in the last 7 nights · {off} bots turned it off',
  'memory.tidy.bot': 'Night tidy for {name}',
  'memory.tidy.bot.follow': 'follows the memory settings for every bot: {state}.',
  'memory.tidy.state.on': '{every}, on Claude {model}',
  'memory.tidy.state.off': 'off',
  'memory.tidy.choice': "{name}'s night tidy",
  'memory.tidy.choice.follow': 'Follow',
  'memory.tidy.choice.on': 'On',
  'memory.tidy.choice.off': 'Off',
  'tidy.night.title': 'Night tidy for {n} bots',
  'tidy.night.title.one': 'Night tidy for {name}',
  'tidy.night.ran': 'ran {time} · Claude · {model} · {tokens} tokens',
  'tidy.night.counts': '{changes} changed lines · {proposals} waiting from outside',
  'tidy.night.from': 'from {source} · waiting since {date}',
  'tidy.night.notKept.one': '1 line was not kept: it read like an instruction inside outside content.',
  'tidy.night.notKept': '{n} lines were not kept: they read like instructions inside outside content.',
  'tidy.night.note': "The old memory stays as a saved copy. Undo in each bot's Memory while it is kept.",
  'tidy.night.checked': '{n} of {total} lines checked',
  'tidy.night.discard': 'Discard',
  'tidy.night.apply': 'Apply checked',
  'tidy.night.open': "Open {name}'s memory",
  'tidy.night.remove': 'Remove: {text}',
  'tidy.night.add': 'Add: {text}',
  'tidy.night.keep': 'Keep: {text}',
};
