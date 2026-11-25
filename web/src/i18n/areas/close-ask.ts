// Ticket 338: the General row and the one question when closing a running session's tab. All eight languages.
declare module '../index' {
  interface AreaKeys {
    'closeAsk.row': true;
    'closeAsk.rowDesc': true;
    'field.confirmCloseRunning': true;
    'closeAsk.title': true;
    'closeAsk.text': true;
    'closeAsk.keep': true;
    'closeAsk.close': true;
  }
}

export const en = {
  'closeAsk.row': 'Ask before closing a running session tab',
  'closeAsk.rowDesc': 'Closing the tab of a running session with {key} or its close button asks once.',
  'field.confirmCloseRunning': 'Ask before closing a running session tab',
  'closeAsk.title': "Close the '{name}' tab?",
  'closeAsk.text': 'The session keeps running. You can open its tab again.',
  'closeAsk.keep': 'Keep tab',
  'closeAsk.close': 'Close tab',
};
export const ko = {
  'closeAsk.row': '실행 중인 세션 탭을 닫기 전에 묻기',
  'closeAsk.rowDesc': '실행 중인 세션의 탭을 {key}나 닫기 버튼으로 닫으면 한 번 확인합니다.',
  'field.confirmCloseRunning': '실행 중인 세션 탭을 닫기 전에 묻기',
  'closeAsk.title': "‘{name}’ 탭을 닫으시겠습니까?",
  'closeAsk.text': '세션은 계속 실행됩니다. 탭은 다시 열 수 있습니다.',
  'closeAsk.keep': '탭 유지',
  'closeAsk.close': '탭 닫기',
};
export const ja = {
  'closeAsk.row': '実行中のセッションタブを閉じる前に確認',
  'closeAsk.rowDesc': '実行中のセッションのタブを {key} や閉じるボタンで閉じるときに一度確認します。',
  'field.confirmCloseRunning': '実行中のセッションタブを閉じる前に確認',
  'closeAsk.title': '「{name}」タブを閉じますか？',
  'closeAsk.text': 'セッションは実行を続けます。タブはもう一度開けます。',
  'closeAsk.keep': 'タブを残す',
  'closeAsk.close': 'タブを閉じる',
};
export const zhHans = {
  'closeAsk.row': "关闭运行中的会话选项卡前询问",
  'closeAsk.rowDesc': "用 {key} 或关闭按钮关闭运行中会话的选项卡时询问一次。",
  'field.confirmCloseRunning': '关闭运行中的会话选项卡前询问',
  'closeAsk.title': "关闭“{name}”选项卡？",
  'closeAsk.text': "会话会继续运行。选项卡可以重新打开。",
  'closeAsk.keep': "保留选项卡",
  'closeAsk.close': "关闭选项卡",
};
export const zhHant = {
  'closeAsk.row': "關閉執行中的工作階段選項卡前詢問",
  'closeAsk.rowDesc': '用 {key} 或關閉按鈕關閉執行中工作階段的選項卡時詢問一次。',
  'field.confirmCloseRunning': '關閉執行中的工作階段選項卡前詢問',
  'closeAsk.title': "關閉「{name}」選項卡？",
  'closeAsk.text': '工作階段會繼續執行。可以重新開啟它的選項卡。',
  'closeAsk.keep': '保留選項卡',
  'closeAsk.close': '關閉選項卡',
};
export const es = {
  'closeAsk.row': 'Preguntar antes de cerrar la pestaña de una sesión en ejecución',
  'closeAsk.rowDesc': 'Al cerrar la pestaña de una sesión en ejecución con {key} o con su botón de cierre, se pregunta una vez.',
  'field.confirmCloseRunning': 'Preguntar antes de cerrar la pestaña de una sesión en ejecución',
  'closeAsk.title': '¿Cerrar la pestaña “{name}”?',
  'closeAsk.text': 'La sesión sigue en ejecución. Puedes volver a abrir su pestaña.',
  'closeAsk.keep': 'Mantener pestaña',
  'closeAsk.close': 'Cerrar pestaña',
};
export const fr = {
  'closeAsk.row': "Demander avant de fermer l’onglet d’une session en cours",
  'closeAsk.rowDesc': "Fermer l’onglet d’une session en cours ({key} ou son bouton) demande confirmation une fois.",
  'field.confirmCloseRunning': "Demander avant de fermer l’onglet d’une session en cours",
  'closeAsk.title': "Fermer l’onglet « {name} » ?",
  'closeAsk.text': 'La session continue de tourner. Vous pouvez rouvrir son onglet.',
  'closeAsk.keep': "Garder l’onglet",
  'closeAsk.close': "Fermer l’onglet",
};
export const pt = {
  'closeAsk.row': "Perguntar antes de fechar a aba de uma sessão em execução",
  'closeAsk.rowDesc': "Ao fechar a aba de uma sessão em execução com {key} ou pelo botão de fechar, o Nunchiro pergunta uma vez.",
  'field.confirmCloseRunning': "Perguntar antes de fechar a aba de uma sessão em execução",
  'closeAsk.title': "Fechar a aba “{name}”?",
  'closeAsk.text': "A sessão continua em execução. Você pode abrir a aba de novo.",
  'closeAsk.keep': "Manter aba",
  'closeAsk.close': "Fechar aba",
};
