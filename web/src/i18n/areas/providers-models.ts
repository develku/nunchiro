// Ticket 358, mock #models2: the model filter and the owner's own model ids in Settings > Accounts.
declare module '../index' {
  interface AreaKeys {
    'providerModels.filter': true;
    'providerModels.claudeSwitch': true;
    'providerModels.none': true;
    'providerModels.add': true;
    'providerModels.id': true;
    'providerModels.name': true;
    'providerModels.nameOf': true;
    'providerModels.changeAria': true;
    'providerModels.removeAria': true;
    'providerModels.duplicate': true;
    'providerModels.badName': true;
    'providerModels.full': true;
  }
}

export const en = {
  'providerModels.claudeSwitch': 'A custom model is used when a new session starts. It cannot be switched to in a running Claude session.',
  'providerModels.filter': 'Filter models',
  'providerModels.none': 'No matching models',
  'providerModels.add': 'Add a model',
  'providerModels.id': 'Model ID',
  'providerModels.name': 'Label (optional)',
  'providerModels.nameOf': 'Label of {id}',
  'providerModels.changeAria': 'Change {id}',
  'providerModels.removeAria': 'Remove {id}',
  'providerModels.duplicate': 'That model is already on the list. Not saved.',
  'providerModels.badName': 'Use a label of up to 64 plain characters. Not saved.',
  'providerModels.full': 'The list of added models is full ({max} bytes). Remove one first. Not saved.',
};

export const ko = {
  'providerModels.claudeSwitch': '직접 추가한 모델은 새 세션을 시작할 때 쓰입니다. 실행 중인 Claude 세션에서는 전환할 수 없습니다.',
  'providerModels.filter': '모델 필터',
  'providerModels.none': '일치하는 모델이 없습니다',
  'providerModels.add': '모델 직접 추가',
  'providerModels.id': '모델 ID',
  'providerModels.name': '이름 (선택)',
  'providerModels.nameOf': '{id}의 이름',
  'providerModels.changeAria': '{id} 변경',
  'providerModels.removeAria': '{id} 제거',
  'providerModels.duplicate': '이미 목록에 있는 모델입니다. 저장되지 않았습니다.',
  'providerModels.badName': '이름은 일반 문자 64자 이내로 쓰세요. 저장되지 않았습니다.',
  'providerModels.full': '추가한 모델 목록이 가득 찼습니다({max}바이트). 먼저 하나를 제거하세요. 저장되지 않았습니다.',
};

export const ja = {
  'providerModels.claudeSwitch': '追加したモデルは新しいセッションの開始時に使われます。実行中の Claude セッションでは切り替えられません。',
  'providerModels.filter': 'モデルを絞り込む',
  'providerModels.none': '一致するモデルはありません',
  'providerModels.add': 'モデルを追加',
  'providerModels.id': 'モデル ID',
  'providerModels.name': '名前（任意）',
  'providerModels.nameOf': '{id} の名前',
  'providerModels.changeAria': '{id} を変更',
  'providerModels.removeAria': '{id} を削除',
  'providerModels.duplicate': 'そのモデルはすでに一覧にあります。保存されていません。',
  'providerModels.badName': '名前は通常の文字で 64 文字以内にしてください。保存されていません。',
  'providerModels.full': '追加したモデルの一覧がいっぱいです（{max} バイト）。先に 1 つ削除してください。保存されていません。',
};

export const zhHans = {
  'providerModels.claudeSwitch': '添加的模型在新会话启动时使用，无法在运行中的 Claude 会话里切换到它。',
  'providerModels.filter': '筛选模型',
  'providerModels.none': '没有匹配的模型',
  'providerModels.add': '添加模型',
  'providerModels.id': '模型 ID',
  'providerModels.name': '名称（可选）',
  'providerModels.nameOf': '{id} 的名称',
  'providerModels.changeAria': '更改 {id}',
  'providerModels.removeAria': '移除 {id}',
  'providerModels.duplicate': '该模型已在列表中。未保存。',
  'providerModels.badName': '名称最多 64 个普通字符。未保存。',
  'providerModels.full': '已添加的模型列表已满（{max} 字节）。请先移除一个。未保存。',
};

