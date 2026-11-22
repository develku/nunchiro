// Ticket 358, mock #update: the 새 버전 popover and 모두 업데이트 (n) in Settings > Accounts.
declare module '../index' {
  interface AreaKeys {
    'providerUpdateUi.now': true;
    'providerUpdateUi.copy': true;
    'providerUpdateUi.all': true;
  }
}

export const en = {
  'providerUpdateUi.now': 'Update now',
  'providerUpdateUi.copy': 'Copy command',
  'providerUpdateUi.all': 'Update all ({n})',
};

export const ko = {
  'providerUpdateUi.now': '지금 업데이트',
  'providerUpdateUi.copy': '명령 복사',
  'providerUpdateUi.all': '모두 업데이트 ({n})',
};

export const ja = {
  'providerUpdateUi.now': '今すぐアップデート',
  'providerUpdateUi.copy': 'コマンドをコピー',
  'providerUpdateUi.all': 'すべてアップデート（{n}）',
};

export const zhHans = {
  'providerUpdateUi.now': '立即更新',
  'providerUpdateUi.copy': '复制命令',
  'providerUpdateUi.all': '全部更新（{n}）',
};

export const zhHant = {
  'providerUpdateUi.now': '立即更新',
  'providerUpdateUi.copy': '複製指令',
  'providerUpdateUi.all': '全部更新（{n}）',
};

export const es = {
  'providerUpdateUi.now': 'Actualizar ahora',
  'providerUpdateUi.copy': 'Copiar comando',
  'providerUpdateUi.all': 'Actualizar todo ({n})',
};

export const fr = {
  'providerUpdateUi.now': 'Mettre à jour maintenant',
  'providerUpdateUi.copy': 'Copier la commande',
  'providerUpdateUi.all': 'Tout mettre à jour ({n})',
};

export const pt = {
  'providerUpdateUi.now': 'Atualizar agora',
  'providerUpdateUi.copy': 'Copiar comando',
  'providerUpdateUi.all': 'Atualizar tudo ({n})',
};
