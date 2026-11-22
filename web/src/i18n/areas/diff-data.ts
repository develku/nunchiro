// Ticket 374: Diff's Branch view (where this branch left origin's default branch) and the plain state Files and Diff
// show for an SSH session they cannot read.
declare module '../index' {
  interface AreaKeys {
    'diff.scope.branch': true;
    'diff.branch.base': true;
    'diff.branch.onDefault': true;
    'diff.branch.noOrigin': true;
    'diff.branch.empty': true;
    'diff.ssh.unavailable': true;
  }
}

export const en = {
  'diff.scope.branch': 'Branch',
  'diff.branch.base': 'where it branched from {branch}',
  'diff.branch.onDefault': 'On the default branch there is no branch to compare.',
  'diff.branch.noOrigin': 'There is no origin, so there is nothing to compare with.',
  'diff.branch.empty': 'This branch has nothing that differs from the default branch.',
  'diff.ssh.unavailable': 'Not available for SSH sessions yet.',
};
export const ko = {
  'diff.scope.branch': '브랜치',
  'diff.branch.base': '{branch}에서 갈라진 지점',
  'diff.branch.onDefault': '기본 브랜치에서는 비교할 브랜치가 없습니다.',
  'diff.branch.noOrigin': 'origin이 없어 비교할 수 없습니다.',
  'diff.branch.empty': '이 브랜치에는 기본 브랜치와 다른 내용이 없습니다.',
  'diff.ssh.unavailable': 'SSH 세션에서는 아직 사용할 수 없습니다.',
};
export const ja = {
  'diff.scope.branch': 'ブランチ',
  'diff.branch.base': '{branch} から分かれた地点',
  'diff.branch.onDefault': 'デフォルトブランチでは比較するブランチがありません。',
  'diff.branch.noOrigin': 'origin がないため比較できません。',
  'diff.branch.empty': 'このブランチにはデフォルトブランチとの違いがありません。',
  'diff.ssh.unavailable': 'SSH セッションではまだ使えません。',
};
export const zhHans = {
  'diff.scope.branch': '分支',
  'diff.branch.base': '从 {branch} 分出的位置',
  'diff.branch.onDefault': '在默认分支上没有可比较的分支。',
  'diff.branch.noOrigin': '没有 origin，无法比较。',
  'diff.branch.empty': '此分支与默认分支没有差异。',
  'diff.ssh.unavailable': '暂不支持 SSH 会话。',
};
export const zhHant = {
  'diff.scope.branch': '分支',
  'diff.branch.base': '從 {branch} 分出的位置',
  'diff.branch.onDefault': '在預設分支上沒有可比較的分支。',
  'diff.branch.noOrigin': '沒有 origin，無法比較。',
  'diff.branch.empty': '此分支與預設分支沒有差異。',
  'diff.ssh.unavailable': '尚不支援 SSH 工作階段。',
};
export const es = {
  'diff.scope.branch': 'Rama',
  'diff.branch.base': 'donde se separó de {branch}',
  'diff.branch.onDefault': 'En la rama predeterminada no hay otra rama que comparar.',
  'diff.branch.noOrigin': 'No hay origin, así que no hay con qué comparar.',
  'diff.branch.empty': 'Esta rama no tiene nada distinto de la rama predeterminada.',
  'diff.ssh.unavailable': 'Aún no disponible en sesiones SSH.',
};
export const fr = {
  'diff.scope.branch': 'Branche',
  'diff.branch.base': "là où elle s’est écartée de {branch}",
  'diff.branch.onDefault': 'Sur la branche par défaut, il n’y a pas de branche à comparer.',
  'diff.branch.noOrigin': 'Il n’y a pas d’origin, donc rien à comparer.',
  'diff.branch.empty': 'Cette branche ne diffère en rien de la branche par défaut.',
  'diff.ssh.unavailable': 'Pas encore disponible pour les sessions SSH.',
};
export const pt = {
  'diff.scope.branch': 'Branch',
  'diff.branch.base': 'onde se separou de {branch}',
  'diff.branch.onDefault': 'No branch padrão não há outro branch para comparar.',
  'diff.branch.noOrigin': 'Não há origin, então não há com o que comparar.',
  'diff.branch.empty': 'Este branch não tem nada diferente do branch padrão.',
  'diff.ssh.unavailable': 'Ainda não disponível em sessões SSH.',
};
