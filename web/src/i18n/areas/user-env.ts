// Ticket 260 (G28): Settings › Providers › Shell environment (features/user-env.tsx).
declare module '../index' {
  interface AreaKeys {
    'userEnv.title': true;
    'field.envInheritShell': true;
    'userEnv.inheritDesc': true;
    'field.envNames': true;
    'userEnv.namesDesc': true;
    'userEnv.failed': true;
    'searchWords.envInheritShell': true;
    'field.envStripSecrets': true;
    'userEnv.stripDesc': true;
    'userEnv.leftOut': true;
    'field.envKeepSecrets': true;
    'userEnv.keepDesc': true;
    'userEnv.keepOff': true;
    'searchWords.envStripSecrets': true;
  }
}

export const en = {
  'userEnv.title': "Shell environment",
  'field.envInheritShell': "Use my login shell environment",
  'userEnv.inheritDesc': "Claude, Codex and shell tabs get the variables your login shell sets. Applies to sessions started after a change.",
  'field.envNames': "Variables to pass from your shell",
  'userEnv.namesDesc': "Variable names, separated by spaces. PATH, locale and SSH_AUTH_SOCK are always passed.",
  'userEnv.failed': "Your login shell's environment could not be read ({error}), so sessions get Nunchiro's own.",
  'searchWords.envInheritShell': "environment variables, shell environment, login shell, env",
  'field.envStripSecrets': "Leave secret-looking variables out of agents",
  'userEnv.stripDesc': "Claude and Codex sessions, and shells an agent starts, begin without variables whose names contain a word like KEY, TOKEN, SECRET, PASSWORD or AUTH. Shell tabs you open keep them. Each agent keeps its own sign-in variables.",
  'userEnv.leftOut': "Left out now: {names}.",
  'field.envKeepSecrets': "Keep these variables for agents",
  'userEnv.keepDesc': "Exact names, separated by spaces. Only names, never values, are stored.",
  // Ticket 1024: English only for now; the other languages fall back to it.
  'userEnv.keepOff': "These names are not used while the switch above is off. Reset clears them.",
  'searchWords.envStripSecrets': "secrets, API key, token, password, environment variables, env",
};
export const ko = {
  'userEnv.title': "셸 환경",
  'field.envInheritShell': "로그인 셸 환경 사용",
  'userEnv.inheritDesc': "Claude, Codex, 셸 탭이 로그인 셸에서 설정한 변수를 받습니다. 바꾼 뒤 시작하는 세션부터 적용됩니다.",
  'field.envNames': "셸에서 전달할 변수",
  'userEnv.namesDesc': "변수 이름을 공백으로 구분해 적으세요. PATH, 로케일, SSH_AUTH_SOCK은 항상 전달됩니다.",
  'userEnv.failed': "로그인 셸 환경을 읽지 못해({error}) 세션은 Nunchiro 자체 환경을 받습니다.",
  'searchWords.envInheritShell': "환경 변수, 셸 환경, 로그인 셸, env",
  // Ticket 1008: awaiting a native read.
  'field.envStripSecrets': "에이전트에 비밀로 보이는 변수 넘기지 않기",
  'userEnv.stripDesc': "Claude와 Codex 세션, 그리고 에이전트가 시작한 셸은 이름에 KEY, TOKEN, SECRET, PASSWORD, AUTH 같은 단어가 든 변수 없이 시작합니다. 직접 연 셸 탭은 그대로 받습니다. 각 에이전트는 자기 로그인 변수를 그대로 받습니다.",
  'userEnv.leftOut': "지금 빠지는 변수: {names}.",
  'field.envKeepSecrets': "에이전트에 넘길 변수",
  'userEnv.keepDesc': "정확한 이름을 공백으로 구분해 적으세요. 값은 저장하지 않고 이름만 저장합니다.",
  'searchWords.envStripSecrets': "비밀, API 키, 토큰, 암호, 환경 변수, env",
};
export const ja = {
  'userEnv.title': "シェル環境",
  'field.envInheritShell': "ログインシェルの環境を使う",
  'userEnv.inheritDesc': "Claude、Codex、シェルタブに、ログインシェルが設定する変数を渡します。変更後に開始したセッションから適用されます。",
  'field.envNames': "シェルから渡す変数",
  'userEnv.namesDesc': "変数名をスペースで区切って入力します。PATH、ロケール、SSH_AUTH_SOCK は常に渡されます。",
  'userEnv.failed': "ログインシェルの環境を読み取れなかったため（{error}）、セッションには Nunchiro 自身の環境が渡されます。",
  'searchWords.envInheritShell': "環境変数, シェル環境, ログインシェル, env",
  // Ticket 1008: awaiting a native read.
  'field.envStripSecrets': "秘密情報らしい変数をエージェントに渡さない",
  'userEnv.stripDesc': "Claude と Codex のセッション、およびエージェントが開始したシェルは、名前に KEY、TOKEN、SECRET、PASSWORD、AUTH などの語を含む変数なしで開始します。自分で開いたシェルタブには渡されます。各エージェントは自分のサインイン用の変数を受け取ります。",
  'userEnv.leftOut': "現在除外中: {names}。",
  'field.envKeepSecrets': "エージェントに渡す変数",
  'userEnv.keepDesc': "正確な名前をスペースで区切って入力します。保存されるのは名前だけで、値は保存されません。",
  'searchWords.envStripSecrets': "秘密情報, API キー, トークン, パスワード, 環境変数, env",
};
export const zhHans = {
  'userEnv.title': "Shell 环境",
  'field.envInheritShell': "使用我的登录 Shell 环境",
  'userEnv.inheritDesc': "Claude、Codex 和 Shell 选项卡会获得登录 Shell 设置的变量。更改后启动的会话生效。",
  'field.envNames': "从 Shell 传递的变量",
  'userEnv.namesDesc': "变量名以空格分隔。PATH、区域设置和 SSH_AUTH_SOCK 始终会传递。",
  'userEnv.failed': "无法读取登录 Shell 的环境（{error}），因此会话使用 Nunchiro 自身的环境。",
  'searchWords.envInheritShell': "环境变量, Shell 环境, 登录 Shell, env",
  // Ticket 1008: awaiting a native read.
  'field.envStripSecrets': "不向代理传递看似机密的变量",
  'userEnv.stripDesc': "Claude 和 Codex 会话以及代理启动的 Shell 在启动时不带名称中含有 KEY、TOKEN、SECRET、PASSWORD 或 AUTH 等单词的变量。你自己打开的 Shell 选项卡仍会获得这些变量。每个代理仍会获得自己的登录变量。",
  'userEnv.leftOut': "当前排除：{names}。",
  'field.envKeepSecrets': "仍传递给代理的变量",
  'userEnv.keepDesc': "准确的变量名，以空格分隔。只存储名称，从不存储值。",
  'searchWords.envStripSecrets': "机密, API 密钥, 令牌, 密码, 环境变量, env",
};
export const zhHant = {
  'userEnv.title': "shell 環境",
  'field.envInheritShell': "使用我的登入 shell 環境",
  'userEnv.inheritDesc': "Claude、Codex 和 shell 選項卡會取得登入 shell 設定的變數。變更後啟動的工作階段才會套用。",
  'field.envNames': "從 shell 傳遞的變數",
  'userEnv.namesDesc': "變數名稱以空格分隔。PATH、地區設定和 SSH_AUTH_SOCK 一律會傳遞。",
  'userEnv.failed': "無法讀取登入 shell 的環境（{error}），因此工作階段使用 Nunchiro 本身的環境。",
  'searchWords.envInheritShell': "環境變數, shell 環境, 登入 shell, env",
  // Ticket 1008: awaiting a native read.
  'field.envStripSecrets': "不將看似機密的變數傳給代理",
  'userEnv.stripDesc': "Claude 和 Codex 工作階段以及代理啟動的 shell 在啟動時不帶名稱中含有 KEY、TOKEN、SECRET、PASSWORD 或 AUTH 等字詞的變數。你自己開啟的 shell 選項卡仍會取得這些變數。每個代理仍會取得自己的登入變數。",
  'userEnv.leftOut': "目前排除：{names}。",
  'field.envKeepSecrets': "仍傳給代理的變數",
  'userEnv.keepDesc': "準確的變數名稱，以空格分隔。只儲存名稱，從不儲存值。",
  'searchWords.envStripSecrets': "機密, API 金鑰, 權杖, 密碼, 環境變數, env",
};
export const es = {
  'userEnv.title': "Entorno del shell",
  'field.envInheritShell': "Usar el entorno de mi shell de inicio de sesión",
  'userEnv.inheritDesc': "Claude, Codex y las pestañas de shell reciben las variables que define tu shell de inicio de sesión. Se aplica a las sesiones iniciadas después del cambio.",
  'field.envNames': "Variables que se pasan desde tu shell",
  'userEnv.namesDesc': "Nombres de variables separados por espacios. PATH, la configuración regional y SSH_AUTH_SOCK siempre se pasan.",
  'userEnv.failed': "No se pudo leer el entorno de tu shell de inicio de sesión ({error}), así que las sesiones reciben el propio de Nunchiro.",
  'searchWords.envInheritShell': "variables de entorno, entorno del shell, shell de inicio de sesión, env",
  // Ticket 1008: awaiting a native read.
  'field.envStripSecrets': "No pasar a los agentes variables que parecen secretas",
  'userEnv.stripDesc': "Las sesiones de Claude y Codex, y los shells que inicia un agente, empiezan sin las variables cuyo nombre contiene una palabra como KEY, TOKEN, SECRET, PASSWORD o AUTH. Las pestañas de shell que abres tú las conservan. Cada agente conserva sus propias variables de inicio de sesión.",
  'userEnv.leftOut': "Se omiten ahora: {names}.",
  'field.envKeepSecrets': "Variables que se pasan igualmente a los agentes",
  'userEnv.keepDesc': "Nombres exactos separados por espacios. Solo se guardan los nombres, nunca los valores.",
  'searchWords.envStripSecrets': "secretos, clave de API, token, contraseña, variables de entorno, env",
};
export const fr = {
  'userEnv.title': "Environnement du shell",
  'field.envInheritShell': "Utiliser l’environnement de mon shell de connexion",
  'userEnv.inheritDesc': "Claude, Codex et les onglets shell reçoivent les variables définies par votre shell de connexion. S’applique aux sessions lancées après la modification.",
  'field.envNames': "Variables transmises depuis votre shell",
  'userEnv.namesDesc': "Noms de variables séparés par des espaces. PATH, les paramètres régionaux et SSH_AUTH_SOCK sont toujours transmis.",
  'userEnv.failed': "L’environnement de votre shell de connexion n’a pas pu être lu ({error}) ; les sessions reçoivent donc celui de Nunchiro.",
  'searchWords.envInheritShell': "variables d'environnement, environnement du shell, shell de connexion, env",
  // Ticket 1008: awaiting a native read.
  'field.envStripSecrets': "Ne pas transmettre aux agents les variables qui semblent secrètes",
  'userEnv.stripDesc': "Les sessions Claude et Codex, ainsi que les shells lancés par un agent, démarrent sans les variables dont le nom contient un mot comme KEY, TOKEN, SECRET, PASSWORD ou AUTH. Les onglets shell que vous ouvrez les conservent. Chaque agent conserve ses propres variables de connexion.",
  'userEnv.leftOut': "Omises actuellement : {names}.",
  'field.envKeepSecrets': "Variables transmises malgré tout aux agents",
  'userEnv.keepDesc': "Noms exacts séparés par des espaces. Seuls les noms sont enregistrés, jamais les valeurs.",
  'searchWords.envStripSecrets': "secrets, clé d'API, jeton, mot de passe, variables d'environnement, env",
};
export const pt = {
  'userEnv.title': "Ambiente do shell",
  'field.envInheritShell': "Usar o ambiente do meu shell de login",
  'userEnv.inheritDesc': "Claude, Codex e as abas de shell recebem as variáveis definidas pelo seu shell de login. Vale para sessões iniciadas depois da mudança.",
  'field.envNames': "Variáveis passadas do seu shell",
  'userEnv.namesDesc': "Nomes de variáveis separados por espaços. PATH, localidade e SSH_AUTH_SOCK são sempre passados.",
  'userEnv.failed': "Não foi possível ler o ambiente do seu shell de login ({error}), então as sessões recebem o ambiente do próprio Nunchiro.",
  'searchWords.envInheritShell': "variáveis de ambiente, ambiente do shell, shell de login, env",
  // Ticket 1008: awaiting a native read.
  'field.envStripSecrets': "Não passar aos agentes variáveis que parecem secretas",
  'userEnv.stripDesc': "Sessões do Claude e do Codex, e shells que um agente inicia, começam sem as variáveis cujo nome contém uma palavra como KEY, TOKEN, SECRET, PASSWORD ou AUTH. As abas de shell que você abre as mantêm. Cada agente mantém suas próprias variáveis de login.",
  'userEnv.leftOut': "Omitidas agora: {names}.",
  'field.envKeepSecrets': "Variáveis passadas mesmo assim aos agentes",
  'userEnv.keepDesc': "Nomes exatos separados por espaços. Só os nomes são guardados, nunca os valores.",
  'searchWords.envStripSecrets': "segredos, chave de API, token, senha, variáveis de ambiente, env",
};
