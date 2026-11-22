// Ticket 469: the one action an empty list or empty screen offers, and the no-session lines moved out of raw English. Worded apart from the header and tab-bar buttons
// ("New session", "Add machine", "Add schedule") so the page never shows two controls with the same name.
declare module '../index' {
  interface AreaKeys {
    'empty.startSession': true;
    'empty.addMcp': true;
    'empty.addFirstMachine': true;
    'files.noSession': true;
    'artifactsWidget.noSession': true;
    'artifactsWidget.noItems': true;
    'artifactsWidget.eventsError': true;
    'artifactsWidget.thisSession': true;
    'artifactsWidget.filesChanged': true;
  }
}
export const en = {
  "empty.addMcp": "Add a server",
  'empty.startSession': "Start a session",
  'empty.addFirstMachine': "Add your first machine",
  'files.noSession': "Open a session to see its files.",
  'artifactsWidget.noSession': "Open a session to see its attachments and artifacts.",
  "artifactsWidget.noItems": "No attachments or artifacts in this session yet. Attach a file to a message, or ask the agent to make an artifact.",
  'artifactsWidget.eventsError': "Chat events are unavailable: {error}",
  'artifactsWidget.thisSession': "This session",
  'artifactsWidget.filesChanged': "Files changed",
};
export const ko = {
  "empty.addMcp": "서버 추가",
  'empty.startSession': "세션 시작",
  'empty.addFirstMachine': "첫 머신 추가",
  'files.noSession': "세션을 열면 파일이 표시됩니다.",
  'artifactsWidget.noSession': "세션을 열면 첨부 파일과 아티팩트가 표시됩니다.",
  "artifactsWidget.noItems": "이 세션에는 아직 첨부 파일이나 아티팩트가 없습니다. 메시지에 파일을 첨부하거나 에이전트에게 아티팩트를 만들어 달라고 하세요.",
  'artifactsWidget.eventsError': "채팅 이벤트를 읽을 수 없습니다: {error}",
  'artifactsWidget.thisSession': "이 세션",
  'artifactsWidget.filesChanged': "변경된 파일",
};
export const ja = {
  "empty.addMcp": "サーバーを追加",
  'empty.startSession': "セッションを開始",
  'empty.addFirstMachine': "最初のマシンを追加",
  'files.noSession': "セッションを開くとファイルが表示されます。",
  'artifactsWidget.noSession': "セッションを開くと添付ファイルとアーティファクトが表示されます。",
  "artifactsWidget.noItems": "このセッションにはまだ添付ファイルやアーティファクトがありません。メッセージにファイルを添付するか、エージェントにアーティファクトを作らせてください。",
  'artifactsWidget.eventsError': "チャットイベントを読み込めません：{error}",
  'artifactsWidget.thisSession': "このセッション",
  'artifactsWidget.filesChanged': "変更されたファイル",
};
export const zhHans = {
  "empty.addMcp": "添加服务器",
  'empty.startSession': "开始会话",
  'empty.addFirstMachine': "添加第一台机器",
  'files.noSession': "打开一个会话以查看其文件。",
  'artifactsWidget.noSession': "打开一个会话以查看其附件和产物。",
  "artifactsWidget.noItems": "此会话还没有附件或产物。给消息附加文件，或让代理做一个产物。",
  'artifactsWidget.eventsError': "无法读取聊天事件：{error}",
  'artifactsWidget.thisSession': "此会话",
  'artifactsWidget.filesChanged': "已更改的文件",
};
export const zhHant = {
  "empty.addMcp": "新增伺服器",
  'empty.startSession': "開始工作階段",
  'empty.addFirstMachine': "新增第一台機器",
  'files.noSession': "開啟一個工作階段以查看其檔案。",
  'artifactsWidget.noSession': "開啟一個工作階段以查看其附件和產物。",
  "artifactsWidget.noItems": "此工作階段還沒有附件或產物。為訊息附加檔案，或請代理做一個產物。",
  'artifactsWidget.eventsError': "無法讀取聊天事件：{error}",
  'artifactsWidget.thisSession': "此工作階段",
  'artifactsWidget.filesChanged': "已變更的檔案",
};
export const es = {
  "empty.addMcp": "Añadir un servidor",
  'empty.startSession': "Iniciar una sesión",
  'empty.addFirstMachine': "Añadir la primera máquina",
  'files.noSession': "Abre una sesión para ver sus archivos.",
  'artifactsWidget.noSession': "Abre una sesión para ver sus adjuntos y artefactos.",
  "artifactsWidget.noItems": "Esta sesión aún no tiene adjuntos ni artefactos. Adjunta un archivo a un mensaje o pide al agente que cree un artefacto.",
  'artifactsWidget.eventsError': "Los eventos del chat no están disponibles: {error}",
  'artifactsWidget.thisSession': "Esta sesión",
  'artifactsWidget.filesChanged': "Archivos cambiados",
};
export const fr = {
  "empty.addMcp": "Ajouter un serveur",
  'empty.startSession': "Démarrer une session",
  'empty.addFirstMachine': "Ajouter une première machine",
  'files.noSession': "Ouvrez une session pour voir ses fichiers.",
  'artifactsWidget.noSession': "Ouvrez une session pour voir ses pièces jointes et artefacts.",
  "artifactsWidget.noItems": "Cette session n’a encore ni pièce jointe ni artefact. Joignez un fichier à un message ou demandez à l’agent de créer un artefact.",
  'artifactsWidget.eventsError': "Les événements de la conversation sont indisponibles : {error}",
  'artifactsWidget.thisSession': "Cette session",
  'artifactsWidget.filesChanged': "Fichiers modifiés",
};
export const pt = {
  "empty.addMcp": "Adicionar um servidor",
  'empty.startSession': "Iniciar uma sessão",
  'empty.addFirstMachine': "Adicionar a primeira máquina",
  'files.noSession': "Abra uma sessão para ver os arquivos.",
  'artifactsWidget.noSession': "Abra uma sessão para ver os anexos e artefatos.",
  "artifactsWidget.noItems": "Esta sessão ainda não tem anexos nem artefatos. Anexe um arquivo a uma mensagem ou peça ao agente para criar um artefato.",
  'artifactsWidget.eventsError': "Os eventos da conversa não estão disponíveis: {error}",
  'artifactsWidget.thisSession': "Esta sessão",
  'artifactsWidget.filesChanged': "Arquivos alterados",
};
