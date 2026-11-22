// Ticket 358: Settings > Accounts, rename, provider on/off, the 권한 row and the default's fallback. Copy is the mock's (358.html, c-358.html).
declare module '../index' {
  interface AreaKeys {
    'providersManage.rename': true;
    'providersManage.renameAria': true;
    'providersManage.renameGroup': true;
    'providersManage.renameNote': true;
    'providersManage.duplicate': true;
    'providersManage.save': true;
    'providersManage.signInAria': true;
    'providersManage.allOff': true;
    'providersManage.fellBack': true;
    'providersManage.use': true;
    'providersManage.useNote': true;
    'providersManage.useAria': true;
    'providersManage.off': true;
    'providersManage.permission': true;
    'providersManage.permissionNote': true;
    'providersManage.bypassOff': true;
  }
}

export const en = {
  'providersManage.rename': 'Rename',
  'providersManage.renameAria': 'Rename {name} account {label}',
  'providersManage.renameGroup': 'Rename {label}',
  'providersManage.renameNote': 'Running sessions stay as they are. New sessions start under the new name.',
  'providersManage.duplicate': 'An account with this name already exists.',
  'providersManage.signInAria': 'Sign in to {name}',
  'providersManage.allOff': 'Claude and Codex are turned off in Settings > Accounts.',
  'providersManage.save': 'Save',
  'providersManage.fellBack': 'Signed out. New sessions use the CLI’s own sign-in instead.',
  'providersManage.use': 'Use',
  'providersManage.useNote': 'When off, it disappears from the agent choices for new sessions.',
  'providersManage.useAria': 'Use {name}',
  'providersManage.off': 'Off',
  'providersManage.permission': 'Permission',
  'providersManage.permissionNote': 'Applies from the next new session.',
  'providersManage.bypassOff': 'Claude’s settings turn off Bypass permissions, so new sessions start in Auto.',
};

export const ko = {
  'providersManage.rename': '이름 바꾸기',
  'providersManage.renameAria': '{name} 계정 {label} 이름 바꾸기',
  'providersManage.renameGroup': '{label} 이름 바꾸기',
  'providersManage.renameNote': '실행 중인 세션과 대화는 그대로입니다. 새 세션은 새 이름으로 시작합니다.',
  'providersManage.duplicate': '이미 있는 계정 이름입니다.',
  'providersManage.signInAria': '{name} 로그인',
  'providersManage.allOff': 'Claude와 Codex는 설정 > 계정에서 꺼져 있습니다.',
  'providersManage.save': '저장',
  'providersManage.fellBack': '로그아웃되어 새 세션은 CLI 자체 로그인으로 시작합니다.',
  'providersManage.use': '사용',
  'providersManage.useNote': '끄면 새 세션의 에이전트 선택에서 사라집니다.',
  'providersManage.useAria': '{name} 사용',
  'providersManage.off': '꺼짐',
  'providersManage.permission': '권한',
  'providersManage.permissionNote': '새 세션부터 적용됩니다.',
  'providersManage.bypassOff': "Claude 설정에서 권한 우회가 꺼져 있어 새 세션은 자동 모드로 시작합니다.",
};

export const ja = {
  'providersManage.rename': '名前を変更',
  'providersManage.renameAria': '{name} のアカウント {label} の名前を変更',
  'providersManage.renameGroup': '{label} の名前を変更',
  'providersManage.renameNote': '実行中のセッションと会話はそのままです。新しいセッションは新しい名前で始まります。',
  'providersManage.duplicate': 'この名前のアカウントはすでにあります。',
  'providersManage.signInAria': "{name} にログイン",
  'providersManage.allOff': 'Claude と Codex は「設定 > アカウント」でオフになっています。',
  'providersManage.save': '保存',
  'providersManage.fellBack': 'ログアウトしたため、新しいセッションは CLI 自身のログインで始まります。',
  'providersManage.use': '使用',
  'providersManage.useNote': 'オフにすると、新しいセッションのエージェント選択から消えます。',
  'providersManage.useAria': '{name} を使用',
  'providersManage.off': 'オフ',
  'providersManage.permission': '権限',
  'providersManage.permissionNote': '次の新しいセッションから適用されます。',
  'providersManage.bypassOff': "Claude の設定で権限のバイパスがオフのため、新しいセッションは「自動」で始まります。",
};

export const zhHans = {
  'providersManage.rename': '重命名',
  'providersManage.renameAria': '重命名 {name} 账户 {label}',
  'providersManage.renameGroup': '重命名 {label}',
  'providersManage.renameNote': '运行中的会话和对话保持不变。新会话将以新名称启动。',
  'providersManage.duplicate': '已存在同名账户。',
  'providersManage.signInAria': '登录 {name}',
  'providersManage.allOff': 'Claude 和 Codex 已在“设置 > 账户”中关闭。',
  'providersManage.save': '保存',
  'providersManage.fellBack': '已退出登录，新会话将使用 CLI 自身的登录。',
  'providersManage.use': '使用',
  'providersManage.useNote': '关闭后，它会从新会话的代理选择中消失。',
  'providersManage.useAria': '使用 {name}',
  'providersManage.off': '已关闭',
  'providersManage.permission': '权限',
  'providersManage.permissionNote': '从下一个新会话开始生效。',
  'providersManage.bypassOff': 'Claude 的设置关闭了“绕过权限”，新会话将以自动模式启动。',
};

