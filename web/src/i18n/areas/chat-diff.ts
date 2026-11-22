// Ticket 222 (B19): Diff's "Latest turn / Changes" scope and the chat's per-turn "N changed files" row; the header
// and list states (review SHOULD, V2.5-63).
declare module '../index' {
  interface AreaKeys {
    'diff.scope.label': true;
    'diff.scope.turn': true;
    'diff.scope.changes': true;
    'diff.scope.noTurn': true;
    'diff.scope.turnEmpty': true;
    'diff.scope.turnBase': true;
    'diff.turnRow.one': true;
    'diff.turnRow.other': true;
    'diff.turnRow.open': true;
    'diff.turnRow.more': true;
    'diff.state.noSession': true;
    'diff.state.error': true;
    'diff.state.loading': true;
    'diff.state.baseUnknown': true;
    'diff.state.baseMissing': true;
    'diff.state.notGit': true;
    'diff.state.noChanges': true;
    'diff.truncated': true;
    'diff.head.vs': true;
    'diff.head.emptyRepo': true;
    'diff.head.sessionStart': true;
    'diff.head.checkoutStart': true;
    'diff.head.files.one': true;
    'diff.head.files.other': true;
  }
}

export const en = {
  'diff.scope.label': 'Diff scope',
  'diff.scope.turn': 'Turn files',
  'diff.scope.changes': 'Changes',
  'diff.scope.noTurn': 'No turn has finished yet in this session, so there is no latest turn to show.',
  'diff.scope.turnEmpty': 'The last turn changed no files.',
  'diff.scope.turnBase': 'the files of this turn, with all later changes',
  'diff.turnRow.one': '{n} changed file',
  'diff.turnRow.other': '{n} changed files',
  'diff.turnRow.open': 'Open diff',
  'diff.turnRow.more': '… and {n} more',
  'diff.state.noSession': 'Open a session to see its changes.',
  'diff.state.error': 'Diff is unavailable: {error}',
  'diff.state.loading': 'Loading changes…',
  'diff.state.baseUnknown': 'Start commit unknown: this session started before Nunchiro recorded it, so there is nothing to compare with.',
  'diff.state.baseMissing': 'The start commit no longer exists. Git history was rewritten or cleaned up, so there is nothing to compare.',
  'diff.state.notGit': 'This folder is not a git repository, so there are no changes to show.',
  'diff.state.noChanges': 'No changes since the session started.',
  'diff.truncated': 'Showing the first {n} files; more changed.',
  'diff.head.vs': 'vs {base}',
  'diff.head.emptyRepo': 'an empty repository',
  'diff.head.sessionStart': 'session start',
  'diff.head.checkoutStart': 'this checkout since session start',
  'diff.head.files.one': '{n} file',
  'diff.head.files.other': '{n} files',
};
export const ko = {
  'diff.scope.label': 'Diff 범위',
  'diff.scope.turn': '턴 파일만',
  'diff.scope.changes': '변경 전체',
  'diff.scope.noTurn': "이 세션에서 아직 끝난 턴이 없어 마지막 턴을 보여 드릴 수 없습니다.",
  'diff.scope.turnEmpty': "마지막 턴은 파일을 바꾸지 않았습니다.",
  'diff.scope.turnBase': '이 턴의 파일만, 그 이후의 변경 전체',
  'diff.turnRow.one': '파일 {n}개 변경',
  'diff.turnRow.other': '파일 {n}개 변경',
  'diff.turnRow.open': 'Diff 열기',
  'diff.turnRow.more': '… 외 {n}개',
  'diff.state.noSession': "세션을 열면 변경 사항이 표시됩니다.",
  'diff.state.error': "Diff를 사용할 수 없습니다: {error}",
  'diff.state.loading': '변경 사항을 불러오는 중…',
  'diff.state.baseUnknown': "시작 커밋을 알 수 없습니다. 이 세션은 Nunchiro가 기록하기 전에 시작되어 비교할 대상이 없습니다.",
  'diff.state.baseMissing': "시작 커밋이 더 이상 없습니다(기록이 다시 쓰였거나 정리됨). 비교할 대상이 없습니다.",
  'diff.state.notGit': "이 폴더는 git 저장소가 아니라서 표시할 변경 사항이 없습니다.",
  'diff.state.noChanges': "세션이 시작된 뒤로 변경 사항이 없습니다.",
  'diff.truncated': "처음 {n}개 파일만 표시합니다. 더 많은 파일이 바뀌었습니다.",
  'diff.head.vs': '{base} 기준',
  'diff.head.emptyRepo': '빈 저장소',
  'diff.head.sessionStart': '세션 시작',
  'diff.head.checkoutStart': '세션 시작 이후 이 체크아웃',
  'diff.head.files.one': '파일 {n}개',
  'diff.head.files.other': '파일 {n}개',
};
export const ja = {
  'diff.scope.label': '差分の範囲',
  'diff.scope.turn': 'ターンのファイル',
  'diff.scope.changes': 'すべての変更',
  'diff.scope.noTurn': 'このセッションではまだターンが終わっていないため、最新のターンはありません。',
  'diff.scope.turnEmpty': '最新のターンで変更されたファイルはありません。',
  'diff.scope.turnBase': 'このターンのファイル（それ以降の変更もすべて含む）',
  'diff.turnRow.one': '{n} 件のファイルを変更',
  'diff.turnRow.other': '{n} 件のファイルを変更',
  'diff.turnRow.open': '差分を開く',
  'diff.turnRow.more': '… ほか {n} 件',
  'diff.state.noSession': 'セッションを開くと変更が表示されます。',
  'diff.state.error': '差分を利用できません：{error}',
  'diff.state.loading': '変更を読み込み中…',
  'diff.state.baseUnknown': '開始コミットが不明です。このセッションは Nunchiro が記録する前に始まったため、比較対象がありません。',
  'diff.state.baseMissing': '開始コミットはもう存在しません（履歴の書き換えまたはガベージコレクション）。比較対象がありません。',
  'diff.state.notGit': 'このフォルダーは git リポジトリではないため、表示する変更はありません。',
  'diff.state.noChanges': 'セッション開始以降の変更はありません。',
  'diff.truncated': '最初の {n} 件のファイルを表示しています。ほかにも変更があります。',
  'diff.head.vs': '{base} と比較',
  'diff.head.emptyRepo': '空のリポジトリ',
  'diff.head.sessionStart': 'セッション開始',
  'diff.head.checkoutStart': 'セッション開始以降のこのチェックアウト',
  'diff.head.files.one': '{n} 件のファイル',
  'diff.head.files.other': '{n} 件のファイル',
};
export const zhHans = {
  'diff.scope.label': '差异范围',
  'diff.scope.turn': '本轮文件',
  'diff.scope.changes': '全部更改',
  'diff.scope.noTurn': '此会话尚无已完成的轮次，因此没有最新一轮可显示。',
  'diff.scope.turnEmpty': '最新一轮没有更改任何文件。',
  'diff.scope.turnBase': '仅本轮的文件，含此后的全部改动',
  'diff.turnRow.one': '已更改 {n} 个文件',
  'diff.turnRow.other': '已更改 {n} 个文件',
  'diff.turnRow.open': '打开差异',
  'diff.turnRow.more': '… 另有 {n} 个',
  'diff.state.noSession': '打开一个会话以查看其更改。',
  'diff.state.error': '差异不可用：{error}',
  'diff.state.loading': '正在加载更改…',
  'diff.state.baseUnknown': '起始提交未知：此会话在 Nunchiro 记录它之前就已开始，因此没有可比较的对象。',
  'diff.state.baseMissing': '起始提交已不存在（历史被改写或已被垃圾回收），因此没有可比较的对象。',
  'diff.state.notGit': '此文件夹不是 git 仓库，因此没有可显示的更改。',
  'diff.state.noChanges': '自会话开始以来没有更改。',
  'diff.truncated': '仅显示前 {n} 个文件；还有更多更改。',
  'diff.head.vs': '对比 {base}',
  'diff.head.emptyRepo': '空仓库',
  'diff.head.sessionStart': '会话开始',
  'diff.head.checkoutStart': '会话开始以来的此检出',
  'diff.head.files.one': '{n} 个文件',
  'diff.head.files.other': '{n} 个文件',
};
export const zhHant = {
  'diff.scope.label': '差異範圍',
  'diff.scope.turn': '本輪檔案',
  'diff.scope.changes': '全部變更',
  'diff.scope.noTurn': '此工作階段尚無已完成的輪次，因此沒有最新一輪可顯示。',
  'diff.scope.turnEmpty': '最新一輪沒有變更任何檔案。',
  'diff.scope.turnBase': '僅本輪的檔案，含此後的全部變更',
  'diff.turnRow.one': '已變更 {n} 個檔案',
  'diff.turnRow.other': '已變更 {n} 個檔案',
  'diff.turnRow.open': '開啟差異',
  'diff.turnRow.more': '… 另有 {n} 個',
  'diff.state.noSession': '開啟一個工作階段以查看其變更。',
  'diff.state.error': '差異無法使用：{error}',
  'diff.state.loading': '正在載入變更…',
  'diff.state.baseUnknown': '起始提交未知：此工作階段在 Nunchiro 記錄它之前就已開始，因此沒有可比較的對象。',
  'diff.state.baseMissing': '起始提交已不存在。Git 歷史已被改寫或清理，因此沒有可比較的對象。',
  'diff.state.notGit': '此資料夾不是 git 儲存庫，因此沒有可顯示的變更。',
  'diff.state.noChanges': '自工作階段開始以來沒有變更。',
  'diff.truncated': '僅顯示前 {n} 個檔案；還有更多變更。',
  'diff.head.vs': '對比 {base}',
  'diff.head.emptyRepo': '空儲存庫',
  'diff.head.sessionStart': '工作階段開始',
  'diff.head.checkoutStart': '工作階段開始以來的此簽出',
  'diff.head.files.one': '{n} 個檔案',
  'diff.head.files.other': '{n} 個檔案',
};
export const es = {
  'diff.scope.label': 'Alcance de Diff',
  'diff.scope.turn': 'Archivos del turno',
  'diff.scope.changes': 'Cambios',
  'diff.scope.noTurn': 'Aún no ha terminado ningún turno en esta sesión, así que no hay último turno que mostrar.',
  'diff.scope.turnEmpty': 'El último turno no cambió ningún archivo.',
  'diff.scope.turnBase': 'solo los archivos de este turno, con todos sus cambios desde entonces',
  'diff.turnRow.one': '{n} archivo cambiado',
  'diff.turnRow.other': '{n} archivos cambiados',
  'diff.turnRow.open': 'Abrir diff',
  'diff.turnRow.more': '… y {n} más',
  'diff.state.noSession': 'Abre una sesión para ver sus cambios.',
  'diff.state.error': 'Diff no está disponible: {error}',
  'diff.state.loading': 'Cargando cambios…',
  'diff.state.baseUnknown': 'Commit inicial desconocido: esta sesión empezó antes de que Nunchiro lo registrara, así que no hay nada con qué comparar.',
  'diff.state.baseMissing': 'El commit inicial ya no existe (el historial se reescribió o se eliminó por recolección de basura), así que no hay nada con qué comparar.',
  'diff.state.notGit': 'Esta carpeta no es un repositorio git, así que no hay cambios que mostrar.',
  'diff.state.noChanges': 'No hay cambios desde que empezó la sesión.',
  'diff.truncated': 'Se muestran los primeros {n} archivos; hay más cambios.',
  'diff.head.vs': 'vs {base}',
  'diff.head.emptyRepo': 'un repositorio vacío',
  'diff.head.sessionStart': 'inicio de la sesión',
  'diff.head.checkoutStart': 'esta copia desde el inicio de la sesión',
  'diff.head.files.one': '{n} archivo',
  'diff.head.files.other': '{n} archivos',
};
export const fr = {
  'diff.scope.label': 'Portée du Diff',
  'diff.scope.turn': 'Fichiers du tour',
  'diff.scope.changes': 'Modifications',
  'diff.scope.noTurn': 'Aucun tour n’est encore terminé dans cette session : il n’y a pas de dernier tour à afficher.',
  'diff.scope.turnEmpty': 'Le dernier tour n’a modifié aucun fichier.',
  'diff.scope.turnBase': 'seulement les fichiers de ce tour, avec tous leurs changements depuis',
  'diff.turnRow.one': '{n} fichier modifié',
  'diff.turnRow.other': '{n} fichiers modifiés',
  'diff.turnRow.open': 'Ouvrir le diff',
  'diff.turnRow.more': "… et {n} autres",
  'diff.state.noSession': 'Ouvrez une session pour voir ses modifications.',
  'diff.state.error': "Diff indisponible : {error}",
  'diff.state.loading': 'Chargement des modifications…',
  'diff.state.baseUnknown': 'Commit de départ inconnu : cette session a commencé avant que Nunchiro ne l’enregistre, il n’y a donc rien à comparer.',
  'diff.state.baseMissing': 'Le commit de départ n’existe plus (historique réécrit ou nettoyé par le ramasse-miettes), il n’y a donc rien à comparer.',
  'diff.state.notGit': 'Ce dossier n’est pas un dépôt git, il n’y a donc aucune modification à afficher.',
  'diff.state.noChanges': 'Aucune modification depuis le début de la session.',
  'diff.truncated': 'Affichage des {n} premiers fichiers ; d’autres ont changé.',
  'diff.head.vs': 'vs {base}',
  'diff.head.emptyRepo': 'un dépôt vide',
  'diff.head.sessionStart': 'début de session',
  'diff.head.checkoutStart': 'cette copie depuis le début de session',
  'diff.head.files.one': '{n} fichier',
  'diff.head.files.other': '{n} fichiers',
};
export const pt = {
  'diff.scope.label': 'Escopo do diff',
  'diff.scope.turn': 'Arquivos do turno',
  'diff.scope.changes': 'Alterações',
  'diff.scope.noTurn': 'Nenhum turno terminou ainda nesta sessão, então não há último turno para mostrar.',
  'diff.scope.turnEmpty': 'O último turno não alterou nenhum arquivo.',
  'diff.scope.turnBase': 'só os arquivos deste turno, com todas as mudanças desde então',
  'diff.turnRow.one': '{n} arquivo alterado',
  'diff.turnRow.other': '{n} arquivos alterados',
  'diff.turnRow.open': 'Abrir diff',
  'diff.turnRow.more': '… e mais {n}',
  'diff.state.noSession': 'Abra uma sessão para ver as alterações.',
  'diff.state.error': 'O diff não está disponível: {error}',
  'diff.state.loading': 'Carregando alterações…',
  'diff.state.baseUnknown': 'Commit inicial desconhecido: esta sessão começou antes de o Nunchiro registrá-lo, então não há com o que comparar.',
  'diff.state.baseMissing': "O commit inicial não existe mais (o histórico foi reescrito ou limpo pelo garbage collector), então não há com o que comparar.",
  'diff.state.notGit': 'Esta pasta não é um repositório git, então não há alterações para mostrar.',
  'diff.state.noChanges': 'Nenhuma alteração desde o início da sessão.',
  'diff.truncated': 'Mostrando os primeiros {n} arquivos; há mais alterações.',
  'diff.head.vs': 'vs {base}',
  'diff.head.emptyRepo': 'um repositório vazio',
  'diff.head.sessionStart': 'início da sessão',
  'diff.head.checkoutStart': 'esta cópia desde o início da sessão',
  'diff.head.files.one': '{n} arquivo',
  'diff.head.files.other': '{n} arquivos',
};
