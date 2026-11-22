// Tickets 311, 312: per-row reset, shown defaults, plain settings errors and Retry (settings/shell).
declare module '../index' {
  interface AreaKeys {
    'settings.kit.default': true;
    'settings.kit.resetRow': true;
    'settings.kit.resetTip': true;
    'settings.kit.resetSec': true;
    'settings.kit.resetDone': true;
    'settings.kit.toDefaults': true;
    'settings.kit.retry': true;
    'settings.err.core': true;
    'settings.err.busy': true;
    'settings.err.denied': true;
    'settings.err.full': true;
    'settings.err.version': true;
    'settings.err.folderTilde': true;
    'settings.err.folderDots': true;
    'settings.err.folderOut': true;
    'settings.err.folderLong': true;
  }
}

export const en = {
  'settings.kit.default': 'Default {value}',
  'settings.kit.resetRow': 'Reset {label} to default',
  'settings.kit.resetTip': 'Reset to default',
  'settings.kit.resetSec': 'Reset {section} to defaults',
  'settings.kit.resetDone': '{section} reset to defaults',
  'settings.kit.toDefaults': 'Reset to defaults',
  'settings.kit.retry': 'Try again',
  'settings.err.core': "Lost the connection to Nunchiro's background service. Wait a moment and try again.",
  'settings.err.busy': 'Nunchiro is busy right now. Wait a moment and try again.',
  'settings.err.denied': "Nunchiro is not allowed to write there. Check the folder's permissions.",
  'settings.err.full': 'The disk is full, so this could not be saved.',
  'settings.err.version': 'The background service is a different version. Restart Nunchiro and try again.',
  'settings.err.folderTilde': 'Write the full folder path instead of ~.',
  'settings.err.folderDots': 'A full folder path cannot contain "..".',
  'settings.err.folderOut': 'That folder is outside the repository. Use a folder inside it or next to it, like ../.worktrees, or a full path.',
  'settings.err.folderLong': 'Enter a folder path of at most 1024 characters.',
};

export const ko = {
  'settings.kit.default': '기본 {value}',
  'settings.kit.resetRow': '{label} 기본값으로 되돌리기',
  'settings.kit.resetTip': '기본값으로 되돌리기',
  'settings.kit.resetSec': '{section} 기본값으로 되돌리기',
  'settings.kit.resetDone': '{section}을(를) 기본값으로 되돌렸습니다',
  'settings.kit.toDefaults': '기본값으로',
  'settings.kit.retry': '다시 시도',
  'settings.err.core': 'Nunchiro 백그라운드 서비스와 연결이 끊겼습니다. 잠시 후 다시 시도하세요.',
  'settings.err.busy': 'Nunchiro가 지금 바쁩니다. 잠시 후 다시 시도하세요.',
  'settings.err.denied': '그 위치에 쓸 권한이 없습니다. 폴더 권한을 확인하세요.',
  'settings.err.full': '디스크가 가득 차서 저장하지 못했습니다.',
  'settings.err.version': '백그라운드 서비스의 버전이 다릅니다. Nunchiro를 다시 시작한 뒤 시도하세요.',
  'settings.err.folderTilde': '~ 대신 폴더 전체 경로를 적으세요.',
  'settings.err.folderDots': '전체 경로에는 ".."를 쓸 수 없습니다.',
  'settings.err.folderOut': '그 폴더는 저장소 밖으로 나갑니다. 저장소 안이나 바로 옆(예: ../.worktrees), 또는 전체 경로를 적으세요.',
  'settings.err.folderLong': '폴더 경로는 1024자까지 쓸 수 있습니다.',
};

