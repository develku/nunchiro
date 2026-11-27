// Triggers under the Schedules list (schedule/TriggersSection.tsx). English only for now.
declare module '../index' {
  interface AreaKeys {
    'trigger.title': true;
    'trigger.add': true;
    'trigger.none': true;
    'trigger.new': true;
    'trigger.when': true;
    'trigger.when.github.checks_failed': true;
    'trigger.when.github.changes_requested': true;
    'trigger.when.github.labeled': true;
    'trigger.when.webhook': true;
    'trigger.when.cli': true;
    'trigger.repo': true;
    'trigger.githubNote': true;
    'trigger.label': true;
    'trigger.name': true;
    'trigger.noProject': true;
    'trigger.taskNote': true;
    'trigger.before': true;
    'trigger.ask': true;
    'trigger.auto': true;
    'trigger.autoLong': true;
    'trigger.address': true;
    'trigger.addressNote': true;
    'trigger.command': true;
    'trigger.secretOnce': true;
    'trigger.copy': true;
    'trigger.done': true;
    'trigger.lastFired': true;
    'trigger.notFired': true;
    'trigger.webhook': true;
    'trigger.cli': true;
    'trigger.onOf': true;
    'trigger.removeAsk': true;
    'trigger.removeOf': true;
    'trigger.authors': true;
    'trigger.anyAuthor': true;
    'trigger.anyAuthorNote': true;
  }
}

export const en = {
  "trigger.title": "Triggers",
  "trigger.add": "Add trigger",
  "trigger.none": "No triggers yet.",
  "trigger.new": "New trigger",
  "trigger.when": "When",
  "trigger.when.github.checks_failed": "GitHub: checks fail on my pull request",
  "trigger.when.github.changes_requested": "GitHub: a review asks for changes",
  "trigger.when.github.labeled": "GitHub: an issue gets a label",
  "trigger.when.webhook": "A webhook is called",
  "trigger.when.cli": "A command runs",
  "trigger.repo": "Repository",
  "trigger.githubNote": "Read with your own gh every 2 minutes while the trigger is on. What is there now starts nothing.",
  "trigger.label": "Label",
  "trigger.name": "Name",
  "trigger.noProject": "Open a session in a project first: a trigger starts in a project Nunchiro knows.",
  "trigger.taskNote": "What the caller sends is added below your task as quoted data, cut at 4 KB.",
  "trigger.before": "Before it starts",
  "trigger.ask": "Ask me first",
  "trigger.auto": "Starts by itself",
  "trigger.autoLong": "Start by itself (at most 4 an hour)",
  "trigger.address": "Address",
  "trigger.addressNote": "Only this Mac can reach it. To let a service on the internet call it, point your own tunnel at this port.",
  "trigger.command": "Command",
  "trigger.secretOnce": "The secret of {name}, shown this once. Set it as the webhook's secret, or send it as X-Nunchiro-Secret.",
  "trigger.copy": "Copy",
  "trigger.done": "Done",
  "trigger.lastFired": "last fired {when}",
  "trigger.notFired": "not fired yet",
  "trigger.webhook": "Webhook",
  "trigger.cli": "Command line",
  "trigger.onOf": "Trigger {name}",
  "trigger.removeAsk": "Remove this trigger?",
  "trigger.removeOf": "Remove trigger {name}",
  "trigger.authors": "Pull requests",
  "trigger.anyAuthor": "Anyone's, not only mine",
  "trigger.anyAuthorNote": "Off: only your own pull requests. On a public repository anyone's pull request could start a run on code they wrote.",
};
