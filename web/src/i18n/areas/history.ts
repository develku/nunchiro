// Ticket 1022 (mockup docs/design/tree-done-1121): the tree's hollow bars, their popover, the "just finished" row and the
// History widget (tree/DoneBars.tsx, history/HistoryView.tsx). Ticket 1029: `history.stopped`, a stopped row's mark. ja, zh, es, fr and pt wait for their native read.
// Lane w59 (the same mockup's filter row, short lengths and empty states): the lines from `history.project` on are English
// only (owner rule 11-21: the other languages get one pass before the public release; a missing key shows English).
declare module '../index' {
  interface AreaKeys {
    'history.title': true;
    'history.chip': true;
    'history.tip': true;
    'history.just': true;
    'history.popHead': true;
    'history.today': true;
    'history.yesterday': true;
    'history.earlier': true;
    'history.viewAll': true;
    'history.search': true;
    'history.filters': true;
    'history.allProjects': true;
    'history.stoppedOrFailed': true;
    'history.stopped': true;
    'history.view': true;
    'history.continue': true;
    'history.changes': true;
    'history.none': true;
    'history.noMatch': true;
    'history.searching': true;
    'history.project': true;
    'history.agent': true;
    'history.sessions.one': true;
    'history.sessions.other': true;
    'history.len.sub': true;
    'history.len.m': true;
    'history.len.hm': true;
    'history.len.dh': true;
    'history.noneHint': true;
    'history.clear': true;
    'history.outside': true;
    'history.outsideOnly': true;
    'history.open': true;
  }
}

export const en = {
  'history.title': 'History',
  'history.chip': 'Finished today: {n}. Show them',
  'history.tip': 'done {n} · today',
  'history.just': 'Just finished · {age}',
  'history.popHead': '{name} · {n} finished',
  'history.today': 'Today',
  'history.yesterday': 'Yesterday',
  'history.earlier': 'Earlier',
  'history.viewAll': 'View all in History',
  'history.search': 'Search name, branch, conversation',
  'history.filters': 'History filters',
  'history.allProjects': 'All projects',
  'history.stoppedOrFailed': 'Stopped or failed',
  'history.stopped': 'Stopped',
  'history.view': 'View conversation',
  'history.continue': 'Continue',
  'history.changes': 'View changes',
  'history.none': 'No finished sessions yet',
  'history.noMatch': 'No sessions match',
  'history.searching': 'Searching conversations…',
  'history.project': 'Project',
  'history.agent': 'Agent',
  'history.sessions.one': '{n} session',
  'history.sessions.other': '{n} sessions',
  'history.len.sub': '<1m',
  'history.len.m': '{m}m',
  'history.len.hm': '{h}h {m}m',
  'history.len.dh': '{d}d {h}h',
  'history.noneHint': 'Sessions land here when they end.',
  'history.clear': 'Clear filters',
  // Ticket 1073: a conversation found on disk that no Nunchiro session ran, the filter for those, the palette command.
  'history.outside': 'Started in a terminal',
  'history.outsideOnly': 'Started outside Nunchiro',
  'history.open': 'Open History',
};

export const ko = {
  'history.title': '기록',
  'history.chip': '오늘 끝난 세션 {n}개. 보기',
  'history.tip': '끝남 {n} · 오늘',
  'history.just': '방금 끝남 · {age}',
  'history.popHead': '{name} · 끝난 세션 {n}',
  'history.today': '오늘',
  'history.yesterday': '어제',
  'history.earlier': '이전',
  'history.viewAll': '기록에서 모두 보기',
  'history.search': '대화 내용, 세션 이름, 브랜치 검색…',
  'history.filters': '기록 필터',
  'history.allProjects': '모든 프로젝트',
  'history.stoppedOrFailed': '멈춤 또는 실패',
  'history.stopped': '멈춤',
  'history.view': '대화 보기',
  'history.continue': '이어서 하기',
  'history.changes': '변경 보기',
  'history.none': '아직 끝난 세션이 없습니다',
  'history.noMatch': '맞는 끝난 세션이 없습니다',
  'history.searching': '대화 내용 검색 중…',
};

export const ja = {
  'history.title': '履歴',
  'history.chip': '今日終了: {n}。表示',
  'history.tip': '終了 {n} · 今日',
  'history.just': '終了したばかり · {age}',
  'history.popHead': '{name} · 終了 {n}',
  'history.today': '今日',
  'history.yesterday': '昨日',
  'history.earlier': 'それ以前',
  'history.viewAll': '履歴ですべて表示',
  'history.search': '会話、セッション名、ブランチを検索…',
  'history.filters': '履歴のフィルター',
  'history.allProjects': 'すべてのプロジェクト',
  'history.stoppedOrFailed': '停止または失敗',
  'history.stopped': '停止',
  'history.view': '会話を表示',
  'history.continue': '続ける',
  'history.changes': '変更を表示',
  'history.none': '終了したセッションはまだありません',
  'history.noMatch': '一致する終了したセッションはありません',
  'history.searching': '会話を検索中…',
};

