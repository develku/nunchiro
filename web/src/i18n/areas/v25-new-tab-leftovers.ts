// v25-new-tab-leftovers (ticket 297 item 8): the Stop confirmation asked before a running agent ends (StopAsk in NewSession.tsx).
declare module '../index' {
  interface AreaKeys {
    "stopAsk.title": true;
    "stopAsk.text": true;
    "stopAsk.cancel": true;
    "stopAsk.stop": true;
  }
}

export const en = {
  "stopAsk.title": "Stop {name}?",
  "stopAsk.text": "The agent ends now. Its chat stays readable here.",
  "stopAsk.cancel": "Cancel",
  "stopAsk.stop": "Stop",
};

export const ko = {
  "stopAsk.title": "{name}을(를) 중지하시겠습니까?",
  "stopAsk.text": "에이전트가 지금 종료됩니다. 대화는 여기서 계속 읽을 수 있습니다.",
  "stopAsk.cancel": "취소",
  "stopAsk.stop": "중지",
};

export const ja = {
  "stopAsk.title": "{name} を停止しますか？",
  "stopAsk.text": "エージェントはすぐに終了します。チャットはここで引き続き読めます。",
  "stopAsk.cancel": "キャンセル",
  "stopAsk.stop": "停止",
};

export const zhHans = {
  "stopAsk.title": "停止 {name}？",
  "stopAsk.text": "代理将立即结束。其对话仍可在此阅读。",
  "stopAsk.cancel": "取消",
  "stopAsk.stop": "停止",
};

export const zhHant = {
  "stopAsk.title": "停止 {name}？",
  "stopAsk.text": "代理將立即結束。其對話仍可在此閱讀。",
  "stopAsk.cancel": "取消",
  "stopAsk.stop": "停止",
};

export const es = {
  "stopAsk.title": "¿Detener {name}?",
  "stopAsk.text": "El agente termina ahora. Su chat sigue siendo legible aquí.",
  "stopAsk.cancel": "Cancelar",
  "stopAsk.stop": "Detener",
};

export const fr = {
  "stopAsk.title": "Arrêter {name} ?",
  "stopAsk.text": "L’agent s’arrête maintenant. Sa conversation reste lisible ici.",
  "stopAsk.cancel": "Annuler",
  "stopAsk.stop": "Arrêter",
};

export const pt = {
  "stopAsk.title": "Parar {name}?",
  "stopAsk.text": "O agente termina agora. A conversa continua legível aqui.",
  "stopAsk.cancel": "Cancelar",
  "stopAsk.stop": "Parar",
};
