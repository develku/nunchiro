// Ticket 391 follow-up (real-app check 11-10): the third sign-in word, the onboarding Providers step's rule, and the
// copy fixes of Providers and Skills & hooks.
declare module '../index' {
  interface AreaKeys {
    'providers.couldNotCheck': true;
    'onboarding.providers.rule': true;
    'onboarding.providers.doneSigned': true;
    'onboarding.providers.doneApproved': true;
    'acpLogin.whatTerminal': true;
    'acpLogin.whatAgent': true;
    'acpLogin.whatIn': true;
    'acpLogin.whatInOut': true;
    'acpLogin.whatCancel': true;
    'settings.accounts.cleanClaude': true;
    'settings.accounts.cleanCodex': true;
    'providers.modelOne': true;
  }
}

export const en = {
  'providers.couldNotCheck': "Could not check",
  'onboarding.providers.rule': 'Done when an installed agent is signed in or an ACP agent is approved.',
  'onboarding.providers.doneSigned': 'Done: {name} is signed in.',
  'onboarding.providers.doneApproved': 'Done: {name} is approved.',
  'acpLogin.whatTerminal': "Sign in opens {name}'s own login in a terminal tab.",
  'acpLogin.whatAgent': "Sign in asks {name} to start its own login, usually in your browser.",
  'acpLogin.whatIn': "Nothing to do: {name} is already signed in with its own login; Nunchiro keeps no password or key.",
  'acpLogin.whatInOut': "Nothing to do: {name} is already signed in. Sign out runs {name}'s own sign-out.",
  'acpLogin.whatCancel': "Cancel stops this sign-in; {name} stays signed out.",
  'settings.accounts.cleanClaude': "A new account starts empty. Skills, hooks, plugins and CLAUDE.md from ~/.claude are not loaded. Add what you need in {page}.",
  'settings.accounts.cleanCodex': "A new account starts empty. The config, AGENTS.md and skills from ~/.codex are not loaded. Add what you need in {page}.",
  'providers.modelOne': "Model",
};

export const ko = {
  'providers.couldNotCheck': '확인하지 못함',
  'onboarding.providers.rule': '설치된 에이전트 하나가 로그인되거나 ACP 에이전트 하나가 승인되면 완료됩니다.',
  'onboarding.providers.doneSigned': '완료: {name} 로그인됨.',
  'onboarding.providers.doneApproved': '완료: {name} 승인됨.',
  'acpLogin.whatTerminal': "로그인을 누르면 터미널 탭에서 {name} 자체 로그인이 열립니다.",
  'acpLogin.whatAgent': "로그인을 누르면 {name}이(가) 자체 로그인을 시작합니다. 보통 브라우저에서 열립니다.",
  'acpLogin.whatIn': "누를 것이 없습니다. {name}은(는) 이미 자체 로그인으로 로그인되어 있습니다. Nunchiro는 비밀번호나 키를 보관하지 않습니다.",
  'acpLogin.whatInOut': "누를 것이 없습니다. {name}은(는) 이미 로그인되어 있습니다. 로그아웃을 누르면 {name} 자체 로그아웃이 실행됩니다.",
  'acpLogin.whatCancel': "취소를 누르면 이 로그인을 멈춥니다. {name}은(는) 로그인되지 않은 상태로 남습니다.",
  'settings.accounts.cleanClaude': "새 계정은 빈 설정으로 시작합니다. ~/.claude의 스킬, 훅, 플러그인, CLAUDE.md는 불러오지 않습니다. 필요한 항목은 {page}에서 추가하세요.",
  'settings.accounts.cleanCodex': "새 계정은 빈 설정으로 시작합니다. ~/.codex의 설정, AGENTS.md, 스킬은 불러오지 않습니다. 필요한 항목은 {page}에서 추가하세요.",
  'providers.modelOne': "모델",
};

