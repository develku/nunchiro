// Ticket 358 (327): the words of Claude's and Codex's own command on Settings > Accounts (mock #edit, #pathedit).
declare module '../index' {
  interface AreaKeys {
    'providers.cmd.path': true;
    'providers.cmd.args': true;
    'providers.cmd.approve': true;
    'providers.cmd.reset': true;
    'providers.cmd.again': true;
    'providers.cmd.pending': true;
    'providers.cmd.refused': true;
    'providers.cmd.codexArgs': true;
    'providers.cmd.envOnly': true;
  }
}

export const en = {
  'providers.cmd.path': 'Executable path',
  'providers.cmd.args': 'Arguments',
  'providers.cmd.approve': 'Approve and save',
  'providers.cmd.reset': 'Reset to default',
  'providers.cmd.again': 'Changing the command needs approval again.',
  'providers.cmd.pending': '{command} needs approval. New sessions keep the previous command until you approve it.',
  'providers.cmd.refused': 'The command changed since it was approved, so new sessions will not start. Approve it again under Change, or reset it to the default.',
  'providers.cmd.codexArgs': 'With arguments, Nunchiro does not add its hooks, so it cannot see when the agent waits.',
  "providers.cmd.envOnly": "Sessions get all environment variables of the background service. These names only set the “missing” status. They do not limit what the CLI sees.",
};

export const ko = {
  'providers.cmd.path': '실행 파일 경로',
  'providers.cmd.args': '인수',
  'providers.cmd.approve': '승인하고 저장',
  'providers.cmd.reset': '기본값으로 되돌리기',
  'providers.cmd.again': '명령을 바꾸면 다시 승인해야 합니다.',
  'providers.cmd.pending': '{command} 승인이 필요합니다. 승인할 때까지 새 세션은 이전 명령을 씁니다.',
  'providers.cmd.refused': '승인한 뒤 명령이 바뀌어 새 세션을 시작하지 않습니다. 변경에서 다시 승인하거나 기본값으로 되돌리세요.',
  'providers.cmd.codexArgs': "인수가 있으면 Nunchiro 훅이 들어가지 않고 대기 감지도 꺼집니다.",
  "providers.cmd.envOnly": "세션은 백그라운드 서비스의 환경을 모두 받습니다. 이 이름은 “없음” 표시에만 쓰이고 CLI가 보는 변수를 제한하지 않습니다.",
};

export const ja = {
  'providers.cmd.path': '実行ファイルのパス',
  'providers.cmd.args': '引数',
  'providers.cmd.approve': '承認して保存',
  'providers.cmd.reset': 'デフォルトに戻す',
  'providers.cmd.again': 'コマンドを変更すると再度承認が必要です。',
  'providers.cmd.pending': '{command} は承認が必要です。承認するまで新しいセッションは以前のコマンドを使います。',
  'providers.cmd.refused': '承認後にコマンドが変更されたため、新しいセッションは開始されません。「変更」から再度承認するか、デフォルトに戻してください。',
  'providers.cmd.codexArgs': '引数があると Nunchiro のフックは追加されず、待機検出もオフになります。',
  "providers.cmd.envOnly": "セッションはバックグラウンドサービスの環境をすべて受け取ります。この名前は「なし」の表示にのみ使われ、CLI から見える変数を制限しません。",
};

export const zhHans = {
  'providers.cmd.path': '可执行文件路径',
  'providers.cmd.args': '参数',
  'providers.cmd.approve': '批准并保存',
  'providers.cmd.reset': '恢复默认',
  'providers.cmd.again': '更改命令后需要重新批准。',
  'providers.cmd.pending': '{command} 需要批准。批准前，新会话继续使用之前的命令。',
  'providers.cmd.refused': '命令在批准后已被更改，因此新会话不会启动。请在“更改”中重新批准，或恢复默认。',
  'providers.cmd.codexArgs': '有参数时不会添加 Nunchiro 钩子，等待检测也会关闭。',
  "providers.cmd.envOnly": "会话会获得后台服务的全部环境：这些名称只用于显示“缺失”状态，不会限制 CLI 能看到的变量。",
};

