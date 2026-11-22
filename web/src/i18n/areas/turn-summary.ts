// Q5 (look 11-17): two English literals outside the catalogue. A chat turn's summary line ("Read 2 files, edited 1, used
// 1 other tool") and the model picker's failed-switch line. All eight languages. `.one`/`.other` follow the plural rule.
declare module '../index' {
  interface AreaKeys {
    'turnsum.read.one': true;
    'turnsum.read.other': true;
    'turnsum.edited.one': true;
    'turnsum.edited.other': true;
    'turnsum.edit.one': true;
    'turnsum.edit.other': true;
    'turnsum.searched.one': true;
    'turnsum.searched.other': true;
    'turnsum.ran.one': true;
    'turnsum.ran.other': true;
    'turnsum.denied.one': true;
    'turnsum.denied.other': true;
    'turnsum.asking.one': true;
    'turnsum.asking.other': true;
    'turnsum.askingCall.one': true;
    'turnsum.askingCall.other': true;
    'turnsum.task.one': true;
    'turnsum.task.other': true;
    'turnsum.other.one': true;
    'turnsum.other.other': true;
    'turnsum.join': true;
    'picker.switchFailed': true;
  }
}

export const en = {
  'turnsum.read.one': 'read {n} file',
  'turnsum.read.other': 'read {n} files',
  'turnsum.edited.one': 'edited {n} file',
  'turnsum.edited.other': 'edited {n} files',
  'turnsum.edit.one': '{n} edit',
  'turnsum.edit.other': '{n} edits',
  'turnsum.searched.one': 'searched {n} pattern',
  'turnsum.searched.other': 'searched {n} patterns',
  'turnsum.ran.one': 'ran {n} command',
  'turnsum.ran.other': 'ran {n} commands',
  'turnsum.denied.one': 'denied {n} command',
  'turnsum.denied.other': 'denied {n} commands',
  'turnsum.asking.one': '{n} command waiting for your answer',
  'turnsum.asking.other': '{n} commands waiting for your answer',
  'turnsum.askingCall.one': '{n} request waiting for your answer',
  'turnsum.askingCall.other': '{n} requests waiting for your answer',
  'turnsum.task.one': '{n} task',
  'turnsum.task.other': '{n} tasks',
  'turnsum.other.one': 'used {n} other tool',
  'turnsum.other.other': 'used {n} other tools',
  'turnsum.join': ', ',
  'picker.switchFailed': 'switch failed: check the terminal, press Esc, try again',
};

export const ko = {
  'turnsum.read.one': '파일 {n}개 읽음',
  'turnsum.read.other': '파일 {n}개 읽음',
  'turnsum.edited.one': '파일 {n}개 편집',
  'turnsum.edited.other': '파일 {n}개 편집',
  'turnsum.edit.one': '편집 {n}건',
  'turnsum.edit.other': '편집 {n}건',
  'turnsum.searched.one': '패턴 {n}개 검색',
  'turnsum.searched.other': '패턴 {n}개 검색',
  'turnsum.ran.one': '명령 {n}개 실행',
  'turnsum.ran.other': '명령 {n}개 실행',
  'turnsum.denied.one': '명령 {n}개 거부됨',
  'turnsum.denied.other': '명령 {n}개 거부됨',
  'turnsum.asking.one': '명령 {n}개가 답변을 기다림',
  'turnsum.asking.other': '명령 {n}개가 답변을 기다림',
  'turnsum.askingCall.one': '요청 {n}개가 답변을 기다림',
  'turnsum.askingCall.other': '요청 {n}개가 답변을 기다림',
  'turnsum.task.one': '작업 {n}개',
  'turnsum.task.other': '작업 {n}개',
  'turnsum.other.one': '다른 도구 {n}개 사용',
  'turnsum.other.other': '다른 도구 {n}개 사용',
  'turnsum.join': ', ',
  'picker.switchFailed': '전환하지 못했습니다. 터미널을 확인하고 Esc를 누른 뒤 다시 시도하세요.',
};

