// The test message of an agent's row in Settings > Accounts (settings/accounts/acpTry.tsx); mockup
// docs/design/agent-kinds-m7/index.html, sections 3 and 11.
declare module '../index' {
  interface AreaKeys {
    'providersTry.title': true;
    'providersTry.sends': true;
    'providersTry.costs': true;
    'providersTry.send': true;
    'providersTry.again': true;
    'providersTry.waiting': true;
    'providersTry.cancel': true;
    'providersTry.answered': true;
    'providersTry.receipt': true;
    'providersTry.today': true;
    'providersTry.fail.no_answer': true;
    'providersTry.fail.no_answer.next': true;
    'providersTry.fail.not_signed_in': true;
    'providersTry.fail.error': true;
    'providersTry.fail.empty': true;
    'providersTry.fail.no_end': true;
    'providersTry.chip.none': true;
    'providersTry.chip.today': true;
    'providersTry.chip.days.one': true;
    'providersTry.chip.days.other': true;
    'providersTry.chip.version': true;
    'providersTry.chip.failed': true;
  }
}

export const en = {
  'providersTry.title': 'Test',
  'providersTry.sends': 'Sends “Reply with the one word: ready.” in an empty folder.',
  'providersTry.costs': 'It uses a little of your {agent} allowance. Anything the agent asks permission for is refused.',
  'providersTry.send': 'Send a test message',
  'providersTry.again': 'Send again',
  'providersTry.waiting': 'Waiting for {agent} to answer…',
  'providersTry.cancel': 'Cancel',
  'providersTry.answered': 'Answered “{text}” in {seconds} s.',
  'providersTry.receipt': 'Message sent · answer read · turn ended · {agent} {version} · {when}',
  'providersTry.today': 'today {time}',
  'providersTry.fail.no_answer': 'No answer in 60 seconds.',
  'providersTry.fail.no_answer.next': 'The agent connected but did not answer. Check your plan’s limit, or try again.',
  'providersTry.fail.not_signed_in': '{agent} is not signed in.',
  'providersTry.fail.error': '{agent} answered with an error: “{text}”',
  'providersTry.fail.empty': '{agent} sent an empty answer.',
  'providersTry.fail.no_end': '{agent} stopped before the turn ended.',
  'providersTry.chip.none': 'Not tried',
  'providersTry.chip.today': 'Answered today',
  'providersTry.chip.days.one': 'Answered 1 day ago',
  'providersTry.chip.days.other': 'Answered {n} days ago',
  'providersTry.chip.version': 'Not tried on {version}',
  'providersTry.chip.failed': 'Test failed',
};
