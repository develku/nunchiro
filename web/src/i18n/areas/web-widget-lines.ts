// Ticket 960 (P5 detail pass 2): a placed web widget's status line and its send target, in the window's language
// (they were English literals in WebWidget.tsx, so a Korean window showed "read only · act is off for this widget").
declare module '../index' {
  interface AreaKeys {
    'rest.widgets.web.hint.act': true;
    'rest.widgets.web.hint.read': true;
    'rest.widgets.web.navigated': true;
    'rest.widgets.web.sent': true;
    'rest.widgets.web.queued': true;
    'rest.widgets.web.target.session': true;
    'rest.widgets.web.target.start': true;
  }
}

export const en = {
  'rest.widgets.web.hint.act': 'an action asks here before anything is sent',
  'rest.widgets.web.hint.read': 'read only · actions are off for this widget',
  'rest.widgets.web.navigated': 'the page went to another address · reload the widget to connect again',
  'rest.widgets.web.sent': 'sent to {target} · {time}',
  'rest.widgets.web.queued': 'queued for {target} · {time}',
  'rest.widgets.web.target.session': 'session “{name}”',
  'rest.widgets.web.target.start': 'a new {kind} session',
};
export const ko = {
  'rest.widgets.web.hint.act': '보내기 전에 여기서 먼저 묻습니다',
  'rest.widgets.web.hint.read': '읽기 전용 · 이 위젯은 보내기가 꺼져 있습니다',
  'rest.widgets.web.navigated': '페이지가 다른 곳으로 이동했습니다 · 위젯을 새로고침할 때까지 연결이 닫혀 있습니다',
  'rest.widgets.web.sent': '{target}에 보냄 · {time}',
  'rest.widgets.web.queued': '{target}에 보낼 차례를 기다림 · {time}',
  'rest.widgets.web.target.session': '세션 “{name}”',
  'rest.widgets.web.target.start': '새 {kind} 세션',
};
export const ja = {
  'rest.widgets.web.hint.act': '送信する前にここで確認します',
  'rest.widgets.web.hint.read': '読み取り専用 · このウィジェットは送信がオフです',
  'rest.widgets.web.navigated': "ページが移動しました · ウィジェットを再読み込みするまで接続が切れています",
  'rest.widgets.web.sent': '{target} に送信 · {time}',
  'rest.widgets.web.queued': '{target} への送信待ち · {time}',
  'rest.widgets.web.target.session': 'セッション「{name}」',
  'rest.widgets.web.target.start': '新しい {kind} セッション',
};
export const zhHans = {
  'rest.widgets.web.hint.act': '发送前会先在这里确认',
  'rest.widgets.web.hint.read': '只读 · 此小组件的发送已关闭',
  'rest.widgets.web.navigated': '页面已跳转 · 重新加载小组件前连接保持关闭',
  'rest.widgets.web.sent': '已发送到 {target} · {time}',
  'rest.widgets.web.queued': '排队发送到 {target} · {time}',
  'rest.widgets.web.target.session': '会话“{name}”',
  'rest.widgets.web.target.start': '新的 {kind} 会话',
};
export const zhHant = {
  'rest.widgets.web.hint.act': '傳送前會先在這裡確認',
  'rest.widgets.web.hint.read': '唯讀 · 此小工具的傳送已關閉',
  'rest.widgets.web.navigated': '頁面已跳轉 · 重新載入小工具前連線保持關閉',
  'rest.widgets.web.sent': '已傳送到 {target} · {time}',
  'rest.widgets.web.queued': '排隊傳送到 {target} · {time}',
  'rest.widgets.web.target.session': '工作階段「{name}」',
  'rest.widgets.web.target.start': '新的 {kind} 工作階段',
};
export const es = {
  'rest.widgets.web.hint.act': 'antes de enviar nada, se pregunta aquí',
  'rest.widgets.web.hint.read': 'solo lectura · el envío está desactivado para este widget',
  'rest.widgets.web.navigated': 'la página navegó a otro sitio · la conexión queda cerrada hasta recargar el widget',
  'rest.widgets.web.sent': 'enviado a {target} · {time}',
  'rest.widgets.web.queued': 'en cola para {target} · {time}',
  'rest.widgets.web.target.session': 'la sesión “{name}”',
  'rest.widgets.web.target.start': 'una nueva sesión de {kind}',
};
export const fr = {
  'rest.widgets.web.hint.act': 'avant tout envoi, la demande s’affiche ici',
  'rest.widgets.web.hint.read': 'lecture seule · l’envoi est désactivé pour ce widget',
  'rest.widgets.web.navigated': 'la page a changé d’adresse · la connexion reste fermée jusqu’au rechargement du widget',
  'rest.widgets.web.sent': 'envoyé à {target} · {time}',
  'rest.widgets.web.queued': 'en attente pour {target} · {time}',
  'rest.widgets.web.target.session': 'la session « {name} »',
  'rest.widgets.web.target.start': 'une nouvelle session {kind}',
};
export const pt = {
  'rest.widgets.web.hint.act': 'antes de enviar algo, a pergunta aparece aqui',
  'rest.widgets.web.hint.read': 'somente leitura · agir está desativado para este widget',
  'rest.widgets.web.navigated': 'a página navegou para outro lugar · a conexão fica fechada até recarregar o widget',
  'rest.widgets.web.sent': 'enviado para {target} · {time}',
  'rest.widgets.web.queued': 'na fila para {target} · {time}',
  'rest.widgets.web.target.session': 'a sessão “{name}”',
  'rest.widgets.web.target.start': 'uma nova sessão de {kind}',
};
