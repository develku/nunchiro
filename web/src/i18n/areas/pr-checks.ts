// Ticket 373: the PR view's failing checks, Fix with agent, and the palette's PR list (web/src/pr/).
declare module '../index' {
  interface AreaKeys {
    'prChecks.failed': true;
    'prChecks.details': true;
    'prChecks.fix': true;
    'prChecks.needSession': true;
    'prChecks.openList': true;
  }
}

export const en = {
  'prChecks.failed': 'Failed checks: {n}',
  'prChecks.details': 'Details',
  'prChecks.fix': 'Fix with agent',
  'prChecks.needSession': 'Open the PR from a session to ask its agent.',
  'prChecks.openList': 'Open the PR list',
};

export const ko = {
  'prChecks.failed': "실패한 검사 {n}개",
  'prChecks.details': '자세히',
  'prChecks.fix': '에이전트로 고치기',
  'prChecks.needSession': "세션에서 PR을 열어야 에이전트에게 요청할 수 있습니다.",
  'prChecks.openList': 'PR 목록 열기',
};

export const ja = {
  'prChecks.failed': '失敗したチェック {n} 件',
  'prChecks.details': '詳細',
  'prChecks.fix': 'エージェントで修正',
  'prChecks.needSession': 'セッションから PR を開くと依頼できます。',
  'prChecks.openList': 'PR 一覧を開く',
};

export const zhHans = {
  'prChecks.failed': '{n} 个检查失败',
  'prChecks.details': '详情',
  'prChecks.fix': '让代理修复',
  'prChecks.needSession': '从会话中打开 PR 才能请代理处理。',
  'prChecks.openList': '打开 PR 列表',
};

export const zhHant = {
  'prChecks.failed': '{n} 個檢查失敗',
  'prChecks.details': '詳情',
  'prChecks.fix': '讓代理修正',
  'prChecks.needSession': '從工作階段開啟 PR 才能請代理處理。',
  'prChecks.openList': '開啟 PR 清單',
};

export const es = {
  'prChecks.failed': 'Comprobaciones fallidas: {n}',
  'prChecks.details': 'Detalles',
  'prChecks.fix': 'Arreglar con el agente',
  'prChecks.needSession': 'Abre el PR desde una sesión para pedírselo a su agente.',
  'prChecks.openList': 'Abrir la lista de PR',
};

export const fr = {
  'prChecks.failed': 'Vérifications en échec : {n}',
  'prChecks.details': 'Détails',
  'prChecks.fix': 'Corriger avec l’agent',
  'prChecks.needSession': 'Ouvrez la PR depuis une session pour le demander à son agent.',
  'prChecks.openList': 'Ouvrir la liste des PR',
};

export const pt = {
  'prChecks.failed': 'Verificações com falha: {n}',
  'prChecks.details': 'Detalhes',
  'prChecks.fix': 'Corrigir com o agente',
  'prChecks.needSession': 'Abra o PR a partir de uma sessão para pedir ao agente.',
  'prChecks.openList': 'Abrir a lista de PRs',
};

export { zhHans as 'zh-Hans', zhHant as 'zh-Hant' };
