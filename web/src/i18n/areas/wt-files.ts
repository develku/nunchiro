// Ticket 253 (G22): Settings › Git & Worktrees › Shared files (features/wt-files.tsx), the create line naming what was not
// shared, and the linked paths in the remove sheet (tree/worktrees.tsx). English is the source; the others are drafts.
declare module '../index' {
  interface AreaKeys {
    'field.sharedFiles': true;
    'wtFiles.filesDesc': true;
    'wtFiles.none': true;
    'wtFiles.link': true;
    'wtFiles.copy': true;
    'wtFiles.mode': true;
    'wtFiles.remove': true;
    'wtFiles.addLabel': true;
    'wtFiles.add': true;
    'field.sparsePreset': true;
    'wtFiles.sparseDesc': true;
    'wtFiles.failed': true;
    'wtFiles.linkedLabel': true;
    'wtFiles.linked': true;
  }
}

export const en = {
  'field.sharedFiles': "Shared files",
  'wtFiles.filesDesc': "Paths relative to the project folder, such as .env or config/master.key. Link is the default: a secret then has one copy, in the project. Copy gives the worktree its own file. A file git checks out is never replaced.",
  'wtFiles.none': "No shared files yet.",
  'wtFiles.link': "Link",
  'wtFiles.copy': "Copy",
  'wtFiles.mode': "How {path} is shared",
  'wtFiles.remove': "Remove {path}",
  'wtFiles.addLabel': "Path to share",
  'wtFiles.add': "Add",
  'field.sparsePreset': "Sparse checkout",
  'wtFiles.sparseDesc': "Folders a new worktree checks out, one per line (git sparse-checkout, cone mode); the files at the top level always come too. Empty checks out everything.",
  'wtFiles.failed': "The worktree was made, but these were not shared: {paths}",
  'wtFiles.linkedLabel': "Linked from the project",
  'wtFiles.linked': "Linked from the project: removing the worktree removes only the link, and the project keeps its file.",
};

export const ko = {
  'field.sharedFiles': "공유 파일",
  'wtFiles.filesDesc': "프로젝트 폴더 기준 경로입니다. 예: .env, config/master.key. 기본은 링크입니다. 그러면 비밀 값의 사본이 프로젝트에 하나만 남습니다. 복사는 워크트리에 별도 파일을 만듭니다. git이 체크아웃한 파일은 절대 덮어쓰지 않습니다.",
  'wtFiles.none': "아직 공유 파일이 없습니다.",
  'wtFiles.link': "링크",
  'wtFiles.copy': "복사",
  'wtFiles.mode': "{path} 공유 방식",
  'wtFiles.remove': "{path} 제거",
  'wtFiles.addLabel': "공유할 경로",
  'wtFiles.add': "추가",
  'field.sparsePreset': "스파스 체크아웃",
  'wtFiles.sparseDesc': "새 워크트리가 체크아웃할 폴더를 한 줄에 하나씩 적습니다(git sparse-checkout, cone 모드). 최상위 파일은 항상 함께 옵니다. 비워 두면 전체를 체크아웃합니다.",
  'wtFiles.failed': "워크트리는 만들었지만 다음은 공유하지 못했습니다: {paths}",
  'wtFiles.linkedLabel': "프로젝트에서 링크됨",
  'wtFiles.linked': "프로젝트에서 링크됨: 워크트리를 제거해도 링크만 지워지고 프로젝트의 파일은 그대로 남습니다.",
};

export const ja = {
  'field.sharedFiles': "共有ファイル",
  'wtFiles.filesDesc': "プロジェクトフォルダーからの相対パスです（例：.env、config/master.key）。デフォルトはリンクで、秘密情報の実体はプロジェクトに 1 つだけ残ります。コピーはワークツリー専用のファイルを作ります。git がチェックアウトしたファイルは置き換えません。",
  'wtFiles.none': "共有ファイルはまだありません。",
  'wtFiles.link': "リンク",
  'wtFiles.copy': "コピー",
  'wtFiles.mode': "{path} の共有方法",
  'wtFiles.remove': "{path} を削除",
  'wtFiles.addLabel': "共有するパス",
  'wtFiles.add': "追加",
  'field.sparsePreset': "スパースチェックアウト",
  'wtFiles.sparseDesc': "新しいワークツリーがチェックアウトするフォルダーを 1 行に 1 つ書きます。最上位のファイルは常に含まれます。空ならすべてをチェックアウトします。",
  'wtFiles.failed': "ワークツリーは作成されましたが、次は共有できませんでした：{paths}",
  'wtFiles.linkedLabel': "プロジェクトからリンク",
  'wtFiles.linked': "プロジェクトからリンク：ワークツリーを削除してもリンクだけが消え、プロジェクトのファイルは残ります。",
};

export const zhHans = {
  'field.sharedFiles': "共享文件",
  'wtFiles.filesDesc': "相对于项目文件夹的路径，例如 .env 或 config/master.key。默认是链接：这样密钥只在项目中保留一份。复制会给工作树一个独立文件。git 检出的文件永远不会被替换。",
  'wtFiles.none': "还没有共享文件。",
  'wtFiles.link': "链接",
  'wtFiles.copy': "复制",
  'wtFiles.mode': "{path} 的共享方式",
  'wtFiles.remove': "移除 {path}",
  'wtFiles.addLabel': "要共享的路径",
  'wtFiles.add': "添加",
  'field.sparsePreset': "稀疏检出",
  'wtFiles.sparseDesc': "新工作树检出的文件夹，每行一个；顶层文件始终会包含。留空则检出全部。",
  'wtFiles.failed': "工作树已创建，但以下内容未能共享：{paths}",
  'wtFiles.linkedLabel': "从项目链接",
  'wtFiles.linked': "从项目链接：移除工作树只会删除链接，项目中的文件保留。",
};

