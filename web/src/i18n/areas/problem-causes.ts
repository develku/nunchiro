// Ticket 604: the problem card's cause in the window's language. The core writes each cause in English
// (crates/nunchiro-core/src/problems.rs); ProblemCard.tsx picks the key by case and passes the agent, machine or ACP name,
// the exit code and the agent's own reset time as arguments. The core's English text stays under Details.
declare module '../index' {
  interface AreaKeys {
    'problem.cause.signedOut': true;
    'problem.cause.limit': true;
    'problem.cause.limitReset': true;
    'problem.cause.hookTrust': true;
    'problem.cause.missing': true;
    'problem.cause.unexpected': true;
    'problem.cause.unexpectedCode': true;
    'problem.cause.machineDown': true;
    'problem.cause.machineVersion': true;
    'problem.cause.acpNoAnswer': true;
    'problem.cause.acpRefused': true;
    'problem.cause.setAside': true;
  }
}

export const en = {
  'problem.cause.signedOut': "{name} is signed out.",
  'problem.cause.limit': "{name} usage limit reached.",
  'problem.cause.limitReset': "{name} usage limit reached. Resets {at} per {name}.",
  'problem.cause.hookTrust': "{name} refused Nunchiro's hooks.",
  'problem.cause.missing': "{name} is not installed.",
  'problem.cause.unexpected': "Session ended unexpectedly.",
  'problem.cause.unexpectedCode': "Session ended unexpectedly (exit code {code}).",
  'problem.cause.machineDown': "Can't reach {alias}.",
  'problem.cause.machineVersion': "{alias} runs another Nunchiro version.",
  'problem.cause.acpNoAnswer': "{name} did not answer ACP: check its command.",
  'problem.cause.acpRefused': "a Claude ACP agent needs ANTHROPIC_API_KEY (or CLAUDE_CODE_USE_BEDROCK with AWS_PROFILE or AWS_ACCESS_KEY_ID, or CLAUDE_CODE_USE_VERTEX with ANTHROPIC_VERTEX_PROJECT_ID) in its env names; Nunchiro never uses a Claude.ai login over ACP",
  'problem.cause.setAside': "A sessions.json of another version was set aside. Saved scrollback and exports are not cleaned up until you remove it.",
};

export const ko = {
  'problem.cause.signedOut': "{name}에 로그인되어 있지 않습니다.",
  'problem.cause.limit': "{name} 사용 한도에 도달했습니다.",
  'problem.cause.limitReset': "{name} 사용 한도에 도달했습니다. {name} 기준 {at}에 초기화됩니다.",
  'problem.cause.hookTrust': "{name}이(가) Nunchiro 훅을 거부했습니다.",
  'problem.cause.missing': "{name}이(가) 설치되어 있지 않습니다.",
  'problem.cause.unexpected': "세션이 예기치 않게 종료되었습니다.",
  'problem.cause.unexpectedCode': "세션이 예기치 않게 종료되었습니다(종료 코드 {code}).",
  'problem.cause.machineDown': "{alias}에 연결할 수 없습니다.",
  'problem.cause.machineVersion': "{alias}에서 다른 버전의 Nunchiro가 실행 중입니다.",
  'problem.cause.acpNoAnswer': "{name}이(가) ACP에 응답하지 않습니다. 명령을 확인하세요.",
  'problem.cause.acpRefused': "Claude ACP 에이전트에는 환경 변수 이름에 ANTHROPIC_API_KEY(또는 AWS_PROFILE이나 AWS_ACCESS_KEY_ID와 함께 CLAUDE_CODE_USE_BEDROCK, 또는 ANTHROPIC_VERTEX_PROJECT_ID와 함께 CLAUDE_CODE_USE_VERTEX)가 필요합니다. Nunchiro는 ACP에서 Claude.ai 로그인을 사용하지 않습니다.",
  'problem.cause.setAside': "다른 버전의 sessions.json을 따로 보관했습니다. 이 파일을 제거하기 전에는 저장된 스크롤백과 내보내기 파일이 정리되지 않습니다.",
};

