// Ticket 261 (needs 197, G14): the Diff section on Settings > Appearance and the Diff view's own option words.
declare module '../index' {
  interface AreaKeys {
    'diffopt.title': true;
    'field.diffHideWhitespace': true;
    'diffopt.hideWhitespace.desc': true;
    'field.diffWrap': true;
    'diffopt.wrap.desc': true;
    'field.diffCollapse': true;
    'diffopt.short.ws': true;
    'diffopt.short.wrap': true;
    'diffopt.short.fold': true;
    'diffopt.collapse.desc': true;
    'field.diffHideList': true;
    'diffopt.hideList.desc': true;
    'field.diffColours': true;
    'diffopt.colours.desc': true;
    'diffopt.colours.theme': true;
    'diffopt.colours.colourBlind': true;
    'diffopt.wsOnly': true;
    'diffopt.wsHidden.one': true;
    'diffopt.wsHidden.other': true;
    'diffopt.show.one': true;
    'diffopt.show.other': true;
  }
}

export const en = {
  'diffopt.title': 'Diff',
  'field.diffHideWhitespace': 'Hide whitespace changes',
  'diffopt.hideWhitespace.desc': 'A line that changed only in spaces or tabs is shown as unchanged. A section with no other change is collapsed.',
  'field.diffWrap': 'Wrap long lines',
  'diffopt.wrap.desc': 'Long lines wrap inside the view instead of scrolling sideways.',
  'field.diffCollapse': 'Collapse unchanged lines',
  'diffopt.short.ws': 'Spaces',
  'diffopt.short.wrap': 'Wrap',
  'diffopt.short.fold': 'Collapse',
  'diffopt.collapse.desc': 'Unchanged lines around a change are collapsed into one row. Click the row to show them again.',
  'field.diffHideList': 'Hide the changed-file list',
  'diffopt.hideList.desc': 'Show only the open file; the chat still opens the other files.',
  'field.diffColours': 'Diff colours',
  'diffopt.colours.desc': 'Colour-blind safe marks added lines blue and removed lines orange.',
  'diffopt.colours.theme': 'Theme',
  'diffopt.colours.colourBlind': 'Colour-blind safe',
  'diffopt.wsOnly': 'Whitespace-only change hidden',
  'diffopt.wsHidden.one': '1 whitespace-only change hidden',
  'diffopt.wsHidden.other': '{n} whitespace-only changes hidden',
  'diffopt.show.one': 'Show 1 line',
  'diffopt.show.other': 'Show {n} lines',
};
export const ko = {
  'diffopt.title': 'Diff',
  'field.diffHideWhitespace': '공백 변경 숨기기',
  'diffopt.hideWhitespace.desc': '공백이나 탭만 바뀐 줄은 바뀌지 않은 줄로 보이고, 그것만 있는 부분은 접힙니다.',
  'field.diffWrap': '긴 줄 줄바꿈',
  'diffopt.wrap.desc': '긴 줄을 옆으로 스크롤하지 않고 화면 안에서 줄바꿈합니다.',
  'field.diffCollapse': '바뀌지 않은 줄 접기',
  'diffopt.short.ws': '공백',
  'diffopt.short.wrap': '줄바꿈',
  'diffopt.short.fold': '접기',
  'diffopt.collapse.desc': '변경 주변의 바뀌지 않은 줄을 한 줄로 접고, 누르면 다시 보입니다.',
  'field.diffHideList': '변경된 파일 목록 숨기기',
  'diffopt.hideList.desc': '열린 파일만 보입니다. 다른 파일은 채팅에서 엽니다.',
  'field.diffColours': 'Diff 색상',
  'diffopt.colours.desc': '색각 이상 안전 색상은 추가된 줄을 파란색, 삭제된 줄을 주황색으로 표시합니다.',
  'diffopt.colours.theme': '테마',
  'diffopt.colours.colourBlind': '색각 이상 안전',
  'diffopt.wsOnly': '공백만 바뀐 부분 숨김',
  'diffopt.wsHidden.one': '공백만 바뀐 변경 1개 숨김',
  'diffopt.wsHidden.other': '공백만 바뀐 변경 {n}개 숨김',
  'diffopt.show.one': '1줄 보기',
  'diffopt.show.other': '{n}줄 보기',
};
export const ja = {
  'diffopt.title': '差分',
  'field.diffHideWhitespace': '空白の変更を隠す',
  'diffopt.hideWhitespace.desc': 'スペースやタブだけが変わった行は変更なしとして表示し、それだけの部分は折りたたみます。',
  'field.diffWrap': '長い行を折り返す',
  'diffopt.wrap.desc': '長い行を横にスクロールせず、表示内で折り返します。',
  'field.diffCollapse': '変更のない行を折りたたむ',
  'diffopt.short.ws': '空白',
  'diffopt.short.wrap': '折り返し',
  'diffopt.short.fold': '折りたたみ',
  'diffopt.collapse.desc': '変更の前後にある変更のない行を 1 行に折りたたみます。その行をクリックすると再び表示します。',
  'field.diffHideList': '変更ファイルの一覧を隠す',
  'diffopt.hideList.desc': '開いているファイルだけを表示します。ほかのファイルはチャットから開けます。',
  'field.diffColours': '差分の色',
  'diffopt.colours.desc': '色覚に配慮した配色では、追加行を青、削除行をオレンジで示します。',
  'diffopt.colours.theme': 'テーマ',
  'diffopt.colours.colourBlind': '色覚に配慮',
  'diffopt.wsOnly': '空白のみの変更を非表示',
  'diffopt.wsHidden.one': '空白のみの変更 1 件を非表示',
  'diffopt.wsHidden.other': '空白のみの変更 {n} 件を非表示',
  'diffopt.show.one': '1 行を表示',
  'diffopt.show.other': '{n} 行を表示',
};
export const zhHans = {
  'diffopt.title': '差异',
  'field.diffHideWhitespace': '隐藏空白更改',
  'diffopt.hideWhitespace.desc': '只改了空格或制表符的行显示为未更改；只有这类更改的部分会折叠。',
  'field.diffWrap': '长行自动换行',
  'diffopt.wrap.desc': '长行在视图内换行，而不是横向滚动。',
  'field.diffCollapse': '折叠未更改的行',
  'diffopt.short.ws': '空白',
  'diffopt.short.wrap': '换行',
  'diffopt.short.fold': '折叠',
  'diffopt.collapse.desc': '更改周围未更改的行折叠为一行，点击可再次显示。',
  'field.diffHideList': '隐藏已更改文件列表',
  'diffopt.hideList.desc': '只显示打开的文件；其他文件仍可从聊天中打开。',
  'field.diffColours': '差异颜色',
  'diffopt.colours.desc': '色盲友好配色用蓝色标记新增的行，用橙色标记删除的行。',
  'diffopt.colours.theme': '主题',
  'diffopt.colours.colourBlind': '色盲友好',
  'diffopt.wsOnly': '已隐藏仅空白的更改',
  'diffopt.wsHidden.one': '已隐藏 1 处仅空白的更改',
  'diffopt.wsHidden.other': '已隐藏 {n} 处仅空白的更改',
  'diffopt.show.one': '显示 1 行',
  'diffopt.show.other': '显示 {n} 行',
};
export const zhHant = {
  'diffopt.title': '差異',
  'field.diffHideWhitespace': '隱藏空白變更',
  'diffopt.hideWhitespace.desc': '只改了空格或定位字元的行顯示為未變更；只有這類變更的部分會收合。',
  'field.diffWrap': '長行自動換行',
  'diffopt.wrap.desc': '長行在檢視內換行，而不是橫向捲動。',
  'field.diffCollapse': '收合未變更的行',
  'diffopt.short.ws': '空白',
  'diffopt.short.wrap': '換行',
  'diffopt.short.fold': '收合',
  'diffopt.collapse.desc': '變更周圍未變更的行收合為一行，按一下可再次顯示。',
  'field.diffHideList': '隱藏已變更檔案清單',
  'diffopt.hideList.desc': '只顯示開啟的檔案；其他檔案仍可從聊天中開啟。',
  'field.diffColours': '差異顏色',
  'diffopt.colours.desc': '色盲友善配色以藍色標示新增的行，以橘色標示刪除的行。',
  'diffopt.colours.theme': '主題',
  'diffopt.colours.colourBlind': '色盲友善',
  'diffopt.wsOnly': '已隱藏僅空白的變更',
  'diffopt.wsHidden.one': '已隱藏 1 處僅空白的變更',
  'diffopt.wsHidden.other': '已隱藏 {n} 處僅空白的變更',
  'diffopt.show.one': '顯示 1 行',
  'diffopt.show.other': '顯示 {n} 行',
};
export const es = {
  'diffopt.title': 'Diff',
  'field.diffHideWhitespace': 'Ocultar cambios de espacios',
  'diffopt.hideWhitespace.desc': 'Una línea que solo cambió en espacios o tabulaciones se muestra sin cambios; una parte con solo eso se pliega.',
  'field.diffWrap': 'Ajustar líneas largas',
  'diffopt.wrap.desc': 'Las líneas largas se ajustan dentro de la vista en lugar de desplazarse en horizontal.',
  'field.diffCollapse': 'Contraer líneas sin cambios',
  'diffopt.short.ws': 'Espacios',
  'diffopt.short.wrap': 'Ajustar',
  'diffopt.short.fold': 'Contraer',
  'diffopt.collapse.desc': 'Las líneas sin cambios alrededor de un cambio se contraen en una fila que las vuelve a mostrar.',
  'field.diffHideList': 'Ocultar la lista de archivos cambiados',
  'diffopt.hideList.desc': 'Muestra solo el archivo abierto; el chat sigue abriendo los demás.',
  'field.diffColours': 'Colores de diferencias',
  'diffopt.colours.desc': 'El modo apto para daltonismo marca en azul las líneas añadidas y en naranja las eliminadas.',
  'diffopt.colours.theme': 'Tema',
  'diffopt.colours.colourBlind': 'Apto para daltonismo',
  'diffopt.wsOnly': 'Cambio solo de espacios oculto',
  'diffopt.wsHidden.one': '1 cambio solo de espacios oculto',
  'diffopt.wsHidden.other': '{n} cambios solo de espacios ocultos',
  'diffopt.show.one': 'Mostrar 1 línea',
  'diffopt.show.other': 'Mostrar {n} líneas',
};
export const fr = {
  'diffopt.title': 'Diff',
  'field.diffHideWhitespace': 'Masquer les changements d’espaces',
  'diffopt.hideWhitespace.desc': 'Une ligne modifiée seulement par des espaces ou des tabulations s’affiche inchangée ; une partie qui ne contient que cela est repliée.',
  'field.diffWrap': 'Retour à la ligne des longues lignes',
  'diffopt.wrap.desc': 'Les longues lignes passent à la ligne dans la vue au lieu de défiler à l’horizontale.',
  'field.diffCollapse': 'Replier les lignes inchangées',
  'diffopt.short.ws': 'Espaces',
  'diffopt.short.wrap': 'Renvoi',
  'diffopt.short.fold': 'Replier',
  'diffopt.collapse.desc': 'Les lignes inchangées autour d’une modification se replient en une ligne qui les réaffiche.',
  'field.diffHideList': 'Masquer la liste des fichiers modifiés',
  'diffopt.hideList.desc': "Affiche seulement le fichier ouvert ; la conversation ouvre toujours les autres.",
  'field.diffColours': 'Couleurs du Diff',
  'diffopt.colours.desc': 'Le mode adapté au daltonisme marque les lignes ajoutées en bleu et les lignes supprimées en orange.',
  'diffopt.colours.theme': 'Thème',
  'diffopt.colours.colourBlind': 'Adapté au daltonisme',
  'diffopt.wsOnly': 'Modification d’espaces seulement masquée',
  'diffopt.wsHidden.one': '1 modification d’espaces seulement masquée',
  'diffopt.wsHidden.other': '{n} modifications d’espaces seulement masquées',
  'diffopt.show.one': 'Afficher 1 ligne',
  'diffopt.show.other': 'Afficher {n} lignes',
};
export const pt = {
  'diffopt.title': "Diff",
  'field.diffHideWhitespace': 'Ocultar alterações de espaços',
  'diffopt.hideWhitespace.desc': 'Uma linha alterada só em espaços ou tabulações aparece sem alteração; uma parte só com isso é recolhida.',
  'field.diffWrap': 'Quebrar linhas longas',
  'diffopt.wrap.desc': 'Linhas longas quebram dentro da visualização em vez de rolar na horizontal.',
  'field.diffCollapse': 'Recolher linhas sem alteração',
  'diffopt.short.ws': 'Espaços',
  'diffopt.short.wrap': 'Quebra',
  'diffopt.short.fold': 'Recolher',
  'diffopt.collapse.desc': 'As linhas sem alteração em volta de uma mudança são recolhidas em uma só linha. Clique nela para mostrá-las de novo.',
  'field.diffHideList': 'Ocultar a lista de arquivos alterados',
  'diffopt.hideList.desc': "Mostra só o arquivo aberto; a conversa ainda abre os outros.",
  'field.diffColours': 'Cores do diff',
  'diffopt.colours.desc': 'O modo para daltonismo marca as linhas adicionadas em azul e as removidas em laranja.',
  'diffopt.colours.theme': 'Tema',
  'diffopt.colours.colourBlind': 'Para daltonismo',
  'diffopt.wsOnly': 'Alteração só de espaços oculta',
  'diffopt.wsHidden.one': '1 alteração só de espaços oculta',
  'diffopt.wsHidden.other': '{n} alterações só de espaços ocultas',
  'diffopt.show.one': 'Mostrar 1 linha',
  'diffopt.show.other': 'Mostrar {n} linhas',
};
