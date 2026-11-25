// Ticket 451: the status bar's account switch (chrome/AccountSwitch.tsx).
declare module '../index' {
  interface AreaKeys {
    'accountSwitch.chip': true;
    'accountSwitch.tip': true;
    'accountSwitch.menu': true;
    'accountSwitch.done': true;
    'accountSwitch.failed': true;
    'accountSwitch.foot': true;
    'accountSwitch.manage': true;
    'accountSwitch.thisSession': true;
    'accountSwitch.continueOn': true;
    'accountSwitch.continued': true;
    'accountSwitch.notContinued': true;
    'accountSwitch.startsOn': true;
    'accountSwitch.continueSub': true;
    'accountSwitch.waitsTurn': true;
    'accountSwitch.nearTitle': true;
    'accountSwitch.nearText': true;
    'accountSwitch.nextUsed': true;
    'accountSwitch.resets': true;
    'accountSwitch.startOn': true;
    'accountSwitch.continueTab': true;
    'accountSwitch.allTitle': true;
    'accountSwitch.allText': true;
    'accountSwitch.close': true;
    'accountSwitch.leadsAny': true;
    'accountSwitch.leadsAnySub': true;
    'accountSwitch.clickOnly': true;
    'accountSwitch.notContinuedBack': true;
    'accountSwitch.nearAt': true;
    'accountSwitch.nearAtOption': true;
  }
}

export const en = {
  'accountSwitch.chip': "{name} account for new sessions: {label}",
  'accountSwitch.tip': "Switch the {name} account for new sessions",
  'accountSwitch.menu': "{name} account for new sessions",
  'accountSwitch.done': "New {name} sessions start on {label}. Running sessions keep theirs.",
  'accountSwitch.failed': "The account was not changed: {error}",
  'accountSwitch.foot': "Every new session starts on the checked account: yours, your leads', their workers' and reviewers'. Running sessions keep theirs. A project set to its own account in Settings > Team keeps it.",
  'accountSwitch.manage': "Manage accounts…",
  'accountSwitch.thisSession': "This session runs on {label}",
  'accountSwitch.continueOn': "Continue this session on {label}",
  'accountSwitch.continued': "The session continues on {label}. Its first turn there reads the whole conversation again.",
  'accountSwitch.notContinued': "The session was not continued: {error}",
  // Ticket 1126 (English only until release; other languages fall back to these).
  'accountSwitch.startsOn': "New {name} sessions start on",
  'accountSwitch.continueSub': "Ends “{session}” and opens the same conversation on {label} in this tab. Its first turn there reads the whole conversation again.",
  'accountSwitch.waitsTurn': "Waits for this turn to end.",
  'accountSwitch.nearTitle': "{label} has used {pct}% of its week",
  'accountSwitch.nearText': "New {name} sessions still start on {label}.",
  'accountSwitch.nextUsed': "{label} has used {pct}% of its week.",
  'accountSwitch.resets': "{label} resets {when}.",
  'accountSwitch.startOn': "Start new sessions on {label}",
  'accountSwitch.continueTab': "Continue “{session}” on {label}",
  'accountSwitch.allTitle': "Every {name} account has used {pct}% of its week",
  'accountSwitch.allText': "New sessions stay on {label} (week {pct}%). Nothing switches until an account resets. First reset: {first}, {when}.",
  'accountSwitch.close': "Close",
  'accountSwitch.leadsAny': "Leads may use any of my accounts",
  'accountSwitch.clickOnly': "{name} switches only when you click: its usage numbers come from its own sessions.",
  'accountSwitch.notContinuedBack': "The session was not continued: {error}. It reopened on the account it ran on.",
  'accountSwitch.nearAt': "Show the limit card when the checked account has used",
  'accountSwitch.nearAtOption': "{pct}% of its week",
  'accountSwitch.leadsAnySub': "Off by default. A team lead may start sessions on any of your accounts and move itself; each start says so in its room. Workers and reviewers stay on yours.",
};

export const ko = {
  'accountSwitch.chip': "새 세션의 {name} 계정: {label}",
  'accountSwitch.tip': "새 세션의 {name} 계정 바꾸기",
  'accountSwitch.menu': "새 세션의 {name} 계정",
  'accountSwitch.done': "새 {name} 세션은 {label} 계정으로 시작합니다. 실행 중인 세션은 그대로입니다.",
  'accountSwitch.failed': "계정을 바꾸지 못했습니다: {error}",
  'accountSwitch.manage': "계정 관리…",
  'accountSwitch.thisSession': "이 세션의 계정: {label}",
  'accountSwitch.continueOn': "이 세션을 {label} 계정으로 이어가기",
  'accountSwitch.continued': "세션을 {label} 계정으로 이어갑니다. 그 계정의 첫 턴은 대화 전체를 다시 읽습니다.",
  'accountSwitch.notContinued': "세션을 이어가지 못했습니다: {error}",
};

