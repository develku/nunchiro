// Ticket 494: a Providers row whose own status check came back with no answer says so, why when known, the way on, and
// when it last ran (so a Check that gives the same answer still shows that it ran).
declare module '../index' {
  interface AreaKeys {
    'providers.checkFail.noAnswer': true;
    'providers.checkFail.error': true;
    'providers.checkFail.next': true;
    'providers.checkFail.at': true;
  }
}
export const en = {
  'providers.checkFail.noAnswer': "{name}'s status command gave no answer, so its sign-in is not known.",
  'providers.checkFail.error': "The check could not run: {error}",
  'providers.checkFail.next': "Sign in, or run {name} once in a terminal, then Check again.",
  'providers.checkFail.at': "Checked at {time}",
};
export const ko = {
  'providers.checkFail.noAnswer': "{name}의 상태 명령이 답하지 않아 로그인 상태를 알 수 없습니다.",
  'providers.checkFail.error': "확인을 실행하지 못했습니다: {error}",
  'providers.checkFail.next': "로그인하거나 터미널에서 {name}을(를) 한 번 실행한 뒤 다시 확인하세요.",
  'providers.checkFail.at': "{time}에 확인함",
};
export const ja = {
  'providers.checkFail.noAnswer': "{name} の状態コマンドが応答しなかったため、ログイン状態が分かりません。",
  'providers.checkFail.error': "確認を実行できませんでした：{error}",
  'providers.checkFail.next': "ログインするか、ターミナルで {name} を一度実行してから、もう一度確認してください。",
  'providers.checkFail.at': "{time} に確認",
};
export const zhHans = {
  'providers.checkFail.noAnswer': "{name} 的状态命令没有应答，因此不知道登录状态。",
  'providers.checkFail.error': "无法运行检查：{error}",
  'providers.checkFail.next': "请登录，或在终端中运行一次 {name}，然后再检查。",
  'providers.checkFail.at': "检查于 {time}",
};
export const zhHant = {
  'providers.checkFail.noAnswer': "{name} 的狀態指令沒有回應，因此不知道登入狀態。",
  'providers.checkFail.error': "無法執行檢查：{error}",
  'providers.checkFail.next': "請登入，或在終端中執行一次 {name}，然後再檢查。",
  'providers.checkFail.at': "檢查時間：{time}",
};
export const es = {
  'providers.checkFail.noAnswer': "El comando de estado de {name} no respondió, así que no se sabe si la sesión está iniciada.",
  'providers.checkFail.error': "No se pudo hacer la comprobación: {error}",
  'providers.checkFail.next': "Inicia sesión, o ejecuta {name} una vez en un terminal, y vuelve a comprobar.",
  'providers.checkFail.at': "Comprobado a las {time}",
};
export const fr = {
  'providers.checkFail.noAnswer': "La commande d’état de {name} n’a pas répondu : la connexion n’est pas connue.",
  'providers.checkFail.error': "La vérification n’a pas pu être exécutée : {error}",
  'providers.checkFail.next': "Connectez-vous, ou lancez {name} une fois dans un terminal, puis vérifiez à nouveau.",
  'providers.checkFail.at': "Vérifié à {time}",
};
export const pt = {
  'providers.checkFail.noAnswer': "O comando de status do {name} não respondeu, então não se sabe se o login foi feito.",
  'providers.checkFail.error': "Não foi possível fazer a verificação: {error}",
  'providers.checkFail.next': "Entre, ou execute o {name} uma vez em um terminal, e depois pressione Verificar novamente.",
  'providers.checkFail.at': "Verificado às {time}",
};
