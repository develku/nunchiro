// Ticket 374 (mock-m3 374.html scenes newwt, pr, tidy): a new worktree starts from origin's default branch, a PR link
// fetches the PR's code, and Tidy lists worktrees with no commits.
declare module '../index' {
  interface AreaKeys {
    'wtbase.fetchedFirst': true;
    'wtbase.basePlaceholder': true;
    'wtbase.stale': true;
    'wtbase.prFetch': true;
    'wtbase.prForeign': true;
    'wtbase.prStale': true;
    'wtbase.group.empty': true;
    'wtbase.emptyClosed': true;
    'wtbase.emptyNone': true;
  }
}

export const en = {
  'wtbase.fetchedFirst': '(fetched before creating)',
  'wtbase.basePlaceholder': "Base branch (default: origin's default branch)",
  'wtbase.stale': "Could not reach GitHub, so the worktree was made from the last downloaded {branch}.",
  'wtbase.prFetch': "Could not fetch the PR’s code (network). No branch or folder was made.",
  'wtbase.prForeign': "This PR belongs to a different repository than this project.",
  'wtbase.prStale': "This PR’s branch already exists at an older commit. Delete it to get the newest commit.",
  'wtbase.group.empty': 'No commits',
  'wtbase.emptyClosed': 'No new commits against the current branch · session closed',
  'wtbase.emptyNone': 'No new commits against the current branch · no session',
};

export const ko = {
  'wtbase.fetchedFirst': '(생성 전에 가져옴)',
  'wtbase.basePlaceholder': '기준 브랜치(기본값: origin의 기본 브랜치)',
  'wtbase.stale': 'GitHub에 연결하지 못해 마지막으로 가져온 {branch} 기준으로 만들었습니다.',
  'wtbase.prFetch': 'PR 코드를 가져오지 못했습니다 (네트워크). 브랜치와 폴더는 만들지 않았습니다.',
  'wtbase.prForeign': '이 PR의 저장소가 이 프로젝트의 원격과 다릅니다.',
  'wtbase.prStale': '이 PR의 브랜치가 이전 커밋에 이미 있습니다. 새 헤드를 받으려면 그 브랜치를 삭제하세요.',
  'wtbase.group.empty': '커밋 없음',
  'wtbase.emptyClosed': '현재 브랜치 기준 새 커밋 없음 · 세션 닫힘',
  'wtbase.emptyNone': '현재 브랜치 기준 새 커밋 없음 · 세션 없음',
};

export const ja = {
  'wtbase.fetchedFirst': '（作成前に取得）',
  'wtbase.basePlaceholder': "ベースブランチ（デフォルト：origin のデフォルトブランチ）",
  'wtbase.stale': 'GitHub に接続できなかったため、最後に取得した {branch} から作成しました。',
  'wtbase.prFetch': 'PR のコードを取得できませんでした（ネットワーク）。ブランチとフォルダーは作成していません。',
  'wtbase.prForeign': 'この PR のリポジトリはこのプロジェクトのリモートではありません。',
  'wtbase.prStale': 'この PR のブランチは古いコミットのまま既にあります。新しいヘッドを取り出すにはそのブランチを削除してください。',
  'wtbase.group.empty': 'コミットなし',
  'wtbase.emptyClosed': '現在のブランチに対して新しいコミットなし · セッション終了',
  'wtbase.emptyNone': '現在のブランチに対して新しいコミットなし · セッションなし',
};

export const zhHans = {
  'wtbase.fetchedFirst': '（创建前获取）',
  'wtbase.basePlaceholder': '基准分支（默认：origin 的默认分支）',
  'wtbase.stale': '无法连接 GitHub，已从上次获取的 {branch} 创建。',
  'wtbase.prFetch': '无法获取 PR 的代码（网络）。未创建分支或文件夹。',
  'wtbase.prForeign': '此 PR 的仓库不是本项目的远程仓库。',
  'wtbase.prStale': "此 PR 的分支已存在，且指向较旧的提交。请删除该分支，以检出最新提交。",
  'wtbase.group.empty': '无提交',
  'wtbase.emptyClosed': '相对当前分支无新提交 · 会话已关闭',
  'wtbase.emptyNone': '相对当前分支无新提交 · 无会话',
};

