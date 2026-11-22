// v25-space-switch-fu (V2.5-82): a Browser space another mounted pane already shows is listed but disabled in the switcher,
// because there is one native webview per space. The hover name reuses `exitWidgets.spaces`.
declare module '../index' {
  interface AreaKeys {
    'spaceSwitchFu.shownElsewhere': true;
  }
}

export const en = { 'spaceSwitchFu.shownElsewhere': '{name} - shown in another pane' };
export const ko = { 'spaceSwitchFu.shownElsewhere': '{name} - 다른 패널에 표시 중' };
export const ja = { 'spaceSwitchFu.shownElsewhere': '{name} - 別のペインで表示中' };
export const zhHans = { 'spaceSwitchFu.shownElsewhere': '{name} - 已在另一个窗格中显示' };
export const zhHant = { 'spaceSwitchFu.shownElsewhere': '{name} - 已在另一個面板中顯示' };
export const es = { 'spaceSwitchFu.shownElsewhere': '{name} - se muestra en otro panel' };
export const fr = { 'spaceSwitchFu.shownElsewhere': '{name} - affiché dans un autre volet' };
export const pt = { 'spaceSwitchFu.shownElsewhere': '{name} - exibido em outro painel' };
