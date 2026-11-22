// Ticket 810 (first-use walk 10, Korean walk): the composer picker's refusal reasons (picker/blocked.ts) were English
// literals in a Korean window, as its tooltip and inside its accessible name.
declare module '../index' {
  interface AreaKeys {
    'walk10.picker.disconnected': true;
    'walk10.picker.noSession': true;
    'walk10.picker.notRunning': true;
    'walk10.picker.switching': true;
    'walk10.picker.modeWalk': true;
    'walk10.picker.notIdle': true;
  }
}

export const en = {
  'walk10.picker.disconnected': 'disconnected from Nunchiro',
  'walk10.picker.noSession': 'open a session first',
  'walk10.picker.notRunning': 'the session is not running',
  'walk10.picker.switching': 'switching…',
  'walk10.picker.modeWalk': 'a mode change is in progress',
  'walk10.picker.notIdle': 'switch when the agent is idle (now {status})',
};

export const ko = {
  'walk10.picker.disconnected': 'Nunchiro와 연결이 끊겼습니다',
  'walk10.picker.noSession': '먼저 세션을 여세요',
  'walk10.picker.notRunning': '세션이 실행 중이 아닙니다',
  'walk10.picker.switching': '바꾸는 중…',
  'walk10.picker.modeWalk': '모드를 바꾸는 중입니다',
  'walk10.picker.notIdle': '에이전트가 쉬고 있을 때 바꾸세요 (지금: {status})',
};

export const ja = {
  'walk10.picker.disconnected': 'Nunchiro との接続が切れています',
  'walk10.picker.noSession': '先にセッションを開いてください',
  'walk10.picker.notRunning': 'セッションは実行中ではありません',
  'walk10.picker.switching': '切り替え中…',
  'walk10.picker.modeWalk': 'モードを切り替えています',
  'walk10.picker.notIdle': 'エージェントがアイドルのときに切り替えてください（現在：{status}）',
};

export const zhHans = {
  'walk10.picker.disconnected': '与 Nunchiro 的连接已断开',
  'walk10.picker.noSession': '请先打开一个会话',
  'walk10.picker.notRunning': '会话未在运行',
  'walk10.picker.switching': '正在切换…',
  'walk10.picker.modeWalk': '正在切换模式',
  'walk10.picker.notIdle': '请在代理空闲时切换（当前：{status}）',
};

export const zhHant = {
  'walk10.picker.disconnected': '與 Nunchiro 的連線已中斷',
  'walk10.picker.noSession': '請先開啟一個工作階段',
  'walk10.picker.notRunning': '工作階段未在執行',
  'walk10.picker.switching': '正在切換…',
  'walk10.picker.modeWalk': '正在切換模式',
  'walk10.picker.notIdle': '請在代理閒置時切換（目前：{status}）',
};

export const es = {
  'walk10.picker.disconnected': 'sin conexión con Nunchiro',
  'walk10.picker.noSession': 'abre primero una sesión',
  'walk10.picker.notRunning': 'la sesión no está en marcha',
  'walk10.picker.switching': 'cambiando…',
  'walk10.picker.modeWalk': 'se está cambiando el modo',
  'walk10.picker.notIdle': 'cambia cuando el agente esté inactivo (ahora: {status})',
};

export const fr = {
  'walk10.picker.disconnected': 'déconnecté de Nunchiro',
  'walk10.picker.noSession': 'ouvrez d’abord une session',
  'walk10.picker.notRunning': 'la session n’est pas en cours',
  'walk10.picker.switching': 'changement…',
  'walk10.picker.modeWalk': 'un changement de mode est en cours',
  'walk10.picker.notIdle': 'changez quand l’agent est inactif (actuellement : {status})',
};

export const pt = {
  'walk10.picker.disconnected': "desconectado do Nunchiro",
  'walk10.picker.noSession': 'abra primeiro uma sessão',
  'walk10.picker.notRunning': 'a sessão não está em execução',
  'walk10.picker.switching': "mudando…",
  'walk10.picker.modeWalk': "uma mudança de modo está em andamento",
  'walk10.picker.notIdle': "mude quando o agente estiver ocioso (agora: {status})",
};
