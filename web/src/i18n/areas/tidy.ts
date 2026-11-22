// Ticket 1005: the card for a teammate's memory file past the 6 KB its brief quotes (decisions/DecisionsWidget.tsx
// `TidyCard`). English only (owner rule 11-21: the other languages get one pass before the public release; a missing
// key shows English).
declare module '../index' {
  interface AreaKeys {
    'tidy.title': true;
    'tidy.why': true;
    'tidy.yes': true;
  }
}

export const en = {
  'tidy.title': "{name}'s {file} is too long",
  'tidy.why': "It is over the 6 KB a brief quotes, so the rest does not reach {name}. Let {name} tidy it?",
  'tidy.yes': 'Tidy it',
};
