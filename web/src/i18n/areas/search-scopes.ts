// Ticket 493: a Files search with no match says where a conversation's words are, and offers the Sessions search for them.
declare module '../index' {
  interface AreaKeys {
    'search.files.noneHint': true;
    'search.files.trySessions': true;
  }
}
export const en = {
  'search.files.noneHint': "Files searches this folder only. To search chats, use Sessions.",
  'search.files.trySessions': "Search sessions",
};
export const ko = {
  'search.files.noneHint': "파일은 이 폴더만 찾습니다. 대화에 나온 말은 세션에서 찾으세요.",
  'search.files.trySessions': "세션에서 찾기",
};
export const ja = {
  'search.files.noneHint': "「ファイル」はこのフォルダーだけを検索します。チャット内の語句は「セッション」で検索できます。",
  'search.files.trySessions': "セッションを検索",
};
export const zhHans = {
  'search.files.noneHint': "文件只搜索此文件夹。聊天中的文字请在会话中搜索。",
  'search.files.trySessions': "搜索会话",
};
export const zhHant = {
  'search.files.noneHint': "檔案只搜尋此資料夾。聊天中的文字請在工作階段中搜尋。",
  'search.files.trySessions': "搜尋工作階段",
};
export const es = {
  'search.files.noneHint': "Archivos busca solo en esta carpeta. Para buscar en los chats, usa Sesiones.",
  'search.files.trySessions': "Buscar en sesiones",
};
export const fr = {
  'search.files.noneHint': "Fichiers cherche seulement dans ce dossier. Pour chercher dans les conversations, utilisez Sessions.",
  'search.files.trySessions': "Chercher dans les sessions",
};
export const pt = {
  'search.files.noneHint': "A busca em Arquivos olha só nesta pasta. Para buscar nas conversas, use Sessões.",
  'search.files.trySessions': "Buscar nas sessões",
};
