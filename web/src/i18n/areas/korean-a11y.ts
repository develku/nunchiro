// Lane korean-a11y-1115 (first-use walks 9 and 10): English literals a Korean window still showed or spoke.
// Ticket 790: the answer strip's kind chip and the board, finished and failed notifications. Ticket 811: a resize handle
// next to a split of zones. Ticket 812: a key chip's spoken key names. Ticket 880: a folder the app may not read.
// Ticket 830: the room's lost card with no live seat.
declare module '../index' {
  interface AreaKeys {
    'a11y.chip.permission': true;
    'a11y.chip.question': true;
    'a11y.chip.dialog': true;
    'a11y.chip.background': true;
    'a11y.chip.stale': true;
    'a11y.chip.board': true;
    'a11y.chip.owner': true;
    'a11y.note.board': true;
    'a11y.note.finishedTitle': true;
    'a11y.note.finished': true;
    'a11y.note.failedTitle': true;
    'a11y.note.failed': true;
    'a11y.layout.group': true;
    'a11y.key.Control': true;
    'a11y.key.Alt': true;
    'a11y.key.Shift': true;
    'a11y.key.Meta': true;
    'a11y.key.Space': true;
    'a11y.key.Comma': true;
    'a11y.key.Period': true;
    'a11y.key.Slash': true;
    'a11y.key.Equal': true;
    'a11y.key.Minus': true;
    'a11y.key.Enter': true;
    'a11y.key.Escape': true;
    'a11y.key.Tab': true;
    'a11y.key.then': true;
    'a11y.err.noAccess': true;
    'a11y.err.noAccess.todo': true;
    'a11y.room.lostNew': true;
  }
}

export const en = {
  'a11y.chip.permission': 'permission',
  'a11y.chip.question': 'question',
  'a11y.chip.dialog': 'folder trust',
  'a11y.chip.background': 'task',
  'a11y.chip.stale': 'stale',
  'a11y.chip.board': 'board',
  'a11y.chip.owner': 'needs you',
  'a11y.note.board': 'Board decision',
  'a11y.note.finishedTitle': '{name} · finished',
  'a11y.note.finished': '{name} finished',
  'a11y.note.failedTitle': '{name} · failed',
  'a11y.note.failed': '{name} failed',
  'a11y.layout.group': 'zone group',
  'a11y.key.Control': 'Control',
  'a11y.key.Alt': 'Option',
  'a11y.key.Shift': 'Shift',
  'a11y.key.Meta': 'Command',
  'a11y.key.Space': 'Space',
  'a11y.key.Comma': 'comma',
  'a11y.key.Period': 'period',
  'a11y.key.Slash': 'slash',
  'a11y.key.Equal': 'equals',
  'a11y.key.Minus': 'minus',
  'a11y.key.Enter': 'Enter',
  'a11y.key.Escape': 'Escape',
  'a11y.key.Tab': 'Tab',
  'a11y.key.then': '{first}, then {next}',
  'a11y.err.noAccess': 'Nunchiro may not read that folder.',
  'a11y.err.noAccess.todo': 'If the folder is on an external drive, go to System Settings > Files and Folders > Removable Volumes and allow Nunchiro. Then add the folder again.',
  'a11y.room.lostNew': 'Start a new session in this project',
};

