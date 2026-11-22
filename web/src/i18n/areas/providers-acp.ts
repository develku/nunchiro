// Ticket 358, mock #acplogin: an ACP agent's sign-in row in Settings > Accounts.
declare module '../index' {
  interface AreaKeys {
    'acpLogin.signIn': true;
    'acpLogin.agent': true;
    'acpLogin.terminal': true;
    'acpLogin.method': true;
    'acpLogin.waiting': true;
    'acpLogin.signing': true;
    'acpLogin.signed': true;
    'acpLogin.failed': true;
    'acpLogin.timedOut': true;
    'acpLogin.badLink': true;
    'acpLogin.checkFailed': true;
  }
}

export const en = {
  'acpLogin.signIn': 'Sign in',
  'acpLogin.agent': 'Agent login',
  'acpLogin.terminal': 'Terminal',
  'acpLogin.method': 'Sign-in method',
  'acpLogin.waiting': 'Waiting for the sign-in window the agent opened.',
  'acpLogin.signing': 'Signing in',
  'acpLogin.signed': 'Signed in',
  'acpLogin.failed': 'The sign-in did not finish.',
  'acpLogin.timedOut': 'The sign-in timed out.',
  'acpLogin.checkFailed': 'Could not read the sign-in state. Open this row again to retry.',
  'acpLogin.badLink': 'The agent sent a sign-in link that Nunchiro cannot open.',
};

export const ko = {
  'acpLogin.signIn': '로그인',
  'acpLogin.agent': '에이전트 로그인',
  'acpLogin.terminal': '터미널',
  'acpLogin.method': '로그인 방법',
  'acpLogin.waiting': '에이전트가 연 로그인 창을 기다리는 중입니다.',
  'acpLogin.signing': '로그인 중',
  'acpLogin.signed': '로그인됨',
  'acpLogin.failed': '로그인이 끝나지 않았습니다.',
  'acpLogin.timedOut': '로그인 시간이 지났습니다.',
  'acpLogin.checkFailed': '로그인 상태를 읽지 못했습니다. 이 행을 다시 열어 확인하세요.',
  'acpLogin.badLink': '에이전트가 보낸 로그인 링크를 Nunchiro가 열 수 없습니다.',
};

export const ja = {
  'acpLogin.signIn': 'ログイン',
  'acpLogin.agent': 'エージェントログイン',
  'acpLogin.terminal': 'ターミナル',
  'acpLogin.method': 'ログイン方法',
  'acpLogin.waiting': 'エージェントが開いたログイン画面を待っています。',
  'acpLogin.signing': 'ログイン中',
  'acpLogin.signed': 'ログイン済み',
  'acpLogin.failed': 'ログインは完了しませんでした。',
  'acpLogin.timedOut': 'ログインがタイムアウトしました。',
  'acpLogin.checkFailed': 'ログイン状態を読み取れませんでした。この行を開き直して再試行してください。',
  'acpLogin.badLink': 'エージェントが送ったログインリンクは Nunchiro では開けません。',
};

export const zhHans = {
  'acpLogin.signIn': '登录',
  'acpLogin.agent': '代理登录',
  'acpLogin.terminal': '终端',
  'acpLogin.method': '登录方式',
  'acpLogin.waiting': '正在等待代理打开的登录窗口。',
  'acpLogin.signing': '登录中',
  'acpLogin.signed': '已登录',
  'acpLogin.failed': '登录未完成。',
  'acpLogin.timedOut': '登录已超时。',
  'acpLogin.checkFailed': '无法读取登录状态。请重新打开此行再试。',
  'acpLogin.badLink': '代理发来的登录链接 Nunchiro 无法打开。',
};

export const zhHant = {
  'acpLogin.signIn': '登入',
  'acpLogin.agent': '代理登入',
  'acpLogin.terminal': '終端',
  'acpLogin.method': '登入方式',
  'acpLogin.waiting': '正在等待代理開啟的登入視窗。',
  'acpLogin.signing': '登入中',
  'acpLogin.signed': '已登入',
  'acpLogin.failed': '登入未完成。',
  'acpLogin.timedOut': '登入已逾時。',
  'acpLogin.checkFailed': '無法讀取登入狀態。請重新開啟此列再試。',
  'acpLogin.badLink': '代理傳送的登入連結，Nunchiro 無法開啟。',
};

export const es = {
  'acpLogin.signIn': 'Iniciar sesión',
  'acpLogin.agent': 'Inicio de sesión del agente',
  'acpLogin.terminal': 'Terminal',
  'acpLogin.method': 'Método de inicio de sesión',
  'acpLogin.waiting': 'Esperando la ventana de inicio de sesión que abrió el agente.',
  'acpLogin.signing': 'Iniciando sesión',
  'acpLogin.signed': 'Sesión iniciada',
  'acpLogin.failed': 'El inicio de sesión no terminó.',
  'acpLogin.timedOut': 'El inicio de sesión caducó.',
  'acpLogin.checkFailed': 'No se pudo leer el estado de la sesión. Abre esta fila otra vez para reintentar.',
  'acpLogin.badLink': 'El agente envió un enlace de inicio de sesión que Nunchiro no puede abrir.',
};

export const fr = {
  'acpLogin.signIn': 'Se connecter',
  'acpLogin.agent': 'Connexion de l’agent',
  'acpLogin.terminal': 'Terminal',
  'acpLogin.method': 'Méthode de connexion',
  'acpLogin.waiting': 'En attente de la fenêtre de connexion ouverte par l’agent.',
  'acpLogin.signing': 'Connexion en cours',
  'acpLogin.signed': 'Connecté',
  'acpLogin.failed': 'La connexion n’a pas abouti.',
  'acpLogin.timedOut': 'La connexion a expiré.',
  'acpLogin.checkFailed': 'Impossible de lire l’état de connexion. Rouvrez cette ligne pour réessayer.',
  'acpLogin.badLink': 'L’agent a envoyé un lien de connexion que Nunchiro ne peut pas ouvrir.',
};

export const pt = {
  'acpLogin.signIn': 'Entrar',
  'acpLogin.agent': 'Login do agente',
  'acpLogin.terminal': 'Terminal',
  'acpLogin.method': 'Método de login',
  'acpLogin.waiting': 'Aguardando a janela de login aberta pelo agente.',
  'acpLogin.signing': 'Entrando',
  'acpLogin.signed': 'Conectado',
  'acpLogin.failed': 'O login não terminou.',
  'acpLogin.timedOut': 'O login expirou.',
  'acpLogin.checkFailed': 'Não foi possível ler o estado do login. Abra esta linha de novo para tentar outra vez.',
  'acpLogin.badLink': 'O agente enviou um link de login que o Nunchiro não consegue abrir.',
};