export const ja = {
  'accountSwitch.chip': "新しいセッションの {name} アカウント：{label}",
  'accountSwitch.tip': "新しいセッションの {name} アカウントを切り替える",
  'accountSwitch.menu': "新しいセッションの {name} アカウント",
  'accountSwitch.done': "新しい {name} セッションは {label} で始まります。実行中のセッションはそのままです。",
  'accountSwitch.failed': "アカウントを変更できませんでした：{error}",
  'accountSwitch.manage': "アカウントを管理…",
  'accountSwitch.thisSession': "このセッションのアカウント：{label}",
  'accountSwitch.continueOn': "このセッションを {label} で続ける",
  'accountSwitch.continued': "セッションを {label} で続けます。そのアカウントの最初のターンは会話全体を読み直します。",
  'accountSwitch.notContinued': "セッションを続けられませんでした：{error}",
};

export const zhHans = {
  'accountSwitch.chip': "新会话的 {name} 账户：{label}",
  'accountSwitch.tip': "切换新会话的 {name} 账户",
  'accountSwitch.menu': "新会话的 {name} 账户",
  'accountSwitch.done': "新的 {name} 会话将使用 {label}。正在运行的会话保持不变。",
  'accountSwitch.failed': "未能更改账户：{error}",
  'accountSwitch.manage': "管理账户…",
  'accountSwitch.thisSession': "此会话使用的账户：{label}",
  'accountSwitch.continueOn': "在 {label} 上继续此会话",
  'accountSwitch.continued': "会话将在 {label} 上继续。该账户的第一轮会重新读取整个对话。",
  'accountSwitch.notContinued': "未能继续会话：{error}",
};

export const zhHant = {
  'accountSwitch.chip': "新工作階段的 {name} 帳戶：{label}",
  'accountSwitch.tip': "切換新工作階段的 {name} 帳戶",
  'accountSwitch.menu': "新工作階段的 {name} 帳戶",
  'accountSwitch.done': "新的 {name} 工作階段將使用 {label}。執行中的工作階段維持不變。",
  'accountSwitch.failed': "無法變更帳戶：{error}",
  'accountSwitch.manage': "管理帳戶…",
  'accountSwitch.thisSession': "此工作階段使用的帳戶：{label}",
  'accountSwitch.continueOn': "在 {label} 上繼續此工作階段",
  'accountSwitch.continued': "工作階段將在 {label} 上繼續。該帳戶的第一輪會重新讀取整段對話。",
  'accountSwitch.notContinued': "無法繼續工作階段：{error}",
};

export const es = {
  'accountSwitch.chip': "Cuenta de {name} para sesiones nuevas: {label}",
  'accountSwitch.tip': "Cambiar la cuenta de {name} para sesiones nuevas",
  'accountSwitch.menu': "Cuenta de {name} para sesiones nuevas",
  'accountSwitch.done': "Las sesiones nuevas de {name} empiezan con {label}. Las que están en curso conservan la suya.",
  'accountSwitch.failed': "No se cambió la cuenta: {error}",
  'accountSwitch.manage': "Administrar cuentas…",
  'accountSwitch.thisSession': "Esta sesión usa {label}",
  'accountSwitch.continueOn': "Continuar esta sesión con {label}",
  'accountSwitch.continued': "La sesión continúa con {label}. Su primer turno allí vuelve a leer toda la conversación.",
  'accountSwitch.notContinued': "No se continuó la sesión: {error}",
};

export const fr = {
  'accountSwitch.chip': "Compte {name} pour les nouvelles sessions : {label}",
  'accountSwitch.tip': "Changer le compte {name} des nouvelles sessions",
  'accountSwitch.menu': "Compte {name} pour les nouvelles sessions",
  'accountSwitch.done': "Les nouvelles sessions {name} démarrent avec {label}. Les sessions en cours gardent le leur.",
  'accountSwitch.failed': "Le compte n’a pas été changé : {error}",
  'accountSwitch.manage': "Gérer les comptes…",
  'accountSwitch.thisSession': "Cette session utilise {label}",
  'accountSwitch.continueOn': "Continuer cette session avec {label}",
  'accountSwitch.continued': "La session continue avec {label}. Son premier tour y relit toute la conversation.",
  'accountSwitch.notContinued': "La session n’a pas été continuée : {error}",
};

export const pt = {
  'accountSwitch.chip': "Conta do {name} para novas sessões: {label}",
  'accountSwitch.tip': "Trocar a conta do {name} para novas sessões",
  'accountSwitch.menu': "Conta do {name} para novas sessões",
  'accountSwitch.done': "Novas sessões do {name} começam com {label}. As sessões em andamento mantêm a delas.",
  'accountSwitch.failed': "A conta não foi alterada: {error}",
  'accountSwitch.manage': "Gerenciar contas…",
  'accountSwitch.thisSession': "Esta sessão usa {label}",
  'accountSwitch.continueOn': "Continuar esta sessão com {label}",
  'accountSwitch.continued': "A sessão continua com {label}. O primeiro turno lá relê a conversa inteira.",
  'accountSwitch.notContinued': "A sessão não foi continuada: {error}",
};