export const ko = {
  'a11y.chip.permission': '권한',
  'a11y.chip.question': '질문',
  'a11y.chip.dialog': '폴더 신뢰',
  'a11y.chip.background': '작업',
  'a11y.chip.stale': '멈춤',
  'a11y.chip.board': '보드',
  'a11y.chip.owner': '내 답 대기',
  'a11y.note.board': '보드 결정',
  'a11y.note.finishedTitle': '{name} · 완료',
  'a11y.note.finished': '{name} 완료',
  'a11y.note.failedTitle': '{name} · 실패',
  'a11y.note.failed': '{name} 실패',
  'a11y.layout.group': '영역 묶음',
  'a11y.key.Control': '컨트롤',
  'a11y.key.Alt': '옵션',
  'a11y.key.Shift': '시프트',
  'a11y.key.Meta': '커맨드',
  'a11y.key.Space': '스페이스',
  'a11y.key.Comma': '쉼표',
  'a11y.key.Period': '마침표',
  'a11y.key.Slash': '슬래시',
  'a11y.key.Equal': '등호',
  'a11y.key.Minus': '빼기',
  'a11y.key.Enter': '엔터',
  'a11y.key.Escape': '이스케이프',
  'a11y.key.Tab': '탭',
  'a11y.key.then': '{first}, 다음 {next}',
  'a11y.err.noAccess': 'Nunchiro가 그 폴더를 읽을 권한이 없습니다.',
  'a11y.err.noAccess.todo': '외장 드라이브에 있다면 시스템 설정의 파일 및 폴더 > 이동식 볼륨에서 Nunchiro를 허용한 뒤 다시 추가하세요.',
  'a11y.room.lostNew': '이 프로젝트에서 새 세션 시작',
};

export const ja = {
  'a11y.chip.permission': '許可',
  'a11y.chip.question': '質問',
  'a11y.chip.dialog': "フォルダーの信頼確認",
  'a11y.chip.background': 'タスク',
  'a11y.chip.stale': '停滞',
  'a11y.chip.board': 'ボード',
  'a11y.chip.owner': '要対応',
  'a11y.note.board': 'ボードの判断',
  'a11y.note.finishedTitle': '{name} · 完了',
  'a11y.note.finished': '{name} が完了しました',
  'a11y.note.failedTitle': '{name} · 失敗',
  'a11y.note.failed': '{name} が失敗しました',
  'a11y.layout.group': 'ゾーンのまとまり',
  'a11y.key.Control': 'コントロール',
  'a11y.key.Alt': 'オプション',
  'a11y.key.Shift': 'シフト',
  'a11y.key.Meta': 'コマンド',
  'a11y.key.Space': 'スペース',
  'a11y.key.Comma': 'カンマ',
  'a11y.key.Period': 'ピリオド',
  'a11y.key.Slash': 'スラッシュ',
  'a11y.key.Equal': 'イコール',
  'a11y.key.Minus': 'マイナス',
  'a11y.key.Enter': 'エンター',
  'a11y.key.Escape': 'エスケープ',
  'a11y.key.Tab': 'タブ',
  'a11y.key.then': '{first}、次に {next}',
  'a11y.err.noAccess': "Nunchiro はそのフォルダーを読み取れない可能性があります。",
  'a11y.err.noAccess.todo': '外部ドライブにある場合は、システム設定のファイルとフォルダー > リムーバブルボリュームで Nunchiro を許可してから、もう一度追加してください。',
  'a11y.room.lostNew': 'このプロジェクトで新しいセッションを始める',
};

export const zhHans = {
  'a11y.chip.permission': '权限',
  'a11y.chip.question': '问题',
  'a11y.chip.dialog': '文件夹信任',
  'a11y.chip.background': '任务',
  'a11y.chip.stale': '停滞',
  'a11y.chip.board': '看板',
  'a11y.chip.owner': '需要你处理',
  'a11y.note.board': '看板决策',
  'a11y.note.finishedTitle': '{name} · 已完成',
  'a11y.note.finished': '{name} 已完成',
  'a11y.note.failedTitle': '{name} · 失败',
  'a11y.note.failed': '{name} 失败',
  'a11y.layout.group': '区域组',
  'a11y.key.Control': 'Control 键',
  'a11y.key.Alt': 'Option 键',
  'a11y.key.Shift': 'Shift 键',
  'a11y.key.Meta': 'Command 键',
  'a11y.key.Space': '空格',
  'a11y.key.Comma': '逗号',
  'a11y.key.Period': '句号',
  'a11y.key.Slash': '斜杠',
  'a11y.key.Equal': '等号',
  'a11y.key.Minus': '减号',
  'a11y.key.Enter': '回车',
  'a11y.key.Escape': 'Esc 键',
  'a11y.key.Tab': 'Tab 键',
  'a11y.key.then': '{first}，然后 {next}',
  'a11y.err.noAccess': 'Nunchiro 无权读取该文件夹。',
  'a11y.err.noAccess.todo': '如果它在外置驱动器上，请在系统设置的“文件和文件夹” > 可移除的宗卷中允许 Nunchiro，然后重新添加。',
  'a11y.room.lostNew': '在此项目中开始新会话',
};

