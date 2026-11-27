// Ticket 373: the Diff header's one git button (diff/gitAction.ts): its ladder labels, disabled reasons and the fixed
// prompt each rung sends to the session's agent. Copy from the approved mock (373.html). All eight languages.
declare module '../index' {
  interface AreaKeys {
    'gitActions.label.commit': true;
    'gitActions.label.commitPush': true;
    'gitActions.label.commitPushPr': true;
    'gitActions.label.push': true;
    'gitActions.label.pushPr': true;
    'gitActions.label.createPr': true;
    'gitActions.label.pull': true;
    'gitActions.label.sync': true;
    'gitActions.why.defaultBranch': true;
    'gitActions.why.shell': true;
    'gitActions.why.notRunning': true;
    'gitActions.why.blocked': true;
    'gitActions.why.working': true;
    'gitActions.why.detached': true;
    'gitActions.why.unknown': true;
    'gitActions.why.upToDate': true;
    'gitActions.why.diverged': true;
    'gitActions.why.noRemote': true;
    'gitActions.why.noCommits': true;
    'gitActions.why.noGh': true;
    'gitActions.sendFailed': true;
    'gitActions.prompt.commit': true;
    'gitActions.prompt.commitPush': true;
    'gitActions.prompt.commitPushPr': true;
    'gitActions.prompt.push': true;
    'gitActions.prompt.pushPr': true;
    'gitActions.prompt.createPr': true;
    'gitActions.prompt.pull': true;
    'gitActions.label.askPushPr': true;
    'gitActions.label.askCreatePr': true;
    'gitActions.label.pushCreatePr': true;
    'gitActions.pr.title': true;
    'gitActions.pr.body': true;
    'gitActions.pr.base': true;
    'gitActions.pr.draft': true;
    'gitActions.pr.filled': true;
    'gitActions.pr.fromTemplate': true;
    'gitActions.pr.pushFirst.one': true;
    'gitActions.pr.pushFirst.other': true;
    'gitActions.pr.creating': true;
    'gitActions.pr.needsGh': true;
    'gitActions.pr.open': true;
    'gitActions.pr.openGit': true;
    'gitActions.pr.created': true;
    'gitActions.err.exists': true;
    'gitActions.err.pushedNoGh': true;
    'gitActions.err.pushedNoPr': true;
    'gitActions.err.title': true;
    'gitActions.err.body': true;
    'gitActions.err.notGithub': true;
    'gitActions.err.noPr': true;
    'gitActions.err.noLink': true;
    'gitActions.err.url': true;
    'gitActions.err.target': true;
    'gitActions.push.noUpstream': true;
    'gitActions.why.noPushRemote': true;
    'gitActions.label.askPush': true;
    'gitActions.choices': true;
    'gitActions.choice.appTip': true;
    'gitActions.push.confirm.one': true;
    'gitActions.push.confirm.other': true;
    'gitActions.push.prGets': true;
    'gitActions.push.go': true;
    'gitActions.push.going': true;
    'gitActions.push.cancel': true;
    'gitActions.push.done.one': true;
    'gitActions.push.done.other': true;
    'gitActions.push.dismiss': true;
    'gitActions.err.changed': true;
    'gitActions.err.newer': true;
    'gitActions.err.signin': true;
    'gitActions.err.hook': true;
    'gitActions.err.refused': true;
    'gitActions.err.several': true;
    'gitActions.err.default': true;
    'gitActions.err.nothing': true;
    'gitActions.err.failed': true;
    'gitActions.err.failed.todo': true;
  }
}

