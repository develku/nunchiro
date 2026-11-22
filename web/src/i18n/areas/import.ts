// V2.5-12 first-run import of existing claude/codex conversations (read only; needs 137).
declare module '../index' {
  interface AreaKeys {
    'import.step': true;
    'import.look': true;
    'import.looking': true;
    'import.empty': true;
    'import.hint': true;
    'import.selectAll': true;
    'import.run': true;
    'import.done.one': true;
    'import.done.other': true;
    'import.importing': true;
    'import.imported': true;
    'import.searchLabel': true;
    'import.searchGo': true;
    'import.noHits': true;
    'import.untitled': true;
    'import.failed': true;
    'import.readOnlyNote': true;
    'import.openHit': true;
    'import.truncated': true;
    'import.readFailed': true;
    'import.reading': true;
  }
}
export const en = {
  'import.step': 'Import existing conversations',
  'import.look': 'Look for conversations',
  'import.looking': 'Looking…',
  'import.empty': 'No conversations found in ~/.claude or ~/.codex.',
  'import.hint': 'Read only. Nunchiro never writes to ~/.claude or ~/.codex. You can search imported conversations here, but you cannot resume them as live sessions.',
  'import.selectAll': 'Select all',
  'import.run': 'Import {n} selected',
  'import.done.one': 'Imported {n} conversation.',
  'import.done.other': 'Imported {n} conversations.',
  'import.importing': 'Importing…',
  'import.imported': 'imported',
  'import.searchLabel': 'Search imported conversations',
  'import.searchGo': 'Search',
  'import.noHits': 'No match in the imported conversations.',
  'import.untitled': 'Untitled conversation',
  'import.failed': 'Import failed: {error}',
  'import.readOnlyNote': 'Imported · read-only',
  'import.openHit': 'Open this conversation (read-only)',
  'import.truncated': 'Showing the first {n} entries; {left} left out',
  'import.readFailed': 'Could not read this conversation: {error}',
  'import.reading': 'Reading…',
};
export const ko = {
  'import.step': '기존 대화 가져오기',
  'import.look': '대화 찾기',
  'import.looking': '찾는 중…',
  'import.empty': '~/.claude 또는 ~/.codex에서 대화를 찾지 못했습니다.',
  'import.hint': '읽기 전용: Nunchiro는 ~/.claude와 ~/.codex에 아무것도 쓰지 않습니다. 가져온 대화는 여기서 검색할 수 있고, 실행 중인 세션으로 이어지지는 않습니다.',
  'import.selectAll': '모두 선택',
  'import.run': '{n}개 가져오기',
  'import.done.one': '대화 {n}개를 가져왔습니다.',
  'import.done.other': '대화 {n}개를 가져왔습니다.',
  'import.importing': '가져오는 중…',
  'import.imported': '가져옴',
  'import.searchLabel': '가져온 대화 검색',
  'import.searchGo': '검색',
  'import.noHits': '가져온 대화에 일치하는 내용이 없습니다.',
  'import.untitled': '제목 없는 대화',
  'import.failed': '가져오기 실패: {error}',
  'import.readOnlyNote': '가져옴 · 읽기 전용',
  'import.openHit': '이 대화 열기 (읽기 전용)',
  'import.truncated': '처음 {n}개 항목만 표시합니다. {left}개는 생략했습니다',
  'import.readFailed': '이 대화를 읽지 못했습니다: {error}',
  'import.reading': '읽는 중…',
};
export const ja = {
  'import.step': '既存の会話をインポート',
  'import.look': '会話を探す',
  'import.looking': '探しています…',
  'import.empty': '~/.claude または ~/.codex に会話が見つかりません。',
  'import.hint': '読み取り専用：Nunchiro は ~/.claude と ~/.codex に何も書き込みません。インポートした会話はここで検索できますが、実行中のセッションとして再開はされません。',
  'import.selectAll': 'すべて選択',
  'import.run': '選択した {n} 件をインポート',
  'import.done.one': '{n} 件の会話をインポートしました。',
  'import.done.other': '{n} 件の会話をインポートしました。',
  'import.importing': 'インポート中…',
  'import.imported': 'インポート済み',
  'import.searchLabel': 'インポートした会話を検索',
  'import.searchGo': '検索',
  'import.noHits': 'インポートした会話に一致するものはありません。',
  'import.untitled': '無題の会話',
  'import.failed': 'インポートに失敗しました：{error}',
  'import.readOnlyNote': 'インポート済み · 読み取り専用',
  'import.openHit': 'この会話を開く（読み取り専用）',
  'import.truncated': '最初の {n} 件を表示しています。{left} 件は省略されました',
  'import.readFailed': 'この会話を読み込めませんでした：{error}',
  'import.reading': '読み込み中…',
};
export const zhHans = {
  'import.step': '导入已有对话',
  'import.look': '查找对话',
  'import.looking': '查找中…',
  'import.empty': '在 ~/.claude 或 ~/.codex 中没有找到对话。',
  'import.hint': '只读：Nunchiro 绝不会写入 ~/.claude 或 ~/.codex。导入的对话可以在这里搜索，但不会作为运行中的会话恢复。',
  'import.selectAll': '全选',
  'import.run': '导入所选 {n} 个',
  'import.done.one': '已导入 {n} 个对话。',
  'import.done.other': '已导入 {n} 个对话。',
  'import.importing': '正在导入…',
  'import.imported': '已导入',
  'import.searchLabel': '搜索已导入的对话',
  'import.searchGo': '搜索',
  'import.noHits': '已导入的对话中没有匹配项。',
  'import.untitled': '无标题对话',
  'import.failed': '导入失败：{error}',
  'import.readOnlyNote': '已导入 · 只读',
  'import.openHit': '打开此对话（只读）',
  'import.truncated': '显示前 {n} 条；另有 {left} 条未显示',
  'import.readFailed': '无法读取此对话：{error}',
  'import.reading': '读取中…',
};
export const zhHant = {
  'import.step': '匯入既有對話',
  'import.look': '尋找對話',
  'import.looking': '尋找中…',
  'import.empty': '在 ~/.claude 或 ~/.codex 中找不到對話。',
  'import.hint': '唯讀：Nunchiro 絕不會寫入 ~/.claude 或 ~/.codex。匯入的對話可在此搜尋，但不會作為執行中的工作階段繼續。',
  'import.selectAll': '全選',
  'import.run': '匯入所選 {n} 個',
  'import.done.one': '已匯入 {n} 個對話。',
  'import.done.other': '已匯入 {n} 個對話。',
  'import.importing': '正在匯入…',
  'import.imported': '已匯入',
  'import.searchLabel': '搜尋已匯入的對話',
  'import.searchGo': '搜尋',
  'import.noHits': '已匯入的對話中沒有符合項目。',
  'import.untitled': '未命名對話',
  'import.failed': '匯入失敗：{error}',
  'import.readOnlyNote': '已匯入 · 唯讀',
  'import.openHit': '開啟此對話（唯讀）',
  'import.truncated': '顯示前 {n} 筆；另有 {left} 筆未顯示',
  'import.readFailed': '無法讀取此對話：{error}',
  'import.reading': '讀取中…',
};
export const es = {
  'import.step': 'Importar conversaciones existentes',
  'import.look': 'Buscar conversaciones',
  'import.looking': 'Buscando…',
  'import.empty': 'No se encontraron conversaciones en ~/.claude ni en ~/.codex.',
  'import.hint': 'Solo lectura: Nunchiro nunca escribe en ~/.claude ni en ~/.codex. Las conversaciones importadas se pueden buscar aquí; no se reanudan como sesiones activas.',
  'import.selectAll': 'Seleccionar todo',
  'import.run': 'Importar {n} seleccionadas',
  'import.done.one': 'Se importó {n} conversación.',
  'import.done.other': 'Se importaron {n} conversaciones.',
  'import.importing': 'Importando…',
  'import.imported': 'importada',
  'import.searchLabel': 'Buscar en las conversaciones importadas',
  'import.searchGo': 'Buscar',
  'import.noHits': 'Sin coincidencias en las conversaciones importadas.',
  'import.untitled': 'Conversación sin título',
  'import.failed': 'Error al importar: {error}',
  'import.readOnlyNote': 'Importada · solo lectura',
  'import.openHit': 'Abrir esta conversación (solo lectura)',
  'import.truncated': 'Se muestran las primeras {n} entradas; {left} omitidas',
  'import.readFailed': 'No se pudo leer esta conversación: {error}',
  'import.reading': 'Leyendo…',
};
export const fr = {
  'import.step': 'Importer les conversations existantes',
  'import.look': 'Chercher des conversations',
  'import.looking': 'Recherche…',
  'import.empty': 'Aucune conversation trouvée dans ~/.claude ou ~/.codex.',
  'import.hint': 'Lecture seule : Nunchiro n’écrit jamais dans ~/.claude ni ~/.codex. Les conversations importées sont consultables ici ; elles ne reprennent pas comme sessions actives.',
  'import.selectAll': 'Tout sélectionner',
  'import.run': 'Importer {n} sélectionnées',
  'import.done.one': '{n} conversation importée.',
  'import.done.other': '{n} conversations importées.',
  'import.importing': 'Importation…',
  'import.imported': 'importée',
  'import.searchLabel': 'Rechercher dans les conversations importées',
  'import.searchGo': 'Rechercher',
  'import.noHits': 'Aucun résultat dans les conversations importées.',
  'import.untitled': 'Conversation sans titre',
  'import.failed': 'Échec de l’importation : {error}',
  'import.readOnlyNote': 'Importée · lecture seule',
  'import.openHit': 'Ouvrir cette conversation (lecture seule)',
  'import.truncated': 'Affichage des {n} premières entrées ; {left} omises',
  'import.readFailed': 'Impossible de lire cette conversation : {error}',
  'import.reading': 'Lecture…',
};
export const pt = {
  'import.step': 'Importar conversas existentes',
  'import.look': 'Procurar conversas',
  'import.looking': 'Procurando…',
  'import.empty': 'Nenhuma conversa encontrada em ~/.claude ou ~/.codex.',
  'import.hint': 'Somente leitura: o Nunchiro nunca grava em ~/.claude nem em ~/.codex. Você pode buscar nas conversas importadas aqui; elas não são retomadas como sessões ativas.',
  'import.selectAll': 'Selecionar tudo',
  'import.run': 'Importar {n} selecionadas',
  'import.done.one': '{n} conversa importada.',
  'import.done.other': '{n} conversas importadas.',
  'import.importing': 'Importando…',
  'import.imported': 'importada',
  'import.searchLabel': 'Buscar nas conversas importadas',
  'import.searchGo': 'Buscar',
  'import.noHits': 'Nenhum resultado nas conversas importadas.',
  'import.untitled': 'Conversa sem título',
  'import.failed': 'Falha ao importar: {error}',
  'import.readOnlyNote': 'Importada · somente leitura',
  'import.openHit': 'Abrir esta conversa (somente leitura)',
  'import.truncated': 'Mostrando as primeiras {n} entradas; {left} omitidas',
  'import.readFailed': 'Não foi possível ler esta conversa: {error}',
  'import.reading': 'Lendo…',
};
