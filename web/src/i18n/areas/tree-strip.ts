// Ticket 388: the head rows' colour strip, its tooltip, the gathered strip at the sidebar's edge. One file for the lane; every language has every key.
declare module '../index' {
  interface AreaKeys {
    "tree.strip.r": true;
    "tree.strip.o": true;
    "tree.strip.w": true;
    "tree.strip.y": true;
    "tree.strip.b": true;
    "tree.strip.g": true;
    "tree.strip.gDone": true;
    "tree.strip.open": true;
    "tree.strip.next": true;
    "tree.strip.above": true;
    "tree.strip.below": true;
    "tree.strip.scrollUp": true;
    "tree.strip.scrollDown": true;
  }
}

export const en = { "tree.strip.r": "{n} failed", "tree.strip.o": "{n} your turn", "tree.strip.w": "{n} limited", "tree.strip.y": "{n} stale", "tree.strip.b": "{n} working", "tree.strip.g": "{n} idle", "tree.strip.gDone": "{n} finished", "tree.strip.open": "{what} · open the longest waiting", "tree.strip.next": "Most urgent {name}", "tree.strip.above": "Above {name}", "tree.strip.below": "Below {name}", "tree.strip.scrollUp": "Scroll up to the hidden urgent sessions", "tree.strip.scrollDown": "Scroll down to the hidden urgent sessions" };
export const ko = { "tree.strip.r": "실패 {n}", "tree.strip.o": "내 차례 {n}", "tree.strip.w": "한도 {n}", "tree.strip.y": "멈춤 {n}", "tree.strip.b": "작업 중 {n}", "tree.strip.g": "쉬는 중 {n}", "tree.strip.gDone": "끝남 {n}", "tree.strip.open": "{what} · 가장 오래 기다린 세션 열기", "tree.strip.next": "가장 급한 일 {name}", "tree.strip.above": "위 {name}", "tree.strip.below": "아래 {name}", "tree.strip.scrollUp": "가려진 급한 세션으로 위로 스크롤", "tree.strip.scrollDown": "가려진 급한 세션으로 아래로 스크롤" };
export const ja = { "tree.strip.r": "失敗 {n}", "tree.strip.o": "あなたの番 {n}", "tree.strip.w": "上限 {n}", "tree.strip.y": "停滞 {n}", "tree.strip.b": "作業中 {n}", "tree.strip.g": "アイドル {n}", "tree.strip.gDone": "完了 {n}", "tree.strip.open": "{what} · 最も長く待っているものを開く", "tree.strip.next": "最優先：{name}", "tree.strip.above": "上 {name}", "tree.strip.below": "下 {name}", "tree.strip.scrollUp": "隠れた急ぎのセッションまで上へスクロール", "tree.strip.scrollDown": "隠れた急ぎのセッションまで下へスクロール" };
export const zhHans = { "tree.strip.r": "失败 {n}", "tree.strip.o": "轮到你 {n}", "tree.strip.w": "达上限 {n}", "tree.strip.y": "停滞 {n}", "tree.strip.b": "工作中 {n}", "tree.strip.g": "空闲 {n}", "tree.strip.gDone": "已完成 {n}", "tree.strip.open": "{what} · 打开等待最久的", "tree.strip.next": "最紧急 {name}", "tree.strip.above": "上方 {name}", "tree.strip.below": "下方 {name}", "tree.strip.scrollUp": "向上滚动到隐藏的紧急会话", "tree.strip.scrollDown": "向下滚动到隐藏的紧急会话" };
export const zhHant = { "tree.strip.r": "失敗 {n}", "tree.strip.o": "輪到你 {n}", "tree.strip.w": "限額 {n}", "tree.strip.y": "停滯 {n}", "tree.strip.b": "工作中 {n}", "tree.strip.g": "閒置 {n}", "tree.strip.gDone": "已結束 {n}", "tree.strip.open": "{what} · 開啟等待最久的", "tree.strip.next": "最緊急 {name}", "tree.strip.above": "上方 {name}", "tree.strip.below": "下方 {name}", "tree.strip.scrollUp": "向上捲動到隱藏的緊急工作階段", "tree.strip.scrollDown": "向下捲動到隱藏的緊急工作階段" };
export const es = { "tree.strip.r": "{n} con error", "tree.strip.o": "{n} tu turno", "tree.strip.w": "{n} en límite", "tree.strip.y": "{n} estancadas", "tree.strip.b": "{n} trabajando", "tree.strip.g": "{n} inactivas", "tree.strip.gDone": "{n} terminadas", "tree.strip.open": "{what} · abrir la que más espera", "tree.strip.next": "Lo más urgente {name}", "tree.strip.above": "Arriba {name}", "tree.strip.below": "Abajo {name}", "tree.strip.scrollUp": "Subir a las sesiones urgentes ocultas", "tree.strip.scrollDown": "Bajar a las sesiones urgentes ocultas" };
export const fr = { "tree.strip.r": "{n} en échec", "tree.strip.o": "{n} à vous", "tree.strip.w": "limitées : {n}", "tree.strip.y": "immobiles : {n}", "tree.strip.b": "{n} en cours", "tree.strip.g": "inactives : {n}", "tree.strip.gDone": "terminées : {n}", "tree.strip.open": "{what} · ouvrir celle qui attend le plus", "tree.strip.next": "Le plus urgent {name}", "tree.strip.above": "Au-dessus de {name}", "tree.strip.below": "En dessous de {name}", "tree.strip.scrollUp": "Remonter aux sessions urgentes masquées", "tree.strip.scrollDown": "Descendre aux sessions urgentes masquées" };
export const pt = { "tree.strip.r": "{n} com falha", "tree.strip.o": "{n} sua vez", "tree.strip.w": "{n} no limite", "tree.strip.y": "paradas: {n}", "tree.strip.b": "{n} trabalhando", "tree.strip.g": "inativas: {n}", "tree.strip.gDone": "encerradas: {n}", "tree.strip.open": "{what} · abrir a que espera há mais tempo", "tree.strip.next": "Mais urgente {name}", "tree.strip.above": "Acima {name}", "tree.strip.below": "Abaixo {name}", "tree.strip.scrollUp": "Subir até as sessões urgentes ocultas", "tree.strip.scrollDown": "Descer até as sessões urgentes ocultas" };
