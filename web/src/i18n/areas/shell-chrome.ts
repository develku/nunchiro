// v25-shell-chrome (tickets 283, 282, needs 205-207, 213): the Icon bar's hide / show button and (ticket 1052, restored) edge, the Sidebar edge, the two
// Sidebar width commands, Restart session, the waiting dot's name. All eight languages (tests/i18n-translations.spec.ts wants every key in each).
declare module '../index' {
  interface AreaKeys {
    'shell.chrome.hideLeft': true;
    'shell.chrome.showLeft': true;
    'shell.chrome.hideRight': true;
    'shell.chrome.showRight': true;
    'shell.chrome.barEdge': true;
    'shell.chrome.barEdgeTitle': true;
    'shell.chrome.sidebarEdgeTitle': true;
    'shell.chrome.sidebarsWider': true;
    'shell.chrome.sidebarsNarrower': true;
    'shell.chrome.sidebarRightToggle': true;
    'shell.chrome.barsToggle': true;
    'shell.chrome.barsAutohide': true;
    'field.barsAutohide': true;
    'shell.chrome.barsAutohideDesc': true;
    'shell.chrome.autoHideBars': true;
    'shell.chrome.restartSession': true;
    'shell.chrome.resumeSession': true;
    'shell.chrome.notRestarted': true;
    'shell.chrome.waiting': true;
  }
}

export const en = {
  'shell.chrome.hideLeft': 'Hide left sidebar',
  'shell.chrome.showLeft': 'Show left sidebar',
  'shell.chrome.hideRight': 'Hide right sidebar',
  'shell.chrome.showRight': 'Show right sidebar',
  'shell.chrome.barEdge': 'Resize the icon bars',
  'shell.chrome.barEdgeTitle': 'Drag to narrow or widen both icon bars · double-click for the default ({width} px)',
  'shell.chrome.sidebarEdgeTitle': 'Drag to resize both sidebars · double-click for the default width',
  'shell.chrome.sidebarsWider': 'Sidebars wider',
  'shell.chrome.sidebarsNarrower': 'Sidebars narrower',
  'shell.chrome.sidebarRightToggle': 'Show or hide the right sidebar',
  'shell.chrome.barsToggle': 'Show or hide the icon bars',
  'shell.chrome.barsAutohide': 'Auto-hide the icon bars',
  'field.barsAutohide': 'Auto-hide the icon bars',
  'shell.chrome.barsAutohideDesc': 'The icon bars slide away and come back when the pointer reaches the left or right edge of the window, or when keyboard focus enters them. Off by default.',
  'shell.chrome.autoHideBars': 'Auto-hide icon bars', // ticket 1093: the left bar's toggle and its command; English only until ticket 1035
  'shell.chrome.restartSession': 'Restart session',
  'shell.chrome.resumeSession': 'Resume session',
  'shell.chrome.notRestarted': 'Not restarted: {error}',
  'shell.chrome.waiting': 'waiting for you',
};

export const ko = {
  'shell.chrome.hideLeft': '왼쪽 사이드바 숨기기',
  'shell.chrome.showLeft': '왼쪽 사이드바 보기',
  'shell.chrome.hideRight': '오른쪽 사이드바 숨기기',
  'shell.chrome.showRight': '오른쪽 사이드바 보기',
  'shell.chrome.barEdge': "아이콘 바 너비 조절",
  'shell.chrome.barEdgeTitle': "끌어서 두 아이콘 바의 너비를 조절 · 더블클릭하면 기본값({width}px)",
  'shell.chrome.sidebarEdgeTitle': '끌어서 두 사이드바의 너비를 함께 조절 · 더블클릭하면 기본 너비',
  'shell.chrome.sidebarsWider': '사이드바 넓게',
  'shell.chrome.sidebarsNarrower': '사이드바 좁게',
  'shell.chrome.sidebarRightToggle': '오른쪽 사이드바 보기·숨기기',
  'shell.chrome.barsToggle': "아이콘 바 보이기·숨기기",
  'shell.chrome.restartSession': '세션 다시 시작',
  'shell.chrome.resumeSession': '세션 재개',
  'shell.chrome.notRestarted': '다시 시작하지 못함: {error}',
  'shell.chrome.waiting': '내 답 대기',
};

