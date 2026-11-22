// V2.5-15 (ticket 154, needs 139): the new-project wizard, a project's icon and Open in editor.
declare module '../index' {
  interface AreaKeys {
    'projects.wizard.title': true;
    'projects.wizard.name': true;
    'projects.wizard.machine': true;
    'projects.wizard.thisMac': true;
    'projects.wizard.create': true;
    'projects.wizard.cancel': true;
    'projects.wizard.existing': true;
    'projects.add.browse': true;
    'projects.add.browseNote': true;
    'projects.add.create': true;
    'projects.add.createNote': true;
    'projects.add.clone': true;
    'projects.add.cloneNote': true;
    'projects.editor': true;
    'projects.editorTitle': true;
    'projects.icon': true;
    'projects.iconTitle': true;
    'projects.iconBad': true;
  }
}

export const en = {
  'projects.wizard.title': 'New project',
  'projects.wizard.name': 'Name',
  'projects.wizard.machine': 'Machine',
  'projects.wizard.thisMac': 'This Mac',
  'projects.wizard.create': 'Create',
  'projects.wizard.cancel': 'Cancel',
  'projects.wizard.existing': 'Use an existing folder…',
  'projects.add.browse': 'Browse folder',
  'projects.add.browseNote': 'Pick a folder or Git repository on this Mac',
  'projects.add.create': 'Create new',
  'projects.add.createNote': 'Make a new folder and start it as a Git repository',
  'projects.add.clone': 'Clone',
  'projects.add.cloneNote': 'Get a repository from a Git URL',
  'projects.editor': 'Open in editor',
  'projects.editorTitle': 'Open {name} in your editor',
  'projects.icon': 'Set icon',
  'projects.iconTitle': 'Choose an image as the icon of {name}',
  'projects.iconBad': 'The icon must be a PNG, JPEG or SVG image of at most 256 KiB.',
};

export const ko = {
  'projects.wizard.title': '새 프로젝트',
  'projects.wizard.name': '이름',
  'projects.wizard.machine': '머신',
  'projects.wizard.thisMac': '이 Mac',
  'projects.wizard.create': '만들기',
  'projects.wizard.cancel': '취소',
  'projects.wizard.existing': '기존 폴더 사용…',
  'projects.add.browse': '폴더 찾아보기',
  'projects.add.browseNote': '이 Mac에 있는 폴더나 Git 저장소를 고릅니다',
  'projects.add.create': '새로 만들기',
  'projects.add.createNote': '새 폴더를 만들고 Git 저장소로 시작합니다',
  'projects.add.clone': '복제',
  'projects.add.cloneNote': 'Git URL에서 저장소를 가져옵니다',
  'projects.editor': '편집기에서 열기',
  'projects.editorTitle': '{name}을(를) 편집기에서 열기',
  'projects.icon': '아이콘 설정',
  'projects.iconTitle': '{name}의 아이콘으로 쓸 이미지 선택',
  'projects.iconBad': '아이콘은 256 KiB 이하의 PNG, JPEG 또는 SVG 이미지여야 합니다.',
};

export const ja = {
  'projects.wizard.title': '新しいプロジェクト',
  'projects.wizard.name': '名前',
  'projects.wizard.machine': 'マシン',
  'projects.wizard.thisMac': 'この Mac',
  'projects.wizard.create': '作成',
  'projects.wizard.cancel': 'キャンセル',
  'projects.wizard.existing': '既存のフォルダーを使う…',
  'projects.add.browse': 'フォルダーを参照',
  'projects.add.browseNote': 'この Mac のフォルダーや Git リポジトリを選びます',
  'projects.add.create': '新規作成',
  'projects.add.createNote': '新しいフォルダーを作り、Git リポジトリとして始めます',
  'projects.add.clone': 'クローン',
  'projects.add.cloneNote': 'Git URL からリポジトリを取得します',
  'projects.editor': 'エディターで開く',
  'projects.editorTitle': '{name} をエディターで開く',
  'projects.icon': 'アイコンを設定',
  'projects.iconTitle': '{name} のアイコンにする画像を選択',
  'projects.iconBad': 'アイコンは 256 KiB 以下の PNG、JPEG、SVG 画像にしてください。',
};

export const zhHans = {
  'projects.wizard.title': '新建项目',
  'projects.wizard.name': '名称',
  'projects.wizard.machine': "机器",
  'projects.wizard.thisMac': '这台 Mac',
  'projects.wizard.create': '创建',
  'projects.wizard.cancel': '取消',
  'projects.wizard.existing': '使用现有文件夹…',
  'projects.add.browse': '浏览文件夹',
  'projects.add.browseNote': '选择这台 Mac 上的文件夹或 Git 仓库',
  'projects.add.create': '建立新專案',
  'projects.add.createNote': "创建新文件夹，并初始化为 Git 仓库",
  'projects.add.clone': '克隆',
  'projects.add.cloneNote': '从 Git URL 获取仓库',
  'projects.editor': '在编辑器中打开',
  'projects.editorTitle': '在编辑器中打开 {name}',
  'projects.icon': '设置图标',
  'projects.iconTitle': '为 {name} 选择图标图片',
  'projects.iconBad': '图标必须是不超过 256 KiB 的 PNG、JPEG 或 SVG 图片。',
};

