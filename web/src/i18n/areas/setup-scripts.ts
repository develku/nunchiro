// Ticket 259 (G21): Settings › Git & Worktrees › Setup scripts (features/setup-scripts.tsx), the setup approval sheet
// (approval/PermissionSheet.tsx) and the start-an-agent note when setup failed.
declare module '../index' {
  interface AreaKeys {
    'field.setupScript': true;
    'setupScripts.setupDesc': true;
    'field.cleanupScript': true;
    'setupScripts.cleanupDesc': true;
    'field.setupPolicy': true;
    'setupScripts.policyDesc': true;
    'setupScripts.ask': true;
    'setupScripts.approved': true;
    'setupScripts.skip': true;
    'field.setupWait': true;
    'setupScripts.waitDesc': true;
    'setupScripts.agentLeft': true;
    'setupSheet.title': true;
    'setupSheet.kind': true;
    'setupSheet.runs': true;
    'setupSheet.changed': true;
    'setupSheet.note': true;
    'setupSheet.none': true;
    'setupSheet.approve': true;
  }
}

export const en = {
  'field.setupScript': "Setup script",
  'setupScripts.setupDesc': "Runs in a setup tab when a worktree is made. Left empty, the repo's orca.yaml scripts.setup runs instead, only after you approve its exact text.",
  'field.cleanupScript': "Cleanup script",
  'setupScripts.cleanupDesc': "Runs in a cleanup tab before Nunchiro removes a worktree. If it fails or runs past 2 minutes, the worktree is kept.",
  'field.setupPolicy': "Repo setup script",
  'setupScripts.policyDesc': "Ask shows a new or changed script for approval. Run when approved runs only a script you approved, unchanged. Skip runs no setup script.",
  'setupScripts.ask': "Ask",
  'setupScripts.approved': "Run when approved",
  'setupScripts.skip': "Skip",
  'field.setupWait': "Agent waits for setup",
  'setupScripts.waitDesc': "With Start an agent here on, the agent starts only after the setup tab finishes without an error.",
  'setupScripts.agentLeft': "Setup did not finish without an error, so the agent was not started. Its setup tab shows why; start the agent yourself when ready.",
  'setupSheet.title': "Approve the setup script of {name}",
  'setupSheet.kind': "Setup script from the repo's orca.yaml",
  'setupSheet.runs': "Runs with bash in a visible setup tab of this worktree:",
  'setupSheet.changed': "This script changed since you approved it. Review it again.",
  'setupSheet.note': "The approval covers this exact text for every worktree of {project}; a changed script asks again. It runs as you, with your files and network.",
  'setupSheet.none': "This worktree has no setup script to approve.",
  'setupSheet.approve': "Approve and run",
};
export const ko = {
  'field.setupScript': "준비 스크립트",
  'setupScripts.setupDesc': "워크트리를 만들 때 준비 탭에서 실행됩니다. 비워 두면 저장소의 orca.yaml scripts.setup이 대신 실행되며, 그 내용을 그대로 승인한 뒤에만 실행됩니다.",
  'field.cleanupScript': "정리 스크립트",
  'setupScripts.cleanupDesc': "Nunchiro가 워크트리를 제거하기 전에 정리 탭에서 실행됩니다. 실패하거나 2분을 넘기면 워크트리를 남겨 둡니다.",
  'field.setupPolicy': "저장소 준비 스크립트",
  'setupScripts.policyDesc': "“묻기”는 새 스크립트나 바뀐 스크립트를 보여 주고 승인을 받습니다. “승인되면 실행”은 승인한 뒤 바뀌지 않은 스크립트만 실행합니다. “건너뛰기”는 준비 스크립트를 실행하지 않습니다.",
  'setupScripts.ask': "묻기",
  'setupScripts.approved': "승인되면 실행",
  'setupScripts.skip': "건너뛰기",
  'field.setupWait': "에이전트가 준비를 기다림",
  'setupScripts.waitDesc': "여기서 에이전트 시작이 켜져 있으면, 준비 탭이 오류 없이 끝난 뒤에만 에이전트가 시작됩니다.",
  'setupScripts.agentLeft': "준비가 오류 없이 끝나지 않아 에이전트를 시작하지 않았습니다. 이유는 준비 탭에 나옵니다. 준비되면 직접 에이전트를 시작하세요.",
  'setupSheet.title': "{name}의 준비 스크립트 승인",
  'setupSheet.kind': "저장소 orca.yaml의 준비 스크립트",
  'setupSheet.runs': "이 워크트리의 보이는 준비 탭에서 bash로 실행됩니다:",
  'setupSheet.changed': "이 스크립트는 승인한 뒤 바뀌었습니다. 다시 검토하세요.",
  'setupSheet.note': "승인은 {project}의 모든 워크트리에서 이 내용 그대로에만 적용됩니다. 스크립트가 바뀌면 다시 묻습니다. 스크립트는 내 권한으로, 내 파일과 네트워크를 쓰며 실행됩니다.",
  'setupSheet.none': "이 워크트리에는 승인할 준비 스크립트가 없습니다.",
  'setupSheet.approve': "승인하고 실행",
};
export const ja = {
  'field.setupScript': "セットアップスクリプト",
  'setupScripts.setupDesc': "ワークツリーを作るとセットアップタブで実行されます。空のままなら、リポジトリの orca.yaml scripts.setup が代わりに実行されます。その内容をそのまま承認した後だけです。",
  'field.cleanupScript': "クリーンアップスクリプト",
  'setupScripts.cleanupDesc': "Nunchiro がワークツリーを削除する前にクリーンアップタブで実行されます。失敗するか 2 分を超えると、ワークツリーは残ります。",
  'field.setupPolicy': "リポジトリのセットアップスクリプト",
  'setupScripts.policyDesc': "「確認」は、新しいスクリプトや変更されたスクリプトを承認のために表示します。「承認済みなら実行」は、承認したまま変わっていないスクリプトだけを実行します。「スキップ」はセットアップスクリプトを実行しません。",
  'setupScripts.ask': "確認",
  'setupScripts.approved': "承認済みなら実行",
  'setupScripts.skip': "スキップ",
  'field.setupWait': "エージェントはセットアップを待つ",
  'setupScripts.waitDesc': "「ここでエージェントを開始」がオンなら、セットアップタブがエラーなしで終わった後にだけエージェントが開始します。",
  'setupScripts.agentLeft': "セットアップがエラーで終了したため、エージェントを開始しませんでした。理由はセットアップタブに表示されます。準備ができたらエージェントを自分で開始してください。",
  'setupSheet.title': "{name} のセットアップスクリプトを承認",
  'setupSheet.kind': "リポジトリの orca.yaml のセットアップスクリプト",
  'setupSheet.runs': "このワークツリーのセットアップタブに表示して bash で実行されます：",
  'setupSheet.changed': "このスクリプトは承認後に変更されました。もう一度確認してください。",
  'setupSheet.note': "承認は {project} のすべてのワークツリーで、この内容そのものにだけ有効です。スクリプトが変わると再度確認します。スクリプトはあなたとして、あなたのファイルとネットワークで実行されます。",
  'setupSheet.none': "このワークツリーには承認するセットアップスクリプトがありません。",
  'setupSheet.approve': "承認して実行",
};
export const zhHans = {
  'field.setupScript': "初始化脚本",
  'setupScripts.setupDesc': "创建工作树时在初始化选项卡中运行。留空时改为运行仓库 orca.yaml 的 scripts.setup，且只在你批准其确切内容之后运行。",
  'field.cleanupScript': "清理脚本",
  'setupScripts.cleanupDesc': "在 Nunchiro 移除工作树前于清理选项卡中运行。如果失败或运行超过 2 分钟，工作树会被保留。",
  'field.setupPolicy': "仓库初始化脚本",
  'setupScripts.policyDesc': "询问：显示新的或已更改的脚本供批准。批准后运行：只运行你批准且未更改的脚本。跳过：不运行任何初始化脚本。",
  'setupScripts.ask': "询问",
  'setupScripts.approved': "批准后运行",
  'setupScripts.skip': "跳过",
  'field.setupWait': "代理等待初始化完成",
  'setupScripts.waitDesc': "开启“在此启动代理”时，代理只在初始化选项卡无错误地完成后启动。",
  'setupScripts.agentLeft': "初始化未成功完成，因此未启动代理。原因显示在初始化选项卡中；准备好后请自行启动代理。",
  'setupSheet.title': "批准 {name} 的初始化脚本",
  'setupSheet.kind': "来自仓库 orca.yaml 的初始化脚本",
  'setupSheet.runs': "在此工作树的可见初始化选项卡中用 bash 运行：",
  'setupSheet.changed': "此脚本在你批准后已更改。请重新审核。",
  'setupSheet.note': "批准只适用于 {project} 所有工作树中这段确切的内容；脚本更改后会再次询问。它以你的身份运行，可使用你的文件和网络。",
  'setupSheet.none': "此工作树没有需要批准的初始化脚本。",
  'setupSheet.approve': "批准并运行",
};
export const zhHant = {
  'field.setupScript': "初始化指令碼",
  'setupScripts.setupDesc': "建立工作樹時在初始化選項卡中執行。留空時改為執行儲存庫 orca.yaml 的 scripts.setup，且只在你核准其確切內容之後執行。",
  'field.cleanupScript': "清理指令碼",
  'setupScripts.cleanupDesc': "在 Nunchiro 移除工作樹前於清理選項卡中執行。如果失敗或執行超過 2 分鐘，工作樹會被保留。",
  'field.setupPolicy': "儲存庫初始化指令碼",
  'setupScripts.policyDesc': "詢問：顯示新的或已變更的指令碼供核准。核准後執行：只執行你核准且未變更的指令碼。略過：不執行任何初始化指令碼。",
  'setupScripts.ask': "詢問",
  'setupScripts.approved': "核准後執行",
  'setupScripts.skip': "略過",
  'field.setupWait': "代理等待初始化完成",
  'setupScripts.waitDesc': "開啟「在此啟動代理」時，代理只在初始化選項卡無錯誤地完成後啟動。",
  'setupScripts.agentLeft': "初始化未能順利完成，因此未啟動代理。原因顯示在初始化選項卡中；準備好後請自行啟動代理。",
  'setupSheet.title': "核准 {name} 的初始化指令碼",
  'setupSheet.kind': "來自儲存庫 orca.yaml 的初始化指令碼",
  'setupSheet.runs': "在此工作樹的可見初始化選項卡中用 bash 執行：",
  'setupSheet.changed': "此指令碼在你核准後已變更。請重新審查。",
  'setupSheet.note': "核准只適用於 {project} 所有工作樹中這段確切的內容；指令碼變更後會再次詢問。它以你的身分執行，可使用你的檔案和網路。",
  'setupSheet.none': "此工作樹沒有需要核准的初始化指令碼。",
  'setupSheet.approve': "核准並執行",
};
export const es = {
  'field.setupScript': "Script de preparación",
  'setupScripts.setupDesc': "Se ejecuta en una pestaña de preparación al crear un árbol de trabajo. Si lo dejas vacío, se ejecuta el scripts.setup del orca.yaml del repositorio, solo después de que apruebes su texto exacto.",
  'field.cleanupScript': "Script de limpieza",
  'setupScripts.cleanupDesc': "Se ejecuta en una pestaña de limpieza antes de que Nunchiro elimine un árbol de trabajo. Si falla o tarda más de 2 minutos, el árbol de trabajo se conserva.",
  'field.setupPolicy': "Script de preparación del repositorio",
  'setupScripts.policyDesc': "Preguntar muestra un script nuevo o cambiado para aprobarlo. Ejecutar si está aprobado ejecuta solo un script que aprobaste, sin cambios. Omitir no ejecuta ningún script de preparación.",
  'setupScripts.ask': "Preguntar",
  'setupScripts.approved': "Ejecutar si está aprobado",
  'setupScripts.skip': "Omitir",
  'field.setupWait': "El agente espera a la preparación",
  'setupScripts.waitDesc': "Con Iniciar un agente aquí activado, el agente se inicia solo después de que la pestaña de preparación termine sin errores.",
  'setupScripts.agentLeft': "La preparación no terminó sin errores, así que el agente no se inició. Su pestaña de preparación muestra por qué; inicia el agente tú mismo cuando esté listo.",
  'setupSheet.title': "Aprobar el script de preparación de {name}",
  'setupSheet.kind': "Script de preparación del orca.yaml del repositorio",
  'setupSheet.runs': "Se ejecuta con bash en una pestaña de preparación visible de este árbol de trabajo:",
  'setupSheet.changed': "Este script cambió desde que lo aprobaste. Revísalo de nuevo.",
  'setupSheet.note': "La aprobación cubre este texto exacto en todos los árboles de trabajo de {project}; un script cambiado vuelve a preguntar. Se ejecuta como tú, con tus archivos y tu red.",
  'setupSheet.none': "Este árbol de trabajo no tiene un script de preparación que aprobar.",
  'setupSheet.approve': "Aprobar y ejecutar",
};
export const fr = {
  'field.setupScript': "Script de préparation",
  'setupScripts.setupDesc': "S’exécute dans un onglet de préparation à la création d’un arbre de travail. Laissé vide, c’est le scripts.setup du orca.yaml du dépôt qui s’exécute, seulement après que vous avez approuvé son texte exact.",
  'field.cleanupScript': "Script de nettoyage",
  'setupScripts.cleanupDesc': "S’exécute dans un onglet de nettoyage avant que Nunchiro retire un arbre de travail. S’il échoue ou dure plus de 2 minutes, l’arbre de travail est conservé.",
  'field.setupPolicy': "Script de préparation du dépôt",
  'setupScripts.policyDesc': "Demander affiche un script nouveau ou modifié pour approbation. Exécuter si approuvé n’exécute qu’un script que vous avez approuvé, inchangé. Ignorer n’exécute aucun script de préparation.",
  'setupScripts.ask': "Demander",
  'setupScripts.approved': "Exécuter si approuvé",
  'setupScripts.skip': "Ignorer",
  'field.setupWait': "L’agent attend la préparation",
  'setupScripts.waitDesc': "Avec Démarrer un agent ici activé, l’agent ne démarre qu’une fois l’onglet de préparation terminé sans erreur.",
  'setupScripts.agentLeft': "La préparation a échoué, l’agent n’a donc pas démarré. Son onglet de préparation indique pourquoi ; démarrez l’agent vous-même quand c’est prêt.",
  'setupSheet.title': "Approuver le script de préparation de {name}",
  'setupSheet.kind': "Script de préparation du orca.yaml du dépôt",
  'setupSheet.runs': "S’exécute avec bash dans un onglet de préparation visible de cet arbre de travail :",
  'setupSheet.changed': "Ce script a changé depuis que vous l’avez approuvé. Relisez-le.",
  'setupSheet.note': "L’approbation couvre ce texte exact pour tous les arbres de travail de {project} ; un script modifié redemande. Il s’exécute en votre nom, avec vos fichiers et votre réseau.",
  'setupSheet.none': "Cet arbre de travail n’a pas de script de préparation à approuver.",
  'setupSheet.approve': "Approuver et exécuter",
};
export const pt = {
  'field.setupScript': "Script de preparação",
  'setupScripts.setupDesc': "Roda em uma aba de preparação quando uma árvore de trabalho é criada. Se ficar vazio, roda o scripts.setup do orca.yaml do repositório, só depois que você aprovar o texto exato.",
  'field.cleanupScript': "Script de limpeza",
  'setupScripts.cleanupDesc': "Roda em uma aba de limpeza antes de o Nunchiro remover uma árvore de trabalho. Se falhar ou passar de 2 minutos, ela é mantida.",
  'field.setupPolicy': "Script de preparação do repositório",
  'setupScripts.policyDesc': "Perguntar mostra um script novo ou alterado para aprovação. Rodar se aprovado roda só um script que você aprovou, sem mudanças. Pular não roda nenhum script de preparação.",
  'setupScripts.ask': "Perguntar",
  'setupScripts.approved': "Rodar se aprovado",
  'setupScripts.skip': "Pular",
  'field.setupWait': "O agente espera a preparação",
  'setupScripts.waitDesc': "Com Iniciar um agente aqui ativado, o agente só inicia depois que a aba de preparação terminar sem erros.",
  'setupScripts.agentLeft': "A preparação não terminou sem erros, então o agente não foi iniciado. A aba de preparação mostra o motivo; inicie o agente você mesmo quando estiver pronto.",
  'setupSheet.title': "Aprovar o script de preparação de {name}",
  'setupSheet.kind': "Script de preparação do orca.yaml do repositório",
  'setupSheet.runs': "Roda com bash em uma aba de preparação visível desta árvore de trabalho:",
  'setupSheet.changed': "Este script mudou desde que você o aprovou. Revise-o novamente.",
  'setupSheet.note': "A aprovação cobre este texto exato em todas as árvores de trabalho de {project}; um script alterado pergunta de novo. Ele roda como você, com seus arquivos e sua rede.",
  'setupSheet.none': "Esta árvore de trabalho não tem um script de preparação para aprovar.",
  'setupSheet.approve': "Aprovar e rodar",
};