export const zhHant = {
  'providersManage.rename': '重新命名',
  'providersManage.renameAria': '重新命名 {name} 帳戶 {label}',
  'providersManage.renameGroup': '重新命名 {label}',
  'providersManage.renameNote': '執行中的工作階段和對話維持不變。新工作階段將以新名稱啟動。',
  'providersManage.duplicate': '已有相同名稱的帳戶。',
  'providersManage.signInAria': '登入 {name}',
  'providersManage.allOff': 'Claude 和 Codex 已在「設定 > 帳戶」中關閉。',
  'providersManage.save': '儲存',
  'providersManage.fellBack': '已登出，新工作階段將使用 CLI 自身的登入。',
  'providersManage.use': '使用',
  'providersManage.useNote': '關閉後，它會從新工作階段的代理選擇中消失。',
  'providersManage.useAria': '使用 {name}',
  'providersManage.off': '已關閉',
  'providersManage.permission': '權限',
  'providersManage.permissionNote': '從下一個新工作階段開始生效。',
  'providersManage.bypassOff': 'Claude 的設定關閉了「繞過權限」，新工作階段將以自動模式啟動。',
};

export const es = {
  'providersManage.rename': 'Renombrar',
  'providersManage.renameAria': 'Renombrar la cuenta {label} de {name}',
  'providersManage.renameGroup': 'Renombrar {label}',
  'providersManage.renameNote': 'Las sesiones en curso y las conversaciones no cambian. Las sesiones nuevas empiezan con el nombre nuevo.',
  'providersManage.duplicate': 'Ya existe una cuenta con este nombre.',
  'providersManage.signInAria': 'Iniciar sesión en {name}',
  'providersManage.allOff': 'Claude y Codex están desactivados en Ajustes > Cuentas.',
  'providersManage.save': 'Guardar',
  'providersManage.fellBack': 'Sesión cerrada: las sesiones nuevas empiezan con el inicio de sesión propio de la CLI.',
  'providersManage.use': 'Usar',
  'providersManage.useNote': 'Si se desactiva, desaparece de la elección de agente en las sesiones nuevas.',
  'providersManage.useAria': 'Usar {name}',
  'providersManage.off': 'Desactivado',
  'providersManage.permission': 'Permisos',
  'providersManage.permissionNote': 'Se aplica desde la próxima sesión nueva.',
  'providersManage.bypassOff': 'Los ajustes de Claude desactivan Omitir permisos, así que las sesiones nuevas empiezan en Automático.',
};

export const fr = {
  'providersManage.rename': 'Renommer',
  'providersManage.renameAria': 'Renommer le compte {label} de {name}',
  'providersManage.renameGroup': 'Renommer {label}',
  'providersManage.renameNote': 'Les sessions en cours et les conversations restent inchangées. Les nouvelles sessions démarrent sous le nouveau nom.',
  'providersManage.duplicate': 'Un compte porte déjà ce nom.',
  'providersManage.signInAria': 'Se connecter à {name}',
  'providersManage.allOff': 'Claude et Codex sont désactivés dans Réglages > Comptes.',
  'providersManage.save': 'Enregistrer',
  'providersManage.fellBack': 'Déconnecté : les nouvelles sessions démarrent avec la connexion propre à la CLI.',
  'providersManage.use': 'Utiliser',
  'providersManage.useNote': 'Désactivé, il disparaît du choix d’agent des nouvelles sessions.',
  'providersManage.useAria': 'Utiliser {name}',
  'providersManage.off': 'Désactivé',
  'providersManage.permission': 'Autorisations',
  'providersManage.permissionNote': 'S’applique à partir de la prochaine nouvelle session.',
  'providersManage.bypassOff': "Les réglages de Claude désactivent le mode Contourner les autorisations : les nouvelles sessions démarrent en mode Automatique.",
};

export const pt = {
  'providersManage.rename': 'Renomear',
  'providersManage.renameAria': 'Renomear a conta {label} de {name}',
  'providersManage.renameGroup': 'Renomear {label}',
  'providersManage.renameNote': 'As sessões em execução e as conversas continuam como estão. As novas sessões começam com o novo nome.',
  'providersManage.duplicate': 'Já existe uma conta com este nome.',
  'providersManage.signInAria': 'Entrar em {name}',
  'providersManage.allOff': 'Claude e Codex estão desativados em Configurações > Contas.',
  'providersManage.save': 'Salvar',
  'providersManage.fellBack': "Você saiu da conta: as novas sessões começam com o login próprio da CLI.",
  'providersManage.use': 'Usar',
  'providersManage.useNote': 'Desativado, some da escolha de agente das novas sessões.',
  'providersManage.useAria': 'Usar {name}',
  'providersManage.off': 'Desativado',
  'providersManage.permission': 'Permissões',
  'providersManage.permissionNote': 'Vale a partir da próxima nova sessão.',
  'providersManage.bypassOff': 'As configurações do Claude desativam Ignorar permissões, então as novas sessões começam em Automático.',
};
