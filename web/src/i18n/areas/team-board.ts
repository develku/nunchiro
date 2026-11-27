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
    'tboard.waitsFor.one': true;
    'tboard.waitsFor.other': true;
    'tboard.waits': true;
    'tboard.waitsStage': true;
    'tboard.waiters.one': true;
    'tboard.waiters.other': true;
    'tboard.readySince': true;
    'tboard.early': true;
    'tboard.stuck': true;
    'tboard.stopWaiting': true;
    'tboard.dropTask': true;
    'tboard.waitFor': true;
    'tboard.waitNothing': true;
    'tboard.thisTask': true;
    'tboard.startAnyway': true;
    'tboard.waitsHead': true;
    'tboard.waitsDrawer': true;
    'tboard.startsWhen.one': true;
    'tboard.startsWhen.other': true;
    'tboard.meta.task.one': true;
    'tboard.meta.task.other': true;
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
  // Task dependencies (mockup docs/design/task-deps-m5/index.html, panels 3 and 7).
  'tboard.waitsFor.one': 'Waits for "{title}"',
  'tboard.waitsFor.other': 'Waits for {n} tasks',
  'tboard.waits': 'Waits',
  'tboard.waitsStage': 'waits',
  'tboard.waiters.one': '{n} task waits for this',
  'tboard.waiters.other': '{n} tasks wait for this',
  'tboard.readySince': 'ready since {when}',
  'tboard.early': 'started before "{title}" landed',
  'tboard.stuck': '"{title}" was dropped, so this cannot start. Stop waiting for it, or drop this too?',
  'tboard.stopWaiting': 'Stop waiting',
  'tboard.dropTask': 'Drop this task',
  'tboard.waitFor': 'Wait for…',
  'tboard.waitNothing': 'Wait for nothing',
  'tboard.thisTask': 'this task',
  'tboard.startAnyway': 'Start anyway',
  'tboard.waitsHead': 'Waits for',
  'tboard.waitsDrawer': '{name}: what it waits for',
  'tboard.startsWhen.one': 'Starts when it has landed. {lead} is told then.',
  'tboard.startsWhen.other': 'Starts when all {n} have landed. {lead} is told then.',
  'tboard.meta.task.one': '{n} waits for a task',
  'tboard.meta.task.other': '{n} wait for a task',
};