export const zhHant = {
  'wtbase.fetchedFirst': '（建立前取得）',
  'wtbase.basePlaceholder': '基準分支（預設：origin 的預設分支）',
  'wtbase.stale': '無法連線到 GitHub，已從上次取得的 {branch} 建立。',
  'wtbase.prFetch': '無法取得 PR 的程式碼（網路）。未建立分支或資料夾。',
  'wtbase.prForeign': '此 PR 的儲存庫不是本專案的遠端。',
  'wtbase.prStale': "此 PR 的分支已存在，但停在較舊的提交。請刪除該分支，才能簽出最新提交。",
  'wtbase.group.empty': '沒有提交',
  'wtbase.emptyClosed': '相對目前分支沒有新提交 · 工作階段已關閉',
  'wtbase.emptyNone': '相對目前分支沒有新提交 · 沒有工作階段',
};

export const es = {
  'wtbase.fetchedFirst': '(se trae antes de crear)',
  'wtbase.basePlaceholder': 'Rama base (predeterminada: la rama principal de origin)',
  'wtbase.stale': 'No se pudo conectar con GitHub, así que el árbol de trabajo se creó a partir de la última versión descargada de {branch}.',
  'wtbase.prFetch': 'No se pudo traer el código del PR (red). No se creó ninguna rama ni carpeta.',
  'wtbase.prForeign': 'El repositorio de este PR no es un remoto de este proyecto.',
  'wtbase.prStale': "La rama de este PR ya existe en un commit anterior. Bórrala para obtener el commit más reciente.",
  'wtbase.group.empty': 'Sin commits',
  'wtbase.emptyClosed': 'Sin commits nuevos respecto a la rama actual · sesión cerrada',
  'wtbase.emptyNone': 'Sin commits nuevos respecto a la rama actual · sin sesión',
};

export const fr = {
  'wtbase.fetchedFirst': '(récupérée avant la création)',
  'wtbase.basePlaceholder': "Branche de base (par défaut : la branche par défaut d’origin)",
  'wtbase.stale': "Impossible de joindre GitHub : créé depuis la dernière {branch} récupérée.",
  'wtbase.prFetch': "Impossible de récupérer le code de la PR (réseau). Aucune branche ni aucun dossier n’a été créé.",
  'wtbase.prForeign': "Cette PR appartient à un autre dépôt que celui de ce projet.",
  'wtbase.prStale': 'La branche de cette PR existe déjà sur un commit plus ancien. Supprimez-la pour récupérer la nouvelle tête.',
  'wtbase.group.empty': 'Aucun commit',
  'wtbase.emptyClosed': 'Aucun nouveau commit par rapport à la branche actuelle · session fermée',
  'wtbase.emptyNone': 'Aucun nouveau commit par rapport à la branche actuelle · aucune session',
};

export const pt = {
  'wtbase.fetchedFirst': '(buscado antes de criar)',
  'wtbase.basePlaceholder': "Branch base (padrão: o branch padrão de origin)",
  'wtbase.stale': 'Não foi possível acessar o GitHub; criado a partir do último {branch} buscado.',
  'wtbase.prFetch': "Não foi possível buscar o código do PR (rede). Nenhum branch ou pasta foi criado.",
  'wtbase.prForeign': 'O repositório deste PR não é o remoto deste projeto.',
  'wtbase.prStale': "O branch deste PR já existe em um commit anterior. Apague-o para obter o novo head.",
  'wtbase.group.empty': 'Sem commits',
  'wtbase.emptyClosed': 'Nenhum commit novo em relação ao branch atual · sessão fechada',
  'wtbase.emptyNone': 'Nenhum commit novo em relação ao branch atual · sem sessão',
};
