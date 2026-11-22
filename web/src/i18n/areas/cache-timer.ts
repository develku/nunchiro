// Ticket 257: the prompt-cache countdown in the tree (tree/CacheTimer.tsx) and its Settings > Agents section
// (features/cache-timer.tsx). English is the source; the other seven are first drafts for a native read.
declare module '../index' {
  interface AreaKeys {
    'cacheTimer.cold': true;
    'cacheTimer.tip': true;
    'cacheTimer.coldTip': true;
    'cacheTimer.title': true;
    'cacheTimer.lede': true;
    'field.cacheTimer': true;
    'cacheTimer.desc': true;
    'field.cacheTtl': true;
    'cacheTimer.ttlDesc': true;
    'cacheTimer.fiveMin': true;
    'cacheTimer.oneHour': true;
  }
}

export const en = {
  'cacheTimer.cold': 'cache cold',
  'cacheTimer.tip': 'Prompt cache expires in {left}',
  'cacheTimer.coldTip': 'The prompt cache has expired: the next message sends the whole conversation again, at full price',
  'cacheTimer.title': 'Prompt cache timer',
  'cacheTimer.lede': 'Claude caches the conversation so each message costs less. After a pause the cache expires, and the next message sends everything again at full price.',
  'field.cacheTimer': 'Cache timer',
  'cacheTimer.desc': 'When a Claude session stops working, its row counts down to the cache expiry.',
  'field.cacheTtl': 'Cache duration',
  'cacheTimer.ttlDesc': "Match your plan's cache time. The default is 5 minutes.",
  'cacheTimer.fiveMin': '5 minutes',
  'cacheTimer.oneHour': '1 hour',
};
export const ko = {
  'cacheTimer.cold': '캐시 만료',
  'cacheTimer.tip': '프롬프트 캐시가 {left} 후 만료됩니다',
  'cacheTimer.coldTip': '프롬프트 캐시가 만료됐습니다. 다음 메시지는 대화 전체를 정가로 다시 보냅니다',
  'cacheTimer.title': '프롬프트 캐시 타이머',
  'cacheTimer.lede': 'Claude는 대화를 캐시해 메시지마다 비용을 줄입니다. 잠시 쉬면 캐시가 만료되고, 다음 메시지는 전부를 정가로 다시 보냅니다.',
  'field.cacheTimer': '캐시 타이머',
  'cacheTimer.desc': 'Claude 세션이 일을 멈추면 그 줄에 캐시 만료까지 남은 시간이 표시됩니다.',
  'field.cacheTtl': '캐시 유지 시간',
  'cacheTimer.ttlDesc': '쓰는 요금제의 캐시 시간에 맞추세요. 기본은 5분입니다.',
  'cacheTimer.fiveMin': '5분',
  'cacheTimer.oneHour': '1시간',
};
export const ja = {
  'cacheTimer.cold': 'キャッシュ切れ',
  'cacheTimer.tip': 'プロンプトキャッシュはあと {left} で切れます',
  'cacheTimer.coldTip': 'プロンプトキャッシュが切れました。次のメッセージは会話全体を通常料金で送り直します',
  'cacheTimer.title': 'プロンプトキャッシュタイマー',
  'cacheTimer.lede': 'Claude は会話をキャッシュして、メッセージごとの費用を抑えます。間が空くとキャッシュが切れ、次のメッセージはすべてを通常料金で送り直します。',
  'field.cacheTimer': 'キャッシュタイマー',
  'cacheTimer.desc': 'Claude セッションが作業を止めると、その行にキャッシュが切れるまでの残り時間を表示します。',
  'field.cacheTtl': 'キャッシュの保持時間',
  'cacheTimer.ttlDesc': 'ご利用のプランのキャッシュ時間に合わせてください。デフォルトは 5 分です。',
  'cacheTimer.fiveMin': '5 分',
  'cacheTimer.oneHour': '1 時間',
};
export const zhHans = {
  'cacheTimer.cold': '缓存已过期',
  'cacheTimer.tip': '提示缓存将在 {left} 后过期',
  'cacheTimer.coldTip': '提示缓存已过期：下一条消息会按全价重新发送整个对话',
  'cacheTimer.title': '提示缓存计时器',
  'cacheTimer.lede': 'Claude 会缓存对话，让每条消息花费更少。停顿一段时间后缓存过期，下一条消息会按全价重新发送全部内容。',
  'field.cacheTimer': '缓存计时器',
  'cacheTimer.desc': 'Claude 会话停止工作后，它的行会倒数到缓存过期。',
  'field.cacheTtl': '缓存时长',
  'cacheTimer.ttlDesc': '与你所用套餐的缓存时间一致。默认 5 分钟。',
  'cacheTimer.fiveMin': '5 分钟',
  'cacheTimer.oneHour': '1 小时',
};
export const zhHant = {
  'cacheTimer.cold': '快取已過期',
  'cacheTimer.tip': '提示快取將在 {left} 後過期',
  'cacheTimer.coldTip': '提示快取已過期：下一則訊息會以全價重新傳送整段對話',
  'cacheTimer.title': '提示快取計時器',
  'cacheTimer.lede': 'Claude 會快取對話，讓每則訊息花費更少。停頓一段時間後快取過期，下一則訊息會以全價重新傳送全部內容。',
  'field.cacheTimer': '快取計時器',
  'cacheTimer.desc': 'Claude 工作階段停止工作後，它的列會倒數到快取過期。',
  'field.cacheTtl': '快取時長',
  'cacheTimer.ttlDesc': '與你所用方案的快取時間一致。預設 5 分鐘。',
  'cacheTimer.fiveMin': '5 分鐘',
  'cacheTimer.oneHour': '1 小時',
};
export const es = {
  'cacheTimer.cold': 'caché fría',
  'cacheTimer.tip': 'La caché del prompt caduca en {left}',
  'cacheTimer.coldTip': 'La caché del prompt ha caducado: el próximo mensaje vuelve a enviar toda la conversación a precio completo',
  'cacheTimer.title': 'Temporizador de caché del prompt',
  'cacheTimer.lede': 'Claude guarda la conversación en caché para que cada mensaje cueste menos. Tras una pausa la caché caduca y el próximo mensaje vuelve a enviarlo todo a precio completo.',
  'field.cacheTimer': 'Temporizador de caché',
  'cacheTimer.desc': 'Cuando una sesión de Claude deja de trabajar, su fila cuenta hacia atrás hasta que caduca la caché.',
  'field.cacheTtl': 'Duración de la caché',
  'cacheTimer.ttlDesc': 'Ajústala al tiempo de caché de tu plan. Por defecto, 5 minutos.',
  'cacheTimer.fiveMin': '5 minutos',
  'cacheTimer.oneHour': '1 hora',
};
export const fr = {
  'cacheTimer.cold': 'cache expiré',
  'cacheTimer.tip': 'Le cache du prompt expire dans {left}',
  'cacheTimer.coldTip': "Le cache du prompt a expiré : le prochain message renvoie toute la conversation au plein tarif",
  'cacheTimer.title': 'Minuteur du cache de prompt',
  'cacheTimer.lede': "Claude met la conversation en cache pour que chaque message coûte moins. Après une pause, le cache expire et le prochain message renvoie tout au plein tarif.",
  'field.cacheTimer': 'Minuteur du cache',
  'cacheTimer.desc': "Quand une session Claude arrête de travailler, sa ligne affiche un compte à rebours jusqu’à l’expiration du cache.",
  'field.cacheTtl': 'Durée du cache',
  'cacheTimer.ttlDesc': 'Alignez-la sur la durée de cache de votre forfait. Par défaut, 5 minutes.',
  'cacheTimer.fiveMin': '5 minutes',
  'cacheTimer.oneHour': '1 heure',
};
export const pt = {
  'cacheTimer.cold': 'cache expirado',
  'cacheTimer.tip': 'O cache do prompt expira em {left}',
  'cacheTimer.coldTip': 'O cache do prompt expirou: a próxima mensagem reenvia toda a conversa pelo preço cheio',
  'cacheTimer.title': 'Temporizador do cache do prompt',
  'cacheTimer.lede': 'O Claude guarda a conversa em cache para que cada mensagem custe menos. Depois de uma pausa o cache expira, e a próxima mensagem reenvia tudo pelo preço cheio.',
  'field.cacheTimer': 'Temporizador do cache',
  'cacheTimer.desc': 'Quando uma sessão do Claude para de trabalhar, a linha dela faz uma contagem regressiva até o cache expirar.',
  'field.cacheTtl': 'Duração do cache',
  'cacheTimer.ttlDesc': 'Ajuste ao tempo de cache do seu plano. O padrão é 5 minutos.',
  'cacheTimer.fiveMin': '5 minutos',
  'cacheTimer.oneHour': '1 hora',
};
