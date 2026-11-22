// Ticket 264 (needs 198, G05): Settings › In-app browser › Profiles (features/browser-profiles.tsx), the new-space picker and the
// signed-in chip of the side pane's browser.
declare module '../index' {
  interface AreaKeys {
    'bprofiles.title': true;
    'bprofiles.lede': true;
    'bprofiles.builtIn': true;
    'bprofiles.defaultChip': true;
    'bprofiles.live': true;
    'bprofiles.live1': true;
    'bprofiles.idle': true;
    'bprofiles.add': true;
    'bprofiles.addConfirm': true;
    'bprofiles.nameLabel': true;
    'bprofiles.rename': true;
    'bprofiles.renameLabel': true;
    'bprofiles.makeDefault': true;
    'bprofiles.clear': true;
    'bprofiles.remove': true;
    'bprofiles.removeBusy': true;
    'bprofiles.keep': true;
    'bprofiles.clearTitle': true;
    'bprofiles.clearText': true;
    'bprofiles.clearConfirm': true;
    'bprofiles.removeTitle': true;
    'bprofiles.removeText': true;
    'bprofiles.removeConfirm': true;
    'bprofiles.cleared': true;
    'bprofiles.removed': true;
    'bprofiles.picker': true;
    'bprofiles.gone': true;
    'bprofiles.signedIn': true;
    'bprofiles.signedInTip': true;
    'field.browserProfiles': true;
  }
}

export const en = {
  'bprofiles.title': 'Browser profiles',
  'bprofiles.lede': 'A profile holds cookies and logins. Your tabs and agent spaces on one profile share them, so an agent can act on sites you are signed in to. Use a separate profile to keep a site away from agents.',
  'bprofiles.builtIn': 'Default profile',
  'bprofiles.defaultChip': 'Default',
  'bprofiles.live': 'Open in {n} browser spaces',
  'bprofiles.live1': 'Open in 1 browser space',
  'bprofiles.idle': 'Not open anywhere',
  'bprofiles.add': 'Add profile',
  'bprofiles.addConfirm': 'Add',
  'bprofiles.nameLabel': 'Profile name',
  'bprofiles.rename': 'Rename',
  'bprofiles.renameLabel': 'New name for {name}',
  'bprofiles.makeDefault': 'Make default',
  'bprofiles.clear': 'Clear cookies and site data',
  'bprofiles.remove': 'Remove',
  'bprofiles.removeBusy': 'First close the browser spaces that use this profile',
  'bprofiles.keep': 'Keep',
  'bprofiles.clearTitle': 'Clear all cookies and site data in “{name}”?',
  'bprofiles.clearText': 'Every browser space on this profile is signed out, your own tabs and agents alike. This cannot be undone.',
  'bprofiles.clearConfirm': 'Clear everything',
  'bprofiles.removeTitle': 'Remove “{name}”?',
  'bprofiles.removeText': 'Its cookies, logins and site data are deleted. This cannot be undone. Paused spaces on this profile will ask for a profile again.',
  'bprofiles.removeConfirm': 'Remove profile',
  'bprofiles.cleared': '“{name}” is cleared.',
  'bprofiles.removed': '“{name}” is removed.',
  'bprofiles.picker': 'Profile',
  'bprofiles.gone': 'This space\'s profile was removed; pick one',
  'bprofiles.signedIn': 'signed in: {site}',
  'bprofiles.signedInTip': 'This browser profile is signed in to this site, so the agent can act as you here',
  'field.browserProfiles': 'Browser profiles',
};

