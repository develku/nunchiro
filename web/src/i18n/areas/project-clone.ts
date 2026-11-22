// Ticket 370 item 3: the clone step. Korean is the mock's copy (docs/design/m2-1109/370.html #clone #cloning #clonefail);
// the timeout, other and parent lines are not drawn there and follow its wording.
declare module '../index' {
  interface AreaKeys {
    'projects.clone.entry': true;
    'projects.clone.title': true;
    'projects.clone.url': true;
    'projects.clone.parent': true;
    'projects.clone.browse': true;
    'projects.clone.back': true;
    'projects.clone.cancel': true;
    'projects.clone.clone': true;
    'projects.clone.busy': true;
    'projects.clone.retry': true;
    'projects.clone.progress': true;
    'projects.clone.cancelNote': true;
    'projects.clone.removed': true;
    'projects.clone.stage.counting': true;
    'projects.clone.stage.compressing': true;
    'projects.clone.stage.receiving': true;
    'projects.clone.stage.resolving': true;
    'projects.clone.stage.updating': true;
    'projects.clone.refused': true;
    'projects.clone.parentBad': true;
    'projects.clone.exists': true;
    'projects.clone.auth': true;
    'projects.clone.ssh': true;
    'projects.clone.timeout': true;
    'projects.clone.other': true;
    'projects.clone.addFailed': true;
    'projects.clone.readd': true;
  }
}

export const en = {
  'projects.clone.entry': 'Clone…',
  'projects.clone.title': 'Clone a repository',
  'projects.clone.url': 'Git URL',
  'projects.clone.parent': 'Parent folder',
  'projects.clone.browse': 'Choose folder',
  'projects.clone.back': 'Back',
  'projects.clone.cancel': 'Cancel',
  'projects.clone.clone': 'Clone',
  'projects.clone.busy': 'Cloning…',
  'projects.clone.retry': 'Retry',
  'projects.clone.progress': 'Clone progress',
  'projects.clone.cancelNote': 'Cancelling removes only the folder this clone created.',
  'projects.clone.removed': 'The folder this clone created was removed.',
  'projects.clone.stage.counting': 'Counting objects',
  'projects.clone.stage.compressing': 'Compressing objects',
  'projects.clone.stage.receiving': 'Receiving objects',
  'projects.clone.stage.resolving': 'Resolving deltas',
  'projects.clone.stage.updating': 'Updating files',
  'projects.clone.refused': 'This URL cannot be used. Use https://, ssh:// or the scp form (user@host:path).',
  'projects.clone.parentBad': 'The parent folder must start with / or ~/. It cannot contain “..”.',
  'projects.clone.exists': 'The folder {path} already exists. The existing folder was not touched. Choose another parent folder.',
  'projects.clone.auth': 'Could not clone. Authentication failed. Check in a terminal that you can access this repository.',
  'projects.clone.ssh': 'Could not clone. Nunchiro could not use your SSH key. Add the key to ssh-agent, and connect once to a new host in a terminal first.',
  'projects.clone.timeout': 'Could not clone. Stopped after 120 seconds with no progress. Check the network and try again.',
  'projects.clone.other': 'Could not clone. Check the URL and the network.',
  'projects.clone.addFailed': 'Cloned to {path}, but it could not be added to the tree.',
  'projects.clone.readd': 'Add to the tree again',
};

export const ko = {
  'projects.clone.entry': '복제…',
  'projects.clone.title': '저장소 복제',
  'projects.clone.url': 'Git URL',
  'projects.clone.parent': '상위 폴더',
  'projects.clone.browse': '폴더 선택',
  'projects.clone.back': '뒤로',
  'projects.clone.cancel': '취소',
  'projects.clone.clone': '복제',
  'projects.clone.busy': '복제 중…',
  'projects.clone.retry': '다시 시도',
  'projects.clone.progress': '복제 진행률',
  'projects.clone.cancelNote': '취소하면 이 복제가 만든 폴더만 제거합니다.',
  'projects.clone.removed': '이 복제가 만든 폴더는 제거했습니다.',
  'projects.clone.stage.counting': '객체 세는 중',
  'projects.clone.stage.compressing': '객체 압축하는 중',
  'projects.clone.stage.receiving': '객체 받는 중',
  'projects.clone.stage.resolving': '델타 처리하는 중',
  'projects.clone.stage.updating': '파일 쓰는 중',
  'projects.clone.refused': "이 URL은 사용할 수 없습니다. https://, ssh:// 또는 scp 형식만 사용할 수 있습니다.",
  'projects.clone.parentBad': '상위 폴더는 / 또는 ~/로 시작해야 하고 ..를 넣을 수 없습니다.',
  'projects.clone.exists': '{path} 폴더가 이미 있습니다. 기존 폴더는 건드리지 않았습니다. 다른 상위 폴더를 고르세요.',
  'projects.clone.auth': '복제하지 못했습니다. 인증에 실패했습니다. 터미널에서 이 저장소에 접근할 수 있는지 확인하세요.',
  'projects.clone.ssh': '복제하지 못했습니다. SSH 키를 쓸 수 없습니다. 암호가 걸린 키는 ssh-agent에 등록하고, 처음 쓰는 호스트는 터미널에서 먼저 연결하세요.',
  'projects.clone.timeout': '복제하지 못했습니다. 120초 동안 진행이 없어 중단했습니다. 네트워크를 확인하고 다시 시도하세요.',
  'projects.clone.other': '복제하지 못했습니다. URL과 네트워크를 확인하세요.',
  'projects.clone.addFailed': '{path}에 복제했지만 트리에 추가하지 못했습니다.',
  'projects.clone.readd': '트리에 다시 추가',
};