export const ja = {
  'turnsum.read.one': '{n} 件のファイルを読み取り',
  'turnsum.read.other': '{n} 件のファイルを読み取り',
  'turnsum.edited.one': '{n} 件のファイルを編集',
  'turnsum.edited.other': '{n} 件のファイルを編集',
  'turnsum.edit.one': '{n} 件の編集',
  'turnsum.edit.other': '{n} 件の編集',
  'turnsum.searched.one': '{n} 件のパターンを検索',
  'turnsum.searched.other': '{n} 件のパターンを検索',
  'turnsum.ran.one': '{n} 件のコマンドを実行',
  'turnsum.ran.other': '{n} 件のコマンドを実行',
  'turnsum.denied.one': '{n} 件のコマンドを拒否',
  'turnsum.denied.other': '{n} 件のコマンドを拒否',
  'turnsum.asking.one': '{n} 件のコマンドが回答待ち',
  'turnsum.asking.other': '{n} 件のコマンドが回答待ち',
  'turnsum.askingCall.one': '{n} 件の要求が回答待ち',
  'turnsum.askingCall.other': '{n} 件の要求が回答待ち',
  'turnsum.task.one': '{n} 件のタスク',
  'turnsum.task.other': '{n} 件のタスク',
  'turnsum.other.one': 'ほかのツールを {n} 件使用',
  'turnsum.other.other': 'ほかのツールを {n} 件使用',
  'turnsum.join': '、',
  'picker.switchFailed': '切り替えられませんでした。ターミナルを確認し、Esc を押してからもう一度試してください。',
};

export const zhHans = {
  'turnsum.read.one': '读取了 {n} 个文件',
  'turnsum.read.other': '读取了 {n} 个文件',
  'turnsum.edited.one': '编辑了 {n} 个文件',
  'turnsum.edited.other': '编辑了 {n} 个文件',
  'turnsum.edit.one': '{n} 处编辑',
  'turnsum.edit.other': '{n} 处编辑',
  'turnsum.searched.one': '搜索了 {n} 个模式',
  'turnsum.searched.other': '搜索了 {n} 个模式',
  'turnsum.ran.one': '运行了 {n} 条命令',
  'turnsum.ran.other': '运行了 {n} 条命令',
  'turnsum.denied.one': '拒绝了 {n} 条命令',
  'turnsum.denied.other': '拒绝了 {n} 条命令',
  'turnsum.asking.one': '{n} 条命令在等待你的回答',
  'turnsum.asking.other': '{n} 条命令在等待你的回答',
  'turnsum.askingCall.one': '{n} 个请求在等待你的回答',
  'turnsum.askingCall.other': '{n} 个请求在等待你的回答',
  'turnsum.task.one': '{n} 个任务',
  'turnsum.task.other': '{n} 个任务',
  'turnsum.other.one': '使用了 {n} 个其他工具',
  'turnsum.other.other': '使用了 {n} 个其他工具',
  'turnsum.join': '，',
  'picker.switchFailed': '切换失败：请检查终端，按 Esc 后重试',
};

export const zhHant = {
  'turnsum.read.one': '讀取了 {n} 個檔案',
  'turnsum.read.other': '讀取了 {n} 個檔案',
  'turnsum.edited.one': '編輯了 {n} 個檔案',
  'turnsum.edited.other': '編輯了 {n} 個檔案',
  'turnsum.edit.one': '{n} 處編輯',
  'turnsum.edit.other': '{n} 處編輯',
  'turnsum.searched.one': '搜尋了 {n} 個模式',
  'turnsum.searched.other': '搜尋了 {n} 個模式',
  'turnsum.ran.one': '執行了 {n} 個指令',
  'turnsum.ran.other': '執行了 {n} 個指令',
  'turnsum.denied.one': '拒絕了 {n} 個指令',
  'turnsum.denied.other': '拒絕了 {n} 個指令',
  'turnsum.asking.one': '{n} 個指令在等待你的回答',
  'turnsum.asking.other': '{n} 個指令在等待你的回答',
  'turnsum.askingCall.one': '{n} 個請求在等待你的回答',
  'turnsum.askingCall.other': '{n} 個請求在等待你的回答',
  'turnsum.task.one': '{n} 個任務',
  'turnsum.task.other': '{n} 個任務',
  'turnsum.other.one': '使用了 {n} 個其他工具',
  'turnsum.other.other': '使用了 {n} 個其他工具',
  'turnsum.join': '，',
  'picker.switchFailed': '切換失敗：請檢查終端，按 Esc 後重試',
};