export const ja = {
  'settings.kit.default': "デフォルト {value}",
  'settings.kit.resetRow': "{label}をデフォルトに戻す",
  'settings.kit.resetTip': "デフォルトに戻す",
  'settings.kit.resetSec': "{section}をデフォルトに戻す",
  'settings.kit.resetDone': "{section}をデフォルトに戻しました",
  'settings.kit.toDefaults': "デフォルトに戻す",
  'settings.kit.retry': '再試行',
  'settings.err.core': 'Nunchiro のバックグラウンドサービスとの接続が切れました。少し待ってからもう一度お試しください。',
  'settings.err.busy': "Nunchiro は現在処理中です。少し待ってからもう一度お試しください。",
  'settings.err.denied': 'その場所に書き込む権限がありません。フォルダーの権限を確認してください。',
  'settings.err.full': 'ディスクがいっぱいのため保存できませんでした。',
  'settings.err.version': 'バックグラウンドサービスのバージョンが異なります。Nunchiro を再起動してからお試しください。',
  'settings.err.folderTilde': '~ ではなくフォルダーのフルパスを入力してください。',
  'settings.err.folderDots': 'フルパスに ".." は使えません。',
  'settings.err.folderOut': 'そのフォルダーはリポジトリの外に出ます。リポジトリ内か隣（例：../.worktrees）、またはフルパスを入力してください。',
  'settings.err.folderLong': 'フォルダーのパスは 1024 文字までです。',
};

export const zhHans = {
  'settings.kit.default': '默认 {value}',
  'settings.kit.resetRow': '将{label}恢复默认',
  'settings.kit.resetTip': '恢复默认',
  'settings.kit.resetSec': '将{section}恢复默认',
  'settings.kit.resetDone': '{section}已恢复默认',
  'settings.kit.toDefaults': '恢复默认',
  'settings.kit.retry': '重试',
  'settings.err.core': '与 Nunchiro 后台服务的连接已断开。请稍后重试。',
  'settings.err.busy': 'Nunchiro 正忙。请稍后重试。',
  'settings.err.denied': '没有写入该位置的权限。请检查文件夹权限。',
  'settings.err.full': '磁盘已满，无法保存。',
  'settings.err.version': '后台服务版本不同。请重启 Nunchiro 后重试。',
  'settings.err.folderTilde': '请填写完整的文件夹路径，不要用 ~。',
  'settings.err.folderDots': '完整路径中不能包含 ".."。',
  'settings.err.folderOut': '该文件夹超出了仓库范围。请使用仓库内或旁边的文件夹（如 ../.worktrees），或填写完整路径。',
  'settings.err.folderLong': '文件夹路径最多 1024 个字符。',
};

export const zhHant = {
  'settings.kit.default': '預設 {value}',
  'settings.kit.resetRow': '將{label}重置為預設值',
  'settings.kit.resetTip': '重置為預設值',
  'settings.kit.resetSec': '將{section}重置為預設值',
  'settings.kit.resetDone': '{section}已重置為預設值',
  'settings.kit.toDefaults': '重置為預設值',
  'settings.kit.retry': '重試',
  'settings.err.core': '與 Nunchiro 背景服務的連線已中斷。請稍後再試。',
  'settings.err.busy': 'Nunchiro 正忙。請稍後再試。',
  'settings.err.denied': '沒有寫入該位置的權限。請檢查資料夾權限。',
  'settings.err.full': '磁碟已滿，無法儲存。',
  'settings.err.version': '背景服務版本不同。請重新啟動 Nunchiro 後再試。',
  'settings.err.folderTilde': '請填寫完整的資料夾路徑，不要用 ~。',
  'settings.err.folderDots': '完整路徑中不能包含 ".."。',
  'settings.err.folderOut': '該資料夾超出了儲存庫範圍。請使用儲存庫內或旁邊的資料夾（如 ../.worktrees），或填寫完整路徑。',
  'settings.err.folderLong': '資料夾路徑最多 1024 個字元。',
};