export const en = {
  'gitActions.label.commit': 'Commit',
  'gitActions.label.commitPush': 'Commit & push',
  'gitActions.label.commitPushPr': 'Commit, push & PR',
  'gitActions.label.push': 'Push',
  'gitActions.label.pushPr': 'Push & PR',
  'gitActions.label.createPr': 'Create PR',
  'gitActions.label.pull': 'Pull',
  'gitActions.label.sync': 'Sync',
  'gitActions.why.defaultBranch': 'Not available on the default branch ({branch}). Work in a worktree.',
  'gitActions.why.shell': 'A terminal session has no agent to ask.',
  'gitActions.why.notRunning': 'The agent is not running.',
  'gitActions.why.blocked': 'The agent is waiting for an answer. Answer it first.',
  'gitActions.why.working': 'The agent is working. You can press this when the turn ends.',
  'gitActions.why.detached': 'Create a branch first.',
  'gitActions.why.unknown': 'Git status is unavailable.',
  'gitActions.why.upToDate': 'The branch is up to date. Nothing to do.',
  'gitActions.why.diverged': 'The branch has diverged from its remote. Rebase or merge first.',
  'gitActions.why.noRemote': 'This repository has no remote to push to. Add one with git remote add.',
  'gitActions.why.noCommits': 'No local commits to push.',
  'gitActions.why.noGh': 'Creating a PR needs the GitHub CLI (gh).',
  'gitActions.sendFailed': 'Could not ask the agent: {error}',
  'gitActions.prompt.commit': 'Commit the changes with a clear message. Do not push.',
  'gitActions.prompt.commitPush': 'Commit the changes, then push this branch. Never push to the default branch.',
  'gitActions.prompt.commitPushPr': 'Commit the changes, push this branch, then open a PR. Never push to the default branch.',
  'gitActions.prompt.push': 'Push this branch. Never push to the default branch.',
  'gitActions.prompt.pushPr': 'Push this branch, then open a PR. Never push to the default branch.',
  'gitActions.prompt.createPr': 'Open a PR for this branch. Never push to the default branch.',
  'gitActions.prompt.pull': "Pull the new commits from this branch's remote. If there are conflicts, stop and tell me.",
  'gitActions.why.noPushRemote': "This branch has no remote to push to that the app can pick. Push it once with git push -u in a terminal.",
  'gitActions.label.askPush': "Ask {agent} to push",
  'gitActions.choices': "Push choices",
  'gitActions.choice.appTip': "The app pushes after you confirm the commits and where they go.",
  'gitActions.push.confirm.one': "Push 1 commit to {remote}/{branch}? Head commit: {head}.",
  'gitActions.push.confirm.other': "Push {n} commits to {remote}/{branch}? Head commit: {head}.",
  'gitActions.push.prGets': "PR #{pr} gets them.",
  'gitActions.push.go': "Push",
  'gitActions.push.going': "Pushing…",
  'gitActions.push.cancel': "Cancel",
  'gitActions.push.done.one': "Pushed 1 commit to {remote}/{branch}.",
  'gitActions.push.done.other': "Pushed {n} commits to {remote}/{branch}.",
  'gitActions.push.dismiss': "Dismiss",
  'gitActions.err.changed': "Nothing was sent: the branch changed after this was shown (new head {head}). Look again.",
  'gitActions.err.newer': "Not pushed: {remote} has newer commits on {branch}. Pull first, then push again.",
  'gitActions.err.signin': "Not pushed: git needs you to sign in. Run git push once in a terminal tab, then try again.",
  'gitActions.err.hook': "Not pushed: the pre-push hook failed.",
  'gitActions.err.refused': "Not pushed: {remote} refused the push.",
  'gitActions.err.several': "Not pushed: this branch has no remote set and there are several. Push it once with git push -u in a terminal.",
  'gitActions.err.default': "Not pushed: this is the default branch. Work in a worktree.",
  'gitActions.err.nothing': "Not pushed: there are no new commits to push.",
  'gitActions.err.failed': "Not pushed.",
  'gitActions.err.failed.todo': "The details below say why.",
  'gitActions.label.askPushPr': "Ask {agent} to push & open PR",
  'gitActions.label.askCreatePr': "Ask {agent} to open a PR",
  'gitActions.label.pushCreatePr': "Push & create PR",
  'gitActions.pr.title': "Title",
  'gitActions.pr.body': "Description",
  'gitActions.pr.base': "Into",
  'gitActions.pr.draft': "Draft",
  'gitActions.pr.filled': "Filled from your commits. You can edit it.",
  'gitActions.pr.fromTemplate': "Filled from the repository's pull request template. You can edit it.",
  'gitActions.pr.pushFirst.one': "Pushes 1 commit to {remote}/{branch} first. Head commit: {head}.",
  'gitActions.pr.pushFirst.other': "Pushes {n} commits to {remote}/{branch} first. Head commit: {head}.",
  'gitActions.pr.creating': "Creating…",
  'gitActions.pr.needsGh': "Creating a pull request needs the GitHub CLI (gh), installed and signed in.",
  'gitActions.pr.open': "Open",
  'gitActions.pr.openGit': "Open Settings › Git",
  'gitActions.pr.created': "Pull request #{pr} created.",
  'gitActions.err.exists': "A pull request for this branch already exists: #{pr}.",
  'gitActions.err.pushedNoGh': "Pushed, but the pull request was not created: the GitHub CLI (gh) is not signed in.",
  'gitActions.err.pushedNoPr': "Pushed, but the pull request was not created.",
  'gitActions.err.title': "No pull request: the title must be one line of 1 to 256 characters.",
  'gitActions.err.body': "No pull request: the description is longer than 60,000 characters.",
  'gitActions.err.notGithub': "No pull request: {remote} is not a GitHub repository.",
  'gitActions.err.noPr': "No pull request was created.",
  'gitActions.err.noLink': "The pull request was created, but gh did not say where. Look in the PRs tab.",
  'gitActions.err.target': "Nothing was sent: where this pushes changed after it was shown (now {remote}/{branch}). Look again.",
  'gitActions.push.noUpstream': "The branch's upstream was not set; git push -u in a terminal sets it.",
  'gitActions.err.url': "Nothing was sent: the push URL of {remote} changed after this was shown. Look again.",
};
export const ko = {
  'gitActions.label.commit': '커밋',
  'gitActions.label.commitPush': '커밋 & 푸시',
  'gitActions.label.commitPushPr': '커밋, 푸시 & PR',
  'gitActions.label.push': '푸시',
  'gitActions.label.pushPr': '푸시 & PR',
  'gitActions.label.createPr': 'PR 만들기',
  'gitActions.label.pull': '풀',
  'gitActions.label.sync': '동기화',
  'gitActions.why.defaultBranch': '기본 브랜치({branch})에서는 누를 수 없습니다. 워크트리에서 작업하세요.',
  'gitActions.why.shell': "터미널 세션에는 요청할 에이전트가 없습니다.",
  'gitActions.why.notRunning': '에이전트가 실행 중이 아닙니다.',
  'gitActions.why.blocked': '에이전트가 답을 기다리고 있습니다. 먼저 답하세요.',
  'gitActions.why.working': '에이전트가 작업 중입니다. 턴이 끝나면 누를 수 있습니다.',
  'gitActions.why.detached': '브랜치를 만든 뒤에 할 수 있습니다.',
  'gitActions.why.unknown': 'git 상태를 읽을 수 없습니다.',
  'gitActions.why.upToDate': '브랜치가 최신입니다. 할 일이 없습니다.',
  'gitActions.why.diverged': '브랜치가 원격과 갈라졌습니다. 먼저 리베이스하거나 병합하세요.',
  'gitActions.why.noRemote': '이 저장소에는 원격이 없어 푸시할 수 없습니다. git remote add로 추가하세요.',
  'gitActions.why.noCommits': '푸시할 로컬 커밋이 없습니다.',
  'gitActions.why.noGh': 'PR을 만들려면 GitHub CLI(gh)가 필요합니다.',
  'gitActions.sendFailed': '에이전트에게 보내지 못했습니다: {error}',
  'gitActions.prompt.commit': '변경을 알맞은 메시지로 커밋해 줘. 푸시는 하지 마.',
  'gitActions.prompt.commitPush': '변경을 커밋하고 푸시해 줘. 기본 브랜치에는 절대 푸시하지 마.',
  'gitActions.prompt.commitPushPr': '변경을 커밋하고 푸시한 다음 PR을 열어 줘. 기본 브랜치에는 절대 푸시하지 마.',
  'gitActions.prompt.push': '이 브랜치를 푸시해 줘. 기본 브랜치에는 절대 푸시하지 마.',
  'gitActions.prompt.pushPr': '푸시하고 PR을 열어 줘. 기본 브랜치에는 절대 푸시하지 마.',
  'gitActions.prompt.createPr': '이 브랜치로 PR을 열어 줘. 기본 브랜치에는 절대 푸시하지 마.',
  'gitActions.prompt.pull': '이 브랜치의 원격에서 새 커밋을 풀해 줘. 충돌이 나면 멈추고 알려 줘.',
};
export const ja = {
  'gitActions.label.commit': 'コミット',
  'gitActions.label.commitPush': 'コミット & プッシュ',
  'gitActions.label.commitPushPr': 'コミット、プッシュ & PR',
  'gitActions.label.push': 'プッシュ',
  'gitActions.label.pushPr': 'プッシュ & PR',
  'gitActions.label.createPr': 'PR を作成',
  'gitActions.label.pull': 'プル',
  'gitActions.label.sync': '同期',
  'gitActions.why.defaultBranch': 'デフォルトブランチ（{branch}）では押せません。ワークツリーで作業してください。',
  'gitActions.why.shell': 'ターミナルセッションには頼めるエージェントがいません。',
  'gitActions.why.notRunning': 'エージェントは実行されていません。',
  'gitActions.why.blocked': 'エージェントが回答を待っています。先に答えてください。',
  'gitActions.why.working': 'エージェントが作業中です。ターンが終わると押せます。',
  'gitActions.why.detached': '先にブランチを作成してください。',
  'gitActions.why.unknown': 'git の状態を読み取れません。',
  'gitActions.why.upToDate': 'ブランチは最新です。することはありません。',
  'gitActions.why.diverged': 'ブランチがリモートと分岐しています。先にリベースかマージをしてください。',
  'gitActions.why.noRemote': 'このリポジトリにはプッシュ先のリモートがありません。git remote add で追加してください。',
  'gitActions.why.noCommits': 'プッシュするローカルコミットがありません。',
  'gitActions.why.noGh': 'PR を作成するには GitHub CLI（gh）が必要です。',
  'gitActions.sendFailed': 'エージェントに送れませんでした：{error}',
  'gitActions.prompt.commit': '変更を分かりやすいメッセージでコミットして。プッシュはしないで。',
  'gitActions.prompt.commitPush': '変更をコミットしてプッシュして。デフォルトブランチには絶対にプッシュしないで。',
  'gitActions.prompt.commitPushPr': '変更をコミットしてプッシュし、PR を開いて。デフォルトブランチには絶対にプッシュしないで。',
  'gitActions.prompt.push': 'このブランチをプッシュして。デフォルトブランチには絶対にプッシュしないで。',
  'gitActions.prompt.pushPr': 'プッシュして PR を開いて。デフォルトブランチには絶対にプッシュしないで。',
  'gitActions.prompt.createPr': 'このブランチの PR を開いて。デフォルトブランチには絶対にプッシュしないで。',
  'gitActions.prompt.pull': 'このブランチのリモートから新しいコミットをプルして。衝突したら止めて知らせて。',
};
export const zhHans = {
  'gitActions.label.commit': '提交',
  'gitActions.label.commitPush': '提交并推送',
  'gitActions.label.commitPushPr': '提交、推送并创建 PR',
  'gitActions.label.push': '推送',
  'gitActions.label.pushPr': '推送并创建 PR',
  'gitActions.label.createPr': '创建 PR',
  'gitActions.label.pull': '拉取',
  'gitActions.label.sync': '同步',
  'gitActions.why.defaultBranch': '在默认分支（{branch}）上不可用。请在工作树中工作。',
  'gitActions.why.shell': '终端会话没有可以委托的代理。',
  'gitActions.why.notRunning': '代理未在运行。',
  'gitActions.why.blocked': '代理正在等待回答。请先回答。',
  'gitActions.why.working': '代理正在工作。本轮结束后即可点击。',
  'gitActions.why.detached': '请先创建分支。',
  'gitActions.why.unknown': '无法读取 git 状态。',
  'gitActions.why.upToDate': '分支已是最新，无事可做。',
  'gitActions.why.diverged': '分支已与远程分叉。请先变基或合并。',
  'gitActions.why.noRemote': '此仓库没有可推送的远程。请用 git remote add 添加。',
  'gitActions.why.noCommits': '没有要推送的本地提交。',
  'gitActions.why.noGh': '创建 PR 需要 GitHub CLI (gh)。',
  'gitActions.sendFailed': '无法发送给代理：{error}',
  'gitActions.prompt.commit': '用清晰的提交信息提交这些更改。不要推送。',
  'gitActions.prompt.commitPush': '提交这些更改，然后推送此分支。绝不要推送到默认分支。',
  'gitActions.prompt.commitPushPr': '提交这些更改，推送此分支，然后创建 PR。绝不要推送到默认分支。',
  'gitActions.prompt.push': '推送此分支。绝不要推送到默认分支。',
  'gitActions.prompt.pushPr': '推送此分支，然后创建 PR。绝不要推送到默认分支。',
  'gitActions.prompt.createPr': '为此分支创建 PR。绝不要推送到默认分支。',
  'gitActions.prompt.pull': '从此分支的远程拉取新提交。如有冲突，请停下并告诉我。',
};
export const zhHant = {
  'gitActions.label.commit': '提交',
  'gitActions.label.commitPush': '提交並推送',
  'gitActions.label.commitPushPr': '提交、推送並建立 PR',
  'gitActions.label.push': '推送',
  'gitActions.label.pushPr': '推送並建立 PR',
  'gitActions.label.createPr': '建立 PR',
  'gitActions.label.pull': '拉取',
  'gitActions.label.sync': '同步',
  'gitActions.why.defaultBranch': '在預設分支（{branch}）上無法使用。請在工作樹中工作。',
  'gitActions.why.shell': '終端工作階段沒有可以委託的代理。',
  'gitActions.why.notRunning': '代理未在執行。',
  'gitActions.why.blocked': '代理正在等待回答。請先回答。',
  'gitActions.why.working': '代理正在工作。本輪結束後即可按下。',
  'gitActions.why.detached': '請先建立分支。',
  'gitActions.why.unknown': '無法讀取 git 狀態。',
  'gitActions.why.upToDate': '分支已是最新，沒有要做的事。',
  'gitActions.why.diverged': '分支已與遠端分岔。請先重定基底或合併。',
  'gitActions.why.noRemote': '此儲存庫沒有可推送的遠端。請用 git remote add 新增。',
  'gitActions.why.noCommits': '沒有要推送的本機提交。',
  'gitActions.why.noGh': '建立 PR 需要 GitHub CLI（gh）。',
  'gitActions.sendFailed': '無法傳送給代理：{error}',
  'gitActions.prompt.commit': '用清楚的訊息提交這些變更。不要推送。',
  'gitActions.prompt.commitPush': '提交這些變更，然後推送此分支。絕對不要推送到預設分支。',
  'gitActions.prompt.commitPushPr': '提交這些變更，推送此分支，然後建立 PR。絕對不要推送到預設分支。',
  'gitActions.prompt.push': '推送此分支。絕對不要推送到預設分支。',
  'gitActions.prompt.pushPr': '推送此分支，然後建立 PR。絕對不要推送到預設分支。',
  'gitActions.prompt.createPr': '為此分支建立 PR。絕對不要推送到預設分支。',
  'gitActions.prompt.pull': '從此分支的遠端拉取新提交。如有衝突，請停下並告訴我。',
};
export const es = {
  'gitActions.label.commit': 'Commit',
  'gitActions.label.commitPush': 'Commit y push',
  'gitActions.label.commitPushPr': 'Commit, push y PR',
  'gitActions.label.push': 'Push',
  'gitActions.label.pushPr': 'Push y PR',
  'gitActions.label.createPr': 'Crear PR',
  'gitActions.label.pull': 'Pull',
  'gitActions.label.sync': 'Sincronizar',
  'gitActions.why.defaultBranch': 'No disponible en la rama predeterminada ({branch}). Trabaja en un árbol de trabajo.',
  'gitActions.why.shell': 'Una sesión de terminal no tiene un agente al que pedírselo.',
  'gitActions.why.notRunning': 'El agente no está en ejecución.',
  'gitActions.why.blocked': 'El agente espera una respuesta. Respóndela primero.',
  'gitActions.why.working': 'El agente está trabajando. Podrás pulsarlo cuando termine el turno.',
  'gitActions.why.detached': 'Crea una rama primero.',
  'gitActions.why.unknown': 'No se puede leer el estado de git.',
  'gitActions.why.upToDate': 'La rama está al día. No hay nada que hacer.',
  'gitActions.why.diverged': 'La rama se ha separado de su remoto. Haz rebase o merge primero.',
  'gitActions.why.noRemote': 'Este repositorio no tiene un remoto al que hacer push. Añade uno con git remote add.',
  'gitActions.why.noCommits': 'No hay commits locales para hacer push.',
  'gitActions.why.noGh': 'Crear un PR requiere la CLI de GitHub (gh).',
  'gitActions.sendFailed': 'No se pudo pedir al agente: {error}',
  'gitActions.prompt.commit': 'Haz commit de los cambios con un mensaje claro. No hagas push.',
  'gitActions.prompt.commitPush': 'Haz commit de los cambios y luego push de esta rama. Nunca hagas push a la rama predeterminada.',
  'gitActions.prompt.commitPushPr': 'Haz commit de los cambios, push de esta rama y luego abre un PR. Nunca hagas push a la rama predeterminada.',
  'gitActions.prompt.push': 'Haz push de esta rama. Nunca hagas push a la rama predeterminada.',
  'gitActions.prompt.pushPr': 'Haz push de esta rama y luego abre un PR. Nunca hagas push a la rama predeterminada.',
  'gitActions.prompt.createPr': 'Abre un PR para esta rama. Nunca hagas push a la rama predeterminada.',
  'gitActions.prompt.pull': 'Haz pull de los commits nuevos del remoto de esta rama. Si hay conflictos, detente y avísame.',
};
export const fr = {
  'gitActions.label.commit': 'Commit',
  'gitActions.label.commitPush': 'Commit et push',
  'gitActions.label.commitPushPr': 'Commit, push et PR',
  'gitActions.label.push': 'Push',
  'gitActions.label.pushPr': 'Push et PR',
  'gitActions.label.createPr': 'Créer une PR',
  'gitActions.label.pull': 'Pull',
  'gitActions.label.sync': 'Synchroniser',
  'gitActions.why.defaultBranch': 'Indisponible sur la branche par défaut ({branch}). Travaillez dans un arbre de travail.',
  'gitActions.why.shell': "Une session de terminal n’a pas d’agent à qui le demander.",
  'gitActions.why.notRunning': "L’agent ne tourne pas.",
  'gitActions.why.blocked': "L’agent attend une réponse. Répondez d’abord.",
  'gitActions.why.working': "L’agent travaille. Vous pourrez cliquer à la fin du tour.",
  'gitActions.why.detached': "Créez d’abord une branche.",
  'gitActions.why.unknown': "L’état git est illisible.",
  'gitActions.why.upToDate': 'La branche est à jour. Rien à faire.',
  'gitActions.why.diverged': "La branche a divergé de son dépôt distant. Faites d’abord un rebase ou un merge.",
  'gitActions.why.noRemote': "Ce dépôt n’a pas de dépôt distant où pousser. Ajoutez-en un avec git remote add.",
  'gitActions.why.noCommits': 'Aucun commit local à pousser.',
  'gitActions.why.noGh': 'Créer une PR nécessite la CLI GitHub (gh).',
  'gitActions.sendFailed': "Impossible de le demander à l’agent : {error}",
  'gitActions.prompt.commit': 'Fais un commit des changements avec un message clair. Ne pousse pas.',
  'gitActions.prompt.commitPush': 'Fais un commit des changements, puis pousse cette branche. Ne pousse jamais sur la branche par défaut.',
  'gitActions.prompt.commitPushPr': 'Fais un commit des changements, pousse cette branche, puis ouvre une PR. Ne pousse jamais sur la branche par défaut.',
  'gitActions.prompt.push': 'Pousse cette branche. Ne pousse jamais sur la branche par défaut.',
  'gitActions.prompt.pushPr': 'Pousse cette branche, puis ouvre une PR. Ne pousse jamais sur la branche par défaut.',
  'gitActions.prompt.createPr': 'Ouvre une PR pour cette branche. Ne pousse jamais sur la branche par défaut.',
  'gitActions.prompt.pull': "Récupère (pull) les nouveaux commits du dépôt distant de cette branche. En cas de conflit, arrête-toi et dis-le-moi.",
};
export const pt = {
  'gitActions.label.commit': 'Commit',
  'gitActions.label.commitPush': 'Commit e push',
  'gitActions.label.commitPushPr': 'Commit, push e PR',
  'gitActions.label.push': 'Push',
  'gitActions.label.pushPr': 'Push e PR',
  'gitActions.label.createPr': 'Criar PR',
  'gitActions.label.pull': 'Pull',
  'gitActions.label.sync': 'Sincronizar',
  'gitActions.why.defaultBranch': 'Indisponível no branch padrão ({branch}). Trabalhe em uma árvore de trabalho.',
  'gitActions.why.shell': 'Uma sessão de terminal não tem um agente a quem pedir.',
  'gitActions.why.notRunning': 'O agente não está em execução.',
  'gitActions.why.blocked': 'O agente está esperando uma resposta. Responda primeiro.',
  'gitActions.why.working': 'O agente está trabalhando. Você poderá clicar quando o turno terminar.',
  'gitActions.why.detached': 'Crie um branch primeiro.',
  'gitActions.why.unknown': 'Não foi possível ler o estado do git.',
  'gitActions.why.upToDate': 'O branch está atualizado. Nada a fazer.',
  'gitActions.why.diverged': 'O branch divergiu do remoto. Faça rebase ou merge primeiro.',
  'gitActions.why.noRemote': 'Este repositório não tem um remoto para push. Adicione um com git remote add.',
  'gitActions.why.noCommits': 'Não há commits locais para enviar.',
  'gitActions.why.noGh': 'Criar um PR requer a CLI do GitHub (gh).',
  'gitActions.sendFailed': 'Não foi possível pedir ao agente: {error}',
  'gitActions.prompt.commit': 'Faça commit das alterações com uma mensagem clara. Não faça push.',
  'gitActions.prompt.commitPush': 'Faça commit das alterações e depois push deste branch. Nunca faça push no branch padrão.',
  'gitActions.prompt.commitPushPr': 'Faça commit das alterações, push deste branch e depois abra um PR. Nunca faça push no branch padrão.',
  'gitActions.prompt.push': 'Faça push deste branch. Nunca faça push no branch padrão.',
  'gitActions.prompt.pushPr': 'Faça push deste branch e depois abra um PR. Nunca faça push no branch padrão.',
  'gitActions.prompt.createPr': 'Abra um PR para este branch. Nunca faça push no branch padrão.',
  'gitActions.prompt.pull': 'Faça pull dos commits novos do remoto deste branch. Se houver conflitos, pare e me avise.',
};
