// Ticket 1002 lane 1: Settings > Assistants (features/assistants.tsx, mockup home-chief-of-staff-1120.html frame 5).
// The seven translations are a first pass; their native read is Q5.
declare module '../index' {
  interface AreaKeys {
    'assistants.title': true;
    'assistants.desc': true;
    'field.homeChief': true;
    'assistants.noLead': true;
    'assistants.editJob': true;
    'assistants.claudeOnly': true;
    'assistants.mode': true;
    'assistants.modeDesc': true;
    'assistants.applies': true;
    'assistants.recommended': true;
    'assistants.briefs': true;
    'assistants.briefsDesc': true;
    'assistants.openSchedules': true;
    'assistants.connectors': true;
    'assistants.mail': true;
    'assistants.mailDesc': true;
    'assistants.readDrafts': true;
    'assistants.calendar': true;
    'assistants.calendarOff': true;
    'assistants.calendarDesc': true;
    'assistants.allowed': true;
    'assistants.allowedDesc': true;
    'assistants.fixed': true;
    'assistants.fullShell': true;
    'assistants.fullShellWarn': true;
    // Tickets 1032 and 1034 (mockup docs/design/bot-statusbar-1121/index.html part 3). English only (owner 11-21): the
    // other languages show these in English until their one pass before the public release.
    'assistants.defaultName': true;
    'assistants.defaultJob': true;
    'assistants.setUp': true;
    'assistants.nameDesc': true;
    'onboarding.assistant.title': true;
    'onboarding.assistant.body': true;
    'onboarding.assistant.runsOn': true;
    'onboarding.assistant.runsOnDesc': true;
    'onboarding.assistant.save': true;
    'onboarding.assistant.note': true;
    'onboarding.assistant.done': true;
    'onboarding.assistant.open': true;
    'onboarding.assistant.rename': true;
    'onboarding.assistant.noClaude': true;
  }
}

