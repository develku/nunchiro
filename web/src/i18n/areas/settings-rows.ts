// Ticket 543: the rows that gained a reset or a why line (Settings pages that had neither), in all 8 languages.
declare module '../index' {
  interface AreaKeys {
    'settingsReset.strip': true;
    'settingsWhy.accountName': true;
    'settingsWhy.commandUnread': true;
    'settingsWhy.modelsUnread': true;
    'settingsWhy.noLibrary': true;
    'settingsWhy.machineHost': true;
  }
}

export const en = {
  'settingsReset.strip': 'Where you answer',
  'settingsWhy.accountName': 'Use a name of at most 64 characters, with no control or invisible characters.',
  'settingsWhy.commandUnread': 'The command could not be read, so it cannot be changed yet.',
  'settingsWhy.modelsUnread': 'The model list could not be read, so nothing can be added yet.',
  'settingsWhy.noLibrary': 'The widget library opens from Layout editing, which this window cannot start. Open it from a session window.',
  'settingsWhy.machineHost': 'Use letters, digits, dots, dashes and underscores for the host, and digits only for the port.',
};

export const ko = {
  'settingsReset.strip': '답하는 곳',
  'settingsWhy.accountName': '이름은 64자 이하로, 제어 문자나 보이지 않는 문자 없이 입력하세요.',
  'settingsWhy.commandUnread': '명령을 읽지 못해 아직 바꿀 수 없습니다.',
  'settingsWhy.modelsUnread': '모델 목록을 읽지 못해 아직 추가할 수 없습니다.',
  'settingsWhy.noLibrary': '위젯 라이브러리는 배치 편집에서 열리는데, 이 창에서는 시작할 수 없습니다. 세션 창에서 여세요.',
  'settingsWhy.machineHost': '호스트에는 영문자, 숫자, 점, 대시, 밑줄을, 포트에는 숫자만 쓰세요.',
};

export const ja = {
  'settingsReset.strip': '回答する場所',
  'settingsWhy.accountName': '名前は 64 文字以内で、制御文字や見えない文字を含めないでください。',
  'settingsWhy.commandUnread': 'コマンドを読み込めなかったため、まだ変更できません。',
  'settingsWhy.modelsUnread': 'モデルの一覧を読み込めなかったため、まだ追加できません。',
  'settingsWhy.noLibrary': 'ウィジェットライブラリはレイアウト編集から開きますが、このウィンドウでは開始できません。セッションのウィンドウから開いてください。',
  'settingsWhy.machineHost': 'ホストには英数字、ドット、ハイフン、アンダースコアを、ポートには数字だけを使ってください。',
};

export const zhHans = {
  'settingsReset.strip': '回答的位置',
  'settingsWhy.accountName': '名称最多 64 个字符，且不能包含控制字符或不可见字符。',
  'settingsWhy.commandUnread': '无法读取该命令，因此暂时无法更改。',
  'settingsWhy.modelsUnread': '无法读取模型列表，因此暂时无法添加。',
  'settingsWhy.noLibrary': '小组件库从布局编辑中打开，而此窗口无法启动布局编辑。请在会话窗口中打开。',
  'settingsWhy.machineHost': '主机只能使用字母、数字、点、短横线和下划线，端口只能使用数字。',
};

export const zhHant = {
  'settingsReset.strip': '回答的位置',
  'settingsWhy.accountName': '名稱最多 64 個字元，且不能包含控制字元或不可見字元。',
  'settingsWhy.commandUnread': '無法讀取該指令，因此暫時無法變更。',
  'settingsWhy.modelsUnread': '無法讀取模型清單，因此暫時無法新增。',
  'settingsWhy.noLibrary': '小工具庫從配置編輯中開啟，而此視窗無法啟動配置編輯。請在工作階段視窗中開啟。',
  'settingsWhy.machineHost': '主機只能使用字母、數字、點、連字號和底線，連接埠只能使用數字。',
};

export const es = {
  'settingsReset.strip': 'Dónde respondes',
  'settingsWhy.accountName': 'Usa un nombre de 64 caracteres como máximo, sin caracteres de control ni invisibles.',
  'settingsWhy.commandUnread': 'No se pudo leer el comando, así que todavía no se puede cambiar.',
  'settingsWhy.modelsUnread': 'No se pudo leer la lista de modelos, así que todavía no se puede añadir nada.',
  'settingsWhy.noLibrary': 'La biblioteca de widgets se abre desde la edición de la disposición, que esta ventana no puede iniciar. Ábrela desde una ventana de sesión.',
  'settingsWhy.machineHost': 'Usa letras, dígitos, puntos, guiones y guiones bajos para el host, y solo dígitos para el puerto.',
};

export const fr = {
  'settingsReset.strip': 'Où vous répondez',
  'settingsWhy.accountName': 'Utilisez un nom de 64 caractères au plus, sans caractère de contrôle ni caractère invisible.',
  'settingsWhy.commandUnread': "La commande n’a pas pu être lue, donc elle ne peut pas encore être modifiée.",
  'settingsWhy.modelsUnread': "La liste des modèles n’a pas pu être lue, donc rien ne peut encore être ajouté.",
  'settingsWhy.noLibrary': "La bibliothèque de widgets s’ouvre depuis la modification de la disposition, que cette fenêtre ne peut pas lancer. Ouvrez-la depuis une fenêtre de session.",
  'settingsWhy.machineHost': "Utilisez des lettres, des chiffres, des points, des tirets et des tirets bas pour l’hôte, et uniquement des chiffres pour le port.",
};

export const pt = {
  'settingsReset.strip': 'Onde você responde',
  'settingsWhy.accountName': 'Use um nome de no máximo 64 caracteres, sem caracteres de controle nem invisíveis.',
  'settingsWhy.commandUnread': 'Não foi possível ler o comando, então ele ainda não pode ser alterado.',
  'settingsWhy.modelsUnread': 'Não foi possível ler a lista de modelos, então ainda não dá para adicionar nada.',
  'settingsWhy.noLibrary': 'A biblioteca de widgets abre a partir da edição da disposição, que esta janela não pode iniciar. Abra-a em uma janela de sessão.',
  'settingsWhy.machineHost': 'Use letras, dígitos, pontos, hifens e sublinhados para o host, e somente dígitos para a porta.',
};