export const ja = {
  'shell.chrome.hideLeft': '左サイドバーを隠す',
  'shell.chrome.showLeft': '左サイドバーを表示',
  'shell.chrome.hideRight': '右サイドバーを隠す',
  'shell.chrome.showRight': '右サイドバーを表示',
  'shell.chrome.barEdge': 'アイコンバーの幅を変更',
  'shell.chrome.barEdgeTitle': 'ドラッグで両方のアイコンバーの幅を変更 · ダブルクリックでデフォルト値（{width} px）',
  'shell.chrome.sidebarEdgeTitle': 'ドラッグで両方のサイドバーの幅を変更 · ダブルクリックでデフォルトの幅',
  'shell.chrome.sidebarsWider': 'サイドバーを広げる',
  'shell.chrome.sidebarsNarrower': 'サイドバーを狭める',
  'shell.chrome.sidebarRightToggle': '右のサイドバーを表示・非表示',
  'shell.chrome.barsToggle': 'アイコンバーを表示・非表示',
  'shell.chrome.restartSession': 'セッションを再起動',
  'shell.chrome.resumeSession': 'セッションを再開',
  'shell.chrome.notRestarted': '再起動できませんでした：{error}',
  'shell.chrome.waiting': 'あなたの対応待ち',
};

export const zhHans = {
  'shell.chrome.hideLeft': '隐藏左侧边栏',
  'shell.chrome.showLeft': '显示左侧边栏',
  'shell.chrome.hideRight': '隐藏右侧边栏',
  'shell.chrome.showRight': '显示右侧边栏',
  'shell.chrome.barEdge': '调整图标栏宽度',
  'shell.chrome.barEdgeTitle': '拖动可同时调整两个图标栏的宽度 · 双击恢复默认值 ({width} px)',
  'shell.chrome.sidebarEdgeTitle': '拖动可同时调整两个侧边栏的宽度 · 双击恢复默认宽度',
  'shell.chrome.sidebarsWider': '加宽侧边栏',
  'shell.chrome.sidebarsNarrower': '收窄侧边栏',
  'shell.chrome.sidebarRightToggle': '显示或隐藏右侧边栏',
  'shell.chrome.barsToggle': '显示或隐藏图标栏',
  'shell.chrome.restartSession': '重新启动会话',
  'shell.chrome.resumeSession': '恢复会话',
  'shell.chrome.notRestarted': '未能重新启动：{error}',
  'shell.chrome.waiting': '等待你处理',
};

export const zhHant = {
  'shell.chrome.hideLeft': '隱藏左側邊欄',
  'shell.chrome.showLeft': '顯示左側邊欄',
  'shell.chrome.hideRight': '隱藏右側邊欄',
  'shell.chrome.showRight': '顯示右側邊欄',
  'shell.chrome.barEdge': '調整圖示欄寬度',
  'shell.chrome.barEdgeTitle': '拖曳可同時調整兩個圖示欄的寬度 · 按兩下恢復預設值（{width} px）',
  'shell.chrome.sidebarEdgeTitle': '拖曳可同時調整兩個側邊欄的寬度 · 按兩下恢復預設寬度',
  'shell.chrome.sidebarsWider': '加寬側邊欄',
  'shell.chrome.sidebarsNarrower': '縮窄側邊欄',
  'shell.chrome.sidebarRightToggle': '顯示或隱藏右側邊欄',
  'shell.chrome.barsToggle': '顯示或隱藏圖示欄',
  'shell.chrome.restartSession': '重新啟動工作階段',
  'shell.chrome.resumeSession': '繼續工作階段',
  'shell.chrome.notRestarted': '未能重新啟動：{error}',
  'shell.chrome.waiting': '等你處理',
};