export const zhHans = {
  'history.title': '历史',
  'history.chip': '今天结束：{n}。显示',
  'history.tip': '结束 {n} · 今天',
  'history.just': '刚刚结束 · {age}',
  'history.popHead': '{name} · 结束 {n}',
  'history.today': '今天',
  'history.yesterday': '昨天',
  'history.earlier': '更早',
  'history.viewAll': '在历史中查看全部',
  'history.search': '搜索对话、会话名称、分支…',
  'history.filters': '历史筛选',
  'history.allProjects': '所有项目',
  'history.stoppedOrFailed': '已停止或失败',
  'history.stopped': '已停止',
  'history.view': '查看对话',
  'history.continue': '继续',
  'history.changes': '查看更改',
  'history.none': '还没有结束的会话',
  'history.noMatch': '没有匹配的已结束会话',
  'history.searching': '正在搜索对话…',
};

export const zhHant = {
  'history.title': '歷史',
  'history.chip': '今天結束：{n}。顯示',
  'history.tip': '結束 {n} · 今天',
  'history.just': '剛剛結束 · {age}',
  'history.popHead': '{name} · 結束 {n}',
  'history.today': '今天',
  'history.yesterday': '昨天',
  'history.earlier': '更早',
  'history.viewAll': '在歷史中查看全部',
  'history.search': '搜尋對話、工作階段名稱、分支…',
  'history.filters': '歷史篩選',
  'history.allProjects': '所有專案',
  'history.stoppedOrFailed': '已停止或失敗',
  'history.stopped': '已停止',
  'history.view': '查看對話',
  'history.continue': '繼續',
  'history.changes': '查看變更',
  'history.none': '還沒有結束的工作階段',
  'history.noMatch': '沒有符合的已結束工作階段',
  'history.searching': '正在搜尋對話…',
};

export const es = {
  'history.title': 'Historial',
  'history.chip': 'Terminadas hoy: {n}. Mostrar',
  'history.tip': 'terminadas {n} · hoy',
  'history.just': 'Recién terminada · {age}',
  'history.popHead': '{name} · {n} terminadas',
  'history.today': 'Hoy',
  'history.yesterday': 'Ayer',
  'history.earlier': 'Antes',
  'history.viewAll': 'Ver todo en el historial',
  'history.search': 'Buscar conversaciones, nombres de sesión, ramas…',
  'history.filters': 'Filtros del historial',
  'history.allProjects': 'Todos los proyectos',
  'history.stoppedOrFailed': 'Detenidas o fallidas',
  'history.stopped': 'Detenida',
  'history.view': 'Ver conversación',
  'history.continue': 'Continuar',
  'history.changes': 'Ver cambios',
  'history.none': 'Aún no hay sesiones terminadas',
  'history.noMatch': 'Ninguna sesión terminada coincide',
  'history.searching': 'Buscando en las conversaciones…',
};

export const fr = {
  'history.title': 'Historique',
  'history.chip': 'Terminées aujourd’hui : {n}. Afficher',
  'history.tip': 'terminées {n} · aujourd’hui',
  'history.just': 'Tout juste terminée · {age}',
  'history.popHead': '{name} · {n} terminées',
  'history.today': 'Aujourd’hui',
  'history.yesterday': 'Hier',
  'history.earlier': 'Plus tôt',
  'history.viewAll': 'Tout voir dans l’historique',
  'history.search': 'Rechercher conversations, noms de session, branches…',
  'history.filters': 'Filtres de l’historique',
  'history.allProjects': 'Tous les projets',
  'history.stoppedOrFailed': 'Arrêtées ou en échec',
  'history.stopped': 'Arrêtée',
  'history.view': 'Voir la conversation',
  'history.continue': 'Continuer',
  'history.changes': 'Voir les modifications',
  'history.none': 'Aucune session terminée pour le moment',
  'history.noMatch': 'Aucune session terminée ne correspond',
  'history.searching': 'Recherche dans les conversations…',
};

export const pt = {
  'history.title': 'Histórico',
  'history.chip': 'Terminadas hoje: {n}. Mostrar',
  'history.tip': 'terminadas {n} · hoje',
  'history.just': 'Acabou de terminar · {age}',
  'history.popHead': '{name} · {n} terminadas',
  'history.today': 'Hoje',
  'history.yesterday': 'Ontem',
  'history.earlier': 'Antes',
  'history.viewAll': 'Ver tudo no histórico',
  'history.search': 'Buscar conversas, nomes de sessão, branches…',
  'history.filters': 'Filtros do histórico',
  'history.allProjects': 'Todos os projetos',
  'history.stoppedOrFailed': 'Paradas ou com falha',
  'history.stopped': 'Parada',
  'history.view': 'Ver conversa',
  'history.continue': 'Continuar',
  'history.changes': 'Ver alterações',
  'history.none': 'Ainda não há sessões terminadas',
  'history.noMatch': 'Nenhuma sessão terminada corresponde',
  'history.searching': 'Buscando nas conversas…',
};

export { zhHans as 'zh-Hans', zhHant as 'zh-Hant' };
