// Ticket 375 (part A): Files row actions, Open in editor, the editor setting and the viewer's Wrap.
// English is the source; the other seven are first drafts for a later native read.
declare module '../index' {
  interface AreaKeys {
    'files.openEditor': true;
    'files.editorFailed': true;
    'files.editorRemote': true;
    'files.addToChat': true;
    'files.wrap': true;
    'files.wrapTip': true;
    'field.editorApp': true;
    'files.editorDesc': true;
    'files.editorDefault': true;
    'searchWords.editorApp': true;
  }
}

export const en = {
  'files.openEditor': "Open in editor",
  'files.editorFailed': "The editor did not open: {error}",
  'files.editorRemote': "Opens on this Mac only; this session runs on another machine.",
  'files.addToChat': "Add to chat",
  'files.wrap': "Wrap",
  'files.wrapTip': "Wrap long lines (kept for this tab)",
  'field.editorApp': "Editor",
  'files.editorDesc': "Open in editor uses this app. VS Code, Cursor and Zed also jump to the line.",
  'files.editorDefault': "System default",
  'searchWords.editorApp': "editor, open in editor, code editor, VS Code, Cursor, Zed",
};
export const ko = {
  'files.openEditor': "편집기에서 열기",
  'files.editorFailed': "편집기가 열리지 않았습니다: {error}",
  'files.editorRemote': "이 Mac에서만 열립니다. 이 세션은 다른 컴퓨터에서 실행 중입니다.",
  'files.addToChat': "채팅에 추가",
  'files.wrap': "줄바꿈",
  'files.wrapTip': "긴 줄 줄바꿈 (이 탭에 유지)",
  'field.editorApp': "편집기",
  'files.editorDesc': "편집기에서 열기가 이 앱을 사용합니다. VS Code, Cursor, Zed는 해당 줄로 이동합니다.",
  'files.editorDefault': "시스템 기본값",
  'searchWords.editorApp': "에디터, 편집기, 에디터에서 열기, 코드 에디터",
};
export const ja = {
  'files.openEditor': "エディターで開く",
  'files.editorFailed': "エディターが開きませんでした：{error}",
  'files.editorRemote': "この Mac でのみ開けます。このセッションは別のマシンで動いています。",
  'files.addToChat': "チャットに追加",
  'files.wrap': "折り返し",
  'files.wrapTip': "長い行を折り返す（このタブで保持）",
  'field.editorApp': "エディター",
  'files.editorDesc': "「エディターで開く」はこのアプリを使います。VS Code、Cursor、Zed はその行へ移動します。",
  'files.editorDefault': "システムのデフォルト",
  'searchWords.editorApp': "エディタ, エディタで開く, コードエディタ",
};
export const zhHans = {
  'files.openEditor': "在编辑器中打开",
  'files.editorFailed': "编辑器未能打开：{error}",
  'files.editorRemote': "只能在这台 Mac 上打开；此会话在另一台机器上运行。",
  'files.addToChat': "添加到聊天",
  'files.wrap': "换行",
  'files.wrapTip': "长行换行（此选项卡保持）",
  'field.editorApp': "编辑器",
  'files.editorDesc': "“在编辑器中打开”使用此应用。VS Code、Cursor 和 Zed 还会跳到该行。",
  'files.editorDefault': "系统默认",
  'searchWords.editorApp': "编辑器, 在编辑器中打开, 代码编辑器",
};
export const zhHant = {
  'files.openEditor': "在編輯器中開啟",
  'files.editorFailed': "編輯器未能開啟：{error}",
  'files.editorRemote': "只能在這台 Mac 上開啟；此工作階段在另一台機器上執行。",
  'files.addToChat': "加入聊天",
  'files.wrap': "換行",
  'files.wrapTip': "長行換行（此選項卡保留）",
  'field.editorApp': "編輯器",
  'files.editorDesc': "「在編輯器中開啟」使用此 App。VS Code、Cursor 和 Zed 也會跳到該行。",
  'files.editorDefault': "系統預設",
  'searchWords.editorApp': "編輯器, 在編輯器中開啟, 程式碼編輯器",
};
export const es = {
  'files.openEditor': "Abrir en el editor",
  'files.editorFailed': "El editor no se abrió: {error}",
  'files.editorRemote': "Solo se abre en este Mac; esta sesión se ejecuta en otra máquina.",
  'files.addToChat': "Añadir al chat",
  'files.wrap': "Ajustar",
  'files.wrapTip': "Ajustar líneas largas (se guarda para esta pestaña)",
  'field.editorApp': "Editor",
  'files.editorDesc': "Abrir en el editor usa esta app. VS Code, Cursor y Zed también saltan a la línea.",
  'files.editorDefault': "Predeterminado del sistema",
  'searchWords.editorApp': "editor, abrir en el editor, editor de código",
};
export const fr = {
  'files.openEditor': "Ouvrir dans l’éditeur",
  'files.editorFailed': "L’éditeur ne s’est pas ouvert : {error}",
  'files.editorRemote': "S’ouvre sur ce Mac uniquement ; cette session tourne sur une autre machine.",
  'files.addToChat': "Ajouter à la conversation",
  'files.wrap': "Retour à la ligne",
  'files.wrapTip': "Retour à la ligne des longues lignes (conservé pour cet onglet)",
  'field.editorApp': "Éditeur",
  'files.editorDesc': "Ouvrir dans l’éditeur utilise cette app. VS Code, Cursor et Zed vont aussi à la ligne.",
  'files.editorDefault': "Par défaut du système",
  'searchWords.editorApp': "éditeur, ouvrir dans l’éditeur, éditeur de code",
};
export const pt = {
  'files.openEditor': "Abrir no editor",
  'files.editorFailed': "O editor não abriu: {error}",
  'files.editorRemote': "Abre só neste Mac; esta sessão roda em outra máquina.",
  'files.addToChat': "Adicionar à conversa",
  'files.wrap': "Quebrar linhas",
  'files.wrapTip': "Quebrar linhas longas (mantido nesta aba)",
  'field.editorApp': "Editor",
  'files.editorDesc': "Abrir no editor usa este app. VS Code, Cursor e Zed também vão para a linha.",
  'files.editorDefault': "Padrão do sistema",
  'searchWords.editorApp': "editor, abrir no editor, editor de código",
};
