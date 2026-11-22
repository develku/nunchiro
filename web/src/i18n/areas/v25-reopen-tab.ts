// v25-reopen-tab (ticket 299): Reopen closed tab (⇧⌘T), in the tab's right-click menu, the "+" popover and the palette.
declare module '../index' {
  interface AreaKeys {
    "reopen.cmd": true;
    "reopen.none": true;
  }
}

export const en = {
  "reopen.cmd": "Reopen closed tab",
  "reopen.none": "No tab was closed in this window yet",
};

export const ko = {
  "reopen.cmd": "닫은 탭 다시 열기",
  "reopen.none": "이 창에서 닫은 탭이 아직 없습니다",
};

export const ja = {
  "reopen.cmd": "閉じたタブを開き直す",
  "reopen.none": "このウィンドウで閉じたタブはまだありません",
};

export const zhHans = {
  "reopen.cmd": "重新打开已关闭的选项卡",
  "reopen.none": "此窗口还没有关闭过选项卡",
};

export const zhHant = {
  "reopen.cmd": "重新開啟已關閉的選項卡",
  "reopen.none": "此視窗尚未關閉過選項卡",
};

export const es = {
  "reopen.cmd": "Reabrir la pestaña cerrada",
  "reopen.none": "Aún no se ha cerrado ninguna pestaña en esta ventana",
};

export const fr = {
  "reopen.cmd": "Rouvrir l’onglet fermé",
  "reopen.none": "Aucun onglet n’a encore été fermé dans cette fenêtre",
};

export const pt = {
  "reopen.cmd": "Reabrir a aba fechada",
  "reopen.none": "Nenhuma aba foi fechada nesta janela ainda",
};