export const zhHant = {
  'providerModels.claudeSwitch': '新增的模型會在新工作階段啟動時使用，無法在執行中的 Claude 工作階段裡切換到它。',
  'providerModels.filter': '篩選模型',
  'providerModels.none': '沒有相符的模型',
  'providerModels.add': '新增模型',
  'providerModels.id': '模型 ID',
  'providerModels.name': '名稱（選填）',
  'providerModels.nameOf': '{id} 的名稱',
  'providerModels.changeAria': '變更 {id}',
  'providerModels.removeAria': '移除 {id}',
  'providerModels.duplicate': '該模型已在清單中。未儲存。',
  'providerModels.badName': '名稱最多 64 個一般字元。未儲存。',
  'providerModels.full': '已新增的模型清單已滿（{max} 位元組）。請先移除一個。未儲存。',
};

export const es = {
  'providerModels.claudeSwitch': 'Un modelo añadido se usa al iniciar una sesión nueva. No se puede cambiar a él en una sesión de Claude en curso.',
  'providerModels.filter': 'Filtrar modelos',
  'providerModels.none': 'Ningún modelo coincide',
  'providerModels.add': 'Añadir un modelo',
  'providerModels.id': 'ID del modelo',
  'providerModels.name': 'Nombre (opcional)',
  'providerModels.nameOf': 'Nombre de {id}',
  'providerModels.changeAria': 'Cambiar {id}',
  'providerModels.removeAria': 'Quitar {id}',
  'providerModels.duplicate': 'Ese modelo ya está en la lista. No se guardó.',
  'providerModels.badName': 'Usa un nombre de hasta 64 caracteres normales. No se guardó.',
  'providerModels.full': 'La lista de modelos añadidos está llena ({max} bytes). Quita uno primero. No se guardó.',
};

export const fr = {
  'providerModels.claudeSwitch': 'Un modèle ajouté sert au démarrage d’une nouvelle session. Impossible d’y passer dans une session Claude en cours.',
  'providerModels.filter': 'Filtrer les modèles',
  'providerModels.none': 'Aucun modèle ne correspond',
  'providerModels.add': 'Ajouter un modèle',
  'providerModels.id': 'ID du modèle',
  'providerModels.name': 'Nom (facultatif)',
  'providerModels.nameOf': 'Nom de {id}',
  'providerModels.changeAria': 'Modifier {id}',
  'providerModels.removeAria': 'Retirer {id}',
  'providerModels.duplicate': 'Ce modèle est déjà dans la liste. Non enregistré.',
  'providerModels.badName': 'Utilisez un nom de 64 caractères simples au maximum. Non enregistré.',
  'providerModels.full': 'La liste des modèles ajoutés est pleine ({max} octets). Retirez-en un d’abord. Non enregistré.',
};

export const pt = {
  'providerModels.claudeSwitch': 'Um modelo adicionado é usado ao iniciar uma nova sessão. Não é possível mudar para ele em uma sessão do Claude em execução.',
  'providerModels.filter': 'Filtrar modelos',
  'providerModels.none': 'Nenhum modelo corresponde',
  'providerModels.add': 'Adicionar modelo',
  'providerModels.id': 'ID do modelo',
  'providerModels.name': 'Nome (opcional)',
  'providerModels.nameOf': 'Nome de {id}',
  'providerModels.changeAria': 'Alterar {id}',
  'providerModels.removeAria': 'Remover {id}',
  'providerModels.duplicate': 'Esse modelo já está na lista. Não foi salvo.',
  'providerModels.badName': 'Use um nome de até 64 caracteres simples. Não foi salvo.',
  'providerModels.full': 'A lista de modelos adicionados está cheia ({max} bytes). Remova um primeiro. Não foi salvo.',
};
