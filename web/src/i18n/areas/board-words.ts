// Ticket 871: the default board columns in the window's language (shown while a column keeps its stored English title).
// Ticket 872: the Settings › Layout switch for script widgets, its search words, and the off note's button to it.
declare module '../index' {
  interface AreaKeys {
    'board.default.todo': true;
    'board.default.working': true;
    'board.default.needsDecision': true;
    'board.default.review': true;
    'board.default.done': true;
    'settings.section.widgets': true;
    'settings.row.scriptWidgets': true;
    'settings.row.scriptWidgetsDesc': true;
    'field.scriptWidgets': true;
    'rest.widgets.openSetting': true;
  }
}

export const en = {
  'board.default.todo': 'To do',
  'board.default.working': 'Working',
  'board.default.needsDecision': 'Needs decision',
  'board.default.review': 'Review',
  'board.default.done': 'Done',
  'settings.section.widgets': 'Widgets',
  'settings.row.scriptWidgets': 'Script widgets',
  'settings.row.scriptWidgetsDesc': 'An agent can make a script widget. It runs a command and shows the output. When this is on, each widget runs in a sandbox, only after you approve it. A changed widget needs approval again. This is off by default.',
  'field.scriptWidgets': 'Script widgets',
  'rest.widgets.openSetting': 'Open setting',
};
export const ko = {
  'board.default.todo': '할 일',
  'board.default.working': '작업 중',
  'board.default.needsDecision': '결정 필요',
  'board.default.review': '검토',
  'board.default.done': '완료',
  'settings.section.widgets': '위젯',
  'settings.row.scriptWidgets': '스크립트 위젯',
  'settings.row.scriptWidgetsDesc': '에이전트가 만든 스크립트 위젯이 샌드박스 안에서 명령을 실행합니다. 각 위젯은 승인한 뒤에만 실행되고, 바뀌면 다시 묻습니다. 기본값은 꺼짐입니다.',
  'field.scriptWidgets': '스크립트 위젯',
  'rest.widgets.openSetting': '설정 열기',
};
export const ja = {
  'board.default.todo': 'やること',
  'board.default.working': '作業中',
  'board.default.needsDecision': '要判断',
  'board.default.review': 'レビュー',
  'board.default.done': '完了',
  'settings.section.widgets': 'ウィジェット',
  'settings.row.scriptWidgets': 'スクリプトウィジェット',
  'settings.row.scriptWidgetsDesc': 'エージェントはスクリプトウィジェットを作れます。コマンドを実行して、その出力を表示するウィジェットです。オンにすると、各ウィジェットは承認後にだけサンドボックス内で実行されます。変更されたウィジェットは再度承認が必要です。デフォルトはオフです。',
  'field.scriptWidgets': 'スクリプトウィジェット',
  'rest.widgets.openSetting': '設定を開く',
};
export const zhHans = {
  'board.default.todo': '待办',
  'board.default.working': '进行中',
  'board.default.needsDecision': '待决策',
  'board.default.review': '审查',
  'board.default.done': '已完成',
  'settings.section.widgets': '小组件',
  'settings.row.scriptWidgets': '脚本小组件',
  'settings.row.scriptWidgetsDesc': '让代理制作的脚本小组件在沙盒中运行其命令。每个小组件仅在你批准后运行，更改后会再次询问。默认关闭。',
  'field.scriptWidgets': '脚本小组件',
  'rest.widgets.openSetting': '打开设置',
};
export const zhHant = {
  'board.default.todo': '待辦',
  'board.default.working': '進行中',
  'board.default.needsDecision': '需要決策',
  'board.default.review': '審查',
  'board.default.done': '已完成',
  'settings.section.widgets': '小工具',
  'settings.row.scriptWidgets': '指令碼小工具',
  'settings.row.scriptWidgetsDesc': '讓代理製作的指令碼小工具在沙箱中執行其指令。每個小工具僅在你核准後執行，變更後會再次詢問。預設關閉。',
  'field.scriptWidgets': '指令碼小工具',
  'rest.widgets.openSetting': '開啟設定',
};
export const es = {
  'board.default.todo': 'Por hacer',
  'board.default.working': 'En curso',
  'board.default.needsDecision': 'Requiere decisión',
  'board.default.review': 'Revisión',
  'board.default.done': 'Hecho',
  'settings.section.widgets': 'Widgets',
  'settings.row.scriptWidgets': 'Widgets de script',
  'settings.row.scriptWidgetsDesc': 'Permite que los widgets de script que crean los agentes ejecuten su comando en un sandbox. Cada widget solo se ejecuta después de que lo apruebes y vuelve a preguntar si cambia. Desactivado por defecto.',
  'field.scriptWidgets': 'Widgets de script',
  'rest.widgets.openSetting': 'Abrir ajuste',
};
export const fr = {
  'board.default.todo': 'À faire',
  'board.default.working': 'En cours',
  'board.default.needsDecision': 'Décision requise',
  'board.default.review': 'Relecture',
  'board.default.done': 'Terminé',
  'settings.section.widgets': 'Widgets',
  'settings.row.scriptWidgets': 'Widgets de script',
  'settings.row.scriptWidgetsDesc': 'Permet aux widgets de script créés par les agents d’exécuter leur commande dans un bac à sable. Chaque widget ne s’exécute qu’après votre approbation et redemande s’il change. Désactivé par défaut.',
  'field.scriptWidgets': 'Widgets de script',
  'rest.widgets.openSetting': 'Ouvrir le réglage',
};
export const pt = {
  'board.default.todo': 'A fazer',
  'board.default.working': 'Em andamento',
  'board.default.needsDecision': 'Precisa de decisão',
  'board.default.review': 'Revisão',
  'board.default.done': 'Concluído',
  'settings.section.widgets': 'Widgets',
  'settings.row.scriptWidgets': 'Widgets de script',
  'settings.row.scriptWidgetsDesc': 'Permite que widgets de script criados por agentes executem seu comando em um sandbox. Cada widget só é executado depois que você o aprova e pergunta de novo se mudar. Desativado por padrão.',
  'field.scriptWidgets': 'Widgets de script',
  'rest.widgets.openSetting': 'Abrir configuração',
};