export const ja = {
  'providers.couldNotCheck': '確認できませんでした',
  'onboarding.providers.rule': "インストール済みのエージェントがログインするか、ACP エージェントが承認されると完了です。",
  'onboarding.providers.doneSigned': "完了：{name} はログイン済みです。",
  'onboarding.providers.doneApproved': '完了：{name} は承認済みです。',
  'acpLogin.whatTerminal': "ログインを押すと、{name} 自身のログインがターミナルタブで開きます。",
  'acpLogin.whatAgent': "ログインを押すと、{name} が自身のログインを始めます。通常はブラウザで開きます。",
  'acpLogin.whatIn': "操作は不要です。{name} は自身のログインですでにログインしています。Nunchiro はパスワードやキーを保存しません。",
  'acpLogin.whatInOut': "操作は不要です。{name} はログイン済みです。ログアウトを押すと {name} 自身のログアウトが実行されます。",
  'acpLogin.whatCancel': "キャンセルを押すとこのログインを止めます。{name} はログインしていないままです。",
  'settings.accounts.cleanClaude': "新しいアカウントは空の状態で始まります。~/.claude のスキル、フック、プラグイン、CLAUDE.md は読み込まれません。必要なものは {page} で追加してください。",
  'settings.accounts.cleanCodex': "新しいアカウントは空の状態で始まります。~/.codex の設定、AGENTS.md、スキルは読み込まれません。必要なものは {page} で追加してください。",
  'providers.modelOne': "モデル",
};

export const zhHans = {
  'providers.couldNotCheck': '无法检查',
  'onboarding.providers.rule': '已安装的代理登录，或 ACP 代理获批准后即完成。',
  'onboarding.providers.doneSigned': '已完成：{name} 已登录。',
  'onboarding.providers.doneApproved': '已完成：{name} 已批准。',
  'acpLogin.whatTerminal': "点击登录会在终端选项卡中打开 {name} 自己的登录。",
  'acpLogin.whatAgent': "点击登录会让 {name} 开始自己的登录，通常在浏览器中进行。",
  'acpLogin.whatIn': "无需操作：{name} 已用自己的登录方式登录；Nunchiro 不保存任何密码或密钥。",
  'acpLogin.whatInOut': "无需操作：{name} 已登录。点击退出登录会运行 {name} 自己的退出流程。",
  'acpLogin.whatCancel': "点击取消会停止这次登录；{name} 仍保持未登录。",
  'settings.accounts.cleanClaude': "新账户从空白开始：不会加载 ~/.claude 中的技能、钩子、插件和 CLAUDE.md。需要的内容请在{page}中添加。",
  'settings.accounts.cleanCodex': "新账户从空白开始：不会加载 ~/.codex 中的配置、AGENTS.md 和技能。需要的内容请在{page}中添加。",
  'providers.modelOne': "模型",
};

export const zhHant = {
  'providers.couldNotCheck': '無法檢查',
  'onboarding.providers.rule': '已安裝的代理登入，或 ACP 代理獲核准後即完成。',
  'onboarding.providers.doneSigned': '已完成：{name} 已登入。',
  'onboarding.providers.doneApproved': '已完成：{name} 已核准。',
  'acpLogin.whatTerminal': "點按登入會在終端選項卡中開啟 {name} 自己的登入。",
  'acpLogin.whatAgent': "點按登入會讓 {name} 開始自己的登入，通常在瀏覽器中進行。",
  'acpLogin.whatIn': "無需操作：{name} 已用自己的登入方式登入；Nunchiro 不保存任何密碼或金鑰。",
  'acpLogin.whatInOut': "無需操作：{name} 已登入。按下登出會執行 {name} 自己的登出流程。",
  'acpLogin.whatCancel': "按下取消會停止這次登入；{name} 仍維持未登入。",
  'settings.accounts.cleanClaude': "新帳戶從空白開始：不會載入 ~/.claude 中的技能、掛鉤、外掛和 CLAUDE.md。需要的內容請在{page}中新增。",
  'settings.accounts.cleanCodex': "新帳戶從空白開始：不會載入 ~/.codex 中的設定、AGENTS.md 和技能。需要的內容請在{page}中新增。",
  'providers.modelOne': "模型",
};

