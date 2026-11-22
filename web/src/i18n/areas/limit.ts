// Ticket 372: a live session's usage limit (the band, its Resume at <time> and Cancel, the tree row's word) and the
// status bar's limit chip, as the 372 mockup draws them. All eight languages. `{time}` is the reset in local time.
declare module '../index' {
  interface AreaKeys {
    'limit.reached': true;
    'limit.armed': true;
    'limit.resume': true;
    'limit.cancel': true;
    'limit.saving': true;
    'limit.failed': true;
    'limit.failed.noAnswer': true;
    'limit.failed.gone': true;
    'limit.row': true;
  }
}

export const en = {
  'limit.reached': 'Usage limit reached · resets {time}',
  'limit.armed': 'One “continue” message will be sent to this session at {time}',
  'limit.resume': 'Resume at {time}',
  'limit.cancel': 'Cancel',
  'limit.saving': 'Saving…',
  'limit.failed': 'Not scheduled; the details are below.',
  'limit.failed.noAnswer': 'Not scheduled because the session did not answer; try again in a moment.',
  'limit.failed.gone': "Not scheduled because the usage limit is no longer on this session's screen.",
  'limit.row': 'Limit',
};
export const ko = {
  'limit.reached': '사용 한도에 도달했습니다 · {time} 초기화',
  'limit.armed': '{time}에 이 세션에 “continue” 메시지를 한 번 보냅니다',
  'limit.resume': '{time}에 재개',
  'limit.cancel': '취소',
  'limit.saving': '저장 중…',
  'limit.failed': '예약하지 못했으며 자세한 내용은 아래에 있습니다.',
  'limit.failed.noAnswer': '세션이 응답하지 않아 예약하지 못했으니 잠시 후 다시 시도하세요.',
  'limit.failed.gone': '이 세션 화면에 사용 한도가 더 이상 없어 예약하지 못했습니다.',
  'limit.row': '한도',
};
export const ja = {
  'limit.reached': '使用上限に達しました · {time} にリセット',
  'limit.armed': '{time} にこのセッションへ続行メッセージを 1 回送ります',
  'limit.resume': '{time} に再開',
  'limit.cancel': 'キャンセル',
  'limit.saving': '保存中…',
  'limit.failed': '予約できませんでした（詳細は下にあります）。',
  'limit.failed.noAnswer': 'セッションが応答しなかったため予約できませんでした。しばらくしてからもう一度お試しください。',
  'limit.failed.gone': 'このセッションの画面に使用上限がもう表示されていないため、予約できませんでした。',
  'limit.row': '上限',
};
export const zhHans = {
  'limit.reached': '已达到使用上限 · {time} 重置',
  'limit.armed': '将在 {time} 向此会话发送一次继续消息',
  'limit.resume': '在 {time} 继续',
  'limit.cancel': '取消',
  'limit.saving': '正在保存…',
  'limit.failed': '未能预约，详情见下方。',
  'limit.failed.noAnswer': '会话没有响应，未能预约；请稍后重试。',
  'limit.failed.gone': '此会话的屏幕上已不再显示使用上限，未能预约。',
  'limit.row': '上限',
};
export const zhHant = {
  'limit.reached': '已達到使用上限 · {time} 重置',
  'limit.armed': '將在 {time} 向此工作階段傳送一次繼續訊息',
  'limit.resume': '在 {time} 繼續',
  'limit.cancel': '取消',
  'limit.saving': '正在儲存…',
  'limit.failed': '未能預約，詳情見下方。',
  'limit.failed.noAnswer': '工作階段沒有回應，未能預約；請稍後再試。',
  'limit.failed.gone': '此工作階段的畫面上已不再顯示使用上限，未能預約。',
  'limit.row': '上限',
};
export const es = {
  'limit.reached': 'Límite de uso alcanzado · se restablece: {time}',
  'limit.armed': 'Se enviará un mensaje “continuar” a esta sesión: {time}',
  'limit.resume': 'Reanudar: {time}',
  'limit.cancel': 'Cancelar',
  'limit.saving': 'Guardando…',
  'limit.failed': 'No programado; los detalles están abajo.',
  'limit.failed.noAnswer': 'No programado porque la sesión no respondió; inténtalo de nuevo en un momento.',
  'limit.failed.gone': 'No programado porque el límite de uso ya no está en la pantalla de esta sesión.',
  'limit.row': 'Límite',
};
export const fr = {
  'limit.reached': "Limite d’utilisation atteinte · réinitialisation à {time}",
  'limit.armed': 'À {time}, cette session reçoit un message pour continuer',
  'limit.resume': 'Reprendre à {time}',
  'limit.cancel': 'Annuler',
  'limit.saving': 'Enregistrement…',
  'limit.failed': 'Non programmé ; les détails sont ci-dessous.',
  'limit.failed.noAnswer': "Non programmé, car la session n’a pas répondu ; réessayez dans un instant.",
  'limit.failed.gone': "Non programmé, car la limite d’utilisation n’est plus à l’écran de cette session.",
  'limit.row': 'Limite',
};
export const pt = {
  'limit.reached': 'Limite de uso atingido · redefine às {time}',
  'limit.armed': 'Às {time}, esta sessão recebe uma mensagem para continuar',
  'limit.resume': 'Retomar às {time}',
  'limit.cancel': 'Cancelar',
  'limit.saving': 'Salvando…',
  'limit.failed': 'Não agendado; os detalhes estão abaixo.',
  'limit.failed.noAnswer': 'Não agendado porque a sessão não respondeu; tente de novo em instantes.',
  'limit.failed.gone': 'Não agendado porque o limite de uso não está mais na tela desta sessão.',
  'limit.row': 'Limite',
};
