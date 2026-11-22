// Ticket 701 (first-use walk 8, Korean walk): the tree row tips (tree.ts rowState) and the decision card's why line and
// kind words (tree/decisions.ts whatWhy) were English literals in a Korean window.
declare module '../index' {
  interface AreaKeys {
    'walk8.tip.permission': true;
    'walk8.tip.question': true;
    'walk8.tip.asked': true;
    'walk8.tip.limit': true;
    'walk8.tip.goneWhy': true;
    'walk8.tip.merged': true;
    'walk8.tip.branchKept': true;
    'walk8.tip.failed': true;
    'walk8.tip.prChecks': true;
    'walk8.tip.checksFail': true;
    'walk8.tip.stale': true;
    'walk8.tip.prOpen': true;
    'walk8.tip.new': true;
    'walk8.why.checking': true;
    'walk8.why.question': true;
    'walk8.why.risky': true;
    'walk8.why.permission': true;
    'walk8.why.read': true;
    'walk8.kind.stale': true;
    'walk8.kind.background': true;
    'walk8.kind.board': true;
    'walk8.kind.owner': true;
    'walk8.who.acp': true;
    'walk8.line.dialog': true;
    'walk8.line.edit': true;
    'walk8.line.write': true;
    'walk8.line.run': true;
  }
}

export const en = {
  'walk8.line.dialog': 'Needs an answer in the terminal',
  'walk8.line.edit': 'Edit {file}',
  'walk8.line.write': 'Write {file}',
  'walk8.line.run': 'Run {command}',
  'walk8.tip.permission': 'Needs permission',
  'walk8.tip.question': 'Question',
  'walk8.tip.asked': '{who} · asked {age} ago',
  'walk8.tip.limit': 'Usage limit · resets {time}',
  'walk8.tip.goneWhy': 'Deleted outside the app',
  'walk8.tip.merged': 'Merged · PR #{n}',
  'walk8.tip.branchKept': 'Branch kept',
  'walk8.tip.failed': 'Agent failed',
  'walk8.tip.prChecks': 'PR #{n} open · checks running',
  'walk8.tip.checksFail': 'Checks failing · PR #{n}',
  'walk8.tip.stale': 'no output for {age}',
  'walk8.tip.prOpen': 'PR #{n} open',
  'walk8.tip.new': 'New · no session yet',
  'walk8.why.checking': '{text} · checking',
  'walk8.why.question': 'The agent asks you to choose.',
  'walk8.why.risky': 'Risky: it may delete files, reach outside the folder, use the network, or Nunchiro cannot read the request.',
  'walk8.why.permission': 'The agent asks before it runs this.',
  'walk8.why.read': 'Read only: it reads from {server} and changes nothing.',
  'walk8.kind.stale': 'stale',
  'walk8.kind.background': 'task running',
  'walk8.kind.board': 'board decision',
  'walk8.kind.owner': 'needs you',
  'walk8.who.acp': 'ACP agent',
};

export const ko = {
  'walk8.line.dialog': '터미널에서 답해야 합니다',
  'walk8.line.edit': '{file} 편집',
  'walk8.line.write': '{file} 쓰기',
  'walk8.line.run': '{command} 실행',
  'walk8.tip.permission': '권한 필요',
  'walk8.tip.question': '질문',
  'walk8.tip.asked': "{who} · {age} 전에 질문함",
  'walk8.tip.limit': '사용 한도 · {time} 초기화',
  'walk8.tip.goneWhy': '앱 밖에서 삭제됨',
  'walk8.tip.merged': '병합됨 · PR #{n}',
  'walk8.tip.branchKept': '브랜치는 남아 있음',
  'walk8.tip.failed': '에이전트 실패',
  'walk8.tip.prChecks': 'PR #{n} 열림 · 검사 실행 중',
  'walk8.tip.checksFail': '검사 실패 · PR #{n}',
  'walk8.tip.stale': '{age} 동안 출력 없음',
  'walk8.tip.prOpen': 'PR #{n} 열림',
  'walk8.tip.new': '새 작업 · 아직 세션 없음',
  'walk8.why.checking': '{text} · 확인 중',
  'walk8.why.question': '에이전트가 선택을 요청합니다.',
  'walk8.why.risky': '위험: 파일을 삭제하거나 폴더 밖이나 네트워크에 접근할 수 있습니다. 또는 Nunchiro가 요청을 읽지 못했습니다.',
  'walk8.why.permission': '에이전트가 이것을 실행하기 전에 묻습니다.',
  'walk8.why.read': '읽기 전용: {server}에서 읽기만 하고 아무것도 바꾸지 않습니다.',
  'walk8.kind.stale': '멈춤',
  'walk8.kind.background': '작업 실행 중',
  'walk8.kind.board': '보드 결정',
  'walk8.kind.owner': '내 답 대기',
  'walk8.who.acp': 'ACP 에이전트',
};