export const es = {
  'shell.chrome.hideLeft': 'Ocultar la barra lateral izquierda',
  'shell.chrome.showLeft': 'Mostrar la barra lateral izquierda',
  'shell.chrome.hideRight': 'Ocultar la barra lateral derecha',
  'shell.chrome.showRight': 'Mostrar la barra lateral derecha',
  'shell.chrome.barEdge': 'Cambiar el ancho de las barras de iconos',
  'shell.chrome.barEdgeTitle': 'Arrastra para estrechar o ensanchar las dos barras de iconos · doble clic para el valor por defecto ({width} px)',
  'shell.chrome.sidebarEdgeTitle': 'Arrastra para cambiar el ancho de las dos barras laterales · doble clic para el ancho por defecto',
  'shell.chrome.sidebarsWider': 'Barras laterales más anchas',
  'shell.chrome.sidebarsNarrower': 'Barras laterales más estrechas',
  'shell.chrome.sidebarRightToggle': 'Mostrar u ocultar la barra lateral derecha',
  'shell.chrome.barsToggle': 'Mostrar u ocultar las barras de iconos',
  'shell.chrome.restartSession': 'Reiniciar la sesión',
  'shell.chrome.resumeSession': 'Reanudar la sesión',
  'shell.chrome.notRestarted': 'No se pudo reiniciar: {error}',
  'shell.chrome.waiting': 'esperando tu respuesta',
};

export const fr = {
  'shell.chrome.hideLeft': 'Masquer la barre latérale gauche',
  'shell.chrome.showLeft': 'Afficher la barre latérale gauche',
  'shell.chrome.hideRight': 'Masquer la barre latérale droite',
  'shell.chrome.showRight': 'Afficher la barre latérale droite',
  'shell.chrome.barEdge': 'Redimensionner les barres d’icônes',
  'shell.chrome.barEdgeTitle': 'Faites glisser pour rétrécir ou élargir les deux barres d’icônes · double-clic pour la valeur par défaut ({width} px)',
  'shell.chrome.sidebarEdgeTitle': 'Faites glisser pour redimensionner les deux barres latérales · double-clic pour la largeur par défaut',
  'shell.chrome.sidebarsWider': 'Barres latérales plus larges',
  'shell.chrome.sidebarsNarrower': 'Barres latérales plus étroites',
  'shell.chrome.sidebarRightToggle': 'Afficher ou masquer la barre latérale droite',
  'shell.chrome.barsToggle': 'Afficher ou masquer les barres d’icônes',
  'shell.chrome.restartSession': 'Redémarrer la session',
  'shell.chrome.resumeSession': 'Reprendre la session',
  'shell.chrome.notRestarted': 'Redémarrage impossible : {error}',
  'shell.chrome.waiting': 'vous attend',
};

export const pt = {
  'shell.chrome.hideLeft': 'Ocultar a barra lateral esquerda',
  'shell.chrome.showLeft': 'Mostrar a barra lateral esquerda',
  'shell.chrome.hideRight': 'Ocultar a barra lateral direita',
  'shell.chrome.showRight': 'Mostrar a barra lateral direita',
  'shell.chrome.barEdge': 'Redimensionar as barras de ícones',
  'shell.chrome.barEdgeTitle': 'Arraste para estreitar ou alargar as duas barras de ícones · duplo clique para o padrão ({width} px)',
  'shell.chrome.sidebarEdgeTitle': 'Arraste para redimensionar as duas barras laterais · duplo clique para a largura padrão',
  'shell.chrome.sidebarsWider': 'Barras laterais mais largas',
  'shell.chrome.sidebarsNarrower': 'Barras laterais mais estreitas',
  'shell.chrome.sidebarRightToggle': 'Mostrar ou ocultar a barra lateral direita',
  'shell.chrome.barsToggle': 'Mostrar ou ocultar as barras de ícones',
  'shell.chrome.restartSession': 'Reiniciar a sessão',
  'shell.chrome.resumeSession': 'Retomar a sessão',
  'shell.chrome.notRestarted': 'Não foi possível reiniciar: {error}',
  'shell.chrome.waiting': 'esperando você',
};