export const zhHant = {
  'a11y.chip.permission': '權限',
  'a11y.chip.question': '問題',
  'a11y.chip.dialog': "資料夾信任",
  'a11y.chip.background': '工作',
  'a11y.chip.stale': '停滯',
  'a11y.chip.board': '看板',
  'a11y.chip.owner': '需要你處理',
  'a11y.note.board': '看板決策',
  'a11y.note.finishedTitle': '{name} · 已完成',
  'a11y.note.finished': '{name} 已完成',
  'a11y.note.failedTitle': '{name} · 失敗',
  'a11y.note.failed': '{name} 失敗',
  'a11y.layout.group': "區域群組",
  'a11y.key.Control': '控制鍵',
  'a11y.key.Alt': '選項鍵',
  'a11y.key.Shift': '上檔鍵',
  'a11y.key.Meta': '指令鍵',
  'a11y.key.Space': '空白鍵',
  'a11y.key.Comma': '逗號',
  'a11y.key.Period': '句號',
  'a11y.key.Slash': '斜線',
  'a11y.key.Equal': '等號',
  'a11y.key.Minus': '減號',
  'a11y.key.Enter': '輸入鍵',
  'a11y.key.Escape': '跳出鍵',
  'a11y.key.Tab': '定位鍵',
  'a11y.key.then': '{first}，然後 {next}',
  'a11y.err.noAccess': "Nunchiro 無權讀取該資料夾。",
  'a11y.err.noAccess.todo': "若該資料夾在外接磁碟上，請在「系統設定」>「檔案和檔案夾」>「可卸除式卷宗」中允許 Nunchiro，然後再次加入該資料夾。",
  'a11y.room.lostNew': '在此專案中開始新工作階段',
};

export const es = {
  'a11y.chip.permission': 'permiso',
  'a11y.chip.question': 'pregunta',
  'a11y.chip.dialog': 'confianza de carpeta',
  'a11y.chip.background': 'tarea',
  'a11y.chip.stale': 'estancada',
  'a11y.chip.board': 'tablero',
  'a11y.chip.owner': 'te necesita',
  'a11y.note.board': 'Decisión del tablero',
  'a11y.note.finishedTitle': '{name} · terminado',
  'a11y.note.finished': '{name} terminó',
  'a11y.note.failedTitle': '{name} · falló',
  'a11y.note.failed': '{name} falló',
  'a11y.layout.group': 'grupo de zonas',
  'a11y.key.Control': 'Control',
  'a11y.key.Alt': 'Opción',
  'a11y.key.Shift': 'Mayúsculas',
  'a11y.key.Meta': 'Comando',
  'a11y.key.Space': 'Espacio',
  'a11y.key.Comma': 'coma',
  'a11y.key.Period': 'punto',
  'a11y.key.Slash': 'barra',
  'a11y.key.Equal': 'igual',
  'a11y.key.Minus': 'menos',
  'a11y.key.Enter': 'Intro',
  'a11y.key.Escape': 'Escape',
  'a11y.key.Tab': 'Tabulador',
  'a11y.key.then': '{first}, luego {next}',
  'a11y.err.noAccess': 'Nunchiro no puede leer esa carpeta.',
  'a11y.err.noAccess.todo': 'Si está en un disco externo, permite a Nunchiro en Ajustes del Sistema, en Archivos y carpetas > Volúmenes extraíbles, y vuelve a añadirla.',
  'a11y.room.lostNew': 'Iniciar una sesión nueva en este proyecto',
};