export const ko = {
  'bprofiles.title': '브라우저 프로필',
  'bprofiles.lede': '프로필에는 쿠키와 로그인이 들어 있습니다. 같은 프로필의 내 탭과 에이전트 공간은 이를 함께 쓰므로, 에이전트가 내가 로그인한 사이트에서 작업할 수 있습니다. 에이전트가 쓰면 안 되는 사이트는 별도 프로필에 두세요.',
  'bprofiles.builtIn': '기본 프로필',
  'bprofiles.defaultChip': '기본값',
  'bprofiles.live': '브라우저 공간 {n}개에서 열림',
  'bprofiles.live1': '브라우저 공간 1개에서 열림',
  'bprofiles.idle': '열려 있지 않음',
  'bprofiles.add': '프로필 추가',
  'bprofiles.addConfirm': '추가',
  'bprofiles.nameLabel': '프로필 이름',
  'bprofiles.rename': '이름 바꾸기',
  'bprofiles.renameLabel': '{name}의 새 이름',
  'bprofiles.makeDefault': '기본값으로',
  'bprofiles.clear': '쿠키와 사이트 데이터 지우기',
  'bprofiles.remove': '제거',
  'bprofiles.removeBusy': '이 프로필을 쓰는 브라우저 공간을 먼저 닫으세요',
  'bprofiles.keep': '유지',
  'bprofiles.clearTitle': '“{name}”의 쿠키와 사이트 데이터를 모두 지우시겠습니까?',
  'bprofiles.clearText': '내 탭과 에이전트를 포함해 이 프로필의 모든 브라우저 공간이 로그아웃됩니다. 되돌릴 수 없습니다.',
  'bprofiles.clearConfirm': '모두 지우기',
  'bprofiles.removeTitle': '“{name}”을(를) 제거하시겠습니까?',
  'bprofiles.removeText': '쿠키, 로그인, 사이트 데이터가 삭제됩니다. 되돌릴 수 없습니다. 이 프로필에서 멈춰 있는 공간은 프로필을 다시 묻습니다.',
  'bprofiles.removeConfirm': '프로필 제거',
  'bprofiles.cleared': '“{name}”의 쿠키와 사이트 데이터를 지웠습니다.',
  'bprofiles.removed': '“{name}”을(를) 제거했습니다.',
  'bprofiles.picker': '프로필',
  'bprofiles.gone': '이 공간의 프로필이 제거되었습니다. 프로필을 선택하세요',
  'bprofiles.signedIn': '로그인됨: {site}',
  'bprofiles.signedInTip': '이 브라우저 프로필은 이 사이트에 로그인되어 있어 에이전트가 나 대신 작업할 수 있습니다',
  'field.browserProfiles': '브라우저 프로필',
};

export const ja = {
  'bprofiles.title': 'ブラウザプロファイル',
  'bprofiles.lede': 'プロファイルには Cookie とログインが保存されます。同じプロファイルの自分のタブとエージェントのスペースはこれを共有するため、エージェントはあなたがログインしているサイトで操作できます。エージェントに使わせないサイトには別のプロファイルを使ってください。',
  'bprofiles.builtIn': 'デフォルトプロファイル',
  'bprofiles.defaultChip': 'デフォルト',
  'bprofiles.live': '{n} 個のブラウザスペースで使用中',
  'bprofiles.live1': '1 個のブラウザスペースで使用中',
  'bprofiles.idle': '使用されていません',
  'bprofiles.add': 'プロファイルを追加',
  'bprofiles.addConfirm': '追加',
  'bprofiles.nameLabel': 'プロファイル名',
  'bprofiles.rename': '名前を変更',
  'bprofiles.renameLabel': '{name} の新しい名前',
  'bprofiles.makeDefault': 'デフォルトにする',
  'bprofiles.clear': 'Cookie とサイトデータを消去',
  'bprofiles.remove': '削除',
  'bprofiles.removeBusy': "先にこのプロファイルで開いているブラウザスペースを閉じてください",
  'bprofiles.keep': '残す',
  'bprofiles.clearTitle': '「{name}」の Cookie とサイトデータをすべて消去しますか？',
  'bprofiles.clearText': '自分のタブもエージェントも含め、このプロファイルのすべてのブラウザスペースがログアウトします。元に戻せません。',
  'bprofiles.clearConfirm': 'すべて消去',
  'bprofiles.removeTitle': '「{name}」を削除しますか？',
  'bprofiles.removeText': 'Cookie、ログイン、サイトデータが削除されます。元に戻せません。このプロファイルの一時停止中のスペースは、プロファイルをもう一度選ぶよう求めます。',
  'bprofiles.removeConfirm': 'プロファイルを削除',
  'bprofiles.cleared': '「{name}」を消去しました。',
  'bprofiles.removed': '「{name}」を削除しました。',
  'bprofiles.picker': 'プロファイル',
  'bprofiles.gone': 'このスペースのプロファイルは削除されました。プロファイルを選んでください',
  'bprofiles.signedIn': 'ログイン中：{site}',
  'bprofiles.signedInTip': 'このブラウザプロファイルはこのサイトにログインしているため、エージェントがあなたとして操作できます',
  'field.browserProfiles': 'ブラウザプロファイル',
};

