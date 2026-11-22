// Ticket 389: Settings > Keyboard > Hints after the label change: p and s prefix keys, Shift + kind filters, screen regions.
declare module '../index' {
  interface AreaKeys {
    'hints.prefixDesc': true;
    'hints.oneKindDesc': true;
    'hints.prefixKey': true;
    'hints.filterKey': true;
    'hints.struck': true;
    'hints.fewKeys': true;
    'hints.regionsLegend': true;
    'hints.region_left': true;
    'hints.region_top': true;
    'hints.region_right': true;
    'hints.region_composer': true;
    'hints.mismatch': true;
    'hints.mismatchLink': true;
  }
}

export const en = {
  'hints.prefixDesc': 'Project labels are {p}1, {p}2 … Session labels are {s}1, {s}2 … in tab order ({s}1 is the first tab). These two keys only start those labels.',
  'hints.oneKindDesc': 'For every other kind, hold Shift and type its key. Only that kind keeps its letters. For example, Shift+{key} shows labels on tabs only. Rare controls also use this way.',
  'hints.prefixKey': '{kind} labels start here',
  'hints.filterKey': 'Shift+{key}: {kind} only',
  'hints.struck': 'Crossed-out keys start project and session labels, so one-key labels do not use them.',
  'hints.fewKeys': 'The project and session keys leave fewer than two keys for labels: add more keys to the alphabet.',
  'hints.regionsLegend': 'Colour shows where on the screen the labels are',
  'hints.region_left': 'left bar',
  'hints.region_top': 'top bar',
  'hints.region_right': 'right bar',
  'hints.region_composer': 'composer',
  'hints.mismatch': 'Letters not matching? {link}',
  'hints.mismatchLink': 'Change hint letters',
};
export const ko = {
  'hints.prefixDesc': '프로젝트는 {p}1 {p}2, 세션은 탭 순서대로 {s}1 {s}2입니다({s}1은 첫 탭). 이 두 키는 이 라벨의 앞글자로만 씁니다.',
  'hints.oneKindDesc': '나머지 종류는 Shift를 누른 채 그 키를 치면 그 종류에만 첫 키부터 글자가 다시 붙습니다. 예: Shift+{key}을(를) 치면 탭에만. 드물게 쓰는 버튼도 이렇게 보입니다.',
  'hints.prefixKey': '{kind} 라벨의 앞글자',
  'hints.filterKey': 'Shift+{key}: {kind}만',
  'hints.struck': '줄 그은 키는 프로젝트·세션 라벨의 앞글자라서 한 글자 라벨에는 쓰지 않습니다.',
  'hints.fewKeys': '프로젝트·세션 키를 빼면 라벨에 쓸 키가 두 개 미만입니다. 알파벳에 키를 더 넣으세요.',
  'hints.regionsLegend': '색: 그 키가 라벨이 되는 화면 위치',
  'hints.region_left': '왼쪽 바',
  'hints.region_top': '위쪽 바',
  'hints.region_right': '오른쪽 바',
  'hints.region_composer': "입력창",
  'hints.mismatch': '글자가 안 맞나요? {link}',
  'hints.mismatchLink': '힌트 글자 바꾸기',
};
export const ja = {
  'hints.prefixDesc': 'プロジェクトは {p}1 {p}2、セッションはタブの順に {s}1 {s}2 です（{s}1 は最初のタブ）。この二つのキーはそのラベルの頭にだけ使います。',
  'hints.oneKindDesc': 'ほかの種類は、Shift を押しながらその種類のキーを打ちます。その種類だけにラベルが付きます。例：Shift+{key} でタブだけにラベルが付きます。めったに使わないボタンもこの方法で選べます。',
  'hints.prefixKey': '{kind}のラベルの頭',
  'hints.filterKey': 'Shift+{key}：{kind}だけ',
  'hints.struck': '取り消し線のキーはプロジェクトとセッションのラベルの頭なので、一文字のラベルには使いません。',
  'hints.fewKeys': 'プロジェクトとセッションのキーを除くと、ラベルに使えるキーが二つ未満です。アルファベットにキーを足してください。',
  'hints.regionsLegend': '色：そのキーがラベルになる画面の位置',
  'hints.region_left': '左バー',
  'hints.region_top': '上バー',
  'hints.region_right': '右バー',
  'hints.region_composer': "入力欄",
  'hints.mismatch': '文字が合いませんか？ {link}',
  'hints.mismatchLink': 'ヒント文字を変える',
};
export const zhHans = {
  'hints.prefixDesc': '项目标为 {p}1 {p}2，会话按选项卡顺序标为 {s}1 {s}2（{s}1 是第一个选项卡）。这两个键只用作这些标签的开头。',
  'hints.oneKindDesc': '其他类别：按住 Shift 再按它的键，只有该类别保留字母。例如 Shift+{key} 只在选项卡上显示标签。不常用的控件也用这种方式。',
  'hints.prefixKey': '{kind}标签的开头',
  'hints.filterKey': 'Shift+{key}：只显示{kind}',
  'hints.struck': '划掉的键是项目和会话标签的开头，所以单键标签不使用它们。',
  'hints.fewKeys': '去掉项目和会话键后，可用于标签的键少于两个：请在字母表中添加更多键。',
  'hints.regionsLegend': '颜色：该键所标注的屏幕位置',
  'hints.region_left': '左栏',
  'hints.region_top': '顶栏',
  'hints.region_right': '右栏',
  'hints.region_composer': '输入框',
  'hints.mismatch': '字母对不上？{link}',
  'hints.mismatchLink': '更改提示字母',
};
export const zhHant = {
  'hints.prefixDesc': '專案標為 {p}1 {p}2，工作階段依選項卡順序標為 {s}1 {s}2（{s}1 是第一個選項卡）。這兩個鍵只用作這些標籤的開頭。',
  'hints.oneKindDesc': '其他類別：按住 Shift 再按它的鍵，只有該類別保留字母，並從第一個鍵重新編排。例如 Shift+{key} 只留下選項卡。不常用的按鈕也這樣顯示。',
  'hints.prefixKey': '{kind}標籤的開頭',
  'hints.filterKey': 'Shift+{key}：只顯示{kind}',
  'hints.struck': '劃掉的鍵是專案和工作階段標籤的開頭，所以單鍵標籤不使用它們。',
  'hints.fewKeys': '去掉專案和工作階段鍵後，可用於標籤的鍵少於兩個：請在字母表中加入更多鍵。',
  'hints.regionsLegend': '顏色：該鍵所標示的螢幕位置',
  'hints.region_left': '左側圖示欄',
  'hints.region_top': '頂部欄',
  'hints.region_right': '右側圖示欄',
  'hints.region_composer': '輸入框',
  'hints.mismatch': '字母對不上？{link}',
  'hints.mismatchLink': '變更提示字母',
};
export const es = {
  'hints.prefixDesc': 'Las etiquetas de proyecto son {p}1, {p}2 … y las de sesión {s}1, {s}2 …, en el orden de las pestañas ({s}1 es la primera). Estas dos teclas solo inician esas etiquetas.',
  'hints.oneKindDesc': 'Para cualquier otro tipo, mantén Shift y pulsa su tecla: solo ese tipo conserva sus etiquetas. Por ejemplo, Shift+{key} muestra etiquetas solo en las pestañas. Los controles poco usados también se alcanzan así.',
  'hints.prefixKey': 'inicio de las etiquetas de {kind}',
  'hints.filterKey': 'Shift+{key}: solo {kind}',
  'hints.struck': 'Las teclas tachadas inician las etiquetas de proyectos y sesiones, así que las etiquetas de una tecla no las usan.',
  'hints.fewKeys': 'Sin las teclas de proyecto y sesión quedan menos de dos teclas para etiquetas: añade más teclas al alfabeto.',
  'hints.regionsLegend': "El color indica en qué parte de la pantalla están las etiquetas",
  'hints.region_left': 'barra izquierda',
  'hints.region_top': 'barra superior',
  'hints.region_right': 'barra derecha',
  'hints.region_composer': "campo de escritura",
  'hints.mismatch': '¿Las letras no coinciden? {link}',
  'hints.mismatchLink': "Cambiar las letras de las pistas",
};
export const fr = {
  'hints.prefixDesc': 'Les projets s’écrivent {p}1 {p}2 et les sessions {s}1 {s}2, dans l’ordre des onglets ({s}1 est le premier). Ces deux touches ne servent qu’à commencer ces étiquettes.',
  'hints.oneKindDesc': 'Pour les autres types, maintenez Maj et tapez leur touche : seul ce type garde ses lettres. Par exemple, Maj+{key} n’affiche d’étiquettes que sur les onglets. Les commandes rares s’affichent de la même façon.',
  'hints.prefixKey': 'début des étiquettes {kind}',
  'hints.filterKey': 'Maj+{key} : {kind} seulement',
  'hints.struck': 'Les touches barrées commencent les étiquettes de projet et de session ; les étiquettes d’une seule touche ne les utilisent pas.',
  'hints.fewKeys': 'Sans les touches projet et session, il reste moins de deux touches pour les étiquettes : ajoutez des touches à l’alphabet.',
  'hints.regionsLegend': 'La couleur indique où se trouvent les étiquettes à l’écran',
  'hints.region_left': 'barre gauche',
  'hints.region_top': 'barre du haut',
  'hints.region_right': 'barre droite',
  'hints.region_composer': 'zone de saisie',
  'hints.mismatch': 'Les lettres ne correspondent pas ? {link}',
  'hints.mismatchLink': 'Changer les lettres d’indice',
};
export const pt = {
  'hints.prefixDesc': 'Projetos são {p}1 {p}2 e sessões {s}1 {s}2, na ordem das abas ({s}1 é a primeira). Essas duas teclas só iniciam esses rótulos.',
  'hints.oneKindDesc': 'Os outros tipos: segure Shift e digite a tecla; só esse tipo mantém letras, desde a primeira tecla. Por exemplo, Shift+{key} deixa só as abas. Controles pouco usados aparecem assim também.',
  'hints.prefixKey': 'início dos rótulos de {kind}',
  'hints.filterKey': 'Shift+{key}: só {kind}',
  'hints.struck': 'As teclas riscadas iniciam os rótulos de projeto e sessão, então os rótulos de uma tecla não as usam.',
  'hints.fewKeys': 'Sem as teclas de projeto e sessão restam menos de duas teclas para rótulos: adicione mais teclas ao alfabeto.',
  'hints.regionsLegend': 'A cor mostra em que parte da tela ficam os rótulos',
  'hints.region_left': 'barra esquerda',
  'hints.region_top': 'barra superior',
  'hints.region_right': 'barra direita',
  'hints.region_composer': "caixa de mensagem",
  'hints.mismatch': 'As letras não batem? {link}',
  'hints.mismatchLink': 'Mudar as letras de dica',
};
