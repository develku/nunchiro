// Ticket 252 (needs 197, G20): Settings > Permissions, the macOS permission status rows (features/macos-perms.tsx).
declare module '../index' {
  interface AreaKeys {
    'settings.page.permissions': true;
    'settings.desc.permissions': true;
    "perms.section": true;
    "perms.lede": true;
    "perms.refresh": true;
    "perms.open": true;
    "perms.checking": true;
    "perms.granted": true;
    "perms.notGranted": true;
    "perms.unknown": true;
    "perms.notNeeded": true;
    "perms.fullDisk": true;
    "perms.fullDiskDesc": true;
    "perms.volumes": true;
    "perms.volumesDesc": true;
    "perms.network": true;
    "perms.networkDesc": true;
  }
}

export const en = {
  'settings.page.permissions': 'Permissions',
  'settings.desc.permissions': 'The macOS permissions Nunchiro uses and their current state.',
  "perms.section": "macOS permissions",
  "perms.lede": "Nunchiro only reads these. Change them in System Settings.",
  "perms.refresh": "Refresh",
  "perms.open": "Open System Settings",
  "perms.checking": "Checking…",
  "perms.granted": "Granted",
  "perms.notGranted": "Not granted",
  "perms.unknown": "Unknown",
  "perms.notNeeded": "Not needed",
  "perms.fullDisk": "Full Disk Access",
  "perms.fullDiskDesc": "Reads every folder on this Mac. This access also reaches every agent Nunchiro starts.",
  "perms.volumes": "Removable volumes",
  "perms.volumesDesc": "Reads projects on external drives. Check again after each app update.",
  "perms.network": "Local network",
  "perms.networkDesc": "Lets agents reach devices on your network. macOS does not report this status.",
};

export const ko = {
  'settings.page.permissions': '권한',
  'settings.desc.permissions': 'Nunchiro가 쓰는 macOS 권한과 지금 상태.',
  "perms.section": "macOS 권한",
  "perms.lede": "Nunchiro는 상태를 읽기만 합니다. 바꾸려면 시스템 설정을 여세요.",
  "perms.refresh": "새로고침",
  "perms.open": "시스템 설정 열기",
  "perms.checking": "확인 중…",
  "perms.granted": "허용됨",
  "perms.notGranted": "허용 안 됨",
  "perms.unknown": "알 수 없음",
  "perms.notNeeded": "필요 없음",
  "perms.fullDisk": "전체 디스크 접근 권한",
  "perms.fullDiskDesc": "이 Mac의 모든 폴더를 읽습니다. 이 권한은 Nunchiro가 시작하는 모든 에이전트에도 적용됩니다.",
  "perms.volumes": "이동식 볼륨",
  "perms.volumesDesc": "외장 드라이브의 프로젝트를 읽습니다. 앱을 업데이트할 때마다 다시 확인하세요.",
  "perms.network": "로컬 네트워크",
  "perms.networkDesc": "에이전트가 네트워크의 기기에 접속하게 합니다. macOS는 이 상태를 알려 주지 않습니다.",
};

export const ja = {
  'settings.page.permissions': '権限',
  'settings.desc.permissions': 'Nunchiro が使う macOS の権限と現在の状態。',
  "perms.section": "macOS の権限",
  "perms.lede": "Nunchiro は状態を読み取るだけです。変更はシステム設定で行います。",
  "perms.refresh": "再読み込み",
  "perms.open": "システム設定を開く",
  "perms.checking": "確認中…",
  "perms.granted": "許可済み",
  "perms.notGranted": "未許可",
  "perms.unknown": "不明",
  "perms.notNeeded": "不要",
  "perms.fullDisk": "フルディスクアクセス",
  "perms.fullDiskDesc": "この Mac のすべてのフォルダーを読み取ります。このアクセスは Nunchiro が起動するすべてのエージェントにも及びます。",
  "perms.volumes": "リムーバブルボリューム",
  "perms.volumesDesc": "外部ドライブ上のプロジェクトを読み取ります。アプリを更新するたびに確認してください。",
  "perms.network": "ローカルネットワーク",
  "perms.networkDesc": "エージェントがネットワーク上のデバイスに接続できるようにします。macOS はこの状態を報告しません。",
};

export const zhHans = {
  'settings.page.permissions': '权限',
  'settings.desc.permissions': 'Nunchiro 使用的 macOS 权限及其当前状态。',
  "perms.section": "macOS 权限",
  "perms.lede": "Nunchiro 只读取这些状态。请在系统设置中更改。",
  "perms.refresh": "刷新",
  "perms.open": "打开系统设置",
  "perms.checking": "正在检查…",
  "perms.granted": "已允许",
  "perms.notGranted": "未允许",
  "perms.unknown": "未知",
  "perms.notNeeded": "不需要",
  "perms.fullDisk": "完全磁盘访问权限",
  "perms.fullDiskDesc": "读取这台 Mac 上的所有文件夹。此权限也会作用于 Nunchiro 启动的每个代理。",
  "perms.volumes": "可移除的宗卷",
  "perms.volumesDesc": "读取外置驱动器上的项目。每次更新应用后请重新检查。",
  "perms.network": "本地网络",
  "perms.networkDesc": "让代理访问你网络中的设备。macOS 不报告此状态。",
};