export const zhHant = {
  'field.sharedFiles': "共用檔案",
  'wtFiles.filesDesc': "相對於專案資料夾的路徑，例如 .env 或 config/master.key。預設為連結：如此密鑰只在專案中保留一份。複製會給工作樹一個獨立檔案。git 檢出的檔案絕不會被取代。",
  'wtFiles.none': "尚無共用檔案。",
  'wtFiles.link': "連結",
  'wtFiles.copy': "複製",
  'wtFiles.mode': "{path} 的共用方式",
  'wtFiles.remove': "移除 {path}",
  'wtFiles.addLabel': "要共用的路徑",
  'wtFiles.add': "新增",
  'field.sparsePreset': "稀疏檢出",
  'wtFiles.sparseDesc': "新工作樹檢出的資料夾，每行一個；最上層檔案一律包含。留空則檢出全部。",
  'wtFiles.failed': "工作樹已建立，但以下項目未能共用：{paths}",
  'wtFiles.linkedLabel': "從專案連結",
  'wtFiles.linked': "從專案連結：移除工作樹只會刪除連結，專案中的檔案會保留。",
};

export const es = {
  'field.sharedFiles': "Archivos compartidos",
  'wtFiles.filesDesc': "Rutas relativas a la carpeta del proyecto, como .env o config/master.key. Enlace es lo predeterminado: así un secreto tiene una sola copia, en el proyecto. Copiar da al árbol de trabajo su propio archivo. Nunca se reemplaza un archivo que git extrae.",
  'wtFiles.none': "Aún no hay archivos compartidos.",
  'wtFiles.link': "Enlace",
  'wtFiles.copy': "Copiar",
  'wtFiles.mode': "Cómo se comparte {path}",
  'wtFiles.remove': "Quitar {path}",
  'wtFiles.addLabel': "Ruta a compartir",
  'wtFiles.add': "Añadir",
  'field.sparsePreset': "Extracción dispersa",
  'wtFiles.sparseDesc': "Carpetas que extrae un árbol de trabajo nuevo, una por línea (git sparse-checkout, modo cone); los archivos de la raíz siempre vienen. Vacío extrae todo.",
  'wtFiles.failed': "Se creó el árbol de trabajo, pero esto no se compartió: {paths}",
  'wtFiles.linkedLabel': "Enlazado desde el proyecto",
  'wtFiles.linked': "Enlazado desde el proyecto: al quitar el árbol de trabajo solo se quita el enlace y el proyecto conserva su archivo.",
};

export const fr = {
  'field.sharedFiles': "Fichiers partagés",
  'wtFiles.filesDesc': "Chemins relatifs au dossier du projet, comme .env ou config/master.key. Lien est le choix par défaut : un secret n’a alors qu’une copie, dans le projet. Copier donne à l’arbre de travail son propre fichier. Un fichier extrait par git n’est jamais remplacé.",
  'wtFiles.none': "Aucun fichier partagé pour l’instant.",
  'wtFiles.link': "Lien",
  'wtFiles.copy': "Copier",
  'wtFiles.mode': "Mode de partage de {path}",
  'wtFiles.remove': "Retirer {path}",
  'wtFiles.addLabel': "Chemin à partager",
  'wtFiles.add': "Ajouter",
  'field.sparsePreset': "Extraction partielle",
  'wtFiles.sparseDesc': "Dossiers qu’un nouvel arbre de travail extrait, un par ligne (git sparse-checkout, mode cone) ; les fichiers de la racine sont toujours inclus. Vide : tout est extrait.",
  'wtFiles.failed': "L’arbre de travail a été créé, mais ceci n’a pas été partagé : {paths}",
  'wtFiles.linkedLabel': "Lié depuis le projet",
  'wtFiles.linked': "Lié depuis le projet : retirer l’arbre de travail ne supprime que le lien, le projet garde son fichier.",
};

export const pt = {
  'field.sharedFiles': "Arquivos compartilhados",
  'wtFiles.filesDesc': "Caminhos relativos à pasta do projeto, como .env ou config/master.key. Link é o padrão: assim um segredo tem uma só cópia, no projeto. Copiar dá à árvore de trabalho seu próprio arquivo. Um arquivo que o git extrai nunca é substituído.",
  'wtFiles.none': "Ainda não há arquivos compartilhados.",
  'wtFiles.link': "Link",
  'wtFiles.copy': "Copiar",
  'wtFiles.mode': "Como {path} é compartilhado",
  'wtFiles.remove': "Remover {path}",
  'wtFiles.addLabel': "Caminho a compartilhar",
  'wtFiles.add': "Adicionar",
  'field.sparsePreset': "Checkout esparso",
  'wtFiles.sparseDesc': "Pastas que uma nova árvore de trabalho extrai, uma por linha (git sparse-checkout, modo cone); os arquivos da raiz sempre vêm. Vazio extrai tudo.",
  'wtFiles.failed': "A árvore de trabalho foi criada, mas isto não foi compartilhado: {paths}",
  'wtFiles.linkedLabel': "Vinculado do projeto",
  'wtFiles.linked': "Vinculado do projeto: remover a árvore de trabalho remove só o link, e o projeto mantém seu arquivo.",
};