export const fr = {
  'a11y.chip.permission': 'autorisation',
  'a11y.chip.question': 'question',
  'a11y.chip.dialog': 'confiance du dossier',
  'a11y.chip.background': 'tâche',
  'a11y.chip.stale': 'immobile',
  'a11y.chip.board': 'tableau',
  'a11y.chip.owner': 'vous attend',
  'a11y.note.board': 'Décision du tableau',
  'a11y.note.finishedTitle': '{name} · terminé',
  'a11y.note.finished': '{name} a terminé',
  'a11y.note.failedTitle': '{name} · échec',
  'a11y.note.failed': '{name} a échoué',
  'a11y.layout.group': 'groupe de zones',
  'a11y.key.Control': 'Contrôle',
  'a11y.key.Alt': 'Option',
  'a11y.key.Shift': 'Maj',
  'a11y.key.Meta': 'Commande',
  'a11y.key.Space': 'Espace',
  'a11y.key.Comma': 'virgule',
  'a11y.key.Period': 'point',
  'a11y.key.Slash': 'barre oblique',
  'a11y.key.Equal': 'égal',
  'a11y.key.Minus': 'moins',
  'a11y.key.Enter': 'Entrée',
  'a11y.key.Escape': 'Échap',
  'a11y.key.Tab': 'Tabulation',
  'a11y.key.then': '{first}, puis {next}',
  'a11y.err.noAccess': 'Nunchiro n’a pas le droit de lire ce dossier.',
  'a11y.err.noAccess.todo': 'S’il est sur un disque externe, autorisez Nunchiro dans Réglages Système, sous Fichiers et dossiers > Volumes amovibles, puis ajoutez-le de nouveau.',
  'a11y.room.lostNew': 'Démarrer une nouvelle session dans ce projet',
};

export const pt = {
  'a11y.chip.permission': 'permissão',
  'a11y.chip.question': 'pergunta',
  'a11y.chip.dialog': 'confiança da pasta',
  'a11y.chip.background': 'tarefa',
  'a11y.chip.stale': 'parado',
  'a11y.chip.board': 'quadro',
  'a11y.chip.owner': 'precisa de você',
  'a11y.note.board': 'Decisão do quadro',
  'a11y.note.finishedTitle': '{name} · concluído',
  'a11y.note.finished': '{name} concluiu',
  'a11y.note.failedTitle': '{name} · falhou',
  'a11y.note.failed': '{name} falhou',
  'a11y.layout.group': 'grupo de zonas',
  'a11y.key.Control': 'Control',
  'a11y.key.Alt': 'Option',
  'a11y.key.Shift': 'Shift',
  'a11y.key.Meta': 'Command',
  'a11y.key.Space': 'Espaço',
  'a11y.key.Comma': 'vírgula',
  'a11y.key.Period': 'ponto',
  'a11y.key.Slash': 'barra',
  'a11y.key.Equal': 'igual',
  'a11y.key.Minus': 'menos',
  'a11y.key.Enter': 'Enter',
  'a11y.key.Escape': 'Esc',
  'a11y.key.Tab': 'Tab',
  'a11y.key.then': '{first}, depois {next}',
  'a11y.err.noAccess': 'O Nunchiro não tem permissão para ler essa pasta.',
  'a11y.err.noAccess.todo': 'Se ela estiver em um disco externo, permita o Nunchiro em Ajustes do Sistema, em Arquivos e Pastas > Volumes Removíveis, e adicione-a de novo.',
  'a11y.room.lostNew': 'Iniciar uma nova sessão neste projeto',
};
