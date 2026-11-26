// V2.5-25 chat design pass: the working row at the end of the transcript (needs 140 motion). Older chat.* keys stay in the legacy catalogues.
declare module '../index' {
  interface AreaKeys {
    'chat.v25.working': true;
    'chat.v25.workingFor': true;
    // ticket 212 (needs 178): the row while a decision waits, and the line for a working session with no transcript.
    'chat.v25.waitingForYou': true;
    'chat.noTranscript': true;
    // ticket 294 (needs 213): a first message waits for the agent's startup dialog.
    'chat.held.lead': true;
    // Look 1117 v14 N14-S3-1: a message the core holds behind a permission or question card.
    'chat.held.card': true;
    'chat.held.cancel': true;
    'chat.held.cancelTip': true;
    'chat.held.second': true;
    // Ticket 1056: the true reason a held message waits (English only until ticket 1035).
    'chat.held.working': true;
    'chat.held.behind': true;
    // Ticket 1094: a message the agent did not take waits and goes again (English only until ticket 1035).
    'chat.held.retry': true;
    // Ticket 1121: a dropped message the core stopped pasting (English only until ticket 1035).
    'chat.held.stopped': true;
    // needs 168: the plan strip above the composer.
    'chat.plan.region': true;
    'chat.plan.count': true;
    'chat.plan.done': true;
    'chat.plan.expand': true;
    'chat.plan.collapse': true;
    // ticket 216 (needs 178 B2): the terminal path popover.
    'chat.termPath.hint': true;
    'chat.termPath.open': true;
    'chat.termPath.copy': true;
    'chat.termPath.reveal': true;
    // ticket 581: a chat edit card while its session waits on a permission; ticket 199: the strip's "+N" button.
    'chat.row.waitingApproval': true;
    'chat.strip.next': true;
    // The knock: another sender's message waits at the session's row (English only until the translation pass).
    'knock.label': true;
    'knock.later': true;
    'knock.more': true;
    'knock.why.typing': true;
    'knock.why.turn': true;
    'knock.why.direct': true;
    'knock.why.terminal_text': true;
    'knock.why.later': true;
    'knock.why.attached': true;
    'knock.now': true;
    'knock.attach': true;
    'knock.laterBtn': true;
    'knock.chip': true;
    'knock.detach': true;
    'knock.from': true;
    'knock.failed': true;
    // Type in terminal: letters typed in an agent's terminal go to the composer unless it is on.
    'direct.on': true;
    'direct.onTip': true;
    'direct.done': true;
    'direct.doneTip': true;
    'direct.line': true;
    'direct.note': true;
  }
}

