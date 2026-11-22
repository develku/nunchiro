// Tickets 321, 322 and 323: the per-agent account cards, the new-session default, sign-out and the plan word.
declare module '../index' {
  interface AreaKeys {
    'accountCards.sessionDefaultPick': true;
    'accountCards.sessionDefaultAria': true;
    'accountCards.sessionDefaultChip': true;
    'accountCards.noSessions': true;
    'accountCards.sessionsRunning.one': true;
    'accountCards.sessionsRunning.other': true;
    'accountCards.noLimits': true;
    'accountCards.signOut': true;
    'accountCards.signOutAria': true;
    'accountCards.signOutGroup': true;
    'accountCards.signOutConfirm': true;
    'accountCards.signOutLive.one': true;
    'accountCards.signOutLive.other': true;
    'accountCards.signingOut': true;
    'accountCards.signedOutDone': true;
    'accountCards.plan': true;
    'accountCards.checkAgain': true;
    'accountCards.checkAgainAria': true;
  }
}

export const en = {
  'accountCards.sessionDefaultPick': 'Default for new sessions',
  'accountCards.sessionDefaultAria': 'Default {name} account for new sessions',
  'accountCards.sessionDefaultChip': 'New session default',
  'accountCards.noSessions': 'No sessions',
  'accountCards.sessionsRunning.one': '1 session running',
  'accountCards.sessionsRunning.other': '{n} sessions running',
  'accountCards.noLimits': 'No limit info',
  'accountCards.signOut': 'Sign out',
  'accountCards.signOutAria': 'Sign out of {name}',
  'accountCards.signOutGroup': 'Sign out of {label}',
  'accountCards.signOutConfirm': 'Sign out of “{label}”? The agent’s own logout runs in a new terminal tab.',
  'accountCards.signOutLive.one': '1 running session on it may stop working.',
  'accountCards.signOutLive.other': '{n} running sessions on it may stop working.',
  'accountCards.signingOut': 'Signing out…',
  'accountCards.signedOutDone': 'Signed out of “{label}”.',
  'accountCards.plan': 'Plan {name}',
  'accountCards.checkAgain': 'Check again',
  'accountCards.checkAgainAria': 'Check {label} again',
};

export const ko = {
  'accountCards.sessionDefaultPick': '새 세션 기본 계정',
  'accountCards.sessionDefaultAria': '{name} 새 세션 기본 계정',
  'accountCards.sessionDefaultChip': '새 세션 기본값',
  'accountCards.noSessions': '세션 없음',
  'accountCards.sessionsRunning.one': '세션 1개 실행 중',
  'accountCards.sessionsRunning.other': '세션 {n}개 실행 중',
  'accountCards.noLimits': '한도 정보 없음',
  'accountCards.signOut': '로그아웃',
  'accountCards.signOutAria': '{name} 로그아웃',
  'accountCards.signOutGroup': '{label} 로그아웃',
  'accountCards.signOutConfirm': '“{label}”에서 로그아웃하시겠습니까? 새 터미널 탭에서 에이전트 자체 로그아웃을 실행합니다.',
  'accountCards.signOutLive.one': '실행 중인 세션 1개가 멈출 수 있습니다.',
  'accountCards.signOutLive.other': '실행 중인 세션 {n}개가 멈출 수 있습니다.',
  'accountCards.signingOut': '로그아웃하는 중…',
  'accountCards.signedOutDone': '“{label}”에서 로그아웃했습니다.',
  'accountCards.plan': '요금제 {name}',
  'accountCards.checkAgain': '다시 확인',
  'accountCards.checkAgainAria': '{label} 다시 확인',
};

