// Real-app 11-10 defect 3: a turn that ran commands (a shell, a subagent, an MCP tool) may have changed files its
// list cannot name (the core's `files_partial`, chat/turn_files.rs); Turn files says so instead of "changed no files".
declare module '../index' {
  interface AreaKeys {
    'diff.scope.turnUnknown': true;
    'diff.scope.turnPartial': true;
    'diff.scope.showChanges': true;
  }
}

export const en = {
  'diff.scope.turnUnknown': 'Nunchiro cannot tell which files this turn changed, because it ran commands.',
  'diff.scope.turnPartial': 'This turn ran commands, so it may have changed files not listed here.',
  'diff.scope.showChanges': 'Show all changes',
};

export const ko = {
  'diff.scope.turnUnknown': "이 턴이 명령을 실행해서 어떤 파일을 바꿨는지 알 수 없습니다.",
  'diff.scope.turnPartial': "이 턴이 명령을 실행해서 여기에 없는 파일도 바꿨을 수 있습니다.",
  'diff.scope.showChanges': '모든 변경 보기',
};

export const ja = {
  'diff.scope.turnUnknown': 'このターンはコマンドを実行したため、どのファイルを変更したか分かりません。',
  'diff.scope.turnPartial': 'このターンはコマンドを実行したため、ここにないファイルも変更した可能性があります。',
  'diff.scope.showChanges': 'すべての変更を表示',
};

export const zhHans = {
  'diff.scope.turnUnknown': '这一轮运行了命令，无法判断它更改了哪些文件。',
  'diff.scope.turnPartial': '这一轮运行了命令，可能还更改了此处未列出的文件。',
  'diff.scope.showChanges': '显示全部更改',
};

export const zhHant = {
  'diff.scope.turnUnknown': '這一輪執行了指令，無法判斷它變更了哪些檔案。',
  'diff.scope.turnPartial': '這一輪執行了指令，可能還變更了此處未列出的檔案。',
  'diff.scope.showChanges': '顯示全部變更',
};

export const es = {
  'diff.scope.turnUnknown': 'No se pudo saber qué archivos cambió este turno: ejecutó comandos.',
  'diff.scope.turnPartial': 'Este turno ejecutó comandos, así que pudo cambiar archivos que no aparecen aquí.',
  'diff.scope.showChanges': 'Ver todos los cambios',
};

export const fr = {
  'diff.scope.turnUnknown': 'Impossible de savoir quels fichiers ce tour a modifiés : il a lancé des commandes.',
  'diff.scope.turnPartial': 'Ce tour a lancé des commandes : il a pu modifier des fichiers absents de cette liste.',
  'diff.scope.showChanges': 'Voir toutes les modifications',
};

export const pt = {
  'diff.scope.turnUnknown': 'Não foi possível saber quais arquivos este turno alterou: ele executou comandos.',
  'diff.scope.turnPartial': 'Este turno executou comandos, então pode ter alterado arquivos que não aparecem aqui.',
  'diff.scope.showChanges': 'Ver todas as alterações',
};
