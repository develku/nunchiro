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
};
