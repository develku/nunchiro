// Ticket 1099 (feature cohesion, mockup docs/design/cohesion-1099): the palette rows for places that had none, the
// session's notification level as commands, and the new-tab list's Agent settings row. English only until ticket 1035.
declare module '../index' {
  interface AreaKeys {
    'coh.cmd.usagePage': true;
    'coh.cmd.teamPage': true;
    'coh.cmd.assistantsPage': true;
    'coh.cmd.keysSheet': true;
    'coh.cmd.decisions': true;
    'coh.cmd.schedules': true;
    'coh.cmd.scheduleNew': true;
    'coh.cmd.context': true;
    'coh.cmd.alerts.all': true;
    'coh.cmd.alerts.waiting': true;
    'coh.cmd.alerts.off': true;
    'coh.newtab.settingsWhere': true;
    'coh.schedule.add': true;
    'lead.note.session_empty_closed': true;
    'lead.note.session_closed': true;
    'lead.note.session_close_no': true;
    'sessionClose.title': true;
    'sessionClose.yes': true;
    'sessionClose.onCard': true;
    'coh.cap.title': true;
    'coh.cap.line': true;
    'coh.cap.yes': true;
    'coh.cap.onCard': true;
    'lead.note.cap_yes': true;
    'lead.note.cap_no': true;
    'lead.note.role_yes': true;
    'lead.note.role_no': true;
  }
}

export const en = {
  // No word "settings" in these: a query for it finds Open settings first (palette-names.spec).
  'coh.cmd.usagePage': 'Open the Usage page',
  'coh.cmd.teamPage': 'Open the Team page (how this place works, teammates)',
  'coh.cmd.assistantsPage': 'Open the Assistants page',
  'coh.cmd.keysSheet': 'Show every keyboard shortcut',
  'coh.cmd.decisions': 'Open Decisions',
  'coh.cmd.schedules': 'Open Schedules',
  'coh.cmd.scheduleNew': 'New schedule…',
  'coh.cmd.context': 'Open Context',
  'coh.cmd.alerts.all': 'Alerts for this session: all',
  'coh.cmd.alerts.waiting': 'Alerts for this session: only when it waits for you',
  'coh.cmd.alerts.off': 'Alerts for this session: off',
  'coh.newtab.settingsWhere': 'Settings > Providers',
  'coh.schedule.add': 'New schedule',
  // Panel 4: a lead's ask to change the live seats. The line follows the place's name.
  'lead.note.session_empty_closed': 'The lead closed empty session {name}',
  'lead.note.session_closed': 'You closed {name}',
  'lead.note.session_close_no': 'You said not now to closing {name}',
  'sessionClose.title': 'Close {label}',
  'sessionClose.yes': 'Close',
  'sessionClose.onCard': 'Close it from its card in Decisions',
  'coh.cap.title': 'Change live seats',
  'coh.cap.line': ' · {from} → {to} seats at once',
  'coh.cap.yes': 'Change to {n}',
  'coh.cap.onCard': 'Change it from its card in Decisions',
  // The room lines after the live-seat card's and the role card's answers (sessions.rs team notes; {name} is the cap or the role).
  'lead.note.cap_yes': 'You changed the live seats to {name}',
  'lead.note.cap_no': 'You said not now to {name} live seats',
  'lead.note.role_yes': 'You added the role {name}',
  'lead.note.role_no': 'You said not now to the role {name}',
};