export const ja = {
  'walk8.line.dialog': 'ターミナルで回答が必要',
  'walk8.line.edit': '{file} を編集',
  'walk8.line.write': '{file} に書き込み',
  'walk8.line.run': '{command} を実行',
  'walk8.tip.permission': '許可が必要',
  'walk8.tip.question': '質問',
  'walk8.tip.asked': '{who} · {age}前に質問',
  'walk8.tip.limit': '使用上限 · {time} にリセット',
  'walk8.tip.goneWhy': 'アプリの外で削除されました',
  'walk8.tip.merged': 'マージ済み · PR #{n}',
  'walk8.tip.branchKept': 'ブランチは残っています',
  'walk8.tip.failed': 'エージェントが失敗しました',
  'walk8.tip.prChecks': 'PR #{n} オープン · チェック実行中',
  'walk8.tip.checksFail': 'チェック失敗 · PR #{n}',
  'walk8.tip.stale': '{age}出力なし',
  'walk8.tip.prOpen': 'PR #{n} オープン',
  'walk8.tip.new': '新規 · まだセッションなし',
  'walk8.why.checking': '{text} · 確認中',
  'walk8.why.question': 'エージェントが選択を求めています。',
  'walk8.why.risky': '危険：ファイルの削除、フォルダー外へのアクセス、ネットワークの使用の可能性があるか、Nunchiro が要求を読み取れません。',
  'walk8.why.permission': 'エージェントが実行前に確認しています。',
  'walk8.why.read': '読み取りのみ：{server} から読み取るだけで、何も変更しません。',
  'walk8.kind.stale': '停滞',
  'walk8.kind.background': 'タスク実行中',
  'walk8.kind.board': 'ボードの判断',
  'walk8.kind.owner': '要対応',
  'walk8.who.acp': 'ACP エージェント',
};

export const zhHans = {
  'walk8.line.dialog': '需要在终端中回答',
  'walk8.line.edit': '编辑 {file}',
  'walk8.line.write': '写入 {file}',
  'walk8.line.run': '运行 {command}',
  'walk8.tip.permission': '需要权限',
  'walk8.tip.question': '问题',
  'walk8.tip.asked': '{who} · {age}前提问',
  'walk8.tip.limit': '使用上限 · {time} 重置',
  'walk8.tip.goneWhy': '已在应用外删除',
  'walk8.tip.merged': '已合并 · PR #{n}',
  'walk8.tip.branchKept': '分支已保留',
  'walk8.tip.failed': '代理失败',
  'walk8.tip.prChecks': 'PR #{n} 已打开 · 检查运行中',
  'walk8.tip.checksFail': '检查失败 · PR #{n}',
  'walk8.tip.stale': '{age}无输出',
  'walk8.tip.prOpen': 'PR #{n} 已打开',
  'walk8.tip.new': '新建 · 尚无会话',
  'walk8.why.checking': '{text} · 检查中',
  'walk8.why.question': '代理请你选择。',
  'walk8.why.risky': '有风险：它可能删除文件、访问文件夹之外的内容、使用网络，或者 Nunchiro 无法读取该请求。',
  'walk8.why.permission': '代理在运行前询问你。',
  'walk8.why.read': '只读：仅从 {server} 读取，不会更改任何内容。',
  'walk8.kind.stale': '停滞',
  'walk8.kind.background': '任务运行中',
  'walk8.kind.board': '看板决策',
  'walk8.kind.owner': '需要你处理',
  'walk8.who.acp': 'ACP 代理',
};

