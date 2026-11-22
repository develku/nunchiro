// Ticket 480: the plain words for the error places ticket 476 did not reach.
declare module '../index' {
  interface AreaKeys {
    "err.themeOffline": true;
    "err.layoutTrees": true;
    "err.olderNotLoaded": true;
  }
}

export const en = {
  "err.themeOffline": "Can't reach GitHub; installed themes still work",
  "err.layoutTrees": "layout.toml has {n} Trees: {error}",
  "err.olderNotLoaded": "Older messages did not load: {error}",
};
export const ko = {
  "err.themeOffline": "GitHub에 연결할 수 없습니다. 설치된 테마는 계속 쓸 수 있습니다",
  "err.layoutTrees": "layout.toml에 트리가 {n}개 있습니다: {error}",
  "err.olderNotLoaded": "이전 메시지를 불러오지 못했습니다: {error}",
};
export const ja = {
  "err.themeOffline": "GitHub に接続できません。インストール済みのテーマはそのまま使えます",
  "err.layoutTrees": "layout.toml にツリーが {n} 個あります：{error}",
  "err.olderNotLoaded": "以前のメッセージを読み込めませんでした：{error}",
};
export const zhHans = {
  "err.themeOffline": "无法连接 GitHub；已安装的主题仍可使用",
  "err.layoutTrees": "layout.toml 中有 {n} 个树：{error}",
  "err.olderNotLoaded": "较早的消息未能加载：{error}",
};
export const zhHant = {
  "err.themeOffline": "無法連線到 GitHub；已安裝的主題仍可使用",
  "err.layoutTrees": "layout.toml 中有 {n} 個樹狀清單：{error}",
  "err.olderNotLoaded": "較早的訊息未能載入：{error}",
};
export const es = {
  "err.themeOffline": "No se puede conectar con GitHub; los temas instalados siguen funcionando",
  "err.layoutTrees": "layout.toml tiene {n} árboles: {error}",
  "err.olderNotLoaded": "No se cargaron los mensajes anteriores: {error}",
};
export const fr = {
  "err.themeOffline": "Impossible de joindre GitHub ; les thèmes installés fonctionnent toujours",
  "err.layoutTrees": "layout.toml contient {n} arborescences : {error}",
  "err.olderNotLoaded": "Les messages précédents ne se sont pas chargés : {error}",
};
export const pt = {
  "err.themeOffline": "Não foi possível acessar o GitHub; os temas instalados continuam funcionando",
  "err.layoutTrees": "layout.toml tem {n} árvores: {error}",
  "err.olderNotLoaded": "As mensagens anteriores não carregaram: {error}",
};