export const ja = {
  'projects.clone.entry': 'クローン…',
  'projects.clone.title': 'リポジトリをクローン',
  'projects.clone.url': 'Git URL',
  'projects.clone.parent': '親フォルダー',
  'projects.clone.browse': 'フォルダーを選択',
  'projects.clone.back': '戻る',
  'projects.clone.cancel': 'キャンセル',
  'projects.clone.clone': 'クローン',
  'projects.clone.busy': 'クローン中…',
  'projects.clone.retry': '再試行',
  'projects.clone.progress': 'クローンの進行状況',
  'projects.clone.cancelNote': 'キャンセルすると、このクローンが作成したフォルダーのみ削除します。',
  'projects.clone.removed': 'このクローンが作成したフォルダーは削除しました。',
  'projects.clone.stage.counting': 'オブジェクトを数えています',
  'projects.clone.stage.compressing': 'オブジェクトを圧縮しています',
  'projects.clone.stage.receiving': 'オブジェクトを受信しています',
  'projects.clone.stage.resolving': 'デルタを解決しています',
  'projects.clone.stage.updating': 'ファイルを更新しています',
  'projects.clone.refused': 'この URL は使用できません。https://、ssh://、または scp 形式（user@host:path）を使ってください。',
  'projects.clone.parentBad': '親フォルダーは / または ~/ で始める必要があり、.. は使用できません。',
  'projects.clone.exists': 'フォルダー {path} はすでに存在します。既存のフォルダーには触れていません。別の親フォルダーを選んでください。',
  'projects.clone.auth': 'クローンできませんでした。認証に失敗しました。ターミナルでこのリポジトリにアクセスできるか確認してください。',
  'projects.clone.ssh': 'クローンできませんでした。SSH 鍵を使用できません。パスフレーズ付きの鍵は ssh-agent に登録し、初めてのホストにはターミナルで先に接続してください。',
  'projects.clone.timeout': 'クローンできませんでした。120 秒間進行がなかったため中止しました。ネットワークを確認して再試行してください。',
  'projects.clone.other': 'クローンできませんでした。URL とネットワークを確認してください。',
  'projects.clone.addFailed': '{path} にクローンしましたが、ツリーに追加できませんでした。',
  'projects.clone.readd': 'ツリーに再度追加',
};

const zhHans = {
  'projects.clone.entry': '克隆…',
  'projects.clone.title': '克隆仓库',
  'projects.clone.url': 'Git URL',
  'projects.clone.parent': '父文件夹',
  'projects.clone.browse': '选择文件夹',
  'projects.clone.back': '返回',
  'projects.clone.cancel': '取消',
  'projects.clone.clone': '克隆',
  'projects.clone.busy': '正在克隆…',
  'projects.clone.retry': '重试',
  'projects.clone.progress': '克隆进度',
  'projects.clone.cancelNote': '取消时只删除此次克隆创建的文件夹。',
  'projects.clone.removed': '此次克隆创建的文件夹已删除。',
  'projects.clone.stage.counting': '正在统计对象',
  'projects.clone.stage.compressing': '正在压缩对象',
  'projects.clone.stage.receiving': '正在接收对象',
  'projects.clone.stage.resolving': "正在解析增量",
  'projects.clone.stage.updating': '正在更新文件',
  'projects.clone.refused': '无法使用此 URL。请使用 https://、ssh:// 或 scp 格式（user@host:path）。',
  'projects.clone.parentBad': '父文件夹必须以 / 或 ~/ 开头，且不能包含“..”。',
  'projects.clone.exists': '文件夹 {path} 已存在。现有文件夹未被改动。请选择其他父文件夹。',
  'projects.clone.auth': '无法克隆。身份验证失败。请在终端中确认你可以访问此仓库。',
  'projects.clone.ssh': "无法克隆。无法使用 SSH 密钥。请将带口令的密钥添加到 ssh-agent，首次连接的主机请先在终端中连接。",
  'projects.clone.timeout': '无法克隆。120 秒内没有进展，已停止。请检查网络后重试。',
  'projects.clone.other': '无法克隆。请检查 URL 和网络。',
  'projects.clone.addFailed': '已克隆到 {path}，但无法添加到树中。',
  'projects.clone.readd': "重新添加到项目树",
};