export const zhHans = {
  'bprofiles.title': '浏览器配置文件',
  'bprofiles.lede': '配置文件保存 Cookie 和登录状态。你的选项卡和代理空间如果使用同一配置文件，就会共享这些数据，因此代理可以在你已登录的网站上操作。如不想让代理使用某个网站，请使用单独的配置文件。',
  'bprofiles.builtIn': '默认配置文件',
  'bprofiles.defaultChip': '默认',
  'bprofiles.live': '已在 {n} 个浏览器空间中打开',
  'bprofiles.live1': '已在 1 个浏览器空间中打开',
  'bprofiles.idle': '未在任何地方打开',
  'bprofiles.add': '添加配置文件',
  'bprofiles.addConfirm': '添加',
  'bprofiles.nameLabel': '配置文件名称',
  'bprofiles.rename': '重命名',
  'bprofiles.renameLabel': '{name} 的新名称',
  'bprofiles.makeDefault': '设为默认',
  'bprofiles.clear': '清除 Cookie 和网站数据',
  'bprofiles.remove': '移除',
  'bprofiles.removeBusy': '请先关闭使用此配置文件的浏览器空间',
  'bprofiles.keep': '保留',
  'bprofiles.clearTitle': '清除“{name}”中的所有 Cookie 和网站数据？',
  'bprofiles.clearText': '此配置文件上的所有浏览器空间都将退出登录，包括你自己的选项卡和代理。此操作无法撤销。',
  'bprofiles.clearConfirm': '全部清除',
  'bprofiles.removeTitle': '移除“{name}”？',
  'bprofiles.removeText': '其 Cookie、登录状态和网站数据将被删除。此操作无法撤销。此配置文件上已暂停的空间会重新询问配置文件。',
  'bprofiles.removeConfirm': '移除配置文件',
  'bprofiles.cleared': '已清除“{name}”。',
  'bprofiles.removed': '已移除“{name}”。',
  'bprofiles.picker': '配置文件',
  'bprofiles.gone': '此空间的配置文件已被移除，请选择一个',
  'bprofiles.signedIn': '已登录：{site}',
  'bprofiles.signedInTip': '此浏览器配置文件已登录该网站，因此代理可以以你的身份操作',
  'field.browserProfiles': '浏览器配置文件',
};

export const zhHant = {
  'bprofiles.title': '瀏覽器設定檔',
  'bprofiles.lede': "設定檔保存 Cookie 與登入狀態。同一設定檔中你的選項卡和代理空間會共用這些資料，因此代理可以在你已登入的網站上操作。若不想讓代理使用某個網站，請改用另一個設定檔。",
  'bprofiles.builtIn': '預設設定檔',
  'bprofiles.defaultChip': '預設',
  'bprofiles.live': '在 {n} 個瀏覽器空間中開啟',
  'bprofiles.live1': '在 1 個瀏覽器空間中開啟',
  'bprofiles.idle': '未在任何地方開啟',
  'bprofiles.add': '新增設定檔',
  'bprofiles.addConfirm': '新增',
  'bprofiles.nameLabel': '設定檔名稱',
  'bprofiles.rename': '重新命名',
  'bprofiles.renameLabel': '{name} 的新名稱',
  'bprofiles.makeDefault': '設為預設',
  'bprofiles.clear': '清除 Cookie 與網站資料',
  'bprofiles.remove': '移除',
  'bprofiles.removeBusy': '請先關閉使用此設定檔的瀏覽器空間',
  'bprofiles.keep': '保留',
  'bprofiles.clearTitle': '清除「{name}」中的所有 Cookie 與網站資料？',
  'bprofiles.clearText': "此設定檔上的所有瀏覽器空間都會登出，包括你自己的選項卡和代理。此動作無法復原。",
  'bprofiles.clearConfirm': '全部清除',
  'bprofiles.removeTitle': '移除「{name}」？',
  'bprofiles.removeText': '其 Cookie、登入狀態與網站資料將被刪除。此動作無法復原。此設定檔上已暫停的空間會重新詢問設定檔。',
  'bprofiles.removeConfirm': '移除設定檔',
  'bprofiles.cleared': '已清除「{name}」。',
  'bprofiles.removed': '已移除「{name}」。',
  'bprofiles.picker': '設定檔',
  'bprofiles.gone': '此空間的設定檔已被移除，請選擇一個',
  'bprofiles.signedIn': '已登入：{site}',
  'bprofiles.signedInTip': "此瀏覽器設定檔已登入此網站，因此代理可以用你的身分操作",
  'field.browserProfiles': '瀏覽器設定檔',
};