export const zhHant = {
  'walk8.line.dialog': '需要在終端中回答',
  'walk8.line.edit': '編輯 {file}',
  'walk8.line.write': '寫入 {file}',
  'walk8.line.run': '執行 {command}',
  'walk8.tip.permission': '需要權限',
  'walk8.tip.question': '問題',
  'walk8.tip.asked': '{who} · {age}前提問',
  'walk8.tip.limit': '使用上限 · {time} 重置',
  'walk8.tip.goneWhy': '已在 App 外刪除',
  'walk8.tip.merged': '已合併 · PR #{n}',
  'walk8.tip.branchKept': '分支已保留',
  'walk8.tip.failed': '代理失敗',
  'walk8.tip.prChecks': 'PR #{n} 已開啟 · 檢查執行中',
  'walk8.tip.checksFail': '檢查失敗 · PR #{n}',
  'walk8.tip.stale': '{age}無輸出',
  'walk8.tip.prOpen': 'PR #{n} 已開啟',
  'walk8.tip.new': '新建立 · 尚無工作階段',
  'walk8.why.checking': '{text} · 檢查中',
  'walk8.why.question': '代理請你選擇。',
  'walk8.why.risky': '有風險：可能刪除檔案、存取資料夾以外的位置或使用網路，或 Nunchiro 無法讀取此請求。',
  'walk8.why.permission': '代理在執行前詢問你。',
  'walk8.why.read': '唯讀：僅從 {server} 讀取，不會變更任何內容。',
  'walk8.kind.stale': '停滯',
  'walk8.kind.background': '工作執行中',
  'walk8.kind.board': '看板決策',
  'walk8.kind.owner': '需要你處理',
  'walk8.who.acp': 'ACP 代理',
};

export const es = {
  'walk8.line.dialog': 'Necesita una respuesta en el terminal',
  'walk8.line.edit': 'Editar {file}',
  'walk8.line.write': 'Escribir {file}',
  'walk8.line.run': 'Ejecutar {command}',
  'walk8.tip.permission': 'Necesita permiso',
  'walk8.tip.question': 'Pregunta',
  'walk8.tip.asked': '{who} · preguntó hace {age}',
  'walk8.tip.limit': 'Límite de uso · se restablece: {time}',
  'walk8.tip.goneWhy': 'Borrada fuera de la app',
  'walk8.tip.merged': 'Fusionado · PR #{n}',
  'walk8.tip.branchKept': 'La rama se conserva',
  'walk8.tip.failed': 'El agente falló',
  'walk8.tip.prChecks': 'PR #{n} abierto · comprobaciones en curso',
  'walk8.tip.checksFail': 'Comprobaciones fallidas · PR #{n}',
  'walk8.tip.stale': 'sin salida durante {age}',
  'walk8.tip.prOpen': 'PR #{n} abierto',
  'walk8.tip.new': 'Nuevo · aún sin sesión',
  'walk8.why.checking': '{text} · comprobando',
  'walk8.why.question': 'El agente te pide que elijas.',
  'walk8.why.risky': 'Arriesgado: puede borrar archivos, salir de la carpeta o usar la red, o Nunchiro no puede leer la solicitud.',
  'walk8.why.permission': 'El agente pregunta antes de ejecutar esto.',
  'walk8.why.read': 'Solo lectura: lee de {server} y no cambia nada.',
  'walk8.kind.stale': 'estancada',
  'walk8.kind.background': 'tarea en curso',
  'walk8.kind.board': 'decisión del tablero',
  'walk8.kind.owner': 'te necesita',
  'walk8.who.acp': 'agente ACP',
};