export const zhHant = {
  'providers.cmd.path': '可執行檔路徑',
  'providers.cmd.args': '引數',
  'providers.cmd.approve': '核准並儲存',
  'providers.cmd.reset': '重置為預設值',
  'providers.cmd.again': '變更指令後需要重新核准。',
  'providers.cmd.pending': '{command} 需要核准。核准前，新工作階段會繼續使用先前的指令。',
  'providers.cmd.refused': '指令在核准後已被變更，因此新工作階段不會啟動。請在「變更」中重新核准，或重置為預設值。',
  'providers.cmd.codexArgs': '有引數時不會加入 Nunchiro 掛鉤，等待偵測也會關閉。',
  "providers.cmd.envOnly": "工作階段會取得背景服務的全部環境：這些名稱只用於顯示「缺少」狀態，不會限制 CLI 能看到的變數。",
};

export const es = {
  'providers.cmd.path': 'Ruta del ejecutable',
  'providers.cmd.args': 'Argumentos',
  'providers.cmd.approve': 'Aprobar y guardar',
  'providers.cmd.reset': 'Restablecer valor predeterminado',
  'providers.cmd.again': 'Si cambias el comando, hay que aprobarlo de nuevo.',
  'providers.cmd.pending': '{command} necesita aprobación. Las sesiones nuevas siguen usando el comando anterior hasta que lo apruebes.',
  'providers.cmd.refused': 'El comando cambió después de aprobarse, así que las sesiones nuevas no se iniciarán. Apruébalo de nuevo en Cambiar o restablece el valor predeterminado.',
  'providers.cmd.codexArgs': 'Con argumentos no se añaden los hooks de Nunchiro y la detección de espera se desactiva.',
  "providers.cmd.envOnly": "Las sesiones reciben todas las variables de entorno del servicio en segundo plano. Estos nombres solo determinan el estado “no existe”. No limitan lo que ve la CLI.",
};

export const fr = {
  'providers.cmd.path': "Chemin de l’exécutable",
  'providers.cmd.args': 'Arguments',
  'providers.cmd.approve': 'Approuver et enregistrer',
  'providers.cmd.reset': 'Rétablir la valeur par défaut',
  'providers.cmd.again': 'Modifier la commande demande une nouvelle approbation.',
  'providers.cmd.pending': "{command} doit être approuvée. Les nouvelles sessions gardent la commande précédente jusqu’à votre approbation.",
  'providers.cmd.refused': "La commande a changé depuis son approbation : les nouvelles sessions ne démarreront pas. Approuvez-la de nouveau dans Modifier, ou rétablissez la valeur par défaut.",
  'providers.cmd.codexArgs': "Avec des arguments, les hooks Nunchiro ne sont pas ajoutés et la détection d’attente est désactivée.",
  "providers.cmd.envOnly": "Les sessions reçoivent tout l’environnement du service d’arrière-plan : ces noms servent seulement à l’état « manquant » et ne limitent pas ce que voit la CLI.",
};

export const pt = {
  'providers.cmd.path': 'Caminho do executável',
  'providers.cmd.args': 'Argumentos',
  'providers.cmd.approve': 'Aprovar e salvar',
  'providers.cmd.reset': 'Restaurar padrão',
  'providers.cmd.again': 'Alterar o comando exige nova aprovação.',
  'providers.cmd.pending': '{command} precisa de aprovação. As novas sessões continuam usando o comando anterior até você aprovar.',
  'providers.cmd.refused': 'O comando mudou depois de aprovado, então novas sessões não vão iniciar. Aprove de novo em Alterar ou restaure o padrão.',
  'providers.cmd.codexArgs': 'Com argumentos, os hooks do Nunchiro não são adicionados e a detecção de espera fica desativada.',
  "providers.cmd.envOnly": "As sessões recebem todas as variáveis de ambiente do serviço em segundo plano. Estes nomes só definem o status “ausente”. Eles não limitam o que a CLI vê.",
};

export { zhHans as 'zh-Hans', zhHant as 'zh-Hant' };
