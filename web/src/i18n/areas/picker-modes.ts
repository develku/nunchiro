// W35 picker (mockup docs/design/model-picker-1120, mockup 2): the model menu's More models, Fast mode section and digits,
// and the effort chip's own menu with Ultracode. English is the source; the other seven are drafts for a native read
// (docs/i18n-terms.md). "Ultracode" is Claude Code's own name and stays literal.
declare module '../index' {
  interface AreaKeys {
    'pk.more': true;
    'pk.yourModels': true;
    'pk.fastGroup': true;
    'pk.fastEnable': true;
    'pk.credits': true;
    'pk.fastWrongModel': true;
    'pk.fastRestart': true;
    'pk.fastRestartGo': true;
    'pk.fastDraft': true;
    'pk.fastFirstReply': true;
    'pk.fastOn': true;
    'pk.fastCooling': true;
    'pk.fastCooldown': true;
    'pk.fastCooldownUntil': true;
    'pk.effortHelp': true;
    'pk.reasoning': true;
    'pk.codexHelp': true;
    'pk.thinking': true;
    'pk.fastest': true;
    'pk.ultracodeOn': true;
    'pk.notRead': true;
  }
}

export const en = {
  'pk.more': 'More models',
  'pk.yourModels': 'Your models · starts a new {who} session',
  'pk.fastGroup': 'Fast mode',
  'pk.fastEnable': 'Enable fast mode',
  'pk.credits': 'usage credits',
  'pk.fastWrongModel': 'Fast mode runs on Opus 5.5 or Fable 5.2. Pick one above first.',
  'pk.fastRestart': 'Restarts Claude and resumes this conversation, for this session only.',
  'pk.fastDraft': 'A draft is in the box. Restart Claude and resume this conversation anyway?',
  'pk.fastFirstReply': 'Fast mode is available after the first reply.',
  'pk.fastRestartGo': 'Restart Claude',
  'pk.fastOn': 'fast mode on',
  // Ticket 1010, English only (ticket 1035): the mockup's tooltip; {why} is Claude's own notice.
  'pk.fastCooling': 'fast mode cooling down',
  'pk.fastCooldown': 'Fast mode is cooling down.',
  'pk.fastCooldownUntil': '{why} · until {time}',
  'pk.effortHelp': 'Higher effort means more thorough answers, but takes longer and uses your limits faster.',
  'pk.reasoning': 'Reasoning',
  'pk.codexHelp': 'A switch restarts Codex and resumes this conversation; a draft in its box must be sent or cleared first.',
  'pk.thinking': 'Thinking',
  'pk.fastest': 'uses limits fastest',
  'pk.ultracodeOn': 'Claude plans larger tasks as workflows, at this level.',
  'pk.notRead': 'not read yet',
};
export const ko = {
  'pk.more': '다른 모델',
  'pk.yourModels': '내 모델 · 새 {who} 세션을 시작',
  'pk.fastGroup': '빠른 모드',
  'pk.fastEnable': '빠른 모드 켜기',
  'pk.credits': '사용 크레딧',
  'pk.fastWrongModel': '빠른 모드는 Opus 5.5나 Fable 5.2에서만 됩니다. 위에서 먼저 고르세요.',
  'pk.fastRestart': 'Claude를 다시 시작해 이 대화를 이어 갑니다. 이 세션에만 적용됩니다.',
  'pk.fastDraft': '입력란에 초안이 있습니다. 그래도 Claude를 다시 시작해 이 대화를 이어 갈까요?',
  'pk.fastFirstReply': '빠른 모드는 첫 답변 뒤에 쓸 수 있습니다.',
  'pk.fastRestartGo': 'Claude 다시 시작',
  'pk.fastOn': '빠른 모드 켜짐',
  'pk.effortHelp': '생각 수준이 높을수록 더 꼼꼼히 답하지만, 오래 걸리고 한도를 더 빨리 씁니다.',
  'pk.reasoning': '추론',
  'pk.codexHelp': '바꾸면 Codex가 다시 시작해 이 대화를 이어 갑니다. 입력란의 초안은 먼저 보내거나 지워야 합니다.',
  'pk.thinking': '생각',
  'pk.fastest': '한도를 가장 빨리 씀',
  'pk.ultracodeOn': 'Claude가 큰 작업을 이 수준에서 워크플로로 계획합니다.',
  'pk.notRead': '아직 못 읽음',
};
export const ja = {
  'pk.more': 'ほかのモデル',
  'pk.yourModels': '自分のモデル · 新しい {who} セッションを開始',
  'pk.fastGroup': '高速モード',
  'pk.fastEnable': '高速モードをオン',
  'pk.credits': '利用クレジット',
  'pk.fastWrongModel': '高速モードは Opus 5.5 か Fable 5.2 でのみ使えます。先に上で選んでください。',
  'pk.fastRestart': 'Claude を再起動してこの会話を再開します。このセッションだけに適用します。',
  'pk.fastDraft': '入力欄に下書きがあります。それでも Claude を再起動してこの会話を再開しますか？',
  'pk.fastFirstReply': '高速モードは最初の返答のあとで使えます。',
  'pk.fastRestartGo': 'Claude を再起動',
  'pk.fastOn': '高速モード オン',
  'pk.effortHelp': '思考レベルが高いほど丁寧に答えますが、時間がかかり、上限を早く使います。',
  'pk.reasoning': '推論',
  'pk.codexHelp': '切り替えると Codex が再起動してこの会話を再開します。入力欄の下書きは先に送信するか消してください。',
  'pk.thinking': '思考',
  'pk.fastest': '上限を最も早く使う',
  'pk.ultracodeOn': 'Claude が大きな作業をこのレベルでワークフローとして計画します。',
  'pk.notRead': 'まだ読めていません',
};
export const zhHans = {
  'pk.more': '更多模型',
  'pk.yourModels': '你的模型 · 新开一个 {who} 会话',
  'pk.fastGroup': '快速模式',
  'pk.fastEnable': '开启快速模式',
  'pk.credits': '用量额度',
  'pk.fastWrongModel': '快速模式只在 Opus 5.5 或 Fable 5.2 上运行。请先在上方选择其一。',
  'pk.fastRestart': '重启 Claude 并继续此对话，仅对此会话生效。',
  'pk.fastDraft': '输入框里有草稿。仍要重启 Claude 并继续此对话吗？',
  'pk.fastFirstReply': '快速模式在第一次回复后可用。',
  'pk.fastRestartGo': '重启 Claude',
  'pk.fastOn': '快速模式已开',
  'pk.effortHelp': '思考程度越高，回答越周全，但耗时更长，也更快用完额度。',
  'pk.reasoning': '推理',
  'pk.codexHelp': '切换会重启 Codex 并继续此对话；输入框里的草稿须先发送或清除。',
  'pk.thinking': '思考',
  'pk.fastest': '最快用完额度',
  'pk.ultracodeOn': 'Claude 会以此程度把较大的任务规划为工作流。',
  'pk.notRead': '尚未读取',
};
export const zhHant = {
  'pk.more': '更多模型',
  'pk.yourModels': '你的模型 · 新開一個 {who} 工作階段',
  'pk.fastGroup': '快速模式',
  'pk.fastEnable': '開啟快速模式',
  'pk.credits': '用量額度',
  'pk.fastWrongModel': '快速模式只在 Opus 5.5 或 Fable 5.2 上執行。請先在上方選擇其一。',
  'pk.fastRestart': '重新啟動 Claude 並繼續此對話，僅對此工作階段生效。',
  'pk.fastDraft': '輸入框裡有草稿。仍要重新啟動 Claude 並繼續此對話嗎？',
  'pk.fastFirstReply': '快速模式在第一次回覆後可用。',
  'pk.fastRestartGo': '重新啟動 Claude',
  'pk.fastOn': '快速模式已開',
  'pk.effortHelp': '思考程度越高，回答越周全，但耗時更長，也更快用完額度。',
  'pk.reasoning': '推理',
  'pk.codexHelp': '切換會重新啟動 Codex 並繼續此對話；輸入框裡的草稿須先傳送或清除。',
  'pk.thinking': '思考',
  'pk.fastest': '最快用完額度',
  'pk.ultracodeOn': 'Claude 會以此程度把較大的任務規劃為工作流程。',
  'pk.notRead': '尚未讀取',
};
export const es = {
  'pk.more': 'Más modelos',
  'pk.yourModels': 'Tus modelos · inicia una nueva sesión de {who}',
  'pk.fastGroup': 'Modo rápido',
  'pk.fastEnable': 'Activar el modo rápido',
  'pk.credits': 'créditos de uso',
  'pk.fastWrongModel': 'El modo rápido funciona en Opus 5.5 o Fable 5.2. Elige uno arriba primero.',
  'pk.fastRestart': 'Reinicia Claude y retoma esta conversación, solo en esta sesión.',
  'pk.fastDraft': 'Hay un borrador en el cuadro. ¿Reiniciar Claude y retomar esta conversación de todos modos?',
  'pk.fastFirstReply': 'El modo rápido está disponible después de la primera respuesta.',
  'pk.fastRestartGo': 'Reiniciar Claude',
  'pk.fastOn': 'modo rápido activado',
  'pk.effortHelp': 'Un esfuerzo mayor da respuestas más completas, pero tarda más y gasta tus límites más rápido.',
  'pk.reasoning': 'Razonamiento',
  'pk.codexHelp': 'Un cambio reinicia Codex y retoma esta conversación; un borrador en su cuadro debe enviarse o borrarse antes.',
  'pk.thinking': 'Razonamiento',
  'pk.fastest': 'gasta los límites más rápido',
  'pk.ultracodeOn': 'Claude planifica las tareas grandes como flujos de trabajo, con este nivel.',
  'pk.notRead': 'aún sin leer',
};
export const fr = {
  'pk.more': 'Autres modèles',
  'pk.yourModels': 'Vos modèles · démarre une nouvelle session {who}',
  'pk.fastGroup': 'Mode rapide',
  'pk.fastEnable': 'Activer le mode rapide',
  'pk.credits': "crédits d'utilisation",
  'pk.fastWrongModel': "Le mode rapide fonctionne avec Opus 5.5 ou Fable 5.2. Choisissez-en un ci-dessus d'abord.",
  'pk.fastRestart': 'Redémarre Claude et reprend cette conversation, pour cette session uniquement.',
  'pk.fastDraft': 'Un brouillon est dans la zone. Redémarrer Claude et reprendre cette conversation quand même ?',
  'pk.fastFirstReply': 'Le mode rapide est disponible après la première réponse.',
  'pk.fastRestartGo': 'Redémarrer Claude',
  'pk.fastOn': 'mode rapide activé',
  'pk.effortHelp': "Un effort plus élevé donne des réponses plus approfondies, mais prend plus de temps et consomme vos limites plus vite.",
  'pk.reasoning': 'Raisonnement',
  'pk.codexHelp': "Un changement redémarre Codex et reprend cette conversation ; un brouillon dans sa zone doit d'abord être envoyé ou effacé.",
  'pk.thinking': 'Réflexion',
  'pk.fastest': 'consomme les limites le plus vite',
  'pk.ultracodeOn': 'Claude planifie les grandes tâches en workflows, à ce niveau.',
  'pk.notRead': 'pas encore lu',
};
export const pt = {
  'pk.more': 'Mais modelos',
  'pk.yourModels': 'Seus modelos · inicia uma nova sessão do {who}',
  'pk.fastGroup': 'Modo rápido',
  'pk.fastEnable': 'Ativar o modo rápido',
  'pk.credits': 'créditos de uso',
  'pk.fastWrongModel': 'O modo rápido funciona no Opus 5.5 ou no Fable 5.2. Escolha um acima primeiro.',
  'pk.fastRestart': 'Reinicia o Claude e retoma esta conversa, só nesta sessão.',
  'pk.fastDraft': 'Há um rascunho na caixa. Reiniciar o Claude e retomar esta conversa mesmo assim?',
  'pk.fastFirstReply': 'O modo rápido fica disponível depois da primeira resposta.',
  'pk.fastRestartGo': 'Reiniciar o Claude',
  'pk.fastOn': 'modo rápido ativado',
  'pk.effortHelp': 'Um esforço maior dá respostas mais completas, mas demora mais e gasta seus limites mais rápido.',
  'pk.reasoning': 'Raciocínio',
  'pk.codexHelp': 'Uma troca reinicia o Codex e retoma esta conversa; um rascunho na caixa dele precisa ser enviado ou apagado antes.',
  'pk.thinking': 'Raciocínio',
  'pk.fastest': 'gasta os limites mais rápido',
  'pk.ultracodeOn': 'O Claude planeja tarefas grandes como fluxos de trabalho, neste nível.',
  'pk.notRead': 'ainda não lido',
};
