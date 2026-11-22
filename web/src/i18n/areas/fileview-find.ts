// Ticket 200 (needs 171): the Cmd+F find panel in the file viewer. CodeMirror reads these as its `phrases`.
// `$1` and `$2` are CodeMirror's own placeholders (the position and the total), kept as the library fills them.
declare module '../index' {
  interface AreaKeys {
    'fvfind.label': true;
    'fvfind.find': true;
    'fvfind.next': true;
    'fvfind.previous': true;
    'fvfind.case': true;
    'fvfind.close': true;
    'fvfind.none': true;
    'fvfind.of': true;
    'fvfind.more': true;
  }
}

export const en = {
  'fvfind.label': 'Find in file',
  'fvfind.find': 'Find',
  'fvfind.next': 'Next match',
  'fvfind.previous': 'Previous match',
  'fvfind.case': 'Match case',
  'fvfind.close': 'Close find',
  'fvfind.none': 'No matches',
  'fvfind.of': '$1 of $2',
  'fvfind.more': '$1+',
};
export const ko = {
  'fvfind.label': '파일에서 찾기',
  'fvfind.find': '찾기',
  'fvfind.next': '다음 일치 항목',
  'fvfind.previous': '이전 일치 항목',
  'fvfind.case': '대소문자 구분',
  'fvfind.close': '찾기 닫기',
  'fvfind.none': '일치하는 항목 없음',
  'fvfind.of': '$2개 중 $1번째',
  'fvfind.more': '$1개 이상',
};
export const ja = {
  'fvfind.label': 'ファイル内を検索',
  'fvfind.find': '検索',
  'fvfind.next': '次の一致',
  'fvfind.previous': '前の一致',
  'fvfind.case': '大文字と小文字を区別',
  'fvfind.close': '検索を閉じる',
  'fvfind.none': '一致なし',
  'fvfind.of': '$2 件中 $1 件目',
  'fvfind.more': '$1 件以上',
};
export const zhHans = {
  'fvfind.label': '在文件中查找',
  'fvfind.find': '查找',
  'fvfind.next': '下一个匹配项',
  'fvfind.previous': '上一个匹配项',
  'fvfind.case': '区分大小写',
  'fvfind.close': '关闭查找',
  'fvfind.none': '没有匹配项',
  'fvfind.of': '第 $1 个，共 $2 个',
  'fvfind.more': '$1 个以上',
};
export const zhHant = {
  'fvfind.label': '在檔案中尋找',
  'fvfind.find': '尋找',
  'fvfind.next': '下一個符合項目',
  'fvfind.previous': '上一個符合項目',
  'fvfind.case': '區分大小寫',
  'fvfind.close': '關閉尋找',
  'fvfind.none': '沒有符合項目',
  'fvfind.of': '第 $1 個，共 $2 個',
  'fvfind.more': '$1 個以上',
};
export const es = {
  'fvfind.label': 'Buscar en el archivo',
  'fvfind.find': 'Buscar',
  'fvfind.next': 'Coincidencia siguiente',
  'fvfind.previous': 'Coincidencia anterior',
  'fvfind.case': 'Distinguir mayúsculas',
  'fvfind.close': 'Cerrar búsqueda',
  'fvfind.none': 'Sin coincidencias',
  'fvfind.of': '$1 de $2',
  'fvfind.more': '$1 o más',
};
export const fr = {
  'fvfind.label': 'Rechercher dans le fichier',
  'fvfind.find': 'Rechercher',
  'fvfind.next': 'Occurrence suivante',
  'fvfind.previous': 'Occurrence précédente',
  'fvfind.case': 'Respecter la casse',
  'fvfind.close': 'Fermer la recherche',
  'fvfind.none': 'Aucune occurrence',
  'fvfind.of': '$1 sur $2',
  'fvfind.more': '$1 ou plus',
};
export const pt = {
  'fvfind.label': 'Buscar no arquivo',
  'fvfind.find': 'Buscar',
  'fvfind.next': 'Próxima ocorrência',
  'fvfind.previous': 'Ocorrência anterior',
  'fvfind.case': 'Diferenciar maiúsculas',
  'fvfind.close': "Fechar busca",
  'fvfind.none': 'Nenhuma ocorrência',
  'fvfind.of': '$1 de $2',
  'fvfind.more': '$1 ou mais',
};
