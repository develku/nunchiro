// Ticket 1130 B-L5 C7 (owner 11-25 Q3, mockup docs/design/first-use-b-1130): Quick setup's line under the Folder row when
// a Mac with no Claude or Codex history starts its first session in Assistants. English only until the release language pass.
declare module '../index' {
  interface AreaKeys {
    'firstUse1130.homeLine': true;
    'firstUse1130.homeLineEnd': true;
  }
}

export const en = {
  // The button between the two parts is "Choose folder…" (firstUse.choose).
  'firstUse1130.homeLine': 'No project yet: this runs in Assistants.',
  'firstUse1130.homeLineEnd': 'to work on code.',
};