const zhHant = {
  'projects.clone.entry': '複製…',
  'projects.clone.title': '複製儲存庫',
  'projects.clone.url': 'Git URL',
  'projects.clone.parent': '上層資料夾',
  'projects.clone.browse': '選擇資料夾',
  'projects.clone.back': '返回',
  'projects.clone.cancel': '取消',
  'projects.clone.clone': '複製',
  'projects.clone.busy': '正在複製…',
  'projects.clone.retry': '重試',
  'projects.clone.progress': '複製進度',
  'projects.clone.cancelNote': '取消時只刪除此次複製建立的資料夾。',
  'projects.clone.removed': '此次複製建立的資料夾已刪除。',
  'projects.clone.stage.counting': '正在計算物件',
  'projects.clone.stage.compressing': '正在壓縮物件',
  'projects.clone.stage.receiving': '正在接收物件',
  'projects.clone.stage.resolving': '正在處理差異',
  'projects.clone.stage.updating': '正在更新檔案',
  'projects.clone.refused': '無法使用此 URL。僅支援 https://、ssh:// 或 scp 格式。',
  'projects.clone.parentBad': '上層資料夾必須以 / 或 ~/ 開頭，且不能包含 ..',
  'projects.clone.exists': '資料夾 {path} 已存在。現有資料夾未被變更。請選擇其他上層資料夾。',
  'projects.clone.auth': '無法複製。驗證失敗。請在終端中確認你可以存取此儲存庫。',
  'projects.clone.ssh': '無法複製。無法使用 SSH 金鑰。請將有密碼的金鑰加入 ssh-agent，首次連線的主機請先在終端中連線。',
  'projects.clone.timeout': '無法複製。120 秒內沒有進度，已停止。請檢查網路後重試。',
  'projects.clone.other': '無法複製。請檢查 URL 和網路。',
  'projects.clone.addFailed': '已複製到 {path}，但無法加入樹狀清單。',
  'projects.clone.readd': '重新加入樹狀清單',
};

export const es = {
  'projects.clone.entry': 'Clonar…',
  'projects.clone.title': 'Clonar un repositorio',
  'projects.clone.url': 'URL de Git',
  'projects.clone.parent': 'Carpeta superior',
  'projects.clone.browse': 'Elegir carpeta',
  'projects.clone.back': 'Atrás',
  'projects.clone.cancel': 'Cancelar',
  'projects.clone.clone': 'Clonar',
  'projects.clone.busy': 'Clonando…',
  'projects.clone.retry': 'Reintentar',
  'projects.clone.progress': 'Progreso de la clonación',
  'projects.clone.cancelNote': 'Al cancelar solo se elimina la carpeta creada por esta clonación.',
  'projects.clone.removed': 'Se eliminó la carpeta creada por esta clonación.',
  'projects.clone.stage.counting': 'Contando objetos',
  'projects.clone.stage.compressing': 'Comprimiendo objetos',
  'projects.clone.stage.receiving': 'Recibiendo objetos',
  'projects.clone.stage.resolving': 'Resolviendo diferencias',
  'projects.clone.stage.updating': 'Actualizando archivos',
  'projects.clone.refused': 'Esta URL no se puede usar. Solo https://, ssh:// o formato scp.',
  'projects.clone.parentBad': 'La carpeta superior debe empezar por / o ~/. No puede contener “..”.',
  'projects.clone.exists': 'La carpeta {path} ya existe. No se ha tocado. Elige otra carpeta superior.',
  'projects.clone.auth': 'No se pudo clonar. Falló la autenticación. Comprueba en un terminal que tienes acceso a este repositorio.',
  'projects.clone.ssh': 'No se pudo clonar. No se pudo usar la clave SSH. Añade a ssh-agent las claves con contraseña y conéctate primero desde un terminal a los hosts nuevos.',
  'projects.clone.timeout': 'No se pudo clonar. Se detuvo tras 120 segundos sin progreso. Comprueba la red e inténtalo de nuevo.',
  'projects.clone.other': 'No se pudo clonar. Comprueba la URL y la red.',
  'projects.clone.addFailed': 'Clonado en {path}, pero no se pudo añadir al árbol.',
  'projects.clone.readd': 'Añadir al árbol de nuevo',
};

