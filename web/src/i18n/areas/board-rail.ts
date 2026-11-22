// V2.5-60 (ticket 219, B13): the Board rail icon's count of cards that need the owner. All eight languages
// (tests/i18n-translations.spec.ts wants every key in each).
declare module '../index' {
  interface AreaKeys {
    'board.rail.needsYou.one': true;
    'board.rail.needsYou.other': true;
  }
}

export const en = {
  'board.rail.needsYou.one': '{n} card needs you',
  'board.rail.needsYou.other': '{n} cards need you',
};

export const ko = {
  'board.rail.needsYou.one': '내 답 대기 카드 {n}개',
  'board.rail.needsYou.other': '내 답 대기 카드 {n}개',
};

export const ja = {
  'board.rail.needsYou.one': '要対応のカード {n} 件',
  'board.rail.needsYou.other': '要対応のカード {n} 件',
};

export const zhHans = {
  'board.rail.needsYou.one': '{n} 张卡片等你处理',
  'board.rail.needsYou.other': '{n} 张卡片等你处理',
};

export const zhHant = {
  'board.rail.needsYou.one': '{n} 張卡片需要你處理',
  'board.rail.needsYou.other': '{n} 張卡片需要你處理',
};

export const es = {
  'board.rail.needsYou.one': '{n} tarjeta te necesita',
  'board.rail.needsYou.other': '{n} tarjetas te necesitan',
};

export const fr = {
  'board.rail.needsYou.one': '{n} carte a besoin de vous',
  'board.rail.needsYou.other': '{n} cartes ont besoin de vous',
};

export const pt = {
  'board.rail.needsYou.one': '{n} cartão precisa de você',
  'board.rail.needsYou.other': '{n} cartões precisam de você',
};
