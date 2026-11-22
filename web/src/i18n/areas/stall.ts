// Ticket 1004: the card for a task that stalled (two check-ins of its seats with nothing moved, or the same error three
// times). English is the source; the other seven are drafts for a native read.
declare module '../index' {
  interface AreaKeys {
    'stall.title': true;
    'stall.quiet': true;
    'stall.error': true;
  }
}

export const en = {
  'stall.title': "Stuck: {title}",
  'stall.quiet': "{seat} finished two turns in a row and nothing changed",
  'stall.error': "{seat} stopped on: {error}",
};
export const ko = {
  'stall.title': "멈춤: {title}",
  'stall.quiet': "{seat}이(가) 두 번 연속으로 턴을 끝냈지만 바뀐 것이 없습니다",
  'stall.error': "{seat}이(가) 다음 오류에서 멈췄습니다: {error}",
};
export const ja = {
  'stall.title': "停滞：{title}",
  'stall.quiet': "{seat} は 2 回続けてターンを終えましたが、何も変わっていません",
  'stall.error': "{seat} は次のエラーで止まりました：{error}",
};
export const zhHans = {
  'stall.title': "停滞：{title}",
  'stall.quiet': "{seat} 连续两次结束回合，但没有任何变化",
  'stall.error': "{seat} 停在此错误：{error}",
};
export const zhHant = {
  'stall.title': "停滯：{title}",
  'stall.quiet': "{seat} 連續兩次結束回合，但沒有任何變化",
  'stall.error': "{seat} 停在此錯誤：{error}",
};
export const es = {
  'stall.title': "Atascada: {title}",
  'stall.quiet': "{seat} terminó dos turnos seguidos y nada cambió",
  'stall.error': "{seat} se detuvo en: {error}",
};
export const fr = {
  'stall.title': "Bloquée : {title}",
  'stall.quiet': "{seat} a terminé deux tours de suite et rien n’a changé",
  'stall.error': "{seat} s’est arrêté sur : {error}",
};
export const pt = {
  'stall.title': "Parada: {title}",
  'stall.quiet': "{seat} terminou dois turnos seguidos e nada mudou",
  'stall.error': "{seat} parou em: {error}",
};