export const es = {
  'bprofiles.title': 'Perfiles del navegador',
  'bprofiles.lede': 'Un perfil guarda cookies e inicios de sesión. Tus pestañas y los espacios de agentes de un mismo perfil los comparten, así que un agente puede actuar en los sitios donde hayas iniciado sesión. Usa un perfil aparte para mantener un sitio lejos de los agentes.',
  'bprofiles.builtIn': 'Perfil predeterminado',
  'bprofiles.defaultChip': 'Predeterminado',
  'bprofiles.live': 'Abierto en {n} espacios del navegador',
  'bprofiles.live1': 'Abierto en 1 espacio del navegador',
  'bprofiles.idle': 'Sin abrir',
  'bprofiles.add': 'Añadir perfil',
  'bprofiles.addConfirm': 'Añadir',
  'bprofiles.nameLabel': 'Nombre del perfil',
  'bprofiles.rename': 'Renombrar',
  'bprofiles.renameLabel': 'Nuevo nombre para {name}',
  'bprofiles.makeDefault': 'Hacer predeterminado',
  'bprofiles.clear': 'Borrar cookies y datos de sitios',
  'bprofiles.remove': 'Eliminar',
  'bprofiles.removeBusy': 'Cierra primero los espacios del navegador que usan este perfil',
  'bprofiles.keep': 'Conservar',
  'bprofiles.clearTitle': '¿Borrar todas las cookies y datos de sitios de “{name}”?',
  'bprofiles.clearText': 'Se cerrará la sesión en todos los espacios del navegador de este perfil, incluidas tus pestañas y los agentes. No se puede deshacer.',
  'bprofiles.clearConfirm': 'Borrar todo',
  'bprofiles.removeTitle': '¿Eliminar “{name}”?',
  'bprofiles.removeText': 'Se borrarán sus cookies, inicios de sesión y datos de sitios. No se puede deshacer. Los espacios en pausa de este perfil volverán a pedir un perfil.',
  'bprofiles.removeConfirm': 'Eliminar perfil',
  'bprofiles.cleared': 'Se ha borrado “{name}”.',
  'bprofiles.removed': 'Se ha eliminado “{name}”.',
  'bprofiles.picker': 'Perfil',
  'bprofiles.gone': 'El perfil de este espacio se eliminó; elige uno',
  'bprofiles.signedIn': 'con sesión: {site}',
  'bprofiles.signedInTip': 'Este perfil del navegador tiene la sesión iniciada en este sitio, así que el agente puede actuar en tu nombre',
  'field.browserProfiles': 'Perfiles del navegador',
};

