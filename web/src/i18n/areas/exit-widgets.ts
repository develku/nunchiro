// v25-exit-widgets (tickets 286, 288; needs 207, 213): closing an ended session, and the Terminal and Browser widgets
// that open with no session focused. `shell.terminalIcon.noSession` and `shell.browserIcon.noSession` (shell.ts) are no
// longer used: the widgets open instead of refusing.
declare module '../index' {
  interface AreaKeys {
    'exitWidgets.closeSession': true;
    'exitWidgets.closeWhy': true;
    'exitWidgets.restartWhy': true;
    'exitWidgets.notClosed': true;
    'exitWidgets.closed': true;
    'exitWidgets.spaces': true;
    'exitWidgets.myBrowser': true;
    'exitWidgets.agentSpace': true;
    'exitWidgets.notStarted': true;
  }
}

export const en = {
  'exitWidgets.closeSession': 'Close session',
  'exitWidgets.closeWhy': 'Still running: stop it first, or use Close tab',
  'exitWidgets.restartWhy': "Still running: Restart is for a session that has ended. Use Close session first",
  'exitWidgets.notClosed': 'Not closed: {error}',
  'exitWidgets.closed': 'Closed {name}',
  'exitWidgets.spaces': 'Browser space',
  'exitWidgets.myBrowser': 'My browser',
  'exitWidgets.agentSpace': '{name} (agent)',
  'exitWidgets.notStarted': 'Not started: {error}',
};

export const ko = {
  'exitWidgets.closeSession': '세션 닫기',
  'exitWidgets.closeWhy': '아직 실행 중입니다. 먼저 중지하거나 탭 닫기를 쓰세요',
  'exitWidgets.restartWhy': "아직 실행 중입니다. 다시 시작은 끝난 세션에만 씁니다. 먼저 세션 닫기를 쓰세요",
  'exitWidgets.notClosed': '닫지 못했습니다: {error}',
  'exitWidgets.closed': '{name} 닫음',
  'exitWidgets.spaces': '브라우저 공간',
  'exitWidgets.myBrowser': '내 브라우저',
  'exitWidgets.agentSpace': '{name} (에이전트)',
  'exitWidgets.notStarted': '시작하지 못했습니다: {error}',
};

export const ja = {
  'exitWidgets.closeSession': 'セッションを閉じる',
  'exitWidgets.closeWhy': 'まだ実行中です。先に停止するか、「タブを閉じる」を使ってください',
  'exitWidgets.restartWhy': "まだ実行中です。再起動は終了したセッション用です。先に「セッションを閉じる」を使ってください",
  'exitWidgets.notClosed': '閉じられませんでした：{error}',
  'exitWidgets.closed': '{name} を閉じました',
  'exitWidgets.spaces': 'ブラウザスペース',
  'exitWidgets.myBrowser': '自分のブラウザ',
  'exitWidgets.agentSpace': '{name}（エージェント）',
  'exitWidgets.notStarted': '開始できませんでした：{error}',
};

export const zhHans = {
  'exitWidgets.closeSession': '关闭会话',
  'exitWidgets.closeWhy': '仍在运行：请先停止，或使用“关闭选项卡”',
  'exitWidgets.restartWhy': "仍在运行：重新启动只用于已结束的会话。请先使用“关闭会话”",
  'exitWidgets.notClosed': '未能关闭：{error}',
  'exitWidgets.closed': '已关闭 {name}',
  'exitWidgets.spaces': '浏览器空间',
  'exitWidgets.myBrowser': '我的浏览器',
  'exitWidgets.agentSpace': '{name}（代理）',
  'exitWidgets.notStarted': '未能启动：{error}',
};

export const zhHant = {
  'exitWidgets.closeSession': '關閉工作階段',
  'exitWidgets.closeWhy': '仍在執行：請先停止，或使用「關閉選項卡」',
  'exitWidgets.restartWhy': "仍在執行：重新啟動只用於已結束的工作階段。請先使用「關閉工作階段」",
  'exitWidgets.notClosed': '無法關閉：{error}',
  'exitWidgets.closed': '已關閉 {name}',
  'exitWidgets.spaces': '瀏覽器空間',
  'exitWidgets.myBrowser': '我的瀏覽器',
  'exitWidgets.agentSpace': '{name}（代理）',
  'exitWidgets.notStarted': '無法啟動：{error}',
};

export const es = {
  'exitWidgets.closeSession': "Cerrar esta sesión",
  'exitWidgets.closeWhy': 'Sigue en ejecución: detenla primero o usa Cerrar pestaña',
  'exitWidgets.restartWhy': "Sigue en ejecución: Reiniciar es para una sesión que ya terminó. Usa primero Cerrar esta sesión",
  'exitWidgets.notClosed': 'No se cerró: {error}',
  'exitWidgets.closed': '{name} cerrada',
  'exitWidgets.spaces': 'Espacio del navegador',
  'exitWidgets.myBrowser': 'Mi navegador',
  'exitWidgets.agentSpace': '{name} (agente)',
  'exitWidgets.notStarted': 'No se inició: {error}',
};

export const fr = {
  'exitWidgets.closeSession': 'Fermer la session',
  'exitWidgets.closeWhy': 'Toujours en cours : arrêtez-la d’abord, ou utilisez Fermer l’onglet',
  'exitWidgets.restartWhy': "Toujours en cours : Redémarrer sert pour une session terminée. Utilisez d’abord Fermer la session",
  'exitWidgets.notClosed': 'Non fermée : {error}',
  'exitWidgets.closed': '{name} fermée',
  'exitWidgets.spaces': 'Espace du navigateur',
  'exitWidgets.myBrowser': 'Mon navigateur',
  'exitWidgets.agentSpace': '{name} (agent)',
  'exitWidgets.notStarted': 'Non démarrée : {error}',
};

export const pt = {
  'exitWidgets.closeSession': 'Fechar sessão',
  'exitWidgets.closeWhy': 'Ainda em execução: pare-a primeiro ou use Fechar aba',
  'exitWidgets.restartWhy': "Ainda em execução: Reiniciar é para uma sessão que já terminou. Use primeiro Fechar sessão",
  'exitWidgets.notClosed': 'Não foi fechada: {error}',
  'exitWidgets.closed': '{name} fechada',
  'exitWidgets.spaces': 'Espaço do navegador',
  'exitWidgets.myBrowser': 'Meu navegador',
  'exitWidgets.agentSpace': '{name} (agente)',
  'exitWidgets.notStarted': 'Não foi iniciada: {error}',
};