export const zhHant = {
  'projects.wizard.title': '新增專案',
  'projects.wizard.name': '名稱',
  'projects.wizard.machine': "機器",
  'projects.wizard.thisMac': '這台 Mac',
  'projects.wizard.create': '建立',
  'projects.wizard.cancel': '取消',
  'projects.wizard.existing': '使用現有資料夾…',
  'projects.add.browse': '瀏覽資料夾',
  'projects.add.browseNote': '選擇這台 Mac 上的資料夾或 Git 儲存庫',
  'projects.add.create': '建立新專案',
  'projects.add.createNote': "建立新資料夾，並初始化為 Git 儲存庫",
  'projects.add.clone': '複製',
  'projects.add.cloneNote': '從 Git URL 取得儲存庫',
  'projects.editor': '在編輯器中開啟',
  'projects.editorTitle': '在編輯器中開啟 {name}',
  'projects.icon': '設定圖示',
  'projects.iconTitle': '為 {name} 選擇圖示圖片',
  'projects.iconBad': '圖示必須是不超過 256 KiB 的 PNG、JPEG 或 SVG 圖片。',
};

export const es = {
  'projects.wizard.title': 'Nuevo proyecto',
  'projects.wizard.name': 'Nombre',
  'projects.wizard.machine': 'Máquina',
  'projects.wizard.thisMac': 'Este Mac',
  'projects.wizard.create': 'Crear',
  'projects.wizard.cancel': 'Cancelar',
  'projects.wizard.existing': 'Usar una carpeta existente…',
  'projects.add.browse': 'Buscar carpeta',
  'projects.add.browseNote': 'Elige una carpeta o un repositorio Git de este Mac',
  'projects.add.create': 'Crear nuevo',
  'projects.add.createNote': "Crea una carpeta nueva y la inicia como repositorio Git",
  'projects.add.clone': 'Clonar',
  'projects.add.cloneNote': 'Trae un repositorio desde una URL de Git',
  'projects.editor': 'Abrir en el editor',
  'projects.editorTitle': 'Abrir {name} en el editor',
  'projects.icon': 'Definir icono',
  'projects.iconTitle': 'Elegir una imagen como icono de {name}',
  'projects.iconBad': 'El icono debe ser una imagen PNG, JPEG o SVG de 256 KiB como máximo.',
};

export const fr = {
  'projects.wizard.title': 'Nouveau projet',
  'projects.wizard.name': 'Nom',
  'projects.wizard.machine': 'Machine',
  'projects.wizard.thisMac': 'Ce Mac',
  'projects.wizard.create': 'Créer',
  'projects.wizard.cancel': 'Annuler',
  'projects.wizard.existing': 'Utiliser un dossier existant…',
  'projects.add.browse': 'Parcourir un dossier',
  'projects.add.browseNote': 'Choisissez un dossier ou un dépôt Git sur ce Mac',
  'projects.add.create': 'Créer',
  'projects.add.createNote': "Créez un nouveau dossier et initialisez-le comme dépôt Git",
  'projects.add.clone': 'Cloner',
  'projects.add.cloneNote': 'Récupérez un dépôt depuis une URL Git',
  'projects.editor': 'Ouvrir dans l’éditeur',
  'projects.editorTitle': 'Ouvrir {name} dans l’éditeur',
  'projects.icon': 'Définir l’icône',
  'projects.iconTitle': 'Choisir une image comme icône de {name}',
  'projects.iconBad': 'L’icône doit être une image PNG, JPEG ou SVG de 256 Kio au plus.',
};

export const pt = {
  'projects.wizard.title': 'Novo projeto',
  'projects.wizard.name': 'Nome',
  'projects.wizard.machine': 'Máquina',
  'projects.wizard.thisMac': 'Este Mac',
  'projects.wizard.create': 'Criar',
  'projects.wizard.cancel': 'Cancelar',
  'projects.wizard.existing': 'Usar uma pasta existente…',
  'projects.add.browse': 'Procurar pasta',
  'projects.add.browseNote': 'Escolha uma pasta ou um repositório Git neste Mac',
  'projects.add.create': 'Criar novo',
  'projects.add.createNote': 'Cria uma pasta nova e começa como repositório Git',
  'projects.add.clone': 'Clonar',
  'projects.add.cloneNote': 'Traz um repositório de uma URL Git',
  'projects.editor': 'Abrir no editor',
  'projects.editorTitle': 'Abrir {name} no editor',
  'projects.icon': 'Definir ícone',
  'projects.iconTitle': 'Escolher uma imagem como ícone de {name}',
  'projects.iconBad': 'O ícone deve ser uma imagem PNG, JPEG ou SVG de no máximo 256 KiB.',
};