export const fr = {
  'projects.clone.entry': 'Cloner…',
  'projects.clone.title': 'Cloner un dépôt',
  'projects.clone.url': 'URL Git',
  'projects.clone.parent': 'Dossier parent',
  'projects.clone.browse': 'Choisir un dossier',
  'projects.clone.back': 'Retour',
  'projects.clone.cancel': 'Annuler',
  'projects.clone.clone': 'Cloner',
  'projects.clone.busy': 'Clonage…',
  'projects.clone.retry': 'Réessayer',
  'projects.clone.progress': 'Progression du clonage',
  'projects.clone.cancelNote': 'Annuler supprime uniquement le dossier créé par ce clonage.',
  'projects.clone.removed': 'Le dossier créé par ce clonage a été supprimé.',
  'projects.clone.stage.counting': 'Décompte des objets',
  'projects.clone.stage.compressing': 'Compression des objets',
  'projects.clone.stage.receiving': 'Réception des objets',
  'projects.clone.stage.resolving': 'Résolution des deltas',
  'projects.clone.stage.updating': 'Mise à jour des fichiers',
  'projects.clone.refused': 'Cette URL ne peut pas être utilisée. Seuls https://, ssh:// ou le format scp sont acceptés.',
  'projects.clone.parentBad': 'Le dossier parent doit commencer par / ou ~/. Il ne peut pas contenir « .. ».',
  'projects.clone.exists': 'Le dossier {path} existe déjà. Il n’a pas été modifié. Choisissez un autre dossier parent.',
  'projects.clone.auth': 'Clonage impossible. L’authentification a échoué. Vérifiez dans un terminal que vous avez accès à ce dépôt.',
  'projects.clone.ssh': 'Clonage impossible. La clé SSH n’a pas pu être utilisée. Ajoutez les clés avec phrase secrète à ssh-agent et connectez-vous d’abord depuis un terminal aux nouveaux hôtes.',
  'projects.clone.timeout': 'Clonage impossible. Arrêté après 120 secondes sans progression. Vérifiez le réseau et réessayez.',
  'projects.clone.other': 'Clonage impossible. Vérifiez l’URL et le réseau.',
  'projects.clone.addFailed': 'Cloné dans {path}, mais impossible de l’ajouter à l’arborescence.',
  'projects.clone.readd': 'Ajouter de nouveau à l’arborescence',
};

export const pt = {
  'projects.clone.entry': 'Clonar…',
  'projects.clone.title': 'Clonar um repositório',
  'projects.clone.url': 'URL do Git',
  'projects.clone.parent': 'Pasta superior',
  'projects.clone.browse': 'Escolher pasta',
  'projects.clone.back': 'Voltar',
  'projects.clone.cancel': 'Cancelar',
  'projects.clone.clone': 'Clonar',
  'projects.clone.busy': 'Clonando…',
  'projects.clone.retry': 'Tentar novamente',
  'projects.clone.progress': 'Progresso da clonagem',
  'projects.clone.cancelNote': 'Cancelar remove apenas a pasta criada por esta clonagem.',
  'projects.clone.removed': 'A pasta criada por esta clonagem foi removida.',
  'projects.clone.stage.counting': 'Contando objetos',
  'projects.clone.stage.compressing': 'Comprimindo objetos',
  'projects.clone.stage.receiving': 'Recebendo objetos',
  'projects.clone.stage.resolving': 'Resolvendo diferenças',
  'projects.clone.stage.updating': 'Atualizando arquivos',
  'projects.clone.refused': 'Esta URL não pode ser usada. Use https://, ssh:// ou o formato scp (user@host:path).',
  'projects.clone.parentBad': 'A pasta superior deve começar com / ou ~/. Ela não pode conter “..”.',
  'projects.clone.exists': 'A pasta {path} já existe. Ela não foi alterada. Escolha outra pasta superior.',
  'projects.clone.auth': 'Não foi possível clonar. A autenticação falhou. Verifique em um terminal se você tem acesso a este repositório.',
  'projects.clone.ssh': 'Não foi possível clonar. Não foi possível usar a chave SSH. Adicione chaves com senha ao ssh-agent e conecte-se primeiro a hosts novos em um terminal.',
  'projects.clone.timeout': 'Não foi possível clonar. Parou após 120 segundos sem progresso. Verifique a rede e tente novamente.',
  'projects.clone.other': 'Não foi possível clonar. Verifique a URL e a rede.',
  'projects.clone.addFailed': 'Clonado em {path}, mas não foi possível adicionar à árvore.',
  'projects.clone.readd': 'Adicionar à árvore novamente',
};

export { zhHans as 'zh-Hans', zhHant as 'zh-Hant' };