export const en = {
  "assistants.title": "Assistants",
  "assistants.desc": "Your main assistant: its name, what it may reach and how it asks.",
  "field.homeChief": "Chief of staff mode",
  "assistants.noLead": "No main assistant yet",
  "assistants.editJob": "Edit job…",
  "assistants.claudeOnly": "Mail and calendar locks are for Claude seats in v1",
  "assistants.mode": "Mode",
  "assistants.modeDesc": "Outward actions always need an Outbox card, in every mode. Shell commands ask, except the two setup steps of its brief (its task list and its SOUL file), and in Full access, shell included.",
  "assistants.applies": "Applies the next time the seat starts.",
  "assistants.recommended": "Recommended",
  "assistants.briefs": "Brief schedules",
  "assistants.briefsDesc": "Weekdays 08:30 and 18:00. Both arrive paused.",
  "assistants.openSchedules": "Open Schedules",
  "assistants.connectors": "Connectors",
  "assistants.mail": "Mail",
  "assistants.mailDesc": "Your claude.ai Gmail connector. Reads and searches. A reply or a new message comes to you as an Outbox card; your yes sends exactly that text.",
  "assistants.readDrafts": "Read; sends on your yes",
  "assistants.calendar": "Calendar",
  "assistants.calendarOff": "Not available",
  "assistants.calendarDesc": "The claude.ai calendar connector does not load in Claude Code yet, so v1 has mail only.",
  "assistants.allowed": "Allowed tools",
  "assistants.allowedDesc": "Allowed: read and search mail, stage an Outbox card, send what you said yes to. Everything else is off.",
  "assistants.fixed": "fixed in v1",
  "assistants.fullShell": "Full access, shell included",
  "assistants.fullShellWarn": "In this mode the Outbox card is not enforced: mail text could make it run commands, including sends, without asking.",
  "assistants.defaultName": "Chief",
  "assistants.defaultJob": "Chief of staff. Keep track of what needs me across all my projects.",
  "assistants.setUp": "Set up",
  "assistants.nameDesc": "Shown in the tree and on its seat.",
  "onboarding.assistant.title": "Name your assistant",
  "onboarding.assistant.body": "Optional. Your main assistant works for you across all projects.",
  "onboarding.assistant.runsOn": "Runs on",
  "onboarding.assistant.runsOnDesc": "The assistant's seat is a Claude seat.",
  "onboarding.assistant.save": "Save name",
  "onboarding.assistant.note": "Nothing starts until you open it. You can change the name later in Settings › Assistants.",
  "onboarding.assistant.done": "Your assistant is {name}. It is in the tree under Assistants.",
  "onboarding.assistant.open": "Open {name}",
  "onboarding.assistant.rename": "Rename it in Settings › Assistants.",
  "onboarding.assistant.noClaude": "Your main assistant runs on Claude, and Claude was not found on this Mac. Install Claude, then come back, or skip this step.",
};
export const ko = {
  "assistants.title": "비서",
  "assistants.desc": "Home의 비서실장: 무엇에 닿을 수 있고 어떻게 묻는지.",
  "field.homeChief": "비서실장 모드",
  "assistants.noLead": "Home에 아직 리더가 없습니다",
  "assistants.editJob": "업무 편집…",
  "assistants.claudeOnly": "메일과 캘린더 잠금은 v1에서 Claude 자리에만 적용됩니다",
  "assistants.mode": "모드",
  "assistants.modeDesc": "바깥으로 나가는 작업은 모든 모드에서 항상 보낼 편지함 카드가 필요합니다. 셸 명령은 ‘전체 권한, 셸 포함’을 빼고 항상 묻습니다.",
  "assistants.applies": "다음에 자리가 시작될 때 적용됩니다.",
  "assistants.recommended": "추천",
  "assistants.briefs": "브리핑 일정",
  "assistants.briefsDesc": "평일 08:30과 18:00. 둘 다 일시 중지 상태로 추가됩니다.",
  "assistants.openSchedules": "예약 열기",
  "assistants.connectors": "커넥터",
  "assistants.mail": "메일",
  "assistants.mailDesc": "claude.ai Google 메일 커넥터. 읽고 검색합니다. 답장이나 새 메시지는 보낼 편지함 카드로 오고, 승인하면 그 내용 그대로 보냅니다.",
  "assistants.readDrafts": "읽기, 승인 시 보내기",
  "assistants.calendar": "캘린더",
  "assistants.calendarOff": "사용할 수 없음",
  "assistants.calendarDesc": "claude.ai 캘린더 커넥터가 아직 Claude Code에서 열리지 않아 v1은 메일만 씁니다.",
  "assistants.allowed": "허용된 도구",
  "assistants.allowedDesc": "허용: 메일 읽기와 검색, 보낼 편지함 카드 올리기, 승인한 것 보내기. 나머지는 모두 꺼져 있습니다.",
  "assistants.fixed": "v1에서 고정",
  "assistants.fullShell": "전체 권한, 셸 포함",
  "assistants.fullShellWarn": "이 모드에서는 보낼 편지함 카드가 강제되지 않습니다. 메일 내용 때문에 보내기를 포함한 명령을 묻지 않고 실행할 수 있습니다.",
};
export const ja = {
  "assistants.title": "アシスタント",
  "assistants.desc": "ホームの首席補佐官：アクセスできる範囲と確認のしかた。",
  "field.homeChief": "首席補佐官のモード",
  "assistants.noLead": "ホームにはまだリーダーがいません",
  "assistants.editJob": "仕事を編集…",
  "assistants.claudeOnly": "メールとカレンダーのロックは v1 では Claude のみ対象です",
  "assistants.mode": "モード",
  "assistants.modeDesc": "外へ出る操作はどのモードでも常に送信トレイのカードが必要です。シェルコマンドは「フルアクセス（シェルを含む）」以外では確認します。",
  "assistants.applies": "アシスタントの次回起動時に適用されます。",
  "assistants.recommended": "おすすめ",
  "assistants.briefs": "ブリーフの予定",
  "assistants.briefsDesc": "平日 08:30 と 18:00。どちらも一時停止の状態で届きます。",
  "assistants.openSchedules": "スケジュールを開く",
  "assistants.connectors": "コネクタ",
  "assistants.mail": "メール",
  "assistants.mailDesc": "claude.ai の Gmail コネクタ。メールを読み取り、検索します。返信や新しいメッセージは送信トレイのカードで届き、承認するとその文面のまま送ります。",
  "assistants.readDrafts": "読み取り、承認で送信",
  "assistants.calendar": "カレンダー",
  "assistants.calendarOff": "利用できません",
  "assistants.calendarDesc": "claude.ai のカレンダーコネクタはまだ Claude Code で読み込まれないため、v1 はメールだけです。",
  "assistants.allowed": "許可されたツール",
  "assistants.allowedDesc": "許可：メールの読み取りと検索、送信トレイのカードの作成、承認したものの送信。それ以外はすべてオフです。",
  "assistants.fixed": "v1 では固定",
  "assistants.fullShell": "フルアクセス（シェルを含む）",
  "assistants.fullShellWarn": "このモードでは送信トレイのカードは強制されません。メールの文面によって、送信を含むコマンドを確認なしに実行するおそれがあります。",
};
export const zhHans = {
  "assistants.title": "助理",
  "assistants.desc": "主页的幕僚长：它能触及什么，以及如何询问。",
  "field.homeChief": "幕僚长模式",
  "assistants.noLead": "主页还没有负责人",
  "assistants.editJob": "编辑工作…",
  "assistants.claudeOnly": "邮件和日历锁定在 v1 中只用于 Claude 助理",
  "assistants.mode": "模式",
  "assistants.modeDesc": "向外的操作在每种模式下都需要发件箱卡片。Shell 命令都会询问，“完全访问（含 Shell）”除外。",
  "assistants.applies": "下次助理启动时生效。",
  "assistants.recommended": "推荐",
  "assistants.briefs": "简报日程",
  "assistants.briefsDesc": "工作日 08:30 和 18:00。两者到达时都已暂停。",
  "assistants.openSchedules": "打开日程",
  "assistants.connectors": "连接器",
  "assistants.mail": "邮件",
  "assistants.mailDesc": "你的 claude.ai Google 邮件连接器。读取和搜索。回复或新邮件以发件箱卡片交给你；你同意后按原文发送。",
  "assistants.readDrafts": "读取；经你同意才发送",
  "assistants.calendar": "日历",
  "assistants.calendarOff": "不可用",
  "assistants.calendarDesc": "claude.ai 日历连接器还不能在 Claude Code 中加载，所以 v1 只有邮件。",
  "assistants.allowed": "允许的工具",
  "assistants.allowedDesc": "允许：读取和搜索邮件，提交发件箱卡片，发送你同意的内容。其他全部关闭。",
  "assistants.fixed": "v1 中固定",
  "assistants.fullShell": "完全访问（含 Shell）",
  "assistants.fullShellWarn": "在此模式下不强制使用发件箱卡片：邮件内容可能让它不经询问就运行命令，包括发送。",
};
export const zhHant = {
  "assistants.title": "助理",
  "assistants.desc": "首頁的幕僚長：它能觸及什麼，以及如何詢問。",
  "field.homeChief": "幕僚長模式",
  "assistants.noLead": "首頁還沒有負責人",
  "assistants.editJob": "編輯工作…",
  "assistants.claudeOnly": "郵件和行事曆鎖定在 v1 中只用於 Claude 席位",
  "assistants.mode": "模式",
  "assistants.modeDesc": "向外的動作在每種模式下都需要寄件匣卡片。shell 指令都會詢問，「完整存取（含 shell）」除外。",
  "assistants.applies": "下次席位啟動時生效。",
  "assistants.recommended": "推薦",
  "assistants.briefs": "簡報排程",
  "assistants.briefsDesc": "平日 08:30 和 18:00。兩者到達時都已暫停。",
  "assistants.openSchedules": "開啟排程",
  "assistants.connectors": "連接器",
  "assistants.mail": "郵件",
  "assistants.mailDesc": "你的 claude.ai Google 郵件連接器。讀取和搜尋。回覆或新郵件以寄件匣卡片交給你；你同意後按原文傳送。",
  "assistants.readDrafts": "讀取；經你同意才傳送",
  "assistants.calendar": "行事曆",
  "assistants.calendarOff": "無法使用",
  "assistants.calendarDesc": "claude.ai 行事曆連接器還無法在 Claude Code 中載入，所以 v1 只有郵件。",
  "assistants.allowed": "允許的工具",
  "assistants.allowedDesc": "允許：讀取和搜尋郵件，提交寄件匣卡片，傳送你同意的內容。其他全部關閉。",
  "assistants.fixed": "v1 中固定",
  "assistants.fullShell": "完整存取（含 shell）",
  "assistants.fullShellWarn": "在此模式下不強制使用寄件匣卡片：郵件內容可能讓它不經詢問就執行指令，包括傳送。",
};
export const es = {
  "assistants.title": "Asistentes",
  "assistants.desc": "El jefe de gabinete de Inicio: a qué puede llegar y cómo pregunta.",
  "field.homeChief": "Modo del jefe de gabinete",
  "assistants.noLead": "Inicio aún no tiene líder",
  "assistants.editJob": "Editar trabajo…",
  "assistants.claudeOnly": "Los bloqueos de correo y calendario son solo para puestos de Claude en v1",
  "assistants.mode": "Modo",
  "assistants.modeDesc": "Las acciones hacia fuera siempre necesitan una tarjeta de la bandeja de salida, en cualquier modo. Los comandos de shell preguntan, salvo en Acceso total con shell.",
  "assistants.applies": "Se aplica la próxima vez que el puesto arranque.",
  "assistants.recommended": "Recomendado",
  "assistants.briefs": "Programaciones de resumen",
  "assistants.briefsDesc": "Días laborables a las 08:30 y 18:00. Ambos llegan en pausa.",
  "assistants.openSchedules": "Abrir Programaciones",
  "assistants.connectors": "Conectores",
  "assistants.mail": "Correo",
  "assistants.mailDesc": "Tu conector de Gmail de claude.ai. Lee y busca. Una respuesta o un mensaje nuevo te llega como tarjeta de la bandeja de salida; tu sí envía exactamente ese texto.",
  "assistants.readDrafts": "Lee; envía con tu sí",
  "assistants.calendar": "Calendario",
  "assistants.calendarOff": "No disponible",
  "assistants.calendarDesc": "El conector de calendario de claude.ai aún no carga en Claude Code, así que v1 solo tiene correo.",
  "assistants.allowed": "Herramientas permitidas",
  "assistants.allowedDesc": "Permitido: leer y buscar correo, preparar una tarjeta de la bandeja de salida, enviar lo que aprobaste. Todo lo demás está apagado.",
  "assistants.fixed": "fijo en v1",
  "assistants.fullShell": "Acceso total con shell",
  "assistants.fullShellWarn": "En este modo la tarjeta de la bandeja de salida no se aplica: el texto de un correo podría llevarlo a ejecutar comandos, envíos incluidos, sin preguntar.",
};
export const fr = {
  "assistants.title": "Assistants",
  "assistants.desc": "Le chef de cabinet d’Accueil : ce qu’il peut atteindre et comment il demande.",
  "field.homeChief": "Mode du chef de cabinet",
  "assistants.noLead": "Accueil n’a pas encore de responsable",
  "assistants.editJob": "Modifier la mission…",
  "assistants.claudeOnly": "Les verrous du courrier et de l’agenda ne valent que pour les postes Claude en v1",
  "assistants.mode": "Mode",
  "assistants.modeDesc": "Les actions vers l’extérieur demandent toujours une carte de la boîte d’envoi, dans chaque mode. Les commandes shell demandent, sauf en Accès complet avec le shell.",
  "assistants.applies": "S’applique au prochain démarrage du poste.",
  "assistants.recommended": "Recommandé",
  "assistants.briefs": "Horaires des points",
  "assistants.briefsDesc": "En semaine à 08:30 et 18:00. Les deux arrivent en pause.",
  "assistants.openSchedules": "Ouvrir les horaires",
  "assistants.connectors": "Connecteurs",
  "assistants.mail": "E-mail",
  "assistants.mailDesc": "Votre connecteur Gmail de claude.ai. Il lit et cherche. Une réponse ou un nouveau message vous arrive en carte de la boîte d’envoi ; votre oui envoie exactement ce texte.",
  "assistants.readDrafts": "Lecture ; envoi sur votre oui",
  "assistants.calendar": "Agenda",
  "assistants.calendarOff": "Non disponible",
  "assistants.calendarDesc": "Le connecteur d’agenda de claude.ai ne se charge pas encore dans Claude Code, donc v1 n’a que le courrier.",
  "assistants.allowed": "Outils permis",
  "assistants.allowedDesc": "Permis : lire et chercher le courrier, préparer une carte de la boîte d’envoi, envoyer ce que vous avez accepté. Tout le reste est coupé.",
  "assistants.fixed": "fixe en v1",
  "assistants.fullShell": "Accès complet avec le shell",
  "assistants.fullShellWarn": "Dans ce mode, la carte de la boîte d’envoi n’est pas imposée : le texte d’un e-mail pourrait lui faire lancer des commandes, envois compris, sans demander.",
};
export const pt = {
  "assistants.title": "Assistentes",
  "assistants.desc": "O chefe de gabinete do Início: o que pode alcançar e como pergunta.",
  "field.homeChief": "Modo do chefe de gabinete",
  "assistants.noLead": "O Início ainda não tem líder",
  "assistants.editJob": "Editar trabalho…",
  "assistants.claudeOnly": "Os bloqueios de e-mail e agenda são só para postos do Claude na v1",
  "assistants.mode": "Modo",
  "assistants.modeDesc": "Ações para fora sempre precisam de um cartão da caixa de saída, em todos os modos. Comandos de shell perguntam, exceto em Acesso total com shell.",
  "assistants.applies": "Vale na próxima vez que o posto iniciar.",
  "assistants.recommended": "Recomendado",
  "assistants.briefs": "Horários de resumo",
  "assistants.briefsDesc": "Dias úteis às 08:30 e 18:00. Ambos chegam pausados.",
  "assistants.openSchedules": "Abrir horários",
  "assistants.connectors": "Conectores",
  "assistants.mail": "E-mail",
  "assistants.mailDesc": "Seu conector do Gmail do claude.ai. Lê e pesquisa. Uma resposta ou mensagem nova chega a você como cartão da caixa de saída; seu sim envia exatamente esse texto.",
  "assistants.readDrafts": "Lê; envia com seu sim",
  "assistants.calendar": "Agenda",
  "assistants.calendarOff": "Indisponível",
  "assistants.calendarDesc": "O conector de agenda do claude.ai ainda não carrega no Claude Code, então a v1 tem só e-mail.",
  "assistants.allowed": "Ferramentas permitidas",
  "assistants.allowedDesc": "Permitido: ler e pesquisar e-mail, preparar um cartão da caixa de saída, enviar o que você aprovou. Todo o resto está desligado.",
  "assistants.fixed": "fixo na v1",
  "assistants.fullShell": "Acesso total com shell",
  "assistants.fullShellWarn": "Neste modo o cartão da caixa de saída não é imposto: o texto de um e-mail pode levá-lo a executar comandos, envios incluídos, sem perguntar.",
};
