// Ticket 217 (needs 178 lane L8): Settings search in place, notification defaults, appearance polish.
declare module '../index' {
  interface AreaKeys {
    'settingsA.clear': true;
    'settingsA.notifyDefault': true;
    'settingsA.notifyDefaultNote': true;
    'settingsA.notifyFocused': true;
    'settingsA.notifyFocusedNote': true;
    'settingsA.levelAll': true;
    'settingsA.levelWaiting': true;
    'settingsA.levelMuted': true;
    'settingsA.system': true;
    'settingsA.denied': true;
    'settingsA.notAsked': true;
    'settingsA.askNow': true;
    'settingsA.sendTest': true;
    'settingsA.sent': true;
    'settingsA.allowed': true;
    'settingsA.blocked': true;
    'settingsA.testFailed': true;
    'settingsA.testUnconfirmed': true;
  }
}

export const en = {
  'settingsA.clear': 'Clear search',
  'settingsA.notifyDefault': 'Default for new sessions',
  'settingsA.notifyDefaultNote': "A level set in a session’s header chip replaces this default for that session.",
  'settingsA.notifyFocused': "Do not alert for the session you are viewing",
  'settingsA.notifyFocusedNote': "While that session's tab is in front and the window is active, sounds and notifications are skipped.",
  'settingsA.levelAll': 'All',
  'settingsA.levelWaiting': 'Waiting only',
  'settingsA.levelMuted': 'Muted',
  'settingsA.system': 'System notifications',
  'settingsA.denied': 'macOS is not delivering notifications for Nunchiro: allow them in System Settings > Notifications',
  'settingsA.notAsked': 'Not asked yet',
  'settingsA.askNow': 'Ask now',
  'settingsA.sendTest': 'Send test notification',
  'settingsA.sent': 'Sent',
  'settingsA.allowed': 'Allowed',
  'settingsA.blocked': 'Blocked',
  'settingsA.testFailed': 'Could not send the test notification.',
  'settingsA.testUnconfirmed': 'Sent, but Nunchiro cannot tell whether macOS showed it.',
};
export const ko = {
  'settingsA.clear': '검색 지우기',
  'settingsA.notifyDefault': '새 세션의 알림 수준',
  'settingsA.notifyDefaultNote': '세션 머리글의 칩에서 세션마다 따로 정할 수 있고, 그쪽이 우선합니다.',
  'settingsA.notifyFocused': '보고 있는 세션은 알리지 않기',
  'settingsA.notifyFocusedNote': '그 세션 탭이 앞에 있고 창이 활성일 때는 소리와 알림을 건너뜁니다.',
  'settingsA.levelAll': '모두',
  'settingsA.levelWaiting': '대기만',
  'settingsA.levelMuted': '음소거',
  'settingsA.system': '시스템 알림',
  'settingsA.denied': 'macOS가 Nunchiro 알림을 표시하지 않습니다: 시스템 설정 > 알림에서 허용하세요',
  'settingsA.notAsked': '아직 묻지 않음',
  'settingsA.askNow': '지금 묻기',
  'settingsA.sendTest': '테스트 알림 보내기',
  'settingsA.sent': '보냄',
  'settingsA.allowed': '허용됨',
  'settingsA.blocked': '막힘',
  'settingsA.testFailed': '테스트 알림을 보내지 못했습니다.',
  'settingsA.testUnconfirmed': '보냈지만 macOS가 표시했는지는 확인할 수 없습니다.',
};
export const ja = {
  'settingsA.clear': '検索をクリア',
  'settingsA.notifyDefault': '新しいセッションのデフォルト値',
  'settingsA.notifyDefaultNote': 'ヘッダーのチップで設定したセッション固有のレベルが優先されます。',
  'settingsA.notifyFocused': '表示中のセッションには通知しない',
  'settingsA.notifyFocusedNote': 'そのセッションのタブが前面にあり、ウィンドウがアクティブなときは、音と通知をスキップします。',
  'settingsA.levelAll': 'すべて',
  'settingsA.levelWaiting': '待機中のみ',
  'settingsA.levelMuted': 'ミュート',
  'settingsA.system': 'システム通知',
  'settingsA.denied': 'macOS が Nunchiro の通知を表示していません。システム設定 > 通知で許可してください',
  'settingsA.notAsked': 'まだ確認していません',
  'settingsA.askNow': '今すぐ確認',
  'settingsA.sendTest': 'テスト通知を送信',
  'settingsA.sent': '送信済み',
  'settingsA.allowed': '許可済み',
  'settingsA.blocked': 'ブロック中',
  'settingsA.testFailed': 'テスト通知を送信できませんでした。',
  'settingsA.testUnconfirmed': '送信しましたが、macOS が表示したかどうかは確認できません。',
};
export const zhHans = {
  'settingsA.clear': '清除搜索',
  'settingsA.notifyDefault': '新会话的默认值',
  'settingsA.notifyDefaultNote': "会话自己的级别（在其标题栏标签中设置）优先。",
  'settingsA.notifyFocused': '不提醒正在查看的会话',
  'settingsA.notifyFocusedNote': '当该会话的选项卡在最前且窗口处于活动状态时，跳过声音和通知。',
  'settingsA.levelAll': '全部',
  'settingsA.levelWaiting': '仅等待',
  'settingsA.levelMuted': '静音',
  'settingsA.system': '系统通知',
  'settingsA.denied': 'macOS 未显示 Nunchiro 的通知：请在“系统设置 > 通知”中允许',
  'settingsA.notAsked': '尚未询问',
  'settingsA.askNow': '立即询问',
  'settingsA.sendTest': '发送测试通知',
  'settingsA.sent': '已发送',
  'settingsA.allowed': '已允许',
  'settingsA.blocked': '已阻止',
  'settingsA.testFailed': '无法发送测试通知。',
  'settingsA.testUnconfirmed': '已发送，但无法确认 macOS 是否显示了它。',
};
export const zhHant = {
  'settingsA.clear': '清除搜尋',
  'settingsA.notifyDefault': '新工作階段的預設值',
  'settingsA.notifyDefaultNote': "在工作階段標題列的標籤中設定的層級優先。",
  'settingsA.notifyFocused': '不提醒正在檢視的工作階段',
  'settingsA.notifyFocusedNote': '當該工作階段的選項卡在最前且視窗為作用中時，略過聲音和通知。',
  'settingsA.levelAll': '全部',
  'settingsA.levelWaiting': '僅等待',
  'settingsA.levelMuted': '靜音',
  'settingsA.system': '系統通知',
  'settingsA.denied': 'macOS 未顯示 Nunchiro 的通知：請在 系統設定 > 通知 中允許',
  'settingsA.notAsked': '尚未詢問',
  'settingsA.askNow': '立即詢問',
  'settingsA.sendTest': '傳送測試通知',
  'settingsA.sent': '已傳送',
  'settingsA.allowed': '已允許',
  'settingsA.blocked': '已封鎖',
  'settingsA.testFailed': '無法傳送測試通知。',
  'settingsA.testUnconfirmed': '已傳送，但無法確認 macOS 是否顯示了它。',
};
export const es = {
  'settingsA.clear': 'Borrar búsqueda',
  'settingsA.notifyDefault': 'Predeterminado para sesiones nuevas',
  'settingsA.notifyDefaultNote': 'El nivel propio de una sesión, fijado en su chip de cabecera, prevalece.',
  'settingsA.notifyFocused': 'No avisar de la sesión que estás viendo',
  'settingsA.notifyFocusedNote': 'Mientras la pestaña de esa sesión esté delante y la ventana activa, se omiten los sonidos y las notificaciones.',
  'settingsA.levelAll': 'Todas',
  'settingsA.levelWaiting': 'Solo en espera',
  'settingsA.levelMuted': 'Silenciadas',
  'settingsA.system': 'Notificaciones del sistema',
  'settingsA.denied': 'macOS no está mostrando las notificaciones de Nunchiro: permítelas en Ajustes del Sistema > Notificaciones',
  'settingsA.notAsked': 'Aún no se ha preguntado',
  'settingsA.askNow': 'Preguntar ahora',
  'settingsA.sendTest': 'Enviar notificación de prueba',
  'settingsA.sent': 'Enviada',
  'settingsA.allowed': 'Permitidas',
  'settingsA.blocked': 'Bloqueadas',
  'settingsA.testFailed': 'No se pudo enviar la notificación de prueba.',
  'settingsA.testUnconfirmed': 'Enviada, pero Nunchiro no puede saber si macOS la mostró.',
};
export const fr = {
  'settingsA.clear': 'Effacer la recherche',
  'settingsA.notifyDefault': 'Par défaut pour les nouvelles sessions',
  'settingsA.notifyDefaultNote': "Le niveau propre d’une session, réglé dans sa puce d’en-tête, l’emporte.",
  'settingsA.notifyFocused': 'Ne pas alerter pour la session affichée',
  'settingsA.notifyFocusedNote': "Tant que l’onglet de cette session est au premier plan et la fenêtre active, les sons et notifications sont ignorés.",
  'settingsA.levelAll': 'Toutes',
  'settingsA.levelWaiting': 'En attente seulement',
  'settingsA.levelMuted': 'Muettes',
  'settingsA.system': 'Notifications système',
  'settingsA.denied': "macOS n’affiche pas les notifications de Nunchiro : autorisez-les dans Réglages Système > Notifications",
  'settingsA.notAsked': 'Pas encore demandé',
  'settingsA.askNow': 'Demander maintenant',
  'settingsA.sendTest': 'Envoyer une notification de test',
  'settingsA.sent': 'Envoyée',
  'settingsA.allowed': 'Autorisées',
  'settingsA.blocked': 'Bloquées',
  'settingsA.testFailed': "Impossible d’envoyer la notification de test.",
  'settingsA.testUnconfirmed': "Envoyée, mais Nunchiro ne peut pas savoir si macOS l’a affichée.",
};
export const pt = {
  'settingsA.clear': 'Limpar busca',
  'settingsA.notifyDefault': 'Padrão para novas sessões',
  'settingsA.notifyDefaultNote': 'O nível próprio de uma sessão, definido no chip do cabeçalho, prevalece.',
  'settingsA.notifyFocused': 'Não avisar sobre a sessão que você está vendo',
  'settingsA.notifyFocusedNote': 'Enquanto a aba dessa sessão estiver à frente e a janela ativa, sons e notificações são ignorados.',
  'settingsA.levelAll': 'Todas',
  'settingsA.levelWaiting': 'Apenas em espera',
  'settingsA.levelMuted': 'Silenciadas',
  'settingsA.system': 'Notificações do sistema',
  'settingsA.denied': 'O macOS não está mostrando as notificações do Nunchiro: permita-as em Ajustes do Sistema > Notificações',
  'settingsA.notAsked': 'Ainda não perguntado',
  'settingsA.askNow': 'Perguntar agora',
  'settingsA.sendTest': 'Enviar notificação de teste',
  'settingsA.sent': 'Enviada',
  'settingsA.allowed': 'Permitidas',
  'settingsA.blocked': 'Bloqueadas',
  'settingsA.testFailed': 'Não foi possível enviar a notificação de teste.',
  'settingsA.testUnconfirmed': 'Enviada, mas o Nunchiro não consegue saber se o macOS a mostrou.',
};