export const es = {
  'settings.kit.default': "Predeterminado {value}",
  'settings.kit.resetRow': 'Restablecer {label}',
  'settings.kit.resetTip': 'Restablecer',
  'settings.kit.resetSec': 'Restablecer {section}',
  'settings.kit.resetDone': '{section} restablecido',
  'settings.kit.toDefaults': 'Restablecer',
  'settings.kit.retry': 'Reintentar',
  'settings.err.core': 'Se perdió la conexión con el servicio en segundo plano de Nunchiro. Espera un momento e inténtalo de nuevo.',
  'settings.err.busy': 'Nunchiro está ocupado. Espera un momento e inténtalo de nuevo.',
  'settings.err.denied': 'Nunchiro no tiene permiso para escribir ahí. Revisa los permisos de la carpeta.',
  'settings.err.full': 'El disco está lleno; no se pudo guardar.',
  'settings.err.version': 'El servicio en segundo plano es de otra versión. Reinicia Nunchiro e inténtalo de nuevo.',
  'settings.err.folderTilde': 'Escribe la ruta completa en lugar de ~.',
  'settings.err.folderDots': 'Una ruta completa no puede contener "..".',
  'settings.err.folderOut': 'Esa carpeta sale del repositorio. Usa una dentro o al lado, como ../.worktrees, o una ruta completa.',
  'settings.err.folderLong': 'La ruta admite 1024 caracteres como máximo.',
};

export const fr = {
  'settings.kit.default': 'Par défaut {value}',
  'settings.kit.resetRow': 'Réinitialiser {label}',
  'settings.kit.resetTip': 'Réinitialiser',
  'settings.kit.resetSec': 'Réinitialiser {section}',
  'settings.kit.resetDone': '{section} réinitialisé',
  'settings.kit.toDefaults': 'Réinitialiser',
  'settings.kit.retry': 'Réessayer',
  'settings.err.core': 'Connexion au service d’arrière-plan de Nunchiro perdue. Patientez puis réessayez.',
  'settings.err.busy': 'Nunchiro est occupé. Patientez puis réessayez.',
  'settings.err.denied': "Nunchiro n’a pas le droit d’écrire ici. Vérifiez les permissions du dossier.",
  'settings.err.full': 'Le disque est plein, enregistrement impossible.',
  'settings.err.version': "Le service d’arrière-plan est d’une autre version. Redémarrez Nunchiro puis réessayez.",
  'settings.err.folderTilde': 'Indiquez le chemin complet au lieu de ~.',
  'settings.err.folderDots': 'Un chemin complet ne peut pas contenir "..".',
  'settings.err.folderOut': 'Ce dossier sort du dépôt. Utilisez-en un dedans ou à côté, comme ../.worktrees, ou un chemin complet.',
  'settings.err.folderLong': 'Le chemin est limité à 1024 caractères.',
};

export const pt = {
  'settings.kit.default': 'Padrão {value}',
  'settings.kit.resetRow': 'Restaurar {label}',
  'settings.kit.resetTip': 'Restaurar padrão',
  'settings.kit.resetSec': 'Restaurar {section}',
  'settings.kit.resetDone': '{section} restaurado',
  'settings.kit.toDefaults': 'Restaurar padrão',
  'settings.kit.retry': 'Tentar novamente',
  'settings.err.core': 'A conexão com o serviço em segundo plano do Nunchiro caiu. Aguarde um momento e tente novamente.',
  'settings.err.busy': 'O Nunchiro está ocupado. Aguarde um momento e tente novamente.',
  'settings.err.denied': 'O Nunchiro não tem permissão para gravar ali. Verifique as permissões da pasta.',
  'settings.err.full': 'O disco está cheio; não foi possível salvar.',
  'settings.err.version': 'O serviço em segundo plano está em outra versão. Reinicie o Nunchiro e tente novamente.',
  'settings.err.folderTilde': 'Escreva o caminho completo em vez de ~.',
  'settings.err.folderDots': 'Um caminho completo não pode conter "..".',
  'settings.err.folderOut': 'Essa pasta sai do repositório. Use uma dentro ou ao lado, como ../.worktrees, ou um caminho completo.',
  'settings.err.folderLong': 'O caminho aceita no máximo 1024 caracteres.',
};