export const en = {
  'knock.label': 'Message from {name}, waiting', 'knock.later': 'Message from {name}, later', 'knock.more': '{n} more messages waiting',
  'knock.why.typing': 'Goes in when you pause typing.', 'knock.why.turn': 'Goes in when this turn ends.',
  'knock.why.direct': 'Waiting: you are typing in the terminal.', 'knock.why.terminal_text': 'Waiting: your text is in the terminal.',
  'knock.why.later': 'Later: after your next prompt.', 'knock.why.attached': 'Attached to your next prompt.',
  'knock.now': 'Send now', 'knock.attach': 'Attach to my next prompt', 'knock.laterBtn': 'Later',
  'knock.chip': 'Attached: message from {name}', 'knock.detach': 'Detach the message from {name}', 'knock.from': 'Message from {name}',
  'knock.failed': 'Not changed: {error}',
  'direct.on': 'Type in terminal', 'direct.onTip': 'Type in the agent’s own box; other messages wait until you are done',
  'direct.done': 'Done', 'direct.doneTip': 'Letters go to the composer again',
  'direct.line': 'Typing in terminal. Messages wait until you are done.', 'direct.note': 'Typing goes to the composer.',
  'chat.held.working': 'Waiting for the agent to finish its turn:', 'chat.held.behind': 'Waiting for earlier messages to go first ({n}):', // ticket 1056
  'chat.held.retry': 'The agent did not take it yet. It goes again when the agent is ready:', // ticket 1094
  'chat.held.stopped': 'The agent did not take it and it will not be pasted again. Cancel send puts it back in the box:', // ticket 1121
  'chat.held.second': 'One message is already waiting; yours stays in the box.',
  'chat.held.lead': 'Waiting for the agent to be ready:', 'chat.held.card': 'Held until you answer:', 'chat.held.cancel': 'Cancel send', 'chat.held.cancelTip': 'Cancel send: put the words back in the box (Esc)',
  'chat.v25.working': 'Working', 'chat.v25.workingFor': 'Working for {time}',
  'chat.v25.waitingForYou': 'Waiting for you', 'chat.noTranscript': 'no transcript: {reason}',
  'chat.plan.region': 'Plan',
  'chat.plan.count': '{done}/{total} · {step}',
  'chat.plan.done': '{done}/{total} · done',
  'chat.plan.expand': 'Show the plan',
  'chat.plan.collapse': 'Hide the plan',
  'chat.termPath.hint': 'Click for actions, Cmd+click to open',
  'chat.termPath.open': 'Open in Nunchiro',
  'chat.termPath.copy': 'Copy path',
  'chat.termPath.reveal': 'Reveal in Finder',
  'chat.row.waitingApproval': 'waiting for approval',
  'chat.strip.next': 'Show the next waiting item',
};
export const ko = {
  'chat.held.second': '이미 보낼 메시지가 하나 기다리는 중입니다. 입력한 내용은 입력창에 남아 있습니다.',
  'chat.held.lead': '에이전트 준비를 기다리는 중:', 'chat.held.card': '답하면 보냅니다:', 'chat.held.cancel': '보내기 취소', 'chat.held.cancelTip': '보내기를 취소하고 입력창으로 되돌립니다 (Esc)',
  'chat.v25.working': '작업 중', 'chat.v25.workingFor': '작업 중 {time}',
  'chat.v25.waitingForYou': '내 답 대기', 'chat.noTranscript': '대화 기록 없음: {reason}',
  'chat.plan.region': '계획',
  'chat.plan.count': '{done}/{total} · {step}',
  'chat.plan.done': '{done}/{total} · 완료',
  'chat.plan.expand': '계획 펼치기',
  'chat.plan.collapse': '계획 접기',
  'chat.termPath.hint': '클릭하면 동작 선택, Cmd+클릭하면 열기',
  'chat.termPath.open': 'Nunchiro에서 열기',
  'chat.termPath.copy': '경로 복사',
  'chat.termPath.reveal': 'Finder에서 보기',
  'chat.row.waitingApproval': '승인 대기 중',
  'chat.strip.next': '다음 대기 항목 보기',
};
export const ja = {
  'chat.held.second': 'すでに 1 件のメッセージが待機中です。入力内容は入力欄に残っています。',
  'chat.held.lead': 'エージェントの準備を待っています：', 'chat.held.card': '回答するまで保留中：', 'chat.held.cancel': '送信を取り消す', 'chat.held.cancelTip': '送信を取り消して、入力欄に戻す（Esc）',
  'chat.v25.working': '作業中', 'chat.v25.workingFor': '作業中 {time}',
  'chat.v25.waitingForYou': 'あなたの対応待ち', 'chat.noTranscript': 'トランスクリプトなし：{reason}',
  'chat.plan.region': 'プラン',
  'chat.plan.count': '{done}/{total} · {step}',
  'chat.plan.done': '{done}/{total} · 完了',
  'chat.plan.expand': 'プランを開く',
  'chat.plan.collapse': 'プランを閉じる',
  'chat.termPath.hint': 'クリックで操作を選択、Cmd+クリックで開く',
  'chat.termPath.open': 'Nunchiro で開く',
  'chat.termPath.copy': 'パスをコピー',
  'chat.termPath.reveal': 'Finder で表示',
  'chat.row.waitingApproval': '承認待ち',
  'chat.strip.next': '次の待機項目を表示',
};
export const zhHans = {
  'chat.held.second': '已有一条消息在等待发送；你输入的内容保留在输入框中。',
  'chat.held.lead': '正在等待代理就绪：', 'chat.held.card': '回答后发送：', 'chat.held.cancel': '取消发送', 'chat.held.cancelTip': '取消发送，并把内容放回输入框 (Esc)',
  'chat.v25.working': '工作中', 'chat.v25.workingFor': '已工作 {time}',
  'chat.v25.waitingForYou': '等你处理', 'chat.noTranscript': '无对话记录：{reason}',
  'chat.plan.region': '计划',
  'chat.plan.count': '{done}/{total} · {step}',
  'chat.plan.done': '{done}/{total} · 已完成',
  'chat.plan.expand': '展开计划',
  'chat.plan.collapse': '收起计划',
  'chat.termPath.hint': '点击选择操作，Cmd+点击直接打开',
  'chat.termPath.open': '在 Nunchiro 中打开',
  'chat.termPath.copy': '复制路径',
  'chat.termPath.reveal': '在访达中显示',
  'chat.row.waitingApproval': '等待批准',
  'chat.strip.next': '显示下一个等待项',
};
export const zhHant = {
  'chat.held.second': '已有一則訊息在等待傳送；你輸入的內容保留在輸入框中。',
  'chat.held.lead': '正在等待代理就緒：', 'chat.held.card': '回答後傳送：', 'chat.held.cancel': '取消傳送', 'chat.held.cancelTip': '取消傳送，並把內容放回輸入框（Esc）',
  'chat.v25.working': '工作中', 'chat.v25.workingFor': '已工作 {time}',
  'chat.v25.waitingForYou': '等你處理', 'chat.noTranscript': '無對話記錄：{reason}',
  'chat.plan.region': '計畫',
  'chat.plan.count': '{done}/{total} · {step}',
  'chat.plan.done': '{done}/{total} · 已完成',
  'chat.plan.expand': '展開計畫',
  'chat.plan.collapse': '收合計畫',
  'chat.termPath.hint': '點按選擇操作，Cmd+點按直接開啟',
  'chat.termPath.open': '在 Nunchiro 中開啟',
  'chat.termPath.copy': '複製路徑',
  'chat.termPath.reveal': '在 Finder 中顯示',
  'chat.row.waitingApproval': '等待核准',
  'chat.strip.next': '顯示下一個等待項目',
};
export const es = {
  'chat.held.second': 'Ya hay un mensaje en espera; el tuyo se queda en el cuadro.',
  'chat.held.lead': 'Esperando a que el agente esté listo:', 'chat.held.card': 'Retenido hasta que respondas:', 'chat.held.cancel': 'Cancelar el envío', 'chat.held.cancelTip': 'Cancelar el envío y devolver el texto al cuadro (Esc)',
  'chat.v25.working': 'Trabajando', 'chat.v25.workingFor': 'Trabajando desde hace {time}',
  'chat.v25.waitingForYou': 'Esperándote', 'chat.noTranscript': 'sin transcripción: {reason}',
  'chat.plan.region': 'Plan',
  'chat.plan.count': '{done}/{total} · {step}',
  'chat.plan.done': '{done}/{total} · hecho',
  'chat.plan.expand': 'Mostrar el plan',
  'chat.plan.collapse': 'Ocultar el plan',
  'chat.termPath.hint': 'Clic para ver acciones, Cmd+clic para abrir',
  'chat.termPath.open': 'Abrir en Nunchiro',
  'chat.termPath.copy': 'Copiar ruta',
  'chat.termPath.reveal': 'Mostrar en Finder',
  'chat.row.waitingApproval': 'esperando aprobación',
  'chat.strip.next': 'Mostrar el siguiente elemento en espera',
};
export const fr = {
  'chat.held.second': 'Un message attend déjà ; le vôtre reste dans la zone de saisie.',
  'chat.held.lead': "En attente que l’agent soit prêt :", 'chat.held.card': 'Retenu jusqu’à votre réponse :', 'chat.held.cancel': "Annuler l’envoi", 'chat.held.cancelTip': "Annuler l’envoi et remettre le texte dans la zone (Échap)",
  'chat.v25.working': 'En cours', 'chat.v25.workingFor': 'En cours depuis {time}',
  'chat.v25.waitingForYou': "En attente de votre réponse", 'chat.noTranscript': 'pas de transcription : {reason}',
  'chat.plan.region': 'Plan',
  'chat.plan.count': '{done}/{total} · {step}',
  'chat.plan.done': '{done}/{total} · terminé',
  'chat.plan.expand': 'Afficher le plan',
  'chat.plan.collapse': 'Masquer le plan',
  'chat.termPath.hint': 'Cliquer pour les actions, Cmd+clic pour ouvrir',
  'chat.termPath.open': 'Ouvrir dans Nunchiro',
  'chat.termPath.copy': 'Copier le chemin',
  'chat.termPath.reveal': 'Afficher dans le Finder',
  'chat.row.waitingApproval': "en attente d’approbation",
  'chat.strip.next': "Afficher l’élément suivant en attente",
};
export const pt = {
  'chat.held.second': 'Já há uma mensagem aguardando; a sua fica na caixa.',
  'chat.held.lead': 'Aguardando o agente ficar pronto:', 'chat.held.card': 'Retido até você responder:', 'chat.held.cancel': 'Cancelar envio', 'chat.held.cancelTip': 'Cancelar o envio e devolver o texto à caixa (Esc)',
  'chat.v25.working': 'Trabalhando', 'chat.v25.workingFor': 'Trabalhando há {time}',
  'chat.v25.waitingForYou': 'Aguardando você', 'chat.noTranscript': 'sem transcrição: {reason}',
  'chat.plan.region': 'Plano',
  'chat.plan.count': '{done}/{total} · {step}',
  'chat.plan.done': '{done}/{total} · concluído',
  'chat.plan.expand': 'Mostrar o plano',
  'chat.plan.collapse': 'Ocultar o plano',
  'chat.termPath.hint': 'Clique para ver ações, Cmd+clique para abrir',
  'chat.termPath.open': 'Abrir no Nunchiro',
  'chat.termPath.copy': 'Copiar caminho',
  'chat.termPath.reveal': 'Mostrar no Finder',
  'chat.row.waitingApproval': 'aguardando aprovação',
  'chat.strip.next': 'Mostrar o próximo item em espera',
};
