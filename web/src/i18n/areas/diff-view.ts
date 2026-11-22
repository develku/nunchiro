// Ticket 374: the stacked Diff (every file in one view, collapse) and the note on a diff line.
declare module '../index' {
  interface AreaKeys {
    'diffview.collapseAll': true;
    'diffview.expandAll': true;
    'diffview.collapse': true;
    'diffview.expand': true;
    'diffview.collapsed': true;
    'diffview.note': true;
    'diffview.noteField': true;
    'diffview.noteHint': true;
    'diffview.noteOff': true;
  }
}

export const en = {
  'diffview.collapseAll': 'Collapse all',
  'diffview.expandAll': 'Expand all',
  'diffview.collapse': 'Collapse {path}',
  'diffview.expand': 'Expand {path}',
  'diffview.collapsed': 'collapsed',
  'diffview.note': 'Note on line {n}',
  'diffview.noteField': 'Note on {path} line {n}',
  'diffview.noteHint': 'Enter or ⌘Enter adds · Esc cancels',
  'diffview.noteOff': 'Notes can be added only while the agent is running.',
};
export const ko = {
  'diffview.collapseAll': '모두 접기',
  'diffview.expandAll': '모두 펼치기',
  'diffview.collapse': '{path} 접기',
  'diffview.expand': '{path} 펼치기',
  'diffview.collapsed': '접힘',
  'diffview.note': '{n}번 줄에 메모',
  'diffview.noteField': '{path} {n}번 줄 메모',
  'diffview.noteHint': 'Enter 또는 ⌘Enter 추가 · Esc 취소',
  'diffview.noteOff': '에이전트가 실행 중일 때만 메모를 넣을 수 있습니다.',
};
export const ja = {
  'diffview.collapseAll': 'すべて折りたたむ',
  'diffview.expandAll': 'すべて展開',
  'diffview.collapse': '{path} を折りたたむ',
  'diffview.expand': '{path} を展開',
  'diffview.collapsed': '折りたたみ中',
  'diffview.note': '{n} 行目にメモ',
  'diffview.noteField': '{path} の {n} 行目のメモ',
  'diffview.noteHint': 'Enter または ⌘Enter で追加 · Esc で取り消し',
  'diffview.noteOff': 'メモはエージェントの実行中にだけ追加できます。',
};
export const zhHans = {
  'diffview.collapseAll': '全部折叠',
  'diffview.expandAll': '全部展开',
  'diffview.collapse': '折叠 {path}',
  'diffview.expand': '展开 {path}',
  'diffview.collapsed': '已折叠',
  'diffview.note': '在第 {n} 行添加备注',
  'diffview.noteField': '{path} 第 {n} 行的备注',
  'diffview.noteHint': 'Enter 或 ⌘Enter 添加 · Esc 取消',
  'diffview.noteOff': '只有代理运行时才能添加备注。',
};
export const zhHant = {
  'diffview.collapseAll': '全部收合',
  'diffview.expandAll': '全部展開',
  'diffview.collapse': '收合 {path}',
  'diffview.expand': '展開 {path}',
  'diffview.collapsed': '已收合',
  'diffview.note': '在第 {n} 行加上備註',
  'diffview.noteField': '{path} 第 {n} 行的備註',
  'diffview.noteHint': 'Enter 或 ⌘Enter 加入 · Esc 取消',
  'diffview.noteOff': '只有代理執行時才能加上備註。',
};
export const es = {
  'diffview.collapseAll': 'Contraer todo',
  'diffview.expandAll': 'Expandir todo',
  'diffview.collapse': 'Contraer {path}',
  'diffview.expand': 'Expandir {path}',
  'diffview.collapsed': 'contraído',
  'diffview.note': 'Nota en la línea {n}',
  'diffview.noteField': 'Nota en {path}, línea {n}',
  'diffview.noteHint': 'Enter o ⌘Enter añade · Esc cancela',
  'diffview.noteOff': 'Solo se pueden añadir notas mientras el agente se ejecuta.',
};
export const fr = {
  'diffview.collapseAll': 'Tout replier',
  'diffview.expandAll': 'Tout déplier',
  'diffview.collapse': 'Replier {path}',
  'diffview.expand': 'Déplier {path}',
  'diffview.collapsed': 'replié',
  'diffview.note': 'Note sur la ligne {n}',
  'diffview.noteField': 'Note sur {path}, ligne {n}',
  'diffview.noteHint': 'Entrée ou ⌘Entrée ajoute · Échap annule',
  'diffview.noteOff': 'Les notes ne peuvent être ajoutées que pendant que l’agent tourne.',
};
export const pt = {
  'diffview.collapseAll': 'Recolher tudo',
  'diffview.expandAll': 'Expandir tudo',
  'diffview.collapse': 'Recolher {path}',
  'diffview.expand': 'Expandir {path}',
  'diffview.collapsed': 'recolhido',
  'diffview.note': 'Nota na linha {n}',
  'diffview.noteField': 'Nota em {path}, linha {n}',
  'diffview.noteHint': 'Enter ou ⌘Enter adiciona · Esc cancela',
  'diffview.noteOff': 'Só é possível adicionar notas enquanto o agente está em execução.',
};