export const zhHant = {
  'settings.page.permissions': '權限',
  'settings.desc.permissions': 'Nunchiro 使用的 macOS 權限及其目前狀態。',
  "perms.section": "macOS 權限",
  "perms.lede": "Nunchiro 只讀取這些狀態。請在系統設定中變更。",
  "perms.refresh": "重新整理",
  "perms.open": "開啟系統設定",
  "perms.checking": "正在檢查…",
  "perms.granted": "已允許",
  "perms.notGranted": "未允許",
  "perms.unknown": "未知",
  "perms.notNeeded": "不需要",
  "perms.fullDisk": "完全取用磁碟",
  "perms.fullDiskDesc": "讀取這台 Mac 上的所有資料夾。此權限也會作用於 Nunchiro 啟動的每個代理。",
  "perms.volumes": "可卸除式卷宗",
  "perms.volumesDesc": "讀取外接磁碟上的專案。每次更新 App 後請重新檢查。",
  "perms.network": "區域網路",
  "perms.networkDesc": "讓代理連線到你網路中的裝置。macOS 不會回報此狀態。",
};

export const es = {
  'settings.page.permissions': 'Permisos',
  'settings.desc.permissions': 'Los permisos de macOS que usa Nunchiro y su estado actual.',
  "perms.section": "Permisos de macOS",
  "perms.lede": "Nunchiro solo los lee. Cámbialos en Ajustes del Sistema.",
  "perms.refresh": "Actualizar",
  "perms.open": "Abrir Ajustes del Sistema",
  "perms.checking": "Comprobando…",
  "perms.granted": "Concedido",
  "perms.notGranted": "No concedido",
  "perms.unknown": "Desconocido",
  "perms.notNeeded": "No necesario",
  "perms.fullDisk": "Acceso total al disco",
  "perms.fullDiskDesc": "Lee todas las carpetas de este Mac. Este acceso también llega a cada agente que inicia Nunchiro.",
  "perms.volumes": "Volúmenes extraíbles",
  "perms.volumesDesc": "Lee proyectos en discos externos. Vuelve a comprobarlo tras cada actualización de la app.",
  "perms.network": "Red local",
  "perms.networkDesc": "Permite a los agentes acceder a dispositivos de tu red. macOS no informa de este estado.",
};

export const fr = {
  'settings.page.permissions': 'Autorisations',
  'settings.desc.permissions': 'Les autorisations macOS utilisées par Nunchiro et leur état actuel.',
  "perms.section": "Autorisations macOS",
  "perms.lede": "Nunchiro se contente de les lire. Modifiez-les dans Réglages Système.",
  "perms.refresh": "Actualiser",
  "perms.open": "Ouvrir Réglages Système",
  "perms.checking": "Vérification…",
  "perms.granted": "Accordée",
  "perms.notGranted": "Non accordée",
  "perms.unknown": "Inconnue",
  "perms.notNeeded": "Non requise",
  "perms.fullDisk": "Accès complet au disque",
  "perms.fullDiskDesc": "Lit tous les dossiers de ce Mac. Cet accès s’étend aussi à chaque agent lancé par Nunchiro.",
  "perms.volumes": "Volumes amovibles",
  "perms.volumesDesc": "Lit les projets sur des disques externes. Vérifiez de nouveau après chaque mise à jour de l’app.",
  "perms.network": "Réseau local",
  "perms.networkDesc": "Permet aux agents d’atteindre les appareils de votre réseau. macOS ne signale pas cet état.",
};

export const pt = {
  'settings.page.permissions': 'Permissões',
  'settings.desc.permissions': 'As permissões do macOS que o Nunchiro usa e o estado atual.',
  "perms.section": "Permissões do macOS",
  "perms.lede": "O Nunchiro apenas as lê. Altere-as nos Ajustes do Sistema.",
  "perms.refresh": "Atualizar",
  "perms.open": "Abrir Ajustes do Sistema",
  "perms.checking": "Verificando…",
  "perms.granted": "Concedida",
  "perms.notGranted": "Não concedida",
  "perms.unknown": "Desconhecida",
  "perms.notNeeded": "Não necessária",
  "perms.fullDisk": "Acesso Total ao Disco",
  "perms.fullDiskDesc": "Lê todas as pastas deste Mac. Esse acesso também alcança cada agente que o Nunchiro inicia.",
  "perms.volumes": "Volumes removíveis",
  "perms.volumesDesc": "Lê projetos em discos externos. Verifique de novo após cada atualização do app.",
  "perms.network": "Rede local",
  "perms.networkDesc": "Permite que os agentes alcancem dispositivos da sua rede. O macOS não informa este estado.",
};