export const ja = {
  'accountCards.sessionDefaultPick': '新規セッションのデフォルトアカウント',
  'accountCards.sessionDefaultAria': '{name} の新規セッションのデフォルトアカウント',
  'accountCards.sessionDefaultChip': '新規セッションのデフォルト',
  'accountCards.noSessions': 'セッションなし',
  'accountCards.sessionsRunning.one': '1 件のセッションを実行中',
  'accountCards.sessionsRunning.other': '{n} 件のセッションを実行中',
  'accountCards.noLimits': '制限情報なし',
  'accountCards.signOut': "ログアウト",
  'accountCards.signOutAria': "{name} からログアウト",
  'accountCards.signOutGroup': "{label} からログアウト",
  'accountCards.signOutConfirm': "「{label}」からログアウトしますか？新しいターミナルタブでエージェント自身のログアウトを実行します。",
  'accountCards.signOutLive.one': '実行中のセッション 1 件が動かなくなる可能性があります。',
  'accountCards.signOutLive.other': '実行中のセッション {n} 件が動かなくなる可能性があります。',
  'accountCards.signingOut': "ログアウト中…",
  'accountCards.signedOutDone': "「{label}」からログアウトしました。",
  'accountCards.plan': 'プラン {name}',
  'accountCards.checkAgain': '再確認',
  'accountCards.checkAgainAria': '{label} を再確認',
};

export const zhHans = {
  'accountCards.sessionDefaultPick': '新会话默认账户',
  'accountCards.sessionDefaultAria': '{name} 新会话默认账户',
  'accountCards.sessionDefaultChip': '新会话默认',
  'accountCards.noSessions': '没有会话',
  'accountCards.sessionsRunning.one': '1 个会话运行中',
  'accountCards.sessionsRunning.other': '{n} 个会话运行中',
  'accountCards.noLimits': '无使用上限信息',
  'accountCards.signOut': '退出登录',
  'accountCards.signOutAria': '退出 {name}',
  'accountCards.signOutGroup': '退出 {label}',
  'accountCards.signOutConfirm': '要退出“{label}”吗？代理自己的退出命令将在新的终端选项卡中运行。',
  'accountCards.signOutLive.one': '其上 1 个运行中的会话可能停止工作。',
  'accountCards.signOutLive.other': '其上 {n} 个运行中的会话可能停止工作。',
  'accountCards.signingOut': '正在退出…',
  'accountCards.signedOutDone': '已退出“{label}”。',
  'accountCards.plan': '套餐 {name}',
  'accountCards.checkAgain': '重新检查',
  'accountCards.checkAgainAria': '重新检查 {label}',
};

export const zhHant = {
  'accountCards.sessionDefaultPick': '新工作階段預設帳戶',
  'accountCards.sessionDefaultAria': '{name} 新工作階段預設帳戶',
  'accountCards.sessionDefaultChip': '新工作階段預設',
  'accountCards.noSessions': '沒有工作階段',
  'accountCards.sessionsRunning.one': '1 個工作階段執行中',
  'accountCards.sessionsRunning.other': '{n} 個工作階段執行中',
  'accountCards.noLimits': '沒有上限資訊',
  'accountCards.signOut': '登出',
  'accountCards.signOutAria': '登出 {name}',
  'accountCards.signOutGroup': '登出 {label}',
  'accountCards.signOutConfirm': '要登出「{label}」嗎？代理自己的登出指令會在新的終端選項卡中執行。',
  'accountCards.signOutLive.one': '其上 1 個執行中的工作階段可能停止運作。',
  'accountCards.signOutLive.other': '其上 {n} 個執行中的工作階段可能停止運作。',
  'accountCards.signingOut': '正在登出…',
  'accountCards.signedOutDone': '已登出「{label}」。',
  'accountCards.plan': '方案 {name}',
  'accountCards.checkAgain': '重新檢查',
  'accountCards.checkAgainAria': '重新檢查 {label}',
};