export const ja = {
  'problem.cause.signedOut': "{name} にログインしていません。",
  'problem.cause.limit': "{name} の使用上限に達しました。",
  'problem.cause.limitReset': "{name} の使用上限に達しました。{name} によると {at} にリセットされます。",
  'problem.cause.hookTrust': "{name} が Nunchiro フックを拒否しました。",
  'problem.cause.missing': "{name} がインストールされていません。",
  'problem.cause.unexpected': "セッションが予期せず終了しました。",
  'problem.cause.unexpectedCode': "セッションが予期せず終了しました（終了コード {code}）。",
  'problem.cause.machineDown': "{alias} に接続できません。",
  'problem.cause.machineVersion': "{alias} は別のバージョンの Nunchiro を実行しています。",
  'problem.cause.acpNoAnswer': "{name} が ACP に応答しませんでした。コマンドを確認してください。",
  'problem.cause.acpRefused': "Claude ACP エージェントには、環境変数名に ANTHROPIC_API_KEY（または AWS_PROFILE か AWS_ACCESS_KEY_ID を伴う CLAUDE_CODE_USE_BEDROCK、または ANTHROPIC_VERTEX_PROJECT_ID を伴う CLAUDE_CODE_USE_VERTEX）が必要です。Nunchiro は ACP で Claude.ai のログインを使いません。",
  'problem.cause.setAside': "別のバージョンの sessions.json を退避しました。このファイルを削除するまで、保存済みのスクロールバックとエクスポートは整理されません。",
};

export const zhHans = {
  'problem.cause.signedOut': "{name} 未登录。",
  'problem.cause.limit': "{name} 已达到使用上限。",
  'problem.cause.limitReset': "{name} 已达到使用上限。据 {name} 称，将在 {at} 重置。",
  'problem.cause.hookTrust': "{name} 拒绝了 Nunchiro 钩子。",
  'problem.cause.missing': "{name} 未安装。",
  'problem.cause.unexpected': "会话意外结束。",
  'problem.cause.unexpectedCode': "会话意外结束（退出码 {code}）。",
  'problem.cause.machineDown': "无法连接到 {alias}。",
  'problem.cause.machineVersion': "{alias} 运行的是另一个版本的 Nunchiro。",
  'problem.cause.acpNoAnswer': "{name} 没有响应 ACP：请检查它的命令。",
  'problem.cause.acpRefused': "Claude ACP 代理需要在环境变量名中包含 ANTHROPIC_API_KEY（或带有 AWS_PROFILE 或 AWS_ACCESS_KEY_ID 的 CLAUDE_CODE_USE_BEDROCK，或带有 ANTHROPIC_VERTEX_PROJECT_ID 的 CLAUDE_CODE_USE_VERTEX）；Nunchiro 不会通过 ACP 使用 Claude.ai 登录。",
  'problem.cause.setAside': "另一个版本的 sessions.json 已被移开保留。在你移除它之前，已保存的回滚内容和导出文件不会被清理。",
};

export const zhHant = {
  'problem.cause.signedOut': "{name} 未登入。",
  'problem.cause.limit': "{name} 已達到使用上限。",
  'problem.cause.limitReset': "{name} 已達到使用上限。據 {name} 表示，將在 {at} 重置。",
  'problem.cause.hookTrust': "{name} 拒絕了 Nunchiro 掛鉤。",
  'problem.cause.missing': "{name} 未安裝。",
  'problem.cause.unexpected': "工作階段意外結束。",
  'problem.cause.unexpectedCode': "工作階段意外結束（結束碼 {code}）。",
  'problem.cause.machineDown': "無法連線到 {alias}。",
  'problem.cause.machineVersion': "{alias} 執行的是另一個版本的 Nunchiro。",
  'problem.cause.acpNoAnswer': "{name} 沒有回應 ACP：請檢查它的指令。",
  'problem.cause.acpRefused': "Claude ACP 代理需要在環境變數名稱中包含 ANTHROPIC_API_KEY（或帶有 AWS_PROFILE 或 AWS_ACCESS_KEY_ID 的 CLAUDE_CODE_USE_BEDROCK，或帶有 ANTHROPIC_VERTEX_PROJECT_ID 的 CLAUDE_CODE_USE_VERTEX）；Nunchiro 不會透過 ACP 使用 Claude.ai 登入。",
  'problem.cause.setAside': "另一個版本的 sessions.json 已被擱置。在你移除它之前，已儲存的回捲記錄和匯出檔不會被清理。",
};