export const fr = {
  'walk8.line.dialog': 'Réponse attendue dans le terminal',
  'walk8.line.edit': 'Modifier {file}',
  'walk8.line.write': 'Écrire {file}',
  'walk8.line.run': 'Exécuter {command}',
  'walk8.tip.permission': 'Autorisation requise',
  'walk8.tip.question': 'Question',
  'walk8.tip.asked': '{who} · a demandé il y a {age}',
  'walk8.tip.limit': "Limite d’utilisation · réinitialisation {time}",
  'walk8.tip.goneWhy': "Supprimé hors de l’app",
  'walk8.tip.merged': 'Fusionnée · PR #{n}',
  'walk8.tip.branchKept': 'Branche conservée',
  'walk8.tip.failed': "L’agent a échoué",
  'walk8.tip.prChecks': 'PR #{n} ouverte · vérifications en cours',
  'walk8.tip.checksFail': 'Vérifications en échec · PR #{n}',
  'walk8.tip.stale': 'aucune sortie depuis {age}',
  'walk8.tip.prOpen': 'PR #{n} ouverte',
  'walk8.tip.new': 'Nouveau · pas encore de session',
  'walk8.why.checking': '{text} · vérification',
  'walk8.why.question': "L’agent vous demande de choisir.",
  'walk8.why.risky': 'Risqué : il peut supprimer des fichiers, sortir du dossier ou utiliser le réseau, ou bien Nunchiro ne peut pas lire la demande.',
  'walk8.why.permission': "L’agent demande avant de lancer ceci.",
  'walk8.why.read': 'Lecture seule : il lit dans {server} et ne modifie rien.',
  'walk8.kind.stale': 'immobile',
  'walk8.kind.background': 'tâche en cours',
  'walk8.kind.board': 'décision du tableau',
  'walk8.kind.owner': 'a besoin de vous',
  'walk8.who.acp': 'agent ACP',
};

export const pt = {
  'walk8.line.dialog': 'Precisa de resposta no terminal',
  'walk8.line.edit': 'Editar {file}',
  'walk8.line.write': 'Gravar {file}',
  'walk8.line.run': 'Executar {command}',
  'walk8.tip.permission': 'Precisa de permissão',
  'walk8.tip.question': 'Pergunta',
  'walk8.tip.asked': '{who} · perguntou há {age}',
  'walk8.tip.limit': 'Limite de uso · redefine às {time}',
  'walk8.tip.goneWhy': 'Apagada fora do app',
  'walk8.tip.merged': 'Mesclado · PR #{n}',
  'walk8.tip.branchKept': 'Branch mantido',
  'walk8.tip.failed': 'O agente falhou',
  'walk8.tip.prChecks': 'PR #{n} aberto · verificações em andamento',
  'walk8.tip.checksFail': 'Verificações falhando · PR #{n}',
  'walk8.tip.stale': 'sem saída há {age}',
  'walk8.tip.prOpen': 'PR #{n} aberto',
  'walk8.tip.new': 'Novo · ainda sem sessão',
  'walk8.why.checking': '{text} · verificando',
  'walk8.why.question': 'O agente pede que você escolha.',
  'walk8.why.risky': 'Arriscado: pode apagar arquivos, sair da pasta ou usar a rede, ou o Nunchiro não consegue ler o pedido.',
  'walk8.why.permission': 'O agente pergunta antes de executar isto.',
  'walk8.why.read': 'Somente leitura: lê de {server} e não altera nada.',
  'walk8.kind.stale': 'parado',
  'walk8.kind.background': 'tarefa em andamento',
  'walk8.kind.board': 'decisão do quadro',
  'walk8.kind.owner': 'precisa de você',
  'walk8.who.acp': 'agente ACP',
};
