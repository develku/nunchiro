// Ticket 392: a project's past Claude and Codex conversations (ticket 1073: rows in History). Every language has every key.
declare module '../index' {
  interface AreaKeys {
    'past.untitled': true;
    'past.failed': true;
  }
}

export const en = { 'past.untitled': 'Untitled conversation', 'past.failed': 'Could not open it: {error}' };
export const ko = { 'past.untitled': '제목 없는 대화', 'past.failed': '열지 못했습니다: {error}' };
export const ja = { 'past.untitled': '無題の会話', 'past.failed': '開けませんでした：{error}' };
export const zhHans = { 'past.untitled': '无标题对话', 'past.failed': '无法打开：{error}' };
export const zhHant = { 'past.untitled': '無標題對話', 'past.failed': '無法開啟：{error}' };
export const es = { 'past.untitled': 'Conversación sin título', 'past.failed': 'No se pudo abrir: {error}' };
export const fr = { 'past.untitled': 'Conversation sans titre', 'past.failed': 'Ouverture impossible : {error}' };
export const pt = { 'past.untitled': 'Conversa sem título', 'past.failed': 'Não foi possível abrir: {error}' };
