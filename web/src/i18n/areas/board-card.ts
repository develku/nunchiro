// needs 171 (audit Board row 1): an integration card's link, named before the click (tooltip and accessible name).
// board.ts holds the keys written before area files existed (i18n-board-catalogue pins it), so new board keys live here.
declare module '../index' {
  interface AreaKeys {
    "board.card.ariaLink": true;
    "board.card.opensLink": true;
    "board.card.openSession": true;
    "board.menu.open": true;
    "board.menu.edit": true;
    "board.menu.next": true;
    "board.menu.prev": true;
    "board.menu.pr": true;
    "board.menu.delete": true;
    "board.filter.hideIdle": true;
    "board.search.label": true;
    "board.search.placeholder": true;
    "board.search.clear": true;
    "board.project.find": true;
    "board.project.none": true;
  }
}

export const en = {
  "board.card.ariaLink": ", opens {host}",
  "board.card.opensLink": "Opens {host} in your browser",
  "board.card.openSession": "Open session {label}",
  "board.menu.open": "Open card",
  "board.menu.edit": "Edit card",
  "board.menu.next": "Move to next column",
  "board.menu.prev": "Move to previous column",
  "board.menu.pr": "Open pull request",
  "board.menu.delete": "Delete card",
  "board.filter.hideIdle": "Hide idle",
  "board.search.label": "Search cards",
  "board.search.placeholder": "Search cards",
  "board.search.clear": "Clear search",
  "board.project.find": "Find project",
  "board.project.none": "No project matches",
};

export const ko = {
  "board.card.ariaLink": ", {host} 열기",
  "board.card.opensLink": "브라우저에서 {host} 열기",
  "board.card.openSession": "세션 {label} 열기",
  "board.menu.open": "카드 열기",
  "board.menu.edit": "카드 편집",
  "board.menu.next": "다음 열로 옮기기",
  "board.menu.prev": "이전 열로 옮기기",
  "board.menu.pr": "풀 리퀘스트 열기",
  "board.menu.delete": "카드 삭제",
  "board.filter.hideIdle": "쉬는 카드 숨기기",
  "board.search.label": "카드 검색",
  "board.search.placeholder": "카드 검색",
  "board.search.clear": "검색어 지우기",
  "board.project.find": "프로젝트 찾기",
  "board.project.none": "일치하는 프로젝트 없음",
};

export const ja = {
  "board.card.ariaLink": "、{host} を開きます",
  "board.card.opensLink": "ブラウザで {host} を開きます",
  "board.card.openSession": "セッション {label} を開く",
  "board.menu.open": "カードを開く",
  "board.menu.edit": "カードを編集",
  "board.menu.next": "次の列へ移動",
  "board.menu.prev": "前の列へ移動",
  "board.menu.pr": "プルリクエストを開く",
  "board.menu.delete": "カードを削除",
  "board.filter.hideIdle": "アイドルを隠す",
  "board.search.label": "カードを検索",
  "board.search.placeholder": "カードを検索",
  "board.search.clear": "検索をクリア",
  "board.project.find": "プロジェクトを探す",
  "board.project.none": "該当するプロジェクトなし",
};

export const zhHans = {
  "board.card.ariaLink": "，打开 {host}",
  "board.card.opensLink": "在浏览器中打开 {host}",
  "board.card.openSession": "打开会话 {label}",
  "board.menu.open": "打开卡片",
  "board.menu.edit": "编辑卡片",
  "board.menu.next": "移到下一列",
  "board.menu.prev": "移到上一列",
  "board.menu.pr": "打开拉取请求",
  "board.menu.delete": "删除卡片",
  "board.filter.hideIdle": "隐藏空闲",
  "board.search.label": "搜索卡片",
  "board.search.placeholder": "搜索卡片",
  "board.search.clear": "清除搜索",
  "board.project.find": "查找项目",
  "board.project.none": "没有匹配的项目",
};

export const zhHant = {
  "board.card.ariaLink": "，開啟 {host}",
  "board.card.opensLink": "在瀏覽器中開啟 {host}",
  "board.card.openSession": "開啟工作階段 {label}",
  "board.menu.open": "開啟卡片",
  "board.menu.edit": "編輯卡片",
  "board.menu.next": "移到下一欄",
  "board.menu.prev": "移到上一欄",
  "board.menu.pr": "開啟 Pull Request",
  "board.menu.delete": "刪除卡片",
  "board.filter.hideIdle": "隱藏閒置",
  "board.search.label": "搜尋卡片",
  "board.search.placeholder": "搜尋卡片",
  "board.search.clear": "清除搜尋",
  "board.project.find": "尋找專案",
  "board.project.none": "沒有符合的專案",
};

export const es = {
  "board.card.ariaLink": ", abre {host}",
  "board.card.opensLink": "Abre {host} en tu navegador",
  "board.card.openSession": "Abrir la sesión {label}",
  "board.menu.open": "Abrir tarjeta",
  "board.menu.edit": "Editar tarjeta",
  "board.menu.next": "Mover a la columna siguiente",
  "board.menu.prev": "Mover a la columna anterior",
  "board.menu.pr": "Abrir el pull request",
  "board.menu.delete": "Eliminar tarjeta",
  "board.filter.hideIdle": "Ocultar inactivas",
  "board.search.label": "Buscar tarjetas",
  "board.search.placeholder": "Buscar tarjetas",
  "board.search.clear": "Borrar búsqueda",
  "board.project.find": "Buscar proyecto",
  "board.project.none": "Ningún proyecto coincide",
};

export const fr = {
  "board.card.ariaLink": ", ouvre {host}",
  "board.card.opensLink": "Ouvre {host} dans votre navigateur",
  "board.card.openSession": "Ouvrir la session {label}",
  "board.menu.open": "Ouvrir la carte",
  "board.menu.edit": "Modifier la carte",
  "board.menu.next": "Déplacer vers la colonne suivante",
  "board.menu.prev": "Déplacer vers la colonne précédente",
  "board.menu.pr": "Ouvrir la pull request",
  "board.menu.delete": "Supprimer la carte",
  "board.filter.hideIdle": "Masquer les inactives",
  "board.search.label": "Rechercher des cartes",
  "board.search.placeholder": "Rechercher des cartes",
  "board.search.clear": "Effacer la recherche",
  "board.project.find": "Trouver un projet",
  "board.project.none": "Aucun projet ne correspond",
};

export const pt = {
  "board.card.ariaLink": ", abre {host}",
  "board.card.opensLink": "Abre {host} no seu navegador",
  "board.card.openSession": "Abrir a sessão {label}",
  "board.menu.open": "Abrir cartão",
  "board.menu.edit": "Editar cartão",
  "board.menu.next": "Mover para a próxima coluna",
  "board.menu.prev": "Mover para a coluna anterior",
  "board.menu.pr": "Abrir o pull request",
  "board.menu.delete": "Excluir cartão",
  "board.filter.hideIdle": "Ocultar inativos",
  "board.search.label": "Buscar cartões",
  "board.search.placeholder": "Buscar cartões",
  "board.search.clear": "Limpar busca",
  "board.project.find": "Encontrar projeto",
  "board.project.none": "Nenhum projeto corresponde",
};
