// v25-sidepane-t (V2.5-82): the agent side pane's plain window text, so it follows the window language like the Browser space
// switcher inside it. Never agent output or terminal content; the "PTY" tag stays as it is (a technical name).
declare module '../index' {
  interface AreaKeys {
    'sidePane.region': true;
    'sidePane.resize': true;
    'sidePane.resizeTip': true;
    'sidePane.terminals': true;
    'sidePane.closeShell': true;
    'sidePane.needsInput': true;
    'sidePane.inSplit': true;
    'sidePane.termInSplit': true;
    'sidePane.insert': true;
  }
}

export const en = {
  'sidePane.region': "Side pane",
  'sidePane.resize': "Resize the side pane",
  'sidePane.resizeTip': "Drag to resize · double-click for the default width",
  'sidePane.terminals': "Terminals",
  'sidePane.closeShell': "Close {name}",
  'sidePane.needsInput': "Needs your answer here: chat cannot show this question",
  'sidePane.inSplit': "Shown in a split",
  'sidePane.termInSplit': "This session’s terminal is in a split",
  'sidePane.insert': "Insert in composer",
};

export const ko = {
  'sidePane.region': "옆 패널",
  'sidePane.resize': "옆 패널 크기 조절",
  'sidePane.resizeTip': "끌어서 크기 조절 · 두 번 클릭하면 기본 너비",
  'sidePane.terminals': "터미널",
  'sidePane.closeShell': "{name} 닫기",
  'sidePane.needsInput': "여기서 답이 필요합니다: 채팅에 표시할 수 없는 질문입니다",
  'sidePane.inSplit': "분할 보기에 표시 중",
  'sidePane.termInSplit': "이 세션의 터미널이 분할 보기에 있습니다",
  'sidePane.insert': "입력창에 삽입",
};

export const ja = {
  'sidePane.region': "サイドペイン",
  'sidePane.resize': "サイドペインのサイズを変更",
  'sidePane.resizeTip': "ドラッグでサイズ変更 · ダブルクリックでデフォルトの幅",
  'sidePane.terminals': "ターミナル",
  'sidePane.closeShell': "{name} を閉じる",
  'sidePane.needsInput': "ここで回答が必要です：チャットに表示できない質問です",
  'sidePane.inSplit': "分割で表示中",
  'sidePane.termInSplit': "このセッションのターミナルは分割で表示されています",
  'sidePane.insert': "入力欄に挿入",
};

export const zhHans = {
  'sidePane.region': "侧边面板",
  'sidePane.resize': "调整侧边面板大小",
  'sidePane.resizeTip': "拖动以调整大小 · 双击恢复默认宽度",
  'sidePane.terminals': "终端",
  'sidePane.closeShell': "关闭 {name}",
  'sidePane.needsInput': "需要在这里回答：聊天无法显示这个问题",
  'sidePane.inSplit': "已在拆分中显示",
  'sidePane.termInSplit': "此会话的终端位于拆分中",
  'sidePane.insert': "插入到输入框",
};

export const zhHant = {
  'sidePane.region': "側邊面板",
  'sidePane.resize': "調整側邊面板大小",
  'sidePane.resizeTip': "拖曳以調整大小 · 按兩下恢復預設寬度",
  'sidePane.terminals': "終端",
  'sidePane.closeShell': "關閉 {name}",
  'sidePane.needsInput': "需要在這裡回答：聊天無法顯示這個問題",
  'sidePane.inSplit': "已在分割畫面中顯示",
  'sidePane.termInSplit': "此工作階段的終端位於分割畫面中",
  'sidePane.insert': "插入到輸入框",
};

export const es = {
  'sidePane.region': "Panel lateral",
  'sidePane.resize': "Cambiar el tamaño del panel lateral",
  'sidePane.resizeTip': "Arrastra para cambiar el tamaño · doble clic para el ancho predeterminado",
  'sidePane.terminals': "Terminales",
  'sidePane.closeShell': "Cerrar {name}",
  'sidePane.needsInput': "Necesita tu respuesta aquí: el chat no puede mostrar esta pregunta",
  'sidePane.inSplit': "Se muestra en una división",
  'sidePane.termInSplit': "El terminal de esta sesión está en una división",
  'sidePane.insert': "Insertar en el campo de escritura",
};

export const fr = {
  'sidePane.region': "Volet latéral",
  'sidePane.resize': "Redimensionner le volet latéral",
  'sidePane.resizeTip': "Faites glisser pour redimensionner · double-clic pour la largeur par défaut",
  'sidePane.terminals': "Terminaux",
  'sidePane.closeShell': "Fermer {name}",
  'sidePane.needsInput': "Votre réponse est attendue ici : la conversation ne peut pas afficher cette question",
  'sidePane.inSplit': "Affiché dans une division",
  'sidePane.termInSplit': "Le terminal de cette session est dans une division",
  'sidePane.insert': "Insérer dans la zone de saisie",
};

export const pt = {
  'sidePane.region': "Painel lateral",
  'sidePane.resize': "Redimensionar o painel lateral",
  'sidePane.resizeTip': "Arraste para redimensionar · clique duas vezes para a largura padrão",
  'sidePane.terminals': "Terminais",
  'sidePane.closeShell': "Fechar {name}",
  'sidePane.needsInput': "Precisa da sua resposta aqui: a conversa não consegue mostrar esta pergunta",
  'sidePane.inSplit': "Exibido em uma divisão",
  'sidePane.termInSplit': "O terminal desta sessão está em uma divisão",
  'sidePane.insert': "Inserir na caixa de mensagem",
};