export const es = {
  'turnsum.read.one': 'leyó {n} archivo',
  'turnsum.read.other': 'leyó {n} archivos',
  'turnsum.edited.one': 'editó {n} archivo',
  'turnsum.edited.other': 'editó {n} archivos',
  'turnsum.edit.one': '{n} edición',
  'turnsum.edit.other': '{n} ediciones',
  'turnsum.searched.one': 'buscó {n} patrón',
  'turnsum.searched.other': 'buscó {n} patrones',
  'turnsum.ran.one': 'ejecutó {n} comando',
  'turnsum.ran.other': 'ejecutó {n} comandos',
  'turnsum.denied.one': 'denegó {n} comando',
  'turnsum.denied.other': 'denegó {n} comandos',
  'turnsum.asking.one': '{n} comando espera tu respuesta',
  'turnsum.asking.other': '{n} comandos esperan tu respuesta',
  'turnsum.askingCall.one': '{n} solicitud espera tu respuesta',
  'turnsum.askingCall.other': '{n} solicitudes esperan tu respuesta',
  'turnsum.task.one': '{n} tarea',
  'turnsum.task.other': '{n} tareas',
  'turnsum.other.one': 'usó {n} herramienta más',
  'turnsum.other.other': 'usó {n} herramientas más',
  'turnsum.join': ', ',
  'picker.switchFailed': 'No se pudo cambiar: revisa el terminal, pulsa Esc y vuelve a intentarlo',
};

export const fr = {
  'turnsum.read.one': 'a lu {n} fichier',
  'turnsum.read.other': 'a lu {n} fichiers',
  'turnsum.edited.one': 'a modifié {n} fichier',
  'turnsum.edited.other': 'a modifié {n} fichiers',
  'turnsum.edit.one': '{n} modification',
  'turnsum.edit.other': '{n} modifications',
  'turnsum.searched.one': 'a cherché {n} motif',
  'turnsum.searched.other': 'a cherché {n} motifs',
  'turnsum.ran.one': 'a lancé {n} commande',
  'turnsum.ran.other': 'a lancé {n} commandes',
  'turnsum.denied.one': 'a refusé {n} commande',
  'turnsum.denied.other': 'a refusé {n} commandes',
  'turnsum.asking.one': '{n} commande attend votre réponse',
  'turnsum.asking.other': '{n} commandes attendent votre réponse',
  'turnsum.askingCall.one': '{n} demande attend votre réponse',
  'turnsum.askingCall.other': '{n} demandes attendent votre réponse',
  'turnsum.task.one': '{n} tâche',
  'turnsum.task.other': '{n} tâches',
  'turnsum.other.one': 'a utilisé {n} autre outil',
  'turnsum.other.other': 'a utilisé {n} autres outils',
  'turnsum.join': ', ',
  'picker.switchFailed': "Échec du changement : vérifiez le terminal, appuyez sur Échap, puis réessayez",
};

export const pt = {
  'turnsum.read.one': 'leu {n} arquivo',
  'turnsum.read.other': 'leu {n} arquivos',
  'turnsum.edited.one': 'editou {n} arquivo',
  'turnsum.edited.other': 'editou {n} arquivos',
  'turnsum.edit.one': '{n} edição',
  'turnsum.edit.other': '{n} edições',
  'turnsum.searched.one': 'buscou {n} padrão',
  'turnsum.searched.other': 'buscou {n} padrões',
  'turnsum.ran.one': 'executou {n} comando',
  'turnsum.ran.other': 'executou {n} comandos',
  'turnsum.denied.one': 'negou {n} comando',
  'turnsum.denied.other': 'negou {n} comandos',
  'turnsum.asking.one': '{n} comando aguarda sua resposta',
  'turnsum.asking.other': '{n} comandos aguardam sua resposta',
  'turnsum.askingCall.one': '{n} pedido aguarda sua resposta',
  'turnsum.askingCall.other': '{n} pedidos aguardam sua resposta',
  'turnsum.task.one': '{n} tarefa',
  'turnsum.task.other': '{n} tarefas',
  'turnsum.other.one': 'usou mais {n} ferramenta',
  'turnsum.other.other': 'usou mais {n} ferramentas',
  'turnsum.join': ', ',
  'picker.switchFailed': 'Falha ao trocar: verifique o terminal, pressione Esc e tente de novo',
};
