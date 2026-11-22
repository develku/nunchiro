// Ticket 366: the default auto-allowed cdnjs libraries in Settings > Artifact libraries. All eight languages.
// libsFor.* (owner 2026-11-16): what each default library is for, and which versions this Mac already holds.
declare module "../index" {
  interface AreaKeys {
    "libsDefault.chip": true;
    "libsDefault.note": true;
    "libsFor.Chart.js": true;
    "libsFor.d3": true;
    "libsFor.three.js": true;
    "libsFor.plotly.js": true;
    "libsFor.lodash.js": true;
    "libsFor.PapaParse": true;
    "libsFor.tone": true;
    "libsFor.KaTeX": true;
    "libsFor.highlight.js": true;
    "libsFor.marked": true;
    "libsFor.leaflet": true;
    "libsFor.have": true;
    "libsFor.none": true;
  }
}

export const en = {
  "libsFor.Chart.js": "Charts",
  "libsFor.d3": "Data visualisation",
  "libsFor.three.js": "3D graphics",
  "libsFor.plotly.js": "Interactive charts and graphs",
  "libsFor.lodash.js": "Helper functions for data",
  "libsFor.PapaParse": "Reads and writes CSV",
  "libsFor.tone": "Sound and music",
  "libsFor.KaTeX": "Math formulas",
  "libsFor.highlight.js": "Code colouring",
  "libsFor.marked": "Markdown to HTML",
  "libsFor.leaflet": "Maps",
  "libsFor.have": "On this Mac: {versions}",
  "libsFor.none": "Not fetched yet",
  "libsDefault.chip": "Default",
  "libsDefault.note":
    "On by default. Exact versions that match the manifest load without a card. When off, Nunchiro asks once.",
};
export const ko = {
  "libsFor.Chart.js": "차트",
  "libsFor.d3": "데이터 시각화",
  "libsFor.three.js": "3D 그래픽",
  "libsFor.plotly.js": "대화형 차트와 그래프",
  "libsFor.lodash.js": "데이터 처리 도우미 함수",
  "libsFor.PapaParse": "CSV 읽기와 쓰기",
  "libsFor.tone": "소리와 음악",
  "libsFor.KaTeX": "수식 표시",
  "libsFor.highlight.js": "코드 색 강조",
  "libsFor.marked": "Markdown을 HTML로 변환",
  "libsFor.leaflet": "지도",
  "libsFor.have": "이 Mac에 있음: {versions}",
  "libsFor.none": "아직 가져오지 않음",
  "libsDefault.chip": "기본값",
  "libsDefault.note":
    "기본으로 켜져 있습니다. 매니페스트와 일치하는 정확한 버전은 카드 없이 불러옵니다. 끄면 한 번 묻습니다.",
};
export const ja = {
  "libsFor.Chart.js": "グラフ",
  "libsFor.d3": "データの可視化",
  "libsFor.three.js": "3D グラフィックス",
  "libsFor.plotly.js": "インタラクティブなグラフ",
  "libsFor.lodash.js": "データ処理の補助関数",
  "libsFor.PapaParse": "CSV の読み書き",
  "libsFor.tone": "音と音楽",
  "libsFor.KaTeX": "数式の表示",
  "libsFor.highlight.js": "コードの色分け",
  "libsFor.marked": "Markdown を HTML に変換",
  "libsFor.leaflet": "地図",
  "libsFor.have": "この Mac にあるもの：{versions}",
  "libsFor.none": "まだ取得していません",
  "libsDefault.chip": "デフォルト",
  "libsDefault.note":
    "デフォルトでオン：マニフェストと完全に一致するバージョンはカードなしで読み込まれます。オフにすると一度だけ確認します。",
};
export const zhHans = {
  "libsFor.Chart.js": "图表",
  "libsFor.d3": "数据可视化",
  "libsFor.three.js": "3D 图形",
  "libsFor.plotly.js": "交互式图表",
  "libsFor.lodash.js": "数据处理辅助函数",
  "libsFor.PapaParse": "读写 CSV",
  "libsFor.tone": "声音和音乐",
  "libsFor.KaTeX": "数学公式",
  "libsFor.highlight.js": "代码着色",
  "libsFor.marked": "Markdown 转 HTML",
  "libsFor.leaflet": "地图",
  "libsFor.have": "此 Mac 上已有：{versions}",
  "libsFor.none": "尚未获取",
  "libsDefault.chip": "默认",
  "libsDefault.note":
    "默认开启：与清单匹配的确切版本无需卡片即可加载。关闭后会询问一次。",
};
export const zhHant = {
  "libsFor.Chart.js": "圖表",
  "libsFor.d3": "資料視覺化",
  "libsFor.three.js": "3D 圖形",
  "libsFor.plotly.js": "互動式圖表",
  "libsFor.lodash.js": "資料處理輔助函式",
  "libsFor.PapaParse": "讀寫 CSV",
  "libsFor.tone": "聲音和音樂",
  "libsFor.KaTeX": "數學公式",
  "libsFor.highlight.js": "程式碼上色",
  "libsFor.marked": "Markdown 轉 HTML",
  "libsFor.leaflet": "地圖",
  "libsFor.have": "此 Mac 上已有：{versions}",
  "libsFor.none": "尚未取得",
  "libsDefault.chip": "預設",
  "libsDefault.note":
    "預設開啟：與清單相符的確切版本無需卡片即可載入。關閉後會詢問一次。",
};
export const es = {
  "libsFor.Chart.js": "Gráficos",
  "libsFor.d3": "Visualización de datos",
  "libsFor.three.js": "Gráficos 3D",
  "libsFor.plotly.js": "Gráficos interactivos",
  "libsFor.lodash.js": "Funciones auxiliares para datos",
  "libsFor.PapaParse": "Lee y escribe CSV",
  "libsFor.tone": "Sonido y música",
  "libsFor.KaTeX": "Fórmulas matemáticas",
  "libsFor.highlight.js": "Coloreado de código",
  "libsFor.marked": "Markdown a HTML",
  "libsFor.leaflet": "Mapas",
  "libsFor.have": "En este Mac: {versions}",
  "libsFor.none": "Aún no descargada",
  "libsDefault.chip": "Predeterminado",
  "libsDefault.note":
    "Activado de forma predeterminada: las versiones exactas que coinciden con el manifiesto se cargan sin tarjeta. Si lo desactivas, pregunta una vez.",
};
export const fr = {
  "libsFor.Chart.js": "Graphiques",
  "libsFor.d3": "Visualisation de données",
  "libsFor.three.js": "Graphiques 3D",
  "libsFor.plotly.js": "Graphiques interactifs",
  "libsFor.lodash.js": "Fonctions utilitaires pour les données",
  "libsFor.PapaParse": "Lit et écrit du CSV",
  "libsFor.tone": "Son et musique",
  "libsFor.KaTeX": "Formules mathématiques",
  "libsFor.highlight.js": "Coloration du code",
  "libsFor.marked": "Markdown vers HTML",
  "libsFor.leaflet": "Cartes",
  "libsFor.have": "Sur ce Mac : {versions}",
  "libsFor.none": "Pas encore téléchargée",
  "libsDefault.chip": "Par défaut",
  "libsDefault.note":
    "Activé par défaut : les versions exactes qui correspondent au manifeste se chargent sans carte. Désactivé, il demande une fois.",
};
export const pt = {
  "libsFor.Chart.js": "Gráficos",
  "libsFor.d3": "Visualização de dados",
  "libsFor.three.js": "Gráficos 3D",
  "libsFor.plotly.js": "Gráficos interativos",
  "libsFor.lodash.js": "Funções auxiliares para dados",
  "libsFor.PapaParse": "Lê e grava CSV",
  "libsFor.tone": "Som e música",
  "libsFor.KaTeX": "Fórmulas matemáticas",
  "libsFor.highlight.js": "Coloração de código",
  "libsFor.marked": "Markdown para HTML",
  "libsFor.leaflet": "Mapas",
  "libsFor.have": "Neste Mac: {versions}",
  "libsFor.none": "Ainda não baixada",
  "libsDefault.chip": "Padrão",
  "libsDefault.note":
    "Ativado por padrão: versões exatas que correspondem ao manifesto carregam sem cartão. Desativado, pergunta uma vez.",
};