export const es = {
  'problem.cause.signedOut': "{name} no ha iniciado sesión.",
  'problem.cause.limit': "{name} alcanzó su límite de uso.",
  'problem.cause.limitReset': "{name} alcanzó su límite de uso. Se restablece {at} según {name}.",
  'problem.cause.hookTrust': "{name} rechazó los hooks de Nunchiro.",
  'problem.cause.missing': "{name} no está instalado.",
  'problem.cause.unexpected': "La sesión terminó de forma inesperada.",
  'problem.cause.unexpectedCode': "La sesión terminó de forma inesperada (código de salida {code}).",
  'problem.cause.machineDown': "No se puede conectar con {alias}.",
  'problem.cause.machineVersion': "{alias} ejecuta otra versión de Nunchiro.",
  'problem.cause.acpNoAnswer': "{name} no respondió por ACP: revisa su comando.",
  'problem.cause.acpRefused': "Un agente ACP de Claude necesita ANTHROPIC_API_KEY (o CLAUDE_CODE_USE_BEDROCK con AWS_PROFILE o AWS_ACCESS_KEY_ID, o CLAUDE_CODE_USE_VERTEX con ANTHROPIC_VERTEX_PROJECT_ID) en los nombres de su entorno; Nunchiro nunca usa un inicio de sesión de Claude.ai por ACP.",
  'problem.cause.setAside': "Se apartó un sessions.json de otra versión. El historial guardado del terminal y las exportaciones no se limpian hasta que lo elimines.",
};

export const fr = {
  'problem.cause.signedOut': "{name} n’est pas connecté.",
  'problem.cause.limit': "{name} a atteint sa limite d’utilisation.",
  'problem.cause.limitReset': "{name} a atteint sa limite d’utilisation. Réinitialisation {at} selon {name}.",
  'problem.cause.hookTrust': "{name} a refusé les hooks de Nunchiro.",
  'problem.cause.missing': "{name} n’est pas installé.",
  'problem.cause.unexpected': "La session s’est terminée de manière inattendue.",
  'problem.cause.unexpectedCode': "La session s’est terminée de manière inattendue (code de sortie {code}).",
  'problem.cause.machineDown': "Impossible d’atteindre {alias}.",
  'problem.cause.machineVersion': "{alias} exécute une autre version de Nunchiro.",
  'problem.cause.acpNoAnswer': "{name} n’a pas répondu en ACP : vérifiez sa commande.",
  'problem.cause.acpRefused': "Un agent ACP Claude a besoin de ANTHROPIC_API_KEY (ou de CLAUDE_CODE_USE_BEDROCK avec AWS_PROFILE ou AWS_ACCESS_KEY_ID, ou de CLAUDE_CODE_USE_VERTEX avec ANTHROPIC_VERTEX_PROJECT_ID) dans ses noms de variables d’environnement ; Nunchiro n’utilise jamais une connexion Claude.ai via ACP.",
  'problem.cause.setAside': "Un sessions.json d’une autre version a été mis de côté. L’historique enregistré du terminal et les exports ne sont pas nettoyés tant que vous ne l’avez pas supprimé.",
};

export const pt = {
  'problem.cause.signedOut': "{name} está sem login.",
  'problem.cause.limit': "{name} atingiu o limite de uso.",
  'problem.cause.limitReset': "{name} atingiu o limite de uso. Reinicia {at}, segundo {name}.",
  'problem.cause.hookTrust': "{name} recusou os hooks do Nunchiro.",
  'problem.cause.missing': "{name} não está instalado.",
  'problem.cause.unexpected': "A sessão terminou de forma inesperada.",
  'problem.cause.unexpectedCode': "A sessão terminou de forma inesperada (código de saída {code}).",
  'problem.cause.machineDown': "Não é possível conectar a {alias}.",
  'problem.cause.machineVersion': "{alias} executa outra versão do Nunchiro.",
  'problem.cause.acpNoAnswer': "{name} não respondeu por ACP: verifique o comando dele.",
  'problem.cause.acpRefused': "Um agente ACP do Claude precisa de ANTHROPIC_API_KEY (ou CLAUDE_CODE_USE_BEDROCK com AWS_PROFILE ou AWS_ACCESS_KEY_ID, ou CLAUDE_CODE_USE_VERTEX com ANTHROPIC_VERTEX_PROJECT_ID) nos nomes do ambiente dele; o Nunchiro nunca usa um login do Claude.ai por ACP.",
  'problem.cause.setAside': "Um sessions.json de outra versão foi separado. O histórico salvo do terminal e as exportações não são limpos até você removê-lo.",
};

export { zhHans as 'zh-Hans', zhHant as 'zh-Hant' };