export const es = {
  'accountCards.sessionDefaultPick': 'Predeterminada para sesiones nuevas',
  'accountCards.sessionDefaultAria': 'Cuenta de {name} predeterminada para sesiones nuevas',
  'accountCards.sessionDefaultChip': 'Predeterminada para sesiones nuevas',
  'accountCards.noSessions': 'Sin sesiones',
  'accountCards.sessionsRunning.one': '1 sesión en curso',
  'accountCards.sessionsRunning.other': '{n} sesiones en curso',
  'accountCards.noLimits': 'Sin datos de límite',
  'accountCards.signOut': 'Cerrar sesión',
  'accountCards.signOutAria': 'Cerrar sesión de {name}',
  'accountCards.signOutGroup': 'Cerrar sesión de {label}',
  'accountCards.signOutConfirm': '¿Cerrar sesión de “{label}”? El cierre de sesión propio del agente se ejecuta en una pestaña de terminal nueva.',
  'accountCards.signOutLive.one': "En ella, 1 sesión en curso puede dejar de funcionar.",
  'accountCards.signOutLive.other': "En ella, {n} sesiones en curso pueden dejar de funcionar.",
  'accountCards.signingOut': 'Cerrando sesión…',
  'accountCards.signedOutDone': 'Sesión de “{label}” cerrada.',
  'accountCards.plan': 'Plan {name}',
  'accountCards.checkAgain': 'Comprobar de nuevo',
  'accountCards.checkAgainAria': 'Comprobar {label} de nuevo',
};

export const fr = {
  'accountCards.sessionDefaultPick': 'Par défaut pour les nouvelles sessions',
  'accountCards.sessionDefaultAria': 'Compte {name} par défaut pour les nouvelles sessions',
  'accountCards.sessionDefaultChip': 'Par défaut pour les nouvelles sessions',
  'accountCards.noSessions': 'Aucune session',
  'accountCards.sessionsRunning.one': '1 session en cours',
  'accountCards.sessionsRunning.other': '{n} sessions en cours',
  'accountCards.noLimits': 'Aucune information de limite',
  'accountCards.signOut': 'Se déconnecter',
  'accountCards.signOutAria': 'Se déconnecter de {name}',
  'accountCards.signOutGroup': 'Se déconnecter de {label}',
  'accountCards.signOutConfirm': 'Se déconnecter de « {label} » ? La déconnexion propre à l’agent s’exécute dans un nouvel onglet de terminal.',
  'accountCards.signOutLive.one': '1 session en cours sur ce compte peut cesser de fonctionner.',
  'accountCards.signOutLive.other': '{n} sessions en cours sur ce compte peuvent cesser de fonctionner.',
  'accountCards.signingOut': 'Déconnexion…',
  'accountCards.signedOutDone': 'Déconnecté de « {label} ».',
  'accountCards.plan': 'Forfait {name}',
  'accountCards.checkAgain': 'Vérifier à nouveau',
  'accountCards.checkAgainAria': 'Vérifier {label} à nouveau',
};

export const pt = {
  'accountCards.sessionDefaultPick': 'Padrão para novas sessões',
  'accountCards.sessionDefaultAria': 'Conta {name} padrão para novas sessões',
  'accountCards.sessionDefaultChip': 'Padrão para novas sessões',
  'accountCards.noSessions': 'Nenhuma sessão',
  'accountCards.sessionsRunning.one': '1 sessão em execução',
  'accountCards.sessionsRunning.other': '{n} sessões em execução',
  'accountCards.noLimits': 'Sem informação de limite',
  'accountCards.signOut': 'Sair',
  'accountCards.signOutAria': 'Sair de {name}',
  'accountCards.signOutGroup': 'Sair de {label}',
  'accountCards.signOutConfirm': 'Sair de “{label}”? O logout do próprio agente é executado em uma nova aba de terminal.',
  'accountCards.signOutLive.one': '1 sessão em execução nela pode parar de funcionar.',
  'accountCards.signOutLive.other': '{n} sessões em execução nela podem parar de funcionar.',
  'accountCards.signingOut': 'Saindo…',
  'accountCards.signedOutDone': 'Você saiu de “{label}”.',
  'accountCards.plan': 'Plano {name}',
  'accountCards.checkAgain': 'Verificar novamente',
  'accountCards.checkAgainAria': 'Verificar {label} novamente',
};
