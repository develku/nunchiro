// Ticket 1168 (mockup docs/design/bots-1166.html): the Bots view, a bot's face and its seat. English only until the
// pre-release pass (owner 2026-11-21).
declare module '../index' {
  interface AreaKeys {
    'bots.title': true;
    'bots.cmd.open': true;
    'bots.count.one': true;
    'bots.count.other': true;
    'bots.sum.look': true;
    'bots.sum.work': true;
    'bots.sum.rest': true;
    'bots.new': true;
    'bots.group.seat': true;
    'bots.group.seatNote': true;
    'bots.group.none': true;
    'bots.group.noneNote': true;
    'bots.empty': true;
    'bots.face': true;
    'bots.state.rest': true;
    'bots.state.work': true;
    'bots.state.look': true;
    'bots.now.rest': true;
    'bots.now.work': true;
    'bots.now.look': true;
    'bots.seat.chief': true;
    'bots.seat.lead': true;
    'bots.model.follows': true;
    'bots.model.pinned': true;
    'bots.back': true;
    'bots.openChat': true;
    'bots.soul': true;
    'bots.soul.who': true;
    'bots.soul.edit': true;
    'bots.soul.save': true;
    'bots.soul.cancel': true;
    'bots.soul.label': true;
    'bots.schedules': true;
    'bots.schedules.none': true;
    'bots.schedules.open': true;
    'bots.schedules.paused': true;
    'bots.models': true;
    'bots.models.follow': true;
    'bots.models.pinned': true;
    'bots.models.save': true;
    'bots.moved': true;
    'bots.movedDesc': true;
    'bots.open': true;
    'bots.cmd.new': true;
    'bots.new.title': true;
    'bots.new.name': true;
    'bots.new.face': true;
    'bots.new.faceHint': true;
    'bots.new.job': true;
    'bots.new.jobPh': true;
    'bots.new.from': true;
    'bots.new.runs': true;
    'bots.new.runsIn': true;
    'bots.new.follows': true;
    'bots.new.pinned': true;
    'bots.new.change': true;
    'bots.new.place': true;
    'bots.new.home': true;
    'bots.new.cancel': true;
    'bots.new.create': true;
    'bots.tpl.lead': true;
    'bots.tpl.lead.job': true;
    'bots.tpl.reviewer': true;
    'bots.tpl.reviewer.job': true;
    'bots.tpl.notes': true;
    'bots.tpl.notes.job': true;
    'bots.tpl.chief': true;
    'bots.tpl.chief.job': true;
    'bots.tpl.peer': true;
    'bots.tpl.peer.job': true;
    'bots.tpl.docs': true;
    'bots.tpl.docs.job': true;
    'bots.first.tag': true;
    'bots.first.wrote': true;
    'bots.first.lines.one': true;
    'bots.first.lines.other': true;
    'bots.first.read': true;
    'bots.first.less': true;
    'bots.first.undo': true;
    'bots.first.seatLead': true;
    'bots.first.seatChief': true;
    'bots.first.seatChiefNote': true;
    'bots.first.project': true;
    'bots.first.sit': true;
    'bots.first.sitChief': true;
    'bots.first.notNow': true;
    'bots.first.noProject': true;
    'bots.offer.title': true;
    'bots.offer.create': true;
    'bots.offer.quiet': true;
    'bots.offer.in': true;
    'bots.hand.cmd': true;
    'bots.hand.title': true;
    'bots.hand.note': true;
    'bots.hand.who': true;
    'bots.hand.goal': true;
    'bots.hand.goalPh': true;
    'bots.hand.go': true;
    'bots.hand.none': true;
    'bots.hand.new': true;
    'lead.note.bot_yes': true;
    'lead.note.bot_no': true;
  }
}

