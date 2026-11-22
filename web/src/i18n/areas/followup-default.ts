// Ticket 517: the follow-up default row (features/followup-default.tsx) and the composer hint's queue word.
declare module '../index' {
  interface AreaKeys {
    'field.followupDefault': true;
    'followup.queue': true;
    'followup.steer': true;
    'followup.queueDesc': true;
    'followup.steerDesc': true;
    'followup.hintQueue': true;
  }
}

export const en = {
  'field.followupDefault': 'Follow-up',
  'followup.queue': 'Queue',
  'followup.steer': 'Steer',
  'followup.queueDesc': 'When an agent is working, Enter adds your message to the list. The send-now key (Ctrl+Enter by default) sends that one message at once.',
  'followup.steerDesc': 'When an agent is working, Enter stops the turn and sends your message now. The send-now key (Ctrl+Enter by default) adds that one message to the list instead.',
  'followup.hintQueue': 'queue',
};
export const ko = {
  'field.followupDefault': '후속 메시지',
  'followup.queue': '대기열',
  'followup.steer': '끼어들기',
  'followup.queueDesc': '에이전트가 일하는 중에 Enter를 누르면 메시지가 대기열에 들어갑니다. 지금 보내기 키(기본 Ctrl+Enter)는 그 메시지 하나만 바로 보냅니다.',
  'followup.steerDesc': '에이전트가 일하는 중에 Enter를 누르면 작업을 멈추고 메시지를 바로 보냅니다. 지금 보내기 키(기본 Ctrl+Enter)는 그 메시지 하나만 대기열에 넣습니다.',
  'followup.hintQueue': '대기열',
};
export const ja = {
  'field.followupDefault': 'フォローアップ',
  'followup.queue': 'キュー',
  'followup.steer': '割り込み',
  'followup.queueDesc': 'エージェントの作業中に Enter を押すと、メッセージはキューに入ります。今すぐ送信キー（デフォルトは Ctrl+Enter）は、そのメッセージだけを今すぐ送ります。',
  'followup.steerDesc': 'エージェントの作業中に Enter を押すと、作業を止めてメッセージを今すぐ送ります。今すぐ送信キー（デフォルトは Ctrl+Enter）は、そのメッセージだけをキューに入れます。',
  'followup.hintQueue': 'キュー',
};
export const zhHans = {
  'field.followupDefault': '后续消息',
  'followup.queue': '排队',
  'followup.steer': '打断',
  'followup.queueDesc': '代理工作时按 Enter，消息进入队列。立即发送按键（默认 Ctrl+Enter）只让这一条消息立即发送。',
  'followup.steerDesc': '代理工作时按 Enter，会打断当前一轮并立即发送消息。立即发送按键（默认 Ctrl+Enter）只让这一条消息进入队列。',
  'followup.hintQueue': '排队',
};
export const zhHant = {
  'field.followupDefault': '後續訊息',
  'followup.queue': '排隊',
  'followup.steer': '打斷',
  'followup.queueDesc': '代理工作時按 Enter，訊息會進入佇列。立即傳送按鍵（預設 Ctrl+Enter）只讓這一則訊息立即傳送。',
  'followup.steerDesc': '代理工作時按 Enter，會打斷目前這一輪並立即傳送訊息。立即傳送按鍵（預設 Ctrl+Enter）只讓這一則訊息進入佇列。',
  'followup.hintQueue': '排隊',
};
export const es = {
  'field.followupDefault': 'Mensaje de seguimiento',
  'followup.queue': 'En cola',
  'followup.steer': 'Interrumpir',
  'followup.queueDesc': 'Mientras un agente trabaja, Enter añade tu mensaje a la cola. La tecla de enviar ahora (Ctrl+Enter por defecto) envía ese mensaje de inmediato.',
  'followup.steerDesc': 'Mientras un agente trabaja, Enter detiene el turno y envía tu mensaje ya. La tecla de enviar ahora (Ctrl+Enter por defecto) añade ese mensaje a la cola en su lugar.',
  'followup.hintQueue': 'a la cola',
};
export const fr = {
  'field.followupDefault': 'Message de suivi',
  'followup.queue': 'File d’attente',
  'followup.steer': 'Interrompre',
  'followup.queueDesc': 'Entrée pendant qu’un agent travaille met le message dans la file. La touche d’envoi immédiat (Ctrl+Entrée par défaut) l’envoie tout de suite, pour ce seul message.',
  'followup.steerDesc': 'Entrée pendant qu’un agent travaille arrête le tour et envoie le message tout de suite. La touche d’envoi immédiat (Ctrl+Entrée par défaut) le met dans la file, pour ce seul message.',
  'followup.hintQueue': 'en file',
};
export const pt = {
  'field.followupDefault': 'Mensagem de acompanhamento',
  'followup.queue': 'Fila',
  'followup.steer': 'Interromper',
  'followup.queueDesc': 'Quando um agente está trabalhando, Enter coloca sua mensagem na fila. A tecla de enviar agora (Ctrl+Enter por padrão) envia só essa mensagem na hora.',
  'followup.steerDesc': 'Quando um agente está trabalhando, Enter interrompe o turno e envia sua mensagem na hora. A tecla de enviar agora (Ctrl+Enter por padrão) coloca só essa mensagem na fila.',
  'followup.hintQueue': 'para a fila',
};
