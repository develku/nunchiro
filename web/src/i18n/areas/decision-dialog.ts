// Real-app 11-10 defect 5 (v32-shell-2): a dialog's card (an agent's folder-trust prompt). The core answers a dialog with Esc only
// (needs 44), so the card says the session's terminal answers it, opens that terminal, and names what Esc does.
declare module '../index' {
  interface AreaKeys {
    "decisions.kindDialog": true;
    "decisions.dialogWhy": true;
    "decisions.openTerminal": true;
    "decisions.openTerminalTip": true;
    "decisions.dialogEsc": true;
    "decisions.dialogEscTip": true;
    "decisions.escExits": true;
    "decisions.escCancels": true;
    "decisions.windowShort": true;
  }
}

export const en = {
  "decisions.kindDialog": "prompt in the terminal",
  "decisions.dialogWhy": "Answer this prompt in the terminal of the session. This card cannot send any of its choices.",
  "decisions.openTerminal": "Open terminal",
  "decisions.openTerminalTip": "Show this session's terminal, focused on the prompt",
  "decisions.dialogEsc": "Esc: {effect}",
  "decisions.dialogEscTip": "Sends Esc to the prompt (3)",
  "decisions.escExits": "the agent exits",
  "decisions.escCancels": "the prompt's own cancel",
  "decisions.windowShort": "The window is too short to show this question. Make the window taller, then answer it in the terminal.",
};

export const ko = {
  "decisions.kindDialog": "터미널의 요청",
  "decisions.dialogWhy": "이 요청은 세션의 터미널에서 답하세요. 이 카드에서는 선택지를 보낼 수 없습니다.",
  "decisions.openTerminal": "터미널 열기",
  "decisions.openTerminalTip": "이 세션의 터미널을 열고 요청 위치로 이동합니다",
  "decisions.dialogEsc": "Esc: {effect}",
  "decisions.dialogEscTip": "요청에 Esc를 보냅니다 (3)",
  "decisions.escExits": "에이전트가 종료됩니다",
  "decisions.escCancels": "요청 자체의 취소",
  "decisions.windowShort": "창이 너무 낮아 이 질문을 보여 줄 수 없습니다. 창을 더 높게 키운 뒤 터미널에서 답하세요.",
};

export const ja = {
  "decisions.kindDialog": "ターミナルのプロンプト",
  "decisions.dialogWhy": "このプロンプトにはセッションのターミナルで答えてください。このカードからは選択肢を送れません。",
  "decisions.openTerminal": "ターミナルを開く",
  "decisions.openTerminalTip": "このセッションのターミナルをプロンプトにフォーカスして表示します",
  "decisions.dialogEsc": "Esc：{effect}",
  "decisions.dialogEscTip": "プロンプトに Esc を送ります（3）",
  "decisions.escExits": "エージェントが終了します",
  "decisions.escCancels": "プロンプト自身のキャンセル",
  "decisions.windowShort": "ウィンドウの高さが足りないため、この質問を表示できません。ウィンドウを高くしてから、ターミナルで答えてください。",
};

export const zhHans = {
  "decisions.kindDialog": "终端中的提示",
  "decisions.dialogWhy": "请在会话的终端中回答此提示：此卡片不会发送任何选项。",
  "decisions.openTerminal": "打开终端",
  "decisions.openTerminalTip": "显示此会话的终端并聚焦到提示",
  "decisions.dialogEsc": "Esc：{effect}",
  "decisions.dialogEscTip": "向提示发送 Esc (3)",
  "decisions.escExits": "代理会退出",
  "decisions.escCancels": "提示自身的取消",
  "decisions.windowShort": "窗口太矮，无法显示此问题。请把窗口调高，然后在终端中回答。",
};

export const zhHant = {
  "decisions.kindDialog": "終端中的提示",
  "decisions.dialogWhy": "請在工作階段的終端中回答此提示：此卡片不會傳送任何選項。",
  "decisions.openTerminal": "開啟終端",
  "decisions.openTerminalTip": "顯示此工作階段的終端並聚焦到提示",
  "decisions.dialogEsc": "Esc：{effect}",
  "decisions.dialogEscTip": "向提示傳送 Esc（3）",
  "decisions.escExits": "代理會結束",
  "decisions.escCancels": "提示本身的取消",
  "decisions.windowShort": "視窗太矮，無法顯示此問題。請把視窗調高，然後在終端中回答。",
};

export const es = {
  "decisions.kindDialog": "pregunta en el terminal",
  "decisions.dialogWhy": "Responde a esta pregunta en el terminal de la sesión: esta tarjeta no envía ninguna de sus opciones.",
  "decisions.openTerminal": "Abrir terminal",
  "decisions.openTerminalTip": "Muestra el terminal de esta sesión, con el foco en la pregunta",
  "decisions.dialogEsc": "Esc: {effect}",
  "decisions.dialogEscTip": "Envía Esc a la pregunta (3)",
  "decisions.escExits": "el agente se cierra",
  "decisions.escCancels": "la cancelación propia de la pregunta",
  "decisions.windowShort": "La ventana es demasiado baja para mostrar esta pregunta. Haz la ventana más alta y respóndela en el terminal.",
};

export const fr = {
  "decisions.kindDialog": "invite dans le terminal",
  "decisions.dialogWhy": "Répondez à cette invite dans le terminal de la session : cette carte n’envoie aucun de ses choix.",
  "decisions.openTerminal": "Ouvrir le terminal",
  "decisions.openTerminalTip": "Affiche le terminal de cette session, avec le focus sur l’invite",
  "decisions.dialogEsc": "Échap : {effect}",
  "decisions.dialogEscTip": "Envoie Échap à l’invite (3)",
  "decisions.escExits": "l’agent se ferme",
  "decisions.escCancels": "l’annulation propre à l’invite",
  "decisions.windowShort": "La fenêtre est trop basse pour afficher cette invite. Agrandissez la fenêtre en hauteur, puis répondez dans le terminal.",
};

export const pt = {
  "decisions.kindDialog": "pedido no terminal",
  "decisions.dialogWhy": "Responda a este pedido no terminal da sessão: este cartão não envia nenhuma das opções.",
  "decisions.openTerminal": "Abrir terminal",
  "decisions.openTerminalTip": "Mostra o terminal desta sessão, com o foco no pedido",
  "decisions.dialogEsc": "Esc: {effect}",
  "decisions.dialogEscTip": "Envia Esc ao pedido (3)",
  "decisions.escExits": "o agente sai",
  "decisions.escCancels": "o cancelamento do próprio pedido",
  "decisions.windowShort": "A janela é baixa demais para mostrar este pedido. Aumente a altura da janela e responda no terminal.",
};
