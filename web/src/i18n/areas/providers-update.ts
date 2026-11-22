// Ticket 358, mock #update: a tool's new-version mark and its update row in Settings > Accounts.
declare module '../index' {
  interface AreaKeys {
    'providerUpdate.new': true;
    'providerUpdate.updating': true;
    'providerUpdate.installing': true;
    'providerUpdate.installingAny': true;
    'providerUpdate.failed': true;
    'providerUpdate.failedAny': true;
    'providerUpdate.failedChip': true;
    'providerUpdate.unchanged': true;
    'providerUpdate.unchangedChip': true;
    'providerUpdate.timedOut': true;
    'providerUpdate.startFailed': true;
    'providerUpdate.cancel': true;
    'providerUpdate.retry': true;
    'providerUpdate.progress': true;
  }
}

export const en = {
  'providerUpdate.new': 'New version {version}',
  'providerUpdate.updating': 'Updating',
  'providerUpdate.installing': 'Installing {version}',
  'providerUpdate.installingAny': 'Installing',
  'providerUpdate.failed': '{version} update failed',
  'providerUpdate.failedAny': 'Update failed',
  'providerUpdate.failedChip': 'Failed',
  'providerUpdate.unchanged': 'Update finished, but the version did not change',
  'providerUpdate.unchangedChip': 'No change',
  'providerUpdate.timedOut': 'Timed out',
  'providerUpdate.startFailed': 'Could not start the update',
  'providerUpdate.cancel': 'Cancel',
  'providerUpdate.retry': 'Retry',
  'providerUpdate.progress': 'Update in progress',
};

export const ko = {
  'providerUpdate.new': '새 버전 {version}',
  'providerUpdate.updating': '업데이트 중',
  'providerUpdate.installing': '{version} 설치 중',
  'providerUpdate.installingAny': '설치 중',
  'providerUpdate.failed': '{version} 업데이트 실패',
  'providerUpdate.failedAny': '업데이트 실패',
  'providerUpdate.failedChip': '실패',
  'providerUpdate.unchanged': '업데이트가 끝났지만 버전이 그대로입니다',
  'providerUpdate.unchangedChip': '변경 없음',
  'providerUpdate.timedOut': '시간 초과',
  'providerUpdate.startFailed': '업데이트를 시작하지 못했습니다',
  'providerUpdate.cancel': '취소',
  'providerUpdate.retry': '다시 시도',
  'providerUpdate.progress': '업데이트 진행 중',
};

export const ja = {
  'providerUpdate.new': '新しいバージョン {version}',
  'providerUpdate.updating': 'アップデート中',
  'providerUpdate.installing': '{version} をインストール中',
  'providerUpdate.installingAny': 'インストール中',
  'providerUpdate.failed': '{version} のアップデートに失敗',
  'providerUpdate.failedAny': 'アップデートに失敗',
  'providerUpdate.failedChip': '失敗',
  'providerUpdate.unchanged': 'アップデートは完了しましたが、バージョンは変わっていません',
  'providerUpdate.unchangedChip': '変更なし',
  'providerUpdate.timedOut': 'タイムアウト',
  'providerUpdate.startFailed': 'アップデートを開始できませんでした',
  'providerUpdate.cancel': 'キャンセル',
  'providerUpdate.retry': '再試行',
  'providerUpdate.progress': 'アップデート進行中',
};

export const zhHans = {
  'providerUpdate.new': '新版本 {version}',
  'providerUpdate.updating': '更新中',
  'providerUpdate.installing': '正在安装 {version}',
  'providerUpdate.installingAny': '正在安装',
  'providerUpdate.failed': '{version} 更新失败',
  'providerUpdate.failedAny': '更新失败',
  'providerUpdate.failedChip': '失败',
  'providerUpdate.unchanged': '更新已完成，但版本没有变化',
  'providerUpdate.unchangedChip': '无变化',
  'providerUpdate.timedOut': '超时',
  'providerUpdate.startFailed': '无法启动更新',
  'providerUpdate.cancel': '取消',
  'providerUpdate.retry': '重试',
  'providerUpdate.progress': '正在更新',
};

export const zhHant = {
  'providerUpdate.new': '新版本 {version}',
  'providerUpdate.updating': '更新中',
  'providerUpdate.installing': '正在安裝 {version}',
  'providerUpdate.installingAny': '正在安裝',
  'providerUpdate.failed': '{version} 更新失敗',
  'providerUpdate.failedAny': '更新失敗',
  'providerUpdate.failedChip': '失敗',
  'providerUpdate.unchanged': '更新已完成，但版本沒有變更',
  'providerUpdate.unchangedChip': '無變更',
  'providerUpdate.timedOut': '逾時',
  'providerUpdate.startFailed': '無法啟動更新',
  'providerUpdate.cancel': '取消',
  'providerUpdate.retry': '重試',
  'providerUpdate.progress': '正在更新',
};

export const es = {
  'providerUpdate.new': 'Nueva versión {version}',
  'providerUpdate.updating': 'Actualizando',
  'providerUpdate.installing': 'Instalando {version}',
  'providerUpdate.installingAny': 'Instalando',
  'providerUpdate.failed': 'Falló la actualización a {version}',
  'providerUpdate.failedAny': 'Falló la actualización',
  'providerUpdate.failedChip': 'Error',
  'providerUpdate.unchanged': 'La actualización terminó, pero la versión no cambió',
  'providerUpdate.unchangedChip': 'Sin cambios',
  'providerUpdate.timedOut': 'Tiempo agotado',
  'providerUpdate.startFailed': 'No se pudo iniciar la actualización',
  'providerUpdate.cancel': 'Cancelar',
  'providerUpdate.retry': 'Reintentar',
  'providerUpdate.progress': 'Actualización en curso',
};

export const fr = {
  'providerUpdate.new': 'Nouvelle version {version}',
  'providerUpdate.updating': 'Mise à jour',
  'providerUpdate.installing': 'Installation de {version}',
  'providerUpdate.installingAny': 'Installation',
  'providerUpdate.failed': 'Échec de la mise à jour vers {version}',
  'providerUpdate.failedAny': 'Échec de la mise à jour',
  'providerUpdate.failedChip': 'Échec',
  'providerUpdate.unchanged': 'Mise à jour terminée, mais la version n’a pas changé',
  'providerUpdate.unchangedChip': 'Aucun changement',
  'providerUpdate.timedOut': 'Délai dépassé',
  'providerUpdate.startFailed': 'Impossible de lancer la mise à jour',
  'providerUpdate.cancel': 'Annuler',
  'providerUpdate.retry': 'Réessayer',
  'providerUpdate.progress': 'Mise à jour en cours',
};

export const pt = {
  'providerUpdate.new': 'Nova versão {version}',
  'providerUpdate.updating': 'Atualizando',
  'providerUpdate.installing': 'Instalando {version}',
  'providerUpdate.installingAny': 'Instalando',
  'providerUpdate.failed': 'Falha ao atualizar para {version}',
  'providerUpdate.failedAny': 'Falha na atualização',
  'providerUpdate.failedChip': 'Falha',
  'providerUpdate.unchanged': 'A atualização terminou, mas a versão não mudou',
  'providerUpdate.unchangedChip': 'Sem alterações',
  'providerUpdate.timedOut': 'Tempo esgotado',
  'providerUpdate.startFailed': 'Não foi possível iniciar a atualização',
  'providerUpdate.cancel': 'Cancelar',
  'providerUpdate.retry': 'Tentar novamente',
  'providerUpdate.progress': 'Atualização em andamento',
};