export const en = {
  'bots.title': 'Bots',
  'bots.cmd.open': 'Open Bots (every bot, its seat and its SOUL)',
  'bots.count.one': '{n} bot',
  'bots.count.other': '{n} bots',
  'bots.sum.look': '{n} needs you',
  'bots.sum.work': '{n} working',
  'bots.sum.rest': '{n} resting',
  'bots.new': 'New bot',
  'bots.group.seat': 'In a seat',
  'bots.group.seatNote': 'one Chief for the office, one Lead per project',
  'bots.group.none': 'No seat',
  'bots.group.noneNote': "their place's lead can call them",
  'bots.empty': 'No bot yet. A bot is a name and one sentence about its job.',
  'bots.face': '{name}, {state}',
  'bots.state.rest': 'resting',
  'bots.state.work': 'working',
  'bots.state.look': 'needs you',
  'bots.now.rest': 'Resting',
  'bots.now.work': 'Working',
  'bots.now.look': 'Needs you',
  'bots.seat.chief': 'Chief',
  'bots.seat.lead': 'Lead of {project}',
  'bots.model.follows': 'follows {agent}',
  'bots.model.pinned': 'pinned: {model}',
  'bots.back': 'All bots',
  'bots.openChat': 'Open chat',
  'bots.soul': 'SOUL',
  'bots.soul.who': 'who {name} is · SOUL.md',
  'bots.soul.edit': 'Edit',
  'bots.soul.save': 'Save',
  'bots.soul.cancel': 'Cancel',
  'bots.soul.label': "{name}'s SOUL",
  'bots.schedules': 'Schedules',
  'bots.schedules.none': 'No schedule yet.',
  'bots.schedules.open': 'Open Schedules',
  'bots.schedules.paused': 'paused',
  'bots.models': 'Models and limits',
  'bots.models.follow': "Follows the agent's newest model. The lead picks per task.",
  'bots.models.pinned': 'Pinned to {model}.',
  'bots.models.save': 'Save',
  'bots.moved': 'Bots have their own view',
  'bots.movedDesc': 'Every bot with its face, its seat, its SOUL and its schedules.',
  'bots.open': 'Open Bots',
  'bots.cmd.new': 'New bot… (a name and one sentence)',
  'bots.new.title': 'New bot',
  'bots.new.name': 'Name',
  'bots.new.face': 'Another face',
  'bots.new.faceHint': 'Click the face for another one',
  'bots.new.job': 'What this bot is for, in one sentence',
  'bots.new.jobPh': 'One sentence: what is this bot for?',
  'bots.new.from': 'Or start from',
  'bots.new.runs': 'Runs on {agent}',
  'bots.new.runsIn': 'Runs on {agent} in {project}',
  'bots.new.follows': 'follows its newest model',
  'bots.new.pinned': 'pinned: {model}',
  'bots.new.change': 'Change',
  'bots.new.place': 'Works in',
  'bots.new.home': 'Home (with the assistants)',
  'bots.new.cancel': 'Cancel',
  'bots.new.create': 'Create',
  'bots.tpl.lead': 'Lead',
  'bots.tpl.lead.job': 'Splits goals into tasks, staffs them and reviews the work before it lands.',
  'bots.tpl.reviewer': 'Reviewer',
  'bots.tpl.reviewer.job': 'Reviews every change before it lands: bugs first, then what is unclear.',
  'bots.tpl.notes': 'Release notes',
  'bots.tpl.notes.job': 'Writes release notes from what landed this week.',
  'bots.tpl.chief': 'Chief',
  'bots.tpl.chief.job': 'Runs your office: the morning brief, reply drafts and follow-ups.',
  'bots.tpl.peer': 'Peer watch',
  'bots.tpl.peer.job': 'Watches what peer tools ship each week and says what matters for us.',
  'bots.tpl.docs': 'Docs',
  'bots.tpl.docs.job': 'Keeps the docs true to the code: finds what went stale and drafts the fix.',
  'bots.first.tag': 'first chat',
  'bots.first.wrote': '{name} wrote SOUL.md',
  'bots.first.lines.one': '{n} line',
  'bots.first.lines.other': '{n} lines',
  'bots.first.read': 'Read',
  'bots.first.less': 'Show less',
  'bots.first.undo': 'Undo',
  'bots.first.seatLead': 'Which project should {name} lead?',
  'bots.first.seatChief': 'Seat {name} as your Chief?',
  'bots.first.seatChiefNote': 'One Chief runs the office: your brief, reply drafts and follow-ups.',
  'bots.first.project': 'Project',
  'bots.first.sit': 'Seat as Lead',
  'bots.first.sitChief': 'Seat as Chief',
  'bots.first.notNow': 'Not now',
  'bots.first.noProject': 'Add a project first; a Lead leads one project.',
  'bots.offer.title': '{from} offers a new bot',
  'bots.offer.create': 'Create bot',
  'bots.offer.quiet': 'Nothing is made before you press Create.',
  'bots.offer.in': 'in {project}',
  'bots.hand.cmd': 'Hand to a bot…',
  'bots.hand.title': 'Hand {name} to a bot',
  'bots.hand.note': 'The bot opens its chat, looks at what is there and reports to you.',
  'bots.hand.who': 'Bot',
  'bots.hand.goal': 'What should it do with it? (optional)',
  'bots.hand.goalPh': 'Leave empty and the bot asks.',
  'bots.hand.go': 'Hand over',
  'bots.hand.none': 'No bot yet. Make one first.',
  'bots.hand.new': 'New bot',
  'lead.note.bot_yes': 'You made the bot {name}',
  'lead.note.bot_no': 'You said not now to the bot {name}',
};
