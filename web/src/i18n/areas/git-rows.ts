// Ticket 378: the live line under the branch prefix row (Settings > Git & Worktrees).
declare module '../index' {
  interface AreaKeys {
    'gitRows.prefixExample': true;
    'gitRows.prefixBad': true;
  }
}

export const en = {
  'gitRows.prefixExample': "A new worktree's branch would be {branch}",
  'gitRows.prefixBad': "Git does not allow this in a branch name: a space, two dots, or one of the characters ~ ^ : ? * [ \\. Nothing was saved.",
};

export const ko = {
  'gitRows.prefixExample': "새 워크트리의 브랜치는 {branch}이(가) 됩니다",
  'gitRows.prefixBad': "Git이 브랜치 이름에 허용하지 않는 글자입니다(공백, 점 두 개, ~ ^ : ? * [ \\ 중 하나). 저장하지 않습니다.",
};

export const ja = {
  'gitRows.prefixExample': "新しいワークツリーのブランチは {branch} になります",
  'gitRows.prefixBad': "Git がブランチ名に許可しない文字です（空白、ドット 2 つ、~ ^ : ? * [ \\ のいずれか）。保存されていません。",
};

export const zhHans = {
  'gitRows.prefixExample': "新工作树的分支将是 {branch}",
  'gitRows.prefixBad': "Git 不允许分支名包含这些字符（空格、两个点，或 ~ ^ : ? * [ \\ 之一）。未保存。",
};

export const zhHant = {
  'gitRows.prefixExample': "新工作樹的分支會是 {branch}",
  'gitRows.prefixBad': "Git 不允許分支名稱包含這些字元（空白、兩個點，或 ~ ^ : ? * [ \\ 之一）。未儲存。",
};

export const es = {
  'gitRows.prefixExample': "La rama de un nuevo árbol de trabajo sería {branch}",
  'gitRows.prefixBad': "Git no admite esto en un nombre de rama: un espacio, dos puntos seguidos (..) o uno de los caracteres ~ ^ : ? * [ \\. No se guardó nada.",
};

export const fr = {
  'gitRows.prefixExample': "La branche d’un nouvel arbre de travail serait {branch}",
  'gitRows.prefixBad': "Git refuse cela dans un nom de branche (une espace, deux points consécutifs ou l’un de ~ ^ : ? * [ \\). Ce n’est pas enregistré.",
};

export const pt = {
  'gitRows.prefixExample': "O branch de uma nova árvore de trabalho seria {branch}",
  'gitRows.prefixBad': "O Git recusa isto em um nome de branch (um espaço, dois pontos finais seguidos (..) ou um de ~ ^ : ? * [ \\). Não é salvo.",
};
