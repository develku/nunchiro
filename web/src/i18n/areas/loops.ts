// Ticket 1003: open loops, the user's promises and what the user waits for, kept by the core (loops.rs). The cards in
// Decisions and their one-line form in the Home view's "Needs you". English only for now (the other languages fall back
// to it until their native read).
declare module '../index' {
  interface AreaKeys {
    'loops.title.add': true;
    'loops.title.close': true;
    'loops.title.overdue': true;
    'loops.words.promise': true;
    'loops.words.waiting': true;
    'loops.line': true;
    'loops.card.heard': true;
    'loops.card.done': true;
    'loops.card.due': true;
    'loops.card.source': true;
    'loops.act.keep': true;
    'loops.act.close': true;
    'loops.act.done': true;
    'loops.act.open': true;
    'loops.quiet.add': true;
    'loops.quiet.close': true;
    'loops.quiet.overdue': true;
    'loops.onCard': true;
    'lead.note.loop_yes': true;
    'lead.note.loop_no': true;
    'lead.note.loop_closed': true;
  }
}

export const en = {
  'loops.title.add': 'Keep track?',
  'loops.title.close': 'Done?',
  'loops.title.overdue': 'Overdue',
  'loops.words.promise': 'You promised {who}: {what}',
  'loops.words.waiting': 'Waiting for {who}: {what}',
  'loops.line': '{title} · {words}',
  'loops.card.heard': '{from} heard: {words}',
  'loops.card.done': '{from} says it is done: {why}',
  'loops.card.due': 'Due {date}',
  'loops.card.source': 'from {source}',
  'loops.act.keep': 'Keep track',
  'loops.act.close': 'Close it',
  'loops.act.done': 'Done, close it',
  'loops.act.open': 'Still open',
  'loops.quiet.add': 'Nothing is kept before your yes',
  'loops.quiet.close': 'It stays open until your yes',
  'loops.quiet.overdue': 'Still open keeps it counted as overdue and does not ask again',
  'loops.onCard': 'Answer it on its card in Decisions',
  'lead.note.loop_yes': 'You kept track of the open loop with {name}',
  'lead.note.loop_no': 'You said no to the open-loop card about {name}',
  'lead.note.loop_closed': 'You closed the open loop with {name}',
};