export const fr = {
  'bprofiles.title': 'Profils du navigateur',
  'bprofiles.lede': 'Un profil contient des cookies et des connexions. Vos onglets et les espaces d’agents d’un même profil les partagent : un agent peut donc agir sur les sites où vous êtes connecté. Utilisez un profil distinct pour tenir un site à l’écart des agents.',
  'bprofiles.builtIn': 'Profil par défaut',
  'bprofiles.defaultChip': 'Par défaut',
  'bprofiles.live': 'Ouvert dans {n} espaces du navigateur',
  'bprofiles.live1': 'Ouvert dans 1 espace du navigateur',
  'bprofiles.idle': 'Ouvert nulle part',
  'bprofiles.add': 'Ajouter un profil',
  'bprofiles.addConfirm': 'Ajouter',
  'bprofiles.nameLabel': 'Nom du profil',
  'bprofiles.rename': 'Renommer',
  'bprofiles.renameLabel': 'Nouveau nom pour {name}',
  'bprofiles.makeDefault': 'Définir par défaut',
  'bprofiles.clear': 'Effacer les cookies et données de sites',
  'bprofiles.remove': 'Supprimer',
  'bprofiles.removeBusy': 'Fermez d’abord les espaces du navigateur qui utilisent ce profil',
  'bprofiles.keep': 'Conserver',
  'bprofiles.clearTitle': 'Effacer tous les cookies et données de sites de « {name} » ?',
  'bprofiles.clearText': 'Tous les espaces du navigateur de ce profil seront déconnectés, vos onglets comme les agents. Action irréversible.',
  'bprofiles.clearConfirm': 'Tout effacer',
  'bprofiles.removeTitle': 'Supprimer « {name} » ?',
  'bprofiles.removeText': 'Ses cookies, connexions et données de sites seront supprimés. Action irréversible. Les espaces en pause de ce profil redemanderont un profil.',
  'bprofiles.removeConfirm': 'Supprimer le profil',
  'bprofiles.cleared': '« {name} » a été effacé.',
  'bprofiles.removed': '« {name} » a été supprimé.',
  'bprofiles.picker': 'Profil',
  'bprofiles.gone': 'Le profil de cet espace a été supprimé ; choisissez-en un',
  'bprofiles.signedIn': 'connecté : {site}',
  'bprofiles.signedInTip': 'Ce profil du navigateur est connecté à ce site : l’agent peut donc agir en votre nom',
  'field.browserProfiles': 'Profils du navigateur',
};

export const pt = {
  'bprofiles.title': 'Perfis do navegador',
  'bprofiles.lede': 'Um perfil guarda cookies e logins. Suas abas e os espaços de agentes de um mesmo perfil os compartilham, então um agente pode agir nos sites em que você está conectado. Use um perfil separado para manter um site longe dos agentes.',
  'bprofiles.builtIn': 'Perfil padrão',
  'bprofiles.defaultChip': 'Padrão',
  'bprofiles.live': 'Aberto em {n} espaços do navegador',
  'bprofiles.live1': 'Aberto em 1 espaço do navegador',
  'bprofiles.idle': 'Não está aberto',
  'bprofiles.add': 'Adicionar perfil',
  'bprofiles.addConfirm': 'Adicionar',
  'bprofiles.nameLabel': 'Nome do perfil',
  'bprofiles.rename': 'Renomear',
  'bprofiles.renameLabel': 'Novo nome para {name}',
  'bprofiles.makeDefault': 'Tornar padrão',
  'bprofiles.clear': 'Apagar cookies e dados de sites',
  'bprofiles.remove': 'Remover',
  'bprofiles.removeBusy': 'Feche primeiro os espaços do navegador que usam este perfil',
  'bprofiles.keep': 'Manter',
  'bprofiles.clearTitle': 'Apagar todos os cookies e dados de sites de “{name}”?',
  'bprofiles.clearText': 'Todos os espaços do navegador neste perfil ficarão sem login, incluindo suas abas e os agentes. Não é possível desfazer.',
  'bprofiles.clearConfirm': 'Apagar tudo',
  'bprofiles.removeTitle': 'Remover “{name}”?',
  'bprofiles.removeText': 'Seus cookies, logins e dados de sites serão apagados. Não é possível desfazer. Os espaços pausados neste perfil pedirão um perfil novamente.',
  'bprofiles.removeConfirm': 'Remover perfil',
  'bprofiles.cleared': 'Os dados de “{name}” foram apagados.',
  'bprofiles.removed': '“{name}” foi removido.',
  'bprofiles.picker': 'Perfil',
  'bprofiles.gone': 'O perfil deste espaço foi removido; escolha um',
  'bprofiles.signedIn': 'conectado: {site}',
  'bprofiles.signedInTip': 'Este perfil do navegador está conectado a este site, então o agente pode agir em seu nome',
  'field.browserProfiles': 'Perfis do navegador',
};
