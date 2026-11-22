// Ticket 304 (V2.5-82 nits): the board legend names each state by a glyph and a word, so its group label is "State key",
// not the colour key the legend was before the redraw.
declare module '../index' {
  interface AreaKeys {
    "board.legend.label": true;
  }
}

export const en = { "board.legend.label": "State key" };
export const ko = { "board.legend.label": "상태 키" };
export const ja = { "board.legend.label": "状態の凡例" };
export const zhHans = { "board.legend.label": "状态说明" };
export const zhHant = { "board.legend.label": "狀態說明" };
export const es = { "board.legend.label": "Leyenda de estados" };
export const fr = { "board.legend.label": "Légende des états" };
export const pt = { "board.legend.label": "Legenda de estados" };
