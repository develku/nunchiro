// Ticket 1115 step 2 (mockup docs/design/workers-1115/mockup.html panel 2): the Team tab's task cards and the drawer that
// peeks at a seat's terminal. English only until ticket 1035.
declare module '../index' {
  interface AreaKeys {
    'tboard.stage.plan': true;
    'tboard.stage.build': true;
    'tboard.stage.review': true;
    'tboard.stage.gate': true;
    'tboard.stage.landed': true;
    'tboard.stageAt': true;
    'tboard.waitsSeat': true;
    'tboard.openTab': true;
    'tboard.close': true;
    'tboard.drawer': true;
    'tboard.notRunning': true;
    'tboard.meta.working': true;
    'tboard.meta.asks.one': true;
    'tboard.meta.asks.other': true;
    'tboard.meta.seat.one': true;
    'tboard.meta.seat.other': true;
    'tboard.meta.landed': true;
  }
}

export const en = {
  'tboard.stage.plan': 'Plan',
  'tboard.stage.build': 'Build',
  'tboard.stage.review': 'Review',
  'tboard.stage.gate': 'Gate',
  'tboard.stage.landed': 'Landed',
  'tboard.stageAt': 'Stage: {stage}',
  'tboard.waitsSeat': 'Waits for a seat',
  'tboard.openTab': 'Open as tab',
  'tboard.close': 'Close the terminal',
  'tboard.drawer': '{name}: terminal',
  'tboard.notRunning': '{name} is not running',
  // The board's counts beside its title (mockup panel 2).
  'tboard.meta.working': '{n} working',
  'tboard.meta.asks.one': '{n} asks you',
  'tboard.meta.asks.other': '{n} ask you',
  'tboard.meta.seat.one': '{n} waits for a seat',
  'tboard.meta.seat.other': '{n} wait for a seat',
  'tboard.meta.landed': 'landed today {n}',
};
