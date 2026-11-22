// V2.5-82 (ticket 297 items 1-3, 5, board watch leftovers): the detail's resize and maximise controls, the subagent list's name and the card menu's
// reasons at the ends of Move next / Move previous. New keys live here; every language has every key. Every key here has a reader
// (web/tests/board-watch-keys.spec.ts fails on one that has none).
declare module '../index' {
  interface AreaKeys {
    "board.watch.resize": true;
    "board.watch.resizeTip": true;
    "board.watch.maximise": true;
    "board.watch.restore": true;
    "board.watch.subs.list": true;
    "board.watch.move.nextWhy": true;
    "board.watch.move.prevWhy": true;
  }
}

export const en = {
  "board.watch.resize": "Resize the card detail",
  "board.watch.resizeTip": "Drag to resize · double-click for the default width",
  "board.watch.maximise": "Maximise detail",
  "board.watch.restore": "Restore detail size",
  "board.watch.subs.list": "Subagents of {title}",
  "board.watch.move.nextWhy": "Already in the last column, or this card cannot be moved",
  "board.watch.move.prevWhy": "Already in the first column, or this card cannot be moved",
};

export const ko = {
  "board.watch.resize": "카드 상세 크기 조절",
  "board.watch.resizeTip": "끌어서 크기 조절 · 두 번 클릭하면 기본 너비",
  "board.watch.maximise": "상세 최대화",
  "board.watch.restore": "상세 크기 복원",
  "board.watch.subs.list": "{title}의 하위 에이전트",
  "board.watch.move.nextWhy": "이미 마지막 열에 있거나 이 카드는 옮길 수 없습니다",
  "board.watch.move.prevWhy": "이미 첫 번째 열에 있거나 이 카드는 옮길 수 없습니다",
};

export const ja = {
  "board.watch.resize": "カード詳細のサイズ変更",
  "board.watch.resizeTip": "ドラッグでサイズ変更 · ダブルクリックでデフォルトの幅",
  "board.watch.maximise": "詳細を最大化",
  "board.watch.restore": "詳細のサイズを元に戻す",
  "board.watch.subs.list": "{title} のサブエージェント",
  "board.watch.move.nextWhy": "すでに最後の列にあるか、このカードは移動できません",
  "board.watch.move.prevWhy": "すでに最初の列にあるか、このカードは移動できません",
};

export const zhHans = {
  "board.watch.resize": "调整卡片详情大小",
  "board.watch.resizeTip": "拖动调整大小 · 双击恢复默认宽度",
  "board.watch.maximise": "最大化详情",
  "board.watch.restore": "还原详情大小",
  "board.watch.subs.list": "{title} 的子代理",
  "board.watch.move.nextWhy": "已在最后一列，或此卡片无法移动",
  "board.watch.move.prevWhy": "已在第一列，或此卡片无法移动",
};

export const zhHant = {
  "board.watch.resize": "調整卡片詳情大小",
  "board.watch.resizeTip": "拖曳調整大小 · 按兩下恢復預設寬度",
  "board.watch.maximise": "最大化詳情",
  "board.watch.restore": "還原詳情大小",
  "board.watch.subs.list": "{title} 的子代理",
  "board.watch.move.nextWhy": "已在最後一欄，或此卡片無法移動",
  "board.watch.move.prevWhy": "已在第一欄，或此卡片無法移動",
};

export const es = {
  "board.watch.resize": "Cambiar el tamaño del detalle de la tarjeta",
  "board.watch.resizeTip": "Arrastra para cambiar el tamaño · doble clic para el ancho predeterminado",
  "board.watch.maximise": "Maximizar detalle",
  "board.watch.restore": "Restaurar el tamaño del detalle",
  "board.watch.subs.list": "Subagentes de {title}",
  "board.watch.move.nextWhy": "Ya está en la última columna, o esta tarjeta no se puede mover",
  "board.watch.move.prevWhy": "Ya está en la primera columna, o esta tarjeta no se puede mover",
};

export const fr = {
  "board.watch.resize": "Redimensionner le détail de la carte",
  "board.watch.resizeTip": "Glisser pour redimensionner · double-clic pour la largeur par défaut",
  "board.watch.maximise": "Agrandir le détail",
  "board.watch.restore": "Restaurer la taille du détail",
  "board.watch.subs.list": "Sous-agents de {title}",
  "board.watch.move.nextWhy": "Déjà dans la dernière colonne, ou cette carte ne peut pas être déplacée",
  "board.watch.move.prevWhy": "Déjà dans la première colonne, ou cette carte ne peut pas être déplacée",
};

export const pt = {
  "board.watch.resize": "Redimensionar o detalhe do cartão",
  "board.watch.resizeTip": "Arraste para redimensionar · clique duas vezes para a largura padrão",
  "board.watch.maximise": "Maximizar detalhe",
  "board.watch.restore": "Restaurar o tamanho do detalhe",
  "board.watch.subs.list": "Subagentes de {title}",
  "board.watch.move.nextWhy": "Já está na última coluna, ou este cartão não pode ser movido",
  "board.watch.move.prevWhy": "Já está na primeira coluna, ou este cartão não pode ser movido",
};