export const es = {
  'providers.couldNotCheck': 'No se pudo comprobar',
  'onboarding.providers.rule': 'Se completa cuando un agente instalado tiene la sesión iniciada o un agente ACP está aprobado.',
  'onboarding.providers.doneSigned': 'Hecho: {name} tiene la sesión iniciada.',
  'onboarding.providers.doneApproved': 'Hecho: {name} está aprobado.',
  'acpLogin.whatTerminal': "Iniciar sesión abre el inicio de sesión propio de {name} en una pestaña de terminal.",
  'acpLogin.whatAgent': "Iniciar sesión pide a {name} que inicie su propio inicio de sesión, normalmente en el navegador.",
  'acpLogin.whatIn': "No hay nada que hacer: {name} ya tiene la sesión iniciada con su propio inicio de sesión; Nunchiro no guarda contraseñas ni claves.",
  'acpLogin.whatInOut': "No hay nada que hacer: {name} ya tiene la sesión iniciada. Cerrar sesión ejecuta el cierre de sesión propio de {name}.",
  'acpLogin.whatCancel': "Cancelar detiene este inicio de sesión; {name} sigue sin sesión iniciada.",
  'settings.accounts.cleanClaude': "Una cuenta nueva empieza limpia: no se cargan los skills, hooks, plugins ni el CLAUDE.md de ~/.claude. Añade lo que necesites en {page}.",
  'settings.accounts.cleanCodex': "Una cuenta nueva empieza limpia: no se cargan la configuración, el AGENTS.md ni los skills de ~/.codex. Añade lo que necesites en {page}.",
  'providers.modelOne': "Modelo",
};

export const fr = {
  'providers.couldNotCheck': 'Vérification impossible',
  'onboarding.providers.rule': "Terminé quand un agent installé est connecté ou qu’un agent ACP est approuvé.",
  'onboarding.providers.doneSigned': 'Terminé : {name} est connecté.',
  'onboarding.providers.doneApproved': 'Terminé : {name} est approuvé.',
  'acpLogin.whatTerminal': "Se connecter ouvre la connexion propre à {name} dans un onglet de terminal.",
  'acpLogin.whatAgent': "Se connecter demande à {name} de lancer sa propre connexion, en général dans le navigateur.",
  'acpLogin.whatIn': "Rien à faire : {name} est déjà connecté avec sa propre connexion ; Nunchiro ne garde ni mot de passe ni clé.",
  'acpLogin.whatInOut': "Rien à faire : {name} est déjà connecté. Se déconnecter lance la déconnexion propre à {name}.",
  'acpLogin.whatCancel': "Annuler arrête cette connexion ; {name} reste déconnecté.",
  'settings.accounts.cleanClaude': "Un nouveau compte démarre vierge : les skills, hooks, plugins et le CLAUDE.md de ~/.claude ne sont pas chargés. Ajoutez ce qu’il vous faut dans {page}.",
  'settings.accounts.cleanCodex': "Un nouveau compte démarre vierge : la configuration, le AGENTS.md et les skills de ~/.codex ne sont pas chargés. Ajoutez ce qu’il vous faut dans {page}.",
  'providers.modelOne': "Modèle",
};

export const pt = {
  'providers.couldNotCheck': 'Não foi possível verificar',
  'onboarding.providers.rule': "Concluído quando um agente instalado está conectado ou um agente ACP está aprovado.",
  'onboarding.providers.doneSigned': "Concluído: {name} está conectado.",
  'onboarding.providers.doneApproved': 'Concluído: {name} está aprovado.',
  'acpLogin.whatTerminal': "Entrar abre o login próprio do {name} em uma aba de terminal.",
  'acpLogin.whatAgent': "Entrar pede ao {name} que inicie o próprio login, geralmente no navegador.",
  'acpLogin.whatIn': "Nada a fazer: {name} já está conectado com o próprio login; o Nunchiro não guarda senhas nem chaves.",
  'acpLogin.whatInOut': "Nada a fazer: {name} já está conectado. Sair executa o logout do próprio {name}.",
  'acpLogin.whatCancel': "Cancelar interrompe este login; {name} continua sem login.",
  'settings.accounts.cleanClaude': "Uma conta nova começa limpa: os skills, hooks, plugins e o CLAUDE.md de ~/.claude não são carregados. Adicione o que precisar em {page}.",
  'settings.accounts.cleanCodex': "Uma conta nova começa limpa: a configuração, o AGENTS.md e os skills de ~/.codex não são carregados. Adicione o que precisar em {page}.",
  'providers.modelOne': "Modelo",
};
