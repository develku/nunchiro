// G2 (owner 11-08): the RC build's update item and palette command (chrome/rcUpdate.ts).
declare module '../index' {
  interface AreaKeys {
    'rc.update.ready': true;
    'rc.update.check': true;
    'rc.update.none': true;
    'rc.update.tip': true;
    'rc.update.failed': true;
    'rc.update.later': true;
    'rc.update.checkFailed': true;
  }
}

export const en = {
  'rc.update.ready': 'Update ready · Restart',
  'rc.update.check': 'Check for updates',
  'rc.update.none': 'No newer build',
  'rc.update.tip': 'Restarts the app. Running sessions keep going.',
  'rc.update.failed': 'Install failed · Retry',
  'rc.update.later': 'Later',
  'rc.update.checkFailed': 'Update check failed: {error}',
};

export const ko = {
  'rc.update.ready': '업데이트 준비됨 · 다시 시작',
  'rc.update.check': '업데이트 확인',
  'rc.update.none': '새 빌드 없음',
  'rc.update.tip': '앱을 다시 시작합니다. 실행 중인 세션은 계속 실행됩니다.',
  'rc.update.failed': '설치 실패, 다시 시도',
  'rc.update.later': '나중에',
  'rc.update.checkFailed': '업데이트 확인 실패: {error}',
};

export const ja = {
  'rc.update.ready': 'アップデート準備完了 · 再起動',
  'rc.update.check': 'アップデートを確認',
  'rc.update.none': '新しいビルドはありません',
  'rc.update.tip': 'アプリを再起動します。実行中のセッションは動き続けます。',
  'rc.update.failed': 'インストール失敗、再試行',
  'rc.update.later': '後で',
  'rc.update.checkFailed': 'アップデートの確認に失敗しました：{error}',
};

export const zhHans = {
  'rc.update.ready': '更新已就绪 · 重新启动',
  'rc.update.check': '检查更新',
  'rc.update.none': '没有更新的构建',
  'rc.update.tip': '重新启动应用。正在运行的会话会继续运行。',
  'rc.update.failed': '安装失败，重试',
  'rc.update.later': '稍后',
  'rc.update.checkFailed': '检查更新失败：{error}',
};

export const zhHant = {
  'rc.update.ready': '更新已就緒 · 重新啟動',
  'rc.update.check': '檢查更新',
  'rc.update.none': "沒有較新的版本",
  'rc.update.tip': '重新啟動 App。執行中的工作階段會繼續執行。',
  'rc.update.failed': '安裝失敗，重試',
  'rc.update.later': '稍後',
  'rc.update.checkFailed': '檢查更新失敗：{error}',
};

export const es = {
  'rc.update.ready': 'Actualización lista · Reiniciar',
  'rc.update.check': 'Buscar actualizaciones',
  'rc.update.none': 'No hay una versión más reciente',
  'rc.update.tip': 'Reinicia la app. Las sesiones en curso siguen funcionando.',
  'rc.update.failed': "Falló la instalación · Reintentar",
  'rc.update.later': 'Más tarde',
  'rc.update.checkFailed': 'Error al buscar actualizaciones: {error}',
};

export const fr = {
  'rc.update.ready': 'Mise à jour prête · Redémarrer',
  'rc.update.check': 'Rechercher des mises à jour',
  'rc.update.none': 'Aucune version plus récente',
  'rc.update.tip': 'Redémarre l’app. Les sessions en cours continuent.',
  'rc.update.failed': 'Échec de l’installation · Réessayer',
  'rc.update.later': 'Plus tard',
  'rc.update.checkFailed': 'Échec de la recherche de mises à jour : {error}',
};

export const pt = {
  'rc.update.ready': 'Atualização pronta · Reiniciar',
  'rc.update.check': 'Procurar atualizações',
  'rc.update.none': 'Nenhuma versão mais recente',
  'rc.update.tip': 'Reinicia o app. As sessões em execução continuam.',
  'rc.update.failed': 'Falha na instalação · Tentar novamente',
  'rc.update.later': 'Mais tarde',
  'rc.update.checkFailed': 'Falha ao procurar atualizações: {error}',
};
