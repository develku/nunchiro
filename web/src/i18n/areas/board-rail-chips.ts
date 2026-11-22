// V2.5-60 follow-up (ticket 219, B13): the Board rail count is over all boards and ignores the Board's chips and search;
// when those show fewer cards its name says so. All eight languages (tests/i18n-translations.spec.ts wants every key in each).
declare module '../index' {
  interface AreaKeys {
    'board.railChips.scope': true;
  }
}

export const en = {
  'board.railChips.scope': 'all boards, whatever the filters and search show',
};

export const ko = {
  'board.railChips.scope': '모든 보드 기준, 필터와 검색과 무관',
};

export const ja = {
  'board.railChips.scope': 'すべてのボード対象、フィルターや検索に関係なし',
};

export const zhHans = {
  'board.railChips.scope': '统计所有看板，不受筛选和搜索影响',
};

export const zhHant = {
  'board.railChips.scope': '統計所有看板，不受篩選和搜尋影響',
};

export const es = {
  'board.railChips.scope': 'todos los tableros, sin importar filtros ni búsqueda',
};

export const fr = {
  'board.railChips.scope': 'tous les tableaux, quels que soient les filtres et la recherche',
};

export const pt = {
  'board.railChips.scope': 'todos os quadros, independentemente de filtros e busca',
};
