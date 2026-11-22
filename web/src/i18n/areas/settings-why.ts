// Ticket 475 (453 pick B): the reasons a Settings control cannot work right now, and their fixes (Row.tsx Why).
declare module '../index' {
  interface AreaKeys {
    'settingsWhy.ghMissing': true;
    'settingsWhy.ghOut': true;
    'settingsWhy.needsApp': true;
    'settingsWhy.profilesMax': true;
    'settingsWhy.agentsOff': true;
    'settingsWhy.openProviders': true;
    'settingsWhy.notifyBlocked': true;
  }
}

export const en = {
  'settingsWhy.ghMissing': 'gh is not installed, so this cannot be turned on.',
  'settingsWhy.ghOut': 'GitHub is not signed in, so PR status cannot be read.',
  'settingsWhy.needsApp': 'Clearing and removing work only in the Nunchiro app. Open Settings there.',
  'settingsWhy.profilesMax': 'At most {n} profiles. Remove one to add another.',
  'settingsWhy.agentsOff': 'Every agent is turned off in Providers, so nothing can be scheduled.',
  'settingsWhy.openProviders': 'Open Providers',
  'settingsWhy.notifyBlocked': 'macOS is not delivering notifications for Nunchiro. Turn them on in System Settings > Notifications > Nunchiro.',
};

export const ko = {
  'settingsWhy.ghMissing': 'gh가 설치되지 않아 켤 수 없습니다.',
  'settingsWhy.ghOut': 'GitHub에 로그인하지 않아 PR 상태를 읽을 수 없습니다.',
  'settingsWhy.needsApp': '지우기와 제거는 Nunchiro 앱에서만 됩니다. 앱에서 설정을 여세요.',
  'settingsWhy.profilesMax': '프로필은 최대 {n}개입니다. 하나를 제거하면 추가할 수 있습니다.',
  'settingsWhy.agentsOff': '프로바이더에서 모든 에이전트가 꺼져 있어 예약할 수 없습니다.',
  'settingsWhy.openProviders': '프로바이더 열기',
  'settingsWhy.notifyBlocked': 'macOS가 Nunchiro 알림을 표시하지 않습니다. 시스템 설정 > 알림 > Nunchiro에서 켜세요.',
};

export const ja = {
  'settingsWhy.ghMissing': 'gh がインストールされていないため、オンにできません。',
  'settingsWhy.ghOut': 'GitHub にログインしていないため、PR の状態を読めません。',
  'settingsWhy.needsApp': '消去と削除は Nunchiro アプリでのみ使えます。アプリで設定を開いてください。',
  'settingsWhy.profilesMax': 'プロファイルは最大 {n} 個です。1 つ削除すると追加できます。',
  'settingsWhy.agentsOff': 'プロバイダーですべてのエージェントがオフのため、予約できません。',
  'settingsWhy.openProviders': 'プロバイダーを開く',
  'settingsWhy.notifyBlocked': 'macOS は Nunchiro の通知を表示していません。システム設定 > 通知 > Nunchiro でオンにしてください。',
};

export const zhHans = {
  'settingsWhy.ghMissing': '未安装 gh，因此无法开启。',
  'settingsWhy.ghOut': '未登录 GitHub，因此无法读取 PR 状态。',
  'settingsWhy.needsApp': '清除和移除只能在 Nunchiro 应用中进行。请在应用中打开设置。',
  'settingsWhy.profilesMax': '最多 {n} 个配置文件。移除一个后即可添加。',
  'settingsWhy.agentsOff': '提供方中所有代理都已关闭，因此无法安排。',
  'settingsWhy.openProviders': '打开提供方',
  'settingsWhy.notifyBlocked': 'macOS 未显示 Nunchiro 的通知。请在“系统设置 > 通知 > Nunchiro”中打开。',
};

export const zhHant = {
  'settingsWhy.ghMissing': '未安裝 gh，因此無法開啟。',
  'settingsWhy.ghOut': '未登入 GitHub，因此無法讀取 PR 狀態。',
  'settingsWhy.needsApp': '清除與移除只能在 Nunchiro App 中進行。請在 App 中開啟設定。',
  'settingsWhy.profilesMax': '最多 {n} 個設定檔。移除一個後即可新增。',
  'settingsWhy.agentsOff': '提供者中所有代理都已關閉，因此無法排程。',
  'settingsWhy.openProviders': '開啟提供者',
  'settingsWhy.notifyBlocked': 'macOS 未顯示 Nunchiro 的通知。請在「系統設定 > 通知 > Nunchiro」中開啟。',
};

export const es = {
  'settingsWhy.ghMissing': 'gh no está instalado, así que no se puede activar.',
  'settingsWhy.ghOut': 'No has iniciado sesión en GitHub, así que no se puede leer el estado del PR.',
  'settingsWhy.needsApp': 'Borrar y eliminar solo funcionan en la app Nunchiro. Abre los ajustes allí.',
  'settingsWhy.profilesMax': 'Como máximo {n} perfiles. Elimina uno para añadir otro.',
  'settingsWhy.agentsOff': 'Todos los agentes están desactivados en Proveedores, así que no se puede programar nada.',
  'settingsWhy.openProviders': 'Abrir Proveedores',
  'settingsWhy.notifyBlocked': 'macOS no está mostrando las notificaciones de Nunchiro. Actívalas en Ajustes del Sistema > Notificaciones > Nunchiro.',
};

export const fr = {
  'settingsWhy.ghMissing': "gh n’est pas installé, donc ce réglage ne peut pas être activé.",
  'settingsWhy.ghOut': "Vous n’êtes pas connecté à GitHub, donc l’état de la PR ne peut pas être lu.",
  'settingsWhy.needsApp': "Effacer et supprimer ne fonctionnent que dans l’app Nunchiro. Ouvrez les réglages là-bas.",
  'settingsWhy.profilesMax': 'Au plus {n} profils. Supprimez-en un pour en ajouter un autre.',
  'settingsWhy.agentsOff': 'Tous les agents sont désactivés dans Fournisseurs, donc rien ne peut être planifié.',
  'settingsWhy.openProviders': 'Ouvrir Fournisseurs',
  'settingsWhy.notifyBlocked': "macOS n’affiche pas les notifications de Nunchiro. Activez-les dans Réglages Système > Notifications > Nunchiro.",
};

export const pt = {
  'settingsWhy.ghMissing': 'O gh não está instalado, então isto não pode ser ativado.',
  'settingsWhy.ghOut': 'Você não fez login no GitHub, então o status do PR não pode ser lido.',
  'settingsWhy.needsApp': 'Limpar e remover só funcionam no app Nunchiro. Abra as configurações lá.',
  'settingsWhy.profilesMax': 'No máximo {n} perfis. Remova um para adicionar outro.',
  'settingsWhy.agentsOff': 'Todos os agentes estão desativados em Provedores, então nada pode ser agendado.',
  'settingsWhy.openProviders': 'Abrir Provedores',
  'settingsWhy.notifyBlocked': 'O macOS não está mostrando as notificações do Nunchiro. Ative-as em Ajustes do Sistema > Notificações > Nunchiro.',
};
