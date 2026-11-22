// Ticket 392: a project's past Claude and Codex conversations, as one quiet row in the tree. Every language has every key.
declare module '../index' {
  interface AreaKeys {
    'past.title': true;
    'past.count': true;
    'past.label': true;
    'past.more': true;
    'past.untitled': true;
    'past.item': true;
    'past.failed': true;
  }
}

export const en = { 'past.title': 'Past conversations', 'past.count': '{n}', 'past.label': 'Past conversations {n}', 'past.more': '{n} more', 'past.untitled': 'Untitled conversation', 'past.item': '{title}, {agent}, {age}, read-only', 'past.failed': 'Could not open it: {error}' };
export const ko = { 'past.title': '지난 대화', 'past.count': '{n}개', 'past.label': '지난 대화 {n}개', 'past.more': '{n}개 더 보기', 'past.untitled': '제목 없는 대화', 'past.item': '{title}, {agent}, {age}, 읽기 전용', 'past.failed': '열지 못했습니다: {error}' };
export const ja = { 'past.title': '過去の会話', 'past.count': '{n} 件', 'past.label': '過去の会話 {n} 件', 'past.more': 'さらに {n} 件', 'past.untitled': '無題の会話', 'past.item': '{title}、{agent}、{age}、読み取り専用', 'past.failed': '開けませんでした：{error}' };
export const zhHans = { 'past.title': '过去的对话', 'past.count': '{n} 个', 'past.label': '过去的对话 {n} 个', 'past.more': '再显示 {n} 个', 'past.untitled': '无标题对话', 'past.item': '{title}，{agent}，{age}，只读', 'past.failed': '无法打开：{error}' };
export const zhHant = { 'past.title': '過去的對話', 'past.count': '{n} 個', 'past.label': '過去的對話 {n} 個', 'past.more': '再顯示 {n} 個', 'past.untitled': '無標題對話', 'past.item': '{title}，{agent}，{age}，唯讀', 'past.failed': '無法開啟：{error}' };
export const es = { 'past.title': 'Conversaciones anteriores', 'past.count': '{n}', 'past.label': 'Conversaciones anteriores {n}', 'past.more': '{n} más', 'past.untitled': 'Conversación sin título', 'past.item': '{title}, {agent}, {age}, solo lectura', 'past.failed': 'No se pudo abrir: {error}' };
export const fr = { 'past.title': 'Conversations passées', 'past.count': '{n}', 'past.label': 'Conversations passées {n}', 'past.more': "{n} autres", 'past.untitled': 'Conversation sans titre', 'past.item': '{title}, {agent}, {age}, lecture seule', 'past.failed': 'Ouverture impossible : {error}' };
export const pt = { 'past.title': 'Conversas anteriores', 'past.count': '{n}', 'past.label': 'Conversas anteriores {n}', 'past.more': 'Mais {n}', 'past.untitled': 'Conversa sem título', 'past.item': '{title}, {agent}, {age}, somente leitura', 'past.failed': 'Não foi possível abrir: {error}' };
