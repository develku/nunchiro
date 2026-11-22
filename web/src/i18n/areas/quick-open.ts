// Ticket 821: the name finder (⌘P, web/src/files/QuickOpen.tsx) and its command title on the Keys page and in the palette.
declare module '../index' {
  interface AreaKeys {
    "settings.kbd.cmd.files.quickOpen": true;
    "quickOpen.search": true;
    "quickOpen.list": true;
    "quickOpen.type": true;
    "quickOpen.none": true;
    "quickOpen.searchText": true;
    "quickOpen.noFolder": true;
    "quickOpen.more": true;
    "quickOpen.failed": true;
  }
}

export const en = {
  "settings.kbd.cmd.files.quickOpen": "Go to file",
  "quickOpen.search": "File name",
  "quickOpen.list": "Matching files",
  "quickOpen.type": "Type part of a file name",
  "quickOpen.none": "No file name has “{q}”.",
  "quickOpen.searchText": "Search file text with {key}",
  "quickOpen.noFolder": "Open a session to find the files in its folder",
  "quickOpen.more": "More files match. Type more of the name",
  "quickOpen.failed": "File names could not be read. Try again",
};

export const ko = {
  "settings.kbd.cmd.files.quickOpen": "파일로 이동",
  "quickOpen.search": "파일 이름",
  "quickOpen.list": "일치하는 파일",
  "quickOpen.type": "파일 이름의 일부를 입력하세요",
  "quickOpen.none": "이름에 “{q}”이(가) 들어 있는 파일이 없습니다.",
  "quickOpen.searchText": "파일 내용은 {key}(으)로 검색하세요",
  "quickOpen.noFolder": "세션을 열면 그 폴더의 파일을 찾을 수 있습니다",
  "quickOpen.more": "더 많은 파일이 일치합니다. 이름을 더 입력하세요",
  "quickOpen.failed": "파일 이름을 읽지 못했습니다. 다시 시도하세요",
};

export const ja = {
  "settings.kbd.cmd.files.quickOpen": "ファイルへ移動",
  "quickOpen.search": "ファイル名",
  "quickOpen.list": "一致するファイル",
  "quickOpen.type": "ファイル名の一部を入力してください",
  "quickOpen.none": "名前に「{q}」を含むファイルはありません。",
  "quickOpen.searchText": "ファイルの内容は {key} で検索します",
  "quickOpen.noFolder": "セッションを開くと、そのフォルダーのファイルを探せます",
  "quickOpen.more": "ほかにも一致するファイルがあります。名前をもっと入力してください",
  "quickOpen.failed": "ファイル名を読み込めませんでした。もう一度お試しください",
};

export const zhHans = {
  "settings.kbd.cmd.files.quickOpen": "转到文件",
  "quickOpen.search": "文件名",
  "quickOpen.list": "匹配的文件",
  "quickOpen.type": "输入文件名的一部分",
  "quickOpen.none": "没有文件名包含“{q}”。",
  "quickOpen.searchText": "用 {key} 搜索文件内容",
  "quickOpen.noFolder": "打开一个会话即可查找其文件夹中的文件",
  "quickOpen.more": "还有更多匹配的文件。请多输入一些名称",
  "quickOpen.failed": "无法读取文件名。请重试",
};

export const zhHant = {
  "settings.kbd.cmd.files.quickOpen": "前往檔案",
  "quickOpen.search": "檔案名稱",
  "quickOpen.list": "相符的檔案",
  "quickOpen.type": "輸入檔案名稱的一部分",
  "quickOpen.none": "沒有檔案名稱包含「{q}」。",
  "quickOpen.searchText": "用 {key} 搜尋檔案內容",
  "quickOpen.noFolder": "開啟一個工作階段即可尋找其資料夾中的檔案",
  "quickOpen.more": "還有更多相符的檔案。請多輸入一些名稱",
  "quickOpen.failed": "無法讀取檔案名稱。請再試一次",
};

export const es = {
  "settings.kbd.cmd.files.quickOpen": "Ir al archivo",
  "quickOpen.search": "Nombre de archivo",
  "quickOpen.list": "Archivos que coinciden",
  "quickOpen.type": "Escribe parte de un nombre de archivo",
  "quickOpen.none": "Ningún nombre de archivo contiene “{q}”.",
  "quickOpen.searchText": "Busca en el texto de los archivos con {key}",
  "quickOpen.noFolder": "Abre una sesión para buscar los archivos de su carpeta",
  "quickOpen.more": "Coinciden más archivos. Escribe más del nombre",
  "quickOpen.failed": "No se pudieron leer los nombres de archivo. Inténtalo de nuevo",
};

export const fr = {
  "settings.kbd.cmd.files.quickOpen": "Aller au fichier",
  "quickOpen.search": "Nom de fichier",
  "quickOpen.list": "Fichiers correspondants",
  "quickOpen.type": "Saisissez une partie d’un nom de fichier",
  "quickOpen.none": "Aucun nom de fichier ne contient « {q} ».",
  "quickOpen.searchText": "Cherchez dans le texte des fichiers avec {key}",
  "quickOpen.noFolder": "Ouvrez une session pour trouver les fichiers de son dossier",
  "quickOpen.more": "D’autres fichiers correspondent. Saisissez davantage du nom",
  "quickOpen.failed": "Impossible de lire les noms de fichiers. Réessayez",
};

export const pt = {
  "settings.kbd.cmd.files.quickOpen": "Ir para o arquivo",
  "quickOpen.search": "Nome do arquivo",
  "quickOpen.list": "Arquivos correspondentes",
  "quickOpen.type": "Digite parte de um nome de arquivo",
  "quickOpen.none": "Nenhum nome de arquivo contém “{q}”.",
  "quickOpen.searchText": "Busque no texto dos arquivos com {key}",
  "quickOpen.noFolder": "Abra uma sessão para encontrar os arquivos da pasta dela",
  "quickOpen.more": "Mais arquivos correspondem. Digite mais do nome",
  "quickOpen.failed": "Não foi possível ler os nomes de arquivos. Tente de novo",
};
