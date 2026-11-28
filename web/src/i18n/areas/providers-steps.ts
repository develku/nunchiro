// The four add steps of a listed agent and its cost words (settings/accounts/steps.tsx); mockup
// docs/design/agent-kinds-m7/index.html, sections 3 and 11.
declare module '../index' {
  interface AreaKeys {
    'providersSteps.cost': true;
    'providersSteps.checked': true;
    'providersSteps.plans': true;
    'providersSteps.notChecked': true;
    'providersSteps.install': true;
    'providersSteps.installNote': true;
    'providersSteps.openTab': true;
    'providersSteps.copy': true;
    'providersSteps.copied': true;
    'providersSteps.guide': true;
    'providersSteps.notFound': true;
    'providersSteps.approve': true;
    'providersSteps.approveFirst': true;
    'providersSteps.noVars': true;
    'providersSteps.approveButton': true;
    'providersSteps.change': true;
    'providersSteps.signIn': true;
    'providersSteps.signInWith': true;
    'providersSteps.signInAny': true;
    'providersSteps.test': true;
    'providersSteps.testWhat': true;
    'providersSteps.terminalOnly': true;
    'providersSteps.word.free_plan': true;
    'providersSteps.word.free_limited': true;
    'providersSteps.word.free_models': true;
    'providersSteps.word.own_model': true;
    'providersSteps.word.paid_plan': true;
    'providersSteps.word.paid_key': true;
    'providersSteps.word.unknown': true;
  }
}

export const en = {
  'providersSteps.cost': 'Cost',
  'providersSteps.checked': 'Checked {date}',
  'providersSteps.plans': '{service} plans',
  'providersSteps.notChecked': 'Cost not checked',
  'providersSteps.install': 'Install',
  'providersSteps.installNote': 'Nunchiro opens a terminal tab with this command typed. You press Return.',
  'providersSteps.openTab': 'Open in a terminal tab',
  'providersSteps.copy': 'Copy',
  'providersSteps.copied': 'Copied',
  'providersSteps.guide': 'Install guide',
  'providersSteps.notFound': 'Not found yet. This checks again when you come back to the window.',
  'providersSteps.approve': 'Approve',
  'providersSteps.approveFirst': 'After it is installed, you read the exact command Nunchiro will run and approve it.',
  'providersSteps.noVars': 'no variables',
  'providersSteps.approveButton': 'Approve',
  'providersSteps.change': 'Change',
  'providersSteps.signIn': 'Sign in',
  'providersSteps.signInWith': 'With your {service} account, on its row once approved.',
  'providersSteps.signInAny': 'On its row once approved.',
  'providersSteps.test': 'Test',
  'providersSteps.testWhat': 'One short message, to see that it answers.',
  'providersSteps.terminalOnly': 'Terminal only: Nunchiro cannot tell when it finishes, so there is no test.',
  'providersSteps.word.free_plan': 'Free plan works',
  'providersSteps.word.free_limited': 'Free plan, limited',
  'providersSteps.word.free_models': 'Free models',
  'providersSteps.word.own_model': 'Your own model',
  'providersSteps.word.paid_plan': 'Paid plan',
  'providersSteps.word.paid_key': 'Paid key',
  'providersSteps.word.unknown': 'Cost not checked',
};
